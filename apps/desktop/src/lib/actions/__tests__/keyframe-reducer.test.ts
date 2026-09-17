// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import type { Clip, Keyframe } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function makeClip(id: string, duration = 10, keyframes: Keyframe[] = []): Clip {
  return {
    id,
    trackId: '',
    sourceType: 'scene',
    sourceId: 's',
    label: id,
    startTime: 0,
    duration,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes,
  }
}

function stateWithClip(keyframes: Keyframe[] = []): ProjectState {
  const scene = createDefaultScene()
  let s: ProjectState = {
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
  s = dispatchSync(s, { type: 'track/add', params: { trackId: 'T', type: 'video' } }, { source: 'user' }).result.state!
  s = dispatchSync(
    s,
    { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1', 10, keyframes) } },
    { source: 'user' },
  ).result.state!
  return s
}

const kf = (time: number, property: Keyframe['property'], value: number): Keyframe => ({
  time,
  property,
  value,
  easing: 'linear',
})

describe('keyframe/add', () => {
  it('adds a keyframe and keeps the array sorted by time', () => {
    let state = stateWithClip()
    state = dispatchSync(
      state,
      { type: 'keyframe/add', params: { clipId: 'c1', keyframe: kf(5, 'opacity', 0.5) } },
      { source: 'user' },
    ).result.state!
    state = dispatchSync(
      state,
      { type: 'keyframe/add', params: { clipId: 'c1', keyframe: kf(1, 'opacity', 0.1) } },
      { source: 'user' },
    ).result.state!
    const times = state.project.timeline!.tracks[0].clips[0].keyframes.map((k) => k.time)
    expect(times).toEqual([1, 5])
  })

  it('rejects a keyframe at the same (property, time)', () => {
    let state = stateWithClip()
    state = dispatchSync(
      state,
      { type: 'keyframe/add', params: { clipId: 'c1', keyframe: kf(3, 'opacity', 0.5) } },
      { source: 'user' },
    ).result.state!
    const { result } = dispatchSync(
      state,
      { type: 'keyframe/add', params: { clipId: 'c1', keyframe: kf(3, 'opacity', 1) } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('KEYFRAME_CONFLICT')
  })

  it('inverse removes the added keyframe', () => {
    const state = stateWithClip()
    const r1 = dispatchSync(
      state,
      { type: 'keyframe/add', params: { clipId: 'c1', keyframe: kf(2, 'x', 100) } },
      { source: 'user' },
    )
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.project.timeline!.tracks[0].clips[0].keyframes.length).toBe(0)
  })
})

describe('keyframe/update', () => {
  it('updates value of an existing keyframe', () => {
    const state = stateWithClip([kf(2, 'opacity', 0.5)])
    const { result } = dispatchSync(
      state,
      { type: 'keyframe/update', params: { clipId: 'c1', property: 'opacity', time: 2, patch: { value: 0.9 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].clips[0].keyframes[0].value).toBe(0.9)
  })

  it('rejects when no keyframe exists at (property, time)', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'keyframe/update', params: { clipId: 'c1', property: 'opacity', time: 5, patch: { value: 1 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })

  it('rejects when patch.time would collide with another keyframe', () => {
    const state = stateWithClip([kf(2, 'opacity', 0.5), kf(5, 'opacity', 1)])
    const { result } = dispatchSync(
      state,
      { type: 'keyframe/update', params: { clipId: 'c1', property: 'opacity', time: 2, patch: { time: 5 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('KEYFRAME_CONFLICT')
  })
})

describe('keyframe/remove', () => {
  it('removes a keyframe and inverse re-adds it', () => {
    const state = stateWithClip([kf(2, 'opacity', 0.5)])
    const r1 = dispatchSync(
      state,
      { type: 'keyframe/remove', params: { clipId: 'c1', property: 'opacity', time: 2 } },
      { source: 'user' },
    )
    expect(r1.result.state!.project.timeline!.tracks[0].clips[0].keyframes.length).toBe(0)
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.project.timeline!.tracks[0].clips[0].keyframes.length).toBe(1)
  })
})
