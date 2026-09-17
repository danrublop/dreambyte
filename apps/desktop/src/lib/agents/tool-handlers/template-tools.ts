import type { WorldStateMutable } from '@/lib/agents/world-state'
import { getBuiltInTemplate, templateHasContent, INSTANTIABLE_TEMPLATE_IDS } from '@/lib/templates/built-in'
import { instantiateTemplate } from '@/lib/templates/instantiate'
import { ok, err, type ToolResult } from './_shared'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'

/**
 * P1b-fanout-remaining (templates): emit `scene/create` when
 * `use_template` instantiates a new scene.
 */

export const TEMPLATE_TOOL_NAMES = ['use_template'] as const

export function createTemplateToolHandler() {
  return async function handleTemplateTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'use_template': {
        const { templateId, scenePrompt, position } = args as {
          templateId: string
          scenePrompt: string
          position?: number
        }

        const template = getBuiltInTemplate(templateId)
        if (!template) {
          return err(`Template not found: ${templateId}. Available: ${INSTANTIABLE_TEMPLATE_IDS.join(', ')}`)
        }
        // Fail honestly instead of inserting a blank scene and reporting
        // success. 20 of the 30 declared built-ins carry no layers and no
        // interactions, so instantiating one yields a scene with no content at
        // all. The schema enum keeps the agent off them; this covers the MCP
        // and replay paths, which don't go through it.
        if (!templateHasContent(template)) {
          return err(
            `Template "${templateId}" is declared but carries no layers or interactions — instantiating it would create a blank scene. ` +
              `Use create_scene + write_scene_code for a visual scene. Templates that actually instantiate: ${INSTANTIABLE_TEMPLATE_IDS.join(', ')}.`,
          )
        }

        const placeholderValues: Record<string, string> = {}
        for (const placeholder of template.placeholders) {
          if (placeholder === 'TITLE') {
            placeholderValues[placeholder] = scenePrompt.slice(0, 60)
          } else if (placeholder === 'SUBTITLE') {
            placeholderValues[placeholder] = ''
          } else {
            placeholderValues[placeholder] = scenePrompt
          }
        }

        const newScene = instantiateTemplate(template, placeholderValues, scenePrompt.slice(0, 40))

        let insertPosition: number
        if (position != null && position >= 0 && position <= world.scenes.length) {
          world.scenes.splice(position, 0, newScene)
          insertPosition = position
        } else {
          insertPosition = world.scenes.length
          world.scenes.push(newScene)
        }
        emitAgentAction(
          {
            type: 'scene/create',
            params: { sceneId: newScene.id, position: insertPosition, scene: newScene },
          },
          emitterDeps(world),
        )

        return ok(newScene.id, `Created scene from template "${template.name}"`, {
          sceneId: newScene.id,
          templateId,
        })
      }

      default:
        return err(`Unknown template tool: ${toolName}`)
    }
  }
}
