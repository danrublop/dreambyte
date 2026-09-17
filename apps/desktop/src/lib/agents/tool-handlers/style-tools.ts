import { normalizeTransition } from '@/lib/transitions'
import { FONT_FAMILIES, isValidFont, getFontPairing } from '@/lib/fonts/catalog'
import { SCENE_STYLE_PRESETS } from '@/lib/styles/scene-presets'
import type { AgentLogger } from '@/lib/agents/logger'
import type { GlobalStyle, SceneStyleOverride } from '@/lib/types'
import type { SceneStylePresetName } from '@/lib/types'
import type { StylePresetId } from '@/lib/styles/presets'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { ok, err, findScene, updateScene, type ToolResult } from './_shared'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'

/**
 * P1b-fanout-style: emit `style/setSceneOverride`, `style/setGlobal`,
 * `camera/setMotion`, and (for the transition_all op) `scene/update`
 * so the action_log captures style-tool mutations. Best-effort — emit
 * errors are logged inside `emitAgentAction` and never block the tool result.
 */

// There is no style_scene tool (set_scene_style is
// the live tool); unknown-name calls fail soft upstream. NOTE: style_scene's
// handler accepted texture/stroke/axis fields set_scene_style's schema does
// not expose — that widening belongs to the stage-3 consolidation, not here.
export const STYLE_TOOL_NAMES = ['set_camera_motion', 'set_style'] as const

/** Internal op, no schema and NOT registered under this name: the model reaches it as
 *  scene_props(op:'transition_all'), which the executor routes here because this branch
 *  owns the plan-fidelity guard below. */
export const SET_ALL_TRANSITIONS_OP = 'set_all_transitions'

export function createStyleToolHandler(deps: {
  // Mirrors the REAL regenerateHTML return shape (tool-executor.ts): a failed
  // write or an errored runtime-verify is surfaced via verifyStatus/verifyError/
  // error, NOT just `htmlWritten`. The scope:'all_scenes' path below reads these
  // so it can tell the agent which scenes the new global style BROKE instead of
  // discarding every result and reporting "all good".
  regenerateHTML: (
    world: WorldStateMutable,
    sceneId: string,
    logger?: AgentLogger,
  ) => Promise<{
    htmlWritten: boolean
    verifyStatus?: 'unknown' | 'pending' | 'verifying' | 'verified' | 'errored'
    verifyError?: import('@/lib/db/schema').SceneVerifyError | null
    error?: string
  }>
}) {
  return async function handleStyleTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: AgentLogger,
  ): Promise<ToolResult> {
    // set_style merges scene/global via a `scope` discriminator; the rich per-op
    // case bodies below are unchanged. The set_global_style body reads `scope`
    // for its APPLICATION scope (project_default/all_scenes/new_scenes_only), so
    // route that through the separate `applyScope` arg to avoid colliding with
    // the scene|global discriminator.
    let op = toolName
    if (toolName === 'set_style') {
      const a = args as { scope?: string; applyScope?: string }
      if (a.scope === 'global') {
        op = 'set_global_style'
        args = { ...args, scope: a.applyScope }
      } else {
        op = 'set_scene_style'
      }
    }
    switch (op) {
      case 'set_camera_motion': {
        const { sceneId, moves } = args as {
          sceneId: string
          moves: Array<{ type: string; params?: Record<string, unknown> }>
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        const prior = scene.cameraMotion ?? null
        updateScene(world, sceneId, { cameraMotion: moves as any })
        emitAgentAction(
          { type: 'camera/setMotion', params: { sceneId, motion: moves as any, prior } },
          emitterDeps(world),
        )
        await deps.regenerateHTML(world, sceneId, logger)
        const moveNames = moves.map((m) => m.type).join(', ')
        return ok(sceneId, `Set camera motion: ${moveNames}`)
      }

      case 'set_global_style': {
        const {
          palette,
          font,
          bodyFont,
          fontPairing,
          strokeWidth,
          theme,
          duration,
          presetId,
          paletteOverride,
          bgColorOverride,
          fontOverride,
          scope,
        } = args as {
          palette?: string[]
          font?: string
          bodyFont?: string
          fontPairing?: string
          strokeWidth?: number
          theme?: 'dark' | 'light'
          duration?: number
          presetId?: string | null
          paletteOverride?: string[] | null
          bgColorOverride?: string | null
          fontOverride?: string | null
          scope?: 'project_default' | 'all_scenes' | 'new_scenes_only'
        }
        const priorGlobal: GlobalStyle = { ...world.globalStyle }
        // Resolve font pairing first — it sets both heading + body font
        if (fontPairing) {
          const pairing = getFontPairing(fontPairing)
          if (pairing) {
            world.globalStyle.fontOverride = pairing.heading
            world.globalStyle.bodyFontOverride = pairing.body
          }
        }
        if (presetId !== undefined)
          world.globalStyle.presetId = presetId === 'none' ? null : (presetId as StylePresetId | null)
        if (paletteOverride !== undefined)
          world.globalStyle.paletteOverride = paletteOverride as [string, string, string, string] | null
        if (bgColorOverride !== undefined) world.globalStyle.bgColorOverride = bgColorOverride
        if (fontOverride !== undefined) world.globalStyle.fontOverride = fontOverride

        if (font && !isValidFont(font)) {
          return {
            success: false,
            affectedSceneId: null,
            error: `Font "${font}" is not in the curated catalog. Available fonts: ${FONT_FAMILIES.join(', ')}`,
            changes: [],
          }
        }
        if (bodyFont && !isValidFont(bodyFont)) {
          return {
            success: false,
            affectedSceneId: null,
            error: `Body font "${bodyFont}" is not in the curated catalog. Available fonts: ${FONT_FAMILIES.join(', ')}`,
            changes: [],
          }
        }
        if (palette) world.globalStyle.palette = palette as GlobalStyle['palette']
        if (font) world.globalStyle.font = font
        if (bodyFont) world.globalStyle.bodyFontOverride = bodyFont
        if (strokeWidth !== undefined) world.globalStyle.strokeWidth = Math.max(1, Math.min(5, strokeWidth))
        if (theme) world.globalStyle.theme = theme
        if (duration) world.globalStyle.duration = duration

        // Emit a single style/setGlobal capturing what actually changed.
        const globalPatch: Partial<GlobalStyle> = {}
        const globalPrior: Partial<GlobalStyle> = {}
        const priorRecord = priorGlobal as unknown as Record<string, unknown>
        const nextRecord = world.globalStyle as unknown as Record<string, unknown>
        const globalKeys = new Set<string>([...Object.keys(priorRecord), ...Object.keys(nextRecord)])
        for (const k of globalKeys) {
          if (priorRecord[k] !== nextRecord[k]) {
            ;(globalPatch as Record<string, unknown>)[k] = nextRecord[k]
            ;(globalPrior as Record<string, unknown>)[k] = priorRecord[k]
          }
        }
        if (Object.keys(globalPatch).length > 0) {
          emitAgentAction(
            { type: 'style/setGlobal', params: { patch: globalPatch, prior: globalPrior } },
            emitterDeps(world),
          )
        }

        if (scope === 'all_scenes') {
          for (let i = 0; i < world.scenes.length; i++) {
            const priorOverride = world.scenes[i].styleOverride
            const sceneId = world.scenes[i].id
            world.scenes[i] = { ...world.scenes[i], styleOverride: {} }
            emitAgentAction(
              {
                type: 'scene/update',
                params: { sceneId, patch: { styleOverride: {} }, prior: { styleOverride: priorOverride } },
              },
              emitterDeps(world),
            )
          }
          // Collect every regenerate result — a new global style can make one or
          // more scenes throw at render. Discarding these (the old behaviour) let
          // the tool report success:true / affectedSceneId:null, so the post-tool
          // `_verify` gate (which keys off result.affectedSceneId) NEVER fired and
          // the agent moved on with broken scenes in the demo.
          const results = await Promise.all(
            world.scenes.map(async (s) => ({ id: s.id, ...(await deps.regenerateHTML(world, s.id, logger)) })),
          )
          const broken = results.filter(
            (r) =>
              // A user Stop mid-regen returns { htmlWritten:false, error:'Run aborted…' }
              // — that's a cancellation, not a style-induced break, so don't report
              // it as "the global style broke this scene".
              !(r.error && /abort/i.test(r.error)) &&
              (r.verifyStatus === 'errored' || r.htmlWritten === false || Boolean(r.error)),
          )
          if (broken.length > 0) {
            // Surface the per-scene failures to the model so it can patch them.
            // Mirror the post-tool `_verify` signal shape (tool-executor.ts) so the
            // agent gets the SAME actionable "this scene broke, fix it" payload it
            // sees for single-scene tools — here as a per-scene list since the break
            // can span multiple scenes that affectedSceneId can't address.
            const details = broken.map((r) => {
              const msg = r.verifyError?.message ?? r.error ?? 'render failed after global style change'
              const kind = r.verifyError?.kind ?? 'runtime'
              const where = typeof r.verifyError?.line === 'number' ? ` at line ${r.verifyError.line}` : ''
              return { sceneId: r.id, kind, message: `${kind} error${where}: ${msg}` }
            })
            const list = details.map((d) => `${d.sceneId} (${d.message})`).join('; ')
            return {
              success: false,
              affectedSceneId: null,
              error:
                `Global style updated, but it broke ${broken.length} scene(s): ${list}. ` +
                `Fix each with patch_layer_code or regenerate_layer, then call verify_scene.`,
              changes: [
                {
                  type: 'global_updated',
                  description: 'Updated global style (applied to all scenes — some scenes errored)',
                },
              ],
              data: {
                _verify: {
                  status: 'errored',
                  brokenScenes: details,
                  hint: 'The new global style broke these scenes. Patch each one, then verify_scene.',
                },
              },
            }
          }
        }

        return {
          success: true,
          affectedSceneId: null,
          changes: [
            {
              type: 'global_updated',
              description: `Updated global style${scope === 'all_scenes' ? ' (applied to all scenes)' : ''}`,
            },
          ],
        }
      }

      case 'set_all_transitions': {
        const { transition: raw } = args as { transition?: string }
        // normalizeTransition falls back to 'none' for anything it doesn't recognise, so a
        // MISSING transition would silently flatten every scene to a hard cut. Refuse instead.
        if (typeof raw !== 'string' || !raw) return err('scene_props(op:"transition_all") requires transition')
        const transition = normalizeTransition(raw)
        // Fidelity guard: when the scene plan deliberately varies transitions per
        // scene (match-cut here, crossfade there), flattening every scene to one
        // value is the "all 8 → dissolve" defect. Skip and steer to set_transition
        // — the planned per-scene transitions are already seeded on the shells. A
        // plan with uniform/no transitions still allows the flatten (genuine
        // "same everywhere" intent).
        const plannedTransitions = ((world.scenePlan?.scenes ?? []) as Array<{ transition?: string }>)
          .map((s) => s.transition)
          .filter((t): t is string => !!t && t !== 'none')
        if (world.scenes.length >= 2 && new Set(plannedTransitions).size > 1) {
          return ok(
            null,
            `Skipped scene_props(op:"transition_all"): the plan specifies DIFFERENT transitions across scenes, so flattening them all to "${transition}" would discard that intent. The planned per-scene transitions are already applied — use scene_props(op:"transition", sceneId) to change a specific one.`,
          )
        }
        world.scenes.forEach((scene, idx) => {
          const priorTransition = scene.transition
          world.scenes[idx] = { ...scene, transition }
          if (priorTransition !== transition) {
            emitAgentAction(
              {
                type: 'scene/update',
                params: { sceneId: scene.id, patch: { transition }, prior: { transition: priorTransition } },
              },
              emitterDeps(world),
            )
          }
        })
        return ok(null, `Set all transitions to "${transition}"`)
      }

      case 'set_scene_style': {
        const { sceneId, preset, palette, bgColor, font, bodyFont, fontPairing, roughnessLevel, defaultTool } =
          args as {
            sceneId: string
            preset?: string
            palette?: string[]
            bgColor?: string
            font?: string
            bodyFont?: string
            fontPairing?: string
            roughnessLevel?: number
            defaultTool?: string
          }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        let override: SceneStyleOverride = { ...scene.styleOverride }
        if (preset && preset in SCENE_STYLE_PRESETS) {
          override = { ...SCENE_STYLE_PRESETS[preset as SceneStylePresetName] }
        }
        if (fontPairing) {
          const pairing = getFontPairing(fontPairing)
          if (pairing) {
            override.font = pairing.heading
            override.bodyFont = pairing.body
          }
        }
        if (font && !isValidFont(font)) {
          return err(`Font "${font}" is not in the curated catalog. Available: ${FONT_FAMILIES.join(', ')}`)
        }
        if (bodyFont && !isValidFont(bodyFont)) {
          return err(`Body font "${bodyFont}" is not in the curated catalog. Available: ${FONT_FAMILIES.join(', ')}`)
        }
        if (palette && palette.length === 4) override.palette = palette as [string, string, string, string]
        if (bgColor) override.bgColor = bgColor
        if (font) override.font = font
        if (bodyFont) override.bodyFont = bodyFont
        if (roughnessLevel !== undefined) override.roughnessLevel = roughnessLevel
        if (defaultTool) override.defaultTool = defaultTool
        const priorOverride = scene.styleOverride
        updateScene(world, sceneId, { styleOverride: override })
        emitAgentAction(
          {
            type: 'scene/update',
            params: { sceneId, patch: { styleOverride: override }, prior: { styleOverride: priorOverride } },
          },
          emitterDeps(world),
        )
        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, `Applied style ${preset ? `preset "${preset}"` : 'override'} to scene`)
      }

      default:
        return err(`Unknown style tool: ${toolName}`)
    }
  }
}
