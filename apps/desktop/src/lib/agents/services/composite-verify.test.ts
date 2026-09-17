// @vitest-environment node
/**
 * Tests for composite verify.
 *
 * planCompositeVerifySamples is the temporal-sampling spec (outside-voice #5: cross-scene
 * incoherence is TEMPORAL). reviewCutTemporally drives it through the shipped cut-review
 * transport with a boundary-aware prompt and honest-skip.
 */

import { describe, it, expect } from 'vitest'

import {
  planCompositeVerifySamples,
  compositeVerifyPrompt,
  reviewCutTemporally,
  type CompositeVerifyScene,
} from './composite-verify'
import type { CutSceneTiming } from './cut-review'
import { makeRunCostLedger, commitCost } from '../run-cost-ledger'

const scenes = (n: number): CompositeVerifyScene[] =>
  Array.from({ length: n }, (_, i) => ({ sceneId: `s${i}`, name: `Scene ${i + 1}`, durationSec: 8 }))

// A minimal valid image data URI (decodes to non-empty bytes; downsample degrades to it).
const FAKE_FRAME = { dataUri: 'data:image/png;base64,QUFBQQ==', mimeType: 'image/png' }

describe('planCompositeVerifySamples — motion + transition-boundary sampling', () => {
  it('emits motion + a tail/head pair straddling every cut, in playback order', () => {
    const s = planCompositeVerifySamples(scenes(3))
    expect(s.map((x) => x.kind)).toEqual([
      'motion', // s0 mid
      'transition-out', // s0 leaving → cut
      'transition-in', // s1 entering
      'motion', // s1 mid
      'transition-out', // s1 leaving → cut
      'transition-in', // s2 entering
      'motion', // s2 mid
    ])
    expect(s.map((x) => x.sceneId)).toEqual(['s0', 's0', 's1', 's1', 's1', 's2', 's2'])
  })

  it('samples motion at the scene midpoint and boundaries near the cut', () => {
    const [motion, out] = planCompositeVerifySamples(scenes(2))
    expect(motion.kind).toBe('motion')
    expect(motion.timeSec).toBe(4) // 8s * 0.5
    expect(out.kind).toBe('transition-out')
    expect(out.timeSec).toBeCloseTo(7.04) // 8s * (1 - 0.12)
  })

  it('every transition-out is immediately followed by the incoming transition-in (the cut pair)', () => {
    const s = planCompositeVerifySamples(scenes(4))
    for (let i = 0; i < s.length; i++) {
      if (s[i].kind === 'transition-out') {
        expect(s[i + 1]?.kind).toBe('transition-in')
        expect(s[i + 1]?.sceneIndex).toBe(s[i].sceneIndex + 1) // out of scene N, into N+1
      }
    }
  })

  it('a single scene yields only its motion frame (nothing to transition between)', () => {
    const s = planCompositeVerifySamples(scenes(1))
    expect(s).toHaveLength(1)
    expect(s[0].kind).toBe('motion')
  })

  it('clamps a zero/negative duration so a capture never lands out of range', () => {
    const s = planCompositeVerifySamples([
      { sceneId: 'a', name: 'A', durationSec: 0 },
      { sceneId: 'b', name: 'B', durationSec: 8 },
    ])
    for (const x of s) expect(x.timeSec).toBeGreaterThanOrEqual(0)
  })
})

describe('compositeVerifyPrompt — boundary-aware (not the per-still prompt)', () => {
  it('tells the model the frames straddle the cuts and to judge transitions/continuity', () => {
    const timing: CutSceneTiming[] = [
      { index: 0, name: 'Scene 1 — mid', durationSec: 8 },
      { index: 1, name: 'Scene 1 — leaving', durationSec: 8 },
    ]
    const p = compositeVerifyPrompt(timing)
    expect(p).toMatch(/transition/i)
    expect(p).toMatch(/continuity/i)
    expect(p).toMatch(/one .*film|as one film/i)
    // Distinct from cutReviewPrompt, which says the opposite.
    expect(p).not.toMatch(/cannot see motion or transitions/i)
  })
})

describe('reviewCutTemporally — reuses the cut-review transport with the boundary prompt', () => {
  it('captures the boundary+motion set, uses the boundary prompt, maps findings back to sceneId', async () => {
    let sentPrompt = ''
    const brief = await reviewCutTemporally(scenes(3), 'test-engine', {
      capture: async () => FAKE_FRAME,
      send: async (_frames, prompt) => {
        sentPrompt = prompt
        return JSON.stringify({
          summary: 'reads as one film',
          // frame 3 (1-based) is the s1 transition-in → the finding maps to s1.
          findings: [{ kind: 'continuity', severity: 'high', scene: 3, detail: 'palette resets at the cut' }],
        })
      },
    })
    expect(brief.reviewable).toBe(true)
    expect(sentPrompt).toMatch(/transition/i) // boundary prompt, not the per-still one
    expect(brief.reviewedSceneIds).toHaveLength(7) // 3 motion + 2 tail + 2 head
    expect(brief.findings[0].sceneId).toBe('s1')
  })

  it('honest-skips a single-scene cut (nothing to transition between)', async () => {
    const brief = await reviewCutTemporally(scenes(1), 'e', { capture: async () => FAKE_FRAME })
    expect(brief.reviewable).toBe(false)
    expect(brief.note).toMatch(/too few scenes/i)
  })

  it('honest-skips when every capture fails (never a silent clean pass)', async () => {
    const brief = await reviewCutTemporally(scenes(3), 'e', {
      capture: async () => null,
      send: async () => '{"findings":[]}',
    })
    expect(brief.reviewable).toBe(false)
    expect(brief.note).toMatch(/too few frames/i)
  })

  it('honest-skips when the review would exceed the run cost cap', async () => {
    const ledger = makeRunCostLedger(1)
    commitCost(ledger, 2) // already over the cap before the review starts
    let sent = false
    const brief = await reviewCutTemporally(scenes(3), 'e', {
      capture: async () => FAKE_FRAME,
      send: async () => {
        sent = true
        return '{}'
      },
      costLedger: ledger,
    })
    expect(brief.reviewable).toBe(false)
    expect(brief.note).toMatch(/cost cap/i)
    expect(sent).toBe(false) // never reached the VLM
  })

  it('stops before the VLM when aborted mid-capture', async () => {
    const ac = { aborted: true }
    const brief = await reviewCutTemporally(scenes(3), 'e', {
      capture: async () => FAKE_FRAME,
      send: async () => '{}',
      abortSignal: ac,
    })
    expect(brief.reviewable).toBe(false)
  })
})
