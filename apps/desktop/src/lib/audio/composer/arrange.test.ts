// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { compose, MAX_BARS } from './arrange'
import { TEMPLATE_IDS } from './templates'
import { renderArrangement, DRUM_CHANNEL } from './render'

describe('compose (arrange layer)', () => {
  it('produces note events for every template', () => {
    for (const id of TEMPLATE_IDS) {
      const r = compose({ templateId: id, sceneDurationSec: 12 })
      expect(r.arrangement.events.length).toBeGreaterThan(0)
      expect(r.corrections).toEqual([]) // valid input → no corrections
    }
  })

  it('keeps every note in MIDI range 0-127', () => {
    for (const id of TEMPLATE_IDS) {
      const { events } = compose({ templateId: id, sceneDurationSec: 20, intensity: 1 }).arrangement
      for (const e of events) (expect(e.note).toBeGreaterThanOrEqual(0), expect(e.note).toBeLessThanOrEqual(127))
    }
  })

  it('falls back on an unknown template and reports it', () => {
    const r = compose({ templateId: 'nope', sceneDurationSec: 10 })
    expect(r.meta.templateId).toBe('lofi')
    expect(r.corrections.join(' ')).toMatch(/unknown template/)
  })

  it('clamps an absurd tempo and reports the clamp', () => {
    const r = compose({ templateId: 'lofi', tempo: 400, sceneDurationSec: 10 })
    expect(r.meta.tempo).toBeLessThanOrEqual(95)
    expect(r.corrections.join(' ')).toMatch(/tempo .*clamped/)
  })

  it('clamps out-of-range intensity', () => {
    const r = compose({ templateId: 'lofi', intensity: 5, sceneDurationSec: 10 })
    expect(r.corrections.join(' ')).toMatch(/intensity/)
  })

  it('parses minor/major and sharp keys', () => {
    expect(compose({ templateId: 'upbeat', key: 'G minor', sceneDurationSec: 8 }).meta.key).toBe('G minor')
    expect(compose({ templateId: 'upbeat', key: 'F#', sceneDurationSec: 8 }).meta.key).toBe('F# major')
  })

  it('is length-aware: short scene = core only, long scene = intro+core+outro', () => {
    const short = compose({ templateId: 'lofi', sceneDurationSec: 4 })
    expect(short.meta.sections).toEqual(['core'])
    const long = compose({ templateId: 'lofi', tempo: 82, sceneDurationSec: 40 })
    expect(long.meta.sections).toContain('intro')
    expect(long.meta.sections).toContain('outro')
  })

  it('caps very long scenes at MAX_BARS', () => {
    const r = compose({ templateId: 'upbeat', tempo: 120, sceneDurationSec: 100000 })
    expect(r.meta.bars).toBeLessThanOrEqual(MAX_BARS)
    expect(r.corrections.join(' ')).toMatch(/capped/)
  })

  it('routes drum events to the GM drum channel', () => {
    const { events } = compose({ templateId: 'upbeat', sceneDurationSec: 16 }).arrangement
    const drumEvents = events.filter((e) => e.channel === DRUM_CHANNEL)
    expect(drumEvents.length).toBeGreaterThan(0)
  })

  it('is deterministic for identical params', () => {
    const a = compose({ templateId: 'corporate', key: 'D major', tempo: 110, intensity: 0.7, sceneDurationSec: 18 })
    const b = compose({ templateId: 'corporate', key: 'D major', tempo: 110, intensity: 0.7, sceneDurationSec: 18 })
    expect(a.arrangement.events).toEqual(b.arrangement.events)
  })

  // ── M1b arrangement dynamics ───────────────────────────────────────────────
  it('drops a phrase-seam fill + crash on a long arrangement', () => {
    const r = compose({ templateId: 'corporate', sceneDurationSec: 40 })
    const crash = r.arrangement.events.some((e) => e.channel === DRUM_CHANNEL && e.note === 49)
    expect(crash).toBe(true) // CRASH on the next downbeat after a phrase seam
  })

  it('brings the lead in AFTER the first phrase (entrance, not from bar 0)', () => {
    const r = compose({ templateId: 'corporate', sceneDurationSec: 40, intensity: 0.7 })
    const secPerBar = r.plan.secPerBeat * 4
    const lead = r.arrangement.events.filter((e) => e.channel === 3).sort((a, b) => a.startSec - b.startSec)
    const bass = r.arrangement.events.filter((e) => e.channel === 2).sort((a, b) => a.startSec - b.startSec)
    expect(lead.length).toBeGreaterThan(0)
    expect(bass.length).toBeGreaterThan(0)
    // Lead arrives well after the bass (which plays from the core's first bar).
    expect(lead[0].startSec).toBeGreaterThan(bass[0].startSec + 2 * secPerBar)
  })

  it('breathes: core velocity is not flat (a real dynamic arc, not one constant)', () => {
    const r = compose({ templateId: 'corporate', sceneDurationSec: 40 })
    const padVels = r.arrangement.events.filter((e) => e.channel === 0).map((e) => e.velocity)
    expect(padVels.length).toBeGreaterThan(8)
    const spread = Math.max(...padVels) - Math.min(...padVels)
    expect(spread).toBeGreaterThan(6) // beyond humanization jitter alone (±9 on a flat line would rarely exceed)
  })
})

// Render integration — needs the soundfont; skip cleanly when absent.
const SF = process.env.DREAMBYTE_SOUNDFONT_PATH || join(process.cwd(), 'public', 'soundfonts', 'GeneralUser-GS.sf2')
;(existsSync(SF) ? describe : describe.skip)('compose → render integration', () => {
  it('renders a composed lofi arrangement to non-silent audio', async () => {
    const { arrangement } = compose({ templateId: 'lofi', sceneDurationSec: 8, intensity: 0.7 })
    const r = await renderArrangement(arrangement, SF)
    expect(20 * Math.log10(r.rms || 1e-9)).toBeGreaterThan(-40)
  })
})
