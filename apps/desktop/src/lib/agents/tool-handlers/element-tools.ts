import { v4 as uuidv4 } from 'uuid'
import type { TextOverlay } from '@/lib/types'
import type { AgentLogger } from '@/lib/agents/logger'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { ok, err, findScene, updateScene, type ToolResult } from './_shared'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'

/**
 * P1b-fanout-remaining (elements / text overlays): emit `scene/update`
 * with the `textOverlays` array patch + prior.
 */
function emitTextOverlaysUpdate(world: WorldStateMutable, sceneId: string, next: TextOverlay[], prior: TextOverlay[]) {
  emitAgentAction(
    {
      type: 'scene/update',
      params: { sceneId, patch: { textOverlays: next }, prior: { textOverlays: prior } },
    },
    emitterDeps(world),
  )
}

// `element(op)` absorbed add/edit/delete, and `edit` had already absorbed
// move/resize/reorder/adjust_timing (same textOverlay fields, same spread).
// Those four kept handler branches for two releases with no schema and no
// internal caller — dead on both ends — and are gone.
export const ELEMENT_TOOL_NAMES = ['element'] as const

const VALID_ANIMATIONS: TextOverlay['animation'][] = ['fade-in', 'slide-up', 'typewriter']

export function createElementToolHandler(deps: {
  regenerateHTML: (world: WorldStateMutable, sceneId: string, logger?: AgentLogger) => Promise<{ htmlWritten: boolean }>
}) {
  return async function handleElementTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: AgentLogger,
  ): Promise<ToolResult> {
    // element(op) → the internal op names the switch below already dispatches on, the
    // same remap media_library / character use. Per-op required args are checked here
    // because the merged schema can only require what EVERY op needs (op + sceneId);
    // an unknown op must error honestly rather than fall through to a no-op.
    let op = toolName
    if (toolName === 'element') {
      const a = args as { op?: string; content?: unknown; x?: unknown; y?: unknown; elementId?: unknown }
      if (a.op === 'add') {
        if (typeof a.content !== 'string' || typeof a.x !== 'number' || typeof a.y !== 'number')
          return err('element(op:"add") requires content, x and y')
        op = 'add_element'
      } else if (a.op === 'edit' || a.op === 'delete') {
        if (typeof a.elementId !== 'string' || !a.elementId) return err(`element(op:"${a.op}") requires elementId`)
        op = a.op === 'edit' ? 'edit_element' : 'delete_element'
      } else {
        return err(`element: unknown op "${String(a.op)}" — expected "add", "edit" or "delete"`)
      }
    }
    switch (op) {
      case 'add_element': {
        const { sceneId, content, font, size, color, x, y, animation, duration, delay } = args as {
          sceneId: string
          content: string
          font?: string
          size?: number
          color?: string
          x: number
          y: number
          animation?: string
          duration?: number
          delay?: number
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        const validatedAnimation: TextOverlay['animation'] =
          animation && VALID_ANIMATIONS.includes(animation as TextOverlay['animation'])
            ? (animation as TextOverlay['animation'])
            : 'fade-in'

        const overlay: TextOverlay = {
          id: uuidv4(),
          content,
          font: font || 'Caveat',
          size: size || 48,
          color: color || '#ffffff',
          x,
          y,
          animation: validatedAnimation,
          duration: duration || 0.6,
          delay: delay || 0,
        }

        const priorOverlays = scene.textOverlays
        const nextOverlays = [...scene.textOverlays, overlay]
        updateScene(world, sceneId, { textOverlays: nextOverlays })
        emitTextOverlaysUpdate(world, sceneId, nextOverlays, priorOverlays)

        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, `Added text overlay "${content}"`, { elementId: overlay.id })
      }

      case 'edit_element': {
        // `op` is the merged tool's discriminator, not an overlay field — strip it or the
        // spread below writes it onto the TextOverlay.
        const {
          sceneId,
          elementId,
          op: _op,
          ...updates
        } = args as {
          sceneId: string
          elementId: string
          op?: string
          [key: string]: unknown
        }
        void _op
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        const element = scene.textOverlays.find((o) => o.id === elementId)
        if (!element) return err(`Element ${elementId} not found in scene ${sceneId}`)

        if (updates.animation && !VALID_ANIMATIONS.includes(updates.animation as TextOverlay['animation'])) {
          updates.animation = 'fade-in'
        }

        // Drop explicitly-undefined keys so they can't blank a field via the spread
        // below. Matters now that edit_element absorbed move/resize/reorder/timing:
        // adjust_element_timing used to guard each field individually, and a caller
        // passing `{ delay: undefined }` must leave the existing delay alone.
        for (const k of Object.keys(updates)) {
          if (updates[k] === undefined) delete updates[k]
        }

        const priorEditOverlays = scene.textOverlays
        const nextEditOverlays = scene.textOverlays.map((o) => (o.id === elementId ? { ...o, ...updates } : o))
        updateScene(world, sceneId, { textOverlays: nextEditOverlays })
        emitTextOverlaysUpdate(world, sceneId, nextEditOverlays, priorEditOverlays)

        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, `Updated text overlay ${elementId}`)
      }

      case 'delete_element': {
        const { sceneId, elementId } = args as { sceneId: string; elementId: string }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        const element = scene.textOverlays.find((o) => o.id === elementId)
        if (!element) return err(`Element ${elementId} not found in scene ${sceneId}`)

        const priorDeleteOverlays = scene.textOverlays
        const nextDeleteOverlays = scene.textOverlays.filter((o) => o.id !== elementId)
        updateScene(world, sceneId, { textOverlays: nextDeleteOverlays })
        emitTextOverlaysUpdate(world, sceneId, nextDeleteOverlays, priorDeleteOverlays)

        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, `Deleted text overlay ${elementId}`)
      }

      default:
        return err(`Unknown element tool: ${toolName}`)
    }
  }
}
