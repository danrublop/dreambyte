// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import type { Clip } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function makeClip(id: string): Clip {
  return {
    id,
    trackId: '',
    sourceType: 'scene',
    sourceId: 's',
    label: id,
    startTime: 0,
    duration: 10,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 0.7,
    position: { x: 5, y: 10 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
  }
}

function stateWithClip(): ProjectState {
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
    { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1') } },
    { source: 'user' },
  ).result.state!
  return s
}

describe('clip/setTransform', () => {
  it('patches position partially (only the supplied axis)', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/setTransform', params: { clipId: 'c1', position: { x: 99 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const c = result.state!.project.timeline!.tracks[0].clips[0]
    expect(c.position).toEqual({ x: 99, y: 10 })
  })

  it('patches multiple fields in one dispatch', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      {
        type: 'clip/setTransform',
        params: { clipId: 'c1', position: { x: 1, y: 2 }, scale: { x: 2 }, rotation: 45, opacity: 0.5 },
      },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const c = result.state!.project.timeline!.tracks[0].clips[0]
    expect(c.position).toEqual({ x: 1, y: 2 })
    expect(c.scale).toEqual({ x: 2, y: 1 })
    expect(c.rotation).toBe(45)
    expect(c.opacity).toBe(0.5)
  })

  it('rejects opacity outside [0, 1]', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/setTransform', params: { clipId: 'c1', opacity: 1.5 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OUT_OF_BOUNDS')
  })

  it('rejects non-finite rotation', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/setTransform', params: { clipId: 'c1', rotation: Number.POSITIVE_INFINITY } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })

  it('rejects when track is locked', () => {
    const state = stateWithClip()
    state.project.timeline!.tracks[0].locked = true
    const { result } = dispatchSync(
      state,
      { type: 'clip/setTransform', params: { clipId: 'c1', rotation: 10 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TRACK_LOCKED')
  })

  it('inverse restores all prior values byte-equal', () => {
    const state = stateWithClip()
    const r1 = dispatchSync(
      state,
      {
        type: 'clip/setTransform',
        params: { clipId: 'c1', position: { x: 99, y: 99 }, scale: { x: 3, y: 3 }, rotation: 180, opacity: 0.1 },
      },
      { source: 'user' },
    )
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    const c = r2.result.state!.project.timeline!.tracks[0].clips[0]
    expect(c.position).toEqual({ x: 5, y: 10 })
    expect(c.scale).toEqual({ x: 1, y: 1 })
    expect(c.rotation).toBe(0)
    expect(c.opacity).toBe(0.7)
  })
})
