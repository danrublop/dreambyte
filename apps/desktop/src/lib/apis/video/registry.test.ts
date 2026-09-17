// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { firstConfiguredVideoProvider, VIDEO_PROVIDER_FALLBACK_ORDER } from './registry'

const KEYS = ['FAL_KEY', 'GOOGLE_AI_KEY', 'RUNWAY_API_KEY']
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = {}
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!)
})

describe('video provider default — FAL-first, key-aware (media gen runs on FAL)', () => {
  it('fallback order lists FAL models before veo3 (Google) and runway', () => {
    const order = VIDEO_PROVIDER_FALLBACK_ORDER as readonly string[]
    expect(order.indexOf('veo3')).toBeGreaterThan(order.indexOf('kling25'))
    expect(order.indexOf('veo3')).toBeGreaterThan(order.indexOf('ltx'))
    expect(order.indexOf('runway')).toBe(order.length - 1)
  })

  it('picks a FAL model when only FAL_KEY is set', () => {
    process.env.FAL_KEY = 'fal-test'
    const p = firstConfiguredVideoProvider()
    expect(p?.envKey).toBe('FAL_KEY')
  })

  it('picks veo3 when only GOOGLE_AI_KEY is set (FAL absent)', () => {
    process.env.GOOGLE_AI_KEY = 'g-test'
    expect(firstConfiguredVideoProvider()?.id).toBe('veo3')
  })

  it('prefers FAL over veo3 when BOTH keys are set', () => {
    process.env.FAL_KEY = 'fal-test'
    process.env.GOOGLE_AI_KEY = 'g-test'
    expect(firstConfiguredVideoProvider()?.envKey).toBe('FAL_KEY')
  })

  it('returns null when no video key is configured', () => {
    expect(firstConfiguredVideoProvider()).toBeNull()
  })
})
