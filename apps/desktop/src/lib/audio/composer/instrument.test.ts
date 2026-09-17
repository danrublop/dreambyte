import { describe, it, expect } from 'vitest'
import { compose, INSTRUMENTS } from './arrange'

const CH = { pad: 0, keys: 1, bass: 2, lead: 3, drums: 9 }
const evCount = (p: Parameters<typeof compose>[0]) => {
  const c = compose(p)
  const n: Record<number, number> = {}
  for (const e of c.arrangement.events) n[e.channel] = (n[e.channel] ?? 0) + 1
  return n
}
const programOf = (p: Parameters<typeof compose>[0], chan: number) =>
  compose(p).arrangement.channels.find((c) => c.channel === chan)?.program

const base = { templateId: 'corporate', sceneDurationSec: 16 }

describe('compose() instrument override', () => {
  it('overrides the melodic voices (keys + lead) with the chosen GM program', () => {
    expect(programOf({ ...base, instrument: 'piano' }, CH.keys)).toBe(INSTRUMENTS.piano)
    expect(programOf({ ...base, instrument: 'piano' }, CH.lead)).toBe(INSTRUMENTS.piano)
    expect(programOf({ ...base, instrument: 'strings' }, CH.keys)).toBe(INSTRUMENTS.strings)
  })

  it('leaves the template instruments untouched when none is given', () => {
    // corporate keys = acoustic piano (0) by default; lead = 81. Override absent → unchanged.
    expect(programOf(base, CH.keys)).toBe(0)
    expect(programOf(base, CH.lead)).toBe(81)
  })

  it('keeps the template instrument + reports a correction for an unknown name', () => {
    const c = compose({ ...base, instrument: 'kazoo' })
    expect(c.corrections.some((x) => /unknown instrument "kazoo"/.test(x))).toBe(true)
    expect(c.arrangement.channels.find((ch) => ch.channel === CH.keys)?.program).toBe(0) // template's
  })
})

describe('compose() texture', () => {
  it("'solo' plays ONLY the instrument (keys) — no pad/bass/lead/drums", () => {
    const n = evCount({ ...base, instrument: 'piano', texture: 'solo' })
    expect(n[CH.keys]).toBeGreaterThan(0)
    expect(n[CH.pad] ?? 0).toBe(0)
    expect(n[CH.bass] ?? 0).toBe(0)
    expect(n[CH.lead] ?? 0).toBe(0)
    expect(n[CH.drums] ?? 0).toBe(0)
  })

  it("'minimal' drops drums + lead but keeps the pad/bass bed", () => {
    const n = evCount({ ...base, texture: 'minimal' })
    expect(n[CH.drums] ?? 0).toBe(0)
    expect(n[CH.lead] ?? 0).toBe(0)
    expect(n[CH.keys]).toBeGreaterThan(0)
    expect(n[CH.bass]).toBeGreaterThan(0)
  })

  it("'solo'/'minimal' play keys continuously (more than the core-only 'full' gating)", () => {
    const full = evCount(base)[CH.keys]
    const solo = evCount({ ...base, texture: 'solo' })[CH.keys]
    expect(solo).toBeGreaterThan(full) // continuous bed vs intro/outro-dropped
  })

  it("defaults to 'full' (the template band) when texture is omitted", () => {
    const n = evCount(base)
    expect(n[CH.drums]).toBeGreaterThan(0)
    expect(n[CH.pad]).toBeGreaterThan(0)
  })
})
