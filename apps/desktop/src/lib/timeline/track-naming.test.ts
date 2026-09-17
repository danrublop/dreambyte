import { describe, it, expect } from 'vitest'
import { normalizeTrackNames, pickTrackForClip, trackTypeForSource } from './track-naming'
import type { Track } from '@/lib/types'

const trk = (over: Partial<Track> & { id: string }): Track =>
  ({ name: '?', type: 'video', position: 0, clips: [], muted: false, locked: false, ...over }) as Track

describe('normalizeTrackNames', () => {
  it('names video V1,V2,… and audio A1,A2,… by position within type', () => {
    const out = normalizeTrackNames([
      trk({ id: 'v2', type: 'video', position: 1, name: 'whatever' }),
      trk({ id: 'a1', type: 'audio', position: 2, name: 'A1' }),
      trk({ id: 'v1', type: 'video', position: 0, name: 'V1-lower' }),
      trk({ id: 'a2', type: 'audio', position: 3, name: 'Narration' }),
    ])
    const byId = Object.fromEntries(out.map((t) => [t.id, t.name]))
    expect(byId).toEqual({ v1: 'V1', v2: 'V2', a1: 'A1', a2: 'A2' })
  })

  it('reuses NO names after a removal (renumbers, no dupes/gaps)', () => {
    // Had V1,V2,V3; removed V1 → remaining renumber to V1,V2 (not V2,V3).
    const out = normalizeTrackNames([
      trk({ id: 'b', type: 'video', position: 1, name: 'V2' }),
      trk({ id: 'c', type: 'video', position: 2, name: 'V3' }),
    ])
    expect(out.map((t) => t.name).sort()).toEqual(['V1', 'V2'])
  })

  it('overrides custom names (software owns naming)', () => {
    const out = normalizeTrackNames([trk({ id: 'x', type: 'audio', position: 0, name: 'My Cool Music Track' })])
    expect(out[0].name).toBe('A1')
  })
})

describe('pickTrackForClip — route to the lowest free track of the type', () => {
  it('uses the default (lowest) video track when free', () => {
    const tracks = [
      trk({ id: 'v1', type: 'video', position: 0 }),
      trk({ id: 'v2', type: 'video', position: 1 }),
    ]
    expect(pickTrackForClip(tracks, 'video', 0, 5)).toBe('v1')
  })

  it('spills to the next track only when the lower one overlaps', () => {
    const tracks = [
      trk({ id: 'v1', type: 'video', position: 0, clips: [{ startTime: 0, duration: 4 } as any] }),
      trk({ id: 'v2', type: 'video', position: 1 }),
    ]
    expect(pickTrackForClip(tracks, 'video', 2, 3)).toBe('v2') // [2,5) overlaps v1's [0,4)
    expect(pickTrackForClip(tracks, 'video', 5, 3)).toBe('v1') // [5,8) is free on v1
  })

  it('returns null when every track of the type is occupied (caller appends a lane)', () => {
    const tracks = [trk({ id: 'a1', type: 'audio', position: 0, clips: [{ startTime: 0, duration: 10 } as any] })]
    expect(pickTrackForClip(tracks, 'audio', 1, 2)).toBeNull()
  })

  it('skips locked tracks', () => {
    const tracks = [
      trk({ id: 'v1', type: 'video', position: 0, locked: true }),
      trk({ id: 'v2', type: 'video', position: 1 }),
    ]
    expect(pickTrackForClip(tracks, 'video', 0, 5)).toBe('v2')
  })
})

describe('routing helpers', () => {
  it('scene/video/image/title route to a video lane; audio to audio', () => {
    expect(trackTypeForSource('scene')).toBe('video')
    expect(trackTypeForSource('video')).toBe('video')
    expect(trackTypeForSource('image')).toBe('video')
    expect(trackTypeForSource('title')).toBe('video')
    expect(trackTypeForSource('audio')).toBe('audio')
  })
})
