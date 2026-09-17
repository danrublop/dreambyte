#!/usr/bin/env tsx
/**
 * Seed a "Variant Compare Test" project with multiple branches so the
 * variant comparison modal has real data to render.
 *
 * Creates:
 *   - 1 project named "Variant Compare Test"
 *   - 1 default branch ("main") with 3 scenes (red / teal / yellow bgs)
 *   - 3 variant branches ("variant-warm", "variant-cool", "variant-mono")
 *     each cloning the default but recoloring scenes so they're visually
 *     distinguishable when compared side by side
 *   - 12 minimal HTML files in the scenes dir (one per scene per branch)
 *
 * Usage (from repo root):
 *   npx tsx scripts/db/seed-variants-test.ts
 *
 * Then in Dreambyte:
 *   1. Restart the app if it was running
 *   2. Open the "Variant Compare Test" project
 *   3. Click the branch selector dropdown in the Layers tab
 *   4. Click "Compare 3 latest branches side by side"
 *   5. Side-by-side modal opens with the 3 variant branches
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

// ── Locate the Dreambyte runtime data ────────────────────────────────────

/**
 * The app picks DATABASE_URL in this order (per src/electron/main.ts:99-118):
 *   1. process.env.DATABASE_URL if pre-set (e.g., from .env / .env.local)
 *   2. Otherwise: file:<userData>/dreambyte.db
 *
 * The seed script must read the same .env files the app reads — otherwise
 * we'll auto-detect the userData path while the running app is on a
 * dev-mode file: URL, and end up writing to the wrong DB. dotenv handles
 * .env / .env.local / .env.development in that order.
 */
async function locateAppData(): Promise<{ dbFile: string; scenesDir: string; source: string }> {
  // Load .env files explicitly — Node doesn't read them automatically.
  // Use --import for tsx, or call dotenv-flow programmatically if installed.
  try {
    const dotenv = await import('dotenv')
    // Match Next.js / Electron resolution order: .env.local wins over .env
    for (const file of ['.env.development.local', '.env.local', '.env.development', '.env']) {
      const p = path.join(process.cwd(), file)
      if (fs.existsSync(p)) dotenv.config({ path: p, override: false })
    }
  } catch {
    // dotenv missing — fall through to direct path detection.
  }

  // 1. Honor DATABASE_URL if set (most likely in dev — .env has file:./dev.db).
  if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL
    if (url.startsWith('file:')) {
      const rawPath = url.slice(5)
      // Resolve relative paths against cwd, matching libsql's behavior.
      const dbFile = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath)
      if (fs.existsSync(dbFile)) {
        // Scenes dir for dev mode lives under the repo's public/scenes (the
        // Next dev server serves from there). For non-dev (file in userData)
        // use the sibling scenes/ dir.
        const isInUserData = dbFile.includes('Application Support') || dbFile.includes('userData')
        const scenesDir = isInUserData
          ? path.join(path.dirname(dbFile), 'scenes')
          : path.join(process.cwd(), 'public', 'scenes')
        return { dbFile, scenesDir, source: 'DATABASE_URL env var' }
      }
      // File doesn't exist yet — that's fine; createClient will create it.
      // Use a sensible scenesDir default.
      return {
        dbFile,
        scenesDir: path.join(process.cwd(), 'public', 'scenes'),
        source: 'DATABASE_URL env var (file will be created)',
      }
    }
    // Non-file URL (libsql://, https://...) — can't auto-derive scenesDir,
    // and the user is probably on a remote DB so seeding via this script
    // is questionable. Bail loudly.
    throw new Error(
      `DATABASE_URL is set to a non-file URL (${url}). This script only supports local file: URLs. ` +
        `Comment out DATABASE_URL in .env to seed the local userData DB instead.`,
    )
  }

  // 2. Fall back to the Electron userData default (no env override case).
  const override = process.env.DREAMBYTE_USER_DATA
  const candidates = override
    ? [override]
    : [
        path.join(os.homedir(), 'Library/Application Support/dreambyte'),
        path.join(os.homedir(), 'Library/Application Support/Dreambyte'),
        path.join(os.homedir(), '.config/dreambyte'),
        path.join(os.homedir(), '.dreambyte/studio'),
      ]
  for (const dir of candidates) {
    const dbFile = path.join(dir, 'dreambyte.db')
    if (fs.existsSync(dbFile)) {
      return { dbFile, scenesDir: path.join(dir, 'scenes'), source: 'userData auto-detect' }
    }
  }
  throw new Error(
    `Could not find Dreambyte data dir. Looked in:\n${candidates.join('\n')}\n\n` +
      `Run Dreambyte at least once to create the DB, or set DREAMBYTE_USER_DATA / DATABASE_URL.`,
  )
}

// Imports MUST come after env vars are set — the db module reads
// DATABASE_URL on first initDb() call. So we do the env setup inside
// main() before any of the `await import('../lib/db/...')` calls.
async function main() {
  const { dbFile, scenesDir, source } = await locateAppData()
  process.env.DATABASE_URL = `file:${dbFile}`
  process.env.DREAMBYTE_SCENES_DIR = scenesDir

  console.log(`[seed] source    : ${source}`)
  console.log(`[seed] db        : ${dbFile}`)
  console.log(`[seed] scenesDir : ${scenesDir}`)

  if (!fs.existsSync(scenesDir)) fs.mkdirSync(scenesDir, { recursive: true })

  // Bring the user's DB up to the current schema. The app does this on
  // startup; we replicate it here so users who haven't launched the app
  // after pulling new code don't hit "missing column" errors mid-seed.
  const { runMigrations } = await import('../../src/lib/db/migrate')
  const migrationsFolder = path.join(process.cwd(), 'src', 'lib', 'db', 'migrations')
  console.log(`[seed] running migrations from ${migrationsFolder}`)
  await runMigrations({ url: process.env.DATABASE_URL, migrationsFolder })

  const { db } = await import('../../src/lib/db/index')
  const { projects, projectBranches, scenes } = await import('../../src/lib/db/schema')
  const { eq, sql } = await import('drizzle-orm')

  // SQLite locks DB writes per-process. If the running app is mid-autosave
  // when the seed fires its first write, the seed crashes with SQLITE_BUSY.
  // 10s timeout is enough to ride out any normal autosave window. If the
  // app has the DB jammed longer than that, the user should quit it.
  try {
    await db.run(sql`PRAGMA busy_timeout = 10000`)
  } catch (e) {
    console.warn('[seed] could not set busy_timeout:', (e as Error).message)
  }

  const projectName = 'Variant Compare Test'

  // ── 1. Clean any prior seed run so this script is rerunnable.
  const existing = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, projectName))
  for (const row of existing) {
    await db.delete(scenes).where(eq(scenes.projectId, row.id))
    await db.delete(projectBranches).where(eq(projectBranches.projectId, row.id))
    await db.delete(projects).where(eq(projects.id, row.id))
    console.log(`[seed] removed prior project ${row.id}`)
  }

  // ── 2. Define scenes per branch. Each branch gets 3 scenes with
  //       distinct bg colors so the comparison modal renders visibly
  //       different tiles.
  type SceneSpec = { name: string; bg: string; label: string }
  const PALETTES: Record<string, SceneSpec[]> = {
    main: [
      { name: 'Intro', bg: '#ff6b6b', label: 'INTRO · red' },
      { name: 'Hook', bg: '#4ecdc4', label: 'HOOK · teal' },
      { name: 'Outro', bg: '#ffe66d', label: 'OUTRO · yellow' },
    ],
    'variant-warm': [
      { name: 'Intro', bg: '#ff8a00', label: 'INTRO · orange' },
      { name: 'Hook', bg: '#e02d2d', label: 'HOOK · red' },
      { name: 'Outro', bg: '#ffc107', label: 'OUTRO · amber' },
    ],
    'variant-cool': [
      { name: 'Intro', bg: '#0077b6', label: 'INTRO · blue' },
      { name: 'Hook', bg: '#00b4d8', label: 'HOOK · cyan' },
      { name: 'Outro', bg: '#90e0ef', label: 'OUTRO · ice' },
    ],
    'variant-mono': [
      { name: 'Intro', bg: '#1a1a1a', label: 'INTRO · black' },
      { name: 'Hook', bg: '#6b6b6b', label: 'HOOK · gray' },
      { name: 'Outro', bg: '#e0e0e0', label: 'OUTRO · white' },
    ],
  }

  // ── 3. Pre-generate the main branch's scene IDs and full scene blobs
  //       up front. project.description.scenes MUST be populated with
  //       these — otherwise the app loads an empty project, auto-creates
  //       default scenes with random new IDs, and the sceneGraph ends up
  //       referencing those auto-IDs instead of the seeded scenes.
  //       (Symptom: the preview says "No content for <auto-id>".)
  const buildSceneBlob = (id: string, spec: SceneSpec) => ({
    id,
    name: spec.name,
    sceneType: 'svg' as const,
    duration: 4,
    bgColor: spec.bg,
    svgContent: `<rect width="1920" height="1080" fill="${spec.bg}"/>`,
    sceneHTML: '',
    canvasBackgroundCode: '',
    chartLayers: [],
    transition: 'none',
    d3Data: null,
  })
  const mainSceneIds = PALETTES.main.map(() => randomUUID())
  const mainScenesFull = PALETTES.main.map((spec, i) => buildSceneBlob(mainSceneIds[i], spec))

  const defaultBranchId = randomUUID()
  const trackV1Id = randomUUID()
  const trackV2Id = randomUUID()
  const trackA1Id = randomUUID()
  const timeline = {
    tracks: [
      {
        id: trackV1Id,
        name: 'V1',
        type: 'video' as const,
        clips: mainScenesFull.map((s, i) => ({
          id: randomUUID(),
          trackId: trackV1Id,
          sourceType: 'scene' as const,
          sourceId: s.id,
          label: s.name,
          startTime: i * 4,
          duration: 4,
          trimStart: 0,
          trimEnd: null,
          speed: 1,
          opacity: 1,
          position: { x: 0, y: 0 },
          scale: { x: 1, y: 1 },
          rotation: 0,
          filters: [],
          keyframes: [],
        })),
        muted: false,
        locked: false,
        position: 0,
      },
      { id: trackV2Id, name: 'V2', type: 'video' as const, clips: [], muted: false, locked: false, position: 1 },
      { id: trackA1Id, name: 'A1', type: 'audio' as const, clips: [], muted: false, locked: false, position: 2 },
    ],
  }
  const sceneGraph = {
    nodes: mainScenesFull.map((s, i) => ({ id: s.id, position: { x: i * 300, y: 100 } })),
    edges: [],
    startSceneId: mainScenesFull[0].id,
  }
  const description = JSON.stringify({ scenes: mainScenesFull, sceneGraph, timeline })

  // ── 4. Create the project with the full description so the app
  //       doesn't auto-fill defaults on first load.
  const projectId = randomUUID()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db.insert(projects) as any).values({
    id: projectId,
    name: projectName,
    outputMode: 'mp4',
    description,
    globalStyle: {
      presetId: null,
      palette: ['#ff6b6b', '#4ecdc4', '#ffe66d', '#95e1d3'],
      duration: 8,
      theme: 'dark',
    },
    apiPermissions: {},
  })
  console.log(`[seed] created project ${projectId} (${projectName})`)

  // ── 5. Create the default branch.
  await db.insert(projectBranches).values({
    id: defaultBranchId,
    projectId,
    name: 'main',
    isDefault: true,
    description: 'default branch',
  })
  console.log(`[seed] created default branch ${defaultBranchId} (main)`)

  // ── 5. Write main branch scenes + HTML, then create 3 variant branches.
  const branchIds: Array<{ name: string; id: string }> = []
  for (const [branchName, specs] of Object.entries(PALETTES)) {
    let branchId: string
    if (branchName === 'main') {
      branchId = defaultBranchId
    } else {
      branchId = randomUUID()
      await db.insert(projectBranches).values({
        id: branchId,
        projectId,
        name: branchName,
        isDefault: false,
        description: `variant — ${branchName.replace('variant-', '')} palette`,
      })
      console.log(`[seed] created branch ${branchId} (${branchName})`)
    }

    // Insert scenes for this branch. Main branch reuses pre-generated
    // IDs that match project.description (see step 3). Variant branches
    // get fresh IDs — the renderer loads variant scenes via
    // dreambyte:branches.loadEditorScenes which queries the scenes table by
    // branchId, so variant scene IDs are independent.
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]
      const sceneId = branchName === 'main' ? mainSceneIds[i] : randomUUID()
      await db.insert(scenes).values({
        id: sceneId,
        projectId,
        branchId,
        name: spec.name,
        position: i,
        duration: 4,
        bgColor: spec.bg,
        styleOverride: {} as any,
        transition: { type: 'cut', duration: 0 } as any,
        audioLayer: null,
        videoLayer: null,
        thumbnailUrl: null,
        cameraMotion: null,
        worldConfig: null,
        sceneBlob: {
          id: sceneId,
          name: spec.name,
          sceneType: 'svg',
          duration: 4,
          bgColor: spec.bg,
          svgContent: `<rect width="1920" height="1080" fill="${spec.bg}"/>`,
          sceneHTML: '',
        } as any,
      })

      // Write a minimal HTML file the BranchPreviewPlayer iframe can load.
      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;height:100%;font-family:-apple-system,system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.4)}
  body{background:${spec.bg};display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  .badge{font-size:12px;letter-spacing:.18em;opacity:.85;text-transform:uppercase}
  .label{font-size:48px;font-weight:800;margin-top:8px}
  .branch{margin-top:24px;font-size:14px;opacity:.7}
</style></head>
<body>
  <div class="badge">${branchName}</div>
  <div class="label">${spec.label}</div>
  <div class="branch">scene ${i + 1} of ${specs.length}</div>
</body></html>`
      fs.writeFileSync(path.join(scenesDir, `${sceneId}.html`), html, 'utf8')
    }

    branchIds.push({ name: branchName, id: branchId })
  }

  // ── 6. Done — print instructions.
  console.log('')
  console.log('─'.repeat(60))
  console.log('SEED COMPLETE')
  console.log('─'.repeat(60))
  console.log(`Project       : ${projectName} (id: ${projectId})`)
  console.log(`Branches      :`)
  for (const b of branchIds) console.log(`  - ${b.name.padEnd(20)} ${b.id}`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. Restart Dreambyte (or open it if not running).')
  console.log(`  2. Switch to the "${projectName}" project.`)
  console.log('  3. Open the branch selector dropdown in the Layers tab.')
  console.log('  4. Click "Compare 3 latest branches side by side".')
  console.log('  5. The comparison modal opens with the 3 variant branches.')
  console.log('  6. Click "Use this" on any tile to switch to that branch.')
  console.log('─'.repeat(60))

  process.exit(0)
}

main().catch((err) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
