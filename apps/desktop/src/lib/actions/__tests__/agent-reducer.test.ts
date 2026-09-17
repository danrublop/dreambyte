// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function baseState(): ProjectState {
  const sceneA = createDefaultScene()
  sceneA.id = 'scene-A'
  sceneA.name = 'A (pre)'
  const project = createDefaultProject([sceneA])
  // Pin updatedAt to a deterministic past timestamp so the
  // "updatedAt bumps" assertion below can never tie against
  // `Date.now()` on fast CI runners (sub-ms race observed in CI
  // run 26347765989). Equivalent behavior to mocking the clock,
  // but doesn't require fake timers across the rest of the file.
  project.updatedAt = new Date('2020-01-01T00:00:00.000Z').toISOString()
  return {
    scenes: [sceneA],
    globalStyle: {
      presetId: null,
      palette: ['#000', '#111', '#222', '#333'],
      duration: 8,
      theme: 'light',
    } as unknown as ProjectState['globalStyle'],
    project,
    selectedSceneId: sceneA.id,
    uiEditingLayerId: null,
  }
}

describe('agent/applyRun reducer', () => {
  it('overwrites scenes + globalStyle and returns an inverse with the pre-state', () => {
    const state = baseState()
    const sceneB = { ...createDefaultScene(), id: 'scene-B', name: 'B (post)' }
    const sceneC = { ...createDefaultScene(), id: 'scene-C', name: 'C (post)' }
    const newGlobalStyle = { ...state.globalStyle, duration: 12, theme: 'dark' as any }

    const { result, action } = dispatchSync(
      state,
      {
        type: 'agent/applyRun',
        params: { scenes: [sceneB, sceneC], globalStyle: newGlobalStyle, agentType: 'master-builder' },
      },
      { source: 'agent' },
    )

    expect(result.success).toBe(true)
    expect(result.state!.scenes.map((s) => s.id)).toEqual(['scene-B', 'scene-C'])
    expect(result.state!.globalStyle.duration).toBe(12)
    expect(result.state!.globalStyle.theme).toBe('dark')

    // Inverse should capture the original scenes + globalStyle so Cmd+Z restores them.
    expect(result.inverseAction?.type).toBe('agent/applyRun')
    const inverseParams = result.inverseAction!.params as {
      scenes: Array<{ id: string; name: string }>
      globalStyle: { duration: number; theme?: string }
      agentType?: string
    }
    expect(inverseParams.scenes.map((s) => s.id)).toEqual(['scene-A'])
    expect(inverseParams.scenes[0].name).toBe('A (pre)')
    expect(inverseParams.globalStyle.duration).toBe(8)
    expect(inverseParams.globalStyle.theme).toBe('light')
    expect(inverseParams.agentType).toBe('master-builder')

    expect(result.inverseAction?.source).toBe('replay')

    // Forward action gets stamped with the dispatcher's source.
    expect(action.source).toBe('agent')

    // project.updatedAt should bump (review-found inconsistency vs scene-reducer convention).
    expect(result.state!.project.updatedAt).not.toBe(state.project.updatedAt)
  })

  it('round-trips: applying the inverse restores the original state', () => {
    const state = baseState()
    const sceneB = { ...createDefaultScene(), id: 'scene-B', name: 'B' }
    const newGlobalStyle = { ...state.globalStyle, duration: 20 }

    const forward = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [sceneB], globalStyle: newGlobalStyle } },
      { source: 'agent' },
    )
    expect(forward.result.success).toBe(true)

    // Take the post-state and apply the inverse — must yield original state.
    const postState = forward.result.state!
    const inverse = forward.result.inverseAction!
    const replay = dispatchSync(postState, inverse, { source: 'replay' })
    expect(replay.result.success).toBe(true)
    expect(replay.result.state!.scenes.map((s) => s.id)).toEqual(['scene-A'])
    expect(replay.result.state!.globalStyle.duration).toBe(8)

    // And the redo (inverse-of-inverse) should bring us back to the post-state.
    const redo = dispatchSync(replay.result.state!, replay.result.inverseAction!, { source: 'replay' })
    expect(redo.result.success).toBe(true)
    expect(redo.result.state!.scenes.map((s) => s.id)).toEqual(['scene-B'])
    expect(redo.result.state!.globalStyle.duration).toBe(20)
  })

  it('rejects when scenes is not an array', () => {
    const state = baseState()
    const { result } = dispatchSync(
      state,
      // intentionally malformed
      {
        type: 'agent/applyRun',
        params: { scenes: 'not-an-array' as unknown as never, globalStyle: state.globalStyle },
      },
      { source: 'agent' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })

  it('rejects when globalStyle is missing', () => {
    const state = baseState()
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [], globalStyle: null as unknown as never } },
      { source: 'agent' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })

  it('keeps selectedSceneId when the selected scene still exists in the new state', () => {
    const state = baseState()
    // Selected is scene-A; new scenes include scene-A.
    const sceneA = { ...createDefaultScene(), id: 'scene-A', name: 'A (updated)' }
    const sceneB = { ...createDefaultScene(), id: 'scene-B' }
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [sceneA, sceneB], globalStyle: state.globalStyle } },
      { source: 'agent' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.selectedSceneId).toBe('scene-A')
  })

  it('reconciles selectedSceneId to first scene when the selected scene was removed (the dangling-ref bug)', () => {
    // Review finding: reducer was preserving selectedSceneId blindly via
    // ...state. On undo of an agent run that swapped which scenes exist,
    // the in-memory selectedSceneId pointed to a now-absent scene → blank
    // preview / crash. This test locks the fix in.
    const state = baseState() // selectedSceneId='scene-A'
    const sceneB = { ...createDefaultScene(), id: 'scene-B' }
    const sceneC = { ...createDefaultScene(), id: 'scene-C' }
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [sceneB, sceneC], globalStyle: state.globalStyle } },
      { source: 'agent' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.selectedSceneId).toBe('scene-B')
  })

  it('reconciles selectedSceneId to null when the new scenes array is empty', () => {
    const state = baseState()
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [], globalStyle: state.globalStyle } },
      { source: 'agent' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.selectedSceneId).toBeNull()
  })

  it('preserves uiEditingLayerId (cursor model state is not part of the run)', () => {
    const state = { ...baseState(), uiEditingLayerId: 'some-layer-id' }
    const sceneB = { ...createDefaultScene(), id: 'scene-B' }
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [sceneB], globalStyle: state.globalStyle } },
      { source: 'agent' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.uiEditingLayerId).toBe('some-layer-id')
  })

  it('applies sceneGraph when provided and captures the pre-state graph in the inverse', () => {
    // Review finding: undo was reverting scenes but leaving sceneGraph at
    // post-agent values (dangling edge refs to removed scenes) because the
    // graph was updated via a separate updateSceneGraph() bypass call.
    // sceneGraph now flows through the action.
    const state = baseState()
    const newGraph = {
      nodes: [{ id: 'scene-B', position: { x: 0, y: 0 } } as any],
      edges: [],
      startSceneId: 'scene-B',
    }
    const sceneB = { ...createDefaultScene(), id: 'scene-B' }
    const { result } = dispatchSync(
      state,
      {
        type: 'agent/applyRun',
        params: { scenes: [sceneB], globalStyle: state.globalStyle, sceneGraph: newGraph },
      },
      { source: 'agent' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.sceneGraph.startSceneId).toBe('scene-B')

    // Inverse captures the original graph (which had scene-A as start).
    const inverseParams = result.inverseAction!.params as { sceneGraph?: { startSceneId: string } }
    expect(inverseParams.sceneGraph?.startSceneId).toBe(state.project.sceneGraph.startSceneId)
  })

  it('preserves current sceneGraph when caller does not pass one (back-compat)', () => {
    const state = baseState()
    const sceneB = { ...createDefaultScene(), id: 'scene-B' }
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [sceneB], globalStyle: state.globalStyle } },
      { source: 'agent' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.project.sceneGraph).toBe(state.project.sceneGraph)
  })

  it('a plain agent-run apply (no timeline) emits NO schedule-project-save effect', () => {
    const state = baseState()
    const sceneB = { ...createDefaultScene(), id: 'scene-B' }
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [sceneB], globalStyle: state.globalStyle } },
      { source: 'agent' },
    )
    expect(result.success).toBe(true)
    expect(result.effects ?? []).not.toContainEqual({ kind: 'schedule-project-save' })
  })

  it('a delete-inverse apply (carries timeline) DOES schedule a save so undo persists', () => {
    // scene/delete + clip/remove use agent/applyRun WITH a timeline param as
    // their undo inverse. That replay must persist, or the restored state lives
    // only in memory and a reload reverts the delete.
    const state = baseState()
    const sceneB = { ...createDefaultScene(), id: 'scene-B' }
    const { result } = dispatchSync(
      state,
      {
        type: 'agent/applyRun',
        params: { scenes: [sceneB], globalStyle: state.globalStyle, timeline: { tracks: [] } },
      },
      { source: 'replay' },
    )
    expect(result.success).toBe(true)
    expect(result.effects).toContainEqual({ kind: 'schedule-project-save' })
  })

  // ── E3: undo an agent run from the run-start snapshot ────────────────────────
  describe('E3 run-start snapshot + regen/save on undo', () => {
    it('builds the inverse from preRunSnapshot, NOT dispatch-time state.scenes', () => {
      // Simulate the real bug: by dispatch time the live store already merged the
      // run's scenes (state.scenes is POST-stream). The pre-run snapshot is the
      // TRUE from-state. Inverse must restore the snapshot, not the post-stream state.
      const state = baseState()
      const postStreamA = { ...createDefaultScene(), id: 'scene-A', name: 'A (post-stream)' }
      const newScene = { ...createDefaultScene(), id: 'scene-X', name: 'X (run output)' }
      // state.scenes already reflects the streamed merge.
      state.scenes = [postStreamA, newScene]

      const preRunScene = { ...createDefaultScene(), id: 'scene-A', name: 'A (TRUE pre-run)' }
      const { result } = dispatchSync(
        state,
        {
          type: 'agent/applyRun',
          params: {
            scenes: [postStreamA, newScene],
            globalStyle: state.globalStyle,
            preRunSnapshot: {
              scenes: [preRunScene],
              globalStyle: { ...state.globalStyle, duration: 8 } as any,
            },
          },
        },
        { source: 'agent' },
      )
      expect(result.success).toBe(true)
      const inv = result.inverseAction!.params as { scenes: Array<{ id: string; name: string }> }
      // The inverse restores ONLY the pre-run scene — first Cmd+Z lands on pre-run state.
      expect(inv.scenes.map((s) => s.id)).toEqual(['scene-A'])
      expect(inv.scenes[0].name).toBe('A (TRUE pre-run)')
    })

    it('tags the undo inverse with regenerateOnApply; applying it schedules a save AND regenerates HTML', () => {
      const state = baseState()
      const sceneB = { ...createDefaultScene(), id: 'scene-B', name: 'B' }
      const forward = dispatchSync(
        state,
        {
          type: 'agent/applyRun',
          params: {
            scenes: [sceneB],
            globalStyle: state.globalStyle,
            preRunSnapshot: { scenes: state.scenes, globalStyle: state.globalStyle },
          },
        },
        { source: 'agent' },
      )
      expect(forward.result.success).toBe(true)
      const inverse = forward.result.inverseAction!
      expect((inverse.params as { regenerateOnApply?: boolean }).regenerateOnApply).toBe(true)

      // Applying the inverse (the Cmd+Z replay) must persist (reload-shaped) AND
      // regenerate every restored scene's stale HTML.
      const undo = dispatchSync(forward.result.state!, inverse, { source: 'replay' })
      expect(undo.result.success).toBe(true)
      expect(undo.result.effects).toContainEqual({ kind: 'schedule-project-save' })
      expect(undo.result.effects).toContainEqual({ kind: 'regenerate-scene-html', sceneId: 'scene-A' })
      // Restored to pre-run scenes.
      expect(undo.result.state!.scenes.map((s) => s.id)).toEqual(['scene-A'])
    })

    it('redo (inverse-of-inverse) re-applies the run AND regens+saves (v6 review P1: undo wrote pre-run HTML to disk)', () => {
      const state = baseState()
      const sceneB = { ...createDefaultScene(), id: 'scene-B', name: 'B' }
      const forward = dispatchSync(
        state,
        {
          type: 'agent/applyRun',
          params: {
            scenes: [sceneB],
            globalStyle: state.globalStyle,
            preRunSnapshot: { scenes: state.scenes, globalStyle: state.globalStyle },
          },
        },
        { source: 'agent' },
      )
      const undo = dispatchSync(forward.result.state!, forward.result.inverseAction!, { source: 'replay' })
      const redoAction = undo.result.inverseAction!
      // The redo action MUST request regen — the undo just overwrote on-disk HTML
      // with pre-run scenes, so redo has to rewrite it to the run's scenes or a
      // reload resurrects pre-run (the bug this fix kills).
      expect((redoAction.params as { regenerateOnApply?: boolean }).regenerateOnApply).toBe(true)
      const redo = dispatchSync(undo.result.state!, redoAction, { source: 'replay' })
      expect(redo.result.success).toBe(true)
      // Run re-applied.
      expect(redo.result.state!.scenes.map((s) => s.id)).toEqual(['scene-B'])
      // Redo persists (schedule-project-save) and regenerates the restored scene's
      // HTML so disk + memory + the next reload all agree on the run's scenes.
      expect(redo.result.effects ?? []).toContainEqual({ kind: 'schedule-project-save' })
      expect(redo.result.effects ?? []).toContainEqual({ kind: 'regenerate-scene-html', sceneId: 'scene-B' })
      // …and the chain keeps propagating: a second undo is still tagged.
      expect((redo.result.inverseAction!.params as { regenerateOnApply?: boolean }).regenerateOnApply).toBe(true)
    })

    it('falls back to live state.scenes for the inverse when no preRunSnapshot is threaded (back-compat)', () => {
      const state = baseState()
      const sceneB = { ...createDefaultScene(), id: 'scene-B' }
      const { result } = dispatchSync(
        state,
        { type: 'agent/applyRun', params: { scenes: [sceneB], globalStyle: state.globalStyle } },
        { source: 'agent' },
      )
      const inv = result.inverseAction!.params as { scenes: Array<{ id: string }> }
      expect(inv.scenes.map((s) => s.id)).toEqual(['scene-A'])
    })
  })

  it('runId stamped from dispatcher carries to the inverse for grouped undo', () => {
    const state = baseState()
    const sceneB = { ...createDefaultScene(), id: 'scene-B' }
    const { result, action } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [sceneB], globalStyle: state.globalStyle } },
      { source: 'agent', runId: 'run-xyz-123' },
    )
    expect(action.runId).toBe('run-xyz-123')
    expect(result.inverseAction?.runId).toBe('run-xyz-123')
  })
})

describe('agent/applyRun — scene-lock enforcement (cursor model)', () => {
  const userLock = () => ({
    owner: 'user' as const,
    source: 'in-app' as const,
    acquiredAt: Date.now(),
    lastActivityAt: Date.now(),
  })
  const agentLock = () => ({
    owner: 'agent' as const,
    source: 'in-app' as const,
    acquiredAt: Date.now(),
    lastActivityAt: Date.now(),
  })

  it("preserves a USER-held scene against an agent run's overwrite", () => {
    const state = baseState()
    state.scenes[0].lock = userLock() // user holds scene-A
    const agentVersionOfA = { ...state.scenes[0], name: 'A (agent tried to change)', lock: undefined }
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [agentVersionOfA], globalStyle: state.globalStyle } },
      { source: 'agent' },
    )
    expect(result.success).toBe(true)
    // The USER's version (name + lock) survives; the agent's overwrite is dropped.
    expect(result.state!.scenes.find((s) => s.id === 'scene-A')?.name).toBe('A (pre)')
    expect(result.state!.scenes.find((s) => s.id === 'scene-A')?.lock?.owner).toBe('user')
  })

  it('DOES overwrite a scene the agent itself holds (or that is unlocked)', () => {
    const state = baseState()
    state.scenes[0].lock = agentLock() // agent holds it → no conflict
    const agentVersionOfA = { ...state.scenes[0], name: 'A (agent changed)' }
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [agentVersionOfA], globalStyle: state.globalStyle } },
      { source: 'agent' },
    )
    expect(result.state!.scenes.find((s) => s.id === 'scene-A')?.name).toBe('A (agent changed)')
  })

  it('applies verbatim for replay/undo (source !== agent), ignoring the lock', () => {
    const state = baseState()
    state.scenes[0].lock = userLock()
    const restored = { ...state.scenes[0], name: 'A (restored by undo)', lock: undefined }
    const { result } = dispatchSync(
      state,
      { type: 'agent/applyRun', params: { scenes: [restored], globalStyle: state.globalStyle } },
      { source: 'replay' },
    )
    expect(result.state!.scenes.find((s) => s.id === 'scene-A')?.name).toBe('A (restored by undo)')
  })
})
