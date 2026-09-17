import { describe, it, expect } from 'vitest'
import {
  API_COST_SCALARS,
  DEFAULT_SINGLE_CALL_COST_THRESHOLD_USD,
  checkPermission,
  createDefaultAPIPermissions,
  createDefaultPermissionConfig,
  estimateApiCostUsd,
  resolveCostThreshold,
} from './permissions'
import type { APIPermissions } from './types'

function baseline(): APIPermissions {
  const perms = createDefaultAPIPermissions()
  // Put every API into always_allow mode so we can isolate the cost gate.
  for (const key of Object.keys(perms) as Array<keyof APIPermissions>) {
    perms[key] = { ...perms[key], mode: 'always_allow' }
  }
  return perms
}

describe('estimateApiCostUsd', () => {
  it('returns the per-call baseline when no args refine the estimate', () => {
    expect(estimateApiCostUsd('backgroundRemoval')).toBe(API_COST_SCALARS.backgroundRemoval.perCall)
  })

  it('scales video cost with duration', () => {
    const shortClip = estimateApiCostUsd('veo3', { duration: 3 })
    const longClip = estimateApiCostUsd('veo3', { duration: 12 })
    expect(longClip).toBeGreaterThan(shortClip)
  })

  it('scales TTS cost with text length', () => {
    const shortText = estimateApiCostUsd('elevenLabs', { prompt: 'hi' })
    const longText = estimateApiCostUsd('elevenLabs', { prompt: 'x'.repeat(5000) })
    expect(longText).toBeGreaterThan(shortText)
  })

  it('returns 0 for free providers', () => {
    expect(estimateApiCostUsd('freesound')).toBe(0)
    expect(estimateApiCostUsd('pixabay')).toBe(0)
    expect(estimateApiCostUsd('unsplash')).toBe(0)
  })

  // T7: per-model catalog cost overrides the flat per-API scalar. The flat imageGen scalar
  // (0.04) under-priced ideogram (0.08) and over-priced flux-schnell (0.01) at the gate.
  it('uses per-model catalog cost when a model id is supplied', () => {
    expect(estimateApiCostUsd('imageGen', { model: 'ideogram-v3' })).toBeCloseTo(0.08)
    expect(estimateApiCostUsd('imageGen', { model: 'flux-schnell' })).toBeCloseTo(0.003)
    expect(estimateApiCostUsd('imageGen', { model: 'flux-1.1-pro' })).toBeCloseTo(0.05)
  })

  it('falls back to the per-API scalar when the model is unknown or absent', () => {
    expect(estimateApiCostUsd('imageGen')).toBe(API_COST_SCALARS.imageGen.perCall)
    expect(estimateApiCostUsd('imageGen', { model: 'not-a-real-model' })).toBe(API_COST_SCALARS.imageGen.perCall)
  })

  // Tier 3: video upscale is its OWN cost bucket and is duration-INDEPENDENT (no perSecond scalar).
  // This is the fix for the cross-model P0: routing upscale through a generation provider let a caller
  // pass a fake short duration and underbill the same paid Topaz job. A flat bucket removes that lever.
  it('prices videoUpscale as a flat, duration-independent bucket (no fake-duration lever)', () => {
    const base = API_COST_SCALARS.videoUpscale.perCall
    expect(base).toBeGreaterThan(0) // a real, non-zero cost → the cap actually gates it
    expect(API_COST_SCALARS.videoUpscale.perSecond).toBeUndefined()
    expect(estimateApiCostUsd('videoUpscale', { duration: 1 })).toBe(base)
    expect(estimateApiCostUsd('videoUpscale', { duration: 100 })).toBe(base) // duration can't move it
  })

  // Tier 3: 4× upscale prices at ~2× the base AT THE GATE, so the ask/deny threshold sees the same
  // amount reserve + commit charge (a 4× must not auto-allow under a threshold meant for the 2× base).
  it('scales videoUpscale by the upscale factor (4× = 2× the 2× base)', () => {
    const base = API_COST_SCALARS.videoUpscale.perCall
    expect(estimateApiCostUsd('videoUpscale', { upscaleFactor: 2 })).toBe(base)
    expect(estimateApiCostUsd('videoUpscale', { upscaleFactor: 4 })).toBe(base * 2)
    // The factor only affects videoUpscale, not other buckets.
    expect(estimateApiCostUsd('kling', { upscaleFactor: 4, duration: 5 })).toBe(
      estimateApiCostUsd('kling', { duration: 5 }),
    )
  })
})

describe('resolveCostThreshold', () => {
  it('falls back to the project default when the per-API override is null', () => {
    const cfg = createDefaultPermissionConfig()
    expect(resolveCostThreshold(cfg)).toBe(DEFAULT_SINGLE_CALL_COST_THRESHOLD_USD)
  })

  it('uses the per-API override when set', () => {
    const cfg = { ...createDefaultPermissionConfig(), singleCallCostThreshold: 1.5 }
    expect(resolveCostThreshold(cfg)).toBe(1.5)
  })

  it('accepts a null per-API override only via explicit null (undefined → project default)', () => {
    const cfg = { ...createDefaultPermissionConfig(), singleCallCostThreshold: null }
    expect(resolveCostThreshold(cfg, 0.25)).toBe(0.25)
  })
})

describe('checkPermission cost gate', () => {
  const reason = 'test'
  const details = {}
  const sess = new Map<string, string>()

  it('tolerates saved permissions that still carry the removed imageEnhance entry', () => {
    const legacy = { ...baseline(), imageEnhance: createDefaultPermissionConfig() } as APIPermissions
    const r = checkPermission(legacy, 'backgroundRemoval', '$0.01', reason, details, sess, { estimatedCostUsd: 0.01 })
    expect(r.action).toBe('allow')
  })

  it('auto-allows when mode is always_allow AND cost is below threshold', () => {
    const perms = baseline()
    const r = checkPermission(perms, 'backgroundRemoval', '$0.01', reason, details, sess, {
      estimatedCostUsd: 0.01,
    })
    expect(r.action).toBe('allow')
  })

  it('forces ask when mode is always_allow AND cost exceeds threshold', () => {
    const perms = baseline()
    const r = checkPermission(perms, 'veo3', '~$1.25', reason, details, sess, { estimatedCostUsd: 1.25 })
    expect(r.action).toBe('ask')
    if (r.action === 'ask') {
      expect(r.request.costThresholdExceeded).toBe(true)
      expect(r.request.reason).toContain('$1.25')
      expect(r.request.reason).toContain('approval threshold')
    }
  })

  it('per-API threshold override raises the bar', () => {
    const perms = baseline()
    perms.veo3 = { ...perms.veo3, singleCallCostThreshold: 5 }
    const r = checkPermission(perms, 'veo3', '~$1.25', reason, details, sess, { estimatedCostUsd: 1.25 })
    expect(r.action).toBe('allow')
  })

  it('ask_once with prior session approval still gates expensive calls', () => {
    const perms = baseline()
    perms.veo3 = { ...perms.veo3, mode: 'ask_once' }
    sess.set('veo3', 'allow')
    const r = checkPermission(perms, 'veo3', '~$1.25', reason, details, sess, { estimatedCostUsd: 1.25 })
    expect(r.action).toBe('ask')
    if (r.action === 'ask') expect(r.request.costThresholdExceeded).toBe(true)
  })

  it('free providers never fire the cost gate', () => {
    const perms = baseline()
    const r = checkPermission(perms, 'freesound', 'Free', reason, details, sess, { estimatedCostUsd: 0 })
    expect(r.action).toBe('allow')
  })

  it('always_ask mode still asks regardless of cost', () => {
    const perms = baseline()
    perms.backgroundRemoval = { ...perms.backgroundRemoval, mode: 'always_ask' }
    const r = checkPermission(perms, 'backgroundRemoval', '$0.01', reason, details, sess, {
      estimatedCostUsd: 0.01,
    })
    expect(r.action).toBe('ask')
    if (r.action === 'ask') expect(r.request.costThresholdExceeded).toBe(false)
  })

  it('deny takes precedence over the cost gate', () => {
    const perms = baseline()
    perms.veo3 = { ...perms.veo3, mode: 'always_deny' }
    const r = checkPermission(perms, 'veo3', '~$1.25', reason, details, sess, { estimatedCostUsd: 1.25 })
    expect(r.action).toBe('deny')
  })

  it('backfills missing API config from defaults (old DB projects)', () => {
    const perms = baseline()
    // Simulate an old DB row loaded before `kling` existed in the type.
    delete (perms as Partial<typeof perms>).kling
    const r = checkPermission(perms as typeof perms, 'kling', '~$0.45', reason, details, sess, {
      estimatedCostUsd: 0.45,
    })
    // Default mode is always_ask → ask regardless of cost
    expect(r.action).toBe('ask')
  })

  it('handles missing singleCallCostThreshold on old configs', () => {
    const perms = baseline()
    const cfgWithoutThreshold: Omit<(typeof perms)['veo3'], 'singleCallCostThreshold'> = { ...perms.veo3 }
    // Strip the field as if it came from an old DB record.
    perms.veo3 = cfgWithoutThreshold as (typeof perms)['veo3']
    const r = checkPermission(perms, 'veo3', '~$1.25', reason, details, sess, { estimatedCostUsd: 1.25 })
    // Falls back to project default (0.50) → 1.25 > 0.50 → ask.
    expect(r.action).toBe('ask')
    if (r.action === 'ask') expect(r.request.costThresholdExceeded).toBe(true)
  })
})
