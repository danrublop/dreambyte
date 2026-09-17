// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  renderArrangement,
  renderArrangementToFile,
  encodeWav,
  clearSoundBankCache,
  DRUM_CHANNEL,
  SAMPLE_RATE,
  type Arrangement,
} from './render'

// The 40MB soundfont is fetched at build time (scripts/assets/fetch-soundfont.mjs), not committed.
// Skip cleanly when it's absent (e.g. a fresh CI checkout before fetch) so the suite never
// fails for a missing asset; run for real locally + in CI-with-fetch.
const SF = process.env.DREAMBYTE_SOUNDFONT_PATH || join(process.cwd(), 'public', 'soundfonts', 'GeneralUser-GS.sf2')
const hasSF = existsSync(SF)
const d = hasSF ? describe : describe.skip
if (!hasSF) {
  console.warn(`[render.test] soundfont missing at ${SF} — skipping (run: node scripts/assets/fetch-soundfont.mjs)`)
}

// A C-minor triad arrangement on piano (program 0), ~2s.
const chord = (): Arrangement => ({
  durationSec: 2,
  channels: [{ channel: 0, program: 0 }],
  events: [60, 63, 67].map((note) => ({ channel: 0, note, velocity: 100, startSec: 0, durSec: 2 })),
})

function readWavHeader(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
  return {
    riff: tag(0),
    wave: tag(8),
    channels: dv.getUint16(22, true),
    sampleRate: dv.getUint32(24, true),
    bits: dv.getUint16(34, true),
  }
}

d('native composer render', () => {
  beforeAll(() => clearSoundBankCache())

  it('renders a chord to non-silent stereo audio', async () => {
    const r = await renderArrangement(chord(), SF)
    expect(r.left.length).toBe(r.right.length)
    expect(r.frames).toBeGreaterThan(2 * SAMPLE_RATE) // musical region + tail
    // Audible: RMS over the musical region well above the noise floor (-50dB).
    expect(20 * Math.log10(r.rms)).toBeGreaterThan(-50)
  })

  it('encodes a valid 16-bit stereo 44.1kHz WAV', async () => {
    const r = await renderArrangement(chord(), SF)
    const h = readWavHeader(encodeWav(r))
    expect(h.riff).toBe('RIFF')
    expect(h.wave).toBe('WAVE')
    expect(h.channels).toBe(2)
    expect(h.sampleRate).toBe(SAMPLE_RATE)
    expect(h.bits).toBe(16)
  })

  it('is deterministic — identical arrangement renders byte-identical WAV', async () => {
    const a = encodeWav(await renderArrangement(chord(), SF))
    const b = encodeWav(await renderArrangement(chord(), SF))
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
  })

  it('renders silence for an empty arrangement (no crash, ~floor RMS)', async () => {
    const r = await renderArrangement({ durationSec: 1, channels: [], events: [] }, SF)
    expect(r.frames).toBeGreaterThan(0)
    expect(r.rms).toBeLessThan(1e-4)
  })

  it('renders a drum hit on the GM drum channel', async () => {
    const arr: Arrangement = {
      durationSec: 1,
      channels: [{ channel: DRUM_CHANNEL, program: 0 }],
      events: [{ channel: DRUM_CHANNEL, note: 36, velocity: 120, startSec: 0, durSec: 0.2 }], // kick
    }
    const r = await renderArrangement(arr, SF)
    expect(20 * Math.log10(r.rms || 1e-9)).toBeGreaterThan(-60)
  })

  it('writes a WAV file to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'composer-'))
    const out = join(dir, 'chord.wav')
    const meta = await renderArrangementToFile(chord(), SF, out)
    expect(meta.bytes).toBeGreaterThan(44) // header + data
    const onDisk = await readFile(out)
    expect(readWavHeader(onDisk).riff).toBe('RIFF')
  })
})
