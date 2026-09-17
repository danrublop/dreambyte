import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Orphan scene-HTML garbage collection.
 *
 * Scene HTML files are written to the scenes dir on every persist, but unlink
 * only ever happened on project delete — scenes created after a checkpoint
 * and removed by rollback (or replaced by an agent persist under a new id)
 * leave `scenes/{id}.html` on disk forever. Inert but unbounded across
 * build/rollback loops.
 *
 * The sweep deletes `.html` files whose basename is not a live scene id.
 * Deliberately conservative:
 *   - only touches files matching the scene-id shape (`/^[a-zA-Z0-9-]+\.html$/`)
 *     — anything else in the dir is not ours to delete;
 *   - SKIPS entirely when the live-id set is empty — an empty/missing DB
 *     (fresh install, mid-migration race) must not read as "everything is
 *     an orphan";
 *   - per-file errors are swallowed (best-effort, like every other file
 *     cleanup in the app);
 *   - orphans are regenerable anyway (HTML derives from scene code in the
 *     DB), so a false positive costs one regeneration, never data.
 *
 * Deps are injected so the sweep is unit-testable without Electron or SQLite.
 */

const SCENE_HTML_FILE_RE = /^[a-zA-Z0-9-]+\.html$/

export interface SweepResult {
  scanned: number
  deleted: number
  /** True when the sweep refused to run (empty live set / unreadable dir). */
  skipped: boolean
}

/**
 * Collect ALL live scene ids — scenes-table rows ∪ legacy project blob ids.
 *
 * STRICT on malformed blobs: the
 * shared readProjectSceneBlob SWALLOWS JSON.parse errors and returns
 * `{scenes: []}` — which here would silently turn a corrupt project's live
 * scene files into "orphans" and delete them. So this parses the blob with a
 * bare JSON.parse and lets a malformed one THROW; the sweep's caller treats
 * any throw as "abort, delete nothing". A non-object parse result (legacy
 * plain-text descriptions) is treated as "no blob scenes", not an error.
 */
export function collectLiveSceneIds(
  sceneRows: Array<{ id: string }>,
  projectRows: Array<{ description: string | null }>,
): Set<string> {
  const ids = new Set<string>()
  for (const row of sceneRows) ids.add(row.id)
  for (const row of projectRows) {
    if (!row.description) continue
    const parsed: unknown = JSON.parse(row.description) // malformed → throws → sweep aborts
    if (typeof parsed !== 'object' || parsed === null) continue
    const scenes = (parsed as { scenes?: unknown }).scenes
    if (!Array.isArray(scenes)) continue
    for (const s of scenes) {
      const id = (s as { id?: unknown } | null)?.id
      if (typeof id === 'string') ids.add(id)
    }
  }
  return ids
}

export async function sweepOrphanSceneHtml(opts: {
  scenesDir: string
  /** ALL live scene ids — every project, every branch. */
  getLiveSceneIds: () => Promise<Set<string>>
  /** Injected for tests; defaults to real fs. */
  fsImpl?: Pick<typeof fs, 'readdir' | 'unlink'>
}): Promise<SweepResult> {
  const fsi = opts.fsImpl ?? fs

  let live: Set<string>
  try {
    live = await opts.getLiveSceneIds()
  } catch {
    return { scanned: 0, deleted: 0, skipped: true }
  }
  // Empty DB ⇒ refuse — a fresh install or a migration race must not turn
  // the whole dir into "orphans".
  if (live.size === 0) return { scanned: 0, deleted: 0, skipped: true }

  let entries: string[]
  try {
    entries = await fsi.readdir(opts.scenesDir)
  } catch {
    return { scanned: 0, deleted: 0, skipped: true } // dir missing — nothing to sweep
  }

  let scanned = 0
  let deleted = 0
  for (const name of entries) {
    if (!SCENE_HTML_FILE_RE.test(name)) continue
    scanned++
    const id = name.slice(0, -'.html'.length)
    if (live.has(id)) continue
    try {
      await fsi.unlink(path.join(opts.scenesDir, name))
      deleted++
    } catch {
      // Best-effort: a locked/already-gone file is non-fatal.
    }
  }
  return { scanned, deleted, skipped: false }
}
