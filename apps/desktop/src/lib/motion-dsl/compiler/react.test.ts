// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { compileMotionRefToStyleAt, emitReactMotionHelper } from './react'
import type { MotionRef } from '../types'

const PRESET_FADE_UP: MotionRef = { kind: 'preset', preset: 'fadeInUp', durationFrames: 30 }

describe('compileMotionRefToStyleAt', () => {
  it('returns identity at frame 0 (opacity 0, ty 60)', () => {
    const style = compileMotionRefToStyleAt(PRESET_FADE_UP, undefined, 0)
    expect(style.opacity).toBe(0)
    expect(style.transform).toContain('translate(0px, 60px)')
  })

  it('reaches the final state past endFrame', () => {
    const style = compileMotionRefToStyleAt(PRESET_FADE_UP, undefined, 60)
    expect(style.opacity).toBe(1)
    expect(style.transform).toContain('translate(0px, 0px)')
  })

  it('interpolates monotonically across the duration', () => {
    const o0 = compileMotionRefToStyleAt(PRESET_FADE_UP, undefined, 0).opacity ?? 0
    const o15 = compileMotionRefToStyleAt(PRESET_FADE_UP, undefined, 15).opacity ?? 0
    const o30 = compileMotionRefToStyleAt(PRESET_FADE_UP, undefined, 30).opacity ?? 0
    expect(o0).toBeLessThan(o15)
    expect(o15).toBeLessThan(o30)
  })

  it('respects delayFrames — is identity-at-start before delay completes', () => {
    const ref: MotionRef = { kind: 'preset', preset: 'fadeInUp', durationFrames: 30, delayFrames: 12 }
    const before = compileMotionRefToStyleAt(ref, undefined, 5)
    expect(before.opacity).toBe(0) // pre-delay = held at first keyframe
  })

  it('returns empty for unknown preset id', () => {
    const ref: MotionRef = { kind: 'preset', preset: 'noSuchPreset' }
    expect(compileMotionRefToStyleAt(ref, undefined, 0)).toEqual({})
  })

  it('handles a custom motion ref', () => {
    const ref: MotionRef = {
      kind: 'custom',
      keyframes: [
        { at: 0, opacity: 0, tx: 100 },
        { at: 1, opacity: 1, tx: 0 },
      ],
      durationFrames: 20,
    }
    const start = compileMotionRefToStyleAt(ref, undefined, 0)
    const end = compileMotionRefToStyleAt(ref, undefined, 20)
    expect(start.opacity).toBe(0)
    expect(start.transform).toContain('translate(100px')
    expect(end.opacity).toBe(1)
    expect(end.transform).toContain('translate(0px')
  })

  it('handles a spring ref', () => {
    const ref: MotionRef = {
      kind: 'spring',
      from: { x: 0, opacity: 0 },
      to: { x: 100, opacity: 1 },
      spring: 'gentle',
    }
    const start = compileMotionRefToStyleAt(ref, undefined, 0)
    const past = compileMotionRefToStyleAt(ref, undefined, 100)
    expect(start.opacity).toBe(0)
    expect(past.opacity).toBe(1)
  })

  it('passes through opacity-only changes without emitting transform', () => {
    const ref: MotionRef = { kind: 'preset', preset: 'fadeIn', durationFrames: 30 }
    const style = compileMotionRefToStyleAt(ref, undefined, 0)
    expect(style.opacity).toBe(0)
    expect(style.transform).toBeUndefined() // no transform fields in fadeIn
  })

  it('emits transform for translation-only changes without opacity', () => {
    const ref: MotionRef = { kind: 'preset', preset: 'slideInLeft', durationFrames: 30 }
    const style = compileMotionRefToStyleAt(ref, undefined, 0)
    expect(style.opacity).toBeUndefined()
    expect(style.transform).toContain('translate')
  })
})

describe('emitReactMotionHelper', () => {
  it('emits a function definition', () => {
    const out = emitReactMotionHelper(PRESET_FADE_UP)
    expect(out).toContain('function motionStyle(frame)')
  })

  it('honors the helperName option', () => {
    const out = emitReactMotionHelper(PRESET_FADE_UP, undefined, { helperName: 'fadeStyle' })
    expect(out).toContain('function fadeStyle(frame)')
    expect(out).not.toContain('function motionStyle(frame)')
  })

  it('returns a no-op helper for unknown preset', () => {
    const ref: MotionRef = { kind: 'preset', preset: 'noSuchPreset' }
    const out = emitReactMotionHelper(ref)
    expect(out).toContain('return {}')
  })

  it('emitted helper inlines the resolved keyframes', () => {
    // Verifies the JSON.stringify path compiles per-MotionRef constants
    // into the helper body, so the runtime doesn't need to look up the
    // catalog.
    const out = emitReactMotionHelper(PRESET_FADE_UP, undefined, { helperName: 'fn' })
    expect(out).toMatch(/const KF = \[/)
    // fadeInUp's first keyframe is opacity:0, ty:60.
    expect(out).toContain('"opacity":0')
    expect(out).toContain('"ty":60')
  })

  it('emitted helper carries the resolved START/END so delay folds in', () => {
    const ref: MotionRef = { kind: 'preset', preset: 'fadeInUp', durationFrames: 30, delayFrames: 12 }
    const out = emitReactMotionHelper(ref, undefined, { helperName: 'fn' })
    expect(out).toContain('const START = 12')
    expect(out).toContain('const END = 42')
  })
})
