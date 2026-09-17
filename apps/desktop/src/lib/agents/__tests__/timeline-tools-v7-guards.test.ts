// @vitest-environment node
//
// Lane A (agent-hardening v7): timeline numeric guards (P0-3) + linked-sibling
// ripple (P1-11). Covers the corruption surface the audit flagged: NaN/Inf args
// that slip past Math.max / range comparisons, non-audio overlap that desyncs the
// gapless invariant, and remove_clip leaving a linked sibling's track ungapped.

process.env.DATABASE_URL = 'file::memory:'

import { beforeEach, describe, expect, it } from 'vitest'

import { executeTool } from '@/lib/agents/tool-executor'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'
import type { Clip, Track } from '@/lib/types'

function emptyWorld(): WorldStateMutable {
  const scene = createDefaultScene()
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([scene]).sceneGraph,
  }
}

function makeClip(over: Partial<Clip> & { id: string; trackId: string }): Clip {
  return {
    sourceType: 'video',
    sourceId: over.id,
    label: over.id,
    startTime: 0,
    duration: 1,
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

function track(id: string, type: Track['type'], clips: Clip[], position = 0): Track {
  return { id, name: id, type, clips, muted: false, locked: false, position }
}

const call = (world: WorldStateMutable, name: string, args: Record<string, unknown>) => executeTool(name, args, world)

describe('Lane A · P0-3 finite guards (NaN/Inf corruption)', () => {
  let world: WorldStateMutable
  let videoTrackId: string
  beforeEach(async () => {
    world = emptyWorld()
    await call(world, 'init_timeline', {})
    const add = (await call(world, 'add_track', { type: 'graphics', name: 'GFX' })).data as { trackId: string }
    videoTrackId = add.trackId
  })

  async function placeOne(start = 0, duration = 2): Promise<string> {
    const r = await call(world, 'place_clip', {
      trackId: videoTrackId,
      sourceType: 'video',
      sourceId: 'v',
      startTime: start,
      duration,
    })
    expect(r.success).toBe(true)
    return (r.data as { clipId: string }).clipId
  }

  it('trim_clip rejects NaN duration', async () => {
    const id = await placeOne()
    const r = await call(world, 'clip', { op: 'trim', clipId: id, duration: NaN })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/duration must be a finite number/)
  })

  it('CRITICAL regression: split_clip NaN atTime no longer passes the range guard', async () => {
    const id = await placeOne(0, 4)
    const r = await call(world, 'clip', { op: 'split', clipId: id, atTime: NaN })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/atTime must be a finite number/)
    // and the clip is untouched — no NaN-duration halves minted
    const clips = world.timeline!.tracks.flatMap((t) => t.clips)
    expect(clips.every((c) => Number.isFinite(c.duration))).toBe(true)
  })

  it('split_clip still rejects out-of-range (finite) atTime', async () => {
    const id = await placeOne(0, 4)
    const r = await call(world, 'clip', { op: 'split', clipId: id, atTime: 99 })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/out of range/)
  })

  it('keyframe(set) rejects NaN time and Infinity value', async () => {
    const id = await placeOne()
    expect(
      (await call(world, 'keyframe', { action: 'set', clipId: id, property: 'x', time: NaN, value: 1 })).success,
    ).toBe(false)
    expect(
      (await call(world, 'keyframe', { action: 'set', clipId: id, property: 'x', time: 0, value: Infinity })).success,
    ).toBe(false)
  })

  it('slip_edit rejects NaN offset', async () => {
    const id = await placeOne()
    const r = await call(world, 'clip', { op: 'slip', clipId: id, offsetSeconds: NaN })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/offsetSeconds must be a finite number/)
  })

  it('place_clip rejects NaN startTime', async () => {
    const r = await call(world, 'place_clip', {
      trackId: videoTrackId,
      sourceType: 'video',
      sourceId: 'v',
      startTime: NaN,
      duration: 2,
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/startTime must be a finite number/)
  })

  it('valid finite args still succeed (guards do not over-reject)', async () => {
    const id = await placeOne(0, 4)
    expect((await call(world, 'clip', { op: 'trim', clipId: id, duration: 3 })).success).toBe(true)
    expect(
      (await call(world, 'keyframe', { action: 'set', clipId: id, property: 'x', time: 1, value: 0.5 })).success,
    ).toBe(true)
  })
})

describe('Lane A · P0-3 non-audio overlap reject (audio still spills)', () => {
  let world: WorldStateMutable
  beforeEach(async () => {
    world = emptyWorld()
    await call(world, 'init_timeline', {})
  })

  it('place_clip rejects an overlap on a non-audio track', async () => {
    const gfx = (await call(world, 'add_track', { type: 'graphics' })).data as { trackId: string }
    expect(
      (
        await call(world, 'place_clip', {
          trackId: gfx.trackId,
          sourceType: 'video',
          sourceId: 'a',
          startTime: 0,
          duration: 5,
        })
      ).success,
    ).toBe(true)
    const overlap = await call(world, 'place_clip', {
      trackId: gfx.trackId,
      sourceType: 'video',
      sourceId: 'b',
      startTime: 2,
      duration: 5,
    })
    expect(overlap.success).toBe(false)
    expect(overlap.error).toMatch(/overlap/i)
  })

  it('text-track overlap is ALLOWED (captions case — TRACK_OVERLAP_RULES.text=allow)', async () => {
    // Regression for the F1 review find: the reject guard must key on the canonical
    // TRACK_OVERLAP_RULES table, not `track.type !== 'audio'`. Real transcriber output
    // (Whisper VAD/hallucinated repeats) emits overlapping cues; add_captions places
    // each as a `title` clip on a text track and must not hard-abort on overlap.
    const t = (await call(world, 'add_track', { type: 'text' })).data as { trackId: string }
    await call(world, 'place_clip', {
      trackId: t.trackId,
      sourceType: 'title',
      sourceId: 'cue1',
      startTime: 0,
      duration: 3,
    })
    const overlappingCue = await call(world, 'place_clip', {
      trackId: t.trackId,
      sourceType: 'title',
      sourceId: 'cue2',
      startTime: 2,
      duration: 3,
    })
    expect(overlappingCue.success).toBe(true)
    expect(world.timeline!.tracks.find((tk) => tk.id === t.trackId)!.clips.length).toBe(2)
  })

  it('abutting (butt-joined) clips on a reject track do NOT count as overlap', async () => {
    const gfx = (await call(world, 'add_track', { type: 'graphics' })).data as { trackId: string }
    await call(world, 'place_clip', {
      trackId: gfx.trackId,
      sourceType: 'video',
      sourceId: 'a',
      startTime: 0,
      duration: 5,
    })
    const abut = await call(world, 'place_clip', {
      trackId: gfx.trackId,
      sourceType: 'video',
      sourceId: 'b',
      startTime: 5,
      duration: 5,
    })
    expect(abut.success).toBe(true)
  })

  it('audio overlap still spills to a free lane (unchanged behavior)', async () => {
    const a = (await call(world, 'add_track', { type: 'audio' })).data as { trackId: string }
    await call(world, 'place_clip', {
      trackId: a.trackId,
      sourceType: 'audio',
      sourceId: 'm1',
      startTime: 0,
      duration: 5,
    })
    const second = await call(world, 'place_clip', {
      trackId: a.trackId,
      sourceType: 'audio',
      sourceId: 'm2',
      startTime: 2,
      duration: 5,
    })
    expect(second.success).toBe(true)
    // The spill message wording varies ("routed to free lane <name>" / "spilled");
    // the behavior (occupied audio track spills) is what matters.
    expect(second.changes?.[0]?.description ?? '').toMatch(/routed to free lane|spilled|free audio lane/i)
  })
})

describe('Lane A · P1-11 remove_clip ripples linked siblings on OTHER tracks', () => {
  it('removing one half of an avatar A/V pair re-flows both tracks', async () => {
    const world = emptyWorld()
    // V track: [avatarVid @0..4 g1] [tailV @4..6]   A track: [avatarAud @0..4 g1] [tailA @4..6]
    const vTrack = track('V', 'video', [
      makeClip({ id: 'avatarVid', trackId: 'V', sourceType: 'avatar', startTime: 0, duration: 4, linkGroupId: 'g1' }),
      makeClip({ id: 'tailV', trackId: 'V', startTime: 4, duration: 2 }),
    ])
    const aTrack = track(
      'A',
      'audio',
      [
        makeClip({ id: 'avatarAud', trackId: 'A', sourceType: 'audio', startTime: 0, duration: 4, linkGroupId: 'g1' }),
        makeClip({ id: 'tailA', trackId: 'A', startTime: 4, duration: 2 }),
      ],
      1,
    )
    world.timeline = { tracks: [vTrack, aTrack] }

    const r = await call(world, 'clip', { op: 'remove', clipId: 'avatarVid' })
    expect(r.success).toBe(true)

    const byId = (id: string) => world.timeline!.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
    // both linked halves gone
    expect(byId('avatarVid')).toBeUndefined()
    expect(byId('avatarAud')).toBeUndefined()
    // BOTH tracks rippled their tail left to 0 (the bug: tailA stayed at 4)
    expect(byId('tailV')!.startTime).toBe(0)
    expect(byId('tailA')!.startTime).toBe(0)
  })

  it('single-clip removal still ripples its own track (no regression)', async () => {
    const world = emptyWorld()
    const vTrack = track('V', 'video', [
      makeClip({ id: 'c1', trackId: 'V', startTime: 0, duration: 3 }),
      makeClip({ id: 'c2', trackId: 'V', startTime: 3, duration: 2 }),
    ])
    world.timeline = { tracks: [vTrack] }
    const r = await call(world, 'clip', { op: 'remove', clipId: 'c1' })
    expect(r.success).toBe(true)
    const c2 = world.timeline!.tracks[0].clips.find((c) => c.id === 'c2')!
    expect(c2.startTime).toBe(0)
  })
})
