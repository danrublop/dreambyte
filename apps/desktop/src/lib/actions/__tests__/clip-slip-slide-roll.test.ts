// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { Action, ProjectState } from '../types'
import type { Clip } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function makeClip(
  id: string,
  startTime: number,
  duration: number,
  opts: { trimStart?: number; trimEnd?: number | null; speed?: number; linkGroupId?: string } = {},
): Clip {
  return {
    id,
    trackId: '',
    sourceType: 'scene',
    sourceId: 's',
    label: id,
    startTime,
    duration,
    trimStart: opts.trimStart ?? 0,
    trimEnd: opts.trimEnd ?? null,
    speed: opts.speed ?? 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...(opts.linkGroupId ? { linkGroupId: opts.linkGroupId } : {}),
  }
}

function stateWithTracks(specs: Array<{ id: string; type: 'video' | 'audio' }>): ProjectState {
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
  for (const s of specs) {
    state = dispatchSync(state, { type: 'track/add', params: { trackId: s.id, type: s.type } }, { source: 'user' })
      .result.state!
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

describe('clip/roll', () => {
  function twoClips(): ProjectState {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 5, 5))
    return state
  }

  it("rolls the boundary later via the left clip's right edge", () => {
    const { result } = dispatchSync(twoClips(), { type: 'clip/roll', params: { clipId: 'a', edge: 'right', delta: 2 } }, { source: 'user' })
    expect(result.success).toBe(true)
    const a = clipById(result.state!, 'a')!
    const b = clipById(result.state!, 'b')!
    expect(a.duration).toBe(7)
    expect(a.trimEnd).toBe(7) // trimStart 0 + 7 * speed 1
    expect(b.startTime).toBe(7)
    expect(b.duration).toBe(3)
    expect(b.trimStart).toBe(2)
    // Total sequence length unchanged (a + b butt-jointed = 10).
    expect(a.duration + b.duration).toBe(10)
  })

  it("rolls identically via the right clip's left edge", () => {
    const { result } = dispatchSync(twoClips(), { type: 'clip/roll', params: { clipId: 'b', edge: 'left', delta: 2 } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'a')!.duration).toBe(7)
    expect(clipById(result.state!, 'b')!.startTime).toBe(7)
  })

  it('rejects a roll that collapses a clip below the minimum', () => {
    const { result } = dispatchSync(twoClips(), { type: 'clip/roll', params: { clipId: 'a', edge: 'right', delta: 5 } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_TIME_RANGE')
  })

  it('rejects when there is no adjacent clip', () => {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('lonely', 0, 5))
    const { result } = dispatchSync(state, { type: 'clip/roll', params: { clipId: 'lonely', edge: 'right', delta: 1 } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })

  it('inverse restores both clips in one undo', () => {
    const fwd = dispatchSync(twoClips(), { type: 'clip/roll', params: { clipId: 'a', edge: 'right', delta: 2 } }, { source: 'user' })
    const inverse = fwd.result.inverseAction as Action
    expect(inverse.type).toBe('clip/batchEdit')
    const undone = dispatchSync(fwd.result.state!, inverse, { source: 'replay' })
    expect(undone.result.success).toBe(true)
    expect(clipById(undone.result.state!, 'a')!.duration).toBe(5)
    expect(clipById(undone.result.state!, 'b')!.startTime).toBe(5)
    expect(clipById(undone.result.state!, 'b')!.duration).toBe(5)
  })
})

describe('clip/slide', () => {
  function threeClips(): ProjectState {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('m', 5, 5))
    state = addClip(state, 'T', makeClip('n', 10, 5))
    return state
  }

  it('shifts the clip and trims both neighbors to stay gapless', () => {
    const { result } = dispatchSync(threeClips(), { type: 'clip/slide', params: { clipId: 'm', delta: 2 } }, { source: 'user' })
    expect(result.success).toBe(true)
    const a = clipById(result.state!, 'a')!
    const m = clipById(result.state!, 'm')!
    const n = clipById(result.state!, 'n')!
    expect(a.duration).toBe(7) // prev tail extends to butt m's new start
    expect(m.startTime).toBe(7) // m slid by +2, content unchanged
    expect(m.duration).toBe(5)
    expect(n.startTime).toBe(12)
    expect(n.duration).toBe(3)
    expect(n.trimStart).toBe(2)
    // Still gapless and same total length (15).
    expect(a.duration + m.duration + n.duration).toBe(15)
  })

  it('rejects a slide that would collapse the next clip', () => {
    const { result } = dispatchSync(threeClips(), { type: 'clip/slide', params: { clipId: 'm', delta: 5 } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_TIME_RANGE')
  })

  it('slides a clip with no neighbors as a plain move', () => {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('solo', 0, 5))
    const { result } = dispatchSync(state, { type: 'clip/slide', params: { clipId: 'solo', delta: 3 } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'solo')!.startTime).toBe(3)
  })

  it('inverse restores all three clips', () => {
    const fwd = dispatchSync(threeClips(), { type: 'clip/slide', params: { clipId: 'm', delta: 2 } }, { source: 'user' })
    const undone = dispatchSync(fwd.result.state!, fwd.result.inverseAction as Action, { source: 'replay' })
    expect(undone.result.success).toBe(true)
    expect(clipById(undone.result.state!, 'a')!.duration).toBe(5)
    expect(clipById(undone.result.state!, 'm')!.startTime).toBe(5)
    expect(clipById(undone.result.state!, 'n')!.startTime).toBe(10)
  })
})

describe('clip/slip', () => {
  it('shifts the source window, keeping position + duration fixed', () => {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('a', 0, 5, { trimStart: 2, trimEnd: 7 }))
    const { result } = dispatchSync(state, { type: 'clip/slip', params: { clipId: 'a', sourceDelta: 1 } }, { source: 'user' })
    expect(result.success).toBe(true)
    const a = clipById(result.state!, 'a')!
    expect(a.trimStart).toBe(3)
    expect(a.trimEnd).toBe(8)
    expect(a.startTime).toBe(0) // unchanged
    expect(a.duration).toBe(5) // unchanged
  })

  it('clamps trimStart at 0 when slipping past the source head', () => {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('a', 0, 5, { trimStart: 1, trimEnd: 6 }))
    const { result } = dispatchSync(state, { type: 'clip/slip', params: { clipId: 'a', sourceDelta: -5 } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'a')!.trimStart).toBe(0)
  })

  it('linked: slips every clip in the link group together', () => {
    let state = stateWithTracks([{ id: 'V', type: 'video' }, { id: 'A', type: 'audio' }])
    state = addClip(state, 'V', makeClip('vid', 0, 5, { trimStart: 2, trimEnd: 7, linkGroupId: 'g' }))
    state = addClip(state, 'A', makeClip('aud', 0, 5, { trimStart: 2, trimEnd: 7, linkGroupId: 'g' }))
    const { result } = dispatchSync(state, { type: 'clip/slip', params: { clipId: 'vid', sourceDelta: 1, linked: true } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'vid')!.trimStart).toBe(3)
    expect(clipById(result.state!, 'aud')!.trimStart).toBe(3) // linked sibling slipped too
  })

  it('without linked, only the targeted clip slips', () => {
    let state = stateWithTracks([{ id: 'V', type: 'video' }, { id: 'A', type: 'audio' }])
    state = addClip(state, 'V', makeClip('vid', 0, 5, { trimStart: 2, trimEnd: 7, linkGroupId: 'g' }))
    state = addClip(state, 'A', makeClip('aud', 0, 5, { trimStart: 2, trimEnd: 7, linkGroupId: 'g' }))
    const { result } = dispatchSync(state, { type: 'clip/slip', params: { clipId: 'vid', sourceDelta: 1 } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'vid')!.trimStart).toBe(3)
    expect(clipById(result.state!, 'aud')!.trimStart).toBe(2) // untouched
  })

  it('inverse restores the source window', () => {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('a', 0, 5, { trimStart: 2, trimEnd: 7 }))
    const fwd = dispatchSync(state, { type: 'clip/slip', params: { clipId: 'a', sourceDelta: 1 } }, { source: 'user' })
    const undone = dispatchSync(fwd.result.state!, fwd.result.inverseAction as Action, { source: 'replay' })
    expect(undone.result.success).toBe(true)
    expect(clipById(undone.result.state!, 'a')!.trimStart).toBe(2)
    expect(clipById(undone.result.state!, 'a')!.trimEnd).toBe(7)
  })
})

describe('clip/batchEdit', () => {
  it('applies in-place patches to multiple clips atomically', () => {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 10, 5))
    const { result } = dispatchSync(
      state,
      { type: 'clip/batchEdit', params: { edits: [{ clipId: 'a', duration: 3 }, { clipId: 'b', startTime: 20 }] } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(clipById(result.state!, 'a')!.duration).toBe(3)
    expect(clipById(result.state!, 'b')!.startTime).toBe(20)
  })

  it('refuses the whole batch when an edit overlaps on a reject track', () => {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('a', 0, 5))
    state = addClip(state, 'T', makeClip('b', 10, 5))
    // Grow a to [0,12] — overlaps b[10,15].
    const { result } = dispatchSync(state, { type: 'clip/batchEdit', params: { edits: [{ clipId: 'a', duration: 12 }] } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OVERLAP_DETECTED')
    expect(clipById(state, 'a')!.duration).toBe(5) // unchanged
  })

  it('rejects an invalid duration', () => {
    let state = stateWithTracks([{ id: 'T', type: 'video' }])
    state = addClip(state, 'T', makeClip('a', 0, 5))
    const { result } = dispatchSync(state, { type: 'clip/batchEdit', params: { edits: [{ clipId: 'a', duration: 0 }] } }, { source: 'user' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_TIME_RANGE')
  })
})
