// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { captionsToActions } from './caption-actions'
import type { Clip } from '@/lib/types'
import type { SrtCue } from './srt'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    sourceType: 'video',
    sourceId: 'video://fixture.mp4',
    label: '',
    startTime: 10,
    duration: 60,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...overrides,
  }
}

const cue = (start: number, end: number, text: string, index = 1): SrtCue => ({ index, start, end, text })

describe('captionsToActions', () => {
  it('emits a track/add when no subtitlesTrackId is supplied, then a clip/add per cue', () => {
    const plan = captionsToActions({
      parentClip: clip(),
      cues: [cue(0, 2, 'Hello'), cue(2, 4, 'World', 2)],
    })
    expect(plan.actions[0].type).toBe('track/add')
    expect(plan.actions[1].type).toBe('clip/add')
    expect(plan.actions[2].type).toBe('clip/add')
    expect(plan.cueCount).toBe(2)
    expect(plan.totalSeconds).toBeCloseTo(4)
  })

  it('skips the track/add when subtitlesTrackId is supplied', () => {
    const plan = captionsToActions({
      parentClip: clip(),
      cues: [cue(0, 2, 'Hello')],
      subtitlesTrackId: 'sub-1',
    })
    expect(plan.actions[0].type).toBe('clip/add')
    expect(plan.trackId).toBe('sub-1')
  })

  it('rebases cue times onto the global timeline using the parent clip startTime', () => {
    const plan = captionsToActions({
      parentClip: clip({ startTime: 10 }),
      cues: [cue(1, 3, 'Hi')],
      subtitlesTrackId: 'sub',
    })
    const addAction = plan.actions[0]
    expect(addAction.type).toBe('clip/add')
    const p = addAction.params as { clip: { startTime: number; duration: number } }
    expect(p.clip.startTime).toBe(11)
    expect(p.clip.duration).toBe(2)
  })

  it('clips cues that extend past the parent clip duration', () => {
    const plan = captionsToActions({
      parentClip: clip({ startTime: 0, duration: 5 }),
      cues: [cue(4, 10, 'Long one')],
      subtitlesTrackId: 'sub',
    })
    const p = plan.actions[0].params as { clip: { startTime: number; duration: number } }
    expect(p.clip.startTime).toBe(4)
    expect(p.clip.duration).toBe(1) // clipped to [4, 5)
  })

  it('drops zero-length cues', () => {
    const plan = captionsToActions({
      parentClip: clip({ startTime: 0, duration: 5 }),
      cues: [cue(2, 2.005, 'instant'), cue(3, 4, 'real')],
      subtitlesTrackId: 'sub',
    })
    expect(plan.cueCount).toBe(1)
    expect((plan.actions[0].params as { clip: { label: string } }).clip.label).toBe('real')
  })

  it('honours trimStart + speed when rebasing cue times', () => {
    // parent: startTime=0, trimStart=5, speed=2 — source cue at 11s should
    // appear on the timeline at (11 - 5) / 2 = 3s into the parent.
    const plan = captionsToActions({
      parentClip: clip({ startTime: 0, duration: 10, trimStart: 5, speed: 2 }),
      cues: [cue(11, 13, 'speedy')],
      subtitlesTrackId: 'sub',
    })
    const p = plan.actions[0].params as { clip: { startTime: number; duration: number } }
    expect(p.clip.startTime).toBeCloseTo(3)
    expect(p.clip.duration).toBeCloseTo(1) // (13-11)/2 = 1
  })

  it('uses the provided id factory for stable test ids', () => {
    let i = 0
    const newId = () => `id-${++i}`
    const plan = captionsToActions({
      parentClip: clip(),
      cues: [cue(0, 1, 'a'), cue(1, 2, 'b')],
      newId,
    })
    expect(plan.trackId).toBe('id-1')
    expect((plan.actions[1].params as { clipId: string }).clipId).toBe('id-2')
    expect((plan.actions[2].params as { clipId: string }).clipId).toBe('id-3')
  })
})
