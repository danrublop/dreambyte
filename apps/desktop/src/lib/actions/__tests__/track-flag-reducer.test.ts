// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function stateWithTrack(): ProjectState {
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
  const r = dispatchSync(state, { type: 'track/add', params: { trackId: 'T', type: 'video' } }, { source: 'user' })
  return r.result.state!
}

describe('track flag reducers', () => {
  it.each([
    ['track/lock', 'locked'],
    ['track/mute', 'muted'],
    ['track/solo', 'solo'],
    ['track/hide', 'hidden'],
  ] as const)('%s toggles %s and inverse restores it', (actionType, field) => {
    const state = stateWithTrack()
    const params = { trackId: 'T', [field]: true } as Record<string, unknown>
    const { result } = dispatchSync(
      state,
      { type: actionType, params } as unknown as Parameters<typeof dispatchSync>[1],
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0][field as 'locked']).toBe(true)

    const { result: undone } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect(undone.success).toBe(true)
    // After undo, the field returns to the original (false for locked/muted/solo/hidden defaults).
    expect(undone.state!.project.timeline!.tracks[0][field as 'locked'] ?? false).toBe(false)
  })

  it.each(['track/lock', 'track/mute', 'track/solo', 'track/hide'] as const)(
    '%s rejects when track does not exist',
    (actionType) => {
      const state = stateWithTrack()
      const { result } = dispatchSync(
        state,
        {
          type: actionType,
          params: { trackId: 'does-not-exist', locked: true, muted: true, solo: true, hidden: true },
        } as unknown as Parameters<typeof dispatchSync>[1],
        { source: 'user' },
      )
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('TRACK_NOT_FOUND')
    },
  )
})
