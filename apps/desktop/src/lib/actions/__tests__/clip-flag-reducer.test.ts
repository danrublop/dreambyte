// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import type { Clip } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function makeClip(id: string, startTime: number, duration: number): Clip {
  return {
    id,
    trackId: '',
    sourceType: 'scene',
    sourceId: 's',
    label: id,
    startTime,
    duration,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
  }
}

function stateWithClip(): ProjectState {
  const scene = createDefaultScene()
  const state: ProjectState = {
    scenes: [scene],
    globalStyle: {
      presetId: null,
      palette: ['#000', '#111', '#222', '#333'],
      duration: 8,
    } as unknown as ProjectState['globalStyle'],
    project: createDefaultProject([scene]),
    selectedSceneId: scene.id,
    uiEditingLayerId: null,
  }
  let s = state
  s = dispatchSync(s, { type: 'track/add', params: { trackId: 'T', type: 'video' } }, { source: 'user' }).result.state!
  s = dispatchSync(
    s,
    { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1', 0, 10) } },
    { source: 'user' },
  ).result.state!
  return s
}

describe('clip/setSpeed', () => {
  it('sets speed within [0.25, 4.0] and adjusts duration', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/setSpeed', params: { clipId: 'c1', speed: 2 } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const c = result.state!.project.timeline!.tracks[0].clips[0]
    expect(c.speed).toBe(2)
    // sourceDuration = 10 * 1 = 10; newDuration = 10 / 2 = 5
    expect(c.duration).toBe(5)
  })

  it('rejects speeds outside the range', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/setSpeed', params: { clipId: 'c1', speed: 0.1 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OUT_OF_BOUNDS')
  })

  it('inverse restores prior speed + duration', () => {
    const state = stateWithClip()
    const r1 = dispatchSync(state, { type: 'clip/setSpeed', params: { clipId: 'c1', speed: 2 } }, { source: 'user' })
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    const c = r2.result.state!.project.timeline!.tracks[0].clips[0]
    expect(c.speed).toBe(1)
    expect(c.duration).toBe(10)
  })
})

describe('clip/setBlend', () => {
  it('sets blend mode + optional opacity', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/setBlend', params: { clipId: 'c1', blendMode: 'multiply', blendOpacity: 0.5 } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const c = result.state!.project.timeline!.tracks[0].clips[0]
    expect(c.blendMode).toBe('multiply')
    expect(c.blendOpacity).toBe(0.5)
  })

  it('rejects blendOpacity outside [0, 1]', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/setBlend', params: { clipId: 'c1', blendMode: 'screen', blendOpacity: 1.5 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OUT_OF_BOUNDS')
  })
})

describe('clip/fade', () => {
  it('sets fadeIn and fadeOut within duration', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/fade', params: { clipId: 'c1', fadeIn: 1, fadeOut: 2 } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const c = result.state!.project.timeline!.tracks[0].clips[0]
    expect(c.fadeIn).toBe(1)
    expect(c.fadeOut).toBe(2)
  })

  it('rejects fade values > clip duration', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/fade', params: { clipId: 'c1', fadeIn: 100 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OUT_OF_BOUNDS')
  })

  it('rejects fadeIn + fadeOut > duration', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/fade', params: { clipId: 'c1', fadeIn: 6, fadeOut: 6 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_TIME_RANGE')
  })
})

describe('clip/setColorGrade', () => {
  it('stores the grade on the clip', () => {
    const state = stateWithClip()
    const grade = { exposure: 0.5, wheels: { shadows: { hue: 180, amount: 0.2 } } }
    const { result } = dispatchSync(
      state,
      { type: 'clip/setColorGrade', params: { clipId: 'c1', grade } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].clips[0].grade).toEqual(grade)
  })

  it('inverse restores the prior grade', () => {
    const state = stateWithClip()
    const r1 = dispatchSync(
      state,
      { type: 'clip/setColorGrade', params: { clipId: 'c1', grade: { contrast: 1.3 } } },
      { source: 'user' },
    )
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    // prior grade was undefined → inverse clears to {}
    expect(r2.result.state!.project.timeline!.tracks[0].clips[0].grade).toEqual({})
  })

  it('rejects a missing clip', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/setColorGrade', params: { clipId: 'nope', grade: { exposure: 1 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('CLIP_NOT_FOUND')
  })
})
