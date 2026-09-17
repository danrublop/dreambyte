// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { Action, ProjectState } from '../types'
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

/** Build a state with tracks T (and optionally T2), of the given type. */
function stateWithTracks(type: 'video' | 'audio' = 'video', second = false): ProjectState {
  const scene = createDefaultScene()
  let state: ProjectState = {
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
  state = dispatchSync(state, { type: 'track/add', params: { trackId: 'T', type } }, { source: 'user' }).result.state!
  if (second) {
    state = dispatchSync(state, { type: 'track/add', params: { trackId: 'T2', type } }, { source: 'user' }).result.state!
  }
  return state
}

function addClip(state: ProjectState, trackId: string, clip: Clip): ProjectState {
  return dispatchSync(state, { type: 'clip/add', params: { trackId, clipId: clip.id, clip } }, { source: 'user' })
    .result.state!
}

function clipById(state: ProjectState, id: string): Clip | undefined {
  for (const t of state.project.timeline!.tracks) {
    const c = t.clips.find((x) => x.id === id)
    if (c) return c
  }
  return undefined
}

describe('clip/batchMove', () => {
  it('moves multiple clips on the same track atomically', () => {
    let state = stateWithTracks('video')
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 10, 5))
    const { result } = dispatchSync(
      state,
      { type: 'clip/batchMove', params: { moves: [{ clipId: 'a', startTime: 100 }, { clipId: 'b', startTime: 200 }] } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'a')!.startTime).toBe(100)
    expect(clipById(result.state!, 'b')!.startTime).toBe(200)
  })

  it('all-or-nothing: one overlapping move refuses the WHOLE batch (no half-apply)', () => {
    let state = stateWithTracks('video')
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 10, 5))
    state = addClip(state, 'T', makeClip('c', 20, 5))
    // Move a into b's lane (a→[11,16] overlaps b[10,15]); c→30 is fine on its own.
    const { result } = dispatchSync(
      state,
      { type: 'clip/batchMove', params: { moves: [{ clipId: 'a', startTime: 11 }, { clipId: 'c', startTime: 30 }] } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OVERLAP_DETECTED')
    // Original state untouched — neither a nor c moved.
    expect(clipById(state, 'a')!.startTime).toBe(0)
    expect(clipById(state, 'c')!.startTime).toBe(20)
  })

  it('validates against the FINAL state — a swap that stays disjoint succeeds', () => {
    let state = stateWithTracks('video')
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 10, 5))
    // Swap positions: a→10, b→0. Final [a:10-15, b:0-5] is disjoint.
    const { result } = dispatchSync(
      state,
      { type: 'clip/batchMove', params: { moves: [{ clipId: 'a', startTime: 10 }, { clipId: 'b', startTime: 0 }] } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'a')!.startTime).toBe(10)
    expect(clipById(result.state!, 'b')!.startTime).toBe(0)
  })

  it('rejects moved-vs-moved collisions (two clips nudged into each other)', () => {
    let state = stateWithTracks('video')
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 10, 5))
    const { result } = dispatchSync(
      state,
      { type: 'clip/batchMove', params: { moves: [{ clipId: 'a', startTime: 20 }, { clipId: 'b', startTime: 22 }] } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OVERLAP_DETECTED')
  })

  it('moves clips across tracks', () => {
    let state = stateWithTracks('video', true)
    state = addClip(state, 'T', makeClip('a', 0, 5))
    const { result } = dispatchSync(
      state,
      { type: 'clip/batchMove', params: { moves: [{ clipId: 'a', startTime: 3, newTrackId: 'T2' }] } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const t1 = result.state!.project.timeline!.tracks.find((t) => t.id === 'T')!
    const t2 = result.state!.project.timeline!.tracks.find((t) => t.id === 'T2')!
    expect(t1.clips.length).toBe(0)
    expect(t2.clips.map((c) => c.id)).toContain('a')
    expect(clipById(result.state!, 'a')!.startTime).toBe(3)
  })

  it('allows overlap on audio tracks (TRACK_OVERLAP_RULES = allow)', () => {
    let state = stateWithTracks('audio')
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 10, 5))
    const { result } = dispatchSync(
      state,
      { type: 'clip/batchMove', params: { moves: [{ clipId: 'a', startTime: 11 }] } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'a')!.startTime).toBe(11)
  })

  it('the single inverse restores every prior position in one undo', () => {
    let state = stateWithTracks('video', true)
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 10, 5))
    const fwd = dispatchSync(
      state,
      {
        type: 'clip/batchMove',
        params: { moves: [{ clipId: 'a', startTime: 100, newTrackId: 'T2' }, { clipId: 'b', startTime: 200 }] },
      },
      { source: 'user' },
    )
    expect(fwd.result.success).toBe(true)
    const inverse = fwd.result.inverseAction as Action
    expect(inverse.type).toBe('clip/batchMove')
    const undone = dispatchSync(fwd.result.state!, inverse, { source: 'replay' })
    expect(undone.result.success).toBe(true)
    const a = clipById(undone.result.state!, 'a')!
    const b = clipById(undone.result.state!, 'b')!
    expect(a.startTime).toBe(0)
    expect(a.trackId).toBe('T') // moved back to original track
    expect(b.startTime).toBe(10)
  })

  it('rejects a locked source track and duplicate ids', () => {
    let state = stateWithTracks('video')
    state = addClip(state, 'T', makeClip('a', 0, 5))
    const dup = dispatchSync(
      state,
      { type: 'clip/batchMove', params: { moves: [{ clipId: 'a', startTime: 1 }, { clipId: 'a', startTime: 2 }] } },
      { source: 'user' },
    )
    expect(dup.result.success).toBe(false)
    expect(dup.result.error?.code).toBe('INVALID_PARAMS')

    state.project.timeline!.tracks[0].locked = true
    const locked = dispatchSync(
      state,
      { type: 'clip/batchMove', params: { moves: [{ clipId: 'a', startTime: 50 }] } },
      { source: 'user' },
    )
    expect(locked.result.success).toBe(false)
    expect(locked.result.error?.code).toBe('TRACK_LOCKED')
  })

  it('rejects an empty batch', () => {
    const state = stateWithTracks('video')
    const { result } = dispatchSync(state, { type: 'clip/batchMove', params: { moves: [] } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })
})
