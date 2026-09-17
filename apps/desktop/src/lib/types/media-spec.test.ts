import { describe, it, expect } from 'vitest'
import { normalizeMediaSpec, mediaSpecSummary, type MediaSpec } from './media-spec'

describe('normalizeMediaSpec', () => {
  it('fills absent optionals with null (stable shape, never undefined)', () => {
    const s = normalizeMediaSpec({ modality: 'image', model: 'flux-1.1-pro', prompt: 'a fox' })
    expect(s).toEqual({
      modality: 'image',
      model: 'flux-1.1-pro',
      prompt: 'a fox',
      negativePrompt: null,
      aspectRatio: null,
      duration: null,
      strength: null,
      seed: null,
      camera: null,
      characterId: null,
      referenceAssetIds: null,
      provider: null,
      stylePreset: null,
    })
  })

  it('clamps strength to [0,1] and floors the seed to a non-negative int', () => {
    expect(normalizeMediaSpec({ modality: 'image', model: 'm', prompt: 'p', strength: 1.7 }).strength).toBe(1)
    expect(normalizeMediaSpec({ modality: 'image', model: 'm', prompt: 'p', strength: -0.5 }).strength).toBe(0)
    expect(normalizeMediaSpec({ modality: 'image', model: 'm', prompt: 'p', seed: 42.9 }).seed).toBe(42)
    expect(normalizeMediaSpec({ modality: 'image', model: 'm', prompt: 'p', seed: -5 }).seed).toBe(0)
  })

  it('drops non-positive duration and empty reference arrays', () => {
    expect(normalizeMediaSpec({ modality: 'video', model: 'veo-3', prompt: 'p', duration: 0 }).duration).toBeNull()
    expect(normalizeMediaSpec({ modality: 'video', model: 'veo-3', prompt: 'p', duration: 8 }).duration).toBe(8)
    expect(
      normalizeMediaSpec({ modality: 'image', model: 'm', prompt: 'p', referenceAssetIds: [] }).referenceAssetIds,
    ).toBeNull()
    expect(
      normalizeMediaSpec({ modality: 'image', model: 'm', prompt: 'p', referenceAssetIds: ['a', ''] })
        .referenceAssetIds,
    ).toEqual(['a'])
  })

  it('trims prompt and negativePrompt (empty negative → null)', () => {
    const s = normalizeMediaSpec({ modality: 'image', model: 'm', prompt: '  hi  ', negativePrompt: '   ' })
    expect(s.prompt).toBe('hi')
    expect(s.negativePrompt).toBeNull()
  })

  it('rejects non-finite numerics (NaN / Infinity) → null', () => {
    const s = normalizeMediaSpec({
      modality: 'image',
      model: 'm',
      prompt: 'p',
      strength: NaN,
      seed: Infinity,
      duration: -Infinity,
    })
    expect(s.strength).toBeNull()
    expect(s.seed).toBeNull()
    expect(s.duration).toBeNull()
  })

  it('coerces non-string untyped input without throwing (agent/model output)', () => {
    // MediaSpecInput is fed from untyped agent output — a non-string negativePrompt or junk in
    // referenceAssetIds must not throw .trim() or persist garbage.
    const s = normalizeMediaSpec({
      modality: 'image',
      model: 'm',
      prompt: 'p',
      // @ts-expect-error deliberately wrong runtime type
      negativePrompt: 123,
      // @ts-expect-error deliberately wrong runtime type
      referenceAssetIds: ['ok', 42, null, ''],
    })
    expect(s.negativePrompt).toBeNull()
    expect(s.referenceAssetIds).toEqual(['ok'])
  })
})

describe('mediaSpecSummary', () => {
  const base: MediaSpec = normalizeMediaSpec({ modality: 'image', model: 'flux-1.1-pro', prompt: 'p' })

  it('summarizes model + present fields, "·"-joined', () => {
    const s: MediaSpec = { ...base, aspectRatio: '16:9', seed: 42, referenceAssetIds: ['r'] }
    expect(mediaSpecSummary(s)).toBe('flux-1.1-pro · 16:9 · seed 42 · i2i')
  })

  it('uses the catalog label when a resolver is provided', () => {
    expect(mediaSpecSummary(base, (id) => (id === 'flux-1.1-pro' ? 'Flux 1.1 Pro' : null))).toBe('Flux 1.1 Pro')
  })

  it('notes character + camera when set', () => {
    const s: MediaSpec = { ...base, characterId: 'aria', camera: { moves: [{ type: 'dolly-in' }] } }
    expect(mediaSpecSummary(s)).toContain('character')
    expect(mediaSpecSummary(s)).toContain('camera')
  })
})
