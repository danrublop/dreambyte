import { describe, expect, it } from 'vitest'
import type { Scene, SceneType } from '../types/scene'
import type { TransitionType } from '../transitions'
import { scanCrossSceneContinuity } from './cross-scene-continuity'

// Minimal Scene fixture — only the fields the cross-scene scan reads
// (sceneType, transition, audioLayer.tts.src). The rest is filled with inert
// defaults so the cast to Scene is honest about the shape it's standing in for.
function mk(
  sceneType: SceneType,
  opts: { transition?: TransitionType; narration?: boolean } = {},
): Scene {
  return {
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    sceneType,
    transition: opts.transition ?? ('none' as TransitionType),
    audioLayer: opts.narration
      ? { enabled: true, src: null, volume: 1, fadeIn: false, fadeOut: false, startOffset: 0, tts: { src: '/uploads/n.mp3' } }
      : { enabled: false, src: null, volume: 1, fadeIn: false, fadeOut: false, startOffset: 0 },
  } as unknown as Scene
}

describe('scanCrossSceneContinuity', () => {
  it('no-ops for a single scene', () => {
    const r = scanCrossSceneContinuity([mk('react')])
    expect(r.warnings).toEqual([])
    expect(r.monotonePlan).toBe(false)
  })

  it('no-ops for an empty list', () => {
    const r = scanCrossSceneContinuity([])
    expect(r.warnings).toEqual([])
  })

  it('warns on 3 consecutive same-type (motion) scenes', () => {
    const r = scanCrossSceneContinuity([mk('motion'), mk('motion'), mk('motion')])
    expect(r.maxConsecutiveSameType).toBe(3)
    expect(r.warnings.some((w) => w.includes('3 consecutive motion'))).toBe(true)
  })

  it('does NOT warn on exactly 2 consecutive same-type scenes', () => {
    // 2 in a row is fine; the 3rd is a different renderer.
    const r = scanCrossSceneContinuity([mk('motion'), mk('motion'), mk('d3')])
    expect(r.maxConsecutiveSameType).toBe(2)
    expect(r.warnings.some((w) => w.includes('consecutive'))).toBe(false)
  })

  it('is clean for alternating renderers (no monotony of any kind)', () => {
    const r = scanCrossSceneContinuity([mk('react'), mk('d3'), mk('react'), mk('three')])
    expect(r.warnings).toEqual([])
    expect(r.monotonePlan).toBe(false)
    expect(r.monotoneTransition).toBe(false)
  })

  it('warns monotone-plan when all 4 scenes are the same type', () => {
    const r = scanCrossSceneContinuity([mk('react'), mk('react'), mk('react'), mk('react')])
    expect(r.monotonePlan).toBe(true)
    // A 4-long run also trips the consecutive rule; either warning is acceptable,
    // but at least one monotony signal must surface, and output stays bounded.
    expect(r.warnings.length).toBeGreaterThanOrEqual(1)
    expect(r.warnings.length).toBeLessThanOrEqual(4)
  })

  it('flags an all-same plan of length 2 as monotone (below the consecutive threshold)', () => {
    // 2 scenes, both 'react': not a >2 run, but still a one-note plan.
    const r = scanCrossSceneContinuity([mk('react'), mk('react')])
    expect(r.monotonePlan).toBe(true)
    expect(r.warnings.some((w) => w.includes('every scene is the same type'))).toBe(true)
  })

  it('warns on transition monotony (same non-cut transition between every cut)', () => {
    const r = scanCrossSceneContinuity([
      mk('react'),
      mk('d3', { transition: 'crossfade' }),
      mk('react', { transition: 'crossfade' }),
      mk('three', { transition: 'crossfade' }),
    ])
    expect(r.monotoneTransition).toBe(true)
    expect(r.warnings.some((w) => w.includes("'crossfade' transition"))).toBe(true)
  })

  it('does NOT flag a run of plain hard cuts (none) as transition monotony', () => {
    const r = scanCrossSceneContinuity([
      mk('react'),
      mk('d3', { transition: 'none' }),
      mk('three', { transition: 'none' }),
    ])
    expect(r.monotoneTransition).toBe(false)
    expect(r.warnings.some((w) => w.includes('transition'))).toBe(false)
  })

  it('notes a static-narration run (narration + no motion across 3+ scenes)', () => {
    const scenes = [mk('react', { narration: true }), mk('react', { narration: true }), mk('react', { narration: true })]
    const r = scanCrossSceneContinuity(scenes, { hasMotion: () => false })
    expect(r.staticNarrationRun).toBe(true)
    expect(r.warnings.some((w) => w.includes('voiceover over static slides'))).toBe(true)
  })

  it('does NOT note a narration run when the scenes have camera motion', () => {
    const scenes = [mk('react', { narration: true }), mk('react', { narration: true }), mk('react', { narration: true })]
    const r = scanCrossSceneContinuity(scenes, { hasMotion: () => true })
    expect(r.staticNarrationRun).toBe(false)
    expect(r.warnings.some((w) => w.includes('voiceover'))).toBe(false)
  })

  it('breaks a narration run when a non-narration scene interrupts it', () => {
    const scenes = [
      mk('react', { narration: true }),
      mk('react', { narration: true }),
      mk('react'), // no narration → resets the run
      mk('react', { narration: true }),
    ]
    const r = scanCrossSceneContinuity(scenes, { hasMotion: () => false })
    expect(r.staticNarrationRun).toBe(false)
  })

  it('produces SOFT, bounded output and never throws or blocks', () => {
    // A maximally-monotone video: 6 same-type scenes, same transition, narration, no motion.
    const scenes = Array.from({ length: 6 }, () => mk('motion', { transition: 'crossfade', narration: true }))
    let report: ReturnType<typeof scanCrossSceneContinuity> | undefined
    expect(() => {
      report = scanCrossSceneContinuity(scenes, { hasMotion: () => false })
    }).not.toThrow()
    // Soft: it returns warnings (strings), it does not throw / block.
    expect(Array.isArray(report!.warnings)).toBe(true)
    // Bounded: at most one warning per rule (4 rules).
    expect(report!.warnings.length).toBeLessThanOrEqual(4)
    expect(report!.warnings.length).toBeGreaterThan(0)
    expect(report!.warnings.every((w) => typeof w === 'string')).toBe(true)
  })
})
