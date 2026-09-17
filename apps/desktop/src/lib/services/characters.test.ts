import { describe, it, expect } from 'vitest'
import { buildCharacterGenerationParams } from './characters'

// T12 pipeline unit: a reused character's reference + seed + descriptor must flow into the
// generation params. No perceptual oracle (per A4) — we assert the levers are applied, not
// that the pixels look like the character.

const ARIA = {
  description: 'a young woman with red hair and freckles, wearing a green jacket',
  seed: 42,
  model: 'flux-1.1-pro' as string | null,
  strength: 0.6 as number | null,
}

describe('buildCharacterGenerationParams', () => {
  it('applies the pinned seed (reproducibility backbone)', () => {
    const p = buildCharacterGenerationParams(ARIA, {
      prompt: 'standing in a forest',
      referenceImageUrl: 'dreambyte://asset/aria.png',
      fallbackModel: 'flux-schnell',
    })
    expect(p.seed).toBe(42)
  })

  it('passes the reference image through for i2i conditioning', () => {
    const p = buildCharacterGenerationParams(ARIA, {
      prompt: 'sitting at a desk',
      referenceImageUrl: 'dreambyte://asset/aria.png',
      fallbackModel: 'flux-schnell',
    })
    expect(p.referenceImageUrl).toBe('dreambyte://asset/aria.png')
  })

  it('leads the prompt with the identity descriptor, then the scene action', () => {
    const p = buildCharacterGenerationParams(ARIA, {
      prompt: 'waving hello',
      referenceImageUrl: null,
      fallbackModel: 'flux-schnell',
    })
    expect(p.prompt).toBe('a young woman with red hair and freckles, wearing a green jacket. waving hello')
  })

  it("uses the character's model when set, ignoring the fallback", () => {
    const p = buildCharacterGenerationParams(ARIA, {
      prompt: 'x',
      referenceImageUrl: null,
      fallbackModel: 'flux-schnell',
    })
    expect(p.model).toBe('flux-1.1-pro')
  })

  it('falls back to the provided model when the character has none', () => {
    const p = buildCharacterGenerationParams(
      { ...ARIA, model: null },
      { prompt: 'x', referenceImageUrl: null, fallbackModel: 'stable-diffusion-3' },
    )
    expect(p.model).toBe('stable-diffusion-3')
  })

  it('carries the strength override (undefined when unset → endpoint default)', () => {
    const withStrength = buildCharacterGenerationParams(ARIA, {
      prompt: 'x',
      referenceImageUrl: null,
      fallbackModel: 'flux-schnell',
    })
    expect(withStrength.strength).toBe(0.6)
    const noStrength = buildCharacterGenerationParams(
      { ...ARIA, strength: null },
      { prompt: 'x', referenceImageUrl: null, fallbackModel: 'flux-schnell' },
    )
    expect(noStrength.strength).toBeUndefined()
  })

  it('handles a description-less character (scene prompt only)', () => {
    const p = buildCharacterGenerationParams(
      { ...ARIA, description: null },
      { prompt: 'a hero pose', referenceImageUrl: null, fallbackModel: 'flux-schnell' },
    )
    expect(p.prompt).toBe('a hero pose')
  })

  it('preserves a null seed (let the model pick)', () => {
    const p = buildCharacterGenerationParams(
      { ...ARIA, seed: null },
      { prompt: 'x', referenceImageUrl: null, fallbackModel: 'flux-schnell' },
    )
    expect(p.seed).toBeNull()
  })
})
