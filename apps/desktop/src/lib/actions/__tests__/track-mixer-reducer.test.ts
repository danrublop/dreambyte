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
  const r = dispatchSync(state, { type: 'track/add', params: { trackId: 'T', type: 'audio' } }, { source: 'user' })
  return r.result.state!
}

describe('track/setVolume', () => {
  it('sets the linear gain and inverse restores unity', () => {
    const state = stateWithTrack()
    const { result } = dispatchSync(state, { type: 'track/setVolume', params: { trackId: 'T', volume: 1.5 } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].volume).toBe(1.5)

    const { result: undone } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect(undone.success).toBe(true)
    // Prior was unset → restores to unity (1).
    expect(undone.state!.project.timeline!.tracks[0].volume).toBe(1)
  })

  it('clamps above +6 dB and below 0', () => {
    const state = stateWithTrack()
    const hi = dispatchSync(state, { type: 'track/setVolume', params: { trackId: 'T', volume: 99 } }, { source: 'user' })
    expect(hi.result.state!.project.timeline!.tracks[0].volume).toBe(2)
    const lo = dispatchSync(state, { type: 'track/setVolume', params: { trackId: 'T', volume: -5 } }, { source: 'user' })
    expect(lo.result.state!.project.timeline!.tracks[0].volume).toBe(0)
  })

  it('rejects on a locked track', () => {
    let state = stateWithTrack()
    state = dispatchSync(state, { type: 'track/lock', params: { trackId: 'T', locked: true } }, { source: 'user' }).result.state!
    const { result } = dispatchSync(state, { type: 'track/setVolume', params: { trackId: 'T', volume: 0.5 } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TRACK_LOCKED')
  })

  it('rejects when the track does not exist', () => {
    const state = stateWithTrack()
    const { result } = dispatchSync(state, { type: 'track/setVolume', params: { trackId: 'nope', volume: 1 } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TRACK_NOT_FOUND')
  })
})

describe('track/setPan', () => {
  it('sets pan and inverse restores center', () => {
    const state = stateWithTrack()
    const { result } = dispatchSync(state, { type: 'track/setPan', params: { trackId: 'T', pan: -0.7 } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].pan).toBeCloseTo(-0.7, 10)

    const { result: undone } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect(undone.state!.project.timeline!.tracks[0].pan).toBe(0)
  })

  it('clamps to [-1, 1]', () => {
    const state = stateWithTrack()
    const r = dispatchSync(state, { type: 'track/setPan', params: { trackId: 'T', pan: 5 } }, { source: 'user' })
    expect(r.result.state!.project.timeline!.tracks[0].pan).toBe(1)
    const l = dispatchSync(state, { type: 'track/setPan', params: { trackId: 'T', pan: -5 } }, { source: 'user' })
    expect(l.result.state!.project.timeline!.tracks[0].pan).toBe(-1)
  })

  it('rejects on a locked track', () => {
    let state = stateWithTrack()
    state = dispatchSync(state, { type: 'track/lock', params: { trackId: 'T', locked: true } }, { source: 'user' }).result.state!
    const { result } = dispatchSync(state, { type: 'track/setPan', params: { trackId: 'T', pan: 0.3 } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TRACK_LOCKED')
  })
})

describe('audio/setMasterVolume', () => {
  it('sets program master and inverse restores unity', () => {
    const state = stateWithTrack()
    const { result } = dispatchSync(state, { type: 'audio/setMasterVolume', params: { volume: 0.5 } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(result.state!.project.audioSettings.masterVolume).toBe(0.5)

    const { result: undone } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect(undone.state!.project.audioSettings.masterVolume).toBe(1)
  })

  it('clamps to [0, 2]', () => {
    const state = stateWithTrack()
    expect(
      dispatchSync(state, { type: 'audio/setMasterVolume', params: { volume: 99 } }, { source: 'user' }).result.state!
        .project.audioSettings.masterVolume,
    ).toBe(2)
    expect(
      dispatchSync(state, { type: 'audio/setMasterVolume', params: { volume: -3 } }, { source: 'user' }).result.state!
        .project.audioSettings.masterVolume,
    ).toBe(0)
  })

  it('preserves other audioSettings (surgical merge)', () => {
    const state = stateWithTrack()
    const before = state.project.audioSettings.defaultTTSProvider
    const { result } = dispatchSync(state, { type: 'audio/setMasterVolume', params: { volume: 1.3 } }, { source: 'user' })
    expect(result.state!.project.audioSettings.defaultTTSProvider).toBe(before)
    expect(result.state!.project.audioSettings.masterVolume).toBeCloseTo(1.3, 10)
  })
})
