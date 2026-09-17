import { v4 as uuidv4 } from 'uuid'
import type { AILayer, APIName } from '@/lib/types'
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
import { computeAvatarPipCenter, PIP_DEFAULT_SIZE } from '@/lib/media/avatar-geometry'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'
import { isAvatarExpired, avatarTimeoutMessage, avatarSceneFitDuration } from '@/lib/services/avatar-job-deadline'

/**
 * P1b-fanout-remaining (avatar): emit `layer/add` for avatar layers
 * inserted into `aiLayers`, and `scene/update` when `generate_avatar_scene`
 * replaces sceneType + aiLayers at once. Best-effort.
 */

export const AVATAR_TOOL_NAMES = [
  // list_avatars + generate_avatar were legacy HeyGen-only tools with no schema
  // and no internal caller — unreachable on both ends. Deleted; the live surface
  // is generate_avatar_narration / generate_avatar_scene / get_avatar_status.
  'generate_avatar_narration',
  'generate_avatar_scene',
  // get_avatar_status is reached as get_status(kind:'avatar') — routed in tool-executor.
] as const

export function createAvatarToolHandler(deps: {
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
}) {
  return async function handleAvatarTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'generate_avatar_narration': {
        const {
          sceneId,
          text: narrationText,
          placement,
          avatarConfigId: cfgId,
          sourceImageUrl: srcImg,
          characterId: castId,
        } = args as Record<string, any>
        if (!sceneId || !narrationText) return err('sceneId and text are required')
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)

        // Sandbox: no paid avatar provider runs — insert a visible placeholder
        // portrait positioned per the requested placement (no spend).
        if (world.sandboxMode) {
          const { sandboxImageAsset, persistSandboxImage } = await import('@/lib/agents/asset-gateway')
          const ph = await sandboxImageAsset({
            prompt: `[avatar] ${String(narrationText).slice(0, 60)}`,
            width: 512,
            height: 768,
          })
          const url = await persistSandboxImage(world.projectId, ph, 'Avatar (sandbox placeholder)')
          const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
          const place = String(placement ?? 'pip_bottom_right')
          const full = place === 'fullscreen'
          const w = full ? Math.round(dims.height * 0.6) : Math.round(dims.width * 0.16)
          const h = Math.round(w * 1.5)
          const layerId = insertImageLayer(world, sceneId, {
            imageUrl: url,
            x: full ? Math.round(dims.width / 2) : Math.round(dims.width * (place.includes('left') ? 0.16 : 0.84)),
            y: full ? Math.round(dims.height / 2) : Math.round(dims.height * (place.includes('top') ? 0.3 : 0.7)),
            width: w,
            height: h,
            label: 'Avatar (sandbox placeholder)',
            zIndex: 100,
          })
          return ok(sceneId, 'Sandbox: avatar shown as a placeholder portrait (no avatar generated, $0).', {
            layerId,
            imageUrl: url,
            isPlaceholder: true,
            sandboxRequest: {
              tool: 'generate_avatar_narration',
              provider: 'avatar',
              prompt: String(narrationText),
              params: {
                placement: place,
                avatarConfigId: cfgId ?? null,
                sourceImageUrl: srcImg ?? null,
                characterId: castId ?? null,
              },
              note: 'avatar speaks this text; the fal/heygen provider + voice are resolved at generation time',
            },
          })
        }

        // Gate on the EFFECTIVE provider generateAvatar will actually use
        // (override → resolved project/scene/default avatar config), not just the
        // per-run generationOverrides — otherwise an empty-override run with a
        // paid DEFAULT avatar config (heygen/fal) spends with no prompt.
        const { resolveAvatarConfig } = await import('@/lib/services/avatar')
        const resolvedAvatarCfg = world.projectId
          ? await resolveAvatarConfig(world.projectId, { avatarConfigId: cfgId ?? null, sceneId })
          : null
        const avatarProvider =
          world.generationOverrides?.falAvatar?.provider ??
          world.generationOverrides?.heygen?.provider ??
          resolvedAvatarCfg?.provider ??
          ''
        const avatarProviderOptions: import('@/lib/types').GenerationProviderOption[] = [
          { id: 'musetalk', name: 'MuseTalk', cost: '~$0.04/scene', isFree: false },
          { id: 'fabric', name: 'Fabric 1.0', cost: '~$0.08–0.15/scene', isFree: false },
          { id: 'aurora', name: 'Aurora', cost: '~$0.05/scene', isFree: false },
          { id: 'heygen', name: 'HeyGen', cost: '~$0.10–1.00', isFree: false },
        ].filter((p) => !world.mediaGenEnabled || world.mediaGenEnabled[p.id] !== false)

        if (['musetalk', 'fabric', 'aurora'].includes(avatarProvider)) {
          const blocked = await deps.checkApiPermission(world, 'falAvatar', {
            reason: 'Generate avatar narration (FAL provider)',
            details: { prompt: narrationText as string, model: avatarProvider },
          })
          if (blocked)
            return deps.enrichPermission(blocked, {
              generationType: 'avatar',
              prompt: narrationText,
              provider: avatarProvider,
              availableProviders: avatarProviderOptions,
              config: { placement: placement ?? 'pip_bottom_right', sourceImageUrl: srcImg },
              toolArgs: args as Record<string, any>,
            })
        } else if (avatarProvider === 'heygen') {
          const blocked = await deps.checkApiPermission(world, 'heygen', {
            reason: 'Generate avatar narration (HeyGen)',
            details: { prompt: narrationText as string, model: 'heygen' },
          })
          if (blocked)
            return deps.enrichPermission(blocked, {
              generationType: 'avatar',
              prompt: narrationText,
              provider: 'heygen',
              availableProviders: avatarProviderOptions,
              config: { placement: placement ?? 'pip_bottom_right' },
              toolArgs: args as Record<string, any>,
            })
        }

        try {
          const projectId = world.projectId
          if (!projectId) return err('projectId not available in world state')
          // Re-check abort before the paid avatar provider call (HeyGen async start or
          // the sync fal lipsync path). Skip in sandbox (no provider call). Mirrors the choke-point.
          if (!world.sandboxMode) {
            const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
            if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — avatar narration not started')
          }
          const { startAvatarGeneration } = await import('@/lib/services/avatar')
          const result = await startAvatarGeneration(projectId, {
            text: narrationText,
            sceneId,
            avatarConfigId: cfgId ?? null,
            sourceImageUrl: srcImg ?? null,
            characterId: castId ?? null,
          })

          const avatarPlacement = (placement as string) || 'pip_bottom_right'
          const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
          const layerId = uuidv4()

          // D3: aspect-aware pip placement. The old hardcoded 1640/800 was
          // 16:9-only and put the pip offscreen at export on 9:16/1:1. Compute
          // the pip CENTER from the project dims + a proportional margin (mirrors
          // the preview CSS) so the sprite (anchor 0.5) lands in the corner at any
          // aspect ratio. Fullscreen stays frame-centered.
          const pipSize = PIP_DEFAULT_SIZE
          const pipCenter =
            avatarPlacement === 'fullscreen'
              ? { x: Math.round(dims.width / 2), y: Math.round(dims.height / 2) }
              : computeAvatarPipCenter(avatarPlacement, dims, pipSize)

          // Shared geometry for both the processing (heygen, async) and ready
          // (fal, sync) layers — only status/videoUrl/heygenVideoId differ.
          const baseLayer = {
            id: layerId,
            type: 'avatar' as const,
            avatarId: '',
            voiceId: '',
            script: narrationText,
            removeBackground: false,
            x: pipCenter.x,
            y: pipCenter.y,
            width: avatarPlacement === 'fullscreen' ? dims.width : pipSize,
            height: avatarPlacement === 'fullscreen' ? dims.height : pipSize,
            opacity: 1,
            zIndex: 100,
            thumbnailUrl: null,
            startAt: 0,
            label: 'Avatar Narrator',
            avatarPlacement,
          }

          // HeyGen: the job is rendering (1-3 min). Place a `processing` layer
          // carrying the heygenVideoId and tell the model to poll get_avatar_status
          // — the chat stays responsive instead of blocking on the render.
          if (result.async) {
            const provider = result.provider
            const avatarLayer = {
              ...baseLayer,
              videoUrl: null,
              status: 'processing' as const,
              heygenVideoId: result.heygenVideoId,
              estimatedDuration: result.estimatedSeconds || scene.duration,
              // Stamp the render start so get_avatar_status can enforce the
              // 15-min deadline (no infinite poll on a wedged HeyGen job).
              renderStartedAt: Date.now(),
              avatarProvider: provider,
              provenance: {
                prompt: narrationText,
                provider,
                model: cfgId ?? null,
                referenceAssetIds: null,
                referenceUrls: srcImg ? [srcImg] : null,
                generatedAt: new Date().toISOString(),
              },
            }
            updateScene(world, sceneId, { aiLayers: [...(scene.aiLayers ?? []), avatarLayer as any] })
            emitAgentAction(
              { type: 'layer/add', params: { sceneId, layerId, layer: avatarLayer as unknown as AILayer } },
              emitterDeps(world),
            )
            return ok(
              sceneId,
              `Avatar narration is rendering on HeyGen (~${result.estimatedSeconds}s, placement ${avatarPlacement}). The placeholder layer is in place. You MUST call get_avatar_status with this sceneId + layerId every ~30s until it reports done before relying on the avatar.`,
              {
                layerId,
                heygenVideoId: result.heygenVideoId,
                provider,
                placement: avatarPlacement,
                status: 'processing',
                pollWith: 'get_avatar_status',
              },
            )
          }

          // Sync providers (musetalk/fabric/aurora): the video is ready.
          const avatarVideo = result.video
          const videoUrl = avatarVideo.videoUrl
          const provider = avatarVideo.provider
          const cost = avatarVideo.costUsd ?? 0
          // Run-ledger visibility: avatar already logged to the project ledger
          // (avatar.ts); feed the RUN cost cap too (skipDbLog) so avatar spend can
          // trip maxRunCostUsd — it was previously invisible to the run cap.
          await commitMediaSpend(world, `avatar:${provider}`, cost, `avatar narration (${provider})`, {
            skipDbLog: true,
          })
          const avatarLayer = {
            ...baseLayer,
            videoUrl,
            status: 'ready' as const,
            heygenVideoId: null,
            estimatedDuration: avatarVideo.durationSeconds ?? scene.duration,
            avatarProvider: provider,
            // Provenance snapshot of the provider config so the avatar
            // layer is traceable + regenerable later.
            provenance: {
              prompt: narrationText,
              provider,
              model: cfgId ?? null,
              // `srcImg` is a raw URL, not a ProjectAsset id — keep types
              // honest by storing it under `referenceUrls`, leaving
              // `referenceAssetIds` strictly for resolved asset ids.
              referenceAssetIds: null,
              referenceUrls: srcImg ? [srcImg] : null,
              generatedAt: new Date().toISOString(),
            },
          }
          updateScene(world, sceneId, { aiLayers: [...(scene.aiLayers ?? []), avatarLayer as any] })
          emitAgentAction(
            {
              type: 'layer/add',
              params: { sceneId, layerId, layer: avatarLayer as unknown as AILayer },
            },
            emitterDeps(world),
          )
          const costMsg = cost > 0 ? ` Cost: $${cost.toFixed(2)}.` : ' (free)'
          return ok(sceneId, `Avatar narration added (${provider}, ${avatarPlacement}).${costMsg}`, {
            layerId,
            videoUrl,
            provider,
            placement: avatarPlacement,
            costUsd: cost,
          })
        } catch (e: any) {
          return err(`Avatar narration failed: ${e.message}`)
        }
      }

      case 'generate_avatar_scene': {
        const { sceneId, narration_script, content_panels, backdrop, avatar_position, avatar_size, avatar_config_id } =
          args as Record<string, any>
        if (!sceneId || !narration_script) return err('sceneId and narration_script are required')
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)

        // Sandbox: no paid avatar provider runs — insert a visible placeholder portrait.
        if (world.sandboxMode) {
          const scriptText = narration_script?.lines?.map((l: any) => l.text).join(' ') ?? 'avatar scene'
          const { sandboxImageAsset, persistSandboxImage } = await import('@/lib/agents/asset-gateway')
          const ph = await sandboxImageAsset({
            prompt: `[avatar scene] ${String(scriptText).slice(0, 60)}`,
            width: 512,
            height: 768,
          })
          const url = await persistSandboxImage(world.projectId, ph, 'Avatar (sandbox placeholder)')
          const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
          const w = Math.round(dims.width * 0.18)
          const layerId = insertImageLayer(world, sceneId, {
            imageUrl: url,
            x: Math.round(dims.width * 0.82),
            y: Math.round(dims.height * 0.68),
            width: w,
            height: Math.round(w * 1.5),
            label: 'Avatar presenter (sandbox placeholder)',
            zIndex: 100,
          })
          return ok(
            sceneId,
            'Sandbox: avatar scene shown with a placeholder presenter portrait (no avatar generated, $0).',
            {
              layerId,
              imageUrl: url,
              isPlaceholder: true,
              sandboxRequest: {
                tool: 'generate_avatar_scene',
                provider: 'avatar',
                prompt: String(scriptText),
                params: {
                  avatarPosition: avatar_position ?? null,
                  avatarSize: avatar_size ?? null,
                  avatarConfigId: avatar_config_id ?? null,
                  backdrop: backdrop ?? null,
                  contentPanels: content_panels ?? null,
                },
                note: 'avatar presenter speaks this script; the provider + voice are resolved at generation time',
              },
            },
          )
        }

        // Gate on the EFFECTIVE provider generateAvatar will use (override →
        // resolved project/scene/default avatar config). Keying off
        // generationOverrides alone left a free provider as the default, so a paid
        // DB-default avatar config (fal OR heygen) spent with no prompt — the gap
        // P0b's heygen branch was meant to close but couldn't, since avatarProvider
        // was never 'heygen' for an empty-override DB-default run.
        const { resolveAvatarConfig } = await import('@/lib/services/avatar')
        const resolvedSceneAvatarCfg = world.projectId
          ? await resolveAvatarConfig(world.projectId, { avatarConfigId: avatar_config_id ?? null, sceneId })
          : null
        const avatarProvider =
          world.generationOverrides?.falAvatar?.provider ??
          world.generationOverrides?.heygen?.provider ??
          resolvedSceneAvatarCfg?.provider ??
          ''
        const mediaErr = deps.checkMediaEnabled(world, avatarProvider, `Avatar provider "${avatarProvider}"`)
        if (mediaErr) return mediaErr
        if (['musetalk', 'fabric', 'aurora'].includes(avatarProvider)) {
          const blocked = await deps.checkApiPermission(world, 'falAvatar', {
            reason: 'Generate full avatar presenter scene (FAL provider)',
            details: { prompt: narration_script as string, model: avatarProvider },
          })
          if (blocked)
            return deps.enrichPermission(blocked, {
              generationType: 'avatar',
              prompt: 'Avatar scene generation',
              provider: avatarProvider,
              toolArgs: args as Record<string, any>,
            })
        } else if (avatarProvider === 'heygen') {
          // heygen via resolved config (incl. empty-override DB default).
          const scriptText = narration_script?.lines?.map((l: any) => l.text).join(' ') ?? 'avatar scene'
          const blocked = await deps.checkApiPermission(world, 'heygen', {
            reason: 'Generate full avatar presenter scene (HeyGen)',
            details: { prompt: scriptText as string, model: 'heygen' },
          })
          if (blocked)
            return deps.enrichPermission(blocked, {
              generationType: 'avatar',
              prompt: 'Avatar scene generation',
              provider: 'heygen',
              toolArgs: args as Record<string, any>,
            })
        }

        try {
          const priorSceneType = scene.sceneType
          const priorAiLayers = scene.aiLayers ?? []
          // Defer the sceneType change until generation succeeds — setting it
          // up front left the scene as type=avatar_scene with no avatar layer
          // on failure, and bypassed updateScene's cache invalidation (F4).
          const projectId = world.projectId
          if (!projectId) return err('projectId not available in world state')
          const firstLineText = narration_script.lines?.map((l: any) => l.text).join(' ') || 'Avatar scene'
          // Re-check abort before the paid avatar provider call (HeyGen async start or
          // the sync fal lipsync path). Skip in sandbox (no provider call). Mirrors generate_avatar_narration.
          if (!world.sandboxMode) {
            const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
            if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — avatar scene not started')
          }
          const { startAvatarGeneration } = await import('@/lib/services/avatar')
          const result = await startAvatarGeneration(projectId, {
            text: firstLineText,
            sceneId,
            avatarConfigId: avatar_config_id ?? null,
          })
          const provider = result.async ? result.provider : result.video.provider
          const videoUrl = result.async ? null : result.video.videoUrl
          const sceneDims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
          const layerId = uuidv4()
          const avatarLayer = {
            id: layerId,
            type: 'avatar' as const,
            avatarId: '',
            voiceId: '',
            script: firstLineText,
            removeBackground: false,
            x: 0,
            y: 0,
            width: sceneDims.width,
            height: sceneDims.height,
            opacity: 1,
            zIndex: 100,
            // HeyGen is async — leave the video null + status processing until
            // get_avatar_status fills it; everything else is ready immediately.
            videoUrl,
            thumbnailUrl: null,
            status: (result.async ? 'processing' : 'ready') as 'processing' | 'ready',
            heygenVideoId: result.async ? result.heygenVideoId : null,
            estimatedDuration: scene.duration,
            // Stamp the render start for async (HeyGen) jobs so get_avatar_status
            // can enforce the 15-min deadline; synchronous results are already ready.
            renderStartedAt: result.async ? Date.now() : undefined,
            startAt: 0,
            label: 'Avatar Presenter',
            avatarPlacement: narration_script.position || 'fullscreen_left',
            avatarProvider: provider,
            // Provider-config provenance snapshot for the presenter scene.
            provenance: {
              prompt: firstLineText,
              provider,
              model: avatar_config_id ?? null,
              referenceAssetIds: null,
              generatedAt: new Date().toISOString(),
            },
            narrationScript: narration_script,
            avatarSceneConfig: {
              narrationScript: narration_script,
              contentPanels: (content_panels || []).map((p: any, i: number) => ({
                id: p.id || `panel-${i}`,
                html: p.html || '',
                position: p.position || 'right',
                revealAt: String(p.revealAt ?? i * 3 + 2),
                exitAt: p.exitAt ? String(p.exitAt) : undefined,
                style: p.style,
              })),
              backdrop: backdrop || '',
              avatarPosition: avatar_position || 'left',
              avatarSize: avatar_size || 40,
            },
          }

          const newAiLayers = [...(scene.aiLayers ?? []).filter((l) => l.type !== 'avatar'), avatarLayer as any]
          updateScene(world, sceneId, { sceneType: 'avatar_scene', aiLayers: newAiLayers })
          emitAgentAction(
            {
              type: 'scene/update',
              params: {
                sceneId,
                patch: { sceneType: 'avatar_scene' as any, aiLayers: newAiLayers },
                prior: { sceneType: priorSceneType, aiLayers: priorAiLayers },
              },
            },
            emitterDeps(world),
          )

          if (result.async) {
            return ok(
              sceneId,
              `Avatar presenter scene is rendering on HeyGen (~${result.estimatedSeconds}s). ${(content_panels || []).length} content panel(s). You MUST call get_avatar_status with this sceneId + layerId every ~30s until it reports done before relying on the presenter.`,
              {
                layerId,
                provider,
                sceneType: 'avatar_scene',
                heygenVideoId: result.heygenVideoId,
                status: 'processing',
                pollWith: 'get_avatar_status',
                contentPanels: (content_panels || []).length,
              },
            )
          }

          const cost = result.video.costUsd ?? 0
          // Run-ledger visibility (skipDbLog — already logged to the project ledger).
          await commitMediaSpend(world, `avatar:${provider}`, cost, `avatar scene (${provider})`, { skipDbLog: true })
          const costMsg = cost > 0 ? ` Cost: $${cost.toFixed(2)}.` : ' (free)'
          return ok(
            sceneId,
            `Avatar presenter scene created (${provider}).${costMsg} ${(content_panels || []).length} content panel(s).`,
            {
              layerId,
              provider,
              sceneType: 'avatar_scene',
              contentPanels: (content_panels || []).length,
              costUsd: cost,
            },
          )
        } catch (e: any) {
          return err(`Avatar scene failed: ${e.message}`)
        }
      }

      case 'get_avatar_status': {
        const { sceneId, layerId, heygenVideoId: videoIdArg } = args as Record<string, any>
        if (!sceneId && !layerId && !videoIdArg) {
          return err('Provide sceneId + layerId (or heygenVideoId) of the avatar layer to check.')
        }

        // Locate the processing avatar layer: scene → its avatar layer by id (or, as a
        // fallback, by exact heygenVideoId). We scan all scenes when only the videoId is given.
        const scenesToSearch = sceneId ? [findScene(world, sceneId)].filter(Boolean) : (world.scenes ?? [])
        let foundScene: any = null
        let layer: any = null
        for (const s of scenesToSearch as any[]) {
          if (!s) continue
          const match = (s.aiLayers ?? []).find(
            (l: any) =>
              l.type === 'avatar' && ((layerId && l.id === layerId) || (videoIdArg && l.heygenVideoId === videoIdArg)),
          )
          if (match) {
            foundScene = s
            layer = match
            break
          }
        }

        if (!foundScene || !layer) return err('Avatar layer not found (check sceneId + layerId).')
        const videoId = layer.heygenVideoId ?? videoIdArg
        if (!videoId) return err('That avatar layer has no HeyGen videoId to poll (not a HeyGen render).')

        // Already completed on a prior poll — short-circuit so a repeat call doesn't
        // re-download the video, re-regenerate HTML, or re-extend the scene.
        if (layer.status === 'ready' && layer.videoUrl) {
          return ok(foundScene.id, 'Avatar render already complete.', {
            done: true,
            status: 'ready',
            layerId: layer.id,
            videoUrl: layer.videoUrl,
          })
        }

        // Helper: replace the avatar layer in place, preserving every other layer + order.
        const replaceLayer = (patch: Record<string, any>) => {
          const newAiLayers = (foundScene.aiLayers ?? []).map((l: any) => (l.id === layer.id ? { ...l, ...patch } : l))
          updateScene(world, foundScene.id, { aiLayers: newAiLayers })
          emitAgentAction(
            {
              type: 'layer/update',
              params: { sceneId: foundScene.id, layerId: layer.id, patch },
            },
            emitterDeps(world),
          )
        }

        let poll: import('@/lib/services/generation').PollHeygenStatusResult
        try {
          const { pollHeygenStatus } = await import('@/lib/services/generation')
          poll = await pollHeygenStatus(videoId)
        } catch (e: any) {
          // Transient failure (network/provider hiccup): do NOT touch the layer — it
          // stays `processing` so a later poll can still complete it.
          return err(`Avatar status check failed (transient — try again): ${e.message}`)
        }

        if (poll.status === 'completed' && poll.videoUrl) {
          // Real rendered length from HeyGen. Record it on the layer so the export's
          // scene-fit (layerContentEnd reads estimatedDuration) uses the TRUTH, not
          // the word-count estimate the placeholder was minted with.
          const realDuration =
            typeof poll.durationSeconds === 'number' && poll.durationSeconds > 0 ? poll.durationSeconds : null
          const layerPatch: Record<string, any> = {
            status: 'ready',
            videoUrl: poll.videoUrl,
            thumbnailUrl: poll.thumbnailUrl ?? null,
          }
          if (realDuration !== null) layerPatch.estimatedDuration = realDuration
          replaceLayer(layerPatch)

          // Scene-fit: grow the scene so the avatar (and its narration) isn't cut
          // off. Preview advances at scene.duration, so without this a 25s avatar in
          // an 8s scene is chopped. Only ever EXTEND — never shrink a scene the user
          // sized larger — and cap at a sane ceiling so a runaway clip can't bloat it.
          // Shared with the renderer reconcile poll (avatarSceneFitDuration) so an
          // agent-completed and a renderer-completed avatar fit the scene identically.
          const sceneExtendedTo = avatarSceneFitDuration({
            startAt: Number(layer.startAt) || 0,
            realDuration,
            sceneDuration: Number(foundScene.duration) || 0,
          })
          if (sceneExtendedTo !== null) {
            updateScene(world, foundScene.id, { duration: sceneExtendedTo })
            emitAgentAction(
              { type: 'scene/update', params: { sceneId: foundScene.id, patch: { duration: sceneExtendedTo } } },
              emitterDeps(world),
            )
          }

          // Regenerate the scene HTML so the finished clip lands in the preview. Lazy import:
          // tool-executor imports this module, so a top-level import would be circular.
          const { regenerateHTML } = await import('@/lib/agents/tool-executor')
          const avatarHtml = await regenerateHTML(world, foundScene.id)
          const completeMsg = sceneExtendedTo
            ? `Avatar render complete (${realDuration!.toFixed(1)}s) — scene extended to ${sceneExtendedTo.toFixed(1)}s so the avatar isn't cut off.`
            : 'Avatar render complete — the video is now in the scene.'
          return degradeIfHtmlUnwritten(
            avatarHtml,
            ok(foundScene.id, completeMsg, {
              done: true,
              status: 'ready',
              layerId: layer.id,
              videoUrl: poll.videoUrl,
              durationSeconds: realDuration,
              sceneExtendedTo,
            }),
          )
        }

        if (poll.status === 'failed' || (poll.status === 'completed' && !poll.videoUrl)) {
          const message = poll.error ?? 'HeyGen returned no video.'
          replaceLayer({ status: 'error' })
          return err(`Avatar render failed: ${message}`)
        }

        // Deadline: a wedged HeyGen render must not be polled forever. Past the
        // wall-clock budget, flip the layer to `error` and surface a timeout so
        // the agent stops polling and can react (regenerate/skip) instead of an
        // avatar that silently never appears. Legacy layers without a start time
        // are never timed out (isAvatarExpired returns false).
        if (isAvatarExpired(layer.renderStartedAt, Date.now())) {
          replaceLayer({ status: 'error' })
          return err(avatarTimeoutMessage())
        }

        // Still rendering.
        return ok(foundScene.id, 'Avatar is still rendering on HeyGen — poll again in ~30s.', {
          done: false,
          status: 'processing',
          layerId: layer.id,
        })
      }

      default:
        return err(`Unknown avatar tool: ${toolName}`)
    }
  }
}
