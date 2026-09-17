/**
 * Boot-time WAL replay (crash recovery).
 *
 * Every `dispatchAction` writes the action to the per-project WAL *before*
 * the reducer runs. The fire-and-forget DB write may not have landed if
 * the process crashed mid-flush. On boot we scan every project's WAL,
 * idempotently re-insert the missing rows into `action_log`, and then
 * truncate the WAL.
 *
 * Idempotency: `appendActionRows` already filters out ids that already
 * exist, so replaying a WAL twice in a row is a no-op against the DB.
 *
 * Pure-ish: accepts injectable file + DB ops so the test harness can run
 * without an Electron context.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { Action } from './types'
import { readWal, truncateWal, quarantineWal } from './wal'

export interface ReplayDeps {
  /** Returns the absolute path of the project root for a given projectId. */
  resolveProjectDir(projectId: string): string
  /** Batch-insert actions (id-collision idempotent). */
  appendActionRows(projectId: string, actions: Action[], branchId: string | null): Promise<void>
  /**
   * Whether the project still has a DB row. WAL dirs outlive their project
   * (delete leaves the dir; a create can crash before committing its row), so
   * without this guard replay fails every insert against the project_id FK and
   * — since we only truncate on success — re-fails on every boot. Returns true
   * if absent (no guard) so callers in non-DB contexts keep prior behavior.
   */
  projectExists?(projectId: string): Promise<boolean>
}

export interface ReplayResult {
  projectId: string
  replayed: number
  corruptedLines: number
  quarantinePath?: string
  /** Set when the WAL was non-empty but the DB write failed; we leave the WAL alone for next boot. */
  error?: string
  /** Set when the project's DB row is gone — its WAL was skipped and moved aside. */
  skippedOrphan?: boolean
}

/**
 * Replay one project's WAL. Returns the number of actions inserted into
 * `action_log` (which already de-dupes by id). The WAL is truncated only
 * after a successful DB write — on error the file is left intact so the
 * next boot can try again.
 */
export async function replayProjectWal(projectId: string, deps: ReplayDeps): Promise<ReplayResult> {
  const projectDir = deps.resolveProjectDir(projectId)
  const { actions, corruptedLines, quarantinePath } = await readWal({ projectDir })
  if (actions.length === 0) {
    return { projectId, replayed: 0, corruptedLines, quarantinePath }
  }
  // Orphan guard: if the project's DB row is gone, its WAL can never replay
  // (the project_id FK has nothing to reference). Skip the insert and move the
  // WAL aside so this dir stops being scanned + stops spamming FK errors every
  // boot. Deleted projects and crashed-mid-create projects both land here.
  if (deps.projectExists && !(await deps.projectExists(projectId))) {
    const orphanedPath = await quarantineWal({ projectDir })
    return {
      projectId,
      replayed: 0,
      corruptedLines,
      skippedOrphan: true,
      quarantinePath: orphanedPath ?? quarantinePath,
    }
  }
  try {
    await deps.appendActionRows(projectId, actions, null)
  } catch (err) {
    return {
      projectId,
      replayed: 0,
      corruptedLines,
      quarantinePath,
      error: (err as Error).message,
    }
  }
  // Successful DB write — truncate so the next boot doesn't re-replay.
  await truncateWal({ projectDir })
  return { projectId, replayed: actions.length, corruptedLines, quarantinePath }
}

/**
 * Enumerate every project directory under `projectsRoot` and replay each.
 * Returns one `ReplayResult` per project that had pending WAL content.
 */
export async function replayAllProjectWals(projectsRoot: string, deps: ReplayDeps): Promise<ReplayResult[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(projectsRoot)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return []
    throw err
  }
  const results: ReplayResult[] = []
  for (const entry of entries) {
    // Skip non-directory entries + anything that doesn't look like a project id.
    const abs = path.join(projectsRoot, entry)
    let stat
    try {
      stat = await fs.stat(abs)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const result = await replayProjectWal(entry, deps).catch(
      (err) =>
        ({
          projectId: entry,
          replayed: 0,
          corruptedLines: 0,
          error: (err as Error).message,
        }) as ReplayResult,
    )
    if (result.replayed > 0 || result.error || result.corruptedLines > 0 || result.skippedOrphan) {
      results.push(result)
    }
  }
  return results
}
