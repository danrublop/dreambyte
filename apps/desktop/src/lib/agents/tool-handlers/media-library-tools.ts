/**
 * Media-library agent tools.
 *
 * These five tools lift the agent from a "generate-on-every-request" model to a
 * "library-aware" model:
 *
 *   1. query_media_library        — search existing ProjectAssets before generating
 *   2. reuse_asset                — place an existing asset into a scene by id
 *   3. regenerate_asset           — retry a prior generation with overrides
 *   4. generate_image_from_reference — i2i flow with a reference ProjectAsset
 *   5. generate_variation         — sibling variation of an existing generated asset
 *
 * All successful generations land in projectAssets via persistGeneratedAsset
 * so subsequent runs can see them. Cost permission flows mirror the existing
 * generate_image path (checkApiPermission + enrichPermission).
 */

import { v4 as uuidv4 } from 'uuid'
import { and, eq, desc, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { projectAssets } from '@/lib/db/schema'
import type { AILayer, APIName, AssetType, ImageLayer, ImageModel } from '@/lib/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { ok, err, findScene, updateScene, degradeIfHtmlUnwritten, commitMediaSpend, type ToolResult } from './_shared'
import { persistGeneratedAsset } from '@/lib/media/provenance'
import { enrichPrompt } from '@/lib/media/prompt-enhancer'
import { routeMediaIntent } from '@/lib/media/router'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'
import { hexPresentIn, isHex, phraseMatches } from '@/lib/agents/services/style-tokens'

/**
 * P1b-fanout-remaining (media-library): emit `layer/add` for reused asset
 * insertion.
 */

export const MEDIA_LIBRARY_EXT_TOOL_NAMES = [
  'media_library',
  'character',
  // NOTE: regenerate_asset and generate_image_from_reference are deliberately NOT
  // registered names any more. The model reaches both as
  // generate_image(source:'regenerate'|'reference') and the executor calls this handler
  // DIRECTLY for those two sources (same deps, different file) — so each keeps its own
  // permission gate, enrichPermission payload and provenance/lineage writes unchanged,
  // while the retired names stay unroutable.
  // Internal-only: NOT in MEDIA_LIBRARY_TOOLS (no schema) so it's never offered to the
  // model, but it MUST stay registered — landResearchMedia auto-places staged research
  // images by id via executeTool('reuse_asset', …). place_image can't replace it (that
  // needs a url + explicit geometry; reuse_asset places an asset by id and self-lays-out).
  'reuse_asset',
] as const

export function createMediaLibraryExtHandler(deps: {
  checkMediaEnabled: (world: WorldStateMutable, providerId: string, label: string) => ToolResult | null
  checkApiPermission: (
    world: WorldStateMutable,
    api: APIName,
    context?: {
      reason?: string
      details?: { prompt?: string; duration?: number; model?: string; resolution?: string }
    },
  ) => ToolResult | null | Promise<ToolResult | null>
  enrichPermission: (
    result: ToolResult,
    context: {
      generationType: import('@/lib/types').GenerationType
      prompt?: string
      provider?: string
      availableProviders?: import('@/lib/types').GenerationProviderOption[]
      config?: Record<string, any>
      toolArgs?: Record<string, any>
    },
  ) => ToolResult
  regenerateHTML: (
    world: WorldStateMutable,
    sceneId: string,
    logger?: import('@/lib/agents/logger').AgentLogger,
  ) => Promise<{ htmlWritten: boolean; error?: string }>
}) {
  return async function handleMediaLibraryExtTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: import('@/lib/agents/logger').AgentLogger,
  ): Promise<ToolResult> {
    // media_library merges query/tag/import via an action discriminator; the rich
    // per-op case bodies below are unchanged. generate_variation was dropped entirely
    // (regenerate_asset covers it). reuse_asset was dropped from the MODEL surface but
    // stays registered + reachable — the internal auto-placer (landResearchMedia) calls
    // it by name; place_image can't stand in (url + geometry, not by-id self-layout).
    let op = toolName
    if (toolName === 'media_library') {
      const a = (args as { action?: string }).action
      op = a === 'tag' ? 'tag_asset' : a === 'import' ? 'upload_media_from_url' : 'query_media_library'
    } else if (toolName === 'character') {
      op = (args as { action?: string }).action === 'render' ? 'reuse_character' : 'create_character'
    } else if (toolName === 'generate_image') {
      // Only the reference / regenerate sources are routed here (see tool-executor);
      // source:'prompt' never reaches this handler.
      const a = args as { source?: string; referenceAssetId?: unknown; assetId?: unknown }
      if (a.source === 'regenerate') {
        if (typeof a.assetId !== 'string' || !a.assetId)
          return err('generate_image(source:"regenerate") requires assetId')
        op = 'regenerate_asset'
      } else {
        if (typeof a.referenceAssetId !== 'string' || !a.referenceAssetId)
          return err('generate_image(source:"reference") requires referenceAssetId')
        op = 'generate_image_from_reference'
      }
    }
    switch (op) {
      case 'query_media_library':
        return await queryMediaLibrary(args, world)
      case 'reuse_asset':
        return await reuseAsset(args, world, deps, logger)
      case 'regenerate_asset':
        return await regenerateAsset(args, world, deps, logger)
      case 'generate_image_from_reference':
        return await generateImageFromReference(args, world, deps, logger)
      case 'generate_variation':
        return await generateVariation(args, world, deps, logger)
      case 'create_character':
        return await createCharacterTool(args, world, deps)
      case 'reuse_character':
        return await reuseCharacterTool(args, world, deps)
      case 'upload_media_from_url':
        return await uploadMediaFromUrl(args, world)
      case 'tag_asset':
        return await tagAsset(args, world)
      default:
        return err(`Unknown media-library tool: ${toolName}`)
    }
  }
}

// ── query_media_library ──────────────────────────────────────────────────────

async function queryMediaLibrary(args: Record<string, unknown>, world: WorldStateMutable): Promise<ToolResult> {
  const projectId = world.projectId
  if (!projectId) return err('Project id is not available in the agent world')

  const type = normalizeType(args.type)
  const source =
    args.source === 'upload' || args.source === 'generated' ? (args.source as 'upload' | 'generated') : null
  const promptMatch = typeof args.promptContains === 'string' ? (args.promptContains as string).trim() : ''
  const tag = typeof args.tag === 'string' ? (args.tag as string).trim() : ''
  const limit = clampInt(args.limit, 1, 50, 10)

  const conds = [eq(projectAssets.projectId, projectId)]
  if (type) conds.push(eq(projectAssets.type, type))
  if (source) conds.push(eq(projectAssets.source, source))
  if (promptMatch) conds.push(sql`LOWER(${projectAssets.prompt}) LIKE ${'%' + promptMatch.toLowerCase() + '%'}`)
  // SQLite has no array type; `tags` is stored as a JSON array (text mode). json_each unrolls it so we
  // can probe membership with a scalar equality.
  if (tag) conds.push(sql`exists (select 1 from json_each(${projectAssets.tags}) where value = ${tag})`)

  const rows = await db
    .select({
      id: projectAssets.id,
      name: projectAssets.name,
      type: projectAssets.type,
      source: projectAssets.source,
      publicUrl: projectAssets.publicUrl,
      thumbnailUrl: projectAssets.thumbnailUrl,
      width: projectAssets.width,
      height: projectAssets.height,
      prompt: projectAssets.prompt,
      provider: projectAssets.provider,
      model: projectAssets.model,
      tags: projectAssets.tags,
      createdAt: projectAssets.createdAt,
    })
    .from(projectAssets)
    .where(and(...conds))
    .orderBy(desc(projectAssets.createdAt))
    .limit(limit)

  return ok(null, `Found ${rows.length} asset${rows.length === 1 ? '' : 's'}`, { assets: rows, count: rows.length })
}

// ── reuse_asset ──────────────────────────────────────────────────────────────

async function reuseAsset(
  args: Record<string, unknown>,
  world: WorldStateMutable,
  deps: {
    regenerateHTML: (
      world: WorldStateMutable,
      sceneId: string,
      logger?: import('@/lib/agents/logger').AgentLogger,
    ) => Promise<{ htmlWritten: boolean; error?: string }>
  },
  logger?: import('@/lib/agents/logger').AgentLogger,
): Promise<ToolResult> {
  const { assetId, sceneId } = args as { assetId?: string; sceneId?: string }
  if (!assetId || !sceneId) return err('assetId and sceneId are required')

  const projectId = world.projectId
  if (!projectId) return err('Project id unavailable')

  const [asset] = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.id, assetId), eq(projectAssets.projectId, projectId)))
    .limit(1)

  if (!asset) return err(`Asset ${assetId} not found in project`)
  if (asset.type !== 'image' && asset.type !== 'svg') {
    return err(
      `reuse_asset currently supports image/svg assets only (asset is "${asset.type}"). Use set_media_layer(kind:'video') for video.`,
    )
  }

  const scene = findScene(world, sceneId)
  if (!scene) return err(`Scene ${sceneId} not found`)

  const { x, y, width, height, opacity, zIndex } = args as {
    x?: number
    y?: number
    width?: number
    height?: number
    opacity?: number
    zIndex?: number
  }

  const newLayer: ImageLayer = {
    id: uuidv4(),
    type: 'image',
    prompt: asset.prompt ?? `Reused asset: ${asset.name}`,
    model: (asset.model as ImageModel) ?? 'flux-schnell',
    style: null,
    imageUrl: asset.publicUrl,
    x: x ?? 960,
    y: y ?? 540,
    width: width ?? asset.width ?? 800,
    height: height ?? asset.height ?? 600,
    rotation: 0,
    opacity: opacity ?? 1,
    zIndex: zIndex ?? 10,
    status: 'ready',
    label: asset.name,
  }
  updateScene(world, sceneId, { aiLayers: [...(scene.aiLayers || []), newLayer] })
  emitAgentAction(
    {
      type: 'layer/add',
      params: { sceneId, layerId: newLayer.id, layer: newLayer as unknown as AILayer },
    },
    emitterDeps(world),
  )
  const reuseHtml = await deps.regenerateHTML(world, sceneId, logger)
  return degradeIfHtmlUnwritten(
    reuseHtml,
    ok(sceneId, `Reused asset "${asset.name}" from library`, {
      assetId,
      sceneLayerId: newLayer.id,
      publicUrl: asset.publicUrl,
    }),
  )
}

// ── regenerate_asset ─────────────────────────────────────────────────────────

async function regenerateAsset(
  args: Record<string, unknown>,
  world: WorldStateMutable,
  deps: {
    checkMediaEnabled: (world: WorldStateMutable, providerId: string, label: string) => ToolResult | null
    checkApiPermission: (
      world: WorldStateMutable,
      api: APIName,
      context?: any,
    ) => ToolResult | null | Promise<ToolResult | null>
    enrichPermission: (result: ToolResult, context: any) => ToolResult
  },
  _logger?: import('@/lib/agents/logger').AgentLogger,
): Promise<ToolResult> {
  const { assetId, promptOverride, model, enhanceTags, aspectRatio } = args as {
    assetId?: string
    promptOverride?: string
    model?: string
    enhanceTags?: string[]
    aspectRatio?: string
  }
  if (!assetId) return err('assetId is required')

  const projectId = world.projectId
  if (!projectId) return err('Project id unavailable')

  const [parent] = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.id, assetId), eq(projectAssets.projectId, projectId)))
    .limit(1)
  if (!parent) return err(`Asset ${assetId} not found`)
  if (parent.type !== 'image') return err(`generate_image(source:"regenerate") currently supports images only`)

  // Resolve the request ONCE, before the sandbox fork, so the placeholder + the
  // captured request reflect the FINAL enriched prompt the real provider would get —
  // not the raw arg (the early-short-circuit defect this fixes).
  const basePrompt = promptOverride?.trim() || parent.prompt || parent.name || (world.sandboxMode ? 'asset' : '')
  const chosenModel: string = model ?? parent.model ?? 'flux-schnell'
  const chosenAR = aspectRatio ?? deriveAspectFromDims(parent.width, parent.height) ?? '1:1'
  const chosenTags = enhanceTags ?? parent.enhanceTags ?? []
  const finalPrompt = enrichPrompt(basePrompt, chosenTags, chosenModel)

  // Sandbox: produce a tagged placeholder sibling, no paid provider call.
  if (world.sandboxMode) {
    const { sandboxImageAsset, SANDBOX_ASSET_TAG } = await import('@/lib/agents/asset-gateway')
    const ph = await sandboxImageAsset({
      prompt: `[regen] ${finalPrompt}`,
      width: parent.width ?? 1024,
      height: parent.height ?? 1024,
    })
    const persisted = await persistGeneratedAsset({
      projectId,
      sourceUrl: ph.imageUrl,
      type: 'image',
      name: `${parent.name} — sandbox`,
      tags: [SANDBOX_ASSET_TAG],
      width: ph.width,
      height: ph.height,
      metadata: {
        prompt: finalPrompt,
        provider: 'imageGen',
        model: chosenModel,
        costCents: 0,
        parentAssetId: parent.id,
        referenceAssetIds: parent.referenceAssetIds ?? null,
        enhanceTags: [SANDBOX_ASSET_TAG],
      },
    })
    return ok(
      null,
      `Sandbox: placeholder regenerated asset (parent ${parent.id.slice(0, 6)}…) → ${persisted.id} ($0)`,
      {
        assetId: persisted.id,
        parentAssetId: parent.id,
        publicUrl: persisted.publicUrl,
        isPlaceholder: true,
        sandboxRequest: {
          tool: 'regenerate_asset',
          provider: 'imageGen',
          model: chosenModel,
          prompt: finalPrompt,
          params: { aspectRatio: chosenAR, enhanceTags: chosenTags, parentAssetId: parent.id },
        },
      },
    )
  }

  const mediaErr = deps.checkMediaEnabled(world, 'imageGen', 'AI Image Generation')
  if (mediaErr) return mediaErr

  if (!basePrompt) return err('Parent asset has no prompt to regenerate from — pass promptOverride')

  const blocked = await deps.checkApiPermission(world, 'imageGen', {
    reason: 'Regenerate AI image',
    details: { prompt: basePrompt, model: chosenModel },
  })
  if (blocked) {
    return deps.enrichPermission(blocked, {
      generationType: 'image',
      prompt: basePrompt,
      provider: chosenModel,
      config: { aspectRatio: chosenAR, enhanceTags: chosenTags, parentAssetId: parent.id },
      toolArgs: args,
    })
  }

  try {
    const { generateImage } = await import('@/lib/apis/image-gen')
    const result = await generateImage({
      prompt: finalPrompt,
      model: chosenModel,
      aspectRatio: chosenAR,
      style: null,
      skipCache: true, // regenerations must produce a fresh sibling
    })
    // Commit the paid spend — regenerate uses skipCache:true so EVERY call re-bills the
    // provider; the cap must see each one (the handler called generateImage directly, bypassing
    // the service that bills). result.cost is the actual provider cost.
    await commitMediaSpend(
      world,
      'imageGen',
      result.cost ?? 0,
      `regenerate ${chosenModel}: ${finalPrompt.slice(0, 80)}`,
    )
    const persisted = await persistGeneratedAsset({
      projectId,
      sourceUrl: result.imageUrl,
      type: 'image',
      name: `${parent.name} — retry`,
      tags: parent.tags ?? [],
      width: result.width,
      height: result.height,
      metadata: {
        prompt: finalPrompt,
        provider: 'imageGen',
        model: chosenModel,
        costCents: Math.round((result.cost ?? 0) * 100),
        parentAssetId: parent.id,
        referenceAssetIds: parent.referenceAssetIds ?? null,
        enhanceTags: chosenTags,
      },
    })
    return ok(null, `Regenerated asset (parent ${parent.id.slice(0, 6)}…) → ${persisted.id}`, {
      assetId: persisted.id,
      parentAssetId: parent.id,
      publicUrl: persisted.publicUrl,
      prompt: finalPrompt,
      cost: result.cost,
    })
  } catch (e: any) {
    return err(`Regeneration failed: ${e.message}`)
  }
}

// ── generate_image_from_reference (i2i) ──────────────────────────────────────

/**
 * Build a "match this reference style" clause from the most-recently-analyzed
 * reference's style tokens, INCLUDING ONLY the signals the agent's prompt does
 * not already mention (silent-user fallback; explicit prompt always wins).
 * Returns '' when there's no applicable token. Exported for unit tests.
 */
export function buildReferenceStyleClause(
  prompt: string,
  tokens: import('@/lib/agents/services/style-tokens').StyleTokens | undefined,
): string {
  if (!tokens) return ''
  const lower = prompt.toLowerCase()
  const parts: string[] = []
  // Descriptor phrases match on a WORD BOUNDARY so `soft light` isn't treated as
  // already-present when the prompt only says `soft lightbox`.
  const addIfAbsent = (value: string | undefined, render: (v: string) => string) => {
    if (!value || !value.trim()) return
    if (phraseMatches(lower, value)) return // prompt already says it → don't override
    parts.push(render(value))
  }
  // Palette: only the hexes the prompt hasn't already named. Hexes are compared
  // canonically (`#fff` == `#ffffff`) and matched as whole hex tokens so a short
  // hex isn't falsely "found" inside an unrelated longer one.
  if (tokens.palette?.length) {
    const fresh = tokens.palette.filter((c) => (isHex(c) ? !hexPresentIn(lower, c) : !phraseMatches(lower, c)))
    if (fresh.length) parts.push(`color palette ${fresh.join(', ')}`)
  }
  addIfAbsent(tokens.mood, (v) => `${v} mood`)
  addIfAbsent(tokens.lighting, (v) => v)
  addIfAbsent(tokens.composition, (v) => v)
  if (tokens.fonts?.length) {
    const fresh = tokens.fonts.filter((f) => !phraseMatches(lower, f))
    if (fresh.length) parts.push(`typography ${fresh.join(', ')}`)
  }
  return parts.length ? `Match this reference style: ${parts.join('; ')}.` : ''
}

async function generateImageFromReference(
  args: Record<string, unknown>,
  world: WorldStateMutable,
  deps: {
    checkMediaEnabled: (world: WorldStateMutable, providerId: string, label: string) => ToolResult | null
    checkApiPermission: (
      world: WorldStateMutable,
      api: APIName,
      context?: any,
    ) => ToolResult | null | Promise<ToolResult | null>
    enrichPermission: (result: ToolResult, context: any) => ToolResult
  },
  _logger?: import('@/lib/agents/logger').AgentLogger,
): Promise<ToolResult> {
  const { referenceAssetId, prompt, model, aspectRatio, enhanceTags } = args as {
    referenceAssetId?: string
    prompt?: string
    model?: string
    aspectRatio?: string
    enhanceTags?: string[]
  }
  if (!referenceAssetId || !prompt) return err('referenceAssetId and prompt are required')

  const projectId = world.projectId
  if (!projectId) return err('Project id unavailable')

  const [ref] = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.id, referenceAssetId), eq(projectAssets.projectId, projectId)))
    .limit(1)
  if (!ref) return err(`Reference asset ${referenceAssetId} not found`)
  if (ref.type !== 'image' && ref.type !== 'svg') {
    return err('Reference asset must be an image or SVG')
  }

  // Reference-style enrichment + CONSUME-ONCE clear happen in BOTH modes — before
  // the sandbox fork — so (a) the analyzed-reference token can't leak into a later
  // unrelated generation even on a sandbox run (the early-fork leak this fixes), and
  // (b) the sandbox capture reflects the real style-enriched prompt. See the real
  // path below for the rationale on each step.
  const styleClause = buildReferenceStyleClause(prompt, world.referenceStyleTokens)
  world.referenceStyleTokens = undefined
  const promptWithStyle = styleClause ? `${prompt} ${styleClause}` : prompt

  // Sandbox: tagged placeholder, no paid image-to-image call.
  if (world.sandboxMode) {
    // No configured provider in sandbox, so we can't route for the real modelId;
    // enrich against the requested/default model for a faithful review prompt.
    const captureModel = (model as string) ?? 'flux-schnell'
    const finalPrompt = enrichPrompt(promptWithStyle, enhanceTags ?? [], captureModel)
    const { sandboxImageAsset, SANDBOX_ASSET_TAG } = await import('@/lib/agents/asset-gateway')
    const ph = await sandboxImageAsset({
      prompt: `[i2i] ${finalPrompt}`,
      width: ref.width ?? 1024,
      height: ref.height ?? 1024,
    })
    const persisted = await persistGeneratedAsset({
      projectId,
      sourceUrl: ph.imageUrl,
      type: 'image',
      name: `i2i: ${prompt.slice(0, 40)}`,
      tags: [SANDBOX_ASSET_TAG],
      width: ph.width,
      height: ph.height,
      metadata: {
        prompt: finalPrompt,
        provider: 'imageGen',
        model: captureModel,
        costCents: 0,
        parentAssetId: null,
        referenceAssetIds: [referenceAssetId],
        enhanceTags: [SANDBOX_ASSET_TAG],
      },
    })
    return ok(null, `Sandbox: placeholder image-to-image → ${persisted.id} ($0)`, {
      assetId: persisted.id,
      publicUrl: persisted.publicUrl,
      isPlaceholder: true,
      sandboxRequest: {
        tool: 'generate_image_from_reference',
        provider: 'imageGen',
        model: captureModel,
        prompt: finalPrompt,
        params: { aspectRatio, enhanceTags: enhanceTags ?? [], referenceAssetId, styleApplied: !!styleClause },
      },
    })
  }

  const mediaErr = deps.checkMediaEnabled(world, 'imageGen', 'AI Image Generation')
  if (mediaErr) return mediaErr

  const route = routeMediaIntent({
    enabledMap: world.mediaGenEnabled ?? null,
    intent: 'i2i',
    preferModel: model ?? null,
    referenceImageUrl: ref.publicUrl,
  })
  if (route.providerId == null) {
    return err(`No provider available for image-to-image: ${route.reason}`)
  }

  const blocked = await deps.checkApiPermission(world, 'imageGen', {
    reason: 'Generate image from reference',
    details: { prompt, model: route.modelId },
  })
  if (blocked) {
    return deps.enrichPermission(blocked, {
      generationType: 'image',
      prompt,
      provider: route.providerId,
      config: { aspectRatio, enhanceTags, referenceAssetId },
      toolArgs: args,
    })
  }

  // Real i2i conditions on the reference via image_url (generateImage uploads it),
  // so we no longer inject the file path into the prompt as a pseudo-"hint". The
  // reference-style enrichment + consume-once clear ran above the sandbox fork
  // (promptWithStyle) so both paths share one source of truth; here we just enrich
  // for the ROUTED model.
  const finalPrompt = enrichPrompt(promptWithStyle, enhanceTags ?? [], route.modelId)

  try {
    const { generateImage } = await import('@/lib/apis/image-gen')
    const result = await generateImage({
      prompt: finalPrompt,
      model: route.modelId,
      aspectRatio: aspectRatio ?? deriveAspectFromDims(ref.width, ref.height) ?? '1:1',
      referenceImageUrl: ref.publicUrl,
    })
    // Commit the paid i2i spend so the per-project cap accumulates (the handler called
    // generateImage directly; the IPC i2i service bills, this agent path did not).
    await commitMediaSpend(world, 'imageGen', result.cost ?? 0, `i2i ${route.modelId}: ${finalPrompt.slice(0, 80)}`)
    const persisted = await persistGeneratedAsset({
      projectId,
      sourceUrl: result.imageUrl,
      type: 'image',
      name: `from ${ref.name}`,
      metadata: {
        prompt: finalPrompt,
        provider: route.providerId,
        model: route.modelId,
        costCents: Math.round((result.cost ?? 0) * 100),
        parentAssetId: null,
        referenceAssetIds: [ref.id],
        enhanceTags: enhanceTags ?? null,
      },
    })
    return ok(null, `Generated image from reference ${ref.id.slice(0, 6)}…`, {
      assetId: persisted.id,
      publicUrl: persisted.publicUrl,
      referenceAssetId: ref.id,
      prompt: finalPrompt,
      cost: result.cost,
    })
  } catch (e: any) {
    return err(`i2i generation failed: ${e.message}`)
  }
}

// ── generate_variation ───────────────────────────────────────────────────────

// ── create_character / reuse_character ───────────────

type GenDeps = {
  checkMediaEnabled: (world: WorldStateMutable, providerId: string, label: string) => ToolResult | null
  checkApiPermission: (
    world: WorldStateMutable,
    api: APIName,
    context?: any,
  ) => ToolResult | null | Promise<ToolResult | null>
  enrichPermission: (result: ToolResult, context: any) => ToolResult
}

async function createCharacterTool(
  args: Record<string, unknown>,
  world: WorldStateMutable,
  deps: GenDeps,
): Promise<ToolResult> {
  const projectId = world.projectId
  if (!projectId) return err('Project id unavailable')
  const { name, description, prompt, referenceAssetId, model, seed, aspectRatio } = args as {
    name?: string
    description?: string
    prompt?: string
    referenceAssetId?: string
    model?: string
    seed?: number
    aspectRatio?: string
  }
  if (!name || !name.trim()) return err('name is required')

  const { createCharacter } = await import('@/lib/services/characters')

  // A character only costs money when we generate a first portrait from a prompt. In sandbox,
  // or when adopting an existing asset / name-only, no paid call happens — create the bundle
  // directly. The first reuse_character will adopt its result as the reference if none exists.
  const willGenerate = !world.sandboxMode && !referenceAssetId && !!(prompt && prompt.trim())
  if (willGenerate) {
    const mediaErr = deps.checkMediaEnabled(world, 'imageGen', 'AI Image Generation')
    if (mediaErr) return mediaErr
    const blocked = await deps.checkApiPermission(world, 'imageGen', {
      reason: `Generate reference portrait for character "${name}"`,
      details: { prompt: prompt as string, model: model ?? 'flux-1.1-pro' },
    })
    if (blocked) {
      return deps.enrichPermission(blocked, {
        generationType: 'image',
        prompt: prompt as string,
        provider: 'imageGen',
        config: { aspectRatio },
        toolArgs: args,
      })
    }
  }

  try {
    const { character, cost } = await createCharacter({
      projectId,
      name: name.trim(),
      description: description ?? null,
      seed: typeof seed === 'number' ? seed : null,
      model: model ?? null,
      referenceAssetId: referenceAssetId ?? null,
      // Skip the paid portrait in sandbox; the bundle still gets created (seed pinned).
      prompt: world.sandboxMode ? null : (prompt ?? null),
      aspectRatio,
      // Honour the user's provider toggles when routing the portrait (no disabled-provider use).
      mediaGenEnabled: world.mediaGenEnabled ?? null,
    })
    return ok(null, `Created character "${character.name}" (seed ${character.seed})`, {
      characterId: character.id,
      name: character.name,
      seed: character.seed,
      referenceAssetIds: character.referenceAssetIds,
      cost,
    })
  } catch (e: any) {
    return err(`create_character failed: ${e?.message ?? String(e)}`)
  }
}

async function reuseCharacterTool(
  args: Record<string, unknown>,
  world: WorldStateMutable,
  deps: GenDeps,
): Promise<ToolResult> {
  const projectId = world.projectId
  if (!projectId) return err('Project id unavailable')
  const { character, prompt, negativePrompt, aspectRatio } = args as {
    character?: string
    prompt?: string
    negativePrompt?: string
    aspectRatio?: string
  }
  if (!character || !prompt) return err('character and prompt are required')

  const { resolveCharacter } = await import('@/lib/db/queries/characters')
  const found = await resolveCharacter(projectId, character)
  if (!found) return err(`Character not found: ${character}`)

  // Sandbox: tagged placeholder, no paid i2i call. Adopt it as the reference if the
  // character has none yet so a later real run has something to condition on.
  if (world.sandboxMode) {
    const { sandboxImageAsset, SANDBOX_ASSET_TAG } = await import('@/lib/agents/asset-gateway')
    const ph = await sandboxImageAsset({ prompt: `[character ${found.name}] ${prompt}`, width: 1024, height: 1024 })
    const persisted = await persistGeneratedAsset({
      projectId,
      sourceUrl: ph.imageUrl,
      type: 'image',
      name: `${found.name}: ${prompt.slice(0, 40)}`,
      tags: [SANDBOX_ASSET_TAG],
      width: ph.width,
      height: ph.height,
      metadata: {
        prompt,
        provider: 'imageGen',
        model: 'sandbox',
        costCents: 0,
        parentAssetId: found.referenceAssetIds[0] ?? null,
        referenceAssetIds: found.referenceAssetIds.length ? found.referenceAssetIds : null,
        enhanceTags: [SANDBOX_ASSET_TAG],
      },
    })
    if (!found.referenceAssetIds.length) {
      const { setCharacterReferences } = await import('@/lib/db/queries/characters')
      await setCharacterReferences(projectId, found.id, [persisted.id])
    }
    return ok(null, `Sandbox: placeholder render of "${found.name}" → ${persisted.id} ($0)`, {
      assetId: persisted.id,
      publicUrl: persisted.publicUrl,
      characterId: found.id,
      isPlaceholder: true,
      sandboxRequest: {
        tool: 'reuse_character',
        provider: 'imageGen',
        prompt,
        params: {
          character: found.name,
          negativePrompt: negativePrompt ?? null,
          aspectRatio: aspectRatio ?? '1:1',
          referenceAssetIds: found.referenceAssetIds,
        },
        note: 'character reference-conditioned; the character service enriches the final prompt at generation time',
      },
    })
  }

  const mediaErr = deps.checkMediaEnabled(world, 'imageGen', 'AI Image Generation')
  if (mediaErr) return mediaErr
  // Resolve the model the same way the service will, so the permission detail is accurate.
  const primaryRefId = found.referenceAssetIds[0]
  let refUrl: string | null = null
  if (primaryRefId) {
    const [ref] = await db
      .select()
      .from(projectAssets)
      .where(and(eq(projectAssets.id, primaryRefId), eq(projectAssets.projectId, projectId)))
      .limit(1)
    refUrl = ref?.publicUrl ?? null
  }
  const route = routeMediaIntent({
    enabledMap: world.mediaGenEnabled ?? null,
    intent: refUrl ? 'i2i' : 't2i',
    preferModel: found.model ?? null,
    referenceImageUrl: refUrl,
  })
  if (route.providerId == null) return err(`No provider available to render character: ${route.reason}`)
  const blocked = await deps.checkApiPermission(world, 'imageGen', {
    reason: `Render character "${found.name}"`,
    details: { prompt, model: route.modelId },
  })
  if (blocked) {
    return deps.enrichPermission(blocked, {
      generationType: 'image',
      prompt,
      provider: route.providerId,
      config: { aspectRatio, character: found.name },
      toolArgs: args,
    })
  }

  try {
    const { reuseCharacter } = await import('@/lib/services/characters')
    const result = await reuseCharacter({
      projectId,
      character: found.id,
      prompt,
      negativePrompt,
      aspectRatio,
      // Same enabled-map the handler routed/gated with, so the service can't pick a different
      // or disabled provider than the one the user was prompted to approve.
      mediaGenEnabled: world.mediaGenEnabled ?? null,
      // This handler already ran checkApiPermission + enrichPermission above — skip the service's
      // own gate so we don't double-gate the agent path.
      skipPermissionGate: true,
    })
    // Unreachable with skipPermissionGate:true (the gate that surfaces permissionNeeded is bypassed),
    // but narrow the union defensively so a future change can't silently drop the asset path.
    if ('permissionNeeded' in result) return err('reuse_character: unexpected permission prompt on the agent path')
    return ok(null, `Rendered "${found.name}" in a new scene`, {
      assetId: result.asset.id,
      publicUrl: result.asset.publicUrl,
      characterId: result.characterId,
      prompt: result.finalPrompt,
      cost: result.cost,
    })
  } catch (e: any) {
    return err(`reuse_character failed: ${e?.message ?? String(e)}`)
  }
}

async function generateVariation(
  args: Record<string, unknown>,
  world: WorldStateMutable,
  deps: {
    checkMediaEnabled: (world: WorldStateMutable, providerId: string, label: string) => ToolResult | null
    checkApiPermission: (
      world: WorldStateMutable,
      api: APIName,
      context?: any,
    ) => ToolResult | null | Promise<ToolResult | null>
    enrichPermission: (result: ToolResult, context: any) => ToolResult
  },
  _logger?: import('@/lib/agents/logger').AgentLogger,
): Promise<ToolResult> {
  // A variation is a regenerate with a fresh seed — we expose it as a separate tool
  // so the agent can pick the right verb ("make another version" vs "redo because it was bad").
  return await regenerateAsset({ ...args, promptOverride: (args as any).promptOverride ?? null }, world, deps)
}

// ── upload_media_from_url ────────────────────────────────────────────────────

async function uploadMediaFromUrl(args: Record<string, unknown>, world: WorldStateMutable): Promise<ToolResult> {
  const { url, name, tags } = args as { url?: string; name?: string; tags?: string[] }
  const projectId = world.projectId
  if (!projectId) return err('Project id is not available in the agent world')
  if (!url || typeof url !== 'string') return err('url is required')
  try {
    new URL(url)
  } catch {
    return err(`Invalid URL: ${url}`)
  }

  try {
    const { ingestDirect } = await import('@/lib/services/ingest')
    const data = await ingestDirect({ url, projectId, name, tags })
    const asset = data.asset
    const summary = data.deduped
      ? `Deduped — "${asset.name}" already in library (contentHash: ${data.contentHash.slice(0, 8)}…)`
      : `Ingested ${asset.type} "${asset.name}" → asset ${asset.id}`
    return ok(null, summary, data)
  } catch (e) {
    return err(`Media ingest failed: ${(e as Error)?.message ?? String(e)}`)
  }
}

// ── tag_asset ────────────────────────────────────────────────────────────────

async function tagAsset(args: Record<string, unknown>, world: WorldStateMutable): Promise<ToolResult> {
  const { assetId, tags, mode } = args as {
    assetId?: string
    tags?: string[]
    mode?: 'replace' | 'append'
  }
  const projectId = world.projectId
  if (!projectId) return err('Project id is not available in the agent world')
  if (!assetId) return err('assetId is required')
  if (!Array.isArray(tags)) return err('tags must be an array of strings')
  const cleanTags = tags
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim())
    .slice(0, 30)
  const effectiveMode = mode === 'append' ? 'append' : 'replace'

  const [asset] = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.id, assetId), eq(projectAssets.projectId, projectId)))
    .limit(1)
  if (!asset) return err(`Asset ${assetId} not found`)

  const existing = asset.tags ?? []
  const nextTags = effectiveMode === 'replace' ? cleanTags : Array.from(new Set([...existing, ...cleanTags]))

  const [updated] = await db
    .update(projectAssets)
    .set({ tags: nextTags })
    .where(eq(projectAssets.id, assetId))
    .returning()

  return ok(
    null,
    `${effectiveMode === 'replace' ? 'Replaced' : 'Appended'} tags on "${updated.name}" — now [${nextTags.join(', ')}]`,
    {
      assetId,
      tags: nextTags,
      previousTags: existing,
    },
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normalizeType(raw: unknown): AssetType | null {
  if (raw === 'image' || raw === 'video' || raw === 'svg' || raw === 'avatar' || raw === 'audio') return raw
  return null
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function deriveAspectFromDims(w: number | null, h: number | null): string | null {
  if (!w || !h) return null
  const ratio = w / h
  if (ratio > 1.5) return '16:9'
  if (ratio < 0.7) return '9:16'
  if (ratio > 1.1) return '4:3'
  if (ratio < 0.9) return '3:4'
  return '1:1'
}
