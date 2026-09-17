import { v4 as uuidv4 } from 'uuid'
import type { AILayer, APIName, ImageLayer } from '@/lib/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import {
  ok,
  err,
  findScene,
  updateScene,
  insertImageLayer,
  degradeIfHtmlUnwritten,
  commitMediaSpend,
  type ToolResult,
} from './_shared'
import { resolveProjectDimensions } from '@/lib/dimensions'
import { estimateApiCostUsd } from '@/lib/permissions'
import { computeVeo3FullFrameDims, veo3DimsAreFalsy, VEO3_ANCHOR_VERSION } from '@/lib/media/veo3-geometry'
import { persistGeneratedAsset } from '@/lib/media/provenance'
import { resolveOpticsPreset } from '@/lib/media/optics'
import { createLogger } from '@/lib/logger'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'

/**
 * P1b-fanout-image-video: emit `layer/add` from `place_image` so the
 * action_log captures the AI image layer insertion. Best-effort.
 */

const log = createLogger('agent.image-video')

export const IMAGE_VIDEO_TOOL_NAMES = [
  'place_image',
  'generate_image',
  'generate_veo3_video',
  // get_video_status is reached as get_status(kind:'video') — routed in tool-executor.
] as const

export function createImageVideoToolHandler(deps: {
  checkMediaEnabled: (world: WorldStateMutable, providerId: string, label: string) => ToolResult | null
  checkApiPermission: (
    world: WorldStateMutable,
    api: APIName,
    context?: {
      reason?: string
      details?: { prompt?: string; duration?: number; model?: string; resolution?: string; upscaleFactor?: number }
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
  return async function handleImageVideoTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: import('@/lib/agents/logger').AgentLogger,
  ): Promise<ToolResult> {
    // generate_image(mode:'sticker') routes to the sticker case (a transparent-PNG
    // preset); the case body is unchanged. Direct generate_sticker calls (tests)
    // still resolve via the same case.
    const op =
      toolName === 'generate_image' && (args as { mode?: string }).mode === 'sticker' ? 'generate_sticker' : toolName
    switch (op) {
      case 'place_image': {
        const { sceneId, imageUrl, x, y, width, height, opacity, zIndex, assetId, prompt, model, style } = args as {
          sceneId: string
          imageUrl: string
          x: number
          y: number
          width: number
          height: number
          opacity?: number
          zIndex?: number
          /** Live link to the ProjectAsset this image came from. */
          assetId?: string
          /** Provenance fields — usually forwarded from generate_image's result. */
          prompt?: string
          model?: string
          style?: string
        }
        // place_image inserts an EXISTING url as a layer — it calls no provider
        // and costs $0. Skip the imageGen gate in Sandbox, where the fail-closed
        // block (tool-executor) would otherwise hard-error this free op and block
        // placing a sandbox placeholder the agent just produced.
        if (!world.sandboxMode) {
          const permErr = await deps.checkApiPermission(world, 'imageGen', {
            reason: 'Place generated image in scene',
            details: { prompt: imageUrl },
          })
          if (permErr) return permErr
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        // `assetId` is decoupled from `imageUrl` — a stale/foreign id would
        // silently corrupt the parentAssetId provenance chain. Validate it
        // against THIS project's asset library; if it doesn't resolve, drop it
        // to null and omit the provenance snapshot rather than persisting a
        // bogus link. Only the link is dropped — the image still gets placed.
        let resolvedAssetId: string | null = null
        if (assetId) {
          if (!world.projectId) {
            log.warn('place_image: assetId given but no projectId in world — dropping link', {
              extra: { assetId },
            })
          } else {
            const { db } = await import('@/lib/db')
            const { projectAssets } = await import('@/lib/db/schema')
            const { and, eq } = await import('drizzle-orm')
            const [asset] = await db
              .select({ id: projectAssets.id })
              .from(projectAssets)
              .where(and(eq(projectAssets.id, assetId), eq(projectAssets.projectId, world.projectId)))
              .limit(1)
            if (asset) {
              resolvedAssetId = asset.id
            } else {
              log.warn('place_image: assetId did not resolve in project — dropping provenance link', {
                extra: { assetId, projectId: world.projectId },
              })
            }
          }
        }

        // Shape validation: place_image places an EXISTING url/asset and
        // calls no provider, so a garbage/empty/404-shaped imageUrl would sail
        // through and report success — the layer renders broken in the demo.
        // Reject SYNCHRONOUSLY (no network HEAD — keep it fast) when there's no
        // resolved asset AND imageUrl isn't an http(s)/data/blob/root-relative
        // URL, so the model re-fetches or picks a real asset.
        if (!resolvedAssetId && !/^(https?:|data:|blob:|\/)/.test(imageUrl ?? '')) {
          return err(
            `place_image: imageUrl must be an http(s)/data/blob URL or a project asset id; got: ${
              imageUrl ? String(imageUrl) : '(empty)'
            }`,
          )
        }

        const newLayer = {
          id: uuidv4(),
          type: 'image' as const,
          prompt: prompt ?? `Placed image: ${imageUrl}`,
          model: ((model as ImageLayer['model']) ?? 'flux-1.1-pro') as ImageLayer['model'],
          style: (style as ImageLayer['style']) ?? null,
          imageUrl,
          x,
          y,
          width,
          height,
          rotation: 0,
          opacity: opacity ?? 1,
          zIndex: zIndex ?? 1,
          status: 'ready' as const,
          label: 'Placed Image',
          // Carry the asset link + provenance snapshot so the layer is
          // regenerable in place and traceable back to the media library.
          // Provenance is only attached when the asset link actually resolves
          // — a snapshot that references a non-existent asset is worse than
          // no snapshot.
          assetId: resolvedAssetId,
          provenance: resolvedAssetId
            ? {
                prompt: prompt ?? null,
                provider: 'imageGen',
                model: (model as string) ?? null,
                style: (style as string) ?? null,
                referenceAssetIds: null,
                generatedAt: new Date().toISOString(),
              }
            : null,
        }
        updateScene(world, sceneId, { aiLayers: [...(scene.aiLayers || []), newLayer] })
        emitAgentAction(
          {
            type: 'layer/add',
            params: { sceneId, layerId: newLayer.id, layer: newLayer as unknown as AILayer },
          },
          emitterDeps(world),
        )
        const placeHtml = await deps.regenerateHTML(world, sceneId, logger)
        return degradeIfHtmlUnwritten(placeHtml, ok(sceneId, `Placed image from ${imageUrl}`))
      }

      case 'generate_image': {
        const { sceneId, prompt, model, aspectRatio, style, removeBackground } = args as Record<string, any>
        // Sandbox skips media/permission gates entirely (no provider call → no spend).
        if (!world.sandboxMode) {
          const mediaErr = deps.checkMediaEnabled(world, 'imageGen', 'AI Image Generation')
          if (mediaErr) return mediaErr
          const blocked = await deps.checkApiPermission(world, 'imageGen', {
            reason: 'Generate AI image',
            details: { prompt: prompt as string, model: (model as string) ?? 'flux-schnell' },
          })
          if (blocked)
            return deps.enrichPermission(blocked, {
              generationType: 'image',
              prompt: prompt as string,
              provider: (model as string) ?? 'flux-schnell',
              availableProviders: [
                { id: 'flux-1.1-pro', name: 'Flux 1.1 Pro', cost: '~$0.05', isFree: false },
                { id: 'flux-schnell', name: 'Flux Schnell', cost: '~$0.003', isFree: false },
                { id: 'ideogram-v3', name: 'Ideogram V3', cost: '~$0.08', isFree: false },
                { id: 'recraft-v3', name: 'Recraft V3', cost: '~$0.04', isFree: false },
                { id: 'stable-diffusion-3', name: 'SD 3', cost: '~$0.03', isFree: false },
                { id: 'dall-e-3', name: 'OpenAI gpt-image-1', cost: '~$0.17', isFree: false },
              ],
              config: { style, aspectRatio, removeBackground },
              toolArgs: args as Record<string, any>,
            })
          // Background removal is a SEPARATE paid provider (backgroundRemoval, ~$0.01)
          // that runs after generation (~line 253). It was never gated, so a
          // removeBackground:true call billed it with NO checkApiPermission — the cost
          // ceiling (and in-app spend cap) under-counted by the removal spend. Gate +
          // reserve it upfront alongside imageGen (conservative: if the combined cost
          // would breach the ceiling we block before spending anything).
          if (removeBackground) {
            const bgBlocked = await deps.checkApiPermission(world, 'backgroundRemoval', {
              reason: 'Remove image background',
              details: {},
            })
            if (bgBlocked) return bgBlocked
          }
        }
        if (!sceneId || !prompt) return err('sceneId and prompt are required')
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)
        // Re-check abort immediately before the paid provider call. The choke-point
        // gate (tool-executor) covers pre-dispatch; a Stop landing AFTER dispatch but before
        // the bill must still skip the spend. (resolveAsset bills only in real mode.)
        if (!world.sandboxMode) {
          const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
          if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — image generation not started')
        }
        try {
          const { resolveAsset, sandboxStockImageAsset, SANDBOX_ASSET_TAG } = await import('@/lib/agents/asset-gateway')
          // Background removal is a SECOND paid provider; capture its cost so it bills separately
          // from the image gen (the gate reserved both upfront).
          let bgRemovalCost = 0
          // `real` holds the exact pre-existing generation path (behaviour-preserving).
          const result = await resolveAsset(world, {
            real: async () => {
              const { generateImage } = await import('@/lib/apis/image-gen')
              const r = await generateImage({
                prompt,
                negativePrompt: args.negativePrompt as string | undefined,
                model: model ?? 'flux-schnell',
                aspectRatio: aspectRatio ?? '1:1',
                style: style ?? null,
                // i2i / Tier 2 multi-ref / inpaint / outpaint inputs. image-gen enforces the
                // model's capability (an edit input to an incapable model throws → tool err below).
                referenceImageUrl: args.referenceImageUrl as string | undefined,
                referenceImageUrls: args.referenceImageUrls as string[] | undefined,
                maskImageUrl: args.maskImageUrl as string | undefined,
                outpaint: args.outpaint as { left?: number; right?: number; top?: number; bottom?: number } | undefined,
              })
              if (removeBackground) {
                const { removeImageBackground } = await import('@/lib/apis/background-removal')
                const bgResult = await removeImageBackground(r.imageUrl)
                r.imageUrl = bgResult.resultUrl
                bgRemovalCost = bgResult.cost ?? 0
              }
              return r
            },
            // Sandbox: free Wikimedia stock (falls back to a labelled placeholder
            // card on no-result/error) so the preview looks like a real video.
            sandbox: () => sandboxStockImageAsset({ prompt: prompt as string }),
          })
          // Commit the paid image spend so the per-project session/monthly caps accumulate
          // (the agent handler called generateImage directly, bypassing the IPC service that bills).
          // result.cost is the ACTUAL provider cost (0 in sandbox / on a cache hit → skipped). Bill
          // the image under 'imageGen' and any background removal under its own 'backgroundRemoval'.
          await commitMediaSpend(
            world,
            'imageGen',
            result.cost ?? 0,
            `imageGen ${String(model ?? 'flux-schnell')}: ${String(prompt).slice(0, 80)}`,
          )
          if (removeBackground)
            await commitMediaSpend(world, 'backgroundRemoval', bgRemovalCost, `rmbg: ${String(prompt).slice(0, 80)}`)
          // Persist to the media library so query_media_library / reuse_asset can find it later.
          let assetId: string | null = null
          if (world.projectId) {
            try {
              const persisted = await persistGeneratedAsset({
                projectId: world.projectId,
                sourceUrl: result.imageUrl,
                type: 'image',
                width: result.width,
                height: result.height,
                ...(world.sandboxMode ? { tags: [SANDBOX_ASSET_TAG] } : {}),
                metadata: {
                  prompt,
                  provider: 'imageGen',
                  model: (model as string) ?? 'flux-schnell',
                  costCents: Math.round((result.cost ?? 0) * 100),
                  parentAssetId: null,
                  referenceAssetIds: null,
                  enhanceTags: world.sandboxMode ? [SANDBOX_ASSET_TAG] : null,
                },
              })
              assetId = persisted.id
              result.imageUrl = persisted.publicUrl
            } catch (e) {
              // Non-fatal: generation succeeded; we just couldn't persist. The tool result
              // still returns the upstream URL so the agent can place it directly.
              log.warn('persist generated asset failed', { error: e })
            }
          }
          return ok(
            sceneId,
            world.sandboxMode
              ? `Sandbox placeholder image: ${prompt.slice(0, 60)}`
              : `Image generated: ${prompt.slice(0, 60)}`,
            {
              imageUrl: result.imageUrl,
              width: result.width,
              height: result.height,
              cost: result.cost,
              assetId,
              // Provenance echo so the agent can forward these to place_image,
              // giving the placed layer a regenerable provenance snapshot.
              prompt,
              model: (model as string) ?? 'flux-schnell',
              style: style ?? null,
              // Sandbox: capture the FULL would-have-been-sent request (not just the raw
              // prompt) so generation-prompt quality is reviewable (sandbox-capture).
              ...(world.sandboxMode
                ? {
                    sandboxRequest: {
                      tool: 'generate_image',
                      provider: 'imageGen',
                      model: (model as string) ?? 'flux-schnell',
                      prompt,
                      params: {
                        aspectRatio: aspectRatio ?? '1:1',
                        style: style ?? null,
                        negativePrompt: args.negativePrompt ?? null,
                        removeBackground,
                        referenceImageUrls: args.referenceImageUrls ?? args.referenceImageUrl ?? null,
                      },
                    },
                  }
                : {}),
            },
          )
        } catch (e: any) {
          return err(`Image generation failed: ${e.message}`)
        }
      }

      case 'generate_sticker': {
        const { sceneId, prompt, model, style } = args as Record<string, any>
        if (!world.sandboxMode) {
          const mediaErr = deps.checkMediaEnabled(world, 'imageGen', 'AI Image Generation')
          if (mediaErr) return mediaErr
          const blocked = await deps.checkApiPermission(world, 'imageGen', {
            reason: 'Generate AI sticker',
            details: { prompt: prompt as string, model: (model as string) ?? 'recraft-v3' },
          })
          if (blocked) return blocked
          // generate_sticker ALWAYS removes the background (~line 339) — a second paid
          // provider (backgroundRemoval, ~$0.01) that was never gated. Reserve it upfront
          // so the cost ceiling counts both sub-calls, not just the image generation.
          const bgBlocked = await deps.checkApiPermission(world, 'backgroundRemoval', {
            reason: 'Remove sticker background',
            details: {},
          })
          if (bgBlocked) return bgBlocked
        }
        if (!sceneId || !prompt) return err('sceneId and prompt are required')
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)
        // Re-check abort immediately before the paid provider call (see generate_image).
        if (!world.sandboxMode) {
          const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
          if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — sticker generation not started')
        }
        try {
          const { resolveAsset, sandboxImageAsset, SANDBOX_ASSET_TAG } = await import('@/lib/agents/asset-gateway')
          let bgRemovalCost = 0
          const result = await resolveAsset(world, {
            real: async () => {
              const { generateImage } = await import('@/lib/apis/image-gen')
              const r = await generateImage({
                prompt,
                model: model ?? 'recraft-v3',
                aspectRatio: '1:1',
                style: style ?? 'illustration',
              })
              const { removeImageBackground } = await import('@/lib/apis/background-removal')
              const bgResult = await removeImageBackground(r.imageUrl)
              bgRemovalCost = bgResult.cost ?? 0
              return { ...r, imageUrl: bgResult.resultUrl }
            },
            sandbox: () => sandboxImageAsset({ prompt: prompt as string }),
          })
          // Commit the paid sticker spend (image gen + the always-on background removal).
          // result.cost is the ACTUAL cost (0 in sandbox / cache hit → skipped).
          await commitMediaSpend(
            world,
            'imageGen',
            result.cost ?? 0,
            `sticker ${String(model ?? 'recraft-v3')}: ${String(prompt).slice(0, 80)}`,
          )
          await commitMediaSpend(
            world,
            'backgroundRemoval',
            bgRemovalCost,
            `sticker rmbg: ${String(prompt).slice(0, 80)}`,
          )
          let stickerUrl = result.imageUrl
          let assetId: string | null = null
          if (world.projectId) {
            try {
              const persisted = await persistGeneratedAsset({
                projectId: world.projectId,
                sourceUrl: result.imageUrl,
                type: 'image',
                name: `sticker: ${prompt.slice(0, 40)}`,
                tags: world.sandboxMode ? ['sticker', SANDBOX_ASSET_TAG] : ['sticker'],
                metadata: {
                  prompt,
                  provider: 'imageGen',
                  model: (model as string) ?? 'recraft-v3',
                  costCents: Math.round((result.cost ?? 0) * 100),
                  parentAssetId: null,
                  referenceAssetIds: null,
                  enhanceTags: world.sandboxMode ? [SANDBOX_ASSET_TAG] : null,
                },
              })
              assetId = persisted.id
              stickerUrl = persisted.publicUrl
            } catch (e) {
              log.warn('persist sticker failed', { error: e })
            }
          }
          return ok(
            sceneId,
            world.sandboxMode
              ? `Sandbox placeholder sticker: ${prompt.slice(0, 60)}`
              : `Sticker generated: ${prompt.slice(0, 60)}`,
            {
              imageUrl: stickerUrl,
              cost: result.cost,
              assetId,
              ...(world.sandboxMode
                ? {
                    sandboxRequest: {
                      tool: 'generate_sticker',
                      provider: 'imageGen',
                      model: (model as string) ?? 'recraft-v3',
                      prompt,
                      params: { style: style ?? 'illustration', aspectRatio: '1:1', removeBackground: true },
                    },
                  }
                : {}),
            },
          )
        } catch (e: any) {
          return err(`Sticker generation failed: ${e.message}`)
        }
      }

      case 'generate_veo3_video': {
        // Sandbox: real video gen is async (fire-and-forget + poll) and a video
        // layer forces the slow non-tier3 export path. So instead of starting an
        // operation, return a synchronous placeholder still sized to the aspect
        // ratio — $0, no poll, scene stays tier3. The agent places it as an image.
        if (world.sandboxMode) {
          const { sceneId, prompt } = args as Record<string, any>
          if (!sceneId || !prompt) return err('sceneId and prompt are required')
          const scene = findScene(world, sceneId)
          if (!scene) return err(`Scene not found: ${sceneId}`)
          const ar = (args.aspectRatio as string) ?? '16:9'
          const [w, h] = ar === '9:16' ? [576, 1024] : ar === '1:1' ? [1024, 1024] : [1024, 576]
          const { sandboxImageAsset, SANDBOX_ASSET_TAG } = await import('@/lib/agents/asset-gateway')
          const ph = await sandboxImageAsset({ prompt: `[video] ${prompt as string}`, width: w, height: h })
          let imageUrl = ph.imageUrl
          let assetId: string | null = null
          if (world.projectId) {
            try {
              const persisted = await persistGeneratedAsset({
                projectId: world.projectId,
                sourceUrl: ph.imageUrl,
                type: 'image',
                width: w,
                height: h,
                tags: [SANDBOX_ASSET_TAG],
                metadata: {
                  prompt: prompt as string,
                  provider: 'veo3',
                  model: 'sandbox',
                  costCents: 0,
                  parentAssetId: null,
                  referenceAssetIds: null,
                  enhanceTags: [SANDBOX_ASSET_TAG],
                },
              })
              assetId = persisted.id
              imageUrl = persisted.publicUrl
            } catch (e) {
              log.warn('persist sandbox video placeholder failed', { error: e })
            }
          }
          // Insert it full-frame so the "video" is actually visible in the scene
          // (the real veo3 path inserts a video layer on completion).
          const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
          const layerId = insertImageLayer(world, sceneId, {
            imageUrl,
            x: Math.round(dims.width / 2),
            y: Math.round(dims.height / 2),
            width: dims.width,
            height: dims.height,
            label: 'Video (sandbox placeholder)',
            zIndex: 5,
          })
          return ok(sceneId, `Sandbox: video shown as a full-frame placeholder still (no clip generated, $0).`, {
            layerId,
            imageUrl,
            width: w,
            height: h,
            assetId,
            isPlaceholder: true,
            sandboxRequest: {
              tool: 'generate_veo3_video',
              provider: (args.provider as string) ?? 'auto',
              model: (args.model as string) ?? undefined,
              prompt: prompt as string,
              params: {
                aspectRatio: ar,
                duration: args.duration ?? null,
                resolution: args.resolution ?? null,
                imageUrl: args.imageUrl ?? null,
              },
            },
          })
        }
        // Dispatches through the video provider registry so the same tool can
        // drive Veo 3, Kling, or Runway based on the `provider` arg. Keeps the
        // legacy tool name ("generate_veo3_video") working; when the agent
        // wants a different provider it can pass `provider: 'kling'` / `'runway'`.
        const { getVideoProvider, firstConfiguredVideoProvider } = await import('@/lib/apis/video/registry')
        // Default to 'auto' (FAL-first, key-aware) when the agent doesn't pin a
        // provider — media gen runs on FAL for now. An explicit KNOWN provider
        // wins. An explicit UNKNOWN provider is an error, not a silent swap:
        // returning a different provider than the model asked for would hide the
        // mistake (and could bill/gate under the wrong policy).
        const requestedProvider = (args.provider as string | undefined) || 'auto'
        let registryProvider
        if (requestedProvider === 'auto') {
          registryProvider = firstConfiguredVideoProvider()
        } else {
          registryProvider = getVideoProvider(requestedProvider)
          if (!registryProvider) {
            return err(
              `Unknown video provider "${requestedProvider}". Use one of: veo3, veo31, kling, kling25, seedance, seedance2, ltx, wan, hailuo, runway — or omit provider for auto.`,
            )
          }
        }
        if (!registryProvider) {
          return err('No video provider configured. Add GOOGLE_AI_KEY, FAL_KEY, or RUNWAY_API_KEY.')
        }
        if (!process.env[registryProvider.envKey]) {
          return err(`${registryProvider.name} not configured — set ${registryProvider.envKey} first.`)
        }
        const providerId = registryProvider.id
        // Every video provider id is also an APIName — gate against the ACTUAL provider's
        // policy. (Previously ltx/wan/seedance collapsed to 'veo3' → wrong policy checked:
        // a denied seedance could run under an allowed veo3.)
        // Tier 3: an upscale gates under its OWN 'videoUpscale' bucket, NOT the carrying generation
        // provider — agent calls set skipPermissionGate, so THIS check is the authoritative cap for
        // them. Keying it on providerId would let a capped upscale run under any allowed video bucket
        // (and startVideo bills it under videoUpscale, so the cap must read the same bucket).
        const VIDEO_APIS = [
          'veo3',
          'kling',
          'runway',
          'ltx',
          'wan',
          'seedance',
          'hailuo',
          'veo31',
          'kling25',
          'seedance2',
        ]
        const apiName = (
          args.upscaleVideoUrl ? 'videoUpscale' : VIDEO_APIS.includes(providerId) ? providerId : 'veo3'
        ) as APIName

        const mediaErr = deps.checkMediaEnabled(world, providerId, registryProvider.name)
        if (mediaErr) return mediaErr
        const { sceneId, prompt } = args as Record<string, any>
        const blocked = await deps.checkApiPermission(world, apiName, {
          reason: apiName === 'videoUpscale' ? 'Upscale video clip' : `Generate ${registryProvider.name} video clip`,
          details: {
            prompt: prompt as string,
            duration: (args.duration as number) ?? 5,
            resolution: (args.aspectRatio as string) ?? '16:9',
            // Tier 3: feed the factor so the gate estimates the SAME amount reserve/commit will charge
            // (4× ≈ 2× base). Number()-coerced like the value passed to startVideo below.
            upscaleFactor: Number(args.upscaleFactor) === 4 ? 4 : Number(args.upscaleFactor) === 2 ? 2 : undefined,
          },
        })
        if (blocked)
          return deps.enrichPermission(blocked, {
            generationType: 'video',
            prompt: prompt as string,
            provider: providerId,
            availableProviders: [
              { id: 'veo3', name: 'Google Veo 3', cost: '~$0.50–2.00', isFree: false },
              { id: 'kling', name: 'Kling 2.1', cost: '~$0.40–0.55', isFree: false },
              { id: 'runway', name: 'Runway Gen-4', cost: '~$0.70–1.20', isFree: false },
              { id: 'ltx', name: 'LTX Video', cost: '~$0.06/s', isFree: false },
              { id: 'wan', name: 'Wan Video', cost: '~$0.20/clip', isFree: false },
              { id: 'seedance', name: 'Seedance', cost: '~$0.30/s', isFree: false },
            ],
            config: { aspectRatio: args.aspectRatio, duration: args.duration, provider: providerId },
            toolArgs: args as Record<string, any>,
          })
        // Upscale is a pure post-process (source clip → upres) and carries no prompt; every other
        // mode requires one. startVideo enforces the upscale capability + source presence.
        if (!sceneId || (!prompt && !args.upscaleVideoUrl)) return err('sceneId and prompt are required')
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)
        try {
          const aspectRatio = ((args.aspectRatio as string) ?? '16:9') as '16:9' | '9:16' | '1:1'
          const duration = ((args.duration as number) ?? 5) as 5 | 8
          // Route through startVideo so the agent path gets the SAME machinery the
          // in-app path has: start-cache dedupe, a durable video_jobs row (deadline timeout),
          // and a duration-scaled spend reservation. Previously this called provider.generate
          // directly, so agent-started clips had no durability/cache/reservation. The camera
          // fold happens inside startVideo (capability-aware) — pass the raw prompt + spec, not
          // a pre-folded prompt, so it isn't folded twice. We already ran the agent permission
          // UX above, so skip startVideo's own (divergent) project-row gate.
          const { startVideo } = await import('@/lib/services/generation')
          // Validate the edit operation at the boundary instead of an unchecked `as` cast — an
          // unknown op resolves to undefined here, and startVideo then rejects editVideoUrl with no
          // valid operation (fail loud) rather than silently sending an un-framed v2v prompt.
          const { isVideoEditOperation } = await import('@/lib/media/video-edit')
          const editOp = isVideoEditOperation(args.editOperation) ? args.editOperation : undefined
          const res = await startVideo({
            projectId: world.projectId,
            sceneId,
            provider: providerId,
            prompt: prompt as string,
            negativePrompt: args.negativePrompt as string | undefined,
            aspectRatio,
            duration,
            seed: args.seed as number | undefined,
            camera: args.camera as import('@/lib/media/camera').CameraSpec | undefined,
            // Cinema/lens: accept a raw optics spec OR a named lens preset id (resolved to a spec).
            optics:
              (args.optics as import('@/lib/media/optics').OpticsSpec | undefined) ??
              resolveOpticsPreset(args.lensPreset as string | undefined) ??
              undefined,
            effect: args.effect as string | undefined, // Tier 2: VFX effect preset id
            // i2v / Tier 2 keyframe + extend, video→video edit source inputs. startVideo
            // enforces the model's capabilities (an incapable request is rejected there).
            imageUrl: args.imageUrl as string | undefined,
            endImageUrl: args.endImageUrl as string | undefined,
            extendVideoUrl: args.extendVideoUrl as string | undefined,
            editVideoUrl: args.editVideoUrl as string | undefined,
            edit: editOp ? { operation: editOp } : undefined,
            drivingVideoUrl: args.drivingVideoUrl as string | undefined, // Tier 2 Act-Two
            upscaleVideoUrl: args.upscaleVideoUrl as string | undefined, // Tier 3: video upscale
            // Coerce at the boundary (like editOperation above) — arbitrary tool/MCP args could send a
            // string or out-of-range number; accept only 2 or 4, else undefined (factory defaults to 2).
            upscaleFactor: Number(args.upscaleFactor) === 4 ? 4 : Number(args.upscaleFactor) === 2 ? 2 : undefined,
            skipPermissionGate: true,
          })
          if (res.error) return err(`${registryProvider.name} generation failed: ${res.error}`)
          if (!res.operationName) return err(`${registryProvider.name} generation did not start`)
          // Reserve the video ESTIMATE into the RUN cost ledger at dispatch. Video is
          // async (the run usually ends before the poller commits the actual cost to
          // the project ledger), so without a dispatch-time reservation the run's
          // dollar cap is structurally blind to the priciest media class. skipDbLog:
          // the poller logs the real cost to the project ledger on completion.
          const videoEstimate = estimateApiCostUsd(providerId as APIName, { duration })
          await commitMediaSpend(
            world,
            `video:${providerId}`,
            videoEstimate,
            `video ${providerId} (~${duration}s, est.)`,
            {
              skipDbLog: true,
            },
          )
          // Place a real linked Veo3 layer immediately (status: generating)
          // with the operationName + provenance. The poller fills videoUrl when
          // the op completes; until then the layer is visible + traceable rather
          // than the previous fire-and-forget that created nothing.
          const layerId = uuidv4()
          // Dims + anchor at placement: never place a 0×0 (invisible)
          // layer. Contain-fit the clip's aspect ratio into the project frame
          // and author CENTER coords (canon) with the anchor flag, so preview
          // and export agree and the poll/template never has to guess.
          const projectDims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
          const placedDims = computeVeo3FullFrameDims(aspectRatio, projectDims)
          const veo3Layer = {
            id: layerId,
            type: 'veo3' as const,
            prompt,
            negativePrompt: (args.negativePrompt as string | undefined) ?? null,
            aspectRatio,
            duration,
            loop: false,
            playbackRate: 1,
            x: Math.round(projectDims.width / 2),
            y: Math.round(projectDims.height / 2),
            width: placedDims.width,
            height: placedDims.height,
            anchorVersion: VEO3_ANCHOR_VERSION,
            opacity: 1,
            zIndex: 50,
            videoUrl: null,
            thumbnailUrl: null,
            status: 'generating' as const,
            operationName: res.operationName,
            startAt: 0,
            label: `${registryProvider.name} clip`,
            assetId: null,
            provenance: {
              prompt,
              provider: providerId,
              model: providerId,
              referenceAssetIds: null,
              generatedAt: new Date().toISOString(),
            },
          }
          updateScene(world, sceneId, { aiLayers: [...(scene.aiLayers || []), veo3Layer] })
          emitAgentAction(
            { type: 'layer/add', params: { sceneId, layerId, layer: veo3Layer as unknown as AILayer } },
            emitterDeps(world),
          )
          // Reactive generation jobs: register a media_generations record + enqueue the
          // MAIN-PROCESS runner so the job's poll loop is owned off the agent — it advances and
          // pushes the finished clip to the renderer even if no editor window is open (e.g. a
          // headless MCP run) and even after this agent turn ends. Best-effort: the renderer
          // reconcile + (optional) get_video_status remain as defense in depth, so a failure here
          // never blocks the generation. The job id == layerId so the push targets this layer.
          try {
            if (!world.projectId) throw new Error('no projectId in world')
            const { createMediaGeneration } = await import('@/lib/db/queries/media-generations')
            const { getMediaGenerationRunner } = await import('@/lib/services/media-generation-runner')
            const { deadlineFor } = await import('@/lib/services/video-job-deadline')
            await createMediaGeneration({
              id: layerId,
              projectId: world.projectId,
              kind: 'video',
              provider: res.provider ?? providerId,
              operationName: res.operationName,
              prompt: prompt as string,
              sceneId,
              layerId,
              deadlineAtMs: deadlineFor(res.provider ?? providerId, Date.now()),
            })
            getMediaGenerationRunner().enqueue(layerId)
          } catch (e) {
            log.warn('media-generation job registration failed (non-fatal); renderer reconcile will backstop', {
              error: e,
            })
          }
          return ok(
            sceneId,
            `${registryProvider.name} video generation SUBMITTED. Operation: ${res.operationName}. Takes 2-10 min. ` +
              `Placed layer ${layerId} (status: generating). The job runs on a background worker that fills the ` +
              `clip in (or marks the layer 'error' on failure) and updates the timeline automatically — do NOT ` +
              `loop get_video_status. Continue with other work; the clip is not ready yet, so don't tell the user ` +
              `it's done. You may call get_video_status ONCE if you specifically need the final URL in this turn.`,
            { operationName: res.operationName, provider: res.provider, layerId },
          )
        } catch (e: any) {
          return err(`${registryProvider.name} generation failed: ${e.message}`)
        }
      }

      case 'get_video_status': {
        // The real poll tool that completes the generate_veo3_video flow.
        // Finds the placed (status: 'generating') video layer by operationName,
        // polls the provider via the existing pollVideoStatus service, and on
        // completion patches the layer IN PLACE (status → 'ready', videoUrl,
        // dimensions) + regenerates the scene HTML. Fail-loud: an operation
        // failure marks the layer 'error' (prior fields otherwise intact) and
        // returns success:false; an unknown operation/layer is an error.
        const {
          operationName,
          sceneId: argSceneId,
          layerId: argLayerId,
        } = args as {
          operationName?: string
          sceneId?: string
          layerId?: string
        }
        if (!operationName) return err('operationName is required (returned by generate_veo3_video)')

        // Locate the layer the operation belongs to. Prefer an exact
        // operationName match; fall back to explicit sceneId+layerId so the
        // agent can address a layer whose op id it lost track of.
        let targetScene: (typeof world.scenes)[number] | undefined
        let targetLayer: any
        for (const scene of world.scenes) {
          for (const layer of scene.aiLayers || []) {
            const l = layer as any
            const matchesOp = l.operationName && l.operationName === operationName
            const matchesIds = argSceneId && argLayerId && scene.id === argSceneId && l.id === argLayerId
            if (matchesOp || matchesIds) {
              targetScene = scene
              targetLayer = l
              break
            }
          }
          if (targetLayer) break
        }
        if (!targetScene || !targetLayer) {
          return err(
            `No video layer found for operation "${operationName}". It may belong to a different ` +
              `project, or the layer was removed. Pass sceneId + layerId to target a specific layer.`,
          )
        }

        const providerId = (targetLayer.provenance?.provider as string | undefined) ?? undefined
        let pollResult: { done: boolean; videoUrl?: string; provider?: string; error?: string }
        try {
          const { pollVideoStatus } = await import('@/lib/services/generation')
          pollResult = await pollVideoStatus({
            operationName,
            projectId: world.projectId ?? undefined,
            prompt: targetLayer.prompt ?? undefined,
            providerId,
          })
        } catch (e: any) {
          // Polling itself threw (network / provider error). Don't corrupt the
          // layer — report the transient failure so the agent can retry.
          return err(`Video status poll failed for "${operationName}": ${e.message}`)
        }

        if (!pollResult.done) {
          return ok(targetScene.id, `Video "${operationName}" still generating.`, {
            done: false,
            status: 'generating',
            operationName,
            layerId: targetLayer.id,
          })
        }

        if (pollResult.error || !pollResult.videoUrl) {
          // Fail-loud: the operation failed. Mark the layer 'error' so the UI
          // shows it; leave every other field (prompt/position/timing) intact
          // for a possible retry. Return success:false so the agent reacts.
          const errored = (targetScene.aiLayers || []).map((l) =>
            (l as any).id === targetLayer.id ? { ...(l as any), status: 'error' } : l,
          )
          updateScene(world, targetScene.id, { aiLayers: errored })
          await deps.regenerateHTML(world, targetScene.id, logger)
          return err(
            `Video generation for "${operationName}" failed: ${pollResult.error ?? 'no video returned'}. ` +
              `Layer ${targetLayer.id} marked 'error'.`,
          )
        }

        // Completed. Patch the layer in place: ready + videoUrl. If width/height
        // are still placeholder (0) — e.g. an older layer — derive a
        // full-frame contain-fit box from the project + clip aspect ratio so the
        // layer renders at a real size. When we derive dims we also author CENTER
        // coords + the anchor flag (the layer had none, so its 0,0 carried no
        // meaningful anchor); a layer that already has dims keeps its coords/flag.
        const projectDims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
        const needDims = veo3DimsAreFalsy(targetLayer)
        const derived = needDims ? computeVeo3FullFrameDims(targetLayer.aspectRatio as string, projectDims) : null
        const dimsPatch = needDims
          ? {
              width: derived!.width,
              height: derived!.height,
              x: Math.round(projectDims.width / 2),
              y: Math.round(projectDims.height / 2),
              anchorVersion: VEO3_ANCHOR_VERSION,
            }
          : {}
        const patched = (targetScene.aiLayers || []).map((l) =>
          (l as any).id === targetLayer.id
            ? {
                ...(l as any),
                status: 'ready',
                videoUrl: pollResult.videoUrl,
                ...dimsPatch,
              }
            : l,
        )
        updateScene(world, targetScene.id, { aiLayers: patched })
        emitAgentAction(
          {
            type: 'layer/update',
            params: {
              sceneId: targetScene.id,
              layerId: targetLayer.id,
              patch: {
                status: 'ready',
                videoUrl: pollResult.videoUrl,
                ...dimsPatch,
              },
              prior: {
                status: targetLayer.status,
                videoUrl: targetLayer.videoUrl,
                ...(needDims
                  ? {
                      width: targetLayer.width,
                      height: targetLayer.height,
                      x: targetLayer.x,
                      y: targetLayer.y,
                      anchorVersion: targetLayer.anchorVersion,
                    }
                  : {}),
              },
            },
          },
          emitterDeps(world),
        )
        const videoHtml = await deps.regenerateHTML(world, targetScene.id, logger)
        return degradeIfHtmlUnwritten(
          videoHtml,
          ok(targetScene.id, `Video "${operationName}" ready — filled layer ${targetLayer.id}.`, {
            done: true,
            status: 'ready',
            operationName,
            layerId: targetLayer.id,
            videoUrl: pollResult.videoUrl,
          }),
        )
      }

      default:
        return err(`Unknown image/video tool: ${toolName}`)
    }
  }
}
