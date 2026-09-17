// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { REMOVE_TRACK, SET_TRACK_PROPS, CLIP, MARKER, TIMELINE_TOOLS, ALL_TOOLS } from '@/lib/agents/tools'
import { executeTool } from '@/lib/agents/tool-executor'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

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

describe('P2-tools: new tool definitions', () => {
  it('each new tool def has a non-empty name and input_schema with required fields', () => {
    for (const def of [REMOVE_TRACK, SET_TRACK_PROPS, CLIP, MARKER]) {
      expect(def.name).toMatch(/^[a-z_]+$/)
      expect((def.description ?? '').length).toBeGreaterThan(0)
      expect(def.input_schema?.type).toBe('object')
      expect(Array.isArray(def.input_schema?.required)).toBe(true)
    }
  })

  it('all P2 tool defs are wired into TIMELINE_TOOLS', () => {
    const names = TIMELINE_TOOLS.map((t) => t.name)
    for (const name of ['remove_track', 'set_track_props', 'clip', 'marker']) {
      expect(names).toContain(name)
    }
  })

  it('all P2 tool defs are in ALL_TOOLS so the agent can see them', () => {
    const names = ALL_TOOLS.map((t) => t.name)
    for (const name of ['remove_track', 'set_track_props', 'clip', 'marker']) {
      expect(names).toContain(name)
    }
  })
})

describe('P2-tools: executor branches', () => {
  let world: WorldStateMutable
  beforeEach(() => {
    world = emptyWorld()
  })
  afterEach(() => {
    world.timeline = undefined
  })

  async function call(name: string, args: Record<string, unknown>) {
    return executeTool(name, args, world)
  }

  it('add_track → remove_track round-trip', async () => {
    await call('init_timeline', {})
    const add = await call('add_track', { type: 'graphics', name: 'GFX' })
    expect(add.success).toBe(true)
    const trackId = (add.data as { trackId: string }).trackId
    const remove = await call('remove_track', { trackId })
    expect(remove.success).toBe(true)
    expect(world.timeline!.tracks.find((t) => t.id === trackId)).toBeUndefined()
  })

  it('set_track_props flips lock / mute / solo / hide flags', async () => {
    await call('init_timeline', {})
    const trackId = (await call('add_track', { type: 'audio' })).data as { trackId: string }
    const id = trackId.trackId
    expect((await call('set_track_props', { trackId: id, locked: true })).success).toBe(true)
    expect(world.timeline!.tracks.find((t) => t.id === id)?.locked).toBe(true)
    // unlock first so the volume/mute etc. below aren't rejected by the locked guard
    expect((await call('set_track_props', { trackId: id, locked: false, muted: true })).success).toBe(true)
    expect(world.timeline!.tracks.find((t) => t.id === id)?.muted).toBe(true)
    expect((await call('set_track_props', { trackId: id, solo: true })).success).toBe(true)
    expect(world.timeline!.tracks.find((t) => t.id === id)?.solo).toBe(true)
    expect((await call('set_track_props', { trackId: id, hidden: true })).success).toBe(true)
    expect(world.timeline!.tracks.find((t) => t.id === id)?.hidden).toBe(true)
  })

  it('set_track_props sets volume + pan (and rejects a locked track)', async () => {
    await call('init_timeline', {})
    const id = ((await call('add_track', { type: 'audio' })).data as { trackId: string }).trackId
    expect((await call('set_track_props', { trackId: id, volume: 3 })).success).toBe(true)
    expect(world.timeline!.tracks.find((t) => t.id === id)?.volume).toBe(2) // clamped 0..2
    expect((await call('set_track_props', { trackId: id, pan: -2 })).success).toBe(true)
    expect(world.timeline!.tracks.find((t) => t.id === id)?.pan).toBe(-1) // clamped -1..1
    await call('set_track_props', { trackId: id, locked: true })
    expect((await call('set_track_props', { trackId: id, volume: 0.5 })).success).toBe(false) // locked
  })

  it('set_clip_props (fade) rejects when sum exceeds duration', async () => {
    await call('init_timeline', {})
    const trackId = ((await call('add_track', { type: 'video' })).data as { trackId: string }).trackId
    const sceneId = world.scenes[0].id
    const place = await call('place_clip', {
      trackId,
      sourceType: 'scene',
      sourceId: sceneId,
      label: 'c1',
      startTime: 0,
      duration: 5,
    })
    expect(place.success).toBe(true)
    const clipId = (place.data as { clipId: string }).clipId
    const fail = await call('clip', { op: 'props', clipId, fadeIn: 3, fadeOut: 3 })
    expect(fail.success).toBe(false)
    const good = await call('clip', { op: 'props', clipId, fadeIn: 1, fadeOut: 2 })
    expect(good.success).toBe(true)
    // init_timeline pre-populates the default Main track with one clip per
    // scene; the clip we placed lives on the new graphics track. Find by id.
    const clip = world.timeline!.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!
    expect(clip.fadeIn).toBe(1)
    expect(clip.fadeOut).toBe(2)
  })

  it('split_clip fails honestly on a SCENE clip — nothing downstream supports two clips per scene (v5 F1)', async () => {
    await call('init_timeline', {})
    // init_timeline mints one scene clip per scene on the Main track.
    const sceneClip = world.timeline!.tracks[0].clips.find((c) => c.sourceType === 'scene')!
    const result = await call('clip', { op: 'split', clipId: sceneClip.id, atTime: sceneClip.duration / 2 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Cannot split scene clip/)
    // Suggests the supported alternatives instead of a silent no-op.
    expect(result.error).toMatch(/trim_clip|duplicate_scene/)
    // The timeline is untouched — still exactly one clip for the scene.
    const clips = world.timeline!.tracks.flatMap((t) => t.clips).filter((c) => c.sourceId === sceneClip.sourceId)
    expect(clips).toHaveLength(1)
  })

  it('REGRESSION: split_clip still splits video clips after the scene guard', async () => {
    await call('init_timeline', {})
    const trackId = ((await call('add_track', { type: 'video' })).data as { trackId: string }).trackId
    const place = await call('place_clip', {
      trackId,
      sourceType: 'video',
      sourceId: 'media-1',
      label: 'v',
      startTime: 0,
      duration: 8,
    })
    expect(place.success).toBe(true)
    const clipId = (place.data as { clipId: string }).clipId
    const result = await call('clip', { op: 'split', clipId, atTime: 3 })
    expect(result.success).toBe(true)
    const track = world.timeline!.tracks.find((t) => t.id === trackId)!
    expect(track.clips).toHaveLength(2)
  })
})

describe("inspect(kind:'editor')", () => {
  it('returns the world.editorState snapshot when present', async () => {
    const world = emptyWorld()
    world.editorState = {
      selectedSceneId: 'scene-xyz',
      selectedClipIds: ['c1', 'c2'],
      currentTime: 3.5,
      isPlaying: true,
      totalDuration: 12,
      timelineZoom: 0.7,
      capturedAt: '2026-05-12T00:00:00.000Z',
    }
    const result = await executeTool('inspect', { kind: 'editor' }, world)
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      selectedSceneId: 'scene-xyz',
      selectedClipIds: ['c1', 'c2'],
      currentTime: 3.5,
      isPlaying: true,
      totalDuration: 12,
      timelineZoom: 0.7,
    })
  })

  it('returns a zeroed shape with a hint when no snapshot was captured', async () => {
    const world = emptyWorld()
    const result = await executeTool('inspect', { kind: 'editor' }, world)
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.selectedSceneId).toBeNull()
    expect(data.selectedClipIds).toEqual([])
    expect(data.isPlaying).toBe(false)
    expect(typeof data._hint).toBe('string')
  })
})

describe('remove_clip: ripple semantics', () => {
  let world: WorldStateMutable
  beforeEach(() => {
    world = emptyWorld()
  })

  async function call(name: string, args: Record<string, unknown>) {
    return executeTool(name, args, world)
  }

  async function seedThreeClipsOnTrack() {
    await call('init_timeline', {})
    const trackId = ((await call('add_track', { type: 'video', name: 'V1' })).data as { trackId: string }).trackId
    // VIDEO clips, not scene clips: remove_clip refuses scene clips (v6 B3 —
    // they must go through delete_scene so the scene/graph/HTML go too). The
    // ripple mechanics under test are identical for any non-scene clip.
    const clips: string[] = []
    for (const [start, dur, label] of [
      [0, 2, 'c1'],
      [2, 3, 'c2'],
      [5, 4, 'c3'],
    ] as const) {
      const res = await call('place_clip', {
        trackId,
        sourceType: 'video',
        sourceId: `media-${label}`,
        label,
        startTime: start,
        duration: dur,
      })
      clips.push((res.data as { clipId: string }).clipId)
    }
    return { trackId, clipIds: clips }
  }

  it('shifts subsequent clips on the same track left by the removed duration', async () => {
    const { trackId, clipIds } = await seedThreeClipsOnTrack()
    const [, c2, c3] = clipIds
    const result = await call('clip', { op: 'remove', clipId: c2 })
    expect(result.success).toBe(true)

    const track = world.timeline!.tracks.find((t) => t.id === trackId)!
    expect(track.clips.length).toBe(2)
    const c3After = track.clips.find((c) => c.id === c3)!
    // c2 had duration 3 starting at t=2, c3 was at t=5; after ripple c3 starts at t=2
    expect(c3After.startTime).toBe(2)
  })

  it('does not shift clips on other tracks', async () => {
    const { clipIds } = await seedThreeClipsOnTrack()
    // Add a second video track with a clip at t=4 so we can verify isolation.
    const otherTrackId = (
      (await call('add_track', { type: 'video', name: 'V2' })).data as {
        trackId: string
      }
    ).trackId
    const sceneId = world.scenes[0].id
    const otherClip = await call('place_clip', {
      trackId: otherTrackId,
      sourceType: 'scene',
      sourceId: sceneId,
      label: 'other',
      startTime: 4,
      duration: 2,
    })
    const otherClipId = (otherClip.data as { clipId: string }).clipId

    await call('clip', { op: 'remove', clipId: clipIds[1] })

    const otherTrack = world.timeline!.tracks.find((t) => t.id === otherTrackId)!
    const otherAfter = otherTrack.clips.find((c) => c.id === otherClipId)!
    expect(otherAfter.startTime).toBe(4)
  })

  it('does not shift clips that started before the removed clip', async () => {
    const { trackId, clipIds } = await seedThreeClipsOnTrack()
    const [c1, , c3] = clipIds
    await call('clip', { op: 'remove', clipId: c3 })
    const track = world.timeline!.tracks.find((t) => t.id === trackId)!
    const c1After = track.clips.find((c) => c.id === c1)!
    expect(c1After.startTime).toBe(0)
  })

  it('returns an error when clipId does not exist', async () => {
    await seedThreeClipsOnTrack()
    const result = await call('clip', { op: 'remove', clipId: 'does-not-exist' })
    expect(result.success).toBe(false)
  })
})

// ── G3: timeline markers — agent-addressable ─────────────────────────────────

describe('G3: timeline marker tools', () => {
  let world: WorldStateMutable
  beforeEach(() => {
    world = emptyWorld()
  })
  afterEach(() => {
    world.timeline = undefined
  })
  async function call(name: string, args: Record<string, unknown>) {
    return executeTool(name, args, world)
  }

  it('add → remove round-trip', async () => {
    await call('init_timeline', {})
    const add = await call('marker', { action: 'add', time: 4.5, label: 'Chorus', color: '#ff0000' })
    expect(add.success).toBe(true)
    expect(world.timeline!.markers).toHaveLength(1)
    expect(world.timeline!.markers![0]).toMatchObject({ time: 4.5, label: 'Chorus', color: '#ff0000' })

    const markerId = world.timeline!.markers![0].id
    const remove = await call('marker', { action: 'remove', markerId })
    expect(remove.success).toBe(true)
    expect(world.timeline!.markers).toHaveLength(0)
  })

  it('rejects negative/invalid time and unknown marker ids', async () => {
    await call('init_timeline', {})
    expect((await call('marker', { action: 'add', time: -1 })).success).toBe(false)
    expect((await call('marker', { action: 'add' })).success).toBe(false)
    expect((await call('marker', { action: 'remove', markerId: 'nope' })).success).toBe(false)
  })

  it('REGRESSION: track mutations preserve markers (setTimeline merges, not replaces)', async () => {
    await call('init_timeline', {})
    await call('marker', { action: 'add', time: 2, label: 'keep me' })
    // Any track op used to pass `{ tracks }` as the WHOLE timeline, wiping
    // markers/inPoint/outPoint from world state.
    const add = await call('add_track', { type: 'graphics' })
    const trackId = (add.data as { trackId: string }).trackId
    await call('set_track_props', { trackId, locked: true })
    expect(world.timeline!.markers).toHaveLength(1)
    expect(world.timeline!.markers![0].label).toBe('keep me')
    // And marker ops preserve tracks symmetrically.
    expect(world.timeline!.tracks.length).toBeGreaterThan(0)
  })

  it('marker tool def is wired into TIMELINE_TOOLS and ALL_TOOLS', async () => {
    const timelineNames = TIMELINE_TOOLS.map((t) => t.name)
    const allNames = ALL_TOOLS.map((t) => t.name)
    expect(timelineNames).toContain('marker')
    expect(allNames).toContain('marker')
  })
})

// ── G2: cut_by_transcript ─────────────────────────────────────────────────────

describe('G2: cut_by_transcript tool', () => {
  let world: WorldStateMutable
  beforeEach(async () => {
    world = emptyWorld()
    const { setCaptionTranscriber } = await import('@/lib/edit-engines/caption-transcriber')
    setCaptionTranscriber({
      transcribe: async () => ({
        srt: `1\n00:00:01,000 --> 00:00:03,000\nHello everyone, welcome back.\n\n2\n00:00:03,500 --> 00:00:06,000\nToday we look at the quarterly numbers.\n`,
        language: 'en',
      }),
    })
  })
  afterEach(async () => {
    world.timeline = undefined
    const { setCaptionTranscriber } = await import('@/lib/edit-engines/caption-transcriber')
    setCaptionTranscriber(null)
  })
  async function call(name: string, args: Record<string, unknown>) {
    return executeTool(name, args, world)
  }

  it('preview reports matches and cuts nothing', async () => {
    await call('init_timeline', {})
    const clipId = world.timeline!.tracks[0].clips[0].id
    const clipCountBefore = world.timeline!.tracks[0].clips.length
    const r = await call('auto_cut', { mode: 'transcript', clipId, text: 'quarterly numbers', preview: true })
    expect(r.success).toBe(true)
    expect((r.data as { matches: unknown[] }).matches).toHaveLength(1)
    expect(world.timeline!.tracks[0].clips).toHaveLength(clipCountBefore)
  })

  it('apply executes the split/remove plan against the world', async () => {
    await call('init_timeline', {})
    // Target a VIDEO clip — the tool's real use case (footage with speech).
    // (Scene clips can also split now, but cut_by_transcript is for footage.)
    const trackId = ((await call('add_track', { type: 'video' })).data as { trackId: string }).trackId
    const place = await call('place_clip', {
      trackId,
      sourceType: 'video',
      sourceId: 'media-talk',
      label: 'talk',
      startTime: 0,
      duration: 8,
    })
    const clipId = (place.data as { clipId: string }).clipId
    const r = await call('auto_cut', { mode: 'transcript', clipId, text: 'quarterly numbers' })
    expect(r.success).toBe(true)
    expect((r.data as { applied: number }).applied).toBeGreaterThan(0)
    expect((r.data as { savedSeconds: number }).savedSeconds).toBeGreaterThan(0)
  })

  it('no match → honest no-op, never a guess', async () => {
    await call('init_timeline', {})
    const clipId = world.timeline!.tracks[0].clips[0].id
    const r = await call('auto_cut', { mode: 'transcript', clipId, text: 'words never spoken' })
    expect(r.success).toBe(true)
    expect((r.data as { matches: unknown[] }).matches).toHaveLength(0)
  })

  it('rejects empty text and unknown clips', async () => {
    await call('init_timeline', {})
    const clipId = world.timeline!.tracks[0].clips[0].id
    expect((await call('auto_cut', { mode: 'transcript', clipId, text: '  ' })).success).toBe(false)
    expect((await call('auto_cut', { mode: 'transcript', clipId: 'nope', text: 'x' })).success).toBe(false)
  })
})

// ── G1: apply_color(look) ─────────────────────────────────────────────────────

describe('G1: apply_color(look) — the named-look path', () => {
  let world: WorldStateMutable
  beforeEach(() => {
    world = emptyWorld()
  })
  afterEach(() => {
    world.timeline = undefined
  })
  async function call(name: string, args: Record<string, unknown>) {
    return executeTool(name, args, world)
  }
  const clipFilters = () => world.timeline!.tracks[0].clips[0].filters

  it('applies a grade and switching grades replaces it (no noir bleed into warm)', async () => {
    await call('init_timeline', {})
    const clipId = world.timeline!.tracks[0].clips[0].id
    expect((await call('apply_color', { clipIds: [clipId], look: 'noir' })).success).toBe(true)
    expect(clipFilters().some((f) => f.type === 'grayscale')).toBe(true)

    expect((await call('apply_color', { clipIds: [clipId], look: 'warm' })).success).toBe(true)
    expect(clipFilters().some((f) => f.type === 'grayscale')).toBe(false) // replaced, not stacked
    expect(clipFilters().some((f) => f.type === 'sepia')).toBe(true)
  })

  it("preserves non-grade filters (blur) and 'none' clears the grade only", async () => {
    await call('init_timeline', {})
    const clipId = world.timeline!.tracks[0].clips[0].id
    await call('clip', { op: 'props', clipId, filter: { filterType: 'blur', value: 2 } })
    await call('apply_color', { clipIds: [clipId], look: 'cinematic' })
    expect(clipFilters().some((f) => f.type === 'blur')).toBe(true)

    const r = await call('apply_color', { clipIds: [clipId], look: 'none' })
    expect(r.success).toBe(true)
    expect(clipFilters()).toHaveLength(1) // only the blur survives
    expect(clipFilters()[0].type).toBe('blur')
  })

  it('intensity scales the look; unknown grade fails with the available list', async () => {
    await call('init_timeline', {})
    const clipId = world.timeline!.tracks[0].clips[0].id
    const r = await call('apply_color', { clipIds: [clipId], look: 'vivid', lookIntensity: 0.5 })
    expect(r.success).toBe(true)
    const sat = clipFilters().find((f) => f.type === 'saturate')!
    expect(sat.value).toBeCloseTo(1.16, 2) // 1 + (1.32-1)*0.5

    const bad = await call('apply_color', { clipIds: [clipId], look: 'vhs' })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('cinematic')
  })
})
