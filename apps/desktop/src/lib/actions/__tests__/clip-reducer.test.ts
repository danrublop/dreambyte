// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import type { Clip, Keyframe } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function makeClip(id: string, startTime: number, duration: number, keyframes: Keyframe[] = []): Clip {
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
    keyframes,
  }
}

function stateWithTrack(type: 'video' | 'audio' = 'video'): ProjectState {
  const scene = createDefaultScene()
  const state: ProjectState = {
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
  const { result } = dispatchSync(state, { type: 'track/add', params: { trackId: 'T', type } }, { source: 'user' })
  return result.state!
}

describe('clip/add', () => {
  it('inserts a clip onto a track', () => {
    const state = stateWithTrack()
    const clip = makeClip('c1', 0, 5)
    const { result } = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].clips.length).toBe(1)
  })

  it('rejects overlap on video tracks (TRACK_OVERLAP_RULES = reject)', () => {
    let state = stateWithTrack('video')
    const first = makeClip('c1', 0, 5)
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: first } },
      { source: 'user' },
    ).result.state!
    const second = makeClip('c2', 3, 5) // overlaps [0, 5)
    const { result } = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c2', clip: second } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OVERLAP_DETECTED')
  })

  it('allows overlap on audio tracks (TRACK_OVERLAP_RULES = allow)', () => {
    let state = stateWithTrack('audio')
    const first = makeClip('c1', 0, 5)
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: first } },
      { source: 'user' },
    ).result.state!
    const second = makeClip('c2', 3, 5)
    const { result } = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c2', clip: second } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].clips.length).toBe(2)
  })

  it('rejects adds to a locked track', () => {
    const state = stateWithTrack('video')
    state.project.timeline!.tracks[0].locked = true
    const { result } = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1', 0, 5) } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TRACK_LOCKED')
  })
})

describe('clip/move', () => {
  it('changes startTime within the same track', () => {
    let state = stateWithTrack('video')
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1', 0, 5) } },
      { source: 'user' },
    ).result.state!
    const { result } = dispatchSync(
      state,
      { type: 'clip/move', params: { clipId: 'c1', startTime: 10 } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.timeline!.tracks[0].clips[0].startTime).toBe(10)
  })

  it('rejects when destination overlaps', () => {
    let state = stateWithTrack('video')
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'a', clip: makeClip('a', 0, 5) } },
      { source: 'user' },
    ).result.state!
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'b', clip: makeClip('b', 10, 5) } },
      { source: 'user' },
    ).result.state!
    const { result } = dispatchSync(
      state,
      { type: 'clip/move', params: { clipId: 'b', startTime: 3 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OVERLAP_DETECTED')
  })
})

describe('clip/trim', () => {
  it('updates trimStart / trimEnd / duration', () => {
    let state = stateWithTrack('video')
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1', 0, 10) } },
      { source: 'user' },
    ).result.state!
    const { result } = dispatchSync(
      state,
      { type: 'clip/trim', params: { clipId: 'c1', trimStart: 1, duration: 5 } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const c = result.state!.project.timeline!.tracks[0].clips[0]
    expect(c.trimStart).toBe(1)
    expect(c.duration).toBe(5)
  })

  it('rejects duration <= 0', () => {
    let state = stateWithTrack('video')
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1', 0, 10) } },
      { source: 'user' },
    ).result.state!
    const { result } = dispatchSync(
      state,
      { type: 'clip/trim', params: { clipId: 'c1', duration: 0 } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_TIME_RANGE')
  })
})

describe('clip/split — keyframe redistribution', () => {
  const keyframes: Keyframe[] = [
    { time: 0, property: 'opacity', value: 0, easing: 'linear' },
    { time: 1, property: 'opacity', value: 0.5, easing: 'linear' }, // left half
    { time: 3, property: 'opacity', value: 0.75, easing: 'linear' }, // exact match at split (3s)
    { time: 5, property: 'opacity', value: 1, easing: 'linear' }, // right half
    { time: 9, property: 'opacity', value: 0, easing: 'linear' },
  ]

  function stateWithClip() {
    let state = stateWithTrack('video')
    state = dispatchSync(
      state,
      {
        type: 'clip/add',
        params: { trackId: 'T', clipId: 'c1', clip: makeClip('c1', 0, 10, keyframes) },
      },
      { source: 'user' },
    ).result.state!
    return state
  }

  it('property: total keyframe count = original + number of exact-match keyframes', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/split', params: { clipId: 'c1', time: 3, rightClipId: 'c1r' } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const clips = result.state!.project.timeline!.tracks[0].clips
    const total = clips.reduce((sum, c) => sum + c.keyframes.length, 0)
    const exactMatches = keyframes.filter((k) => k.time === 3).length
    expect(total).toBe(keyframes.length + exactMatches)
  })

  it('every keyframe lands on the half whose time-range contains its time', () => {
    const state = stateWithClip()
    const { result } = dispatchSync(
      state,
      { type: 'clip/split', params: { clipId: 'c1', time: 3, rightClipId: 'c1r' } },
      { source: 'user' },
    )
    const [left, right] = result.state!.project.timeline!.tracks[0].clips
    // Left clip is [0, 3) — keyframes have time < 3 (plus the exact-match copy)
    for (const kf of left.keyframes) expect(kf.time).toBeLessThanOrEqual(3)
    // Right clip is [3, 10) — keyframes are rebased so time = original - 3
    for (const kf of right.keyframes) {
      expect(kf.time).toBeGreaterThanOrEqual(0)
      expect(kf.time).toBeLessThan(7) // (10 - 3)
    }
  })

  it('rejects split times outside the clip', () => {
    const state = stateWithClip()
    const out = dispatchSync(
      state,
      { type: 'clip/split', params: { clipId: 'c1', time: 999, rightClipId: 'r' } },
      { source: 'user' },
    )
    expect(out.result.success).toBe(false)
    expect(out.result.error?.code).toBe('INVALID_TIME_RANGE')
  })

  // Regression: the left-half trimEnd was computed by a no-op ternary whose
  // branches were identical, so it could extend past the source's trimmed end.
  // It must clamp to the original trimEnd.
  it('caps the left half trimEnd at the source trimEnd', () => {
    let state = stateWithTrack('video')
    // Split point in source-time (0 + 8/1 = 8) lands past trimEnd (5).
    const clip: Clip = { ...makeClip('c1', 0, 10), trimStart: 0, trimEnd: 5, speed: 1 }
    state = dispatchSync(state, { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip } }, { source: 'user' })
      .result.state!
    const { result } = dispatchSync(
      state,
      { type: 'clip/split', params: { clipId: 'c1', time: 8, rightClipId: 'c1r' } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const [left] = result.state!.project.timeline!.tracks[0].clips
    expect(left.trimEnd).toBe(5) // Math.min(0 + 8*1, 5), not the uncapped 8
  })

  // Regression: trim points are SOURCE seconds while split
  // offsets are PLAYBACK seconds — source = playback × speed. The reducer
  // DIVIDED by speed, so at 2x a 4s-playback split consumed only 2s of
  // source: the left half ended at source 2s while the right half started
  // at source 2s — but playback resumed as if 8s of source had elapsed,
  // silently duplicating media around the cut (and diverging from the
  // agent split tool, which always multiplied).
  it('split on a 2x-speed clip maps playback offset to source offset by MULTIPLYING', () => {
    let state = stateWithTrack('video')
    // 16s of source (trim 0–16) at 2x → 8s playback duration.
    const clip: Clip = { ...makeClip('c1', 0, 8), trimStart: 0, trimEnd: 16, speed: 2 }
    state = dispatchSync(state, { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip } }, { source: 'user' })
      .result.state!
    const { result } = dispatchSync(
      state,
      { type: 'clip/split', params: { clipId: 'c1', time: 4, rightClipId: 'c1r' } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const [left, right] = result.state!.project.timeline!.tracks[0].clips
    // 4s of playback at 2x consumes 8s of source.
    expect(left.trimEnd).toBe(8)
    expect(right.trimStart).toBe(8)
    // Halves butt up with no source gap or overlap.
    expect(left.duration).toBe(4)
    expect(right.duration).toBe(4)
  })

  it('split at speed 1 is unchanged (source offset == playback offset)', () => {
    let state = stateWithTrack('video')
    const clip: Clip = { ...makeClip('c1', 0, 10), trimStart: 2, trimEnd: 12, speed: 1 }
    state = dispatchSync(state, { type: 'clip/add', params: { trackId: 'T', clipId: 'c1', clip } }, { source: 'user' })
      .result.state!
    const { result } = dispatchSync(
      state,
      { type: 'clip/split', params: { clipId: 'c1', time: 6, rightClipId: 'c1r' } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    const [left, right] = result.state!.project.timeline!.tracks[0].clips
    expect(left.trimEnd).toBe(8) // 2 + 6×1
    expect(right.trimStart).toBe(8)
  })
})

describe('clip/remove — inverse (undo) restores everything', () => {
  it('restores a removed scene clip and its scene on inverse', () => {
    let state = stateWithTrack('video')
    const sceneId = state.scenes[0].id
    // A scene clip references its scene via sourceId; removing it deletes the scene.
    const sceneClip: Clip = { ...makeClip('sc1', 0, 5), sourceType: 'scene', sourceId: sceneId }
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'sc1', clip: sceneClip } },
      { source: 'user' },
    ).result.state!

    const { result: removed } = dispatchSync(
      state,
      { type: 'clip/remove', params: { clipId: 'sc1' } },
      { source: 'user' },
    )
    expect(removed.success).toBe(true)
    expect(removed.state!.scenes.find((s) => s.id === sceneId)).toBeUndefined()
    expect(removed.state!.project.timeline!.tracks.flatMap((t) => t.clips).find((c) => c.id === 'sc1')).toBeUndefined()
    expect(removed.inverseAction?.type).toBe('agent/applyRun')

    const { result: undone } = dispatchSync(removed.state!, removed.inverseAction!, { source: 'replay' })
    expect(undone.success).toBe(true)
    expect(undone.state!.scenes.find((s) => s.id === sceneId)).toBeTruthy()
    expect(undone.state!.project.timeline!.tracks.flatMap((t) => t.clips).find((c) => c.id === 'sc1')).toBeTruthy()
  })

  it('re-homes sceneGraph.startSceneId when the start scene is deleted via its clip (parity with scene/delete)', () => {
    const a = { ...createDefaultScene(), id: 'scene-a' }
    const b = { ...createDefaultScene(), id: 'scene-b' }
    const project = createDefaultProject([a, b]) // startSceneId = scene-a, edge a->b
    expect(project.sceneGraph.startSceneId).toBe('scene-a')
    project.timeline = {
      tracks: [
        {
          id: 'T',
          name: 'Scenes',
          type: 'scene',
          muted: false,
          locked: false,
          position: 0,
          clips: [{ ...makeClip('sc-a', 0, 5), sourceType: 'scene', sourceId: 'scene-a' }],
        },
      ],
    }
    const state: ProjectState = {
      scenes: [a, b],
      globalStyle: {
        presetId: null,
        palette: ['#000', '#111', '#222', '#333'],
        duration: 8,
      } as unknown as ProjectState['globalStyle'],
      project,
      selectedSceneId: 'scene-a',
      uiEditingLayerId: null,
    }
    const { result } = dispatchSync(state, { type: 'clip/remove', params: { clipId: 'sc-a' } }, { source: 'user' })
    expect(result.success).toBe(true)
    expect(result.state!.scenes.map((s) => s.id)).toEqual(['scene-b'])
    const g = result.state!.project.sceneGraph
    expect(g.startSceneId).toBe('scene-b') // re-homed off the deleted start scene
    expect(g.nodes.map((n) => n.id)).toEqual(['scene-b'])
  })

  it("removing a scene clip also cascades the scene's avatar clips (parity with scene/delete)", () => {
    let state = stateWithTrack('video')
    const sceneId = state.scenes[0].id
    state.scenes[0].aiLayers = [
      { id: 'av1', type: 'avatar' } as unknown as (typeof state.scenes)[0]['aiLayers'][number],
    ]
    // Scene clip + the scene's avatar video/audio clips (linkgroup-keyed).
    const sceneClip: Clip = { ...makeClip('sc1', 0, 5), sourceType: 'scene', sourceId: sceneId }
    const avatarVideo: Clip = {
      ...makeClip('avv', 6, 5),
      sourceType: 'avatar',
      sourceId: 'av1',
      linkGroupId: 'avatar:av1',
    }
    const avatarAudio: Clip = {
      ...makeClip('ava', 12, 5),
      sourceType: 'audio',
      sourceId: 'avatar-audio:av1',
      linkGroupId: 'avatar:av1',
    }
    for (const clip of [sceneClip, avatarVideo, avatarAudio]) {
      state = dispatchSync(
        state,
        { type: 'clip/add', params: { trackId: 'T', clipId: clip.id, clip } },
        { source: 'user' },
      ).result.state!
    }

    const { result: removed } = dispatchSync(
      state,
      { type: 'clip/remove', params: { clipId: 'sc1' } },
      { source: 'user' },
    )
    expect(removed.success).toBe(true)
    expect(removed.state!.project.timeline!.tracks.flatMap((t) => t.clips)).toHaveLength(0) // all three gone
  })

  it('removing a mirrored title clip deletes the scene.textOverlays entry (shared cascade, v5 F3)', () => {
    let state = stateWithTrack('video')
    const sceneId = state.scenes[0].id
    state.scenes[0].textOverlays = [
      { id: 'ov1', content: 'Hello', duration: 2, delay: 1 },
      { id: 'ov-keep', content: 'Keep', duration: 2, delay: 3 },
    ] as unknown as (typeof state.scenes)[0]['textOverlays']
    // Mirrored title clip: linkGroupId `text:<overlayId>`, sourceId = overlay id
    // (see syncTimelineFromScenes text mirroring).
    const titleClip: Clip = {
      ...makeClip('ttl', 1, 2),
      sourceType: 'title',
      sourceId: 'ov1',
      linkGroupId: 'text:ov1',
    }
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'ttl', clip: titleClip } },
      { source: 'user' },
    ).result.state!

    const { result } = dispatchSync(state, { type: 'clip/remove', params: { clipId: 'ttl' } }, { source: 'user' })
    expect(result.success).toBe(true)
    // Overlay gone from the scene (no resurrection on the next sync) + clip gone.
    expect(result.state!.scenes[0].textOverlays.map((o) => o.id)).toEqual(['ov-keep'])
    expect(result.state!.project.timeline!.tracks.flatMap((t) => t.clips)).toHaveLength(0)
    // Overlays are baked into scene HTML → regen effect for the owning scene.
    expect(result.effects).toContainEqual({ kind: 'regenerate-scene-html', sceneId })
  })

  it('restores a removed plain clip on inverse', () => {
    let state = stateWithTrack('video')
    state = dispatchSync(
      state,
      {
        type: 'clip/add',
        params: { trackId: 'T', clipId: 'p1', clip: { ...makeClip('p1', 0, 4), sourceType: 'video', sourceId: 'x' } },
      },
      { source: 'user' },
    ).result.state!

    const { result: removed } = dispatchSync(
      state,
      { type: 'clip/remove', params: { clipId: 'p1' } },
      { source: 'user' },
    )
    expect(removed.success).toBe(true)
    expect(removed.state!.project.timeline!.tracks.flatMap((t) => t.clips)).toHaveLength(0)

    const { result: undone } = dispatchSync(removed.state!, removed.inverseAction!, { source: 'replay' })
    expect(undone.success).toBe(true)
    expect(undone.state!.project.timeline!.tracks.flatMap((t) => t.clips).find((c) => c.id === 'p1')).toBeTruthy()
  })
})

describe('clip/rippleDelete', () => {
  it('removes the clip and shifts trailing clips left by its duration', () => {
    let state = stateWithTrack('video')
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'a', clip: makeClip('a', 0, 5) } },
      { source: 'user' },
    ).result.state!
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'b', clip: makeClip('b', 5, 3) } },
      { source: 'user' },
    ).result.state!
    state = dispatchSync(
      state,
      { type: 'clip/add', params: { trackId: 'T', clipId: 'c', clip: makeClip('c', 8, 2) } },
      { source: 'user' },
    ).result.state!

    const { result } = dispatchSync(state, { type: 'clip/rippleDelete', params: { clipId: 'b' } }, { source: 'user' })
    expect(result.success).toBe(true)
    const clips = result.state!.project.timeline!.tracks[0].clips
    expect(clips.map((c) => c.id)).toEqual(['a', 'c'])
    expect(clips.find((c) => c.id === 'c')!.startTime).toBe(5) // 8 - 3
  })
})
