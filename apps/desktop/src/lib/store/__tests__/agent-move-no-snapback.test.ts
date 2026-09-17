// @vitest-environment node

/**
 * B3 (v6) in-app resurrection test — the bug this lane closes.
 *
 * The agent's move_clip / remove_clip now write through to scene SOURCE state
 * (the SAME pure helpers the renderer uses). This test proves the round trip:
 * run the agent handler against a world, take the world's scenes + timeline,
 * feed them into the renderer store, run `syncTimelineFromScenes` (which ALWAYS
 * runs on Timeline mount and re-derives mirror clips from scene state), and
 * assert the agent's edit SURVIVES — it is not snapped back / resurrected.
 */

import { describe, it, expect, vi } from 'vitest'

// The agent action-emitter writes to WAL/db; stub it (projectId:null also skips
// persistence, but mocking keeps the test hermetic).
vi.mock('@/lib/agents/tool-handlers/action-emitter', () => ({
  emitAgentAction: () => undefined,
  emitterDepsForWorld: () => ({ projectId: null, runId: null }),
}))

import { createTimelineToolHandler } from '@/lib/agents/tool-handlers/timeline-tools'
import { createTimelineActions } from '../timeline-actions'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Clip, Scene, Track } from '@/lib/types'

const handler = createTimelineToolHandler({ executeTool: (async () => ({ success: true })) as any })

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

/** Minimal renderer store wired to the real timeline actions. */
function makeStore(scenes: Scene[], timeline: { tracks: Track[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any = {
    scenes,
    project: { timeline, updatedAt: '' },
    scheduleSaveProjectToDb: vi.fn(),
    recordUserAction: vi.fn(),
    _pushUndo: vi.fn(),
    _pushUndoDebounced: vi.fn(),
    updateScene: vi.fn(),
    flashClip: vi.fn(),
  }
  const get = () => state
  const set = (arg: any) => {
    const next = typeof arg === 'function' ? arg(state) : arg
    state = { ...state, ...next }
  }
  const actions = createTimelineActions(set as any, get as any)
  state = { ...state, ...actions }
  return { get, syncTimelineFromScenes: actions.syncTimelineFromScenes }
}

describe('agent move_clip → store sync: avatar mirror does NOT snap back (B3)', () => {
  it('the avatar startAt the agent wrote survives syncTimelineFromScenes', async () => {
    const world: WorldStateMutable = {
      scenes: [
        {
          id: 'sx',
          name: 'X',
          duration: 10,
          aiLayers: [{ id: 'lay', type: 'avatar', label: 'Host', startAt: 0, estimatedDuration: 4 }],
        } as any,
      ],
      timeline: {
        tracks: [
          track({ id: 'v1', clips: [clip({ id: 'cs', trackId: 'v1', sourceType: 'scene', sourceId: 'sx' })] }),
          track({
            id: 'v2',
            position: 1,
            clips: [
              clip({
                id: 'av',
                trackId: 'v2',
                sourceType: 'avatar',
                sourceId: 'lay',
                linkGroupId: 'avatar:lay',
                duration: 4,
              }),
            ],
          }),
          track({ id: 'a1', type: 'audio', position: 2, clips: [] }),
        ],
      },
      projectId: 'p',
      currentRunId: 'r',
    } as unknown as WorldStateMutable

    // Agent moves the avatar clip to t=3.
    const res = await handler('clip', { op: 'move', clipId: 'av', toTrackId: 'v2', startTime: 3 }, world)
    expect(res.success).toBe(true)
    expect((world.scenes[0] as any).aiLayers[0].startAt).toBe(3) // written through

    // Hand the agent's world to the renderer store and run the sync.
    const store = makeStore(world.scenes as Scene[], world.timeline as { tracks: Track[] })
    store.syncTimelineFromScenes()

    // The re-derived avatar clip is at sceneStart(0) + startAt(3) = 3 — NOT 0.
    const all = (store.get().project.timeline.tracks as Track[]).flatMap((t) => t.clips)
    const avatarClip = all.find((c) => c.linkGroupId === 'avatar:lay' && c.sourceType === 'avatar')!
    expect(avatarClip.startTime).toBe(3) // no snap-back to the pre-move position
  })
})

describe('agent remove_clip → store sync: narration removal does NOT resurrect (B3)', () => {
  it('removing an avatar mirror strips aiLayers so sync re-derives nothing', async () => {
    const world: WorldStateMutable = {
      scenes: [
        {
          id: 'sx',
          name: 'X',
          duration: 10,
          aiLayers: [{ id: 'lay', type: 'avatar', label: 'Host', startAt: 0, estimatedDuration: 4 }],
        } as any,
      ],
      timeline: {
        tracks: [
          track({ id: 'v1', clips: [clip({ id: 'cs', trackId: 'v1', sourceType: 'scene', sourceId: 'sx' })] }),
          track({
            id: 'v2',
            position: 1,
            clips: [
              clip({
                id: 'av',
                trackId: 'v2',
                sourceType: 'avatar',
                sourceId: 'lay',
                linkGroupId: 'avatar:lay',
                duration: 4,
              }),
            ],
          }),
        ],
      },
      projectId: 'p',
      currentRunId: 'r',
    } as unknown as WorldStateMutable

    const res = await handler('clip', { op: 'remove', clipId: 'av' }, world)
    expect(res.success).toBe(true)

    const store = makeStore(world.scenes as Scene[], world.timeline as { tracks: Track[] })
    store.syncTimelineFromScenes()

    const all = (store.get().project.timeline.tracks as Track[]).flatMap((t) => t.clips)
    expect(all.find((c) => c.linkGroupId === 'avatar:lay')).toBeUndefined() // not resurrected
  })
})
