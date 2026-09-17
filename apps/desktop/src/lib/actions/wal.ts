/**
 * Write-ahead log.
 *
 * Every dispatched action lands in `~/.dreambyte/projects/{projectId}/wal.jsonl`
 * synchronously *before* the reducer runs. On boot, any WAL entries not yet
 * flushed to the `action_log` table are replayed into both the table and the
 * materialized state.
 *
 * Failure-mode handling:
 *   - Corrupted JSONL line on read → skip + log.warn + quarantine the file
 *     by renaming it `wal.<timestamp>.corrupt.jsonl`. Continue boot.
 *   - Disk full (ENOSPC) on append → throws; the executor surfaces it as
 *     STORAGE_FULL with a "Free disk space" hint.
 *   - Multi-window concurrent writes → the OS guarantees `fs.appendFileSync`
 *     atomicity for write(2) calls under the page-size threshold (4kb on
 *     most filesystems); for actions with very large blobs, the executor
 *     should reference a content-addressable blob hash instead of inlining.
 *
 * This file deliberately uses `fs` synchronously. The async `appendAsync`
 * variant is provided for the renderer-side IPC stub which forwards to
 * main; renderers themselves never touch the filesystem.
 */

import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Action } from './types'
import type { WalWriter } from './executor'

export interface ProjectWalConfig {
  /** Absolute path to the project's `.dreambyte/` (or equivalent) root. */
  projectDir: string
}

const WAL_FILE = 'wal.jsonl'

function ensureDirSync(dir: string): void {
  fsSync.mkdirSync(dir, { recursive: true })
}

export function walPath(config: ProjectWalConfig): string {
  return path.join(config.projectDir, WAL_FILE)
}

/**
 * Synchronous WAL writer. Each `append` adds a single newline-terminated
 * JSON line. Throws on disk error; the executor catches and converts to a
 * STORAGE_FULL action error.
 */
export function createWalWriter(config: ProjectWalConfig): WalWriter {
  ensureDirSync(config.projectDir)
  const file = walPath(config)
  return {
    append(action: Action): void {
      const line = JSON.stringify(action) + '\n'
      fsSync.appendFileSync(file, line, { encoding: 'utf-8' })
    },
  }
}

export interface WalReadResult {
  actions: Action[]
  /** Number of corrupted lines that were skipped (not in `actions`). */
  corruptedLines: number
  /** Path to the quarantined file if any lines were corrupt. */
  quarantinePath?: string
}

/**
 * Read every WAL line, JSON-parsing each. Corrupted lines (parse failure)
 * are skipped and counted; if any are found, the original file is renamed
 * to `wal.<timestamp>.corrupt.jsonl` so a fresh WAL starts clean and the
 * operator can inspect the original.
 *
 * Note: callers must call `truncate(config)` once they've successfully
 * persisted the returned actions to the action_log table — otherwise on
 * the next boot the same actions replay again.
 */
export async function readWal(config: ProjectWalConfig): Promise<WalReadResult> {
  const file = walPath(config)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { actions: [], corruptedLines: 0 }
    throw err
  }

  const actions: Action[] = []
  let corruptedLines = 0
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      actions.push(JSON.parse(line) as Action)
    } catch {
      corruptedLines++
    }
  }

  if (corruptedLines === 0) return { actions, corruptedLines: 0 }

  const quarantinePath = path.join(config.projectDir, `wal.${Date.now()}.corrupt.jsonl`)
  try {
    await fs.rename(file, quarantinePath)
  } catch {
    // Best-effort. Even if rename fails the caller still has the parseable
    // actions; the next append will re-create the file via append flag.
  }
  return { actions, corruptedLines, quarantinePath }
}

/** Empty the WAL after its contents are durably persisted in action_log. */
export async function truncateWal(config: ProjectWalConfig): Promise<void> {
  const file = walPath(config)
  try {
    await fs.writeFile(file, '', 'utf-8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return
    throw err
  }
}

/**
 * Move an orphan WAL aside so boot replay stops retrying it every launch. Used
 * when the project's DB row is gone (deleted project, or a create that never
 * committed) — its WAL can never be replayed (the `project_id` FK has nothing
 * to point at), so we rename rather than delete: the actions stay recoverable
 * for forensics, but `readWal` no longer finds them. Returns the new path, or
 * undefined if there was nothing to move (best-effort, never throws).
 */
export async function quarantineWal(config: ProjectWalConfig): Promise<string | undefined> {
  const file = walPath(config)
  const dest = path.join(config.projectDir, `wal.${Date.now()}.orphaned.jsonl`)
  try {
    await fs.rename(file, dest)
    return dest
  } catch {
    // ENOENT (no WAL) or any rename failure — nothing more we can safely do.
    return undefined
  }
}

/**
 * In-memory WAL writer for tests. Records every appended action; never
 * touches disk. Lets us assert ordering + payload without a tmpdir setup.
 */
export function createMemoryWalWriter(): WalWriter & { actions: Action[] } {
  const actions: Action[] = []
  return {
    actions,
    append(action: Action) {
      actions.push(action)
    },
  }
}
