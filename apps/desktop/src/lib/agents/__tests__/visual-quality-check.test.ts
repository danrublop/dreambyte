/**
 * Unit tests for the vision-model visual quality check.
 *
 * Tests the runner-facing wrapper `runVisualQualityCheck` — not the live
 * Anthropic API call. The vision implementation is swapped via
 * `__setVisualQualityCheckImplForTesting` so we can simulate the four
 * response branches without network I/O.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  runVisualQualityCheck,
  checkVisualQuality,
  qualityResultToWarnings,
  VISUAL_CHECK_COST_CAP_USD,
  __setVisualQualityCheckImplForTesting,
  __resetVisualQualityCheckImplForTesting,
  __setVisionEngineResolverForTesting,
  __resetVisionEngineResolverForTesting,
  type VisualQualityResult,
} from '../services/visual-quality-check'
import * as visionDispatch from '../services/vision-dispatch'

// Minimal logger that records calls for assertion.
function makeLogger() {
  const events: Array<{ level: 'log' | 'warn'; phase: string; message: string }> = []
  return {
    events,
    log: (phase: string, message: string) => events.push({ level: 'log', phase, message }),
    warn: (phase: string, message: string) => events.push({ level: 'warn', phase, message }),
  }
}

const DATA_URI = 'data:image/png;base64,iVBORw0KGgo='
const MIME = 'image/png'

describe('runVisualQualityCheck', () => {
  // A5: the wrapper key-gates before reserving cost — give tests a key so the
  // pre-existing behavior assertions still exercise the full path.
  beforeEach(() => {
    __resetVisualQualityCheckImplForTesting()
    // Default: a vision provider IS available (engine resolves) so the
    // behavior assertions exercise the full path without hitting the network.
    __setVisionEngineResolverForTesting(async () => 'cloud:anthropic')
  })

  afterEach(() => {
    __resetVisualQualityCheckImplForTesting()
    __resetVisionEngineResolverForTesting()
  })

  it('skips entirely (no cost reserved, no impl call) when NO vision provider is available', async () => {
    __setVisionEngineResolverForTesting(async () => null)
    let called = 0
    __setVisualQualityCheckImplForTesting(async () => {
      called++
      return null
    })
    const result: { success: boolean; data?: unknown } = { success: true }
    const runProgress = { visualCheckCostUsd: 0 }

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, makeLogger())

    expect(called).toBe(0)
    expect(runProgress.visualCheckCostUsd).toBe(0)
    expect((result.data as any)?._visualWarnings).toBeUndefined()
  })

  it('runs with a NON-Anthropic vision provider (Gemini) — a DeepSeek agent can still see its frames', async () => {
    // No Anthropic key; only a Gemini engine resolves. The agent must still
    // get frame QA — this is the whole point of provider-routed vision.
    delete process.env.ANTHROPIC_API_KEY
    __setVisionEngineResolverForTesting(async () => 'cloud:gemini')
    let seenEngine: string | undefined
    __setVisualQualityCheckImplForTesting(async (_d, _m, _i, engineId) => {
      seenEngine = engineId
      return { readable: true, contrast_ok: true, blank_or_static: false, elements_visible: true, matches_intent: true, notes: '' }
    })
    const result: { success: boolean; data?: unknown } = { success: true }
    const runProgress = { visualCheckCostUsd: 0 }

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, makeLogger())

    expect(seenEngine).toBe('cloud:gemini') // resolved engine threaded to the impl
    expect(runProgress.visualCheckCostUsd).toBeGreaterThan(0)
  })

  it('resolves the vision engine at most once per run (cached on runProgress)', async () => {
    let resolves = 0
    __setVisionEngineResolverForTesting(async () => {
      resolves++
      return 'cloud:anthropic'
    })
    __setVisualQualityCheckImplForTesting(async () => ({
      readable: true, contrast_ok: true, blank_or_static: false, elements_visible: true, matches_intent: true, notes: '',
    }))
    const runProgress = { visualCheckCostUsd: 0 }
    await runVisualQualityCheck(DATA_URI, MIME, { success: true }, runProgress, makeLogger())
    await runVisualQualityCheck(DATA_URI, MIME, { success: true }, runProgress, makeLogger())
    expect(resolves).toBe(1)
  })

  it('attaches no warnings when scene passes all checks', async () => {
    __setVisualQualityCheckImplForTesting(async () => ({
      readable: true,
      contrast_ok: true,
      blank_or_static: false,
      elements_visible: true,
      matches_intent: true,
      notes: '',
    }))
    const result: { success: boolean; data?: unknown } = { success: true, data: { existing: 'value' } }
    const runProgress = { visualCheckCostUsd: 0 }
    const logger = makeLogger()

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, logger)

    expect((result.data as any)._visualWarnings).toBeUndefined()
    expect((result.data as any).existing).toBe('value')
    // Cost still incremented to prevent unbounded retries.
    expect(runProgress.visualCheckCostUsd).toBeGreaterThan(0)
  })

  it('surfaces VISUAL_BLANK_OR_STATIC when scene is blank', async () => {
    __setVisualQualityCheckImplForTesting(async () => ({
      readable: true,
      contrast_ok: true,
      blank_or_static: true,
      elements_visible: true,
      matches_intent: true,
      notes: 'frame is solid white',
    }))
    const result: { success: boolean; data?: unknown } = { success: true }
    const runProgress = { visualCheckCostUsd: 0 }
    const logger = makeLogger()

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, logger)

    const warnings = (result.data as any)._visualWarnings as Array<{ code: string; message: string }>
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('VISUAL_BLANK_OR_STATIC')
    expect(warnings[0].message).toContain('frame is solid white')
  })

  it('surfaces multiple warnings when multiple flags fail', async () => {
    __setVisualQualityCheckImplForTesting(async () => ({
      readable: false,
      contrast_ok: false,
      blank_or_static: false,
      elements_visible: false,
      matches_intent: true,
      notes: '',
    }))
    const result: { success: boolean; data?: unknown } = { success: true }
    const runProgress = { visualCheckCostUsd: 0 }
    const logger = makeLogger()

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, logger)

    const warnings = (result.data as any)._visualWarnings as Array<{ code: string }>
    expect(warnings.map((w) => w.code).sort()).toEqual([
      'VISUAL_ELEMENTS_OFFSCREEN',
      'VISUAL_LOW_CONTRAST',
      'VISUAL_TEXT_UNREADABLE',
    ])
  })

  it('skips API call and warns once when cost cap is reached', async () => {
    let callCount = 0
    __setVisualQualityCheckImplForTesting(async () => {
      callCount++
      return {
        readable: false,
        contrast_ok: true,
        blank_or_static: false,
        elements_visible: true,
        matches_intent: true,
        notes: '',
      } as VisualQualityResult
    })

    // Start already over the cap.
    const result1: { success: boolean; data?: unknown } = { success: true }
    const runProgress = { visualCheckCostUsd: VISUAL_CHECK_COST_CAP_USD + 0.01 }
    const logger = makeLogger()

    await runVisualQualityCheck(DATA_URI, MIME, result1, runProgress, logger)

    // No API call.
    expect(callCount).toBe(0)
    // Cap warning is attached on first overage.
    const warnings = (result1.data as any)._visualWarnings as Array<{ code: string }>
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('VISUAL_CHECK_COST_CAP')
    expect((runProgress as any)._visualCheckCapAnnounced).toBe(true)

    // Second call: still over cap and same runProgress — silent skip, no
    // duplicate warning. This is the bug the test caught: previously the
    // flag lived on result.data so every fresh ToolResult re-fired.
    const result2: { success: boolean; data?: unknown } = { success: true }
    await runVisualQualityCheck(DATA_URI, MIME, result2, runProgress, logger)

    expect(callCount).toBe(0)
    expect((result2.data as any)?._visualWarnings).toBeUndefined()
  })

  it('does not block the run when vision impl returns null', async () => {
    __setVisualQualityCheckImplForTesting(async () => null)
    const result: { success: boolean; data?: unknown } = { success: true, data: { existing: 'value' } }
    const runProgress = { visualCheckCostUsd: 0 }
    const logger = makeLogger()

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, logger)

    expect((result.data as any)._visualWarnings).toBeUndefined()
    expect((result.data as any).existing).toBe('value')
    // Cost still incremented — null counts against budget.
    expect(runProgress.visualCheckCostUsd).toBeGreaterThan(0)
  })

  it('preserves existing data fields when attaching warnings', async () => {
    __setVisualQualityCheckImplForTesting(async () => ({
      readable: false,
      contrast_ok: true,
      blank_or_static: false,
      elements_visible: true,
      matches_intent: true,
      notes: '',
    }))
    const result: { success: boolean; data?: unknown } = {
      success: true,
      data: { _hookWarning: 'RUNTIME: something noisy', clientAction: 'capture_frame' },
    }
    const runProgress = { visualCheckCostUsd: 0 }
    const logger = makeLogger()

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, logger)

    const d = result.data as Record<string, unknown>
    expect(d._hookWarning).toBe('RUNTIME: something noisy')
    expect(d.clientAction).toBe('capture_frame')
    expect((d._visualWarnings as Array<unknown>).length).toBe(1)
  })
})

describe('intent comparison (A3)', () => {
  // The wrapper resolves a vision engine before reserving cost — these tests
  // exercise the full path, so inject an available engine like the main
  // describe above.
  beforeEach(() => {
    __resetVisualQualityCheckImplForTesting()
    __setVisionEngineResolverForTesting(async () => 'cloud:anthropic')
  })
  afterEach(() => {
    __resetVisualQualityCheckImplForTesting()
    __resetVisionEngineResolverForTesting()
  })

  it('threads the intent through to the vision impl', async () => {
    let receivedIntent: unknown
    __setVisualQualityCheckImplForTesting(async (_uri, _mime, intent) => {
      receivedIntent = intent
      return {
        readable: true,
        contrast_ok: true,
        blank_or_static: false,
        elements_visible: true,
        matches_intent: true,
        notes: '',
      }
    })
    const result: { success: boolean; data?: unknown } = { success: true }
    const runProgress = { visualCheckCostUsd: 0 }

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, makeLogger(), undefined, {
      userPrompt: 'make an intro about photosynthesis',
      sceneName: 'Intro',
      scenePlan: 'leaf diagram with sunlight rays',
    })

    expect(receivedIntent).toEqual({
      userPrompt: 'make an intro about photosynthesis',
      sceneName: 'Intro',
      scenePlan: 'leaf diagram with sunlight rays',
    })
  })

  it('surfaces VISUAL_INTENT_MISMATCH when the model judges the frame off-plan', async () => {
    __setVisualQualityCheckImplForTesting(async () => ({
      readable: true,
      contrast_ok: true,
      blank_or_static: false,
      elements_visible: true,
      matches_intent: false,
      notes: 'frame shows a bar chart, intent was a leaf diagram',
    }))
    const result: { success: boolean; data?: unknown } = { success: true }
    const runProgress = { visualCheckCostUsd: 0 }

    await runVisualQualityCheck(DATA_URI, MIME, result, runProgress, makeLogger(), undefined, {
      scenePlan: 'leaf diagram with sunlight rays',
    })

    const warnings = (result.data as any)._visualWarnings as Array<{ code: string; message: string }>
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('VISUAL_INTENT_MISMATCH')
    expect(warnings[0].message).toContain('Note: frame shows a bar chart')
  })

  it('omitting intent keeps pre-A3 behavior (no mismatch warning possible)', async () => {
    __setVisualQualityCheckImplForTesting(async (_uri, _mime, intent) => {
      // No intent forwarded → the prompt instructs matches_intent: true.
      expect(intent).toBeUndefined()
      return {
        readable: true,
        contrast_ok: true,
        blank_or_static: false,
        elements_visible: true,
        matches_intent: true,
        notes: '',
      }
    })
    const result: { success: boolean; data?: unknown } = { success: true }
    await runVisualQualityCheck(DATA_URI, MIME, result, { visualCheckCostUsd: 0 }, makeLogger())
    expect((result.data as any)?._visualWarnings).toBeUndefined()
  })
})

describe('qualityResultToWarnings', () => {
  it('returns empty array when all flags pass', () => {
    expect(
      qualityResultToWarnings({
        readable: true,
        contrast_ok: true,
        blank_or_static: false,
        elements_visible: true,
        matches_intent: true,
        notes: '',
      }),
    ).toEqual([])
  })

  it('does not duplicate notes onto an empty warning list', () => {
    // notes is non-empty but all checks pass — notes should NOT manifest as a warning.
    const warnings = qualityResultToWarnings({
      readable: true,
      contrast_ok: true,
      blank_or_static: false,
      elements_visible: true,
      matches_intent: true,
      notes: 'looks fine to me',
    })
    expect(warnings).toEqual([])
  })

  it('appends notes to the last warning when warnings exist', () => {
    const warnings = qualityResultToWarnings({
      readable: false,
      contrast_ok: true,
      blank_or_static: false,
      elements_visible: true,
      matches_intent: true,
      notes: 'the title font is microscopic',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('Note: the title font is microscopic')
  })
})

describe('checkVisualQuality — provider-routed parsing (review)', () => {
  const PASS = '{"readable":true,"contrast_ok":true,"blank_or_static":false,"elements_visible":true,"matches_intent":true,"notes":""}'
  afterEach(() => vi.restoreAllMocks())

  it('strips a ```json fence before parsing (non-Anthropic providers wrap output)', async () => {
    vi.spyOn(visionDispatch, 'runVisionPrompt').mockResolvedValue('```json\n' + PASS + '\n```')
    const r = await checkVisualQuality(DATA_URI, 'image/png', undefined, 'cloud:qwen')
    expect(r?.readable).toBe(true)
    expect(r?.blank_or_static).toBe(false)
  })

  it('parses a bare JSON object (Anthropic-style)', async () => {
    vi.spyOn(visionDispatch, 'runVisionPrompt').mockResolvedValue(PASS)
    const r = await checkVisualQuality(DATA_URI, 'image/png', undefined, 'cloud:anthropic')
    expect(r?.contrast_ok).toBe(true)
  })

  it('returns null on non-JSON prose', async () => {
    vi.spyOn(visionDispatch, 'runVisionPrompt').mockResolvedValue('The image looks fine to me!')
    expect(await checkVisualQuality(DATA_URI, 'image/png', undefined, 'cloud:gemini')).toBeNull()
  })

  it('returns null (no dispatch) when no engine resolves', async () => {
    const spy = vi.spyOn(visionDispatch, 'runVisionPrompt')
    __setVisionEngineResolverForTesting(async () => null)
    const r = await checkVisualQuality(DATA_URI, 'image/png')
    expect(r).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    __resetVisionEngineResolverForTesting()
  })

  it('returns null on a null dispatch result (timeout/error)', async () => {
    vi.spyOn(visionDispatch, 'runVisionPrompt').mockResolvedValue(null)
    expect(await checkVisualQuality(DATA_URI, 'image/png', undefined, 'cloud:anthropic')).toBeNull()
  })
})
