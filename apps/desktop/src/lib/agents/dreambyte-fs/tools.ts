// Scoped read-only filesystem tools for external agents (W7).
//
// External AI editors (Claude Code, Cursor, Codex) drive Dreambyte projects
// via the Tier 2 file mirror. This module is the read-side primitive
// they speak to: every tool resolves a subpath through `path-guard.ts`
// before touching disk, so a malformed argument can't escape the
// .dreambyte/ root.
//
// Read-only by design — write-back (and the conflict surface that
// would imply) is rejected at the tool boundary. The Cursor-style
// scene lock makes write-conflict handling unnecessary, but external
// agents writing scenes also has to round-trip through the import +
// reconcile path, which the IPC layer composes. Keeping this
// module pure-read is what lets the path guard be the only boundary
// we have to keep airtight.
//
// Tool surface (matches the natural MCP shape):
//
//   list_scenes()                       → [{ id, name, durationFrames? }]
//   read_project()                      → project.json contents (parsed)
//   read_scene(sceneId)                 → scene dreambyte.json contents (parsed)
//   read_scene_html(sceneId)            → rendered HTML string or null
//   list_assets()                       → [{ subpath, sizeBytes }]
//
// Each function takes the scope root as its first argument so the
// caller (typically the IPC handler or a future MCP transport) is
// responsible for binding the scope per session.

import path from 'node:path'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { safeResolve, PathEscapeError } from './path-guard'

/**
 * Read a file refusing to follow a symlink at the FINAL path component.
 * `safeResolve` collapses symlinks at check time, but there's a TOCTOU window
 * before the read: an attacker with write access to the scoped .dreambyte/ folder
 * could swap the leaf for a symlink to /etc/passwd between check and read.
 * O_NOFOLLOW makes open() fail atomically if the leaf
 * is a symlink, closing the race. (O_NOFOLLOW is POSIX-only; on platforms
 * without it this degrades to a normal open, where symlink attacks need
 * privileges anyway.)
 */
async function readFileNoFollow(target: string, encoding: BufferEncoding): Promise<string> {
  const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const fh = await fs.open(target, fsConstants.O_RDONLY | O_NOFOLLOW)
  try {
    return await fh.readFile(encoding)
  } finally {
    await fh.close()
  }
}

/**
 * Strict sceneId validator. A scene id must be alphanumeric +
 * dashes/underscores only — never contain path separators or `..`.
 * This is defense-in-depth: even if path.posix.join collapses `../`
 * to nothing, an id with a separator should still be refused at the
 * tool boundary so an attacker can't read /etc/passwd by smuggling
 * a path through a sceneId-shaped argument.
 */
const SCENE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
function assertValidSceneId(sceneId: unknown): asserts sceneId is string {
  if (typeof sceneId !== 'string' || sceneId.length === 0 || !SCENE_ID_RE.test(sceneId)) {
    throw new DreambyteFsError('sceneId must be alphanumeric (with - or _ separators)', 'OUT_OF_SCOPE')
  }
}

export class DreambyteFsError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'CORRUPT' | 'OUT_OF_SCOPE' | 'INTERNAL',
  ) {
    super(message)
    this.name = 'DreambyteFsError'
  }
}

export interface SceneSummary {
  id: string
  name: string
  durationSeconds?: number
  sceneType?: string
}

export interface AssetEntry {
  subpath: string
  sizeBytes: number
}

/** Read project.json. Throws DreambyteFsError on missing or corrupt. */
export async function readProject(scopeRoot: string): Promise<Record<string, unknown>> {
  const target = await resolveOrEscape(scopeRoot, 'project.json')
  return readJsonOrThrow(target, 'project.json')
}

/** Walk sceneOrder + return one summary per existing scene. Missing scene files are silently skipped — the Tier 2 import path handles warnings; tools return what's actually loadable. */
export async function listScenes(scopeRoot: string): Promise<SceneSummary[]> {
  const projJson = await readProject(scopeRoot)
  const sceneOrder = projJson.sceneOrder
  if (!Array.isArray(sceneOrder)) {
    throw new DreambyteFsError('project.json has no sceneOrder array', 'CORRUPT')
  }
  const summaries: SceneSummary[] = []
  for (const id of sceneOrder) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (!SCENE_ID_RE.test(id)) continue // skip ids with path-like content
    try {
      const scenePath = await safeResolve(scopeRoot, path.posix.join('scenes', `${id}.dreambyte.json`))
      const text = await readFileNoFollow(scenePath, 'utf-8')
      const data = JSON.parse(text) as Record<string, unknown>
      summaries.push({
        id,
        name: typeof data.name === 'string' ? data.name : id,
        durationSeconds: typeof data.duration === 'number' ? (data.duration as number) : undefined,
        sceneType: typeof data.sceneType === 'string' ? (data.sceneType as string) : undefined,
      })
    } catch (err: unknown) {
      if (err instanceof PathEscapeError) throw err
      // ENOENT / SyntaxError / PathNotFoundError → skip silently
    }
  }
  return summaries
}

/** Read a single scene's dreambyte.json. */
export async function readScene(scopeRoot: string, sceneId: string): Promise<Record<string, unknown>> {
  assertValidSceneId(sceneId)
  const target = await resolveOrEscape(scopeRoot, path.posix.join('scenes', `${sceneId}.dreambyte.json`))
  return readJsonOrThrow(target, `scenes/${sceneId}.dreambyte.json`)
}

/** Read a scene's rendered HTML. Returns null if no rendered HTML exists. */
export async function readSceneHtml(scopeRoot: string, sceneId: string): Promise<string | null> {
  assertValidSceneId(sceneId)
  const target = await resolveOrEscape(scopeRoot, path.posix.join('scenes', `${sceneId}.html`))
  try {
    return await readFileNoFollow(target, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new DreambyteFsError(`Failed to read scene HTML: ${(err as Error).message}`, 'INTERNAL')
  }
}

/** Enumerate assets/ subtree. Returns relative subpaths + sizes. */
export async function listAssets(scopeRoot: string): Promise<AssetEntry[]> {
  // Use the realpath form for relative-path calculation. macOS's
  // /var → /private/var symlink otherwise produces relative paths
  // full of "../" because the readdir-iterated paths are real and
  // the original scopeRoot string isn't.
  let realRoot: string
  try {
    realRoot = await fs.realpath(scopeRoot)
  } catch {
    return []
  }
  const assetsDir = path.join(realRoot, 'assets')
  try {
    return await walkAssets(assetsDir, realRoot)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function walkAssets(dir: string, realRoot: string, acc: AssetEntry[] = []): Promise<AssetEntry[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return acc
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, String(entry.name))
    // Re-validate every entry: a symlinked subdir could escape scope
    // mid-walk. Realpath the entry then check containment.
    let realFull: string
    try {
      realFull = await fs.realpath(full)
    } catch {
      continue
    }
    if (!realFull.startsWith(realRoot + path.sep) && realFull !== realRoot) continue // skip leaks
    if (entry.isDirectory()) {
      await walkAssets(full, realRoot, acc)
    } else if (entry.isFile()) {
      const stat = await fs.stat(full)
      const rel = path.relative(realRoot, full)
      acc.push({ subpath: rel.split(path.sep).join('/'), sizeBytes: stat.size })
    }
  }
  return acc
}

// ── helpers ──────────────────────────────────────────────────────────────

async function resolveOrEscape(
  scopeRoot: string,
  subpath: string,
  opts: { mustExist?: boolean } = {},
): Promise<string> {
  try {
    return await safeResolve(scopeRoot, subpath, opts)
  } catch (err: unknown) {
    if (err instanceof PathEscapeError) {
      throw new DreambyteFsError(err.message, 'OUT_OF_SCOPE')
    }
    throw err
  }
}

async function readJsonOrThrow(target: string, label: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFileNoFollow(target, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DreambyteFsError(`${label} not found`, 'NOT_FOUND')
    }
    throw new DreambyteFsError(`Failed to read ${label}: ${(err as Error).message}`, 'INTERNAL')
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch (err: unknown) {
    throw new DreambyteFsError(`Corrupt JSON in ${label}: ${(err as Error).message}`, 'CORRUPT')
  }
}
