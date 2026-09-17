import { describe, it, expect } from 'vitest'
import {
  isExportOrphanHtml,
  isExportLock,
  isStaleTier3TmpDirName,
  selectOrphansToDelete,
  type SweepEntry,
} from './orphan-sweep'

describe('name matchers', () => {
  it('matches __export-*.html', () => {
    expect(isExportOrphanHtml('__export-abc123-9f8e.html')).toBe(true)
    expect(isExportOrphanHtml('scene-abc.html')).toBe(false)
    expect(isExportOrphanHtml('__export-abc.html.lock')).toBe(false)
  })
  it('matches the sidecar lock', () => {
    expect(isExportLock('__export-abc-9f8e.html.lock')).toBe(true)
    expect(isExportLock('__export-abc-9f8e.html')).toBe(false)
  })
  it('matches dreambyte-tier3-* tmp dirs', () => {
    expect(isStaleTier3TmpDirName('dreambyte-tier3-AbC123')).toBe(true)
    expect(isStaleTier3TmpDirName('dreambyte-audio-123')).toBe(false)
  })
})

describe('selectOrphansToDelete', () => {
  const now = 1_000_000_000_000
  const maxAge = 6 * 60 * 60 * 1000 // 6h

  it('keeps files owned by a live process, even if old', () => {
    const entries: SweepEntry[] = [{ name: 'a.html', mtimeMs: 0, ownerAlive: true }]
    expect(selectOrphansToDelete(entries, now, maxAge)).toEqual([])
  })

  it('deletes files whose owning process is dead (crash orphan), regardless of age', () => {
    const entries: SweepEntry[] = [{ name: 'a.html', mtimeMs: now - 1000, ownerAlive: false }]
    expect(selectOrphansToDelete(entries, now, maxAge)).toEqual(['a.html'])
  })

  it('lock-less entries: deletes only past the age backstop', () => {
    const entries: SweepEntry[] = [
      { name: 'young.html', mtimeMs: now - 60 * 1000 }, // 1 min — keep
      { name: 'old.html', mtimeMs: now - 7 * 60 * 60 * 1000 }, // 7h — delete
    ]
    expect(selectOrphansToDelete(entries, now, maxAge)).toEqual(['old.html'])
  })

  it('does not delete a lock-less young file (concurrent export with no resolvable lock yet)', () => {
    const entries: SweepEntry[] = [{ name: 'inflight.html', mtimeMs: now - 30 * 60 * 1000 }] // 30 min
    expect(selectOrphansToDelete(entries, now, maxAge)).toEqual([])
  })
})
