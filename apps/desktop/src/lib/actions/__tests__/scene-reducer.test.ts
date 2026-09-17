// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState, SceneCreateAction } from '../types'
import type { Clip, Timeline } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function emptyState(): ProjectState {
  const scene = createDefaultScene()
  scene.id = 'scene-1'
  scene.name = 'one'
  return {
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
}

describe('scene reducer', () => {
  it('scene/create inserts at the requested position and returns a delete inverse', () => {
    const state = emptyState()
    const newScene = { ...createDefaultScene(), id: 'scene-2', name: 'two' }
    const { result, action } = dispatchSync(
      state,
      { type: 'scene/create', params: { sceneId: 'scene-2', position: 0, scene: newScene } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.scenes.map((s) => s.id)).toEqual(['scene-2', 'scene-1'])
    expect(result.inverseAction?.type).toBe('scene/delete')
    expect(result.inverseAction?.params).toMatchObject({ sceneId: 'scene-2' })
    void action
  })

  it('scene/create rejects duplicate ids', () => {
    const state = emptyState()
    const dup = { ...createDefaultScene(), id: 'scene-1' }
    const { result } = dispatchSync(
      state,
      { type: 'scene/create', params: { sceneId: 'scene-1', scene: dup } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('DUPLICATE_ID')
  })

  it('scene/update applies patch and inverse restores prior values', () => {
    const state = emptyState()
    const { result } = dispatchSync(
      state,
      { type: 'scene/update', params: { sceneId: 'scene-1', patch: { name: 'renamed', duration: 12 } } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.scenes[0].name).toBe('renamed')
    expect(result.state!.scenes[0].duration).toBe(12)

    // Inverse should restore the original values
    const { result: restored } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect(restored.success).toBe(true)
    expect(restored.state!.scenes[0].name).toBe(state.scenes[0].name)
    expect(restored.state!.scenes[0].duration).toBe(state.scenes[0].duration)
  })

  it('scene/update rejects patches that include id', () => {
    const state = emptyState()
    const { result } = dispatchSync(
      state,
      {
        type: 'scene/update',
        params: { sceneId: 'scene-1', patch: { id: 'other' } as Partial<(typeof state.scenes)[number]> },
      },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })

  it('scene/delete removes the scene and inverse restores it at the same index', () => {
    const state = emptyState()
    const newScene = { ...createDefaultScene(), id: 'scene-2', name: 'two' }
    const { result: created } = dispatchSync(
      state,
      { type: 'scene/create', params: { sceneId: 'scene-2', scene: newScene } },
      { source: 'user' },
    )
    expect(created.state!.scenes.map((s) => s.id)).toEqual(['scene-1', 'scene-2'])

    const { result: deleted } = dispatchSync(
      created.state!,
      { type: 'scene/delete', params: { sceneId: 'scene-1' } },
      { source: 'user' },
    )
    expect(deleted.success).toBe(true)
    expect(deleted.state!.scenes.map((s) => s.id)).toEqual(['scene-2'])

    const { result: restored } = dispatchSync(deleted.state!, deleted.inverseAction!, { source: 'replay' })
    expect(restored.state!.scenes.map((s) => s.id)).toEqual(['scene-1', 'scene-2'])
  })

  it('scene/reorder swaps positions and inverse restores order', () => {
    const state = emptyState()
    state.scenes = [
      { ...createDefaultScene(), id: 's1' },
      { ...createDefaultScene(), id: 's2' },
      { ...createDefaultScene(), id: 's3' },
    ]
    const { result } = dispatchSync(
      state,
      { type: 'scene/reorder', params: { fromIndex: 0, toIndex: 2 } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.scenes.map((s) => s.id)).toEqual(['s2', 's3', 's1'])

    const { result: restored } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect(restored.state!.scenes.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('scene/delete with no dependent clips/edges round-trips like before (regression-safe)', () => {
    // Two scenes, no graph edges, no timeline → the cascade has nothing extra
    // to remove and must behave exactly like the pre-cascade delete.
    const s1 = { ...createDefaultScene(), id: 'scene-1', name: 'one' }
    const s2 = { ...createDefaultScene(), id: 'scene-2', name: 'two' }
    const project = createDefaultProject([s1, s2])
    project.sceneGraph = { ...project.sceneGraph, edges: [] }
    const state: ProjectState = {
      scenes: [s1, s2],
      globalStyle: {
        presetId: null,
        palette: ['#000', '#111', '#222', '#333'],
        duration: 8,
      } as unknown as ProjectState['globalStyle'],
      project,
      selectedSceneId: 'scene-1',
      uiEditingLayerId: null,
    }

    const { result: deleted } = dispatchSync(
      state,
      { type: 'scene/delete', params: { sceneId: 'scene-1' } },
      { source: 'user' },
    )
    expect(deleted.success).toBe(true)
    expect(deleted.state!.scenes.map((s) => s.id)).toEqual(['scene-2'])
    expect(deleted.state!.project.sceneGraph.nodes.map((n) => n.id)).toEqual(['scene-2'])
    expect(deleted.state!.project.timeline ?? null).toBe(null)

    const { result: restored } = dispatchSync(deleted.state!, deleted.inverseAction!, { source: 'replay' })
    expect(restored.success).toBe(true)
    expect(restored.state!.scenes.map((s) => s.id)).toEqual(['scene-1', 'scene-2'])
    expect(restored.state!.project.sceneGraph.nodes.map((n) => n.id)).toEqual(['scene-1', 'scene-2'])
  })

  it('reducer freezes the input state in dev (mutation throws)', () => {
    const state = emptyState()
    const newScene = { ...createDefaultScene(), id: 'scene-2', name: 'two' }
    const { result } = dispatchSync(
      state,
      { type: 'scene/create', params: { sceneId: 'scene-2', scene: newScene } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    // The original input must not have been mutated
    expect(state.scenes.length).toBe(1)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.scenes)).toBe(true)
  })

  it('source is set by dispatcher and not trusted from input', () => {
    const state = emptyState()
    const newScene = { ...createDefaultScene(), id: 'scene-2', name: 'two' }
    // Cast through unknown so TS lets us pretend the caller spoofed `source`.
    const malicious = {
      type: 'scene/create',
      params: { sceneId: 'scene-2', scene: newScene },
      source: 'user',
    } as unknown as Parameters<typeof dispatchSync>[1]
    const { action } = dispatchSync(state, malicious, { source: 'agent' })
    expect((action as SceneCreateAction).source).toBe('agent')
  })
})

// ── D-T1: scene/delete cascade (foundational) ──────────────────────────────

function makeClip(id: string, trackId: string, sourceType: Clip['sourceType'], sourceId: string): Clip {
  return {
    id,
    trackId,
    sourceType,
    sourceId,
    label: id,
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
  }
}

/**
 * Two scenes wired through the timeline + scene graph:
 *   - scene track: one scene clip per scene
 *   - audio track: tts/mus clips bound to scene-1, plus one unrelated clip
 *   - graph: scene-1 → scene-2 edge
 */
function cascadeState(): ProjectState {
  const s1 = { ...createDefaultScene(), id: 'scene-1', name: 'one' }
  const s2 = { ...createDefaultScene(), id: 'scene-2', name: 'two' }
  const project = createDefaultProject([s1, s2])
  const timeline: Timeline = {
    tracks: [
      {
        id: 'scenes',
        name: 'Scenes',
        type: 'scene',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip('sc1', 'scenes', 'scene', 'scene-1'), makeClip('sc2', 'scenes', 'scene', 'scene-2')],
      },
      {
        id: 'audio',
        name: 'Audio',
        type: 'audio',
        muted: false,
        locked: false,
        position: 1,
        clips: [
          makeClip('tts1', 'audio', 'audio', 'tts-scene-1'),
          makeClip('mus1', 'audio', 'audio', 'mus-scene-1'),
          makeClip('other', 'audio', 'audio', 'voiceover'),
        ],
      },
    ],
  }
  project.timeline = timeline
  return {
    scenes: [s1, s2],
    globalStyle: {
      presetId: null,
      palette: ['#000', '#111', '#222', '#333'],
      duration: 8,
    } as unknown as ProjectState['globalStyle'],
    project,
    selectedSceneId: 'scene-1',
    uiEditingLayerId: null,
  }
}

describe('scene/delete cascade (D-T1)', () => {
  it('deletes the scene plus its timeline clips and graph edges', () => {
    const state = cascadeState()
    const { result } = dispatchSync(state, { type: 'scene/delete', params: { sceneId: 'scene-1' } }, { source: 'user' })
    expect(result.success).toBe(true)

    // Scene gone.
    expect(result.state!.scenes.map((s) => s.id)).toEqual(['scene-2'])

    // Scene clip + bound audio clips gone; the surviving scene's clip and the
    // unrelated audio clip remain.
    const tl = result.state!.project.timeline!
    const sceneClipIds = tl.tracks.find((t) => t.id === 'scenes')!.clips.map((c) => c.id)
    const audioClipIds = tl.tracks.find((t) => t.id === 'audio')!.clips.map((c) => c.id)
    expect(sceneClipIds).toEqual(['sc2'])
    expect(audioClipIds).toEqual(['other'])

    // Graph node + edge touching scene-1 gone; start re-homed.
    const g = result.state!.project.sceneGraph
    expect(g.nodes.map((n) => n.id)).toEqual(['scene-2'])
    expect(g.edges.length).toBe(0)
    expect(g.startSceneId).toBe('scene-2')
  })

  it('CRITICAL: inverse restores a coherent world (scene + clips + edges)', () => {
    const state = cascadeState()
    const { result: deleted } = dispatchSync(
      state,
      { type: 'scene/delete', params: { sceneId: 'scene-1' } },
      { source: 'user' },
    )
    expect(deleted.success).toBe(true)
    expect(deleted.inverseAction!.type).toBe('agent/applyRun')

    const { result: undone } = dispatchSync(deleted.state!, deleted.inverseAction!, { source: 'replay' })
    expect(undone.success).toBe(true)

    // Scenes restored.
    expect(undone.state!.scenes.map((s) => s.id)).toEqual(['scene-1', 'scene-2'])

    // Timeline restored — both scene clips and all three audio clips back.
    const tl = undone.state!.project.timeline!
    expect(tl.tracks.find((t) => t.id === 'scenes')!.clips.map((c) => c.id)).toEqual(['sc1', 'sc2'])
    expect(tl.tracks.find((t) => t.id === 'audio')!.clips.map((c) => c.id)).toEqual(['tts1', 'mus1', 'other'])

    // Graph restored — node + edge back.
    const g = undone.state!.project.sceneGraph
    expect(g.nodes.map((n) => n.id)).toEqual(['scene-1', 'scene-2'])
    expect(g.edges.map((e) => `${e.fromSceneId}->${e.toSceneId}`)).toEqual(['scene-1->scene-2'])
    expect(g.startSceneId).toBe('scene-1')
  })

  it('undo of a scene delete schedules a project save (persists across reload)', () => {
    // The agent/applyRun inverse carries a timeline, which makes the agent
    // reducer emit schedule-project-save on replay — without it, undo would be
    // in-memory only and a reload would revert the delete.
    const state = cascadeState()
    const { result: deleted } = dispatchSync(
      state,
      { type: 'scene/delete', params: { sceneId: 'scene-1' } },
      { source: 'user' },
    )
    const { result: undone } = dispatchSync(deleted.state!, deleted.inverseAction!, { source: 'replay' })
    expect(undone.success).toBe(true)
    expect(undone.effects).toContainEqual({ kind: 'schedule-project-save' })
  })

  it('cascades avatar video + audio clips of the deleted scene (linkgroup-keyed)', () => {
    // An avatar layer emits a video clip (sourceType avatar, sourceId av.id) and
    // an audio clip (sourceType audio, sourceId avatar-audio:av.id), both sharing
    // linkGroupId avatar:<id>. Deleting the scene must drop both.
    const s1 = { ...createDefaultScene(), id: 'scene-1', name: 'one' }
    s1.aiLayers = [{ id: 'av1', type: 'avatar' } as unknown as (typeof s1.aiLayers)[number]]
    const s2 = { ...createDefaultScene(), id: 'scene-2', name: 'two' }
    const project = createDefaultProject([s1, s2])
    const avatarVideo = { ...makeClip('avv', 'video', 'avatar', 'av1'), linkGroupId: 'avatar:av1' }
    const avatarAudio = { ...makeClip('ava', 'audio', 'audio', 'avatar-audio:av1'), linkGroupId: 'avatar:av1' }
    project.timeline = {
      tracks: [
        {
          id: 'scenes',
          name: 'Scenes',
          type: 'scene',
          muted: false,
          locked: false,
          position: 0,
          clips: [makeClip('sc1', 'scenes', 'scene', 'scene-1'), makeClip('sc2', 'scenes', 'scene', 'scene-2')],
        },
        { id: 'video', name: 'Video', type: 'video', muted: false, locked: false, position: 1, clips: [avatarVideo] },
        {
          id: 'audio',
          name: 'Audio',
          type: 'audio',
          muted: false,
          locked: false,
          position: 2,
          clips: [avatarAudio, makeClip('keep', 'audio', 'audio', 'voiceover')],
        },
      ],
    }
    const state: ProjectState = {
      scenes: [s1, s2],
      globalStyle: {
        presetId: null,
        palette: ['#000', '#111', '#222', '#333'],
        duration: 8,
      } as unknown as ProjectState['globalStyle'],
      project,
      selectedSceneId: 'scene-1',
      uiEditingLayerId: null,
    }

    const { result } = dispatchSync(state, { type: 'scene/delete', params: { sceneId: 'scene-1' } }, { source: 'user' })
    expect(result.success).toBe(true)
    const tl = result.state!.project.timeline!
    expect(tl.tracks.find((t) => t.id === 'scenes')!.clips.map((c) => c.id)).toEqual(['sc2'])
    expect(tl.tracks.find((t) => t.id === 'video')!.clips).toEqual([]) // avatar video gone
    expect(tl.tracks.find((t) => t.id === 'audio')!.clips.map((c) => c.id)).toEqual(['keep']) // avatar audio gone, unrelated kept
  })
})
