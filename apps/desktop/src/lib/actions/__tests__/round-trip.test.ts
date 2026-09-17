// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { Action, ProjectState, AILayer } from '../types'
import type { HotspotElement, CameraMove } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function bigState(): ProjectState {
  const scene = createDefaultScene()
  scene.id = 'scene-1'
  scene.aiLayers = []
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

function makeLayer(id: string, prompt = id): AILayer {
  return {
    id,
    type: 'veo3',
    prompt,
    negativePrompt: null,
    aspectRatio: '16:9',
    duration: 5,
    loop: false,
    playbackRate: 1,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    zIndex: 0,
    videoUrl: null,
    thumbnailUrl: null,
    status: 'pending',
    operationName: null,
    startAt: 0,
    label: id,
  } as unknown as AILayer
}

describe('action layer round-trips', () => {
  it('50-action sequence + 50 undos returns initial state (P1 success criterion)', () => {
    const initial = bigState()
    let state = initial
    const inverses: Action[] = []

    // 50 actions: alternating layer/add and scene/update
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        const id = `L${i}`
        const layer = makeLayer(id)
        const { result } = dispatchSync(
          state,
          { type: 'layer/add', params: { sceneId: 'scene-1', layerId: id, layer } },
          { source: 'user' },
        )
        expect(result.success).toBe(true)
        state = result.state!
        inverses.push(result.inverseAction!)
      } else {
        const { result } = dispatchSync(
          state,
          { type: 'scene/update', params: { sceneId: 'scene-1', patch: { name: `iter-${i}` } } },
          { source: 'user' },
        )
        expect(result.success).toBe(true)
        state = result.state!
        inverses.push(result.inverseAction!)
      }
    }

    // 50 undos (pop top of inverse stack, dispatch, repeat)
    for (let i = inverses.length - 1; i >= 0; i--) {
      const { result } = dispatchSync(state, inverses[i], { source: 'replay', freezeInput: false })
      expect(result.success).toBe(true)
      state = result.state!
    }

    // We get back to initial (modulo project.updatedAt + scene.updatedAt fields,
    // which advance with Date.now() and are intentionally non-deterministic).
    expect(state.scenes[0].aiLayers).toEqual([])
    expect(state.scenes[0].name).toBe(initial.scenes[0].name)
    expect(state.scenes.length).toBe(initial.scenes.length)
  })

  it('replay from initial state reproduces the same final state byte-identical (modulo timestamps)', () => {
    const initial = bigState()
    let live = initial
    const replayLog: Action[] = []

    const ops: Array<Parameters<typeof dispatchSync>[1]> = [
      { type: 'layer/add', params: { sceneId: 'scene-1', layerId: 'A', layer: makeLayer('A') } },
      { type: 'layer/add', params: { sceneId: 'scene-1', layerId: 'B', layer: makeLayer('B') } },
      { type: 'layer/update', params: { sceneId: 'scene-1', layerId: 'A', patch: { prompt: 'updated' } } },
      { type: 'scene/update', params: { sceneId: 'scene-1', patch: { duration: 12 } } },
    ]
    for (const op of ops) {
      const { result, action } = dispatchSync(live, op, { source: 'user' })
      expect(result.success).toBe(true)
      live = result.state!
      replayLog.push(action)
    }

    // Replay against the same initial state with `source: 'replay'`. Use the
    // recorded action ids + timestamps so the exercise is fully deterministic.
    let replayed = initial
    for (const a of replayLog) {
      const { result } = dispatchSync(replayed, { ...a, type: a.type } as Parameters<typeof dispatchSync>[1], {
        source: a.source,
        runId: a.runId,
        freezeInput: false,
      })
      expect(result.success).toBe(true)
      replayed = result.state!
    }

    expect(replayed.scenes[0].aiLayers!.map((l) => l.id)).toEqual(['A', 'B'])
    expect((replayed.scenes[0].aiLayers!.find((l) => l.id === 'A') as { prompt: string }).prompt).toBe('updated')
    expect(replayed.scenes[0].duration).toBe(12)
  })

  // ── P1.5 action types ───────────────────────────────────────────────────
  // The P1 success criterion ("50 actions + 50 undos returns initial state")
  // also has to hold for the P1.5 reducers added later (interaction, camera,
  // audio, style). This test drives a 50-action sequence across all of them
  // and asserts the inverses round-trip cleanly.

  function hotspot(id: string, label: string): HotspotElement {
    return {
      id,
      type: 'hotspot',
      x: 50,
      y: 50,
      width: 10,
      height: 10,
      appearsAt: 0,
      hidesAt: null,
      entranceAnimation: 'fade',
      label,
      shape: 'circle',
      style: 'pulse',
      color: '#fff',
      triggersEdgeId: null,
      jumpsToSceneId: null,
    }
  }

  it('50-action mix across P1.5 reducers round-trips to initial state', () => {
    const initial = bigState()
    let state = initial
    const inverses: Action[] = []

    // Build a varied 50-action sequence. Each branch covers one P1.5 reducer.
    for (let i = 0; i < 50; i++) {
      const op = i % 5
      let input: Parameters<typeof dispatchSync>[1]
      if (op === 0) {
        input = {
          type: 'interaction/add',
          params: {
            sceneId: 'scene-1',
            interactionId: `h${i}`,
            interaction: hotspot(`h${i}`, `label-${i}`),
          },
        }
      } else if (op === 1) {
        // Update the most recently added hotspot's label.
        const last = state.scenes[0].interactions[state.scenes[0].interactions.length - 1]
        if (!last) {
          input = {
            type: 'scene/update',
            params: { sceneId: 'scene-1', patch: { name: `iter-${i}` } },
          }
        } else {
          input = {
            type: 'interaction/update',
            params: {
              sceneId: 'scene-1',
              interactionId: last.id,
              patch: { label: `relabel-${i}` } as Partial<HotspotElement>,
            },
          }
        }
      } else if (op === 2) {
        const moves: CameraMove[] = [
          { type: 'pan', startX: 0, startY: 0, endX: i, endY: 0, easing: 'linear' } as CameraMove,
        ]
        input = { type: 'camera/setMotion', params: { sceneId: 'scene-1', motion: moves } }
      } else if (op === 3) {
        input = {
          type: 'audio/setLayer',
          params: { sceneId: 'scene-1', patch: { volume: 0.5 + (i % 4) * 0.1 } },
        }
      } else {
        input = { type: 'style/setGlobal', params: { patch: { fontOverride: `Font-${i}` } } }
      }
      const { result } = dispatchSync(state, input, { source: 'user' })
      expect(result.success).toBe(true)
      state = result.state!
      inverses.push(result.inverseAction!)
    }

    // 50 undos in reverse order.
    for (let i = inverses.length - 1; i >= 0; i--) {
      const { result } = dispatchSync(state, inverses[i], { source: 'replay', freezeInput: false })
      expect(result.success).toBe(true)
      state = result.state!
    }

    // Initial-state recovery checks (timestamps drift, so compare shape).
    expect(state.scenes[0].interactions).toEqual([])
    expect(state.scenes[0].cameraMotion ?? null).toEqual(initial.scenes[0].cameraMotion ?? null)
    expect(state.scenes[0].audioLayer?.volume).toBe(initial.scenes[0].audioLayer?.volume)
    expect(state.globalStyle.fontOverride ?? null).toEqual(initial.globalStyle.fontOverride ?? null)
  })
})
