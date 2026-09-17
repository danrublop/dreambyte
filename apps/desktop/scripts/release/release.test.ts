// @vitest-environment node
//
// Unit tests for the pure, side-effect-free helpers in scripts/release/release.mjs —
// the two pieces of release orchestration that gate whether a build is even
// allowed to ship, isolated from git/gh/network so they're cheap to verify:
//   - buildFromTag:  parse the monotonic build number (4th version segment)
//                    out of a vA.B.C.D tag (→ CFBundleVersion → updater order).
//   - isBuildAllowed: refuse a build that is not STRICTLY greater than the last
//                     published one; allow the first release (maxPublished null).
//
// The module is imported (not spawned): it only runs main()/arg-parsing when it
// is the process entry point, so importing here pulls just the helpers.

import { describe, it, expect } from 'vitest'
import { buildFromTag, isBuildAllowed } from './release.mjs'

describe('buildFromTag', () => {
  it('parses the 4th segment from a valid 4-segment tag (with leading v)', () => {
    expect(buildFromTag('v0.7.17.0')).toBe(0)
    expect(buildFromTag('v0.7.17.3')).toBe(3)
    expect(buildFromTag('v1.2.3.42')).toBe(42)
  })

  it('parses a 4-segment tag without the leading v', () => {
    expect(buildFromTag('0.7.17.5')).toBe(5)
  })

  it('returns null for a non-conforming tag (snapshot suffix)', () => {
    expect(buildFromTag('v0.2.4.0-audit-snapshot-2026-05-20')).toBeNull()
  })

  it('returns null for a 3-segment tag (no build segment)', () => {
    expect(buildFromTag('v0.7.17')).toBeNull()
    expect(buildFromTag('0.7.17')).toBeNull()
  })

  it('returns null for junk / non-version input', () => {
    expect(buildFromTag('latest')).toBeNull()
    expect(buildFromTag('')).toBeNull()
    expect(buildFromTag('v1.2.3.4.5')).toBeNull()
  })
})

describe('isBuildAllowed (monotonic build-number guard)', () => {
  it('allows the first release when nothing is published (maxPublished null)', () => {
    expect(isBuildAllowed(0, null).ok).toBe(true)
    expect(isBuildAllowed(7, null).ok).toBe(true)
  })

  it('treats undefined maxPublished the same as null (first release)', () => {
    expect(isBuildAllowed(0, undefined).ok).toBe(true)
  })

  it('refuses a build equal to the last published (no off-by-one)', () => {
    const r = isBuildAllowed(5, 5)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not greater/)
  })

  it('refuses a build below the last published', () => {
    expect(isBuildAllowed(4, 5).ok).toBe(false)
    expect(isBuildAllowed(0, 12).ok).toBe(false)
  })

  it('allows a build strictly greater than the last published', () => {
    expect(isBuildAllowed(6, 5).ok).toBe(true)
    expect(isBuildAllowed(13, 12).ok).toBe(true)
  })

  it('is strictly-greater at the boundary (n vs n-1 / n / n+1)', () => {
    expect(isBuildAllowed(10, 11).ok).toBe(false) // below
    expect(isBuildAllowed(11, 11).ok).toBe(false) // equal — must refuse
    expect(isBuildAllowed(12, 11).ok).toBe(true) // above — must allow
  })

  it('refuses a non-finite build number even on a first release (NaN must not slip the guard)', () => {
    expect(isBuildAllowed(NaN, 5).ok).toBe(false)
    expect(isBuildAllowed(NaN, null).ok).toBe(false) // would otherwise pass as "first release"
    expect(isBuildAllowed(Infinity, 5).ok).toBe(false)
  })
})
