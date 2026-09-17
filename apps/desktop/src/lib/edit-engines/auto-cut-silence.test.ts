// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { afterEach, describe, it, expect } from 'vitest'

import { autoCutSilenceForClip } from './auto-cut-silence'
import { setPcmDecoder, getPcmDecoder } from './pcm-decoder'
import type { Clip } from '@/lib/types'

const SR = 48000

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    sourceType: 'video',
    sourceId: 'video://fixture.mp4',
    label: '',
    startTime: 0,
    duration: 3,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...overrides,
  }
}

function tonePcm(seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const w = (2 * Math.PI * 1000) / SR
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * i)
  return out
}

function silenceSamples(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR))
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

afterEach(() => {
  setPcmDecoder(null)
})

describe('autoCutSilenceForClip', () => {
  it('throws a useful error when no decoder is configured', async () => {
    await expect(autoCutSilenceForClip({ clip: clip(), sourceUri: 'foo' })).rejects.toThrow(
      /PCM decoder not configured/,
    )
  })

  it('returns a plan with actions for a clip with one mid-clip silence', async () => {
    const pcm = concat(tonePcm(1.0), silenceSamples(1.0), tonePcm(1.0))
    setPcmDecoder({
      async decode() {
        return { samples: pcm, sampleRate: SR }
      },
    })
    const result = await autoCutSilenceForClip({
      clip: clip({ duration: 3 }),
      sourceUri: 'video://fixture.mp4',
      minSilenceMs: 200,
    })
    expect(result.spans.length).toBe(1)
    expect(result.plan.actions.length).toBeGreaterThan(0)
    expect(result.info.sampleRate).toBe(SR)
    expect(result.info.durationSec).toBeCloseTo(3)
    expect(result.plan.savedSeconds).toBeCloseTo(1, 1)
  })

  it('returns no actions when the clip has no silences', async () => {
    const pcm = tonePcm(2.0)
    setPcmDecoder({
      async decode() {
        return { samples: pcm, sampleRate: SR }
      },
    })
    const result = await autoCutSilenceForClip({
      clip: clip({ duration: 2 }),
      sourceUri: 'video://fixture.mp4',
    })
    expect(result.spans).toEqual([])
    expect(result.plan.actions).toEqual([])
  })

  it('honours threshold + minSilenceMs overrides', async () => {
    // Very-quiet sine (~-46 dB) only counts as silent at a stricter threshold.
    const pcm = tonePcm(2.0, 0.005)
    setPcmDecoder({
      async decode() {
        return { samples: pcm, sampleRate: SR }
      },
    })
    const strict = await autoCutSilenceForClip({
      clip: clip({ duration: 2 }),
      sourceUri: 'video://fixture.mp4',
      threshold: -40,
      minSilenceMs: 200,
    })
    expect(strict.spans.length).toBeGreaterThan(0)
    const loose = await autoCutSilenceForClip({
      clip: clip({ duration: 2 }),
      sourceUri: 'video://fixture.mp4',
      threshold: -50,
    })
    expect(loose.spans).toEqual([])
  })

  it('decoder reset returns a thrown error', async () => {
    setPcmDecoder({
      async decode() {
        return { samples: tonePcm(0.1), sampleRate: SR }
      },
    })
    expect(getPcmDecoder()).toBeDefined()
    setPcmDecoder(null)
    await expect(autoCutSilenceForClip({ clip: clip(), sourceUri: 'foo' })).rejects.toThrow(
      /PCM decoder not configured/,
    )
  })
})
