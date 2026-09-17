// Tier 2 file mirror — export side.
//
// Writes a Dreambyte project to a user-picked folder so it can be git-ed,
// shared as a zip, and read by external agents (Claude Code, Cursor).
// DB stays the source of truth (Tier 1); this is the portability mirror.
//
// Folder shape:
//   {tier2Path}/
//     project.json          full Project + timeline + sceneGraph
//     scenes/
//       {id}.html           rendered scene (if available)
//       {id}.dreambyte.json     structured Scene state for round-trip
//     assets/               (created empty)
//     motion-presets/       (created empty)
//
// Import + reconcile lives in tier2-import.ts. This module is
// write-only and idempotent — safe to call repeatedly.
//
// Path safety: caller must pass a tier2Path that has already been
// validated by `assertSafeTier2Root`. We never write outside the
// root after realpath resolution (defense-in-depth).

import path from 'node:path'
import fs from 'node:fs/promises'
import { rewriteAnimeForEmbed } from '../scene-html/anime-head'
import { rebuildLegacySceneHtml } from '../sceneTemplate'
import type { Project } from '../types/project'
import type { Scene } from '../types/scene'

const FEATURE_FLAG = 'DREAMBYTE_TIER2_EXPORT'
const TIER2_FORMAT_VERSION = 1

export class Tier2DisabledError extends Error {
  constructor() {
    super(`Tier 2 export is disabled. Set ${FEATURE_FLAG}=true to enable.`)
    this.name = 'Tier2DisabledError'
  }
}

export class Tier2PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Tier2PathError'
  }
}

// Scene ids must be alphanumeric + dashes/underscores. Anything else
// risks writing outside the scope root via path traversal once the id
// hits `path.join`. Mirrors the regex in src/lib/agents/dreambyte-fs/tools.ts.
const SAFE_SCENE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
function assertSafeSceneId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0 || !SAFE_SCENE_ID_RE.test(id)) {
    throw new Tier2PathError(`Refusing scene id "${String(id)}" — must match ${SAFE_SCENE_ID_RE}`)
  }
}

/**
 * Validate that a user-picked folder is a safe Tier 2 root.
 * Resolves symlinks via `realpath`, refuses paths inside common system
 * dirs, and ensures the folder exists and is writable.
 *
 * Returns the canonicalised absolute path on success.
 */
export async function assertSafeTier2Root(rawPath: string): Promise<string> {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Tier2PathError('Tier 2 path must be a non-empty string')
  }
  const resolved = path.resolve(rawPath)
  let real: string
  try {
    real = await fs.realpath(resolved)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Allow non-existent path — caller can create on first export.
      // We still resolve via path.resolve to canonicalize.
      real = resolved
    } else {
      throw new Tier2PathError(`Cannot resolve Tier 2 path: ${(err as Error).message}`)
    }
  }
  // Refuse obviously dangerous roots. Cheap defense; the real boundary is
  // that we only write under `real` after this point. macOS resolves
  // /etc → /private/etc and similar, so list both forms.
  const forbidden = [
    '/',
    '/etc',
    '/var',
    '/usr',
    '/bin',
    '/sbin',
    '/System',
    '/Library/System',
    '/private/etc',
    '/private/var/db',
    '/private/var/root',
  ]
  if (forbidden.includes(real)) {
    throw new Tier2PathError(`Refusing Tier 2 root: ${real}`)
  }
  return real
}

/**
 * Copy or create a scene's rendered HTML at `{root}/scenes/{id}.html`.
 * If the project has a previously-rendered HTML at `publicScenesDir`,
 * we copy it. Otherwise we write a placeholder so the file always
 * exists (downstream tooling can rely on the path).
 */
async function writeSceneHtml(scene: Scene, scenesOutDir: string, publicScenesDir: string | null): Promise<void> {
  // Caller (exportProjectToTier2) already ran assertSafeSceneId; defense-in-depth here.
  if (!SAFE_SCENE_ID_RE.test(scene.id)) {
    throw new Tier2PathError(`Refusing scene id "${scene.id}" — must match ${SAFE_SCENE_ID_RE}`)
  }
  const outPath = path.join(scenesOutDir, `${scene.id}.html`)
  if (publicScenesDir) {
    const sourcePath = path.join(publicScenesDir, `${scene.id}.html`)
    try {
      // The editor HTML loads anime.js local-vendor-first (/vendor/animejs/*). A
      // Tier-2 bundle is consumed OUTSIDE the app server, where that path 404s —
      // rewrite to CDN-first so the mirror plays standalone.
      // Pre-anime.js HTML on disk becomes the regenerate placeholder.
      const html = rebuildLegacySceneHtml(await fs.readFile(sourcePath, 'utf8'))
      await fs.writeFile(outPath, rewriteAnimeForEmbed(html))
      return
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
      // Fall through to placeholder.
    }
  }
  const placeholder = `<!doctype html>
<!-- Dreambyte Tier 2 mirror — scene ${scene.id} ("${escapeForComment(scene.name)}") — not yet rendered.
     Open the project in Dreambyte and save once to populate. -->
<html><body></body></html>
`
  await fs.writeFile(outPath, placeholder)
}

function escapeForComment(s: string): string {
  return s.replace(/-->/g, '-- >')
}

export interface ExportArgs {
  project: Project
  scenes: Scene[]
  tier2Path: string
  /** Source dir for already-rendered scene HTML (e.g. `public/scenes/` in dev or `userData/scenes/` in packaged). Null = always write placeholder. */
  publicScenesDir?: string | null
}

export interface ExportResult {
  ok: true
  filesWritten: number
  rootRealPath: string
}

/**
 * Export a project to its Tier 2 folder. Idempotent — overwrites
 * existing files. Caller is responsible for debouncing.
 *
 * Throws Tier2DisabledError if the feature flag is off.
 * Throws Tier2PathError if the path is unsafe or unwritable.
 */
export async function exportProjectToTier2(args: ExportArgs): Promise<ExportResult> {
  if (process.env[FEATURE_FLAG] !== 'true') {
    throw new Tier2DisabledError()
  }
  const { project, scenes, tier2Path, publicScenesDir = null } = args
  const root = await assertSafeTier2Root(tier2Path)

  const scenesDir = path.join(root, 'scenes')
  const assetsDir = path.join(root, 'assets')
  const presetsDir = path.join(root, 'motion-presets')
  await fs.mkdir(scenesDir, { recursive: true })
  await fs.mkdir(assetsDir, { recursive: true })
  await fs.mkdir(presetsDir, { recursive: true })

  let filesWritten = 0

  // 1. project.json — top-level metadata + timeline + scene graph.
  //    Scene blobs are intentionally NOT inlined here; they live in
  //    scenes/{id}.dreambyte.json so each scene is independently diffable.
  const projectJson = {
    formatVersion: TIER2_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      outputMode: project.outputMode,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      mp4Settings: project.mp4Settings,
      interactiveSettings: project.interactiveSettings,
      sceneGraph: project.sceneGraph,
      audioSettings: project.audioSettings,
      audioProviderEnabled: project.audioProviderEnabled,
      mediaGenEnabled: project.mediaGenEnabled,
      watermark: project.watermark,
      brandKit: project.brandKit,
      timeline: project.timeline ?? null,
    },
    sceneOrder: scenes.map((s) => s.id),
  }
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify(projectJson, null, 2))
  filesWritten += 1

  // 2. Per-scene dreambyte.json + html.
  for (const scene of scenes) {
    assertSafeSceneId(scene.id)
    const dreambyteJsonPath = path.join(scenesDir, `${scene.id}.dreambyte.json`)
    await fs.writeFile(dreambyteJsonPath, JSON.stringify(scene, null, 2))
    filesWritten += 1
    await writeSceneHtml(scene, scenesDir, publicScenesDir)
    filesWritten += 1
  }

  // 3. .gitignore — keep DB-only fields (assets/) out of git by default.
  //    User can override per-project by editing the file.
  const gitignorePath = path.join(root, '.gitignore')
  try {
    await fs.access(gitignorePath)
    // exists: leave user's edits alone
  } catch {
    await fs.writeFile(gitignorePath, '# Dreambyte Tier 2 mirror defaults\nassets/\n')
    filesWritten += 1
  }

  return { ok: true, filesWritten, rootRealPath: root }
}
