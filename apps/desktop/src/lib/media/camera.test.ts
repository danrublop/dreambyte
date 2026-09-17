import { describe, it, expect } from 'vitest'
import { compileCameraToPrompt, cameraClauseForProvider, MAX_STACKED_MOVES, type CameraSpec } from './camera'

describe('compileCameraToPrompt', () => {
  it('returns empty for an empty/missing spec (caller skips appending)', () => {
    expect(compileCameraToPrompt(null)).toBe('')
    expect(compileCameraToPrompt(undefined)).toBe('')
    expect(compileCameraToPrompt({ moves: [] })).toBe('')
  })

  it('compiles a single move with an intensity adverb', () => {
    const out = compileCameraToPrompt({ moves: [{ type: 'dolly-in', intensity: 0.9 }] })
    expect(out).toMatch(/Camera movement:/)
    expect(out).toMatch(/aggressive/)
    expect(out).toMatch(/dolly in/)
  })

  it('stacks multiple moves as simultaneous', () => {
    const out = compileCameraToPrompt({
      moves: [
        { type: 'dolly-in', intensity: 0.3 },
        { type: 'orbit-left', intensity: 0.5 },
      ],
    })
    expect(out).toMatch(/dolly in/)
    expect(out).toMatch(/orbit the camera to the left/)
    expect(out).toMatch(/while/)
  })

  it('caps the stack at MAX_STACKED_MOVES (Higgsfield-style)', () => {
    const out = compileCameraToPrompt({
      moves: [{ type: 'dolly-in' }, { type: 'orbit-left' }, { type: 'tilt-up' }, { type: 'crash-zoom-in' }],
    })
    // 4 requested, only 3 compiled → at most MAX-1 ", while" separators.
    expect((out.match(/, while /g) ?? []).length).toBe(MAX_STACKED_MOVES - 1)
    expect(out).not.toMatch(/crash zoom/) // the 4th move dropped
  })

  it("'static' ignores intensity (it doesn't move)", () => {
    const out = compileCameraToPrompt({ moves: [{ type: 'static', intensity: 0.9 }] })
    expect(out).toMatch(/static shot/)
    expect(out).not.toMatch(/aggressive/)
  })

  it('clamps out-of-range intensity instead of producing junk', () => {
    expect(compileCameraToPrompt({ moves: [{ type: 'pan-left', intensity: 5 }] })).toMatch(/aggressive/)
    expect(compileCameraToPrompt({ moves: [{ type: 'pan-left', intensity: -2 }] })).toMatch(/barely/)
  })

  it('drops unknown move types rather than emitting undefined', () => {
    const out = compileCameraToPrompt({ moves: [{ type: 'warp-speed' as never }] })
    expect(out).toBe('')
  })
})

describe('cameraClauseForProvider', () => {
  it('compiles for a camera:prompt video provider (veo3)', () => {
    expect(cameraClauseForProvider('veo3', { moves: [{ type: 'dolly-in' }] })).toMatch(/dolly in/)
  })
  it('returns empty with no camera spec', () => {
    expect(cameraClauseForProvider('veo3', undefined)).toBe('')
  })
  it('defaults unknown providers to prompt-compiled (graceful)', () => {
    expect(cameraClauseForProvider('made-up', { moves: [{ type: 'orbit-left' }] })).toMatch(/orbit/)
  })
})
