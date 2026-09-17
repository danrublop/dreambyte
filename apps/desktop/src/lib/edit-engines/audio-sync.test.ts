// @vitest-environment node

import { describe, it, expect, afterEach } from 'vitest'

import { setPcmDecoder, type DecodedPcm } from './pcm-decoder'
import { computeAudioSyncOffset, buildEnvelope } from './audio-sync'
import type { Clip } from '@/lib/types'

const SR = 48000

/** Minimal Clip with the fields sync touches; rest defaulted. */
function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c',
    trackId: 't',
    sourceType: 'audio',
    sourceId: 'src',
    label: 'clip',
    startTime: 0,
    duration: 10,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    transition: null,
    ...over,
  } as Clip
}

/**
 * PCM with a few transient bursts; `delaySec` shifts them right. `seed` drives
 * both the noise floor AND the burst placement, so two different seeds produce
 * genuinely uncorrelated content (different burst times), while the same seed +
 * a delay produces the same content shifted (the sync case).
 */
function pcmWithBursts(durationSec: number, delaySec: number, seed = 1): DecodedPcm {
  const n = Math.round(durationSec * SR)
  const samples = new Float32Array(n)
  let s = seed
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = 0; i < n; i++) samples[i] = 0.001 * (rand() - 0.5)
  const offset = Math.round(delaySec * SR)
  // Burst times derived from the seed so different seeds → different content.
  const times = Array.from({ length: 6 }, () => rand() * (durationSec - 0.3))
  for (const t of times) {
    const at = Math.round(t * SR) + offset
    for (let k = 0; k < 0.05 * SR && at + k < n; k++) {
      if (at + k >= 0) samples[at + k] += 0.6 * Math.sin((2 * Math.PI * 440 * k) / SR)
    }
  }
  return { samples, sampleRate: SR }
}

afterEach(() => setPcmDecoder(null))

describe('buildEnvelope', () => {
  it('downsamples to ~100 Hz RMS', () => {
    const pcm: DecodedPcm = { samples: new Float32Array(SR), sampleRate: SR } // 1 s
    const env = buildEnvelope(pcm, 0.01)
    expect(env.length).toBe(100)
  })
})

describe('computeAudioSyncOffset', () => {
  it('recovers a known offset between reference and target', async () => {
    // Reference content with no extra delay; target = same content shifted +0.5 s
    // in its source AND placed at startTime 0. The reference sits at startTime 2.
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        if (source === 'ref') return pcmWithBursts(10, 0, 42)
        return pcmWithBursts(10, 0.5, 42) // identical bursts, shifted right 0.5 s
      },
    })
    const ref = clip({ id: 'ref', sourceId: 'ref', startTime: 2 })
    const tgt = clip({ id: 'tgt', sourceId: 'tgt', startTime: 0 })

    const r = await computeAudioSyncOffset(ref, tgt, { searchWindowSeconds: 5 })
    expect(r.matched).toBe(true)
    expect(r.confidence).toBeGreaterThan(0.8)
    // Target audio occurs 0.5 s LATER in its source than the reference, so to
    // line the bursts up the target must start 0.5 s EARLIER than the reference:
    // newStart = refStart(2) + lag(-0.5) = 1.5.
    expect(r.newStartTime).toBeCloseTo(1.5, 1)
  })

  it('refuses uncorrelated clips (no overlap) below confidence', async () => {
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        return source === 'ref' ? pcmWithBursts(10, 0, 1) : pcmWithBursts(10, 0, 99999)
      },
    })
    const ref = clip({ id: 'ref', sourceId: 'ref' })
    const tgt = clip({ id: 'tgt', sourceId: 'tgt' })
    const r = await computeAudioSyncOffset(ref, tgt, { searchWindowSeconds: 5, minConfidence: 0.5 })
    expect(r.matched).toBe(false)
    expect(r.reason).toMatch(/no confident alignment|may not overlap/i)
  })

  it('refuses a silent target', async () => {
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        return source === 'ref'
          ? pcmWithBursts(10, 0, 1)
          : { samples: new Float32Array(5 * SR), sampleRate: SR } // pure silence
      },
    })
    const r = await computeAudioSyncOffset(
      clip({ id: 'ref', sourceId: 'ref' }),
      clip({ id: 'tgt', sourceId: 'tgt' }),
      { searchWindowSeconds: 5 },
    )
    expect(r.matched).toBe(false)
    expect(r.reason).toMatch(/no audible audio/i)
  })

  it('refuses when the reference cannot be decoded', async () => {
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        if (source === 'ref') throw new Error('no audio track')
        return pcmWithBursts(10, 0, 1)
      },
    })
    const r = await computeAudioSyncOffset(
      clip({ id: 'ref', sourceId: 'ref' }),
      clip({ id: 'tgt', sourceId: 'tgt' }),
      {},
    )
    expect(r.matched).toBe(false)
    expect(r.reason).toMatch(/reference clip has no readable audio/i)
  })

  it('refuses when the TARGET cannot be decoded (not just the reference)', async () => {
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        if (source === 'tgt') throw new Error('no audio track')
        return pcmWithBursts(10, 0, 1)
      },
    })
    const r = await computeAudioSyncOffset(
      clip({ id: 'ref', sourceId: 'ref' }),
      clip({ id: 'tgt', sourceId: 'tgt' }),
      {},
    )
    expect(r.matched).toBe(false)
    expect(r.reason).toMatch(/target clip has no readable audio/i)
  })

  it('refuses searchWindowSeconds <= 0 before touching the decoder', async () => {
    let decoded = false
    setPcmDecoder({
      async decode(): Promise<DecodedPcm> {
        decoded = true
        return pcmWithBursts(10, 0, 1)
      },
    })
    const r = await computeAudioSyncOffset(
      clip({ id: 'ref', sourceId: 'ref' }),
      clip({ id: 'tgt', sourceId: 'tgt' }),
      { searchWindowSeconds: 0 },
    )
    expect(r.matched).toBe(false)
    expect(r.reason).toMatch(/must be > 0/i)
    expect(decoded).toBe(false) // refused before any decode
  })

  it('refuses an alignment that falls before the timeline start', async () => {
    // Reference at startTime 0; target content occurs 0.5 s LATER → lag -0.5 s →
    // newStart = 0 - 0.5 < 0. Must refuse rather than place a clip at a negative time.
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        return source === 'ref' ? pcmWithBursts(10, 0, 42) : pcmWithBursts(10, 0.5, 42)
      },
    })
    const r = await computeAudioSyncOffset(
      clip({ id: 'ref', sourceId: 'ref', startTime: 0 }),
      clip({ id: 'tgt', sourceId: 'tgt', startTime: 0 }),
      { searchWindowSeconds: 5 },
    )
    expect(r.matched).toBe(false)
    expect(r.reason).toMatch(/before the timeline start/i)
  })

  it('clamps a negative minConfidence so noise is not accepted as a match', async () => {
    // minConfidence: -1 must not disable the confidence gate. Uncorrelated clips
    // still refuse (peakRatio guard + clamped-to-0 confidence floor).
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        return source === 'ref' ? pcmWithBursts(10, 0, 1) : pcmWithBursts(10, 0, 77777)
      },
    })
    const r = await computeAudioSyncOffset(
      clip({ id: 'ref', sourceId: 'ref' }),
      clip({ id: 'tgt', sourceId: 'tgt' }),
      { searchWindowSeconds: 5, minConfidence: -1 },
    )
    expect(r.matched).toBe(false)
  })
})
