// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function emptyState(): ProjectState {
  const scene = createDefaultScene()
  return {
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
}

describe('track reducer', () => {
  it('track/add initialises the timeline if missing and inserts the track', () => {
    const state = emptyState()
    state.project.timeline = null
    const { result } = dispatchSync(
      state,
      { type: 'track/add', params: { trackId: 't1', type: 'video', name: 'V1' } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks.length).toBe(1)
    expect(result.state!.project.timeline!.tracks[0]).toMatchObject({
      id: 't1',
      type: 'video',
      name: 'V1',
      position: 0,
    })
  })

  it('track/add rejects unknown types', () => {
    const state = emptyState()
    const { result } = dispatchSync(
      state,
      // @ts-expect-error — invalid runtime value
      { type: 'track/add', params: { trackId: 't1', type: 'overlay' } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INCOMPATIBLE_TYPE')
  })

  it('track/add rejects duplicate ids', () => {
    let state = emptyState()
    const r1 = dispatchSync(state, { type: 'track/add', params: { trackId: 't1', type: 'video' } }, { source: 'user' })
    state = r1.result.state!
    const { result } = dispatchSync(
      state,
      { type: 'track/add', params: { trackId: 't1', type: 'audio' } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('DUPLICATE_ID')
  })

  it('track/remove deletes the track and re-positions remaining tracks 0..N-1', () => {
    let state = emptyState()
    for (let i = 0; i < 3; i++) {
      const { result } = dispatchSync(
        state,
        { type: 'track/add', params: { trackId: `t${i}`, type: 'video' } },
        { source: 'user' },
      )
      state = result.state!
    }
    const { result: removed } = dispatchSync(
      state,
      { type: 'track/remove', params: { trackId: 't1' } },
      { source: 'user' },
    )
    expect(removed.success).toBe(true)
    expect(removed.state!.project.timeline!.tracks.map((t) => t.id)).toEqual(['t0', 't2'])
    expect(removed.state!.project.timeline!.tracks.map((t) => t.position)).toEqual([0, 1])
  })

  it('track/add → inverse track/remove restores the track', () => {
    const state = emptyState()
    const { result: added } = dispatchSync(
      state,
      { type: 'track/add', params: { trackId: 't1', type: 'graphics', name: 'GFX' } },
      { source: 'user' },
    )
    expect(added.success).toBe(true)
    const { result: undone } = dispatchSync(added.state!, added.inverseAction!, { source: 'replay' })
    expect(undone.success).toBe(true)
    expect(undone.state!.project.timeline?.tracks.length ?? 0).toBe(0)
  })
})
