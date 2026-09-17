'use client'

import { v4 as uuidv4 } from 'uuid'
import type { Scene, TextOverlay, SvgObject, SvgBranch, SceneNode, InteractionElement } from '../types'
import type { Set, Get } from './types'
import { createDefaultScene } from './helpers'
import {
  tryAcquire,
  tryTouch,
  tryForceTakeover,
  SCENE_LOCK_IDLE_MS,
  type LockOwner,
  type LockSource,
  type AcquireOutcome,
  type TouchOutcome,
  type TakeoverOutcome,
} from './scene-lock'

// Idle timers live module-level (not in Zustand state) so they survive
// structural sharing and can be cancelled deterministically. Map from
// sceneId → handle. The store actions below own all writes here.
const sceneIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearIdleTimer(sceneId: string): void {
  const t = sceneIdleTimers.get(sceneId)
  if (t) {
    clearTimeout(t)
    sceneIdleTimers.delete(sceneId)
  }
}

function armIdleTimer(sceneId: string, fire: () => void): void {
  clearIdleTimer(sceneId)
  // Skip timer setup in non-browser test environments — `setTimeout` is
  // present in node, but tests that exercise the lock state machine want
  // pure synchronous logic. Real callers always run in renderer.
  if (typeof window === 'undefined') return
  const handle = setTimeout(() => {
    sceneIdleTimers.delete(sceneId)
    fire()
  }, SCENE_LOCK_IDLE_MS)
  sceneIdleTimers.set(sceneId, handle)
}

export function createSceneActions(set: Set, get: Get) {
  return {
    addScene: (prompt = '') => {
      const { globalStyle } = get()
      const scene = createDefaultScene(prompt)
      scene.duration = globalStyle.duration ?? 8
      // Position the new scene's node in the graph so dispatchAction's
      // reducer keeps the projection consistent. Scene-graph nodes are a
      // separate concern from the action params shape, so we hand-stitch
      // the project patch via project/update right after.
      const result = get().dispatchAction(
        { type: 'scene/create', params: { sceneId: scene.id, scene } },
        { source: 'user' },
      )
      if (!result.success) return scene.id
      // Sync scene graph node + select the new scene.
      const { project, scenes } = get()
      const existingNodeIds = new Set(project.sceneGraph.nodes.map((n) => n.id))
      if (!existingNodeIds.has(scene.id)) {
        const node: SceneNode = { id: scene.id, position: { x: scenes.length * 220, y: 100 } }
        get().dispatchAction(
          {
            type: 'project/update',
            params: { patch: { sceneGraph: { ...project.sceneGraph, nodes: [...project.sceneGraph.nodes, node] } } },
          },
          { source: 'user' },
        )
      }
      set({ selectedSceneId: scene.id })
      return scene.id
    },

    updateScene: (id: string, updates: Partial<Scene>) => {
      // Strangler-fig: keep the legacy snapshot push so the snapshot-based
      // undo() button keeps working alongside actionUndo until every
      // mutation in the codebase has migrated.
      get()._pushUndoDebounced()
      get().dispatchAction({ type: 'scene/update', params: { sceneId: id, patch: updates } }, { source: 'user' })
    },

    acquireSceneLock: (sceneId: string, owner: LockOwner, source: LockSource = 'unknown'): AcquireOutcome => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) {
        return { ok: false, reason: 'held-by-other', existing: { owner, acquiredAt: 0, lastActivityAt: 0, source } }
      }
      const outcome = tryAcquire(scene, owner, source)
      if (!outcome.ok) return outcome
      set((state) => ({
        scenes: state.scenes.map((s) => (s.id === sceneId ? { ...s, lock: outcome.lock } : s)),
      }))
      armIdleTimer(sceneId, () => get().releaseSceneLock(sceneId))
      return outcome
    },

    touchSceneLock: (sceneId: string, owner: LockOwner): TouchOutcome => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return { ok: false, reason: 'no-lock' }
      const outcome = tryTouch(scene, owner)
      if (!outcome.ok) return outcome
      set((state) => ({
        scenes: state.scenes.map((s) => (s.id === sceneId ? { ...s, lock: outcome.lock } : s)),
      }))
      armIdleTimer(sceneId, () => get().releaseSceneLock(sceneId))
      return outcome
    },

    releaseSceneLock: (sceneId: string) => {
      clearIdleTimer(sceneId)
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.lock) return
      set((state) => ({
        scenes: state.scenes.map((s) => (s.id === sceneId ? { ...s, lock: null } : s)),
      }))
    },

    forceTakeoverSceneLock: (sceneId: string, newOwner: LockOwner, source: LockSource = 'unknown'): TakeoverOutcome => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) {
        return {
          ok: false,
          reason: 'not-stale',
          existing: { owner: newOwner, acquiredAt: 0, lastActivityAt: 0, source },
        }
      }
      const outcome = tryForceTakeover(scene, newOwner, source)
      if (!outcome.ok) return outcome
      set((state) => ({
        scenes: state.scenes.map((s) => (s.id === sceneId ? { ...s, lock: outcome.lock } : s)),
      }))
      armIdleTimer(sceneId, () => get().releaseSceneLock(sceneId))
      return outcome
    },

    deleteScene: (id: string) => {
      get().dispatchAction({ type: 'scene/delete', params: { sceneId: id } }, { source: 'user' })
      // scene/delete cascades the scene's timeline clips, but selectedClipIds
      // lives outside the reducer's ProjectState — prune any now-dangling clip
      // selection so the timeline UI doesn't reference removed clips.
      const sel = get().selectedClipIds
      if (sel.length > 0) {
        const liveClipIds = new Set((get().project.timeline?.tracks ?? []).flatMap((t) => t.clips.map((c) => c.id)))
        const next = sel.filter((cid) => liveClipIds.has(cid))
        if (next.length !== sel.length) set({ selectedClipIds: next })
      }
    },

    duplicateScene: (id: string) => {
      get()._pushUndo()
      const scene = get().scenes.find((s) => s.id === id)
      if (!scene) return
      const newScene: Scene = {
        ...scene,
        id: uuidv4(),
        name: scene.name ? `${scene.name} (copy)` : '',
        thumbnail: null,
        interactions: scene.interactions.map((el) => ({ ...el, id: uuidv4() })),
        // Re-id the fields the timeline keys clips by, and give the copy its own
        // audioLayer object (not an alias of the original's). Without this the
        // copy shares sfx ids + avatar aiLayer ids with the original, and the
        // scene-delete cascade — which matches clips by sfx id / `avatar:<layerId>`
        // — would remove the SURVIVOR's clips when one copy is cut.
        audioLayer: scene.audioLayer
          ? { ...scene.audioLayer, sfx: (scene.audioLayer.sfx ?? []).map((s) => ({ ...s, id: uuidv4() })) }
          : scene.audioLayer,
        aiLayers: (scene.aiLayers ?? []).map((l) => ({ ...l, id: uuidv4() })),
      }
      set((state) => {
        const idx = state.scenes.findIndex((s) => s.id === id)
        const scenes = [...state.scenes]
        scenes.splice(idx + 1, 0, newScene)
        const newNodes: SceneNode[] = [
          ...state.project.sceneGraph.nodes,
          { id: newScene.id, position: { x: (idx + 2) * 220, y: 100 } },
        ]
        return {
          scenes,
          selectedSceneId: newScene.id,
          project: {
            ...state.project,
            sceneGraph: { ...state.project.sceneGraph, nodes: newNodes },
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().saveSceneHTML(newScene.id)
      get().scheduleSaveProjectToDb()
    },

    reorderScenes: (fromIndex: number, toIndex: number) => {
      get().dispatchAction({ type: 'scene/reorder', params: { fromIndex, toIndex } }, { source: 'user' })
    },

    moveScene: (id: string, direction: 'up' | 'down') => {
      const scenes = get().scenes
      const fromIndex = scenes.findIndex((s) => s.id === id)
      if (fromIndex === -1) return
      const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1
      if (toIndex < 0 || toIndex >= scenes.length) return
      get().dispatchAction({ type: 'scene/reorder', params: { fromIndex, toIndex } }, { source: 'user' })
    },

    selectScene: (id: string) => {
      get().clearInspector()
      set({
        selectedSceneId: id,
        textEditorSlotKey: null,
        layersTabSectionPending: null,
        layersTabAvatarLayerIdPending: null,
        layerStackPropertiesKey: null,
      })
    },

    addTextOverlay: (sceneId: string) => {
      const overlay: TextOverlay = {
        id: uuidv4(),
        content: 'Text overlay',
        font: 'Caveat',
        size: 48,
        color: '#ffffff',
        x: 50,
        y: 50,
        animation: 'fade-in',
        duration: 1,
        delay: 0,
      }
      get().updateScene(sceneId, {
        textOverlays: [...(get().scenes.find((s) => s.id === sceneId)?.textOverlays ?? []), overlay],
      })
      // Return the new overlay id so callers (e.g. the timeline Add-text tool)
      // can immediately open its property form in the layer stack.
      return overlay.id
    },

    updateTextOverlay: (sceneId: string, overlayId: string, updates: Partial<TextOverlay>) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        textOverlays: scene.textOverlays.map((o) => (o.id === overlayId ? { ...o, ...updates } : o)),
      })
    },

    removeTextOverlay: (sceneId: string, overlayId: string) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        textOverlays: scene.textOverlays.filter((o) => o.id !== overlayId),
      })
    },

    updateSvgObject: (sceneId: string, objectId: string, updates: Partial<SvgObject>) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        svgObjects: scene.svgObjects.map((o) => (o.id === objectId ? { ...o, ...updates } : o)),
      })
    },

    switchBranch: (sceneId: string, branchId: string) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const branch = scene.svgBranches.find((b) => b.id === branchId)
      if (!branch) return
      get().updateScene(sceneId, {
        svgContent: branch.svgContent,
        usage: branch.usage,
        activeBranchId: branchId,
      })
      if (scene.primaryObjectId) {
        get().updateSvgObject(sceneId, scene.primaryObjectId, { svgContent: branch.svgContent })
      }
      get().saveSceneHTML(sceneId)
    },

    // ── Variable actions ──

    addSceneVariable: (sceneId: string, variable: import('@/lib/types').SceneVariable) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      // Don't add duplicates
      if ((scene.variables ?? []).some((v) => v.name === variable.name)) return
      get().updateScene(sceneId, {
        variables: [...(scene.variables ?? []), variable],
      })
    },

    removeSceneVariable: (sceneId: string, variableName: string) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        variables: (scene.variables ?? []).filter((v) => v.name !== variableName),
      })
    },

    runtimeVariables: {},

    setRuntimeVariable: (sceneId: string, name: string, value: unknown) => {
      set((state) => ({
        runtimeVariables: {
          ...state.runtimeVariables,
          [sceneId]: { ...(state.runtimeVariables[sceneId] ?? {}), [name]: value },
        },
      }))
    },

    getRuntimeVariables: (sceneId: string) => {
      return get().runtimeVariables[sceneId] ?? {}
    },

    // ── Interaction actions ──

    addInteraction: (sceneId: string, element: InteractionElement) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        interactions: [...(scene.interactions ?? []), element],
      })
    },

    updateInteraction: (sceneId: string, elementId: string, updates: Partial<InteractionElement>) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        interactions: (scene.interactions ?? []).map((el) =>
          el.id === elementId ? ({ ...el, ...updates } as InteractionElement) : el,
        ),
      })
    },

    replaceInteraction: (sceneId: string, elementId: string, next: InteractionElement) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        interactions: (scene.interactions ?? []).map((el) => (el.id === elementId ? next : el)),
      })
    },

    removeInteraction: (sceneId: string, elementId: string) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        interactions: (scene.interactions ?? []).filter((el) => el.id !== elementId),
      })
    },

    captureSceneThumbnail: (sceneId: string, dataUrl: string) => {
      get().updateScene(sceneId, { thumbnail: dataUrl })
    },

    captureSceneFilmstrip: (sceneId: string, frames: string[]) => {
      // First sampled frame doubles as the still thumbnail used elsewhere.
      get().updateScene(sceneId, { filmstrip: frames, thumbnail: frames[0] ?? null })
    },

    // Fill ONE slot of a scene's filmstrip (sparse array sized to `total`).
    // Slots fill in as the scene plays/seeks; the first captured frame doubles
    // as the still thumbnail used elsewhere.
    //
    // Written DIRECTLY (not via updateScene/dispatchAction) on purpose: filmstrip
    // frames are a derived UI cache captured passively during playback. Routing
    // them through the action layer would push base64-JPEG inverses onto the undo
    // stack (Cmd+Z would undo a thumbnail) and churn the action log / durable DB
    // on every captured frame. In-memory only is correct — re-captured on replay.
    setSceneFilmstripFrame: (sceneId: string, slot: number, dataUri: string, total: number) => {
      set((state) => ({
        scenes: state.scenes.map((s) => {
          if (s.id !== sceneId) return s
          const base =
            s.filmstrip && s.filmstrip.length === total ? [...s.filmstrip] : new Array<string | null>(total).fill(null)
          base[slot] = dataUri
          return { ...s, filmstrip: base, thumbnail: s.thumbnail ?? dataUri }
        }),
      }))
    },
  }
}
