// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { generateMlDrums } from './ml-drums'
import { resolveMagentaCheckpoint } from './ml-worker'
import { DRUM_CHANNEL } from './render'

const PATTERN = { kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }

describe('generateMlDrums — fallbacks (no model needed)', () => {
  it('returns [] when there are no core bars', async () => {
    expect(await generateMlDrums({ ...PATTERN, coreBars: 0, secPerBeat: 0.5, coreStartSec: 0, qpm: 120 })).toEqual([])
  })
  it('returns [] when the grid is empty (nothing to humanize)', async () => {
    const empty = { kick: '................', snare: '................', hat: '................' }
    expect(await generateMlDrums({ ...empty, coreBars: 4, secPerBeat: 0.5, coreStartSec: 0, qpm: 120 })).toEqual([])
  })
})

// Integration — needs the GrooVAE checkpoint; skip cleanly when absent.
const ck = resolveMagentaCheckpoint('groovae_2bar_humanize')
;(ck ? describe : describe.skip)('generateMlDrums — GrooVAE humanize (integration)', () => {
  it('humanizes the grid into drum-channel events with round-trip pitches', async () => {
    // coreBars 12 = 6 segments → a >8KB worker response: exercises the multi-chunk
    // stdout path + the write-then-exit flush (a `write(big);exit()` truncated it
    // at the 8KB pipe buffer and silently fell back to template drums).
    const ev = await generateMlDrums({ ...PATTERN, coreBars: 12, secPerBeat: 0.5, coreStartSec: 0, qpm: 120 })
    expect(ev.length).toBeGreaterThan(0)
    // Every event is on the GM drum channel, pitch ∈ {kick,snare,hat} (round-trip safe).
    expect(ev.every((e) => e.channel === DRUM_CHANNEL)).toBe(true)
    expect(ev.every((e) => [36, 38, 42].includes(e.note))).toBe(true)
    // Velocities are valid + varied (GrooVAE invents dynamics, not one flat value).
    expect(ev.every((e) => e.velocity >= 1 && e.velocity <= 127)).toBe(true)
    expect(new Set(ev.map((e) => e.velocity)).size).toBeGreaterThan(3)
  })

  it('produces humanized micro-timing (events off the exact step grid)', async () => {
    const secPerBeat = 0.5
    const secPerStep = secPerBeat / 4
    const ev = await generateMlDrums({ ...PATTERN, coreBars: 4, secPerBeat, coreStartSec: 0, qpm: 120 })
    expect(ev.length).toBeGreaterThan(0)
    const offGrid = ev.filter((e) => Math.abs((e.startSec / secPerStep) % 1) > 0.02).length
    // The whole point of GrooVAE: most hits sit OFF the dead grid.
    expect(offGrid).toBeGreaterThan(ev.length * 0.5)
  })

  it('clamps all events inside the core time range (no overrun on odd bar counts)', async () => {
    const secPerBeat = 0.5
    const coreBars = 5 // odd → last 2-bar segment has a trailing empty bar
    const coreStartSec = 2
    const ev = await generateMlDrums({ ...PATTERN, coreBars, secPerBeat, coreStartSec, qpm: 120 })
    const coreEnd = coreStartSec + coreBars * secPerBeat * 4
    expect(ev.every((e) => e.startSec >= coreStartSec && e.startSec < coreEnd)).toBe(true)
  })
})
