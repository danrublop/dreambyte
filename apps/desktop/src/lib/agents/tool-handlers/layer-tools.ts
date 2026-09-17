import { v4 as uuidv4 } from 'uuid'
import type { Scene, SceneType, ZdogPersonAsset, ZdogPersonFormula } from '@/lib/types'
import type { AgentLogger } from '@/lib/agents/logger'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import {
  abortResult,
  clearStaleCodeFields,
  generateLayerContent,
  getWorldAbortSignal,
} from '@/lib/agents/tool-executor'
import { resolveStyle } from '@/lib/styles/presets'
import { generateCode } from '@/lib/generation/generate'
import { runStructuredD3Generation } from '@/lib/generation/d3-structured-run'
import { deriveChartLayersFromScene } from '@/lib/charts/extract'
import { compileD3SceneFromLayers } from '@/lib/charts/compile'
import { scoreLottieQuality } from '@/lib/motion/quality-score'
import { ok, err, findScene, updateScene, emitSceneUpdate, commitMediaSpend, type ToolResult } from './_shared'
import { isPlaceholderContent } from '@/lib/scenes/placeholder-content'
import { clampSceneDuration, plannedDurationFor } from '@/lib/agents/scene-duration'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'

/**
 * Score a Lottie layer's JSON so add_layer / regenerate_layer can return a
 * structured quality signal the agent uses to self-correct. Returns null
 * for non-lottie layers or unparseable JSON — scoring never blocks the result.
 */
function lottieQualityField(
  layerType: SceneType,
  code: string | undefined,
  expectedDuration?: number,
): { score: number; dimensions: Record<string, number>; suggestions: string[] } | null {
  if (layerType !== 'lottie' || !code?.trim()) return null
  try {
    const parsed = JSON.parse(code) as Record<string, unknown>
    const quality = scoreLottieQuality(parsed, { expectedDuration })
    return { score: quality.total, dimensions: quality.dimensions, suggestions: quality.suggestions }
  } catch {
    // Unparseable Lottie JSON: skip scoring rather than fail the tool. The
    // verify gate / render will surface the actual breakage downstream.
    return null
  }
}

/**
 * P1b-fanout-layer: turn the action_log on for layer-tool mutations so
 * undo + the diff viewer see them. Each successful mutation emits exactly
 * the patch that hit `updateScene`. Best-effort: errors are logged inside
 * `emitAgentAction` and never block the tool result.
 */

// ── Tool Names ───────────────────────────────────────────────────────────────

export const LAYER_TOOL_NAMES = [
  'add_layer',
  'create_zdog_composed_scene',
  // save_zdog_asset(kind) is the MODEL-facing name for the two library WRITERS; the
  // reader already returned both libraries. Router below maps kind → the original case.
  'save_zdog_asset',
  'list_zdog_person_assets',
  'remove_layer',
  'reorder_layer',
  'set_layer_opacity',
  'set_layer_visibility',
  'set_layer_grade',
  'set_layer_timing',
  'regenerate_layer',
  'patch_layer_code',
  'write_scene_code',
  // read_scene_code is reached as inspect(kind:'code'); tool-executor's inspect router
  // calls this handler directly, so the name needs no registry entry of its own.
] as const

// ── Factory ──────────────────────────────────────────────────────────────────

export function createLayerToolHandler(deps: {
  regenerateHTML: (world: WorldStateMutable, sceneId: string, logger?: AgentLogger) => Promise<{ htmlWritten: boolean }>
}) {
  const { regenerateHTML } = deps

  return async function handleLayerTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: AgentLogger,
  ): Promise<ToolResult> {
    // save_zdog_asset(kind) → the two original writer cases below.
    if (toolName === 'save_zdog_asset') {
      const kind = (args as { kind?: string }).kind
      if (kind !== 'person' && kind !== 'shapes') {
        return { success: false, error: `save_zdog_asset: unknown kind "${String(kind)}" — expected person or shapes.` }
      }
      toolName = kind === 'person' ? 'save_zdog_person_asset' : 'build_zdog_asset'
    }
    switch (toolName) {
      // ── add_layer ───────────────────────────────────────────────────────

      case 'add_layer': {
        const { sceneId, layerType, prompt, zIndex, opacity, startAt, generatedCode } = args as {
          sceneId: string
          layerType: SceneType
          prompt: string
          zIndex?: number
          opacity?: number
          startAt?: number
          /** Pre-generated code — skips LLM generation (used by local model fallback) */
          generatedCode?: string
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        // If the run is scoped to D3 tools, block non-D3 add_layer to avoid accidental mode drift.
        if ((world.activeTools || []).includes('d3') && layerType !== 'd3') {
          return err(`add_layer(${layerType}) blocked in D3-only mode. Use layerType 'd3' or chart(op:'create').`)
        }

        let result: { success: boolean; code?: string; error?: string; aborted?: boolean }
        if (generatedCode) {
          // Skip LLM — use pre-generated code directly (local model fallback path)
          logger?.log('generation', `Using pre-generated code (${generatedCode.length} chars)`)
          result = { success: true, code: generatedCode }
        } else {
          // Generate content via direct SDK call
          result = await generateLayerContent(
            layerType,
            prompt,
            scene,
            world.globalStyle,
            world.modelId,
            world.modelTier,
            logger,
            world.modelConfigs,
            getWorldAbortSignal(world),
          )
        }
        if (!result.success) {
          return result.aborted
            ? abortResult(result.error || 'Run aborted by user')
            : err(result.error || 'Layer generation failed')
        }
        if (!result.code?.trim()) return err('Layer generation returned empty code — nothing to render')
        // TOCTOU close: the helper's discard check ran BEFORE this handler
        // resumed — re-check before committing the mutation + HTML write.
        if (getWorldAbortSignal(world)?.aborted) {
          return abortResult('Run aborted by user — generated content discarded before commit')
        }

        const layerId = uuidv4()

        // Clear stale code fields from previous scene type before setting new ones
        const staleClears = clearStaleCodeFields(layerType)

        if (layerType === 'svg') {
          const newObj = {
            id: layerId,
            prompt,
            svgContent: result.code || '',
            x: 0,
            y: 0,
            width: 100,
            opacity: opacity ?? 1,
            zIndex: zIndex ?? 2,
          }
          const existing = scene.svgObjects || []
          updateScene(world, sceneId, {
            ...staleClears,
            sceneType: 'svg',
            svgObjects: [...existing, newObj],
            svgContent: result.code || '',
          })
        } else {
          // For canvas2d, d3, three, motion, lottie, zdog — update sceneCode/canvasCode
          const updates: Partial<Scene> = { ...staleClears, sceneType: layerType }
          if (layerType === 'canvas2d') updates.canvasCode = result.code || ''
          else if (layerType === 'lottie') updates.lottieSource = result.code || ''
          else if (layerType === 'react') updates.reactCode = result.code || ''
          else updates.sceneCode = result.code || ''
          updateScene(world, sceneId, updates)
        }

        emitSceneUpdate(world, sceneId, scene)
        await regenerateHTML(world, sceneId, logger)
        const addLottieQuality = lottieQualityField(layerType, result.code, scene.duration)
        return {
          success: true,
          affectedSceneId: sceneId,
          changes: [{ type: 'scene_updated', sceneId, description: `Added ${layerType} layer: "${prompt}"` }],
          data: { layerId, ...(addLottieQuality ? { lottieQuality: addLottieQuality } : {}) },
        }
      }

      // ── create_zdog_composed_scene ──────────────────────────────────────

      case 'create_zdog_composed_scene': {
        const { sceneId, seed, people, modules, beats, title } = args as {
          sceneId: string
          seed: number
          people: unknown[]
          modules: unknown[]
          beats: unknown[]
          title?: string
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        if (!Array.isArray(people) || people.length === 0) return err('people must be a non-empty array')
        if (!Array.isArray(modules)) return err('modules must be an array')
        if (!Array.isArray(beats)) return err('beats must be an array')

        const resolved = resolveStyle(world.globalStyle.presetId, world.globalStyle)
        const library = world.zdogLibrary || []
        const resolvedPeople = (people as any[]).map((p) => {
          if (!p || typeof p !== 'object' || !p.assetId) return p
          const asset = library.find((a) => a.id === p.assetId)
          if (!asset) return p
          return { ...p, formula: { ...(asset.formula || {}), ...(p.formula || {}) } }
        })

        const result = await generateCode('zdog', title || scene.prompt || 'Deterministic composed zdog scene', {
          palette: resolved.palette,
          bgColor: scene.bgColor,
          duration: scene.duration,
          font: resolved.font,
          strokeWidth: world.globalStyle.strokeWidth ?? 2,
          modelId: world.modelId,
          modelTier: world.modelTier,
          zdogComposedSpec: {
            seed,
            title,
            people: resolvedPeople as any,
            modules: modules as any,
            beats: beats as any,
          },
        })

        const staleClears = clearStaleCodeFields('zdog')
        updateScene(world, sceneId, {
          ...staleClears,
          sceneType: 'zdog',
          sceneCode: result.code || '',
          prompt: title || scene.prompt,
        })
        emitSceneUpdate(world, sceneId, scene)
        await regenerateHTML(world, sceneId, logger)
        return ok(sceneId, 'Built deterministic composed Zdog scene', {
          mode: 'composed',
          usage: result.usage,
        })
      }

      // ── save_zdog_person_asset ──────────────────────────────────────────

      case 'save_zdog_person_asset': {
        const { name, formula, tags } = args as {
          name: string
          formula: ZdogPersonFormula
          tags?: string[]
        }
        if (!name || !formula) return err('name and formula are required')
        const now = new Date().toISOString()
        const asset: ZdogPersonAsset = {
          id: uuidv4(),
          name: String(name).slice(0, 120),
          formula,
          tags: Array.isArray(tags) ? tags : [],
          createdAt: now,
          updatedAt: now,
        }
        world.zdogLibrary = [...(world.zdogLibrary || []), asset]
        return ok(null, `Saved Zdog person asset "${asset.name}"`, { asset })
      }

      // ── list_zdog_person_assets ─────────────────────────────────────────

      case 'list_zdog_person_assets': {
        const assets = world.zdogLibrary || []
        const studioAssets = world.zdogStudioLibrary || []
        return ok(null, `Listed ${assets.length} person assets, ${studioAssets.length} studio assets`, {
          assets,
          studioAssets,
        })
      }

      // ── build_zdog_asset ───────────────────────────────────────────────

      case 'build_zdog_asset': {
        const { name, shapes, tags } = args as {
          name: string
          shapes: any[]
          tags?: string[]
        }
        if (!name || !shapes?.length) return err('name and shapes are required')
        const now = new Date().toISOString()
        const asset = {
          id: uuidv4(),
          name: String(name).slice(0, 120),
          shapes,
          tags: Array.isArray(tags) ? tags : [],
          createdAt: now,
          updatedAt: now,
        }
        world.zdogStudioLibrary = [...(world.zdogStudioLibrary || []), asset]
        return ok(null, `Saved Zdog studio asset "${asset.name}" with ${shapes.length} shapes`, { asset })
      }

      // ── remove_layer ────────────────────────────────────────────────────

      case 'remove_layer': {
        const { sceneId, layerId } = args as { sceneId: string; layerId: string }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        // Try to remove from svgObjects
        const svgIdx = (scene.svgObjects || []).findIndex((o) => o.id === layerId)
        if (svgIdx !== -1) {
          const newObjects = scene.svgObjects.filter((o) => o.id !== layerId)
          updateScene(world, sceneId, { svgObjects: newObjects })
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Removed SVG layer ${layerId}`)
        }

        // Try AI layers
        const aiIdx = (scene.aiLayers || []).findIndex((l) => l.id === layerId)
        if (aiIdx !== -1) {
          const removedLayer = scene.aiLayers[aiIdx]
          const newLayers = scene.aiLayers.filter((l) => l.id !== layerId)
          updateScene(world, sceneId, { aiLayers: newLayers })
          emitAgentAction(
            {
              type: 'layer/remove',
              params: { sceneId, layerId, prior: { layer: removedLayer, index: aiIdx } },
            },
            emitterDeps(world),
          )
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Removed AI layer ${layerId}`)
        }

        // D3 chart layers (same ids as chartLayers / context)
        const chartList = deriveChartLayersFromScene(scene as Scene)
        if (chartList.some((c) => c.id === layerId)) {
          const nextCharts = chartList.filter((c) => c.id !== layerId)
          const compiled = compileD3SceneFromLayers(nextCharts)
          const staleClears = clearStaleCodeFields('d3')
          updateScene(world, sceneId, {
            ...staleClears,
            sceneType: 'd3',
            sceneCode: compiled.sceneCode,
            sceneStyles: '',
            d3Data: compiled.d3Data,
            chartLayers: nextCharts,
          })
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Removed chart layer ${layerId}`)
        }

        return err(`Layer ${layerId} not found in scene ${sceneId}`)
      }

      // ── reorder_layer ───────────────────────────────────────────────────

      case 'reorder_layer': {
        const { sceneId, layerId, zIndex } = args as { sceneId: string; layerId: string; zIndex: number }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        const svgObj = (scene.svgObjects || []).find((o) => o.id === layerId)
        if (svgObj) {
          const updated = scene.svgObjects.map((o) => (o.id === layerId ? { ...o, zIndex } : o))
          updateScene(world, sceneId, { svgObjects: updated })
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Set layer ${layerId} z-index to ${zIndex}`)
        }
        return err(`Layer ${layerId} not found`)
      }

      // ── set_layer_opacity ───────────────────────────────────────────────

      case 'set_layer_opacity': {
        const { sceneId, layerId, opacity } = args as { sceneId: string; layerId: string; opacity: number }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        const clamped = Math.max(0, Math.min(1, opacity))
        const svgObj = (scene.svgObjects || []).find((o) => o.id === layerId)
        if (svgObj) {
          const updated = scene.svgObjects.map((o) => (o.id === layerId ? { ...o, opacity: clamped } : o))
          updateScene(world, sceneId, { svgObjects: updated })
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Set layer ${layerId} opacity to ${clamped}`)
        }

        // Try AI layers
        const aiLayer = (scene.aiLayers || []).find((l) => l.id === layerId)
        if (aiLayer) {
          const updated = scene.aiLayers.map((l) => (l.id === layerId ? { ...l, opacity: clamped } : l))
          updateScene(world, sceneId, { aiLayers: updated })
          emitAgentAction(
            {
              type: 'layer/update',
              params: { sceneId, layerId, patch: { opacity: clamped }, prior: { opacity: aiLayer.opacity ?? 1 } },
            },
            emitterDeps(world),
          )
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Set AI layer opacity to ${clamped}`)
        }
        return err(`Layer ${layerId} not found`)
      }

      // ── set_layer_visibility ────────────────────────────────────────────

      case 'set_layer_visibility': {
        const { sceneId, layerId, visible } = args as { sceneId: string; layerId: string; visible: boolean }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        // Visibility is handled via opacity (0 = hidden, 1 = visible)
        const svgObj = (scene.svgObjects || []).find((o) => o.id === layerId)
        if (svgObj) {
          const updated = scene.svgObjects.map((o) => (o.id === layerId ? { ...o, opacity: visible ? 1 : 0 } : o))
          updateScene(world, sceneId, { svgObjects: updated })
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Set layer ${layerId} visibility to ${visible}`)
        }

        // Try AI layers
        const aiLayer = (scene.aiLayers || []).find((l) => l.id === layerId)
        if (aiLayer) {
          const nextOpacity = visible ? 1 : 0
          const updated = scene.aiLayers.map((l) => (l.id === layerId ? { ...l, opacity: nextOpacity } : l))
          updateScene(world, sceneId, { aiLayers: updated })
          emitAgentAction(
            {
              type: 'layer/update',
              params: {
                sceneId,
                layerId,
                patch: { opacity: nextOpacity },
                prior: { opacity: aiLayer.opacity ?? 1 },
              },
            },
            emitterDeps(world),
          )
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Set AI layer ${layerId} visibility to ${visible}`)
        }
        return err(`Layer ${layerId} not found`)
      }

      // ── set_layer_grade ─────────────────────────────────────────────────
      // The advanced (DaVinci/Lumetri-style) correction stack — exposure,
      // contrast, saturation, temperature/tint, hue, lift/gamma/gain wheels,
      // per-channel curves, vignette, sharpen — stored as `colorGrade` on a
      // video or image layer and baked into the scene HTML (CSS + SVG filter).
      // Merges into the existing grade (provide only what you want to change);
      // `reset:true` clears it. Target the scene's video footage by omitting
      // layerId or passing 'video'; otherwise the AI image layer with that id.
      case 'set_layer_grade': {
        const { sceneId, layerId, grade, reset } = args as {
          sceneId: string
          layerId?: string
          grade?: Record<string, unknown>
          reset?: boolean
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        const { NEUTRAL_WHEEL } = await import('@/lib/edit-engines/layer-grade')
        type Grade = import('@/lib/edit-engines/layer-grade').LayerColorGrade
        const clamp = (v: unknown, lo: number, hi: number, fb: number): number =>
          typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
        const wheel = (w: unknown): { r: number; g: number; b: number; master: number } | undefined => {
          if (!w || typeof w !== 'object') return undefined
          const o = w as Record<string, unknown>
          return {
            r: clamp(o.r, -1, 1, 0),
            g: clamp(o.g, -1, 1, 0),
            b: clamp(o.b, -1, 1, 0),
            master: clamp(o.master, -1, 1, 0),
          }
        }
        // Build the merged grade from a base + the provided patch.
        const buildGrade = (base: Grade | undefined): Grade | undefined => {
          if (reset) return undefined
          const g = { ...(base ?? {}) } as Record<string, unknown>
          const p = grade ?? {}
          for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'tint'] as const) {
            if (k in p) g[k] = clamp(p[k], -1, 1, 0)
          }
          if ('hue' in p) g.hue = clamp(p.hue, -180, 180, 0)
          if ('vignette' in p) g.vignette = clamp(p.vignette, 0, 1, 0)
          if ('sharpen' in p) g.sharpen = clamp(p.sharpen, 0, 1, 0)
          for (const k of ['lift', 'gamma', 'gain'] as const) {
            if (k in p) g[k] = wheel(p[k]) ?? NEUTRAL_WHEEL
          }
          if ('curves' in p && p.curves && typeof p.curves === 'object') g.curves = p.curves
          return g as Grade
        }

        const hasVideo = !!(scene.videoLayer?.enabled && scene.videoLayer.src)
        const imageLayers = (scene.aiLayers || []).filter((l) => (l as { type?: string }).type === 'image')
        // Target video when explicitly asked, or when no layerId is given AND
        // there's footage. With no layerId and no footage, fall back to the sole
        // image layer (the common "grade the picture" case) instead of erroring.
        const wantsVideo = layerId === 'video' || layerId === scene.videoLayer?.src || (!layerId && hasVideo)
        if (wantsVideo) {
          if (!hasVideo) {
            return err(`Scene ${sceneId} has no video layer to grade (pass an AI image layerId, or add footage first)`)
          }
          const nextGrade = buildGrade(scene.videoLayer.colorGrade)
          updateScene(world, sceneId, { videoLayer: { ...scene.videoLayer, colorGrade: nextGrade } })
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, reset ? `Cleared grade on the video layer` : `Graded the video layer`, { target: 'video' })
        }

        const aiLayer = layerId
          ? (scene.aiLayers || []).find((l) => l.id === layerId)
          : // no layerId + no video: grade the sole/first image layer
            (imageLayers[0] ?? (scene.aiLayers || [])[0])
        if (aiLayer) {
          const targetId = aiLayer.id // may differ from layerId when we fell back to the sole image layer
          const prior = (aiLayer as { colorGrade?: Grade }).colorGrade
          const nextGrade = buildGrade(prior)
          const updated = scene.aiLayers.map((l) => (l.id === targetId ? { ...l, colorGrade: nextGrade } : l))
          updateScene(world, sceneId, { aiLayers: updated as never })
          emitAgentAction(
            {
              type: 'layer/update',
              params: { sceneId, layerId: targetId, patch: { colorGrade: nextGrade }, prior: { colorGrade: prior } },
            },
            emitterDeps(world),
          )
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, reset ? `Cleared grade on layer ${targetId}` : `Graded layer ${targetId}`, {
            target: targetId,
          })
        }
        return err(
          `No gradable layer in scene ${sceneId} (no video footage and no image layer${layerId ? `; '${layerId}' not found` : ''})`,
        )
      }

      // ── set_layer_timing ────────────────────────────────────────────────

      case 'set_layer_timing': {
        const { sceneId, layerId, startAt } = args as { sceneId: string; layerId: string; startAt: number }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        // startAt is stored in aiLayers
        const aiLayer = (scene.aiLayers || []).find((l) => l.id === layerId)
        if (aiLayer) {
          const updated = scene.aiLayers.map((l) => (l.id === layerId ? { ...l, startAt } : l))
          updateScene(world, sceneId, { aiLayers: updated })
          emitAgentAction(
            {
              type: 'layer/update',
              params: {
                sceneId,
                layerId,
                patch: { startAt },
                prior: { startAt: (aiLayer as { startAt?: number }).startAt },
              },
            },
            emitterDeps(world),
          )
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Set layer startAt to ${startAt}s`)
        }
        return err(`Layer ${layerId} not found in aiLayers`)
      }

      // ── regenerate_layer ────────────────────────────────────────────────

      case 'regenerate_layer': {
        const { sceneId, layerId, prompt, params } = args as {
          sceneId: string
          layerId: string
          prompt: string
          /** AI-layer-specific overrides (model, reference image) ride here. */
          params?: { model?: string; aspectRatio?: string; style?: string; referenceImageUrl?: string }
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        // ── AI layer branch (image/sticker) — decision 3A: EXTEND, not a new tool.
        // Regenerates the layer's media in place from its provenance, keeping
        // geometry/timing/z-order. Fail-loud: any failure leaves the prior
        // layer fully intact and returns a visible error (no partial mutation).
        const aiLayer = (scene.aiLayers || []).find((l) => l.id === layerId)
        if (aiLayer) {
          if (aiLayer.type !== 'image' && aiLayer.type !== 'sticker') {
            return err(
              `regenerate_layer does not yet support "${aiLayer.type}" layers (only image/sticker). ` +
                `Use the dedicated generation tool to replace this layer.`,
            )
          }
          const prov = (aiLayer as { provenance?: import('@/lib/types').LayerProvenance | null }).provenance ?? null
          const effectivePrompt = (prompt && prompt.trim()) || prov?.prompt || (aiLayer as { prompt?: string }).prompt
          if (!effectivePrompt || !effectivePrompt.trim()) {
            return err(
              `Layer ${layerId} has no provenance prompt to regenerate from. ` +
                `It was placed without generation metadata — provide a prompt argument, or remove and regenerate the layer.`,
            )
          }
          const model =
            params?.model ||
            prov?.model ||
            (aiLayer as { model?: string }).model ||
            (aiLayer.type === 'sticker' ? 'recraft-v3' : 'flux-schnell')

          try {
            const { generateImage } = await import('@/lib/apis/image-gen')
            const genResult = await generateImage({
              prompt: effectivePrompt,
              model: model as import('@/lib/types').ImageModel,
              aspectRatio: (params?.aspectRatio as any) ?? '1:1',
              style: (params?.style as any) ?? prov?.style ?? (aiLayer as { style?: string }).style ?? null,
            })
            let finalUrl = genResult.imageUrl
            let bgRemovalCost = 0
            // Stickers carry a transparent cutout — preserve that on regen.
            if (aiLayer.type === 'sticker') {
              const { removeImageBackground } = await import('@/lib/apis/background-removal')
              const bg = await removeImageBackground(genResult.imageUrl)
              finalUrl = bg.resultUrl
              bgRemovalCost = bg.cost ?? 0
            }
            // Commit the paid regen spend so the per-project cap accumulates — regenerate_layer
            // calls generateImage directly (gated at the choke point, but never ledgered). Bill the
            // image under 'imageGen' and any sticker background removal under 'backgroundRemoval';
            // genResult.cost is the actual provider cost (0 → skipped).
            await commitMediaSpend(
              world,
              'imageGen',
              genResult.cost ?? 0,
              `regenerate_layer ${String(model)}: ${effectivePrompt.slice(0, 80)}`,
            )
            if (aiLayer.type === 'sticker')
              await commitMediaSpend(
                world,
                'backgroundRemoval',
                bgRemovalCost,
                `regenerate_layer rmbg: ${effectivePrompt.slice(0, 80)}`,
              )
            // Persist the regenerated result as a new asset (provenance chain via parentAssetId).
            let newAssetId: string | null = null
            if (world.projectId) {
              try {
                const { persistGeneratedAsset } = await import('@/lib/media/provenance')
                const persisted = await persistGeneratedAsset({
                  projectId: world.projectId,
                  sourceUrl: finalUrl,
                  type: 'image',
                  ...(aiLayer.type === 'sticker' ? { tags: ['sticker'] } : {}),
                  metadata: {
                    prompt: effectivePrompt,
                    provider: 'imageGen',
                    model: model as string,
                    costCents: Math.round((genResult.cost ?? 0) * 100),
                    parentAssetId: (aiLayer as { assetId?: string | null }).assetId ?? null,
                    referenceAssetIds: prov?.referenceAssetIds ?? null,
                    enhanceTags: null,
                  },
                })
                newAssetId = persisted.id
                finalUrl = persisted.publicUrl
              } catch (e) {
                // Non-fatal: regeneration succeeded; we just couldn't persist the
                // new asset to the library. Surface in the log; keep the new URL.
                logger?.warn('regenerate_layer', `persist regenerated asset failed: ${(e as Error).message}`)
              }
            }
            // In-place swap: preserve geometry, timing, z-order, opacity, animation.
            const newProvenance: import('@/lib/types').LayerProvenance = {
              prompt: effectivePrompt,
              provider: 'imageGen',
              model: model as string,
              style: (params?.style as string) ?? prov?.style ?? null,
              referenceAssetIds: prov?.referenceAssetIds ?? null,
              generatedAt: new Date().toISOString(),
            }
            const updatedLayers = scene.aiLayers.map((l) => {
              if (l.id !== layerId) return l
              const patched: Record<string, unknown> = {
                ...l,
                prompt: effectivePrompt,
                assetId: newAssetId ?? (l as { assetId?: string | null }).assetId ?? null,
                provenance: newProvenance,
              }
              if (l.type === 'sticker') patched.stickerUrl = finalUrl
              else patched.imageUrl = finalUrl
              return patched as unknown as typeof l
            })
            updateScene(world, sceneId, { aiLayers: updatedLayers })
            emitSceneUpdate(world, sceneId, scene)
            await regenerateHTML(world, sceneId, logger)
            return ok(sceneId, `Regenerated ${aiLayer.type} layer ${layerId}`, {
              assetId: newAssetId,
              imageUrl: finalUrl,
              cost: genResult.cost,
            })
          } catch (e) {
            // Fail-loud contract: the prior layer is untouched (we never mutated
            // world before this point). Return a visible error for the chat.
            return err(`Regeneration failed for ${aiLayer.type} layer ${layerId}: ${(e as Error).message}`)
          }
        }

        const svgObj = (scene.svgObjects || []).find((o) => o.id === layerId)
        if (svgObj) {
          const result = await generateLayerContent(
            'svg',
            prompt,
            scene,
            world.globalStyle,
            world.modelId,
            world.modelTier,
            logger,
            world.modelConfigs,
            getWorldAbortSignal(world),
          )
          if (!result.success) {
            return result.aborted
              ? abortResult(result.error || 'Run aborted by user')
              : err(result.error || 'Regeneration failed')
          }
          if (getWorldAbortSignal(world)?.aborted) {
            return abortResult('Run aborted by user — generated content discarded before commit')
          }
          const updated = scene.svgObjects.map((o) =>
            o.id === layerId ? { ...o, prompt, svgContent: result.code || '' } : o,
          )
          updateScene(world, sceneId, { svgObjects: updated, svgContent: result.code || '' })
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Regenerated layer ${layerId}`)
        }

        // D3 scenes with structured chartLayers: regenerate via DreambyteCharts JSON
        if (scene.sceneType === 'd3' && deriveChartLayersFromScene(scene as Scene).length > 0) {
          const resolved = resolveStyle(world.globalStyle.presetId, world.globalStyle)
          const text = (prompt && String(prompt).trim()) || (scene.prompt || '').trim()
          if (!text) return err('Provide a prompt to regenerate this D3 chart scene')
          try {
            const useProjectModel =
              world.modelId && String(world.modelId).toLowerCase().includes('claude')
                ? String(world.modelId)
                : undefined
            const out = await runStructuredD3Generation({
              prompt: text,
              palette: resolved.palette,
              font: resolved.font,
              bgColor: scene.bgColor,
              duration: scene.duration || 8,
              previousSummary: '',
              d3Data: scene.d3Data,
              model: useProjectModel,
            })
            const staleClears = clearStaleCodeFields('d3')
            updateScene(world, sceneId, {
              ...staleClears,
              sceneType: 'd3',
              prompt: text,
              sceneCode: out.sceneCode,
              sceneStyles: out.styles || '',
              d3Data: out.d3Data,
              chartLayers: out.chartLayers,
            })
            emitSceneUpdate(world, sceneId, scene)
            await regenerateHTML(world, sceneId, logger)
            return ok(sceneId, `Regenerated D3 charts (${out.chartLayers.length} layer(s))`, { usage: out.usage })
          } catch (e) {
            return err(e instanceof Error ? e.message : 'Structured D3 regeneration failed')
          }
        }

        // FALLTHROUGH GUARD (Codex finding): at this point the layerId matched
        // no svgObject, no AI layer, and no D3 chart. Whole-scene code
        // regeneration is ONLY valid when the agent targets the scene itself
        // (layerId === sceneId — code scenes expose no sub-layer id). Any other
        // id is stale/typo'd and MUST error rather than silently nuking the
        // entire scene's code.
        if (layerId !== sceneId) {
          return err(
            `Layer ${layerId} not found in scene ${sceneId} (no SVG object, AI layer, or chart with that id). ` +
              `To regenerate the whole scene's code, pass layerId === sceneId.`,
          )
        }

        // For non-SVG scenes, regenerate the scene code
        const layerType = scene.sceneType
        const result = await generateLayerContent(
          layerType,
          prompt,
          scene,
          world.globalStyle,
          world.modelId,
          world.modelTier,
          logger,
          world.modelConfigs,
          getWorldAbortSignal(world),
        )
        if (!result.success) {
          return result.aborted
            ? abortResult(result.error || 'Run aborted by user')
            : err(result.error || 'Regeneration failed')
        }
        if (getWorldAbortSignal(world)?.aborted) {
          return abortResult('Run aborted by user — generated content discarded before commit')
        }

        const updates: Partial<Scene> = { prompt }
        if (layerType === 'canvas2d') updates.canvasCode = result.code || ''
        else if (layerType === 'lottie') updates.lottieSource = result.code || ''
        else if (layerType === 'react') updates.reactCode = result.code || ''
        else updates.sceneCode = result.code || ''
        updateScene(world, sceneId, updates)
        emitSceneUpdate(world, sceneId, scene)
        await regenerateHTML(world, sceneId, logger)
        const regenLottieQuality = lottieQualityField(layerType, result.code, scene.duration)
        return ok(
          sceneId,
          `Regenerated ${layerType} scene code`,
          regenLottieQuality ? { lottieQuality: regenLottieQuality } : undefined,
        )
      }

      // ── patch_layer_code ────────────────────────────────────────────────

      case 'patch_layer_code': {
        const { sceneId, layerId, oldCode, newCode } = args as {
          sceneId: string
          layerId: string
          oldCode: string
          newCode: string
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        // Try SVG object
        const svgObj = (scene.svgObjects || []).find((o) => o.id === layerId)
        if (svgObj) {
          if (!svgObj.svgContent.includes(oldCode)) {
            return err(`oldCode not found in layer ${layerId} SVG content. Make sure it's an exact substring.`)
          }
          const matchCount = svgObj.svgContent.split(oldCode).length - 1
          const patchedSvg = svgObj.svgContent.replace(oldCode, newCode)
          const updated = scene.svgObjects.map((o) => (o.id === layerId ? { ...o, svgContent: patchedSvg } : o))
          // Also update top-level svgContent if this is the primary object
          const updates: Partial<Scene> = { svgObjects: updated }
          if (scene.primaryObjectId === layerId) updates.svgContent = patchedSvg
          updateScene(world, sceneId, updates)
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          const warning =
            matchCount > 1 ? ` (warning: oldCode matched ${matchCount} times, only first was replaced)` : ''
          return ok(sceneId, `Patched SVG layer ${layerId}${warning}`)
        }

        // Try patching sceneCode/canvasCode/lottieSource
        const codeField =
          scene.sceneType === 'canvas2d'
            ? 'canvasCode'
            : scene.sceneType === 'lottie'
              ? 'lottieSource'
              : scene.sceneType === 'react'
                ? 'reactCode'
                : 'sceneCode'
        const code: string = (scene[codeField as keyof Scene] as string) || ''
        if (!code.includes(oldCode)) {
          // Try whitespace-normalized matching as a fallback
          const normalizeWs = (s: string) => s.replace(/\s+/g, ' ').trim()
          const normalizedCode = normalizeWs(code)
          const normalizedOld = normalizeWs(oldCode)
          if (normalizedCode.includes(normalizedOld)) {
            // Find the actual substring with original whitespace
            const startHint = oldCode.trim().slice(0, 30)
            return err(
              `oldCode not found as-is in ${codeField}, but a whitespace-normalized match exists. ` +
                `The code likely has different indentation/newlines. Try copying the exact code starting with "${startHint}…" from the scene.`,
            )
          }
          // Show a nearby snippet for context
          const firstLine = oldCode.split('\n')[0].trim().slice(0, 40)
          const codeSnippetIdx = code.toLowerCase().indexOf(firstLine.toLowerCase())
          const hint =
            codeSnippetIdx >= 0
              ? ` Closest match near char ${codeSnippetIdx}: "${code.slice(Math.max(0, codeSnippetIdx - 10), codeSnippetIdx + 50).replace(/\n/g, '\\n')}…"`
              : ` Code is ${code.length} chars. First 80: "${code.slice(0, 80).replace(/\n/g, '\\n')}…"`
          return err(`oldCode not found in ${codeField}. Make sure it's an exact substring match.${hint}`)
        }
        const matchCount = code.split(oldCode).length - 1
        const patched = code.replace(oldCode, newCode)
        updateScene(world, sceneId, { [codeField]: patched })
        emitSceneUpdate(world, sceneId, scene)
        await regenerateHTML(world, sceneId, logger)
        const warning = matchCount > 1 ? ` (warning: oldCode matched ${matchCount} times, only first was replaced)` : ''
        return ok(sceneId, `Patched ${codeField} in scene ${sceneId}${warning}`)
      }

      // ── read_scene_code ──────────────────────────────────────────────
      // Returns the full source code for a scene — not truncated like the world state preview.

      case 'read_scene_code': {
        const { sceneId } = args as { sceneId: string }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        const parts: string[] = []
        parts.push(`Scene: "${scene.name}" (${scene.id})`)
        parts.push(`Type: ${scene.sceneType}`)
        parts.push(`Duration: ${scene.duration}s`)

        // Primary code field
        const codeField =
          scene.sceneType === 'react'
            ? 'reactCode'
            : scene.sceneType === 'canvas2d'
              ? 'canvasCode'
              : scene.sceneType === 'svg'
                ? 'svgContent'
                : scene.sceneType === 'lottie'
                  ? 'lottieSource'
                  : 'sceneCode'
        const code = (scene[codeField as keyof Scene] as string) || ''
        // A non-selected scene's code is stripped to a `[<n> chars]`
        // placeholder in the run body. If that placeholder is what we'd return,
        // fail honestly instead of handing the agent a fake "source" it would
        // then echo back into write_scene_code and persist as the real code.
        if (isPlaceholderContent(code)) {
          return err(
            `Source not available in this run — the scene's ${codeField} was elided (placeholder "${code}"). ` +
              `Re-open the scene or use write_scene_code to supply new code.`,
          )
        }
        if (code) {
          parts.push(`\n--- ${codeField} (${code.length} chars) ---`)
          parts.push(code)
        }

        if (scene.sceneStyles) {
          parts.push(`\n--- styles (${scene.sceneStyles.length} chars) ---`)
          parts.push(scene.sceneStyles)
        }

        if (scene.canvasBackgroundCode?.trim()) {
          parts.push(`\n--- canvasBackgroundCode (${scene.canvasBackgroundCode.length} chars) ---`)
          parts.push(scene.canvasBackgroundCode)
        }

        // SVG objects with full code
        if (scene.svgObjects?.length > 0) {
          parts.push(`\n--- SVG Objects (${scene.svgObjects.length}) ---`)
          for (const obj of scene.svgObjects) {
            parts.push(`\n[${obj.id}] "${obj.prompt?.slice(0, 80)}"`)
            if (obj.svgContent) parts.push(obj.svgContent)
          }
        }

        // AI layers with full code
        if (scene.aiLayers?.length > 0) {
          parts.push(`\n--- AI Layers (${scene.aiLayers.length}) ---`)
          for (const layer of scene.aiLayers) {
            parts.push(`\n[${layer.id}] type:${layer.type} label:"${layer.label}"`)
          }
        }

        return ok(sceneId, parts.join('\n'))
      }

      // ── write_scene_code ─────────────────────────────────────────────
      // Direct code write — skips the LLM generation call that add_layer uses.
      // Creates a new scene if sceneId is omitted, or replaces code on existing scene.

      case 'write_scene_code': {
        const {
          sceneId,
          sceneCode,
          styles,
          name: sceneName,
          duration,
          bgColor,
          sceneType: requestedType,
        } = args as {
          sceneId?: string
          sceneCode: string
          styles?: string
          name?: string
          duration?: number
          bgColor?: string
          sceneType?: SceneType
        }
        if (!sceneCode?.trim()) return err('sceneCode is required')

        const type: SceneType = requestedType ?? 'react'

        if (sceneId) {
          // Update existing scene
          const scene = findScene(world, sceneId)
          if (!scene) return err(`Scene ${sceneId} not found`)

          const codeField =
            type === 'react'
              ? 'reactCode'
              : type === 'canvas2d'
                ? 'canvasCode'
                : type === 'lottie'
                  ? 'lottieSource'
                  : type === 'svg'
                    ? 'svgContent'
                    : 'sceneCode'

          const updates: Partial<Scene> = {
            sceneType: type,
            [codeField]: sceneCode,
            ...(styles ? { sceneStyles: styles } : {}),
            ...(sceneName ? { name: sceneName } : {}),
            ...(duration
              ? {
                  duration: clampSceneDuration(
                    duration,
                    // Exempt a scene that already carries a voiceover from the
                    // plan cap so we never truncate narration (only [3,30] applies).
                    scene.audioLayer?.enabled === true && (scene.audioLayer?.tts?.src?.trim().length ?? 0) > 0
                      ? undefined
                      : plannedDurationFor(world, sceneId),
                  ),
                }
              : {}),
            ...(bgColor ? { bgColor } : {}),
          }

          updateScene(world, sceneId, updates)
          emitSceneUpdate(world, sceneId, scene)
          await regenerateHTML(world, sceneId, logger)
          return ok(sceneId, `Wrote ${type} code to scene "${scene.name}" (${sceneId})`)
        }

        // Create new scene with the provided code
        const newScene: Scene = {
          id: uuidv4(),
          name: sceneName || 'Untitled Scene',
          prompt: '',
          summary: '',
          svgContent: type === 'svg' ? sceneCode : '',
          duration: clampSceneDuration(duration || 8),
          bgColor: bgColor || '#0a0c10',
          thumbnail: null,
          videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
          audioLayer: { enabled: false, src: null, volume: 1, fadeIn: false, fadeOut: false, startOffset: 0 },
          textOverlays: [],
          svgObjects: [],
          primaryObjectId: null,
          svgBranches: [],
          activeBranchId: null,
          transition: 'none',
          usage: null,
          sceneType: type,
          canvasCode: type === 'canvas2d' ? sceneCode : '',
          canvasBackgroundCode: '',
          sceneCode: !['react', 'canvas2d', 'svg', 'lottie'].includes(type) ? sceneCode : '',
          reactCode: type === 'react' ? sceneCode : '',
          sceneHTML: '',
          sceneStyles: styles || '',
          lottieSource: type === 'lottie' ? sceneCode : '',
          d3Data: null,
          chartLayers: [],
          interactions: [],
          variables: [],
          aiLayers: [],
          messages: [],
          styleOverride: {},
          cameraMotion: null,
          worldConfig: null,
        }

        const insertedIndex = world.scenes.length
        world.scenes.push(newScene)
        emitAgentAction(
          {
            type: 'scene/create',
            params: { sceneId: newScene.id, position: insertedIndex, scene: newScene },
          },
          emitterDeps(world),
        )
        await regenerateHTML(world, newScene.id, logger)
        return {
          success: true,
          affectedSceneId: newScene.id,
          changes: [
            {
              type: 'scene_created',
              sceneId: newScene.id,
              description: `Created scene "${newScene.name}" with ${type} code (${newScene.id})`,
            },
          ],
        }
      }

      default:
        return err(`Unknown layer tool: ${toolName}`)
    }
  }
}
