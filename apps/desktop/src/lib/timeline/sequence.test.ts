import { describe, it, expect } from 'vitest'
import type { Timeline } from '@/lib/types'
import {
  getSequenceOrder,
  getSequenceSegments,
  getSequenceDuration,
  getCompositeDuration,
  getActiveClips,
  findActiveClip,
  getPlaybackSequenceClips,
} from './sequence'

const clip = (id: string, sourceId: string, startTime: number, duration: number) =>
  ({
    id,
    trackId: 'v1',
    sourceType: 'scene' as const,
    sourceId,
    label: sourceId,
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
  }) as any

const tl = (clips: any[]): Timeline =>
  ({ tracks: [{ id: 'v1', name: 'V1', type: 'video', position: 0, clips }] }) as any

describe('sequence derivation (timeline-authoritative)', () => {
  it('orders scenes by startTime, not array order', () => {
    const t = tl([clip('c2', 'B', 10, 5), clip('c1', 'A', 0, 5)])
    expect(getSequenceOrder(t)).toEqual(['A', 'B'])
  })

  it('emits explicit gap segments between clips and before the first', () => {
    // leading gap 0..2, A[2,5], gap 5..8, B[8,12]
    const t = tl([clip('cA', 'A', 2, 3), clip('cB', 'B', 8, 4)])
    const segs = getSequenceSegments(t)
    expect(segs.map((s) => [s.kind, s.startTime, s.duration])).toEqual([
      ['gap', 0, 2],
      ['scene', 2, 3],
      ['gap', 5, 3],
      ['scene', 8, 4],
    ])
  })

  it('no gap for butt-joined clips (within epsilon)', () => {
    const t = tl([clip('cA', 'A', 0, 5), clip('cB', 'B', 5.0005, 5)])
    const segs = getSequenceSegments(t)
    expect(segs.every((s) => s.kind === 'scene')).toBe(true)
  })

  it('total duration includes trailing gaps (last clip end)', () => {
    const t = tl([clip('cA', 'A', 0, 5), clip('cB', 'B', 10, 4)])
    expect(getSequenceDuration(t)).toBe(14)
  })
})

describe('getCompositeDuration (spans ALL video tracks)', () => {
  it('includes a V2 clip that extends past the V1 spine', () => {
    const t = {
      tracks: [
        { id: 'v1', name: 'V1', type: 'video', position: 0, clips: [clip('a', 'A', 0, 5)] },
        { id: 'v2', name: 'V2', type: 'video', position: 1, clips: [clip('b', 'B', 4, 8)] }, // ends at 12
      ],
    } as unknown as Timeline
    expect(getSequenceDuration(t)).toBe(5) // V1-only
    expect(getCompositeDuration(t)).toBe(12) // spans V2
  })

  it('ignores audio tracks and non-scene clips; 0 for empty/null', () => {
    const t = {
      tracks: [
        { id: 'v1', name: 'V1', type: 'video', position: 0, clips: [clip('a', 'A', 0, 6)] },
        { id: 'a1', name: 'A1', type: 'audio', position: 1, clips: [{ ...clip('au', 'AU', 0, 100), sourceType: 'audio' }] },
      ],
    } as unknown as Timeline
    expect(getCompositeDuration(t)).toBe(6)
    expect(getCompositeDuration(null)).toBe(0)
  })

  // OV-5: a footage-only timeline (bare media, no scenes) must report a real
  // duration — else the composite export sees 0 frames and bails.
  it('counts bare video/image clips so a MEDIA-ONLY timeline has a duration', () => {
    const t = {
      tracks: [
        { id: 'v1', name: 'V1', type: 'video', position: 0, clips: [{ ...clip('v', '/u/foot.mp4', 0, 7), sourceType: 'video' }] },
        { id: 'v2', name: 'V2', type: 'video', position: 1, clips: [{ ...clip('i', '/u/pic.png', 5, 4), sourceType: 'image' }] }, // ends at 9
      ],
    } as unknown as Timeline
    expect(getCompositeDuration(t)).toBe(9) // spans the image clip; NOT 0
  })

  it('still ignores title clips (not composited)', () => {
    const t = tl([{ ...clip('ti', 'Hello', 0, 5), sourceType: 'title' }])
    expect(getCompositeDuration(t)).toBe(0)
  })
})

// ── getActiveClips / findActiveClip ──────────────────────────────────────────

const aclip = (over: Partial<any> & { id: string; trackId: string }) =>
  ({
    sourceType: 'scene',
    sourceId: over.id,
    label: over.id,
    startTime: 0,
    duration: 5,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...over,
  }) as any

const track = (over: Partial<any> & { id: string }) =>
  ({ name: over.id, type: 'video', position: 0, clips: [], muted: false, locked: false, ...over }) as any

const mtl = (tracks: any[]): Timeline => ({ tracks }) as any

describe('getActiveClips / findActiveClip (timeline-authoritative compositing)', () => {
  it('returns empty at a true gap (no clip on any track)', () => {
    const t = mtl([track({ id: 'v1', clips: [aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 5 })] })])
    expect(getActiveClips(t, 6)).toEqual([])
    expect(findActiveClip(t, 6)).toBeNull()
  })

  it('half-open interval: active at startTime, inactive at startTime+duration', () => {
    const t = mtl([track({ id: 'v1', clips: [aclip({ id: 'a', trackId: 'v1', startTime: 2, duration: 3 })] })])
    expect(getActiveClips(t, 2)).toHaveLength(1) // [2,5)
    expect(getActiveClips(t, 5)).toHaveLength(0) // end is exclusive
  })

  it('overlap: the higher-position track wins (V2 over V1)', () => {
    const t = mtl([
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'lo', trackId: 'v1', startTime: 0, duration: 10 })] }),
      track({ id: 'v2', position: 1, clips: [aclip({ id: 'hi', trackId: 'v2', startTime: 3, duration: 4 })] }),
    ])
    // both active at t=5; top-most by z-base is the V2 clip
    expect(getActiveClips(t, 5).map((a) => a.clip.id)).toEqual(['lo', 'hi'])
    expect(findActiveClip(t, 5)!.clip.id).toBe('hi')
    // only V1 active at t=8 (V2 clip ended at 7)
    expect(findActiveClip(t, 8)!.clip.id).toBe('lo')
  })

  it('split halves are two distinct entries by clip id (the split-jump fix)', () => {
    // one source 's', split into [0,4) and [4,8) — distinct clip ids, shared sourceId
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          aclip({ id: 'left', trackId: 'v1', sourceId: 's', startTime: 0, duration: 4, trimStart: 0, trimEnd: 4 }),
          aclip({ id: 'right', trackId: 'v1', sourceId: 's', startTime: 4, duration: 4, trimStart: 4, trimEnd: null }),
        ],
      }),
    ])
    expect(findActiveClip(t, 1)!.clip.id).toBe('left')
    expect(findActiveClip(t, 5)!.clip.id).toBe('right') // resolves the RIGHT half by time, not first-sourceId
  })

  it('honors muted / hidden tracks and solo', () => {
    const base = [
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 10 })] }),
      track({ id: 'v2', position: 1, clips: [aclip({ id: 'b', trackId: 'v2', startTime: 0, duration: 10 })] }),
    ]
    expect(getActiveClips(mtl([{ ...base[0], hidden: true }, base[1]]), 5).map((a) => a.clip.id)).toEqual(['b'])
    expect(getActiveClips(mtl([{ ...base[0], muted: true }, base[1]]), 5).map((a) => a.clip.id)).toEqual(['b'])
    // solo on v2 hides the non-solo v1
    expect(getActiveClips(mtl([base[0], { ...base[1], solo: true }]), 5).map((a) => a.clip.id)).toEqual(['b'])
  })

  it('a soloed AUDIO track does NOT hide video (visual-bus solo only)', () => {
    // Symmetric to the audio-bus fix: soloing an audio track is audio-only and
    // must not blank the picture. Both video clips stay active.
    const t = mtl([
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 10 })] }),
      track({ id: 'v2', position: 1, clips: [aclip({ id: 'b', trackId: 'v2', startTime: 0, duration: 10 })] }),
      track({ id: 'a1', position: 2, type: 'audio', solo: true, clips: [aclip({ id: 'au', trackId: 'a1', sourceType: 'audio', startTime: 0, duration: 10 })] }),
    ])
    expect(getActiveClips(t, 5, { sourceType: 'scene' }).map((a) => a.clip.id)).toEqual(['a', 'b'])
  })

  it('filters by sourceType but keeps full-composite z-base', () => {
    const t = mtl([
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'sc', trackId: 'v1', sourceType: 'scene', startTime: 0, duration: 10 })] }),
      track({ id: 'a1', position: 1, type: 'audio', clips: [aclip({ id: 'au', trackId: 'a1', sourceType: 'audio', startTime: 0, duration: 10 })] }),
    ])
    const scenes = getActiveClips(t, 5, { sourceType: 'scene' })
    expect(scenes.map((a) => a.clip.id)).toEqual(['sc'])
    expect(scenes[0].trackZBase).toBe(100) // index 0 in the FULL sorted track list
  })
})

// The shared playback sequence — ONE definition consumed by both the preview
// (PreviewPlayer.getV1SceneClips) and the export fade (applyFadeTransition), so they
// pick the same "next clip" for a crossfade.
describe('getPlaybackSequenceClips (shared preview/export fade order)', () => {
  it('is the V1 spine in startTime order when there are no higher-track scenes', () => {
    const t = mtl([
      track({
        id: 'v1', position: 0,
        clips: [aclip({ id: 'b', sourceId: 'B', trackId: 'v1', startTime: 5, duration: 5 }), aclip({ id: 'a', sourceId: 'A', trackId: 'v1', startTime: 0, duration: 5 })],
      }),
    ])
    expect(getPlaybackSequenceClips(t).map((c) => c.sourceId)).toEqual(['A', 'B'])
  })

  it('INCLUDES a non-overlapping V2 scene as a gap-filler, in startTime order', () => {
    // V1: A[0,3], C[6,9] with a hole [3,6); V2: B[3,6) fills the hole (no V1 overlap).
    const t = mtl([
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'a', sourceId: 'A', trackId: 'v1', startTime: 0, duration: 3 }), aclip({ id: 'c', sourceId: 'C', trackId: 'v1', startTime: 6, duration: 3 })] }),
      track({ id: 'v2', position: 1, clips: [aclip({ id: 'b', sourceId: 'B', trackId: 'v2', startTime: 3, duration: 3 })] }),
    ])
    expect(getPlaybackSequenceClips(t).map((c) => c.sourceId)).toEqual(['A', 'B', 'C'])
  })

  it('EXCLUDES a V2 scene that overlaps the V1 spine (it stacks, not sequences)', () => {
    const t = mtl([
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'a', sourceId: 'A', trackId: 'v1', startTime: 0, duration: 8 })] }),
      track({ id: 'v2', position: 1, clips: [aclip({ id: 'b', sourceId: 'B', trackId: 'v2', startTime: 2, duration: 3 })] }), // overlaps A
    ])
    expect(getPlaybackSequenceClips(t).map((c) => c.sourceId)).toEqual(['A'])
  })

  it('on a tie at the same startTime, the higher track sorts first (renders on top)', () => {
    const t = mtl([
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'a', sourceId: 'A', trackId: 'v1', startTime: 0, duration: 3 })] }),
      // B on V2 butted exactly at A's end (t=3), non-overlapping → a gap-filler at t=3.
      track({ id: 'v2', position: 1, clips: [aclip({ id: 'b', sourceId: 'B', trackId: 'v2', startTime: 3, duration: 3 })] }),
    ])
    expect(getPlaybackSequenceClips(t).map((c) => c.sourceId)).toEqual(['A', 'B'])
  })

  it('returns [] when there is no video track', () => {
    const t = mtl([track({ id: 'a1', position: 0, type: 'audio', clips: [] })])
    expect(getPlaybackSequenceClips(t)).toEqual([])
  })
})
