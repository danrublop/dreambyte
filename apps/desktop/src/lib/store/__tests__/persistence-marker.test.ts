// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest'
import {
  setPendingSaveMarker,
  clearPendingSaveMarker,
  readPendingSaveMarker,
  readAllPendingSaveMarkers,
  reconcilePendingSaveMarker,
  PENDING_SAVE_MARKER_TTL_MS,
  DB_TIMESTAMP_TOLERANCE_MS,
  type PendingSaveMarker,
} from '../persistence-marker'

/**
 * Durable pending-save marker (IT3/D8/C5; hardened per /review F1/F6).
 *
 * The marker must survive the crash it exists to detect — synchronous
 * localStorage, "reboot" simulated by fresh reads. Branch-keyed (F6): writers
 * on different branches must never clobber or clear each other's crash
 * evidence. Tolerance (F1): DB updatedAt is second-precision, marker ts is
 * ms — same-second saves must read as fresh.
 */

function makeMarker(overrides: Partial<PendingSaveMarker> = {}): PendingSaveMarker {
  return {
    projectId: 'proj-1',
    branchId: null,
    sceneIds: ['scene-a', 'scene-b'],
    ts: 1_000_000,
    ...overrides,
  }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('marker persistence (set / read / clear, branch-keyed)', () => {
  it('round-trips through localStorage (simulated reboot read)', () => {
    setPendingSaveMarker(makeMarker())
    const back = readPendingSaveMarker('proj-1', null)
    expect(back).not.toBeNull()
    expect(back!.sceneIds).toEqual(['scene-a', 'scene-b'])
    expect(back!.ts).toBe(1_000_000)
  })

  it('is scoped per project AND per branch (F6)', () => {
    setPendingSaveMarker(makeMarker({ branchId: 'branch-A' }))
    expect(readPendingSaveMarker('proj-2', 'branch-A')).toBeNull()
    expect(readPendingSaveMarker('proj-1', null)).toBeNull() // different branch key
    expect(readPendingSaveMarker('proj-1', 'branch-A')).not.toBeNull()
  })

  it('F6: a save on branch B cannot clobber or clear branch A’s marker', () => {
    setPendingSaveMarker(makeMarker({ branchId: 'branch-A', ts: 111 }))
    // Concurrent writer on branch B sets and clears ITS marker.
    setPendingSaveMarker(makeMarker({ branchId: 'branch-B', ts: 222 }))
    clearPendingSaveMarker('proj-1', 'branch-B')
    // Branch A's crash evidence survives.
    const a = readPendingSaveMarker('proj-1', 'branch-A')
    expect(a).not.toBeNull()
    expect(a!.ts).toBe(111)
  })

  it('clear removes only its own branch key; absent reads as null', () => {
    setPendingSaveMarker(makeMarker())
    clearPendingSaveMarker('proj-1', null)
    expect(readPendingSaveMarker('proj-1', null)).toBeNull()
  })

  it('corrupt JSON reads as null instead of throwing', () => {
    window.localStorage.setItem('dreambyte:pendingSave:proj-1:default', '{not json')
    expect(readPendingSaveMarker('proj-1', null)).toBeNull()
  })

  it('shape-invalid payloads read as null (missing ts, bad sceneIds, bad branchId)', () => {
    const key = 'dreambyte:pendingSave:proj-1:default'
    window.localStorage.setItem(key, JSON.stringify({ projectId: 'proj-1' }))
    expect(readPendingSaveMarker('proj-1', null)).toBeNull()
    window.localStorage.setItem(key, JSON.stringify({ projectId: 'proj-1', ts: 1, branchId: null, sceneIds: 'nope' }))
    expect(readPendingSaveMarker('proj-1', null)).toBeNull()
    window.localStorage.setItem(key, JSON.stringify({ projectId: 'proj-1', ts: 1, branchId: 7, sceneIds: [] }))
    expect(readPendingSaveMarker('proj-1', null)).toBeNull()
    window.localStorage.setItem(key, JSON.stringify({ projectId: 'proj-1', ts: 1, branchId: null, sceneIds: [42] }))
    expect(readPendingSaveMarker('proj-1', null)).toBeNull()
  })
})

describe('readAllPendingSaveMarkers — boot scan (F6)', () => {
  it('returns every branch’s marker for the project, no other projects', () => {
    setPendingSaveMarker(makeMarker({ branchId: null, ts: 1 }))
    setPendingSaveMarker(makeMarker({ branchId: 'branch-A', ts: 2 }))
    setPendingSaveMarker(makeMarker({ projectId: 'proj-2', branchId: null, ts: 3 }))
    const markers = readAllPendingSaveMarkers('proj-1')
    expect(markers.map((m) => m.ts).sort()).toEqual([1, 2])
  })

  it('removes corrupt entries during the scan', () => {
    window.localStorage.setItem('dreambyte:pendingSave:proj-1:bad', '{corrupt')
    setPendingSaveMarker(makeMarker({ branchId: 'good' }))
    const markers = readAllPendingSaveMarkers('proj-1')
    expect(markers).toHaveLength(1)
    expect(window.localStorage.getItem('dreambyte:pendingSave:proj-1:bad')).toBeNull()
  })

  it('returns [] when nothing is pending', () => {
    expect(readAllPendingSaveMarkers('proj-1')).toEqual([])
  })
})

describe('reconcilePendingSaveMarker — boot verdicts', () => {
  const marker = makeMarker({ ts: 1_000_000 })

  it('clear-fresh when the DB row is at the marker time (save landed exactly)', () => {
    expect(reconcilePendingSaveMarker(marker, 1_000_000, 1_000_500)).toBe('clear-fresh')
  })

  it('clear-fresh when the DB row is newer (agent persist after run start)', () => {
    expect(reconcilePendingSaveMarker(marker, 1_500_000, 1_600_000)).toBe('clear-fresh')
  })

  it('F1: clear-fresh within the second-precision tolerance window', () => {
    // DB floored to the second can read up to 999ms BEFORE the ms marker even
    // though the save landed after it — must not produce a false notify.
    expect(reconcilePendingSaveMarker(marker, marker.ts - 999, marker.ts + 500)).toBe('clear-fresh')
    expect(reconcilePendingSaveMarker(marker, marker.ts - DB_TIMESTAMP_TOLERANCE_MS, marker.ts + 500)).toBe(
      'clear-fresh',
    )
  })

  it('notify when the DB row predates the marker beyond tolerance (the audit crash scenario)', () => {
    expect(reconcilePendingSaveMarker(marker, marker.ts - DB_TIMESTAMP_TOLERANCE_MS - 1, marker.ts + 500)).toBe(
      'notify',
    )
  })

  it('notify when the DB row timestamp is unavailable (0)', () => {
    expect(reconcilePendingSaveMarker(marker, 0, 1_000_500)).toBe('notify')
  })

  it('clear-stale when the marker outlived its TTL, even with a stale DB row', () => {
    const now = marker.ts + PENDING_SAVE_MARKER_TTL_MS + 1
    expect(reconcilePendingSaveMarker(marker, 0, now)).toBe('clear-stale')
  })

  it('still notifies right up to the TTL boundary', () => {
    const now = marker.ts + PENDING_SAVE_MARKER_TTL_MS
    expect(reconcilePendingSaveMarker(marker, 0, now)).toBe('notify')
  })
})

// ── Writer-scoped clears (#124 post-merge review) ─────────────────────────────
//
// Two overlapping saves on the SAME (project, branch) were last-writer-wins:
// the first save's clear removed the marker the second save still relied on,
// so a crash during the second left no marker at boot.

describe('nonce-scoped clear', () => {
  it("an earlier writer's clear does NOT remove a newer writer's marker", () => {
    const nonce1 = setPendingSaveMarker({ projectId: 'p1', branchId: 'b1', sceneIds: ['s1'], ts: 1000 })
    // Second save overlaps and re-sets the marker.
    setPendingSaveMarker({ projectId: 'p1', branchId: 'b1', sceneIds: ['s2'], ts: 2000 })

    // First save completes and clears with ITS nonce — must be a no-op.
    clearPendingSaveMarker('p1', 'b1', nonce1)
    const survivor = readPendingSaveMarker('p1', 'b1')
    expect(survivor).not.toBeNull()
    expect(survivor!.ts).toBe(2000)
  })

  it('the owning writer clears its own marker', () => {
    const nonce = setPendingSaveMarker({ projectId: 'p1', branchId: 'b1', sceneIds: ['s1'], ts: 1000 })
    clearPendingSaveMarker('p1', 'b1', nonce)
    expect(readPendingSaveMarker('p1', 'b1')).toBeNull()
  })

  it('a nonce-less clear stays unconditional (boot reconciliation)', () => {
    setPendingSaveMarker({ projectId: 'p1', branchId: 'b1', sceneIds: ['s1'], ts: 1000 })
    clearPendingSaveMarker('p1', 'b1')
    expect(readPendingSaveMarker('p1', 'b1')).toBeNull()
  })

  it('legacy persisted markers without a nonce can be cleared by any writer (back-compat)', () => {
    window.localStorage.setItem(
      'dreambyte:pendingSave:p1:b1',
      JSON.stringify({ projectId: 'p1', branchId: 'b1', sceneIds: ['s1'], ts: 1000 }),
    )
    clearPendingSaveMarker('p1', 'b1', 999) // any nonce clears a nonce-less marker
    expect(readPendingSaveMarker('p1', 'b1')).toBeNull()
  })
})
