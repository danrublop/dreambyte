// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { applyClipMoveWriteThrough } from '../apply-clip-move-write-through'
import type { Clip, Scene, Timeline, Track } from '@/lib/types'

function clip(over: Partial<Clip> & { id: string; trackId: string }): Clip {
  return {
    sourceType: 'scene',
    sourceId: 's1',
    label: 'c',
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
    transition: null,
    ...over,
  } as Clip
}
function track(over: Partial<Track> & { id: string }): Track {
  return { name: 'T', type: 'video', clips: [], muted: false, locked: false, position: 0, ...over } as Track
}

describe('applyClipMoveWriteThrough — timeline transform (B3/OV#5)', () => {
  it('moves a video clip across tracks and clamps negative start to 0', () => {
    const tl: Timeline = {
      tracks: [
        track({ id: 'v1', clips: [clip({ id: 'c1', trackId: 'v1', sourceType: 'video', sourceId: 'm1' })] }),
        track({ id: 'v2', position: 1 }),
      ],
    }
    const r = applyClipMoveWriteThrough(tl, [], 'c1', { toTrackId: 'v2', startTime: -5 })
    expect(r.changed).toBe(true)
    const moved = r.timeline.tracks.find((t) => t.id === 'v2')!.clips.find((c) => c.id === 'c1')!
    expect(moved.startTime).toBe(0)
    expect(r.timeline.tracks.find((t) => t.id === 'v1')!.clips).toHaveLength(0)
  })

  it('ALLOWS a cross-track scene move to V2 (composites over the V1 gap; no phantom)', () => {
    // Timeline-authoritative (docs/NLE_RECONCILIATION.md): a scene clip may move
    // up to a second video lane. It lands on V2 and leaves a real gap on V1; the
    // old "stay on the primary video track" reject-guard is gone. The next sync
    // recognises the scene lives on V2 and won't re-materialize a V1 duplicate.
    const tl: Timeline = {
      tracks: [
        track({ id: 'v1', clips: [clip({ id: 'cs', trackId: 'v1', sourceType: 'scene', sourceId: 's1' })] }),
        track({ id: 'v2', position: 1 }),
      ],
    }
    const r = applyClipMoveWriteThrough(tl, [], 'cs', { toTrackId: 'v2', startTime: 0 })
    expect(r.changed).toBe(true)
    expect(r.timeline.tracks.find((t) => t.id === 'v1')!.clips).toHaveLength(0) // V1 gap
    const moved = r.timeline.tracks.find((t) => t.id === 'v2')!.clips.find((c) => c.id === 'cs')!
    expect(moved.startTime).toBe(0) // landed on V2
  })

  it('shifts linked aud-/tts-/mus- siblings by the same delta on a scene move', () => {
    const tl: Timeline = {
      tracks: [
        track({ id: 'v1', clips: [clip({ id: 'cs', trackId: 'v1', sourceType: 'scene', sourceId: 'sx' })] }),
        track({
          id: 'a1',
          type: 'audio',
          position: 1,
          clips: [clip({ id: 'aud', trackId: 'a1', sourceType: 'audio', sourceId: 'aud-sx' })],
        }),
      ],
    }
    const r = applyClipMoveWriteThrough(tl, [{ id: 'sx', duration: 5 } as Scene], 'cs', {
      toTrackId: 'v1',
      startTime: 10,
    })
    expect(r.timeline.tracks.find((t) => t.id === 'a1')!.clips.find((c) => c.id === 'aud')!.startTime).toBe(10)
  })

  it('no-op move (same track + start) reports changed:false with no reason', () => {
    const tl: Timeline = { tracks: [track({ id: 'v1', clips: [clip({ id: 'c1', trackId: 'v1' })] })] }
    const r = applyClipMoveWriteThrough(tl, [], 'c1', { toTrackId: 'v1', startTime: 0 })
    expect(r.changed).toBe(false)
    expect(r.rejectedReason).toBeUndefined()
  })
})

describe('applyClipMoveWriteThrough — scene SOURCE write-back (the snap-back fix)', () => {
  const scene = (over: Partial<Scene>): Scene => ({ id: 'sx', duration: 10, ...over }) as Scene

  it('writes back avatar aiLayer.startAt so the next sync re-derives the same clip', () => {
    const tl: Timeline = {
      tracks: [
        track({ id: 'v1', clips: [clip({ id: 'cs', trackId: 'v1', sourceType: 'scene', sourceId: 'sx' })] }),
        track({
          id: 'v2',
          position: 1,
          clips: [clip({ id: 'av', trackId: 'v2', sourceType: 'avatar', sourceId: 'lay', linkGroupId: 'avatar:lay' })],
        }),
      ],
    }
    const scenes = [scene({ aiLayers: [{ id: 'lay', type: 'avatar', label: 'Host', startAt: 0 } as any] })]
    const r = applyClipMoveWriteThrough(tl, scenes, 'av', { toTrackId: 'v2', startTime: 3 })
    expect(r.changed).toBe(true)
    const layer = r.scenes[0].aiLayers!.find((l) => l.id === 'lay')!
    expect((layer as any).startAt).toBe(3) // scene clip is at 0 → relative startAt = 3
  })

  it('writes back audioLayer.startOffset for a narration (aud-) clip move', () => {
    const tl: Timeline = {
      tracks: [
        track({ id: 'v1', clips: [clip({ id: 'cs', trackId: 'v1', sourceType: 'scene', sourceId: 'sx' })] }),
        track({
          id: 'a1',
          type: 'audio',
          position: 1,
          clips: [clip({ id: 'aud', trackId: 'a1', sourceType: 'audio', sourceId: 'aud-sx' })],
        }),
      ],
    }
    const scenes = [scene({ audioLayer: { src: 'n.mp3', startOffset: 0 } as any })]
    const r = applyClipMoveWriteThrough(tl, scenes, 'aud', { toTrackId: 'a1', startTime: 4 })
    expect((r.scenes[0].audioLayer as any).startOffset).toBe(4)
  })

  it('writeBackSource:false leaves source fields untouched (renderer path)', () => {
    const tl: Timeline = {
      tracks: [
        track({ id: 'v1', clips: [clip({ id: 'cs', trackId: 'v1', sourceType: 'scene', sourceId: 'sx' })] }),
        track({
          id: 'a1',
          type: 'audio',
          position: 1,
          clips: [clip({ id: 'aud', trackId: 'a1', sourceType: 'audio', sourceId: 'aud-sx' })],
        }),
      ],
    }
    const scenes = [scene({ audioLayer: { src: 'n.mp3', startOffset: 0 } as any })]
    const r = applyClipMoveWriteThrough(
      tl,
      scenes,
      'aud',
      { toTrackId: 'a1', startTime: 4 },
      { writeBackSource: false },
    )
    expect((r.scenes[0].audioLayer as any).startOffset).toBe(0) // unchanged — setters do this in the store
    // but the timeline DID move:
    expect(r.timeline.tracks.find((t) => t.id === 'a1')!.clips.find((c) => c.id === 'aud')!.startTime).toBe(4)
  })
})
