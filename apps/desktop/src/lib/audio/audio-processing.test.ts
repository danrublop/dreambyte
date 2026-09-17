import { describe, it, expect } from 'vitest'
import {
  resolveAudioProcessing,
  mergeAudioProcessing,
  resolveProgramNormalizeTarget,
  buildLoudnormMeasureFilter,
  buildLoudnormApplyFilter,
  parseLoudnormJson,
  AUDIO_MIX_DEFAULTS,
} from './audio-processing'

describe('resolveAudioProcessing', () => {
  it('absent input → all defaults (normalize + ducking off)', () => {
    const r = resolveAudioProcessing(undefined)
    expect(r.masterGain).toBe(1)
    expect(r.ttsGain).toBe(1)
    expect(r.musicGain).toBe(1)
    expect(r.sfxGain).toBe(1)
    expect(r.normalize).toEqual({ enabled: false, targetLufs: -14 })
    expect(r.ducking.enabled).toBe(false)
    expect(r.ducking).toMatchObject({ duckLevel: 0.2, attackMs: 100, releaseMs: 500, ratio: 10 })
  })

  it('null behaves like absent', () => {
    expect(resolveAudioProcessing(null)).toEqual(resolveAudioProcessing(undefined))
  })

  it('clamps gains to [0,4] and rejects NaN/non-finite to the default', () => {
    expect(resolveAudioProcessing({ masterGain: 999 }).masterGain).toBe(4)
    expect(resolveAudioProcessing({ masterGain: -5 }).masterGain).toBe(0)
    expect(resolveAudioProcessing({ ttsGain: Number.NaN }).ttsGain).toBe(1)
    expect(resolveAudioProcessing({ sfxGain: Infinity }).sfxGain).toBe(1)
    // non-number (LLM could pass a string) → default
    expect(resolveAudioProcessing({ musicGain: '2' as unknown as number }).musicGain).toBe(1)
  })

  it('clamps normalize target LUFS to [-30,-9] and defaults to -14', () => {
    expect(resolveAudioProcessing({ normalize: { enabled: true } }).normalize.targetLufs).toBe(-14)
    expect(resolveAudioProcessing({ normalize: { enabled: true, targetLufs: -100 } }).normalize.targetLufs).toBe(-30)
    expect(resolveAudioProcessing({ normalize: { enabled: true, targetLufs: 0 } }).normalize.targetLufs).toBe(-9)
    expect(resolveAudioProcessing({ normalize: { enabled: true, targetLufs: -16 } }).normalize.targetLufs).toBe(-16)
  })

  it('normalize/ducking enabled only on strict true', () => {
    expect(resolveAudioProcessing({ normalize: { enabled: 1 as unknown as boolean } }).normalize.enabled).toBe(false)
    expect(resolveAudioProcessing({ ducking: { enabled: 'yes' as unknown as boolean } }).ducking.enabled).toBe(false)
    expect(resolveAudioProcessing({ ducking: { enabled: true } }).ducking.enabled).toBe(true)
  })

  it('clamps ducking params to their ranges', () => {
    const r = resolveAudioProcessing({
      ducking: { enabled: true, duckLevel: 5, attackMs: 0, releaseMs: 99999, ratio: 100 },
    })
    expect(r.ducking.duckLevel).toBe(1)
    expect(r.ducking.attackMs).toBe(5)
    expect(r.ducking.releaseMs).toBe(3000)
    expect(r.ducking.ratio).toBe(20)
  })

  it('clamps duckLevel=0 to a small epsilon, NOT 0 (avoids level_sc=1/0=Infinity in FFmpeg)', () => {
    expect(resolveAudioProcessing({ ducking: { enabled: true, duckLevel: 0 } }).ducking.duckLevel).toBe(0.01)
    expect(resolveAudioProcessing({ ducking: { enabled: true, duckLevel: -1 } }).ducking.duckLevel).toBe(0.01)
  })
})

describe('mergeAudioProcessing (partial-update)', () => {
  it('field-merges nested normalize/ducking without clobbering siblings', () => {
    const base = { masterGain: 2, ducking: { enabled: true, duckLevel: 0.3 } }
    const merged = mergeAudioProcessing(base, { ducking: { duckLevel: 0.1 } })
    expect(merged.masterGain).toBe(2) // untouched
    expect(merged.ducking).toEqual({ enabled: true, duckLevel: 0.1 }) // enabled kept, level updated
  })

  it('absent base + patch → just the patch', () => {
    expect(mergeAudioProcessing(undefined, { ttsGain: 1.5 })).toMatchObject({ ttsGain: 1.5 })
  })

  it('patching normalize keeps prior enabled when omitted', () => {
    const merged = mergeAudioProcessing(
      { normalize: { enabled: true, targetLufs: -16 } },
      { normalize: { enabled: true, targetLufs: -14 } as never },
    )
    expect(merged.normalize).toMatchObject({ enabled: true, targetLufs: -14 })
  })
})

describe('resolveProgramNormalizeTarget', () => {
  const layer = (ap: unknown) => ({ audioProcessing: ap as never })
  it('defaults to the -14 LUFS social target when no scene enabled normalization (default-ON)', () => {
    // Loudnorm is default-on: with no scene override the program still normalizes to -14,
    // so exports ship at a consistent loudness instead of an un-normalized arbitrary sum.
    expect(resolveProgramNormalizeTarget([layer(undefined), layer({ masterGain: 2 })])).toEqual({
      targetLufs: -14,
      conflict: false,
    })
  })
  it('first enabled scene wins; no conflict when targets agree', () => {
    const r = resolveProgramNormalizeTarget([
      layer({ normalize: { enabled: true, targetLufs: -16 } }),
      layer({ normalize: { enabled: true, targetLufs: -16 } }),
    ])
    expect(r).toEqual({ targetLufs: -16, conflict: false })
  })
  it('flags conflict when enabled scenes disagree (first still wins)', () => {
    const r = resolveProgramNormalizeTarget([
      layer({ normalize: { enabled: true, targetLufs: -14 } }),
      layer({ normalize: { enabled: true, targetLufs: -23 } }),
    ])
    expect(r).toEqual({ targetLufs: -14, conflict: true })
  })
  it('ignores null/undefined layers safely', () => {
    expect(resolveProgramNormalizeTarget([null, undefined, layer({ normalize: { enabled: true } })])).toEqual({
      targetLufs: -14,
      conflict: false,
    })
  })
})

describe('loudnorm arg builders', () => {
  it('measure filter uses target + proven TP/LRA + json', () => {
    expect(buildLoudnormMeasureFilter(-14)).toBe(
      `loudnorm=I=-14:TP=${AUDIO_MIX_DEFAULTS.normalizeTruePeak}:LRA=${AUDIO_MIX_DEFAULTS.normalizeLra}:print_format=json`,
    )
  })

  it('measure filter clamps an out-of-range target', () => {
    expect(buildLoudnormMeasureFilter(-100)).toContain('I=-30')
  })

  it('apply filter threads the measured values + linear', () => {
    const m = { input_i: '-19.1', input_tp: '-3.2', input_lra: '5.4', input_thresh: '-29.5', target_offset: '0.3' }
    const f = buildLoudnormApplyFilter(-14, m)
    expect(f).toContain('I=-14')
    expect(f).toContain('measured_I=-19.1')
    expect(f).toContain('measured_TP=-3.2')
    expect(f).toContain('measured_thresh=-29.5')
    expect(f).toContain('offset=0.3')
    expect(f).toContain('linear=true')
  })
})

describe('parseLoudnormJson', () => {
  it('extracts the trailing JSON block from loudnorm stderr', () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x] \n{\n  "input_i" : "-19.10",\n  "input_tp" : "-3.20",\n  "input_lra" : "5.40",\n  "input_thresh" : "-29.50",\n  "target_offset" : "0.30"\n}\n`
    const m = parseLoudnormJson(stderr)
    expect(m).not.toBeNull()
    expect(m?.input_i).toBe('-19.10')
    expect(m?.target_offset).toBe('0.30')
  })

  it('returns null when fields are missing (caller falls back to un-normalized)', () => {
    expect(parseLoudnormJson('no json here')).toBeNull()
    expect(parseLoudnormJson('{ "foo": "bar" }')).toBeNull()
  })
})
