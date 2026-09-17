/**
 * Renderer-side diff capture for chat tool cards.
 *
 * Called from AgentChat's `tool_complete` handler when the inline-diffs
 * setting is on. Only tools whose INPUT carries the new code can be diffed
 * honestly client-side:
 *
 *   - write_scene_code: full-scene diff. `before` resolution order:
 *       1. the per-RUN last-written map (sequential writes to the same scene
 *          within one run must diff against each other, not the pre-run code)
 *       2. the store scene's current code field (store scenes stay pre-run
 *          until persistScenesFromAgentRun lands at run end)
 *   - patch_layer_code: the input IS a before/after pair (oldCode/newCode).
 *
 * Generation tools (add_layer, regenerate_layer, …) send prompts, not code —
 * the new code only exists server-side, so no client diff is possible.
 */

import type { Scene } from '@/lib/types'
import { computeLineDiff, type CodeDiff } from './line-diff'

export interface ToolCodeDiff extends CodeDiff {
  /** Short human label for the diff header (scene name or 'patch'). */
  label: string
}

/** The scene's active code field, mirroring built-in-hooks' codeWrite hash. */
function sceneCodeOf(scene: Scene): string {
  return (
    ((scene as unknown as { reactCode?: string }).reactCode ??
      scene.sceneCode ??
      scene.canvasCode ??
      scene.svgContent) ||
    ''
  )
}

export function computeToolCodeDiff(
  toolName: string,
  input: Record<string, unknown>,
  scenes: Scene[],
  lastWrittenCode: Map<string, string>,
): ToolCodeDiff | null {
  if (toolName === 'write_scene_code') {
    const sceneId = typeof input.sceneId === 'string' ? input.sceneId : null
    const after = typeof input.sceneCode === 'string' ? input.sceneCode : null
    if (after == null) return null
    const key = `scene:${sceneId ?? ''}`
    const scene = sceneId ? scenes.find((s) => s.id === sceneId) : undefined
    const before = lastWrittenCode.get(key) ?? (scene ? sceneCodeOf(scene) : '')
    lastWrittenCode.set(key, after)
    const diff = computeLineDiff(before, after)
    if (!diff) return null
    return { ...diff, label: scene?.name ?? sceneId ?? 'scene' }
  }

  if (toolName === 'patch_layer_code') {
    const oldCode = typeof input.oldCode === 'string' ? input.oldCode : null
    const newCode = typeof input.newCode === 'string' ? input.newCode : null
    if (oldCode == null || newCode == null) return null
    const diff = computeLineDiff(oldCode, newCode)
    if (!diff) return null
    return { ...diff, label: 'patch' }
  }

  return null
}
