import { v4 as uuidv4 } from 'uuid'
import { normalizeTransition } from '@/lib/transitions'
import type { Scene } from '@/lib/types'
import { createSceneShell } from '@/lib/agents/scene-shell'
import { clampSceneDuration, plannedDurationFor } from '@/lib/agents/scene-duration'
import type { AgentLogger } from '@/lib/agents/logger'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { ok, err, findScene, updateScene, type ToolResult } from './_shared'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'

/**
 * `emitterDeps(world)` builds the agent's action-emitter dependency. The
 * runner stamps `currentRunId` on the world before tool dispatch
 * so every action emitted within one agent run shares a
 * group id, which powers "undo last agent run".
 */

export const SCENE_TOOL_NAMES = [
  'create_scene',
  'delete_scene',
  'duplicate_scene',
  'reorder_scenes',
  'scene_props',
] as const

export function createSceneToolHandler(deps: {
  regenerateHTML: (world: WorldStateMutable, sceneId: string, logger?: AgentLogger) => Promise<{ htmlWritten: boolean }>
}) {
  return async function handleSceneTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: AgentLogger,
  ): Promise<ToolResult> {
    // scene_props(op) → the internal op names the switch below already dispatches on.
    // op:'transition_all' never arrives here — the executor routes it to the STYLE handler,
    // which owns the plan-fidelity guard. Per-op required args are checked here because the
    // merged schema can only require `op`; an unknown op must error, not no-op.
    let op = toolName
    if (toolName === 'scene_props') {
      const a = args as { op?: string; sceneId?: unknown; duration?: unknown; bgColor?: unknown; transition?: unknown }
      if (typeof a.sceneId !== 'string' || !a.sceneId) return err('scene_props requires sceneId')
      if (a.op === 'duration') {
        if (typeof a.duration !== 'number') return err('scene_props(op:"duration") requires duration')
        op = 'set_scene_duration'
      } else if (a.op === 'background') {
        if (typeof a.bgColor !== 'string' || !a.bgColor) return err('scene_props(op:"background") requires bgColor')
        op = 'set_scene_background'
      } else if (a.op === 'transition') {
        if (typeof a.transition !== 'string' || !a.transition)
          return err('scene_props(op:"transition") requires transition')
        op = 'set_transition'
      } else {
        return err(
          `scene_props: unknown op "${String(a.op)}" — expected "duration", "background", "transition" or "transition_all"`,
        )
      }
    }
    switch (op) {
      case 'create_scene': {
        const { name, prompt, duration, bgColor, position } = args as {
          name: string
          prompt: string
          duration: number
          bgColor?: string
          position?: number
        }
        const newScene: Scene = createSceneShell({ name, prompt, duration, bgColor })

        const insertedIndex =
          typeof position === 'number' && position >= 0 && position <= world.scenes.length
            ? position
            : world.scenes.length
        world.scenes.splice(insertedIndex, 0, newScene)

        emitAgentAction(
          {
            type: 'scene/create',
            params: { sceneId: newScene.id, position: insertedIndex, scene: newScene },
          },
          emitterDeps(world),
        )

        // NOTE: intentionally do NOT write HTML here. A codeless scene renders as
        // "Building…" via the ChatScenePreview content-guard (no 404), and the
        // iframe mounts FRESH with the real HTML the moment write_scene_code lands
        // — no stale placeholder for the preview/capture to get stuck on.

        return {
          success: true,
          affectedSceneId: newScene.id,
          changes: [
            {
              type: 'scene_created',
              sceneId: newScene.id,
              description: `Created scene "${name}" (${newScene.id})`,
            },
          ],
          data: { sceneId: newScene.id },
        }
      }

      case 'delete_scene': {
        const { sceneId } = args as { sceneId: string }
        const idx = world.scenes.findIndex((s) => s.id === sceneId)
        if (idx === -1) return err(`Scene ${sceneId} not found`)
        const sceneName = world.scenes[idx].name
        world.scenes.splice(idx, 1)
        emitAgentAction({ type: 'scene/delete', params: { sceneId } }, emitterDeps(world))
        return {
          success: true,
          affectedSceneId: sceneId,
          changes: [{ type: 'scene_deleted', sceneId, description: `Deleted scene "${sceneName}"` }],
        }
      }

      case 'duplicate_scene': {
        const { sceneId } = args as { sceneId: string }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        const newScene: Scene = {
          ...JSON.parse(JSON.stringify(scene)),
          id: uuidv4(),
          name: scene.name ? `${scene.name} (copy)` : '(copy)',
          thumbnail: null,
          interactions: scene.interactions.map((el) => ({ ...el, id: uuidv4() })),
        }
        const idx = world.scenes.findIndex((s) => s.id === sceneId)
        world.scenes.splice(idx + 1, 0, newScene)
        return {
          success: true,
          affectedSceneId: newScene.id,
          changes: [
            { type: 'scene_created', sceneId: newScene.id, description: `Duplicated scene as "${newScene.name}"` },
          ],
          data: { sceneId: newScene.id },
        }
      }

      case 'reorder_scenes': {
        const { fromIndex, toIndex } = args as { fromIndex: number; toIndex: number }
        if (fromIndex < 0 || fromIndex >= world.scenes.length) return err(`fromIndex ${fromIndex} out of range`)
        if (toIndex < 0 || toIndex >= world.scenes.length) return err(`toIndex ${toIndex} out of range`)
        const [removed] = world.scenes.splice(fromIndex, 1)
        world.scenes.splice(toIndex, 0, removed)
        emitAgentAction({ type: 'scene/reorder', params: { fromIndex, toIndex } }, emitterDeps(world))
        return ok(null, `Moved scene from position ${fromIndex} to ${toIndex}`)
      }

      case 'set_scene_duration': {
        const { sceneId, duration } = args as { sceneId: string; duration: number }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        // Plan-relative cap prevents scenes ballooning toward the 30s ceiling
        // (dead air). But a scene carrying a voiceover must stay as long as its
        // audio — exempt it from the plan cap so this never truncates narration
        // (only the absolute [3,30] floor/ceiling applies then).
        const tts = scene.audioLayer?.tts
        const hasVoiceover = scene.audioLayer?.enabled === true && (tts?.src?.trim().length ?? 0) > 0
        const clamped = clampSceneDuration(duration, hasVoiceover ? undefined : plannedDurationFor(world, sceneId))
        updateScene(world, sceneId, { duration: clamped })
        emitAgentAction({ type: 'scene/update', params: { sceneId, patch: { duration: clamped } } }, emitterDeps(world))
        return ok(sceneId, `Set duration to ${clamped}s`)
      }

      case 'set_scene_background': {
        const { sceneId, bgColor } = args as { sceneId: string; bgColor: string }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        updateScene(world, sceneId, { bgColor })
        emitAgentAction({ type: 'scene/update', params: { sceneId, patch: { bgColor } } }, emitterDeps(world))
        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, `Set background to ${bgColor}`)
      }

      case 'set_transition': {
        const { sceneId, transition: raw } = args as { sceneId: string; transition: string }
        const transition = normalizeTransition(raw)
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        updateScene(world, sceneId, { transition })
        emitAgentAction({ type: 'scene/update', params: { sceneId, patch: { transition } } }, emitterDeps(world))
        return ok(sceneId, `Set transition to "${transition}"`)
      }

      default:
        return err(`Unknown scene tool: ${toolName}`)
    }
  }
}
