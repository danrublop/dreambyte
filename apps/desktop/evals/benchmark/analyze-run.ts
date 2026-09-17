#!/usr/bin/env tsx
/**
 * Pull a REAL in-app agent run by id and produce the benchmark's render-health
 * + defect analysis — "everything we'd get had I run it myself", after YOU ran
 * it interactively (with the Director loop toggle on/off in Settings → Agents).
 *
 * This is the retrospective half of the A/B: you spend the API budget in-app and
 * judge coherence with your own eyes; this reads the persisted run back out and
 * grades render health mechanically (errored / blank / broken / misplaced) with
 * the SAME scorer + the SAME offscreen verifier the offline benchmark uses.
 *
 *   npx tsx --tsconfig evals/benchmark/tsconfig.json evals/benchmark/analyze-run.ts \
 *     --conversation <conversationId>          # or --project <projectId>
 *     [--db file:/abs/path/to/studio.db]       # default: DATABASE_URL, else the macOS app DB
 *     [--scenes-dir <dir>]                     # render on-disk HTML instead of regenerating from the blob
 *     [--render off]                           # skip the offscreen render (structural only)
 *     [--min-scenes N] [--expect-narration] [--expect-type explainer]
 *
 * READ-ONLY: never writes to the DB. Regenerates each scene's HTML from its
 * persisted blob into a throwaway temp dir (location-independent — no dependency
 * on where the app stored files), then renders that.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { config } from 'dotenv'
import {
  scoreBenchmark,
  type BenchmarkCase,
  type BenchmarkScene,
  type RunObservation,
  type SceneRenderHealth,
} from './score'

config({ path: '.env' })
config({ path: '.env.local' })

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else out[key] = 'true'
  }
  return out
}

interface RawVerifyOutcome {
  status: SceneRenderHealth['status']
  error?: { kind?: string; message?: string } | null
  frame?: SceneRenderHealth['frame']
  overflows?: SceneRenderHealth['overflows']
}

/** Normalize a persisted scene blob into the scorer's BenchmarkScene shape.
 *  (Mirrors run.ts:normalizeScene — kept local so this stays a standalone tool.) */
function normalizeScene(row: Record<string, unknown>): BenchmarkScene {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const code =
    str(row.reactCode) || str(row.sceneCode) || str(row.canvasCode) || str(row.svgContent) || str(row.lottieSource)
  const audio = (row.audioLayer && typeof row.audioLayer === 'object' ? row.audioLayer : {}) as Record<string, unknown>
  const aiLayers = Array.isArray(row.aiLayers) ? (row.aiLayers as Array<Record<string, unknown>>) : []
  const hasNarration =
    Boolean(audio.enabled && audio.src) ||
    Boolean(row.narrationUrl) ||
    aiLayers.some((l) => l.type === 'audio' || l.type === 'narration' || Boolean(l.narrationUrl))
  const IMAGERY_AI = new Set(['image', 'sticker', 'veo3', 'avatar'])
  const video = (row.videoLayer && typeof row.videoLayer === 'object' ? row.videoLayer : {}) as Record<string, unknown>
  const hasImagery = Boolean(video.enabled && video.src) || aiLayers.some((l) => IMAGERY_AI.has(str(l.type)))
  const isPlaceholder = code.trim().length === 0 || /PLACEHOLDER|__shell__|BUILDING/i.test(code)
  return { id: str(row.id) || 'unknown', code, hasNarration, isPlaceholder, hasImagery }
}

function renderHealth(here: string, scenesDir: string, sceneIds: string[]): Record<string, SceneRenderHealth> {
  const out: Record<string, SceneRenderHealth> = {}
  if (sceneIds.length === 0) return out
  const work = mkdtempSync(join(tmpdir(), 'analyze-render-'))
  const manifestPath = join(work, 'manifest.json')
  const outPath = join(work, 'out.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({ scenesDir, scenes: sceneIds.map((id) => ({ sceneId: id, file: `${id}.html` })) }),
    'utf8',
  )
  try {
    execFileSync('npx', ['electron', join(here, 'render-verify.mjs'), manifestPath, outPath], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 5 * 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    })
    const raw = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, RawVerifyOutcome>
    for (const id of sceneIds) {
      const o = raw[id]
      out[id] = o
        ? {
            status: o.status,
            ...(o.error?.kind ? { errorKind: o.error.kind } : {}),
            ...(o.error?.message ? { errorMessage: o.error.message } : {}),
            ...(o.frame ? { frame: o.frame } : {}),
            ...(o.overflows ? { overflows: o.overflows } : {}),
          }
        : { status: 'unknown' }
    }
  } catch (e) {
    process.stderr.write(`[analyze] render step skipped (honest): ${(e as Error).message}\n`)
    for (const id of sceneIds) out[id] = { status: 'unknown' }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const conversationId = args['conversation']
  let projectId = args['project']
  if (!conversationId && !projectId) {
    console.error('[analyze] pass --conversation <id> or --project <id>')
    process.exit(2)
  }

  // Point at the app DB (read-only). Default to the packaged macOS app's dreambyte.db;
  // for a dev (dev:desktop) run pass --db file:/abs/worktree/dev.db.
  const dbUrl =
    args['db'] ||
    process.env.DATABASE_URL ||
    `file:${join(homedir(), 'Library', 'Application Support', 'dreambyte', 'dreambyte.db')}`
  process.env.DATABASE_URL = dbUrl

  const { db } = await import('@/lib/db')
  const { getProjectScenesLight, getProjectBrief, getProjectSettingsRow } = await import('@/lib/db/queries/projects')

  if (!projectId && conversationId) {
    const { conversations } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) })
    if (!row) {
      console.error(`[analyze] no conversation ${conversationId} in ${dbUrl}`)
      process.exit(1)
    }
    projectId = row.projectId
  }

  console.error(
    `[analyze] db=${dbUrl} project=${projectId}${conversationId ? ` (conversation ${conversationId})` : ''}`,
  )

  const sceneRows = (await getProjectScenesLight(projectId!)) as Array<Record<string, unknown>>
  const scenes = sceneRows.map(normalizeScene)
  const brief = await getProjectBrief(projectId!).catch(() => null)
  const settings = await getProjectSettingsRow(projectId!).catch(() => null)

  const render = (args['render'] || 'on').toLowerCase() !== 'off'
  if (render && scenes.length > 0) {
    const here = fileURLToPath(new URL('.', import.meta.url))
    let scenesDir = args['scenes-dir']
    const renderable = scenes.filter((s) => !s.isPlaceholder && s.code.trim().length > 0)

    if (!scenesDir) {
      // Regenerate each scene's HTML from its persisted blob — location-independent,
      // reproduces exactly what the scene renders as. Reuses the app's own template.
      const { generateSceneHTML } = await import('@/lib/sceneTemplate')
      const { resolveProjectDimensions } = await import('@/lib/dimensions')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalStyle = (settings?.globalStyle ?? { presetId: null }) as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mp4 = (settings?.mp4Settings ?? {}) as any
      const dims = resolveProjectDimensions(mp4.aspectRatio, mp4.resolution)
      scenesDir = mkdtempSync(join(tmpdir(), 'analyze-html-'))
      for (const row of sceneRows) {
        const s = normalizeScene(row)
        if (s.isPlaceholder || s.code.trim().length === 0) continue
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const html = generateSceneHTML(row as any, globalStyle, undefined, undefined, dims)
          writeFileSync(join(scenesDir, `${s.id}.html`), html, 'utf8')
        } catch (e) {
          process.stderr.write(`[analyze] could not regenerate HTML for ${s.id}: ${(e as Error).message}\n`)
        }
      }
    }

    const ids = renderable.filter((s) => existsSync(join(scenesDir!, `${s.id}.html`))).map((s) => s.id)
    const health = renderHealth(here, scenesDir, ids)
    for (const s of scenes) if (health[s.id]) s.render = health[s.id]
  }

  const caseDef: BenchmarkCase = {
    id: projectId!,
    minScenes: args['min-scenes'] ? parseInt(args['min-scenes'], 10) : 1,
    expectNarration: args['expect-narration'] === 'true',
    ...(args['expect-type'] ? { expectVideoType: args['expect-type'] } : {}),
  }
  const renderableCount = scenes.filter((s) => !s.isPlaceholder && s.code.trim().length > 0).length
  const obs: RunObservation = {
    plannedCount: renderableCount, // no live plan on a pulled run — use the landed count
    persistOk: scenes.length > 0, // scenes are in the table ⇒ persistence succeeded
    ...(brief?.videoType ? { resolvedVideoType: brief.videoType } : {}),
    scenes,
  }
  const score = scoreBenchmark(caseDef, obs)

  console.log(`\n=== RUN ANALYSIS (render-health + structural, NOT taste) ===`)
  console.log(`project ${projectId} · ${scenes.length} scenes (${renderableCount} renderable)`)
  console.log(`videoType: ${brief?.videoType ?? '(no brief)'}`)
  console.log(
    `render gate: ${score.renderGateApplied ? 'applied' : 'SKIPPED (no offscreen render — verdict is weaker)'}`,
  )
  console.log(`\nper-scene:`)
  for (const s of scenes) {
    const r = s.render
    const line = !r
      ? '—'
      : r.status === 'errored'
        ? `ERRORED (${r.errorKind ?? 'error'}: ${(r.errorMessage ?? '').slice(0, 60)})`
        : r.status === 'unknown'
          ? 'unknown (not measured)'
          : `${r.status}${r.frame ? ` · nonblank=${r.frame.nonblankRatio.toFixed(3)} colors=${r.frame.distinctColors}` : ''}${r.overflows?.length ? ` · overflow×${r.overflows.length}` : ''}`
    console.log(`  ${s.isPlaceholder ? '[shell] ' : ''}${s.id.slice(0, 12).padEnd(13)} ${line}`)
  }
  if (score.defects.length) {
    console.log(`\nDEFECTS (would fail the benchmark):`)
    for (const d of score.defects)
      console.log(`  ✗ ${d.kind}${d.sceneId ? ` [${d.sceneId.slice(0, 12)}]` : ''}: ${d.detail}`)
  }
  if (score.advisories.length) {
    console.log(`\nadvisories (reported, non-gating):`)
    for (const a of score.advisories)
      console.log(`  · ${a.kind}${a.sceneId ? ` [${a.sceneId.slice(0, 12)}]` : ''}: ${a.detail}`)
  }
  console.log(
    `\nVERDICT: ${score.passed ? 'PASS — no render-health / structural defects' : 'FAIL — see defects above'}`,
  )
  process.exit(score.passed ? 0 : 1)
}

main().catch((e) => {
  console.error('[analyze] fatal:', e)
  process.exit(2)
})
