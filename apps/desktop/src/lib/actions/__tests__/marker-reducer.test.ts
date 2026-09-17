// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function baseState(): ProjectState {
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

describe('marker reducers (G3)', () => {
  it('marker/add places the marker and its inverse removes it', () => {
    const { result } = dispatchSync(
      baseState(),
      { type: 'marker/add', params: { markerId: 'M1', time: 3.25, label: 'Hook', color: '#ff0000' } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const markers = result.state!.project.timeline?.markers ?? []
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ id: 'M1', time: 3.25, label: 'Hook' })
    expect(result.inverseAction).toMatchObject({ type: 'marker/remove', params: { markerId: 'M1' } })
  })

  it('marker/remove deletes and its inverse restores the marker verbatim', () => {
    const added = dispatchSync(
      baseState(),
      { type: 'marker/add', params: { markerId: 'M1', time: 2, label: 'Beat' } },
      { source: 'user' },
    ).result.state!
    const { result } = dispatchSync(added, { type: 'marker/remove', params: { markerId: 'M1' } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline?.markers ?? []).toHaveLength(0)
    expect(result.inverseAction).toMatchObject({
      type: 'marker/add',
      params: { markerId: 'M1', time: 2, label: 'Beat' },
    })
  })

  it('rejects duplicate ids, invalid times, and unknown removals', () => {
    const added = dispatchSync(
      baseState(),
      { type: 'marker/add', params: { markerId: 'M1', time: 1 } },
      { source: 'user' },
    ).result.state!
    expect(
      dispatchSync(added, { type: 'marker/add', params: { markerId: 'M1', time: 2 } }, { source: 'user' }).result
        .success,
    ).toBe(false)
    expect(
      dispatchSync(baseState(), { type: 'marker/add', params: { markerId: 'M2', time: -1 } }, { source: 'user' })
        .result.success,
    ).toBe(false)
    expect(
      dispatchSync(baseState(), { type: 'marker/remove', params: { markerId: 'ghost' } }, { source: 'user' }).result
        .success,
    ).toBe(false)
  })
})
