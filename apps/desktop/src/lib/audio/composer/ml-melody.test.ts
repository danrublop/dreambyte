// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { generateMlMelody, resolveMagentaCheckpoint } from './ml-melody'

// Needs the cached Magenta checkpoint (node scripts/assets/fetch-magenta.mjs). Skip cleanly
// when absent so the suite never fails for a missing model.
const ck = resolveMagentaCheckpoint()
const d = ck ? describe : describe.skip
if (!ck) {
  // eslint-disable-next-line no-console
  console.warn('[ml-melody.test] Magenta checkpoint missing — skipping (run: node scripts/assets/fetch-magenta.mjs)')
}

d('generateMlMelody', () => {
  it('generates a chord-conditioned lead on the lead channel, in range, within time', async () => {
    const events = await generateMlMelody({
      chordsInC: ['Cm7', 'Fm7', 'Abmaj7', 'Bb7'],
      offset: 7, // → G
      secPerBeat: 60 / 82,
      startSec: 0,
      leadChannel: 3,
      intensity: 0.7,
    })
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(e.channel).toBe(3)
      expect(e.note).toBeGreaterThanOrEqual(0)
      expect(e.note).toBeLessThanOrEqual(127)
      expect(e.startSec).toBeGreaterThanOrEqual(0)
      expect(e.durSec).toBeGreaterThan(0)
    }
  }, 40_000)

  it('returns [] (graceful fallback) for an empty chord list — never throws', async () => {
    const events = await generateMlMelody({
      chordsInC: [],
      offset: 0,
      secPerBeat: 0.5,
      startSec: 0,
      leadChannel: 3,
      intensity: 0.6,
    })
    expect(events).toEqual([])
  })
})
