// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { routeMediaIntent } from './router'

/**
 * The Phase 2 frontier bumps (seedream-4.5, nano-banana-pro) must be in PREFERENCE, otherwise a
 * caller passing them as preferModel silently falls through to the older/cheaper sibling — wrong
 * model AND wrong bill. These pin that preferModel resolves to the exact requested row. FAL_KEY is
 * set so the fal-hosted providers (seedream/nanoBanana) read as ready.
 */
const savedFal = process.env.FAL_KEY
beforeEach(() => {
  process.env.FAL_KEY = 'test-key'
})
afterEach(() => {
  if (savedFal === undefined) delete process.env.FAL_KEY
  else process.env.FAL_KEY = savedFal
})

describe('routeMediaIntent — Phase 2 frontier bump models resolve via preferModel', () => {
  it('t2i: preferModel nano-banana-pro resolves to nano-banana-pro (not the 4c sibling)', () => {
    const r = routeMediaIntent({ intent: 't2i', preferModel: 'nano-banana-pro', enabledMap: null })
    expect(r.modelId).toBe('nano-banana-pro')
    expect(r.providerId).toBe('nanoBanana')
  })

  it('t2i: preferModel seedream-4.5 resolves to seedream-4.5', () => {
    const r = routeMediaIntent({ intent: 't2i', preferModel: 'seedream-4.5', enabledMap: null })
    expect(r.modelId).toBe('seedream-4.5')
    expect(r.providerId).toBe('seedream')
  })

  it('i2i: preferModel nano-banana-pro resolves (with a reference image)', () => {
    const r = routeMediaIntent({
      intent: 'i2i',
      preferModel: 'nano-banana-pro',
      enabledMap: null,
      referenceImageUrl: 'https://example.com/ref.png',
    })
    expect(r.modelId).toBe('nano-banana-pro')
  })

  it('regression: an unknown preferModel still falls through to the default head (no crash)', () => {
    const r = routeMediaIntent({ intent: 't2i', preferModel: 'does-not-exist', enabledMap: null })
    expect(r.modelId).toBe('flux-1.1-pro')
  })
})
