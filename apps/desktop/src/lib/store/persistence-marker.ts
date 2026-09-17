'use client'

/**
 * Durable pending-save marker.
 *
 * The crash window this closes: scene HTML files and the project's DB row are
 * written by two different paths (renderer IPC writes the HTML files; the DB
 * row is written by the main process after an agent run, or by
 * saveProjectToDb for user edits). A crash between "work exists in memory /
 * on disk as HTML" and "DB row committed" used to be invisible: the next boot
 * loaded the stale DB row and the finished work silently vanished.
 *
 * The marker is written to localStorage SYNCHRONOUSLY before the risky
 * persistence step starts and cleared once the DB is confirmed fresh. An
 * in-memory flag cannot do this job — the crash that creates the problem also
 * erases the flag.
 *
 * Keying: markers are keyed per (projectId, branchId). A single
 * project-keyed marker let an agent run on branch A and a routine auto-save
 * on branch B overwrite/clear each other's crash evidence — last-writer-wins
 * exactly when two things were in flight, the scenario most likely to
 * accompany a crash. Branch-keying makes every writer clear only its own
 * marker. Boot reconciliation scans ALL markers under the project prefix.
 *
 * Known residual (accepted, documented): freshness is judged against the
 * PROJECT row's updatedAt (the lightweight getVersion probe has no per-branch
 * timestamp), so a cross-branch save landing after a failed branch persist
 * can still falsely read as "fresh". The marker is a safety net, not a
 * ledger.
 *
 * Timestamp semantics (`ts`): the moment after which a fresh DB row proves
 * the work was persisted.
 *  - Agent runs use the run's `_agentRunStartedAt` — the main process
 *    persists scenes BEFORE the done event reaches the renderer, so
 *    `db.updatedAt > runStart` means the run landed.
 *  - User saves use Date.now() at save start.
 *
 * Tolerance: the DB stores `updatedAt` at SECOND precision
 * (drizzle integer timestamp mode / unixepoch), while marker `ts` is
 * milliseconds. Without slack, a save landing in the same wall-clock second
 * as the marker reads as stale → false "changes may be missing" notices that
 * train users to ignore the real warning. All freshness comparisons use
 * DB_TIMESTAMP_TOLERANCE_MS.
 */

import { createLogger } from '../logger'

const log = createLogger('store.persistence-marker')

export interface PendingSaveMarker {
  projectId: string
  branchId: string | null
  /** Scene ids in flight when the marker was set (C5 — lets the notice and
   *  logs say WHICH scenes may be affected instead of a blanket warning). */
  sceneIds: string[]
  /** See "Timestamp semantics" above. */
  ts: number
  /** Writer identity (#124 post-merge review): two overlapping saves on the
   *  SAME (project, branch) used to be last-writer-wins — the first save's
   *  clear removed the marker the second save was still relying on, so a
   *  crash during the second left no marker at boot. Each set returns a
   *  nonce; a nonce-scoped clear only removes the marker if no NEWER writer
   *  has re-set it. Optional for backward compat with persisted markers. */
  nonce?: number
}

export const PENDING_SAVE_MARKER_TTL_MS = 24 * 60 * 60 * 1000

/** DB updatedAt is second-precision (unixepoch); marker ts is ms. */
export const DB_TIMESTAMP_TOLERANCE_MS = 1000

const KEY_PREFIX = 'dreambyte:pendingSave:'

function markerKey(projectId: string, branchId: string | null): string {
  // Branch-scoped key. 'default' stands in for the null/default branch.
  return `${KEY_PREFIX}${projectId}:${branchId ?? 'default'}`
}

function isValidMarkerShape(parsed: unknown): parsed is PendingSaveMarker {
  // Full shape validation : a corrupt or
  // partially-forged payload is treated as absent, never partially trusted.
  const m = parsed as PendingSaveMarker | null
  return (
    !!m &&
    typeof m.ts === 'number' &&
    typeof m.projectId === 'string' &&
    (typeof m.branchId === 'string' || m.branchId === null) &&
    Array.isArray(m.sceneIds) &&
    m.sceneIds.every((id) => typeof id === 'string') &&
    (m.nonce === undefined || typeof m.nonce === 'number')
  )
}

let _nonceCounter = 0

/** Synchronous by design — must hit disk before the risky save starts.
 *  Returns the writer nonce; pass it to clearPendingSaveMarker so an
 *  overlapping later save's marker survives this save's clear. */
export function setPendingSaveMarker(marker: PendingSaveMarker): number {
  const nonce = marker.nonce ?? ++_nonceCounter
  if (typeof window === 'undefined') return nonce
  try {
    window.localStorage.setItem(markerKey(marker.projectId, marker.branchId), JSON.stringify({ ...marker, nonce }))
  } catch (err) {
    // Quota/permission failure — degrade to the pre-marker behavior, loudly.
    log.warn('failed to write pending-save marker', { error: err })
  }
  return nonce
}

/** Clear the marker. With a `nonce`, the clear is writer-scoped: it only
 *  removes the marker when the stored nonce matches — a newer overlapping
 *  writer's marker survives. Without a nonce (boot reconciliation), the
 *  clear is unconditional. */
export function clearPendingSaveMarker(projectId: string, branchId: string | null, nonce?: number): void {
  if (typeof window === 'undefined') return
  try {
    if (nonce !== undefined) {
      const current = readPendingSaveMarker(projectId, branchId)
      if (current && current.nonce !== undefined && current.nonce !== nonce) return // newer writer owns it
    }
    window.localStorage.removeItem(markerKey(projectId, branchId))
  } catch {
    /* removing is best-effort */
  }
}

export function readPendingSaveMarker(projectId: string, branchId: string | null): PendingSaveMarker | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(markerKey(projectId, branchId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return isValidMarkerShape(parsed) ? parsed : null
  } catch {
    return null // corrupt → treat as absent
  }
}

/** All markers for a project, across branches — boot reconciliation input.
 *  Invalid/corrupt entries are removed as they're encountered. */
export function readAllPendingSaveMarkers(projectId: string): PendingSaveMarker[] {
  if (typeof window === 'undefined') return []
  const out: PendingSaveMarker[] = []
  try {
    const prefix = `${KEY_PREFIX}${projectId}:`
    const staleKeys: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(prefix)) continue
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) ?? '') as unknown
        if (isValidMarkerShape(parsed)) out.push(parsed)
        else staleKeys.push(key)
      } catch {
        staleKeys.push(key)
      }
    }
    for (const key of staleKeys) window.localStorage.removeItem(key)
  } catch {
    /* scan is best-effort */
  }
  return out
}

export type MarkerVerdict =
  | 'clear-fresh' // DB row is at/after the marker (within tolerance) — the work landed
  | 'clear-stale' // marker outlived its TTL — expire with a log, no user noise
  | 'notify' // DB row predates the marker — work may be missing, tell the user

/** Pure decision: what to do with a marker found at boot. */
export function reconcilePendingSaveMarker(
  marker: PendingSaveMarker,
  dbUpdatedAtMs: number,
  nowMs: number,
): MarkerVerdict {
  if (nowMs - marker.ts > PENDING_SAVE_MARKER_TTL_MS) return 'clear-stale'
  // DB timestamps are second-precision; compare with tolerance so a save
  // landing in the marker's wall-clock second still reads as fresh.
  if (dbUpdatedAtMs + DB_TIMESTAMP_TOLERANCE_MS >= marker.ts) return 'clear-fresh'
  return 'notify'
}
