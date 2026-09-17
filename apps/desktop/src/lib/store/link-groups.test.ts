import { describe, expect, it } from 'vitest'
import type { Clip, Timeline } from '@/lib/types'
import {
  allClips,
  findClip,
  linkedClipIds,
  linkClipsInTimeline,
  removeLinkedClips,
  shiftLinkedClips,
  trimLinkedClips,
  unlinkGroupInTimeline,
} from './link-groups'

function mkClip(overrides: Partial<Clip>): Clip {
  return {
    id: overrides.id ?? 'c',
    trackId: overrides.trackId ?? 't',
    sourceType: overrides.sourceType ?? 'video',
    sourceId: overrides.sourceId ?? 'src',
    label: overrides.label ?? 'clip',
    startTime: overrides.startTime ?? 0,
    duration: overrides.duration ?? 5,
    trimStart: overrides.trimStart ?? 0,
    trimEnd: overrides.trimEnd ?? null,
    speed: overrides.speed ?? 1,
    opacity: overrides.opacity ?? 1,
    position: overrides.position ?? { x: 0, y: 0 },
    scale: overrides.scale ?? { x: 1, y: 1 },
    rotation: overrides.rotation ?? 0,
    filters: overrides.filters ?? [],
    keyframes: overrides.keyframes ?? [],
    ...overrides,
  } as Clip
}

function mkTimeline(...clips: Array<{ trackId: string; clip: Clip }>): Timeline {
  const grouped = new Map<string, Clip[]>()
  for (const { trackId, clip } of clips) {
    const arr = grouped.get(trackId) ?? []
    arr.push(clip)
    grouped.set(trackId, arr)
  }
  return {
    tracks: Array.from(grouped.entries()).map(([id, cs], i) => ({
      id,
      name: id,
      type: 'video' as const,
      clips: cs,
      muted: false,
      locked: false,
      position: i,
    })),
  }
}

describe('linkedClipIds', () => {
  it('returns just the clip when it has no link group', () => {
    const tl = mkTimeline({ trackId: 'v1', clip: mkClip({ id: 'a' }) })
    expect(linkedClipIds(tl, 'a')).toEqual(['a'])
  })

  it('returns all siblings sharing the same linkGroupId', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'video', linkGroupId: 'g' }) },
      { trackId: 'a1', clip: mkClip({ id: 'audio', linkGroupId: 'g', sourceType: 'audio' }) },
      { trackId: 'v2', clip: mkClip({ id: 'other' }) },
    )
    const ids = linkedClipIds(tl, 'video').sort()
    expect(ids).toEqual(['audio', 'video'])
  })

  it('returns [clipId] when the clip is not in the timeline', () => {
    const tl = mkTimeline({ trackId: 'v1', clip: mkClip({ id: 'a' }) })
    expect(linkedClipIds(tl, 'gone')).toEqual(['gone'])
  })
})

describe('shiftLinkedClips', () => {
  it('shifts siblings (not origin) by the delta', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'video', startTime: 10, linkGroupId: 'g' }) },
      { trackId: 'a1', clip: mkClip({ id: 'audio', startTime: 10, linkGroupId: 'g', sourceType: 'audio' }) },
    )
    const next = shiftLinkedClips(tl, 'g', 5, 'video')
    const a = findClip(next, 'audio')!
    const v = findClip(next, 'video')!
    expect(a.clip.startTime).toBe(15)
    // Origin untouched — caller already moved it.
    expect(v.clip.startTime).toBe(10)
  })

  it('clamps siblings to startTime >= 0', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'video', startTime: 5, linkGroupId: 'g' }) },
      { trackId: 'a1', clip: mkClip({ id: 'audio', startTime: 2, linkGroupId: 'g', sourceType: 'audio' }) },
    )
    const next = shiftLinkedClips(tl, 'g', -10, 'video')
    expect(findClip(next, 'audio')!.clip.startTime).toBe(0)
  })

  it('no-ops when groupId is undefined', () => {
    const tl = mkTimeline({ trackId: 'v1', clip: mkClip({ id: 'video', startTime: 10 }) })
    const next = shiftLinkedClips(tl, undefined, 5, 'video')
    expect(next).toBe(tl)
  })
})

describe('trimLinkedClips', () => {
  it('right-edge trim extends sibling duration by the same delta', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'video', startTime: 0, duration: 5, linkGroupId: 'g' }) },
      {
        trackId: 'a1',
        clip: mkClip({ id: 'audio', startTime: 0, duration: 5, linkGroupId: 'g', sourceType: 'audio' }),
      },
    )
    const next = trimLinkedClips(tl, 'g', 'right', 2, 'video')
    expect(findClip(next, 'audio')!.clip.duration).toBe(7)
    expect(findClip(next, 'video')!.clip.duration).toBe(5) // unchanged (origin)
  })

  it('left-edge trim shifts sibling start AND shrinks duration', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'video', startTime: 0, duration: 5, linkGroupId: 'g' }) },
      {
        trackId: 'a1',
        clip: mkClip({ id: 'audio', startTime: 0, duration: 5, linkGroupId: 'g', sourceType: 'audio' }),
      },
    )
    const next = trimLinkedClips(tl, 'g', 'left', 1, 'video')
    expect(findClip(next, 'audio')!.clip.startTime).toBe(1)
    expect(findClip(next, 'audio')!.clip.duration).toBe(4)
  })

  it('clamps duration above the 0.05s floor', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'video', startTime: 0, duration: 1, linkGroupId: 'g' }) },
      {
        trackId: 'a1',
        clip: mkClip({ id: 'audio', startTime: 0, duration: 0.1, linkGroupId: 'g', sourceType: 'audio' }),
      },
    )
    const next = trimLinkedClips(tl, 'g', 'right', -10, 'video')
    expect(findClip(next, 'audio')!.clip.duration).toBeGreaterThanOrEqual(0.05)
  })
})

describe('removeLinkedClips', () => {
  it('drops every clip in the group regardless of track', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'video', linkGroupId: 'g' }) },
      { trackId: 'a1', clip: mkClip({ id: 'audio', linkGroupId: 'g', sourceType: 'audio' }) },
      { trackId: 'v2', clip: mkClip({ id: 'other' }) },
    )
    const next = removeLinkedClips(tl, 'g')
    expect(allClips(next).map((r) => r.clip.id)).toEqual(['other'])
  })
})

describe('unlinkGroupInTimeline', () => {
  it('clears linkGroupId on every group member', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'a', linkGroupId: 'g' }) },
      { trackId: 'v1', clip: mkClip({ id: 'b', linkGroupId: 'g' }) },
      { trackId: 'v1', clip: mkClip({ id: 'c', linkGroupId: 'other' }) },
    )
    const next = unlinkGroupInTimeline(tl, 'g')
    expect(findClip(next, 'a')!.clip.linkGroupId).toBeUndefined()
    expect(findClip(next, 'b')!.clip.linkGroupId).toBeUndefined()
    // Untouched groups stay.
    expect(findClip(next, 'c')!.clip.linkGroupId).toBe('other')
  })
})

describe('linkClipsInTimeline', () => {
  it('assigns the given groupId to listed clips only', () => {
    const tl = mkTimeline(
      { trackId: 'v1', clip: mkClip({ id: 'a' }) },
      { trackId: 'v1', clip: mkClip({ id: 'b' }) },
      { trackId: 'v1', clip: mkClip({ id: 'c' }) },
    )
    const next = linkClipsInTimeline(tl, ['a', 'b'], 'newgroup')
    expect(findClip(next, 'a')!.clip.linkGroupId).toBe('newgroup')
    expect(findClip(next, 'b')!.clip.linkGroupId).toBe('newgroup')
    expect(findClip(next, 'c')!.clip.linkGroupId).toBeUndefined()
  })

  it('overrides existing link group when a clip is in two link sets', () => {
    const tl = mkTimeline({ trackId: 'v1', clip: mkClip({ id: 'a', linkGroupId: 'old' }) })
    const next = linkClipsInTimeline(tl, ['a'], 'new')
    expect(findClip(next, 'a')!.clip.linkGroupId).toBe('new')
  })
})
