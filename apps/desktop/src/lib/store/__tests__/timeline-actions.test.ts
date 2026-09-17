import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTimelineActions, withTracks } from '../timeline-actions'
import { createActionDispatch } from '../action-dispatch'
import type { Track, Clip, Timeline } from '../../types'

// ── Minimal helpers ──────────────────────────────────────────────────────────

function makeClip(overrides: Partial<Clip> & { id: string; trackId: string; sourceId: string }): Clip {
  return {
    sourceType: 'scene',
    label: 'Test',
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
    ...overrides,
  }
}

function makeTrack(overrides: Partial<Track> & { id: string }): Track {
  return {
    name: 'V1',
    type: 'video',
    clips: [],
    muted: false,
    locked: false,
    position: 0,
    ...overrides,
  }
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    scenes: [],
    project: { timeline: null, updatedAt: '' },
    // Fields read by the real action dispatcher (projectSlice). Defaulted so
    // dispatchAction can run the reducers against this mock store.
    globalStyle: null,
    selectedSceneId: null,
    uiEditingLayerId: null,
    selectedClipIds: [],
    projectActiveBranchId: null,
    scheduleSaveProjectToDb: vi.fn(),
    initTimeline: vi.fn(),
    updateScene: vi.fn(),
    // Action-layer emit stub: real impl persists to action_log + WAL via IPC.
    // Tests don't care about the side-effect, only that the call doesn't throw.
    recordUserAction: vi.fn(),
    // Legacy undo-snapshot stub. Real impl captures state into _undoStack.
    _pushUndo: vi.fn(),
    // P6.7 — visual flash stub.
    flashClip: vi.fn(),
    ...overrides,
  }
}

function makeActions(initialState: ReturnType<typeof makeState>) {
  // Heterogeneous mock store: holds makeState fields + the timeline actions +
  // the real dispatcher slice. Typed `any` so test bodies can read dynamic
  // fields (project.timeline.tracks, clipClipboard, etc.) without per-line casts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any = initialState
  const mockGet = () => state
  // Zustand's set accepts BOTH an updater fn and a partial object; the real
  // action dispatcher uses the object form (set({ scenes, project, ... })),
  // so the mock must handle both.
  const mockSet = vi.fn((arg: ((s: typeof state) => Partial<typeof state>) | Partial<typeof state>) => {
    const next = typeof arg === 'function' ? (arg as (s: typeof state) => Partial<typeof state>)(state) : arg
    state = { ...state, ...next }
  })
  // Real dispatcher so clip/scene/keyframe actions run the actual reducers
  // (timeline actions delegate source mutations to dispatchAction). We pull
  // ONLY dispatchAction + its stack fields — recordUserAction / _pushUndo stay
  // the makeState stubs that other tests assert against.
  const dispatch = createActionDispatch(mockSet as any, mockGet as any)
  const actions = createTimelineActions(mockSet as any, mockGet as any)
  // Wire actions back into state so get() calls like get().initTimeline() work
  state = {
    _actionUndoStack: [],
    _actionRedoStack: [],
    currentAgentRunId: null,
    ...state,
    ...actions,
    dispatchAction: dispatch.dispatchAction,
  }
  return { actions, mockSet, getState: () => state }
}

// ── syncTimelineFromScenes ───────────────────────────────────────────────────

describe('syncTimelineFromScenes', () => {
  it('preserves an existing scene clip position (timeline-authoritative, no repack)', () => {
    // Timeline-authoritative: the clip owns its startTime. A clip at startTime:10
    // STAYS at 10 (a leading gap is first-class), it is NOT re-laid to 0. Sync
    // never repositions an existing clip — only materializes new / drops deleted.
    const v1Id = 'v1'
    const sceneId = 'scene-a'
    const clipId = 'clip-a'
    const existingClip = makeClip({ id: clipId, trackId: v1Id, sourceId: sceneId, startTime: 10, duration: 5 })
    const v1 = makeTrack({ id: v1Id, clips: [existingClip] })
    const state = makeState({
      scenes: [{ id: sceneId, duration: 5, name: 'A', audioLayer: null } as any],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const resultV1 = (getState().project as any).timeline.tracks.find((t: Track) => t.id === v1Id)
    const resultClip = resultV1.clips.find((c: Clip) => c.sourceId === sceneId)
    expect(resultClip.startTime).toBe(10) // position preserved — no gapless repack
    expect(resultClip.duration).toBe(5)
    expect(resultClip.id).toBe(clipId) // clip identity preserved
  })

  it('shortening a scene leaves a gap — later clips hold position (NLE edge-trim)', () => {
    // set_scene_duration(A, 4) on A(8)|B(8)|C(14): A shrinks in place to 4, and
    // B/C do NOT slide left — a 4s gap opens between A and B. Neighbours never
    // auto-reflow under timeline-authority (that was the scene-sequencer model).
    const v1Id = 'v1'
    const v1 = makeTrack({
      id: v1Id,
      clips: [
        makeClip({ id: 'cA', trackId: v1Id, sourceId: 'A', startTime: 0, duration: 8 }),
        makeClip({ id: 'cB', trackId: v1Id, sourceId: 'B', startTime: 8, duration: 6 }),
        makeClip({ id: 'cC', trackId: v1Id, sourceId: 'C', startTime: 14, duration: 10 }),
      ],
    })
    const state = makeState({
      // A's scene duration is now 4 (the edit already landed on the scene)
      scenes: [
        { id: 'A', duration: 4, name: 'A', audioLayer: null } as any,
        { id: 'B', duration: 6, name: 'B', audioLayer: null } as any,
        { id: 'C', duration: 10, name: 'C', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const clips = (getState().project as any).timeline.tracks
      .find((t: Track) => t.id === v1Id)
      .clips.filter((c: Clip) => c.sourceType === 'scene')
    const at = (sid: string) => clips.find((c: Clip) => c.sourceId === sid)
    expect(at('A').startTime).toBe(0)
    expect(at('A').duration).toBe(4) // shrank in place
    expect(at('B').startTime).toBe(8) // held — gap from 4..8
    expect(at('C').startTime).toBe(14) // held
  })

  it('lengthening a scene is clamped at the next clip — no overlap, no auto-shift', () => {
    // A(8) grown to 12 with B butted at 8: A cannot overlap B, so it butt-joins
    // (clamped to duration 8). B holds at 8. To truly extend A you'd move B.
    const v1Id = 'v1'
    const v1 = makeTrack({
      id: v1Id,
      clips: [
        makeClip({ id: 'cA', trackId: v1Id, sourceId: 'A', startTime: 0, duration: 8 }),
        makeClip({ id: 'cB', trackId: v1Id, sourceId: 'B', startTime: 8, duration: 6 }),
      ],
    })
    const state = makeState({
      scenes: [
        { id: 'A', duration: 12, name: 'A', audioLayer: null } as any, // grown 8 → 12
        { id: 'B', duration: 6, name: 'B', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const clips = (getState().project as any).timeline.tracks
      .find((t: Track) => t.id === v1Id)
      .clips.filter((c: Clip) => c.sourceType === 'scene')
    const at = (sid: string) => clips.find((c: Clip) => c.sourceId === sid)
    expect(at('A').duration).toBe(8) // clamped at B's start, no overlap
    expect(at('B').startTime).toBe(8) // held — never auto-pushed right
  })

  it('a bare state.scenes array reorder does NOT move existing clips', () => {
    // Timeline-authoritative: clip positions are owned by the timeline, not by
    // state.scenes order. Reordering the array alone (without moving clips) is
    // inert for existing clips — sequence reorder must go through a clip move.
    const v1Id = 'v1'
    const v1 = makeTrack({
      id: v1Id,
      clips: [
        makeClip({ id: 'cA', trackId: v1Id, sourceId: 'A', startTime: 0, duration: 8 }),
        makeClip({ id: 'cB', trackId: v1Id, sourceId: 'B', startTime: 8, duration: 6 }),
      ],
    })
    const state = makeState({
      scenes: [
        { id: 'B', duration: 6, name: 'B', audioLayer: null } as any,
        { id: 'A', duration: 8, name: 'A', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const clips = (getState().project as any).timeline.tracks
      .find((t: Track) => t.id === v1Id)
      .clips.filter((c: Clip) => c.sourceType === 'scene')
    const at = (sid: string) => clips.find((c: Clip) => c.sourceId === sid)
    expect(at('A').startTime).toBe(0) // unchanged by array reorder
    expect(at('B').startTime).toBe(8) // unchanged by array reorder
  })

  it('appends new scene clips after the last existing clip', () => {
    const v1Id = 'v1'
    const scene1Id = 'scene-1'
    const scene2Id = 'scene-2'
    const existingClip = makeClip({ id: 'c1', trackId: v1Id, sourceId: scene1Id, startTime: 0, duration: 8 })
    const v1 = makeTrack({ id: v1Id, clips: [existingClip] })
    const state = makeState({
      scenes: [
        { id: scene1Id, duration: 8, name: '1', audioLayer: null } as any,
        { id: scene2Id, duration: 6, name: '2', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const resultV1 = (getState().project as any).timeline.tracks.find((t: Track) => t.id === v1Id)
    const newClip = resultV1.clips.find((c: Clip) => c.sourceId === scene2Id)
    expect(newClip.startTime).toBe(8) // laid after the cursor reaches 8 (scene 1's duration)
    expect(newClip.duration).toBe(6)
  })

  it('anchors scene-owned narration to its scene clip preserved position', () => {
    // B carries narration; B's scene clip and its tts clip both sit at 8.
    // Timeline-authoritative: the scene clip holds 8, and the narration stays
    // anchored to that preserved start (8) — linked audio tracks its scene's
    // position, with no repack to 0.
    const v1Id = 'v1'
    const a1Id = 'a1'
    const v1 = makeTrack({
      id: v1Id,
      position: 0,
      clips: [
        makeClip({ id: 'cA', trackId: v1Id, sourceId: 'A', startTime: 0, duration: 8 }),
        makeClip({ id: 'cB', trackId: v1Id, sourceId: 'B', startTime: 8, duration: 6 }),
      ],
    })
    const a1 = makeTrack({
      id: a1Id,
      name: 'A1',
      type: 'audio',
      position: 1,
      clips: [makeClip({ id: 'tB', trackId: a1Id, sourceId: 'tts-B', sourceType: 'audio', startTime: 8, duration: 6 })],
    })
    const state = makeState({
      scenes: [
        { id: 'B', duration: 6, name: 'B', audioLayer: { tts: { text: 'hi' }, sfx: [] } } as any,
        { id: 'A', duration: 8, name: 'A', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1, a1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const tracks = (getState().project as any).timeline.tracks
    const sceneB = tracks.find((t: Track) => t.id === v1Id).clips.find((c: Clip) => c.sourceId === 'B')
    const audB = tracks.find((t: Track) => t.id === a1Id).clips.find((c: Clip) => c.sourceId === 'tts-B')
    expect(sceneB.startTime).toBe(8) // held its position (no repack)
    expect(audB.startTime).toBe(8) // narration anchored to its scene's start
    expect(audB.id).toBe('tB') // identity preserved
  })

  it('re-expands an auto-sized narration clip up to the audio length when its scene grows', () => {
    // Repro of the "audio outlives its clip" bug: narration was generated while
    // B was 6s, so its tts clip got pinned to 6 — then B grew to 12s. The audio
    // is 10s (tts.duration). An untrimmed tts clip (trimStart 0 / trimEnd null)
    // must track the scene-bounded audio length (10), not stay stuck at 6.
    const v1Id = 'v1'
    const a1Id = 'a1'
    const v1 = makeTrack({
      id: v1Id,
      position: 0,
      clips: [makeClip({ id: 'cB', trackId: v1Id, sourceId: 'B', startTime: 0, duration: 12 })],
    })
    const a1 = makeTrack({
      id: a1Id,
      name: 'A1',
      type: 'audio',
      position: 1,
      clips: [makeClip({ id: 'tB', trackId: a1Id, sourceId: 'tts-B', sourceType: 'audio', startTime: 0, duration: 6 })],
    })
    const state = makeState({
      scenes: [{ id: 'B', duration: 12, name: 'B', audioLayer: { tts: { text: 'hi', duration: 10 }, sfx: [] } } as any],
      project: { timeline: { tracks: [v1, a1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const tracks = (getState().project as any).timeline.tracks
    const audB = tracks.find((t: Track) => t.id === a1Id).clips.find((c: Clip) => c.sourceId === 'tts-B')
    expect(audB.duration).toBe(10) // grew 6 → audio length, clamped to the 12s scene
    expect(audB.id).toBe('tB') // identity preserved
  })

  it('does NOT grow a user-trimmed narration clip (trim is preserved)', () => {
    // Same scene growth, but the user manually trimmed the narration to 4s
    // (trimEnd set). A user trim must survive the sync — clamped so it can't
    // overrun the scene, but never auto-grown back to the 10s audio length.
    const v1Id = 'v1'
    const a1Id = 'a1'
    const v1 = makeTrack({
      id: v1Id,
      position: 0,
      clips: [makeClip({ id: 'cB', trackId: v1Id, sourceId: 'B', startTime: 0, duration: 12 })],
    })
    const a1 = makeTrack({
      id: a1Id,
      name: 'A1',
      type: 'audio',
      position: 1,
      clips: [
        makeClip({
          id: 'tB',
          trackId: a1Id,
          sourceId: 'tts-B',
          sourceType: 'audio',
          startTime: 0,
          duration: 4,
          trimEnd: 4,
        }),
      ],
    })
    const state = makeState({
      scenes: [{ id: 'B', duration: 12, name: 'B', audioLayer: { tts: { text: 'hi', duration: 10 }, sfx: [] } } as any],
      project: { timeline: { tracks: [v1, a1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const tracks = (getState().project as any).timeline.tracks
    const audB = tracks.find((t: Track) => t.id === a1Id).clips.find((c: Clip) => c.sourceId === 'tts-B')
    expect(audB.duration).toBe(4) // user trim preserved (not grown to 10)
  })

  it('removing a middle scene leaves a gap — survivors hold position (lift)', () => {
    // V1 has cA@0, cB@8, cC@14; scene B was deleted from state.scenes. B's clip
    // is dropped (lift) and C does NOT slide into the hole — a 6s gap stays
    // where B was. Closing it is an explicit ripple, never automatic.
    const v1Id = 'v1'
    const v1 = makeTrack({
      id: v1Id,
      clips: [
        makeClip({ id: 'cA', trackId: v1Id, sourceId: 'A', startTime: 0, duration: 8 }),
        makeClip({ id: 'cB', trackId: v1Id, sourceId: 'B', startTime: 8, duration: 6 }),
        makeClip({ id: 'cC', trackId: v1Id, sourceId: 'C', startTime: 14, duration: 10 }),
      ],
    })
    const state = makeState({
      scenes: [
        { id: 'A', duration: 8, name: 'A', audioLayer: null } as any,
        { id: 'C', duration: 10, name: 'C', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const clips = (getState().project as any).timeline.tracks
      .find((t: Track) => t.id === v1Id)
      .clips.filter((c: Clip) => c.sourceType === 'scene')
    const at = (sid: string) => clips.find((c: Clip) => c.sourceId === sid)
    expect(at('B')).toBeUndefined() // deleted scene's clip dropped
    expect(at('A').startTime).toBe(0)
    expect(at('C').startTime).toBe(14) // held — 6s gap where B was
    expect(clips.length).toBe(2)
  })

  it('contains a NaN scene duration instead of poisoning later scenes', () => {
    // A bad duration (NaN from an unguarded writer; Math.max(3, Math.min(30, NaN))
    // is still NaN) on scene B must NOT set the cursor to NaN — C must still get
    // a finite startTime. The bad scene is clamped to a 0-width contribution.
    const v1Id = 'v1'
    const v1 = makeTrack({
      id: v1Id,
      clips: [makeClip({ id: 'cA', trackId: v1Id, sourceId: 'A', startTime: 0, duration: 8 })],
    })
    const state = makeState({
      scenes: [
        { id: 'A', duration: 8, name: 'A', audioLayer: null } as any,
        { id: 'B', duration: NaN, name: 'B', audioLayer: null } as any,
        { id: 'C', duration: 10, name: 'C', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const clips = (getState().project as any).timeline.tracks
      .find((t: Track) => t.id === v1Id)
      .clips.filter((c: Clip) => c.sourceType === 'scene')
    const at = (sid: string) => clips.find((c: Clip) => c.sourceId === sid)
    expect(at('A').startTime).toBe(0)
    expect(at('B').startTime).toBe(8) // bad scene contained at the cursor (0-width)...
    expect(at('C').startTime).toBe(8) // ...so C is unpoisoned, not NaN
    expect(Number.isFinite(at('C').startTime)).toBe(true)
  })

  // The materializer's reuse semantics through the CONSUMER (/review): TTS is
  // reuse:'position' — a user-trimmed narration duration survives syncs, but a
  // clip that OVERRUNS its (shrunken) scene is clamped down; music is
  // reuse:'position+duration' — it always tracks the scene.
  it('TTS reuse keeps a user trim, clamps an overrun, while music tracks the scene', () => {
    const v1Id = 'v1'
    const a1Id = 'a1'
    const a2Id = 'a2'
    const sceneId = 'scene-a'
    const sceneClip = makeClip({ id: 'sc', trackId: v1Id, sourceId: sceneId, startTime: 0, duration: 10 })
    // User trimmed narration to 2s on a 10s scene — must survive. A real
    // right-edge trim sets trimEnd (the source out-point), which is the signal
    // that distinguishes a deliberate trim from a clip that was merely
    // auto-sized to a smaller scene (TrackRow onUpdate writes { duration, trimEnd }).
    const tts = makeClip({
      id: 't',
      trackId: a1Id,
      sourceId: `tts-${sceneId}`,
      sourceType: 'audio',
      startTime: 0,
      duration: 2,
      trimEnd: 2,
    })
    // Music with a stale duration — must snap to the scene.
    const mus = makeClip({
      id: 'm',
      trackId: a2Id,
      sourceId: `mus-${sceneId}`,
      sourceType: 'audio',
      startTime: 0,
      duration: 3,
    })
    const v1 = makeTrack({ id: v1Id, position: 0, clips: [sceneClip] })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 1, clips: [tts] })
    const a2 = makeTrack({ id: a2Id, name: 'A2', type: 'audio', position: 2, clips: [mus] })
    const state = makeState({
      scenes: [
        {
          id: sceneId,
          duration: 10,
          name: 'A',
          audioLayer: { tts: { text: 'hi' }, music: { src: '/m.mp3' }, sfx: [] },
        } as any,
      ],
      project: { timeline: { tracks: [v1, a1, a2] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const tracks = (getState().project as any).timeline.tracks
    const ttsOut = tracks.find((t: Track) => t.id === a1Id).clips.find((c: Clip) => c.sourceId === `tts-${sceneId}`)
    const musOut = tracks.find((t: Track) => t.id === a2Id).clips.find((c: Clip) => c.sourceId === `mus-${sceneId}`)
    expect(ttsOut.duration).toBe(2) // reuse:'position' — user trim survives
    expect(ttsOut.id).toBe('t') // clip identity preserved
    expect(musOut.duration).toBe(10) // reuse:'position+duration' — tracks the scene

    // Scene SHRINKS below the kept TTS duration → the clip must clamp, not
    // bleed past the scene boundary (/review M3).
    const after = getState() as any
    after.scenes = [
      { id: sceneId, duration: 1, name: 'A', audioLayer: { tts: { text: 'hi' }, music: { src: '/m.mp3' }, sfx: [] } },
    ]
    actions.syncTimelineFromScenes()
    const tracks2 = (getState().project as any).timeline.tracks
    const ttsOut2 = tracks2.find((t: Track) => t.id === a1Id).clips.find((c: Clip) => c.sourceId === `tts-${sceneId}`)
    expect(ttsOut2.duration).toBeLessThanOrEqual(1)
  })

  // Regression (data-loss-on-open): imported audio lands on A1 (the first
  // audio track) via placeAssetOnTimeline. The sync that fires on project
  // open used to replace ALL A1 clips with scene-derived narration/sfx,
  // silently deleting the import. Scene-owned clips (aud-/tts-/mus-/sfx) are
  // regenerated; everything else on A1/A2 must survive.
  it('preserves user-imported audio on A1 while regenerating scene narration', () => {
    const v1Id = 'v1'
    const a1Id = 'a1'
    const sceneId = 'scene-a'
    const sceneClip = makeClip({
      id: 'sc',
      trackId: v1Id,
      sourceId: sceneId,
      sourceType: 'scene',
      startTime: 0,
      duration: 5,
    })
    // Scene-owned narration clip (will be regenerated by the sync).
    const sceneAudio = makeClip({
      id: 'aud',
      trackId: a1Id,
      sourceId: `aud-${sceneId}`,
      sourceType: 'audio',
      startTime: 0,
      duration: 5,
    })
    // User-imported clip: sourceId is a URL, not a scene-audio prefix.
    const importedAudio = makeClip({
      id: 'imp',
      trackId: a1Id,
      sourceId: 'https://cdn.example.com/song.mp3',
      sourceType: 'audio',
      startTime: 5,
      duration: 8,
    })
    const v1 = makeTrack({ id: v1Id, position: 0, clips: [sceneClip] })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 1, clips: [sceneAudio, importedAudio] })
    const state = makeState({
      scenes: [
        { id: sceneId, duration: 5, name: 'A', audioLayer: { enabled: true, src: 'voice.mp3', sfx: [] } } as any,
      ],
      project: { timeline: { tracks: [v1, a1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const resultA1 = (getState().project as any).timeline.tracks.find((t: Track) => t.id === a1Id)
    const imp = resultA1.clips.find((c: Clip) => c.id === 'imp')
    expect(imp).toBeTruthy() // imported clip survives the sync
    expect(imp.sourceId).toBe('https://cdn.example.com/song.mp3')
    expect(imp.startTime).toBe(5)
    // The scene-owned narration clip is still present (regenerated, id reused).
    expect(resultA1.clips.find((c: Clip) => c.sourceId === `aud-${sceneId}`)).toBeTruthy()
  })
})

// ── moveClip ─────────────────────────────────────────────────────────────────

describe('moveClip — scene reorder', () => {
  it('reorders scenes array to match V1 clip order after drag', () => {
    const v1Id = 'v1'
    const sceneA = { id: 'scene-a', duration: 5, name: 'A', audioLayer: null } as any
    const sceneB = { id: 'scene-b', duration: 5, name: 'B', audioLayer: null } as any
    // Clip B currently starts at 5 (after A at 0-5)
    const clipA = makeClip({ id: 'ca', trackId: v1Id, sourceId: 'scene-a', startTime: 0, duration: 5 })
    const clipB = makeClip({ id: 'cb', trackId: v1Id, sourceId: 'scene-b', startTime: 5, duration: 5 })
    const v1 = makeTrack({ id: v1Id, clips: [clipA, clipB] })
    const state = makeState({
      scenes: [sceneA, sceneB],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    // Move clip A to startTime=10 (after B at 5) — B is now first
    actions.moveClip('ca', v1Id, 10)

    const newScenes = (getState() as any).scenes as (typeof sceneA)[]
    expect(newScenes[0].id).toBe('scene-b') // B (startTime=5) before A (startTime=10)
    expect(newScenes[1].id).toBe('scene-a')
  })

  it('shifts linked audio clips by the same delta when scene clip moves', () => {
    const v1Id = 'v1'
    const a1Id = 'a1'
    const sceneId = 'scene-x'
    const sceneClip = makeClip({ id: 'cs', trackId: v1Id, sourceId: sceneId, startTime: 0, duration: 5 })
    const audioClip = makeClip({
      id: 'aud',
      trackId: a1Id,
      sourceId: `aud-${sceneId}`,
      sourceType: 'audio',
      startTime: 0,
      duration: 5,
    })
    const v1 = makeTrack({ id: v1Id, position: 0, clips: [sceneClip] })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 1, clips: [audioClip] })
    const state = makeState({
      scenes: [{ id: sceneId, duration: 5, name: 'X', audioLayer: null } as any],
      project: { timeline: { tracks: [v1, a1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.moveClip('cs', v1Id, 10) // move scene clip by +10s

    const resultA1 = (getState().project as any).timeline.tracks.find((t: Track) => t.id === a1Id)
    const resultAudio = resultA1.clips.find((c: Clip) => c.id === 'aud')
    expect(resultAudio.startTime).toBe(10) // shifted by +10
  })

  it('moving a scene clip up to V2 leaves a real gap on V1 (the reported bug)', () => {
    // A[0,5] B[5,10] on V1; drag A up to a second video track V2 at startTime 0.
    // V1 must keep the 0..5 HOLE — B does NOT slide in to fill it. This is the
    // timeline-authoritative fix: positions are owned by clips, not repacked.
    const v1Id = 'v1'
    const v2Id = 'v2'
    const clipA = makeClip({ id: 'ca', trackId: v1Id, sourceId: 'scene-a', startTime: 0, duration: 5 })
    const clipB = makeClip({ id: 'cb', trackId: v1Id, sourceId: 'scene-b', startTime: 5, duration: 5 })
    const v1 = makeTrack({ id: v1Id, position: 0, type: 'video', clips: [clipA, clipB] })
    const v2 = makeTrack({ id: v2Id, position: 1, type: 'video', clips: [] })
    const state = makeState({
      scenes: [
        { id: 'scene-a', duration: 5, name: 'A', audioLayer: null } as any,
        { id: 'scene-b', duration: 5, name: 'B', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1, v2] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.moveClip('ca', v2Id, 0) // drag A up to V2

    const tracks = (getState().project as any).timeline.tracks
    const v1After = tracks.find((t: Track) => t.id === v1Id)
    const v2After = tracks.find((t: Track) => t.id === v2Id)
    expect(v1After.clips.map((c: Clip) => c.id)).toEqual(['cb']) // A left V1
    expect(v1After.clips.find((c: Clip) => c.id === 'cb').startTime).toBe(5) // B HELD — gap at 0..5
    expect(v2After.clips.find((c: Clip) => c.id === 'ca')?.startTime).toBe(0) // A now on V2
  })
})

// ── splitClip ────────────────────────────────────────────────────────────────

describe('splitClip', () => {
  // Mechanics tests use video clips; scene clips also split now (regression below).
  it('produces left duration = atTime and right startTime = original + atTime', () => {
    const v1Id = 'v1'
    const clip = makeClip({
      id: 'c1',
      trackId: v1Id,
      sourceType: 'video',
      sourceId: 'media-a',
      startTime: 2,
      duration: 10,
    })
    const v1 = makeTrack({ id: v1Id, clips: [clip] })
    const state = makeState({
      scenes: [],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    const result = actions.splitClip('c1', 3) // split 3s into the clip

    expect(result).not.toBeNull()
    const allClips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips)
    const left = allClips.find((c: Clip) => c.id === result!.leftId)
    const right = allClips.find((c: Clip) => c.id === result!.rightId)

    expect(left.duration).toBe(3)
    expect(left.startTime).toBe(2) // original startTime unchanged
    expect(right.startTime).toBe(5) // 2 + 3
    expect(right.duration).toBe(7) // 10 - 3
  })

  it('clamps leftClip.trimEnd to original trimEnd so split cannot un-trim content', () => {
    const v1Id = 'v1'
    // Original clip is trimmed: source [10, 15], duration 5 (1:1 speed).
    const clip = makeClip({
      id: 'c1',
      trackId: v1Id,
      sourceType: 'video',
      sourceId: 'media-a',
      startTime: 0,
      duration: 5,
      trimStart: 10,
      trimEnd: 15,
      speed: 1,
    })
    const v1 = makeTrack({ id: v1Id, clips: [clip] })
    const state = makeState({
      scenes: [],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    // Split halfway → naive math would set leftTrimEnd = 10 + 2.5 = 12.5
    // and rightTrimStart = 12.5. Both are below original trimEnd (15), so
    // the clamp is a no-op for an in-range split.
    const inRange = actions.splitClip('c1', 2.5)!
    const clipsAfterInRange = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips)
    const leftIn = clipsAfterInRange.find((c: Clip) => c.id === inRange.leftId)
    const rightIn = clipsAfterInRange.find((c: Clip) => c.id === inRange.rightId)
    expect(leftIn.trimEnd).toBe(12.5)
    expect(rightIn.trimStart).toBe(12.5)
    expect(rightIn.trimEnd).toBe(15) // original trimEnd preserved on right
  })

  it('returns null when atTime is out of clip bounds', () => {
    const v1Id = 'v1'
    const clip = makeClip({
      id: 'c1',
      trackId: v1Id,
      sourceType: 'video',
      sourceId: 'media-a',
      startTime: 0,
      duration: 5,
    })
    const v1 = makeTrack({ id: v1Id, clips: [clip] })
    const state = makeState({
      scenes: [],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions } = makeActions(state)
    expect(actions.splitClip('c1', 0)).toBeNull()
    expect(actions.splitClip('c1', 5)).toBeNull()
    expect(actions.splitClip('c1', 6)).toBeNull()
  })

  it('splits a SCENE clip into two halves, and a sync PRESERVES both (NLE-foundation regression)', () => {
    const pushUndo = vi.fn()
    const clip = makeClip({
      id: 'sc1',
      trackId: 'v1',
      sourceType: 'scene',
      sourceId: 'scene-a',
      startTime: 0,
      duration: 10,
    })
    const v1 = makeTrack({ id: 'v1', clips: [clip] })
    const state = makeState({
      scenes: [{ id: 'scene-a', duration: 10, name: 'A', audioLayer: null } as any],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      _pushUndo: pushUndo,
    })
    const { actions, getState } = makeActions(state)

    const res = actions.splitClip('sc1', 4)
    expect(res).not.toBeNull()
    const afterSplit = (getState().project as any).timeline.tracks[0].clips as Clip[]
    expect(afterSplit).toHaveLength(2) // left [0,4] + right [4,10]
    expect(afterSplit.every((c) => c.sourceId === 'scene-a')).toBe(true)
    expect(new Set(afterSplit.map((c) => c.id)).size).toBe(2) // distinct ids
    expect(pushUndo).toHaveBeenCalled()

    // The critical regression: syncTimelineFromScenes must NOT drop the right
    // half (the exact corruption the old guard prevented).
    actions.syncTimelineFromScenes()
    const afterSync = (getState().project as any).timeline.tracks[0].clips.filter(
      (c: Clip) => c.sourceType === 'scene',
    ) as Clip[]
    expect(afterSync).toHaveLength(2) // both halves survive the sync
    expect(afterSync.map((c) => c.startTime).sort((a, b) => a - b)).toEqual([0, 4])
  })

  it('HARDENING: split is sync-idempotent — two syncs do not drop, dup, or move halves', () => {
    const clip = makeClip({
      id: 'sc1',
      trackId: 'v1',
      sourceType: 'scene',
      sourceId: 'scene-a',
      startTime: 0,
      duration: 10,
    })
    const v1 = makeTrack({ id: 'v1', clips: [clip] })
    const state = makeState({
      scenes: [{ id: 'scene-a', duration: 10, name: 'A', audioLayer: null } as any],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.splitClip('sc1', 4)
    actions.syncTimelineFromScenes()
    actions.syncTimelineFromScenes() // run TWICE — must be stable
    const clips = (getState().project as any).timeline.tracks[0].clips.filter(
      (c: Clip) => c.sourceType === 'scene',
    ) as Clip[]
    expect(clips).toHaveLength(2)
    expect(clips.map((c) => c.startTime).sort((a, b) => a - b)).toEqual([0, 4])
  })

  it('HARDENING: deleting the PRIMARY (left) half keeps the scene + right half; sync keeps the survivor', () => {
    const left = makeClip({
      id: 'l',
      trackId: 'v1',
      sourceType: 'scene',
      sourceId: 'scene-a',
      startTime: 0,
      duration: 4,
      trimEnd: 4,
    })
    const right = makeClip({
      id: 'r',
      trackId: 'v1',
      sourceType: 'scene',
      sourceId: 'scene-a',
      startTime: 4,
      duration: 6,
      trimStart: 4,
    })
    const v1 = makeTrack({ id: 'v1', clips: [left, right] })
    const state = makeState({
      scenes: [{ id: 'scene-a', duration: 10, name: 'A', audioLayer: null } as any],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      selectedClipIds: [],
      selectedSceneId: 'scene-a',
    })
    const { actions, getState } = makeActions(state)
    actions.removeClip('l') // delete the PRIMARY (earliest) half
    expect((getState().scenes as any[]).map((s) => s.id)).toEqual(['scene-a']) // scene survives
    actions.syncTimelineFromScenes()
    const clips = (getState().project as any).timeline.tracks[0].clips.filter(
      (c: Clip) => c.sourceType === 'scene',
    ) as Clip[]
    expect(clips.map((c) => c.id)).toEqual(['r']) // the right half survives the sync (now primary)
    expect(clips[0].startTime).toBe(4) // and keeps its place (gap 0..4 is real)
  })

  it('HARDENING: split then move the right half to V2 — sync keeps one clip per track, no dup', () => {
    const clip = makeClip({
      id: 'sc1',
      trackId: 'v1',
      sourceType: 'scene',
      sourceId: 'scene-a',
      startTime: 0,
      duration: 10,
    })
    const v1 = makeTrack({ id: 'v1', position: 0, type: 'video', clips: [clip] })
    const v2 = makeTrack({ id: 'v2', position: 1, type: 'video', clips: [] })
    const state = makeState({
      scenes: [{ id: 'scene-a', duration: 10, name: 'A', audioLayer: null } as any],
      project: { timeline: { tracks: [v1, v2] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    const res = actions.splitClip('sc1', 4)
    actions.moveClip(res!.rightId, 'v2', 4) // drag the right half up to V2
    actions.syncTimelineFromScenes()
    const tracks = (getState().project as any).timeline.tracks as Track[]
    const v1Scene = tracks.find((t) => t.id === 'v1')!.clips.filter((c: Clip) => c.sourceType === 'scene')
    const v2Scene = tracks.find((t) => t.id === 'v2')!.clips.filter((c: Clip) => c.sourceType === 'scene')
    expect(v1Scene).toHaveLength(1) // left half on V1
    expect(v2Scene).toHaveLength(1) // right half on V2 — NOT re-materialized as a V1 phantom
    expect((getState().scenes as any[]).map((s) => s.id)).toEqual(['scene-a'])
  })

  it('REGRESSION: audio clips still split fine after the scene guard', () => {
    const clip = makeClip({
      id: 'au1',
      trackId: 'a1',
      sourceType: 'audio',
      sourceId: 'song',
      startTime: 0,
      duration: 8,
    })
    const a1 = makeTrack({ id: 'a1', type: 'audio', clips: [clip] })
    const state = makeState({
      scenes: [],
      project: { timeline: { tracks: [a1] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    const result = actions.splitClip('au1', 3)
    expect(result).not.toBeNull()
    expect((getState().project as any).timeline.tracks[0].clips).toHaveLength(2)
  })
})

// ── batchUpdateClips ─────────────────────────────────────────────────────────

describe('batchUpdateClips', () => {
  it('applies all updates in a single set() call', () => {
    const v1Id = 'v1'
    const clipA = makeClip({ id: 'ca', trackId: v1Id, sourceId: 'sa', startTime: 0, duration: 5 })
    const clipB = makeClip({ id: 'cb', trackId: v1Id, sourceId: 'sb', startTime: 5, duration: 5 })
    const v1 = makeTrack({ id: v1Id, clips: [clipA, clipB] })
    const state = makeState({
      scenes: [],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })

    const { actions, mockSet, getState } = makeActions(state)
    actions.batchUpdateClips([
      { id: 'ca', updates: { startTime: 10 } },
      { id: 'cb', updates: { startTime: 20 } },
    ])

    // Only one set() call for both updates
    expect(mockSet).toHaveBeenCalledTimes(1)

    const allClips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips)
    expect(allClips.find((c: Clip) => c.id === 'ca').startTime).toBe(10)
    expect(allClips.find((c: Clip) => c.id === 'cb').startTime).toBe(20)
  })

  it('does not call set() when batch is empty', () => {
    const state = makeState({
      project: { timeline: { tracks: [] }, updatedAt: '' },
    })
    const { actions, mockSet } = makeActions(state)
    actions.batchUpdateClips([])
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('batchUpdateClips is a no-op for unknown clip id (silent failure)', () => {
    const state = makeState({
      project: {
        timeline: {
          tracks: [
            makeTrack({
              id: 'v1',
              clips: [makeClip({ id: 'real-clip', trackId: 'v1', sourceId: 's1', startTime: 0 })],
            }),
          ],
        },
        updatedAt: '',
      },
    })
    const { actions, getState } = makeActions(state)
    // Should not throw — unknown id is silently ignored
    expect(() => actions.batchUpdateClips([{ id: 'ghost-clip', updates: { startTime: 99 } }])).not.toThrow()
    // Real clip is unchanged
    const clips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips)
    expect(clips.find((c: Clip) => c.id === 'real-clip').startTime).toBe(0)
  })
})

// ── syncTimelineFromScenes: avatar clip identity ─────────────────────────────

describe('syncTimelineFromScenes — avatar clip identity', () => {
  it('preserves existing avatar clip ids across re-syncs', () => {
    const v1Id = 'v1'
    const a1Id = 'a1'
    const v2Id = 'v2'
    const a2Id = 'a2'
    const sceneId = 'sc-1'
    const avatarLayerId = 'av-42'
    const linkGroupId = `avatar:${avatarLayerId}`
    const existingSceneClip = makeClip({
      id: 'sc-clip',
      trackId: v1Id,
      sourceId: sceneId,
      sourceType: 'scene',
      startTime: 0,
      duration: 10,
    })
    const existingAvatarVideo = makeClip({
      id: 'av-video-id-STABLE',
      trackId: v2Id,
      sourceId: avatarLayerId,
      sourceType: 'avatar',
      startTime: 1,
      duration: 4,
      linkGroupId,
      keyframes: [{ id: 'kf-1', time: 0.5, property: 'opacity', value: 0.5 }] as any,
    })
    const existingAvatarAudio = makeClip({
      id: 'av-audio-id-STABLE',
      trackId: a2Id,
      sourceId: `avatar-audio:${avatarLayerId}`,
      sourceType: 'audio',
      startTime: 1,
      duration: 4,
      linkGroupId,
    })
    const v1 = makeTrack({ id: v1Id, position: 0, clips: [existingSceneClip] })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 1, clips: [] })
    const v2 = makeTrack({ id: v2Id, name: 'V2', position: 2, clips: [existingAvatarVideo] })
    const a2 = makeTrack({ id: a2Id, name: 'A2', type: 'audio', position: 3, clips: [existingAvatarAudio] })
    const state = makeState({
      scenes: [
        {
          id: sceneId,
          duration: 10,
          audioLayer: null,
          aiLayers: [{ id: avatarLayerId, type: 'avatar', label: 'Host', startAt: 1, estimatedDuration: 4 }],
        } as any,
      ],
      project: { timeline: { tracks: [v1, a1, v2, a2] }, updatedAt: '' },
    })

    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()

    const allClips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips)
    const avatarVid = allClips.find((c: Clip) => c.linkGroupId === linkGroupId && c.sourceType === 'avatar')
    const avatarAud = allClips.find((c: Clip) => c.linkGroupId === linkGroupId && c.sourceType === 'audio')
    expect(avatarVid.id).toBe('av-video-id-STABLE')
    expect(avatarAud.id).toBe('av-audio-id-STABLE')
    // User edits on the prior clip survive the re-sync.
    expect((avatarVid.keyframes as any[]).length).toBe(1)
  })
})

// ── removeClip: authoritative delete (mutates scene source) ──────────────────

describe('removeClip — authoritative source mutation', () => {
  it('deleting a TTS clip clears scene.audioLayer.tts so sync does not respawn', () => {
    const v1Id = 'v1'
    const a1Id = 'a1'
    const sceneId = 'sc-1'
    const ttsClip = makeClip({
      id: 'tts-clip',
      trackId: a1Id,
      sourceId: `tts-${sceneId}`,
      sourceType: 'audio',
      startTime: 0,
      duration: 5,
    })
    const v1 = makeTrack({ id: v1Id, clips: [] })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 1, clips: [ttsClip] })
    const state = makeState({
      scenes: [
        {
          id: sceneId,
          duration: 5,
          audioLayer: { tts: { text: 'hello', src: 'blob://x' }, sfx: [], enabled: false, src: null },
        } as any,
      ],
      project: { timeline: { tracks: [v1, a1] }, updatedAt: '' },
      selectedClipIds: [],
    })

    const { actions, getState } = makeActions(state)
    actions.removeClip('tts-clip')
    const scene = (getState().scenes as any[]).find((s) => s.id === sceneId)
    expect(scene.audioLayer.tts).toBeNull()
  })

  it('deleting a music clip clears scene.audioLayer.music', () => {
    const a1Id = 'a1'
    const sceneId = 'sc-1'
    const musClip = makeClip({
      id: 'mus-clip',
      trackId: a1Id,
      sourceId: `mus-${sceneId}`,
      sourceType: 'audio',
      startTime: 0,
      duration: 5,
    })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 0, clips: [musClip] })
    const state = makeState({
      scenes: [
        {
          id: sceneId,
          duration: 5,
          audioLayer: { music: { src: 'song.mp3', name: 'Song' }, sfx: [], enabled: false, src: null },
        } as any,
      ],
      project: { timeline: { tracks: [a1] }, updatedAt: '' },
      selectedClipIds: [],
    })
    const { actions, getState } = makeActions(state)
    actions.removeClip('mus-clip')
    const scene = (getState().scenes as any[]).find((s) => s.id === sceneId)
    expect(scene.audioLayer.music).toBeNull()
  })

  it('deleting an SFX clip filters the sfx[] array on the owning scene', () => {
    const a1Id = 'a1'
    const sceneId = 'sc-1'
    const sfxId = 'sfx-zap-42'
    const sfxClip = makeClip({
      id: 'sfx-clip',
      trackId: a1Id,
      sourceId: sfxId,
      sourceType: 'audio',
      startTime: 0,
      duration: 0.5,
    })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 0, clips: [sfxClip] })
    const state = makeState({
      scenes: [
        {
          id: sceneId,
          duration: 5,
          audioLayer: {
            sfx: [
              { id: sfxId, name: 'Zap', triggerAt: 0, duration: 0.5 },
              { id: 'sfx-keep', name: 'Keep', triggerAt: 1, duration: 0.5 },
            ],
            enabled: false,
            src: null,
          },
        } as any,
      ],
      project: { timeline: { tracks: [a1] }, updatedAt: '' },
      selectedClipIds: [],
    })
    const { actions, getState } = makeActions(state)
    actions.removeClip('sfx-clip')
    const scene = (getState().scenes as any[]).find((s) => s.id === sceneId)
    expect(scene.audioLayer.sfx.map((x: any) => x.id)).toEqual(['sfx-keep'])
  })

  it('deleting an aud-* clip disables scene.audioLayer and clears src', () => {
    const a1Id = 'a1'
    const sceneId = 'sc-1'
    const audClip = makeClip({
      id: 'aud-clip',
      trackId: a1Id,
      sourceId: `aud-${sceneId}`,
      sourceType: 'audio',
      startTime: 0,
      duration: 5,
    })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 0, clips: [audClip] })
    const state = makeState({
      scenes: [
        {
          id: sceneId,
          duration: 5,
          audioLayer: { enabled: true, src: 'voice.mp3', sfx: [] },
        } as any,
      ],
      project: { timeline: { tracks: [a1] }, updatedAt: '' },
      selectedClipIds: [],
    })
    const { actions, getState } = makeActions(state)
    actions.removeClip('aud-clip')
    const scene = (getState().scenes as any[]).find((s) => s.id === sceneId)
    expect(scene.audioLayer.enabled).toBe(false)
    expect(scene.audioLayer.src).toBeNull()
  })

  it('deleting a scene clip removes the scene + its linked audio clips + scene-graph node', () => {
    const v1Id = 'v1'
    const a1Id = 'a1'
    const sceneId = 'sc-doomed'
    const sceneClip = makeClip({
      id: 'sc-clip',
      trackId: v1Id,
      sourceId: sceneId,
      sourceType: 'scene',
      startTime: 0,
      duration: 5,
    })
    const audClip = makeClip({
      id: 'aud-clip',
      trackId: a1Id,
      sourceId: `aud-${sceneId}`,
      sourceType: 'audio',
      startTime: 0,
      duration: 5,
    })
    const v1 = makeTrack({ id: v1Id, clips: [sceneClip] })
    const a1 = makeTrack({ id: a1Id, name: 'A1', type: 'audio', position: 1, clips: [audClip] })
    const state = makeState({
      scenes: [
        { id: sceneId, duration: 5, audioLayer: { enabled: true, src: 'voice.mp3', sfx: [] } } as any,
        { id: 'survivor', duration: 5, audioLayer: null } as any,
      ],
      project: {
        timeline: { tracks: [v1, a1] },
        sceneGraph: {
          nodes: [
            { id: sceneId, position: { x: 0, y: 0 } },
            { id: 'survivor', position: { x: 220, y: 0 } },
          ],
          edges: [{ fromSceneId: sceneId, toSceneId: 'survivor', id: 'e1', condition: { type: 'auto' } as any }],
        },
        updatedAt: '',
      },
      selectedClipIds: [],
      selectedSceneId: sceneId,
    })
    const { actions, getState } = makeActions(state)
    actions.removeClip('sc-clip')
    expect((getState().scenes as any[]).map((s) => s.id)).toEqual(['survivor'])
    const remainingClips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips)
    expect(remainingClips).toHaveLength(0)
    const graph = (getState().project as any).sceneGraph
    expect(graph.nodes.map((n: any) => n.id)).toEqual(['survivor'])
    expect(graph.edges).toEqual([])
    // selectedSceneId reassigned to surviving scene
    expect((getState() as any).selectedSceneId).toBe('survivor')
  })

  it('clip-centric delete: removing ONE split half keeps the scene + other half; the LAST half removes the scene', () => {
    const v1Id = 'v1'
    const sceneId = 'scene-split'
    // A scene split into two halves on V1, sharing one sourceId, distinct ids.
    const left = makeClip({
      id: 'half-l',
      trackId: v1Id,
      sourceType: 'scene',
      sourceId: sceneId,
      startTime: 0,
      duration: 4,
      trimEnd: 4,
    })
    const right = makeClip({
      id: 'half-r',
      trackId: v1Id,
      sourceType: 'scene',
      sourceId: sceneId,
      startTime: 4,
      duration: 4,
      trimStart: 4,
    })
    const v1 = makeTrack({ id: v1Id, clips: [left, right] })
    const state = makeState({
      scenes: [{ id: sceneId, duration: 8, name: 'S', audioLayer: null } as any],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      selectedClipIds: [],
      selectedSceneId: sceneId,
    })
    const { actions, getState } = makeActions(state)

    // Delete the right half → scene STAYS, left half STAYS.
    actions.removeClip('half-r')
    expect((getState().scenes as any[]).map((s) => s.id)).toEqual([sceneId]) // scene survives
    let clips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips) as Clip[]
    expect(clips.map((c) => c.id)).toEqual(['half-l']) // right half gone, left half remains

    // Delete the last (left) half → NOW the scene is removed.
    actions.removeClip('half-l')
    expect((getState().scenes as any[]).map((s) => s.id)).toEqual([]) // scene gone
    clips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips) as Clip[]
    expect(clips).toHaveLength(0)
  })

  it('deleting an avatar clip strips the avatar layer from scene.aiLayers', () => {
    const v1Id = 'v1'
    const sceneId = 'sc-av'
    const avatarLayerId = 'avatar-42'
    const avatarClip = makeClip({
      id: 'av-clip',
      trackId: v1Id,
      sourceId: avatarLayerId,
      sourceType: 'avatar',
      startTime: 0,
      duration: 5,
      linkGroupId: `avatar:${avatarLayerId}`,
    })
    const v1 = makeTrack({ id: v1Id, clips: [avatarClip] })
    const state = makeState({
      scenes: [
        {
          id: sceneId,
          duration: 5,
          audioLayer: null,
          aiLayers: [{ id: avatarLayerId, type: 'avatar', label: 'Host' }],
        } as any,
      ],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      selectedClipIds: [],
      saveSceneHTML: vi.fn(),
    })
    const { actions, getState } = makeActions(state)
    actions.removeClip('av-clip')
    const scene = (getState().scenes as any[]).find((s) => s.id === sceneId)
    expect(scene.aiLayers).toEqual([])
  })
})

// ── linkClips / unlinkGroup ──────────────────────────────────────────────────

describe('linkClips', () => {
  it('unions prior link groups instead of orphaning their members', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'a', trackId: 'v1', sourceId: 'sa', startTime: 0, linkGroupId: 'g1' }),
        makeClip({ id: 'b', trackId: 'v1', sourceId: 'sb', startTime: 5, linkGroupId: 'g1' }),
        makeClip({ id: 'c', trackId: 'v1', sourceId: 'sc', startTime: 10, linkGroupId: 'g2' }),
        makeClip({ id: 'd', trackId: 'v1', sourceId: 'sd', startTime: 15, linkGroupId: 'g2' }),
        makeClip({ id: 'e', trackId: 'v1', sourceId: 'se', startTime: 20 }),
      ],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    // Linking a + c should pull in b (from g1) and d (from g2) too.
    actions.linkClips(['a', 'c', 'e'])
    const clips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips)
    const groupIds = new Set(clips.filter((c: Clip) => c.linkGroupId).map((c: Clip) => c.linkGroupId))
    // a, b, c, d, e all share ONE new group.
    expect(groupIds.size).toBe(1)
    const newGroup = clips.find((c: Clip) => c.id === 'a').linkGroupId
    expect(clips.find((c: Clip) => c.id === 'b').linkGroupId).toBe(newGroup)
    expect(clips.find((c: Clip) => c.id === 'd').linkGroupId).toBe(newGroup)
    expect(clips.find((c: Clip) => c.id === 'e').linkGroupId).toBe(newGroup)
  })

  it('refuses to link clips that belong to an avatar group', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'av', trackId: 'v1', sourceId: 'av-1', sourceType: 'avatar', linkGroupId: 'avatar:av-1' }),
        makeClip({ id: 'plain', trackId: 'v1', sourceId: 'sx', sourceType: 'video' }),
      ],
    })
    const state = makeState({ project: { timeline: { tracks: [v1] }, updatedAt: '' } })
    const { actions, getState } = makeActions(state)
    actions.linkClips(['av', 'plain'])
    // plain clip should still have no group (link refused).
    const clips = (getState().project as any).timeline.tracks.flatMap((t: Track) => t.clips)
    expect(clips.find((c: Clip) => c.id === 'plain').linkGroupId).toBeUndefined()
  })
})

describe('unlinkGroup', () => {
  it('refuses to unlink avatar groups (they would respawn on next sync)', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({
          id: 'av',
          trackId: 'v1',
          sourceId: 'av-1',
          sourceType: 'avatar',
          linkGroupId: 'avatar:av-1',
        }),
      ],
    })
    const state = makeState({ project: { timeline: { tracks: [v1] }, updatedAt: '' } })
    const { actions, getState } = makeActions(state)
    actions.unlinkGroup('av')
    const clip = (getState().project as any).timeline.tracks
      .flatMap((t: Track) => t.clips)
      .find((c: Clip) => c.id === 'av')
    expect(clip.linkGroupId).toBe('avatar:av-1')
  })
})

describe('syncTimelineFromScenes (null timeline guard)', () => {
  it('calls initTimeline (not a crash) when timeline is null', () => {
    const state = makeState({
      scenes: [{ id: 's1', duration: 5 }],
      project: { timeline: null, updatedAt: '' },
    })
    const { actions, mockSet } = makeActions(state)
    // Should not throw — falls through to initTimeline() which calls set() once
    expect(() => actions.syncTimelineFromScenes()).not.toThrow()
    // set() is called by the initTimeline delegation — this is correct behaviour
    expect(mockSet).toHaveBeenCalled()
  })
})

describe('moveClip (edge cases)', () => {
  it('scene missing from V1 clips sorts to end of track', () => {
    const state = makeState({
      scenes: [
        { id: 's-known', duration: 5 },
        { id: 's-orphan', duration: 8 },
      ],
      project: {
        timeline: {
          tracks: [
            makeTrack({
              id: 'v1',
              clips: [makeClip({ id: 'c1', trackId: 'v1', sourceId: 's-known', startTime: 0, duration: 5 })],
            }),
          ],
        },
        updatedAt: '',
      },
    })
    const { actions, mockSet } = makeActions(state)
    // Moving a clip whose sourceId is NOT in the timeline clips should not throw
    expect(() => actions.moveClip('c-not-in-timeline', 'v1', 10)).not.toThrow()
  })
})

describe('copy / cut / paste', () => {
  it('copyClips snapshots the selected clips into clipClipboard anchored on the earliest', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'a', trackId: 'v1', sourceId: 'src-a', startTime: 5, duration: 2, sourceType: 'video' }),
        makeClip({ id: 'b', trackId: 'v1', sourceId: 'src-b', startTime: 10, duration: 3, sourceType: 'video' }),
      ],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      timelineTransport: { globalTime: 0, totalDuration: 30, isPlaying: false },
    })
    const { actions, getState } = makeActions(state)
    actions.copyClips(['a', 'b'])
    const cb = getState().clipClipboard
    expect(cb).not.toBeNull()
    expect(cb!.clips).toHaveLength(2)
    expect(cb!.anchorTime).toBe(5)
  })

  it('pasteClips places clips at target time and preserves relative offsets', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'a', trackId: 'v1', sourceId: 'src-a', startTime: 5, duration: 2, sourceType: 'video' }),
        makeClip({ id: 'b', trackId: 'v1', sourceId: 'src-b', startTime: 10, duration: 3, sourceType: 'video' }),
      ],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      timelineTransport: { globalTime: 20, totalDuration: 30, isPlaying: false },
    })
    const { actions, getState } = makeActions(state)
    actions.copyClips(['a', 'b'])
    const pasted = actions.pasteClips(20)
    expect(pasted).toHaveLength(2)
    const allClips = getState().project.timeline!.tracks.flatMap((t: Track) => t.clips)
    const pastedClips = allClips.filter((c: Clip) => pasted.includes(c.id))
    const starts = pastedClips.map((c: Clip) => c.startTime).sort((x: number, y: number) => x - y)
    // a was at 5 (anchor), b at 10 → relative 0 and 5 → paste at 20 + 0 and 20 + 5
    expect(starts).toEqual([20, 25])
  })

  it('pasteClips CLONES the scene for a pasted scene clip (own iframe — no shared <video>)', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'sc', trackId: 'v1', sourceId: 'scene-a', startTime: 0, duration: 5, sourceType: 'scene' }),
      ],
    })
    const state = makeState({
      scenes: [{ id: 'scene-a', name: 'A', duration: 5, audioLayer: null, aiLayers: [], interactions: [] } as any],
      project: {
        timeline: { tracks: [v1] },
        sceneGraph: { nodes: [{ id: 'scene-a', position: { x: 0, y: 0 } }], edges: [] },
        updatedAt: '',
      },
      timelineTransport: { globalTime: 10, totalDuration: 20, isPlaying: false },
      saveSceneHTML: vi.fn(),
    })
    const { actions, getState } = makeActions(state)
    actions.copyClips(['sc'])
    const pasted = actions.pasteClips(10)
    expect(pasted).toHaveLength(1)
    const pastedClip = getState()
      .project.timeline!.tracks.flatMap((t: Track) => t.clips)
      .find((c: Clip) => c.id === pasted[0])!
    // The pasted clip points at a NEW scene (its own iframe), not the original.
    expect(pastedClip.sourceId).not.toBe('scene-a')
    expect((getState().scenes as any[]).map((s) => s.id)).toContain(pastedClip.sourceId)
    expect((getState().scenes as any[]).length).toBe(2) // original + clone
  })

  it('cutClips copies then removes the originals', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [makeClip({ id: 'a', trackId: 'v1', sourceId: 'src-a', startTime: 0, duration: 5, sourceType: 'video' })],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      timelineTransport: { globalTime: 0, totalDuration: 5, isPlaying: false },
      selectedClipIds: ['a'],
      scenes: [],
    })
    const { actions, getState } = makeActions(state)
    actions.cutClips(['a'])
    expect(getState().clipClipboard?.clips).toHaveLength(1)
    expect(getState().project.timeline!.tracks[0].clips).toHaveLength(0)
  })

  it('pasteClips with no clipboard is a no-op', () => {
    const state = makeState({
      project: { timeline: { tracks: [] }, updatedAt: '' },
      timelineTransport: { globalTime: 0, totalDuration: 0, isPlaying: false },
    })
    const { actions } = makeActions(state)
    expect(actions.pasteClips()).toEqual([])
  })

  it('pasteClips insert mode pushes downstream clips on each affected track', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'src', trackId: 'v1', sourceId: 'src-s', startTime: 0, duration: 2, sourceType: 'video' }),
        // Clip that's already downstream of where we'll paste.
        makeClip({ id: 'tail', trackId: 'v1', sourceId: 'src-t', startTime: 10, duration: 3, sourceType: 'video' }),
      ],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      timelineTransport: { globalTime: 5, totalDuration: 30, isPlaying: false },
    })
    const { actions, getState } = makeActions(state)
    actions.copyClips(['src'])
    actions.pasteClips(5, { insert: true })
    const clips = getState().project.timeline!.tracks[0].clips
    const tail = clips.find((c: Clip) => c.id === 'tail')!
    // 'src' was 2s long, anchored at 0. Pasted at t=5 spans [5, 7]. Insert
    // shifts every clip on v1 with startTime >= 5 by (7 - 5) = 2 seconds.
    // tail was at 10 → 12.
    expect(tail.startTime).toBe(12)
  })

  it('pasteClips (overlay) never overlaps existing clips — shifts to the nearest free gap (T15)', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'src', trackId: 'v1', sourceId: 'src-s', startTime: 0, duration: 4, sourceType: 'video' }),
        // An existing clip sitting exactly where the paste target lands.
        makeClip({ id: 'occupant', trackId: 'v1', sourceId: 'src-o', startTime: 8, duration: 6, sourceType: 'video' }),
      ],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      timelineTransport: { globalTime: 10, totalDuration: 30, isPlaying: false },
    })
    const { actions, getState } = makeActions(state)
    actions.copyClips(['src'])
    const pasted = actions.pasteClips(10) // target 10..14 collides with occupant 8..14
    const clips = getState().project.timeline!.tracks[0].clips
    const pastedClip = clips.find((c: Clip) => pasted.includes(c.id))!
    // Must not overlap the occupant (8..14): the nearest free gap is at/after 14.
    expect(pastedClip.startTime).toBeGreaterThanOrEqual(14)
    const occ = clips.find((c: Clip) => c.id === 'occupant')!
    const overlaps =
      pastedClip.startTime < occ.startTime + occ.duration && pastedClip.startTime + pastedClip.duration > occ.startTime
    expect(overlaps).toBe(false)
  })

  it('pasteClips (overlay) preserves relative offsets across a multi-clip group when shifting (T15)', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'a', trackId: 'v1', sourceId: 'src-a', startTime: 0, duration: 2, sourceType: 'video' }),
        makeClip({ id: 'b', trackId: 'v1', sourceId: 'src-b', startTime: 5, duration: 2, sourceType: 'video' }),
        // Occupant covering the paste target so the group must shift.
        makeClip({ id: 'occ', trackId: 'v1', sourceId: 'src-o', startTime: 10, duration: 8, sourceType: 'video' }),
      ],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      timelineTransport: { globalTime: 12, totalDuration: 40, isPlaying: false },
    })
    const { actions, getState } = makeActions(state)
    actions.copyClips(['a', 'b']) // anchor 0; rel offsets 0 and 5
    const pasted = actions.pasteClips(12) // a→12, b→17 both inside occ 10..18
    const clips = getState().project.timeline!.tracks[0].clips
    const pastedStarts = clips
      .filter((c: Clip) => pasted.includes(c.id))
      .map((c: Clip) => c.startTime)
      .sort((x: number, y: number) => x - y)
    // Relative offset of 5 between the two pasted clips is preserved.
    expect(pastedStarts[1] - pastedStarts[0]).toBe(5)
    // Neither overlaps the occupant (10..18) → both start at/after 18.
    expect(pastedStarts[0]).toBeGreaterThanOrEqual(18)
  })

  it('pasteClips with no clipboard returns [] and does not mutate state', () => {
    const state = makeState({
      project: { timeline: { tracks: [] }, updatedAt: '' },
      timelineTransport: { globalTime: 0, totalDuration: 0, isPlaying: false },
    })
    const { actions } = makeActions(state)
    expect(actions.pasteClips(5, { insert: true })).toEqual([])
  })

  it('pasteClips remaps linkGroupId and groupId so siblings stay grouped uniquely', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({
          id: 'a',
          trackId: 'v1',
          sourceId: 'src-a',
          startTime: 0,
          duration: 2,
          sourceType: 'video',
          linkGroupId: 'orig-link',
        }),
        makeClip({
          id: 'b',
          trackId: 'v1',
          sourceId: 'src-b',
          startTime: 0,
          duration: 2,
          sourceType: 'video',
          linkGroupId: 'orig-link',
        }),
      ],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      timelineTransport: { globalTime: 10, totalDuration: 20, isPlaying: false },
    })
    const { actions, getState } = makeActions(state)
    actions.copyClips(['a', 'b'])
    const pasted = actions.pasteClips(10)
    const allClips = getState().project.timeline!.tracks.flatMap((t: Track) => t.clips)
    const pastedClips = allClips.filter((c: Clip) => pasted.includes(c.id))
    const newLinkIds = new Set(pastedClips.map((c: Clip) => c.linkGroupId))
    expect(newLinkIds.size).toBe(1) // both pasted clips share ONE new link group
    expect(newLinkIds.has('orig-link')).toBe(false) // and it's NOT the original id
  })
})

describe('sequence in/out + add edit', () => {
  it('setSequenceInPoint clamps below zero and clears out-point when in passes it', () => {
    const v1 = makeTrack({ id: 'v1', clips: [] })
    const state = makeState({
      project: { timeline: { tracks: [v1], outPoint: 5 }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.setSequenceInPoint(-1) // clamped to 0
    expect(getState().project.timeline!.inPoint).toBe(0)
    actions.setSequenceInPoint(10) // > existing out (5) → outPoint cleared
    expect(getState().project.timeline!.inPoint).toBe(10)
    expect(getState().project.timeline!.outPoint).toBeUndefined()
  })

  it('setSequenceInPoint(null) clears the mark', () => {
    const v1 = makeTrack({ id: 'v1', clips: [] })
    const state = makeState({
      project: { timeline: { tracks: [v1], inPoint: 5 }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.setSequenceInPoint(null)
    expect(getState().project.timeline!.inPoint).toBeUndefined()
  })

  it('addEditAtTime splits every clip whose range covers the time', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [makeClip({ id: 'a', trackId: 'v1', sourceId: 'src-a', startTime: 0, duration: 10, sourceType: 'video' })],
    })
    const v2 = makeTrack({
      id: 'v2',
      position: 1,
      clips: [makeClip({ id: 'b', trackId: 'v2', sourceId: 'src-b', startTime: 5, duration: 10, sourceType: 'video' })],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1, v2] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    const newRightIds = actions.addEditAtTime(7)
    // Both 'a' (covers 7) and 'b' (covers 7) get split → 2 new right halves.
    expect(newRightIds).toHaveLength(2)
    const allClips = getState().project.timeline!.tracks.flatMap((t: Track) => t.clips)
    // 4 clips total now (each original became two).
    expect(allClips.length).toBe(4)
  })

  it('addEditAtTime skips locked tracks', () => {
    const v1 = makeTrack({
      id: 'v1',
      locked: true,
      clips: [makeClip({ id: 'a', trackId: 'v1', sourceId: 'src-a', startTime: 0, duration: 10, sourceType: 'video' })],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.addEditAtTime(5)
    expect(getState().project.timeline!.tracks[0].clips.length).toBe(1)
  })

  it('addEditAtTime pushes undo exactly once per call (not once per split)', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [makeClip({ id: 'a', trackId: 'v1', sourceId: 'sa', startTime: 0, duration: 10, sourceType: 'video' })],
    })
    const v2 = makeTrack({
      id: 'v2',
      position: 1,
      clips: [makeClip({ id: 'b', trackId: 'v2', sourceId: 'sb', startTime: 5, duration: 10, sourceType: 'video' })],
    })
    const pushUndo = vi.fn()
    const state = makeState({
      project: { timeline: { tracks: [v1, v2] }, updatedAt: '' },
      _pushUndo: pushUndo,
    })
    const { actions } = makeActions(state)
    // Two clips cover t=7 → both split. Should still be exactly ONE undo push.
    actions.addEditAtTime(7)
    expect(pushUndo).toHaveBeenCalledTimes(1)
  })

  it('addEditAtTime does not push undo when no clips were eligible', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [makeClip({ id: 'a', trackId: 'v1', sourceId: 'sa', startTime: 0, duration: 5, sourceType: 'video' })],
    })
    const pushUndo = vi.fn()
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      _pushUndo: pushUndo,
    })
    const { actions } = makeActions(state)
    // t=10 is past every clip's range.
    actions.addEditAtTime(10)
    expect(pushUndo).not.toHaveBeenCalled()
  })

  it('addEditAtTime splits scene clips too, alongside the rest (NLE-foundation)', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'sc', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 0, duration: 10 }),
      ],
    })
    const v2 = makeTrack({
      id: 'v2',
      position: 1,
      clips: [makeClip({ id: 'b', trackId: 'v2', sourceId: 'src-b', startTime: 0, duration: 10, sourceType: 'video' })],
    })
    const state = makeState({
      scenes: [{ id: 'scene-a', duration: 10, name: 'A', audioLayer: null } as any],
      project: { timeline: { tracks: [v1, v2] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    const newRightIds = actions.addEditAtTime(5)
    // BOTH the scene clip and the video clip split at the playhead.
    expect(newRightIds).toHaveLength(2)
    expect(getState().project.timeline!.tracks.find((t: Track) => t.id === 'v1')!.clips).toHaveLength(2)
    expect(getState().project.timeline!.tracks.find((t: Track) => t.id === 'v2')!.clips).toHaveLength(2)
  })

  it('addEditAtTime crossing ONLY a scene clip now splits it (undo pushed) (NLE-foundation)', () => {
    const pushUndo = vi.fn()
    const v1 = makeTrack({
      id: 'v1',
      clips: [
        makeClip({ id: 'sc', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 0, duration: 10 }),
      ],
    })
    const state = makeState({
      scenes: [{ id: 'scene-a', duration: 10, name: 'A', audioLayer: null } as any],
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      _pushUndo: pushUndo,
    })
    const { actions, getState } = makeActions(state)
    expect(actions.addEditAtTime(5)).toHaveLength(1)
    expect(pushUndo).toHaveBeenCalled()
    expect(getState().project.timeline!.tracks[0].clips).toHaveLength(2)
  })

  it('addEditAtTime restricts to the given trackIds when provided', () => {
    const v1 = makeTrack({
      id: 'v1',
      clips: [makeClip({ id: 'a', trackId: 'v1', sourceId: 'src-a', startTime: 0, duration: 10, sourceType: 'video' })],
    })
    const v2 = makeTrack({
      id: 'v2',
      position: 1,
      clips: [makeClip({ id: 'b', trackId: 'v2', sourceId: 'src-b', startTime: 0, duration: 10, sourceType: 'video' })],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1, v2] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.addEditAtTime(5, ['v1'])
    const v1Clips = getState().project.timeline!.tracks.find((t: Track) => t.id === 'v1')!.clips
    const v2Clips = getState().project.timeline!.tracks.find((t: Track) => t.id === 'v2')!.clips
    expect(v1Clips.length).toBe(2) // split happened
    expect(v2Clips.length).toBe(1) // untouched
  })
})

describe('removeClipRipple — scoped to the affected track', () => {
  it('deleting a V2 overlay ripples ITS track but leaves V1 + audio lanes untouched', () => {
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      clips: [
        makeClip({ id: 'sc', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 5, duration: 5 }),
      ],
    })
    const v2 = makeTrack({
      id: 'v2',
      type: 'video',
      position: 1,
      clips: [
        makeClip({ id: 'ov', trackId: 'v2', sourceType: 'video', sourceId: 'vid', startTime: 0, duration: 4 }),
        makeClip({ id: 'ov2', trackId: 'v2', sourceType: 'video', sourceId: 'vid2', startTime: 5, duration: 3 }),
      ],
    })
    const a1 = makeTrack({
      id: 'a1',
      type: 'audio',
      position: 2,
      clips: [makeClip({ id: 'aud', trackId: 'a1', sourceType: 'audio', sourceId: 'song', startTime: 5, duration: 5 })],
    })
    const state = makeState({
      scenes: [{ id: 'scene-a', duration: 5, name: 'A', audioLayer: null } as any],
      project: { timeline: { tracks: [v1, v2, a1] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('ov') // delete the V2 overlay [0–4]

    const tracks = (getState().project as any).timeline.tracks as Track[]
    // The later clip on V2 (the deleted clip's OWN track) ripples left by 4: 5 → 1.
    expect(tracks.find((t) => t.id === 'v2')!.clips.find((c: Clip) => c.id === 'ov2')!.startTime).toBe(1)
    // V1 scene clip + the unrelated audio clip on OTHER tracks are UNCHANGED.
    expect(tracks.find((t) => t.id === 'v1')!.clips.find((c: Clip) => c.id === 'sc')!.startTime).toBe(5)
    expect(tracks.find((t) => t.id === 'a1')!.clips.find((c: Clip) => c.id === 'aud')!.startTime).toBe(5)
  })

  it('scene-clip delete ripples linked audio lanes but leaves an UNRELATED audio lane alone', () => {
    // The complex half: deleting scene-a must shift scene-b AND scene-b's linked
    // narration (soundtrack stays synced), while a standalone song the user dropped
    // on a separate lane must NOT move.
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      clips: [
        makeClip({ id: 'sa', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 0, duration: 5 }),
        makeClip({ id: 'sb', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-b', startTime: 5, duration: 5 }),
      ],
    })
    const a1 = makeTrack({
      id: 'a1',
      type: 'audio',
      position: 1,
      clips: [
        makeClip({ id: 'ta', trackId: 'a1', sourceType: 'audio', sourceId: 'tts-scene-a', startTime: 0, duration: 5 }),
        makeClip({ id: 'tb', trackId: 'a1', sourceType: 'audio', sourceId: 'tts-scene-b', startTime: 5, duration: 5 }),
      ],
    })
    const a3 = makeTrack({
      id: 'a3',
      type: 'audio',
      position: 2,
      clips: [
        makeClip({
          id: 'song',
          trackId: 'a3',
          sourceType: 'audio',
          sourceId: 'unrelated-song',
          startTime: 5,
          duration: 3,
        }),
      ],
    })
    const state = makeState({
      scenes: [
        { id: 'scene-a', duration: 5, name: 'A', audioLayer: null } as any,
        { id: 'scene-b', duration: 5, name: 'B', audioLayer: null } as any,
      ],
      project: { timeline: { tracks: [v1, a1, a3] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('sa') // ripple-delete scene-a's V1 clip

    const tracks = (getState().project as any).timeline.tracks as Track[]
    // scene-b (V1) and its linked narration (A1) both ripple left by 5 → 0.
    expect(tracks.find((t) => t.id === 'v1')!.clips.find((c: Clip) => c.id === 'sb')!.startTime).toBe(0)
    expect(tracks.find((t) => t.id === 'a1')!.clips.find((c: Clip) => c.id === 'tb')!.startTime).toBe(0)
    // scene-a's own linked narration is deleted with it.
    expect(tracks.find((t) => t.id === 'a1')!.clips.find((c: Clip) => c.id === 'ta')).toBeUndefined()
    // The unrelated standalone song on its own lane is UNTOUCHED.
    expect(tracks.find((t) => t.id === 'a3')!.clips.find((c: Clip) => c.id === 'song')!.startTime).toBe(5)
  })

  it('REMOVES the scene from scenes[] and re-homes graph + selection (v4 #5 orphan)', () => {
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      clips: [
        makeClip({ id: 'sa', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 0, duration: 5 }),
        makeClip({ id: 'sb', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-b', startTime: 5, duration: 5 }),
      ],
    })
    const state = makeState({
      scenes: [
        { id: 'scene-a', duration: 5, name: 'A', audioLayer: null } as any,
        { id: 'scene-b', duration: 5, name: 'B', audioLayer: null } as any,
      ],
      selectedSceneId: 'scene-a',
      project: {
        timeline: { tracks: [v1] },
        updatedAt: '',
        sceneGraph: {
          nodes: [{ id: 'scene-a' }, { id: 'scene-b' }],
          edges: [{ fromSceneId: 'scene-a', toSceneId: 'scene-b' }],
          startSceneId: 'scene-a',
        },
      },
    })
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('sa')

    const s = getState() as any
    // The scene is gone from scenes[] — previously it lingered as an orphan and the
    // next sync minted a fresh clip (snap-back) or the preview played a "deleted" scene.
    expect(s.scenes.map((x: any) => x.id)).toEqual(['scene-b'])
    // Selection moves off the deleted scene; sceneGraph node/edge dropped + start re-homed.
    expect(s.selectedSceneId).toBe('scene-b')
    expect(s.project.sceneGraph.nodes.map((n: any) => n.id)).toEqual(['scene-b'])
    expect(s.project.sceneGraph.edges).toHaveLength(0)
    expect(s.project.sceneGraph.startSceneId).toBe('scene-b')
  })

  it("also drops the scene's avatar clips — cascade parity the old local rule missed (v4 #5)", () => {
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      clips: [
        makeClip({ id: 'sa', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 0, duration: 5 }),
      ],
    })
    const v2 = makeTrack({
      id: 'v2',
      type: 'video',
      position: 1,
      clips: [
        makeClip({
          id: 'av',
          trackId: 'v2',
          sourceType: 'avatar',
          sourceId: 'av-layer-1',
          startTime: 0,
          duration: 5,
          linkGroupId: 'avatar:av-layer-1',
        }),
      ],
    })
    const a1 = makeTrack({
      id: 'a1',
      type: 'audio',
      position: 2,
      clips: [
        makeClip({
          id: 'ava',
          trackId: 'a1',
          sourceType: 'audio',
          sourceId: 'avatar-audio:av-layer-1',
          startTime: 0,
          duration: 5,
          linkGroupId: 'avatar:av-layer-1',
        }),
      ],
    })
    const state = makeState({
      scenes: [
        {
          id: 'scene-a',
          duration: 5,
          name: 'A',
          audioLayer: null,
          aiLayers: [{ id: 'av-layer-1', type: 'avatar' }],
        } as any,
      ],
      project: { timeline: { tracks: [v1, v2, a1] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('sa')

    const tracks = (getState().project as any).timeline.tracks as Track[]
    // Avatar video + audio clips of the deleted scene go too (keyed by avatar layer id,
    // not sceneId — the shared cascade catches them; the old aud-/tts-/mus- rule didn't).
    expect(tracks.find((t) => t.id === 'v2')!.clips.find((c: Clip) => c.id === 'av')).toBeUndefined()
    expect(tracks.find((t) => t.id === 'a1')!.clips.find((c: Clip) => c.id === 'ava')).toBeUndefined()
    expect(getState().scenes).toHaveLength(0)
  })
})

// ── removeClipRipple — source-state cascade (v5 T12: F2/F3/F4) ──────────────

describe('removeClipRipple — source-state cascade (v5 T12)', () => {
  // Avatar A/V pair mirrored from scene.aiLayers (see syncTimelineFromScenes):
  // V1 holds the scene clip, V2 the avatar video + a later unrelated clip,
  // A1 the linked avatar audio sibling.
  function avatarPairState() {
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      clips: [
        makeClip({ id: 'sa', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 0, duration: 10 }),
      ],
    })
    const v2 = makeTrack({
      id: 'v2',
      type: 'video',
      position: 1,
      clips: [
        makeClip({
          id: 'av',
          trackId: 'v2',
          sourceType: 'avatar',
          sourceId: 'av1',
          startTime: 0,
          duration: 3,
          linkGroupId: 'avatar:av1',
        }),
        makeClip({ id: 'later', trackId: 'v2', sourceType: 'video', sourceId: 'vid', startTime: 4, duration: 2 }),
      ],
    })
    const a1 = makeTrack({
      id: 'a1',
      type: 'audio',
      position: 2,
      clips: [
        makeClip({
          id: 'ava',
          trackId: 'a1',
          sourceType: 'audio',
          sourceId: 'avatar-audio:av1',
          startTime: 0,
          duration: 3,
          linkGroupId: 'avatar:av1',
        }),
      ],
    })
    return makeState({
      scenes: [
        {
          id: 'scene-a',
          duration: 10,
          name: 'A',
          audioLayer: null,
          aiLayers: [{ id: 'av1', type: 'avatar', label: 'Host' }],
          textOverlays: [],
        } as any,
      ],
      project: { timeline: { tracks: [v1, v2, a1] }, updatedAt: '' },
      saveSceneHTML: vi.fn(),
    })
  }

  it('ripple of an avatar clip strips the aiLayer + removes the linked sibling + ripples later clips (F2)', () => {
    const state = avatarPairState()
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('av')

    const s = getState() as any
    // Source mutation: the avatar layer is gone, so sync can't resurrect it.
    expect(s.scenes[0].aiLayers).toEqual([])
    const tracks = s.project.timeline.tracks as Track[]
    // BOTH halves of the linked pair are gone (video + audio sibling).
    expect(tracks.find((t) => t.id === 'v2')!.clips.find((c: Clip) => c.id === 'av')).toBeUndefined()
    expect(tracks.find((t) => t.id === 'a1')!.clips.find((c: Clip) => c.id === 'ava')).toBeUndefined()
    // The later clip on the avatar's track rippled left by the avatar's duration: 4 → 1.
    expect(tracks.find((t) => t.id === 'v2')!.clips.find((c: Clip) => c.id === 'later')!.startTime).toBe(1)
    // The scene HTML regenerates (avatar layers are baked into it).
    expect(s.saveSceneHTML).toHaveBeenCalledWith('scene-a', true)
  })

  it('the next syncTimelineFromScenes does NOT resurrect a ripple-deleted avatar (F2)', () => {
    const state = avatarPairState()
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('av')
    actions.syncTimelineFromScenes()

    const allClips = ((getState().project as any).timeline.tracks as Track[]).flatMap((t) => t.clips)
    expect(allClips.filter((c: Clip) => c.linkGroupId === 'avatar:av1')).toHaveLength(0)
    expect(allClips.filter((c: Clip) => c.sourceType === 'avatar')).toHaveLength(0)
    expect(allClips.filter((c: Clip) => c.sourceId === 'avatar-audio:av1')).toHaveLength(0)
  })

  // Title clip mirrored from scene.textOverlays (linkGroupId `text:<overlayId>`,
  // sourceId = overlay id — see the sync's text mirroring).
  function titleClipState() {
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      clips: [
        makeClip({ id: 'sa', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 0, duration: 10 }),
      ],
    })
    const v2 = makeTrack({
      id: 'v2',
      type: 'video',
      position: 1,
      clips: [
        makeClip({
          id: 'ttl',
          trackId: 'v2',
          sourceType: 'title',
          sourceId: 'ov1',
          startTime: 1,
          duration: 2,
          linkGroupId: 'text:ov1',
        }),
      ],
    })
    return makeState({
      scenes: [
        {
          id: 'scene-a',
          duration: 10,
          name: 'A',
          audioLayer: null,
          textOverlays: [{ id: 'ov1', content: 'Hello', duration: 2, delay: 1 }],
        } as any,
      ],
      project: { timeline: { tracks: [v1, v2] }, updatedAt: '' },
      saveSceneHTML: vi.fn(),
    })
  }

  it('ripple of a title clip removes the scene.textOverlays entry; sync emits nothing (F3)', () => {
    const state = titleClipState()
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('ttl')

    const s = getState() as any
    expect(s.scenes[0].textOverlays).toEqual([])
    expect(s.saveSceneHTML).toHaveBeenCalledWith('scene-a', true)

    actions.syncTimelineFromScenes()
    const allClips = ((getState().project as any).timeline.tracks as Track[]).flatMap((t) => t.clips)
    expect(allClips.filter((c: Clip) => c.sourceType === 'title')).toHaveLength(0)
  })

  it('PLAIN removeClip of a title clip also removes the textOverlays entry (F3, via the shared reducer cascade)', () => {
    const state = titleClipState()
    const { actions, getState } = makeActions(state)
    actions.removeClip('ttl')

    const s = getState() as any
    expect(s.scenes[0].textOverlays).toEqual([])
    expect(
      ((s.project as any).timeline.tracks as Track[]).flatMap((t) => t.clips).find((c: Clip) => c.id === 'ttl'),
    ).toBeUndefined()

    actions.syncTimelineFromScenes()
    const allClips = ((getState().project as any).timeline.tracks as Track[]).flatMap((t) => t.clips)
    expect(allClips.filter((c: Clip) => c.sourceType === 'title')).toHaveLength(0)
  })

  it('refuses to ripple-delete a clip on a locked track (F4, reducer TRACK_LOCKED parity)', () => {
    const pushUndo = vi.fn()
    const toast = vi.fn()
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      locked: true,
      clips: [makeClip({ id: 'c1', trackId: 'v1', sourceType: 'video', sourceId: 'vid', startTime: 0, duration: 3 })],
    })
    const state = makeState({
      project: { timeline: { tracks: [v1] }, updatedAt: '' },
      _pushUndo: pushUndo,
      showTransientStatus: toast,
    })
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('c1')

    // Clip untouched, no undo slot consumed, refusal surfaced to the user.
    expect((getState().project as any).timeline.tracks[0].clips).toHaveLength(1)
    expect(pushUndo).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalled()
  })

  it('a linked sibling on a LOCKED track is removed (reducer parity) but the locked track does NOT ripple-shift', () => {
    // Target on unlocked V2; its linked audio sibling sits on a locked A1 that
    // also holds an unrelated later clip. The sibling goes (same as plain
    // removeClip via the reducer), but lock semantics forbid shifting the
    // locked track's other clips.
    const v2 = makeTrack({
      id: 'v2',
      type: 'video',
      position: 0,
      clips: [
        makeClip({
          id: 'av',
          trackId: 'v2',
          sourceType: 'avatar',
          sourceId: 'av1',
          startTime: 0,
          duration: 3,
          linkGroupId: 'avatar:av1',
        }),
        makeClip({ id: 'later-v', trackId: 'v2', sourceType: 'video', sourceId: 'vid', startTime: 4, duration: 2 }),
      ],
    })
    const a1 = makeTrack({
      id: 'a1',
      type: 'audio',
      position: 1,
      locked: true,
      clips: [
        makeClip({
          id: 'ava',
          trackId: 'a1',
          sourceType: 'audio',
          sourceId: 'avatar-audio:av1',
          startTime: 0,
          duration: 3,
          linkGroupId: 'avatar:av1',
        }),
        makeClip({ id: 'later-a', trackId: 'a1', sourceType: 'audio', sourceId: 'aud', startTime: 5, duration: 2 }),
      ],
    })
    const state = makeState({
      scenes: [
        {
          id: 'scene-a',
          duration: 10,
          name: 'A',
          audioLayer: null,
          aiLayers: [{ id: 'av1', type: 'avatar', label: 'Host' }],
          textOverlays: [],
        } as any,
      ],
      project: { timeline: { tracks: [v2, a1] }, updatedAt: '' },
      saveSceneHTML: vi.fn(),
    })
    const { actions, getState } = makeActions(state)
    actions.removeClipRipple('av')

    const tracks = (getState().project as any).timeline.tracks as Track[]
    // Sibling removed despite the lock (parity with the reducer's removeLinkedClips).
    expect(tracks.find((t) => t.id === 'a1')!.clips.find((c: Clip) => c.id === 'ava')).toBeUndefined()
    // The UNLOCKED target track ripples: 4 → 1.
    expect(tracks.find((t) => t.id === 'v2')!.clips.find((c: Clip) => c.id === 'later-v')!.startTime).toBe(1)
    // The LOCKED track's later clip does NOT shift: stays at 5.
    expect(tracks.find((t) => t.id === 'a1')!.clips.find((c: Clip) => c.id === 'later-a')!.startTime).toBe(5)
  })
})

// ── B4: withTracks preserves markers/inPoint/outPoint ─────────────────────────
describe('withTracks (B4)', () => {
  const base: Timeline = {
    tracks: [makeTrack({ id: 'v1' })],
    markers: [{ id: 'm1', time: 2 }],
    inPoint: 1,
    outPoint: 8,
  } as any

  it('swaps tracks while preserving markers/inPoint/outPoint', () => {
    const next = withTracks(base, [makeTrack({ id: 'v2', position: 1 })])
    expect(next.tracks.map((t) => t.id)).toEqual(['v2'])
    expect(next.markers).toEqual([{ id: 'm1', time: 2 }])
    expect(next.inPoint).toBe(1)
    expect(next.outPoint).toBe(8)
  })

  it('handles a null timeline (fresh tracks, no crash)', () => {
    const next = withTracks(null, [makeTrack({ id: 'v1' })])
    expect(next.tracks.map((t) => t.id)).toEqual(['v1'])
    expect(next.markers).toBeUndefined()
  })
})

// ── B2: applyAgentTimeline merges + saves ─────────────────────────────────────
describe('applyAgentTimeline (B2)', () => {
  it('merges the agent timeline and schedules a save', () => {
    const save = vi.fn()
    const state = makeState({
      project: { timeline: { tracks: [makeTrack({ id: 'old' })], markers: [{ id: 'm1', time: 2 }] }, updatedAt: '' },
      scheduleSaveProjectToDb: save,
    })
    const { actions, getState } = makeActions(state)
    actions.applyAgentTimeline({ tracks: [makeTrack({ id: 'new', position: 0 })] } as any)
    const tl = (getState().project as any).timeline as Timeline
    expect(tl.tracks.map((t) => t.id)).toEqual(['new'])
    // The agent timeline dropped markers; the merge preserves the renderer's.
    expect((tl as any).markers).toEqual([{ id: 'm1', time: 2 }])
    expect(save).toHaveBeenCalledTimes(1)
    expect((getState() as any)._isDirty).toBe(true)
  })

  it('lets the agent timeline win on overlapping fields (its markers replace)', () => {
    const state = makeState({
      project: { timeline: { tracks: [makeTrack({ id: 'old' })], markers: [{ id: 'm1', time: 2 }] }, updatedAt: '' },
    })
    const { actions, getState } = makeActions(state)
    actions.applyAgentTimeline({ tracks: [makeTrack({ id: 'new' })], markers: [{ id: 'm2', time: 5 }] } as any)
    expect(((getState().project as any).timeline as any).markers).toEqual([{ id: 'm2', time: 5 }])
  })

  it('is a no-op (no save) when the timeline is null — a scene-only run', () => {
    const save = vi.fn()
    const state = makeState({ scheduleSaveProjectToDb: save })
    const { actions, getState } = makeActions(state)
    actions.applyAgentTimeline(null)
    expect(save).not.toHaveBeenCalled()
    expect((getState().project as any).timeline).toBeNull()
  })
})

// ── B4: markers / inPoint / outPoint survive a sync AND a clip move ───────────
describe('markers survive timeline mutations (B4)', () => {
  it('syncTimelineFromScenes preserves markers + inPoint + outPoint', () => {
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      clips: [
        makeClip({ id: 'sc', trackId: 'v1', sourceType: 'scene', sourceId: 'scene-a', startTime: 10, duration: 5 }),
      ],
    })
    const state = makeState({
      scenes: [{ id: 'scene-a', duration: 5, name: 'A', audioLayer: null } as any],
      project: {
        timeline: { tracks: [v1], markers: [{ id: 'm1', time: 3, label: 'Intro' }], inPoint: 1, outPoint: 4 },
        updatedAt: '',
      },
    })
    const { actions, getState } = makeActions(state)
    actions.syncTimelineFromScenes()
    const tl = (getState().project as any).timeline
    // Timeline-authoritative (Phase 0): the scene clip KEEPS its position (10),
    // sync no longer repacks to 0 — AND markers / inPoint / outPoint survive.
    expect(tl.tracks[0].clips[0].startTime).toBe(10)
    expect(tl.markers).toEqual([{ id: 'm1', time: 3, label: 'Intro' }])
    expect(tl.inPoint).toBe(1)
    expect(tl.outPoint).toBe(4)
  })

  it('moveClip preserves markers + inPoint + outPoint', () => {
    const v1 = makeTrack({
      id: 'v1',
      type: 'video',
      position: 0,
      clips: [makeClip({ id: 'c1', trackId: 'v1', sourceType: 'video', sourceId: 'vid', startTime: 0, duration: 4 })],
    })
    const v2 = makeTrack({ id: 'v2', type: 'video', position: 1, clips: [] })
    const state = makeState({
      scenes: [],
      project: {
        timeline: { tracks: [v1, v2], markers: [{ id: 'm1', time: 2 }], inPoint: 0.5, outPoint: 3.5 },
        updatedAt: '',
      },
    })
    const { actions, getState } = makeActions(state)
    actions.moveClip('c1', 'v2', 6)
    const tl = (getState().project as any).timeline
    expect(tl.tracks.find((t: Track) => t.id === 'v2')!.clips.find((c: Clip) => c.id === 'c1')!.startTime).toBe(6)
    expect(tl.markers).toEqual([{ id: 'm1', time: 2 }])
    expect(tl.inPoint).toBe(0.5)
    expect(tl.outPoint).toBe(3.5)
  })

  it('addTrack / removeTrack preserve markers', () => {
    const state = makeState({
      project: {
        timeline: { tracks: [makeTrack({ id: 'v1' })], markers: [{ id: 'm1', time: 2 }], inPoint: 1 },
        updatedAt: '',
      },
    })
    const { actions, getState } = makeActions(state)
    const newId = actions.addTrack('audio', 'A1')
    expect((getState().project as any).timeline.markers).toEqual([{ id: 'm1', time: 2 }])
    actions.removeTrack(newId)
    expect((getState().project as any).timeline.markers).toEqual([{ id: 'm1', time: 2 }])
    expect((getState().project as any).timeline.inPoint).toBe(1)
  })
})

// ── Overlapping SFX cascade onto separate tracks (like video → V2/V3) ─────────
describe('SFX track cascade on overlap', () => {
  // helper: the audio track holding a given sfx sourceId
  const trackOf = (tracks: Track[], sourceId: string) =>
    tracks.find((t) => t.clips.some((c) => c.sourceId === sourceId))

  const overlappingScene = () =>
    ({
      id: 'sc-1',
      duration: 6,
      name: 'A',
      audioLayer: {
        enabled: false,
        src: null,
        sfx: [
          { id: 'rain', name: 'Rain', triggerAt: 0, duration: 4 }, // 0–4
          { id: 'boom', name: 'Boom', triggerAt: 1, duration: 0.5 }, // overlaps rain
          { id: 'zap', name: 'Zap', triggerAt: 1.2, duration: 0.5 }, // overlaps rain + boom
        ],
      },
    }) as any

  it('initTimeline: 3 overlapping SFX land on 3 distinct audio tracks (A3/A4/A5)', () => {
    const { actions, getState } = makeActions(makeState({ scenes: [overlappingScene()] }))
    actions.initTimeline(true)
    const tracks = (getState().project as any).timeline.tracks as Track[]
    const tRain = trackOf(tracks, 'rain')
    const tBoom = trackOf(tracks, 'boom')
    const tZap = trackOf(tracks, 'zap')
    // each on its own audio track — no two overlapping SFX share a track
    expect(new Set([tRain?.id, tBoom?.id, tZap?.id]).size).toBe(3)
    expect([tRain, tBoom, tZap].every((t) => t?.type === 'audio')).toBe(true)
    expect([tRain?.name, tBoom?.name, tZap?.name].sort()).toEqual(['A3', 'A4', 'A5'])
  })

  it('syncTimelineFromScenes (from empty timeline) cascades overlapping SFX too', () => {
    // No timeline yet → sync defers to initTimeline, but exercise the path.
    const { actions, getState } = makeActions(makeState({ scenes: [overlappingScene()] }))
    actions.initTimeline(true) // give it a timeline
    actions.syncTimelineFromScenes() // re-sync must KEEP them on distinct tracks
    const tracks = (getState().project as any).timeline.tracks as Track[]
    const ids = new Set([trackOf(tracks, 'rain')?.id, trackOf(tracks, 'boom')?.id, trackOf(tracks, 'zap')?.id])
    expect(ids.size).toBe(3)
    // clip identity preserved across the re-sync (no duplicate clips)
    const sfxClips = tracks.flatMap((t) => t.clips).filter((c) => ['rain', 'boom', 'zap'].includes(c.sourceId))
    expect(sfxClips).toHaveLength(3)
  })

  it('non-overlapping SFX stay on ONE track (no needless A4/A5)', () => {
    const scene = {
      id: 'sc-1',
      duration: 6,
      name: 'A',
      audioLayer: {
        enabled: false,
        src: null,
        sfx: [
          { id: 's1', triggerAt: 0, duration: 1 },
          { id: 's2', triggerAt: 2, duration: 1 },
          { id: 's3', triggerAt: 4, duration: 1 },
        ],
      },
    } as any
    const { actions, getState } = makeActions(makeState({ scenes: [scene] }))
    actions.initTimeline(true)
    const tracks = (getState().project as any).timeline.tracks as Track[]
    const audioWithSfx = tracks.filter((t) => t.type === 'audio' && t.clips.length > 0)
    expect(audioWithSfx).toHaveLength(1) // all three share A3
    expect(audioWithSfx[0].clips.map((c) => c.sourceId).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('removing the overlap folds the cascade lane away on re-sync (A4 pruned)', () => {
    const { actions, getState } = makeActions(makeState({ scenes: [overlappingScene()] }))
    actions.initTimeline(true)
    let tracks = (getState().project as any).timeline.tracks as Track[]
    expect(tracks.filter((t) => t.type === 'audio' && t.clips.length > 0)).toHaveLength(3)

    // Drop the two overlapping SFX, leaving only the non-overlapping 'rain'.
    const scenes = getState().scenes as any[]
    scenes[0].audioLayer.sfx = [{ id: 'rain', name: 'Rain', triggerAt: 0, duration: 4 }]
    actions.syncTimelineFromScenes()

    tracks = (getState().project as any).timeline.tracks as Track[]
    const sfxTracks = tracks.filter((t) => t.type === 'audio' && t.clips.length > 0)
    expect(sfxTracks).toHaveLength(1) // A4/A5 pruned
    expect(sfxTracks[0].clips.map((c) => c.sourceId)).toEqual(['rain'])
    // no empty A4/A5 left dangling
    expect(tracks.filter((t) => ['A4', 'A5'].includes(t.name))).toHaveLength(0)
  })
})
