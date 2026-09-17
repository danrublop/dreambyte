'use client'

import type { Scene } from '../types'
import { serializeElementsToCode, patchSVGAttribute } from '../scene-html/element-serializer'
import type { Set, Get } from './types'
import { _inspectorUndoPushed, _inspectorSaveTimer, setInspectorUndoPushed, setInspectorSaveTimer } from './helpers'

export function createInspectorActions(set: Set, get: Get) {
  return {
    selectInspectorElement: (element: import('../types/elements').SceneElement | null, layerId: string | null = null) =>
      set({
        inspectorSelectedElement: element,
        inspectorSelectedLayerId: layerId ?? get().inspectorSelectedLayerId,
      }),

    selectInspectorLayer: (layerId: string | null) =>
      set({
        inspectorSelectedLayerId: layerId,
        inspectorSelectedElement: null,
      }),

    setInspectorElements: (elements: Record<string, import('../types/elements').SceneElement>) =>
      set({ inspectorElements: elements }),

    patchInspectorElement: (elementId: string, property: string, value: unknown) => {
      const state = get()
      const element =
        state.inspectorSelectedElement?.id === elementId
          ? state.inspectorSelectedElement
          : state.inspectorElements[elementId]
      if (!element) return

      // Push undo snapshot on first change in this editing session
      if (!_inspectorUndoPushed) {
        setInspectorUndoPushed(true)
        get()._pushUndo()
      }

      // Update the selected element and the elements registry
      let updatedElement = { ...element, [property]: value } as typeof element
      let updatedElements = {
        ...state.inspectorElements,
        [elementId]: { ...state.inspectorElements[elementId], [property]: value } as typeof element,
      }

      // Update scene code immediately — strategy depends on scene type
      const sceneId = state.selectedSceneId
      const scene = sceneId ? state.scenes.find((s) => s.id === sceneId) : null
      let scenes = state.scenes
      if (scene) {
        const sceneType = scene.sceneType || 'svg'
        const updates: Partial<Scene> = {}

        if (sceneType === 'svg') {
          // SVG: patch the specific attribute in the existing SVG string
          // This preserves all other structure (animations, classes, groups, etc.)
          const patched = patchSVGAttribute(scene.svgContent || '', elementId, property, value)
          if (patched !== scene.svgContent) {
            updates.svgContent = patched
          }
        } else if (sceneType === 'canvas2d') {
          // Canvas2D: full regeneration works because draw() reads from __elements
          const newCode = serializeElementsToCode(Object.values(updatedElements), sceneType)
          if (newCode) {
            updates.canvasCode = newCode
          }
        }

        // React scenes: persist overrides (non-destructive — doesn't modify reactCode)
        if (sceneType === 'react' && element.type.startsWith('dom-')) {
          const prev = scene.elementOverrides ?? {}
          const prevEl = prev[elementId] ?? {}
          updates.elementOverrides = {
            ...prev,
            [elementId]: { ...prevEl, [property]: value as string | number },
          }
        }

        if (Object.keys(updates).length > 0) {
          scenes = state.scenes.map((s) => (s.id === sceneId ? { ...s, ...updates } : s))
        }
      }

      set({
        inspectorSelectedElement: updatedElement,
        inspectorElements: updatedElements,
        scenes,
      })
      get().scheduleSaveProjectToDb()

      // Debounced quiet save (write to disk without iframe reload)
      if (_inspectorSaveTimer) clearTimeout(_inspectorSaveTimer)
      setInspectorSaveTimer(
        setTimeout(() => {
          if (sceneId) {
            get().saveSceneHTML(sceneId, true)
          }
          // Reset undo flag after save so next edit session gets a new snapshot
          setInspectorUndoPushed(false)
        }, 600),
      )
    },

    clearInspector: () =>
      set({
        inspectorSelectedElement: null,
        inspectorSelectedLayerId: null,
        inspectorPendingChanges: {},
      }),

    applyInspectorChanges: async (sceneId: string) => {
      const state = get()
      const pendingChanges = state.inspectorPendingChanges
      if (Object.keys(pendingChanges).length === 0) return

      const scene = state.scenes.find((s) => s.id === sceneId)
      if (!scene) return

      // Apply pending changes to the elements registry
      const elements = { ...state.inspectorElements }
      for (const [elementId, changes] of Object.entries(pendingChanges)) {
        if (elements[elementId]) {
          elements[elementId] = { ...elements[elementId], ...changes } as (typeof elements)[typeof elementId]
        }
      }

      // Serialize elements back to scene code
      const sceneType = scene.sceneType || 'svg'
      const newCode = serializeElementsToCode(Object.values(elements), sceneType)

      if (newCode) {
        // Update the scene's code field based on type
        const updates: Partial<Scene> = {}
        if (sceneType === 'canvas2d') {
          updates.canvasCode = newCode
        } else if (sceneType === 'svg') {
          updates.svgContent = newCode
        }

        if (Object.keys(updates).length > 0) {
          const scenes = state.scenes.map((s) => (s.id === sceneId ? { ...s, ...updates } : s))
          set({ scenes, inspectorPendingChanges: {}, inspectorElements: elements })
          await get().saveSceneHTML(sceneId)
        }
      }
    },
  }
}
