import { describe, it, expect } from 'vitest'
import { getPendingChangelog, CHANGELOG } from './changelog'

describe('getPendingChangelog', () => {
  const known = CHANGELOG[0].version

  it('returns null on a fresh install (no last-seen version)', () => {
    expect(getPendingChangelog(known, null)).toBeNull()
    expect(getPendingChangelog(known, '')).toBeNull()
    expect(getPendingChangelog(known, '   ')).toBeNull()
  })

  it('returns null when already on the last-seen version', () => {
    expect(getPendingChangelog(known, known)).toBeNull()
  })

  it('returns the matching entry on a genuine upgrade', () => {
    const entry = getPendingChangelog(known, '0.7.0.0')
    expect(entry).not.toBeNull()
    expect(entry?.version).toBe(known)
  })

  it('returns null on upgrade to a version with no changelog entry', () => {
    expect(getPendingChangelog('99.0.0.0', '0.7.0.0')).toBeNull()
  })

  it('returns null when current version is missing', () => {
    expect(getPendingChangelog(null, '0.7.0.0')).toBeNull()
    expect(getPendingChangelog('', '0.7.0.0')).toBeNull()
  })

  it('every changelog entry has a version and at least one section', () => {
    for (const e of CHANGELOG) {
      expect(e.version).toBeTruthy()
      expect(e.sections.length).toBeGreaterThan(0)
      for (const s of e.sections) {
        expect(s.heading).toBeTruthy()
        expect(s.items.length).toBeGreaterThan(0)
      }
    }
  })
})
