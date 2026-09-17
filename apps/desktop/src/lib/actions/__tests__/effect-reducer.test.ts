// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import type { Clip, ClipFilter } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function makeClip(id: string, filters: ClipFilter[] = []): Clip {
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
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters,
    keyframes: [],
  }
}

function stateWithClip(filters: ClipFilter[] = []): ProjectState {
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
    { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1', filters) } },
    { source: 'user' },
  ).result.state!
  return s
}

describe('effect/add', () => {
  it('attaches a filter to the clip', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'effect/add', params: { clipId: 'c1', filter: { type: 'blur', value: 4 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].clips[0].filters).toEqual([{ type: 'blur', value: 4 }])
  })

  it('rejects duplicate filter types on the same clip', () => {
    const state = stateWithClip([{ type: 'blur', value: 4 }])
    const { result } = dispatchSync(
      state,
      { type: 'effect/add', params: { clipId: 'c1', filter: { type: 'blur', value: 8 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('DUPLICATE_ID')
  })

  it('rejects unknown filter types', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      // @ts-expect-error — invalid runtime value
      { type: 'effect/add', params: { clipId: 'c1', filter: { type: 'glitch', value: 1 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })
})

describe('effect/update', () => {
  it('updates a filter value and inverse restores it', () => {
    const state = stateWithClip([{ type: 'brightness', value: 0.8 }])
    const r1 = dispatchSync(
      state,
      { type: 'effect/update', params: { clipId: 'c1', filterType: 'brightness', value: 1.2 } },
      { source: 'user' },
    )
    expect(r1.result.state!.project.timeline!.tracks[0].clips[0].filters[0].value).toBe(1.2)
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.project.timeline!.tracks[0].clips[0].filters[0].value).toBe(0.8)
  })

  it('rejects when filter not present', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'effect/update', params: { clipId: 'c1', filterType: 'blur', value: 1 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })
})

describe('effect/remove', () => {
  it('detaches the filter; inverse re-adds it', () => {
    const state = stateWithClip([{ type: 'saturate', value: 1.5 }])
    const r1 = dispatchSync(
      state,
      { type: 'effect/remove', params: { clipId: 'c1', filterType: 'saturate' } },
      { source: 'user' },
    )
    expect(r1.result.state!.project.timeline!.tracks[0].clips[0].filters.length).toBe(0)
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.project.timeline!.tracks[0].clips[0].filters).toEqual([{ type: 'saturate', value: 1.5 }])
  })
})

describe('effect/setGradeFilters', () => {
  it('replaces the managed set in one action, preserving blur; inverse restores prior', () => {
    const state = stateWithClip([
      { type: 'blur', value: 2 },
      { type: 'sepia', value: 0.18 },
      { type: 'saturate', value: 1.1 },
    ])
    const r1 = dispatchSync(
      state,
      {
        type: 'effect/setGradeFilters',
        params: {
          clipId: 'c1',
          gradeFilters: [
            { type: 'grayscale', value: 1 },
            { type: 'contrast', value: 1.15 },
          ],
        },
      },
      { source: 'user' },
    )
    expect(r1.result.success).toBe(true)
    const filters = r1.result.state!.project.timeline!.tracks[0].clips[0].filters
    expect(filters).toEqual([
      { type: 'blur', value: 2 },
      { type: 'grayscale', value: 1 },
      { type: 'contrast', value: 1.15 },
    ])
    // Single inverse action restores the full prior managed set
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    const restored = r2.result.state!.project.timeline!.tracks[0].clips[0].filters
    expect(restored).toEqual([
      { type: 'blur', value: 2 },
      { type: 'sepia', value: 0.18 },
      { type: 'saturate', value: 1.1 },
    ])
  })

  it('empty gradeFilters clears the grade (blur survives)', () => {
    const state = stateWithClip([
      { type: 'blur', value: 2 },
      { type: 'sepia', value: 0.18 },
    ])
    const { result } = dispatchSync(
      state,
      { type: 'effect/setGradeFilters', params: { clipId: 'c1', gradeFilters: [] } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].clips[0].filters).toEqual([{ type: 'blur', value: 2 }])
  })

  it('rejects blur in gradeFilters (not grade-managed), duplicates, and non-finite values', () => {
    const state = stateWithClip()
    expect(
      dispatchSync(
        state,
        { type: 'effect/setGradeFilters', params: { clipId: 'c1', gradeFilters: [{ type: 'blur', value: 1 }] } },
        { source: 'user' },
      ).result.success,
    ).toBe(false)
    expect(
      dispatchSync(
        state,
        {
          type: 'effect/setGradeFilters',
          params: {
            clipId: 'c1',
            gradeFilters: [
              { type: 'sepia', value: 0.1 },
              { type: 'sepia', value: 0.2 },
            ],
          },
        },
        { source: 'user' },
      ).result.error?.code,
    ).toBe('DUPLICATE_ID')
    expect(
      dispatchSync(
        state,
        { type: 'effect/setGradeFilters', params: { clipId: 'c1', gradeFilters: [{ type: 'sepia', value: NaN }] } },
        { source: 'user' },
      ).result.success,
    ).toBe(false)
  })

  it('rejects on locked track and missing clip', () => {
    const state = stateWithClip()
    const locked = dispatchSync(
      state,
      { type: 'track/lock', params: { trackId: 'T', locked: true } },
      { source: 'user' },
    ).result.state!
    expect(
      dispatchSync(
        locked,
        { type: 'effect/setGradeFilters', params: { clipId: 'c1', gradeFilters: [] } },
        { source: 'user' },
      ).result.error?.code,
    ).toBe('TRACK_LOCKED')
    expect(
      dispatchSync(
        state,
        { type: 'effect/setGradeFilters', params: { clipId: 'nope', gradeFilters: [] } },
        { source: 'user' },
      ).result.error?.code,
    ).toBe('CLIP_NOT_FOUND')
  })
})
