import type { AgentLogger } from '@/lib/agents/logger'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { ok, err, findScene, updateScene, type ToolResult } from './_shared'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'

/**
 * P1b-fanout-remaining (asset-media): emit `audio/setLayer` and
 * `scene/update` for the audio/video layer setters.
 */

export const ASSET_MEDIA_TOOL_NAMES = [
  // set_media_layer(kind) is the MODEL-facing name; both original cases stay below and
  // the router maps kind → the case, so the two layers' distinct fields are unchanged.
  'set_media_layer',
  // request_screen_recording is GONE — same reason as publish_interactive: no
  // schema meant the gate rejected it before its honest refusal could run.
  // start_recording is the live entry point.
  'use_asset_in_scene',
  'add_watermark',
] as const

export function createAssetMediaToolHandler(deps: {
  checkApiPermission: (
    world: WorldStateMutable,
    api: string,
    context?: { reason?: string; details?: Record<string, any> },
  ) => ToolResult | null | Promise<ToolResult | null>
  regenerateHTML: (world: WorldStateMutable, sceneId: string, logger?: AgentLogger) => Promise<{ htmlWritten: boolean }>
}) {
  return async function handleAssetMediaTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: AgentLogger,
  ): Promise<ToolResult> {
    // set_media_layer(kind) → the two original op names the switch below dispatches on.
    if (toolName === 'set_media_layer') {
      const kind = (args as { kind?: string }).kind
      if (kind !== 'audio' && kind !== 'video') {
        return { success: false, error: `set_media_layer: unknown kind "${String(kind)}" — expected video or audio.` }
      }
      toolName = kind === 'audio' ? 'set_audio_layer' : 'set_video_layer'
    }
    switch (toolName) {
      case 'set_audio_layer': {
        const { sceneId, src, volume, fadeIn, fadeOut, startOffset } = args as {
          sceneId: string
          src?: string | null
          volume?: number
          fadeIn?: boolean
          fadeOut?: boolean
          startOffset?: number
        }
        // Only check ElevenLabs permission when setting a new audio source. Skipped in
        // sandbox: assigning a src URL calls no provider, so the fail-closed guard here
        // is a pure false positive that would break a $0 run (sandbox done-right).
        if (src != null && !world.sandboxMode) {
          const permErr = await deps.checkApiPermission(world, 'elevenLabs', {
            reason: 'Set scene audio source',
          })
          if (permErr) return permErr
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        const priorAudio = scene.audioLayer
        const audioLayer = {
          ...scene.audioLayer,
          enabled: src != null,
          src: src ?? null,
          volume: volume ?? scene.audioLayer?.volume ?? 1,
          fadeIn: fadeIn ?? scene.audioLayer?.fadeIn ?? false,
          fadeOut: fadeOut ?? scene.audioLayer?.fadeOut ?? false,
          startOffset: startOffset ?? scene.audioLayer?.startOffset ?? 0,
        }
        updateScene(world, sceneId, { audioLayer })
        emitAgentAction(
          { type: 'audio/setLayer', params: { sceneId, patch: audioLayer, prior: priorAudio } },
          emitterDeps(world),
        )
        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, `Updated audio layer`)
      }

      case 'set_video_layer': {
        const { sceneId, src, opacity, trimStart, trimEnd } = args as {
          sceneId: string
          src?: string | null
          opacity?: number
          trimStart?: number
          trimEnd?: number | null
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        // Reject dangerous schemes in the agent-supplied src —
        // relative paths and http(s)/dreambyte/blob/data:video are all legitimate, so
        // blocklist the unsafe ones rather than allowlist. The <video src> value
        // is also attribute-escaped in sceneTemplate.ts as defense-in-depth.
        if (src != null) {
          const lowered = src.trim().toLowerCase()
          const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lowered)?.[1]
          const dangerous =
            scheme === 'javascript' ||
            scheme === 'vbscript' ||
            scheme === 'file' ||
            lowered.startsWith('data:text/html')
          if (dangerous) {
            return err(`Refusing video src with unsafe scheme${scheme ? ` "${scheme}"` : ''}`)
          }
        }

        const priorVideoLayer = scene.videoLayer
        const videoLayer = {
          ...scene.videoLayer,
          enabled: src != null,
          src: src ?? null,
          opacity: opacity ?? scene.videoLayer?.opacity ?? 1,
          trimStart: trimStart ?? scene.videoLayer?.trimStart ?? 0,
          trimEnd: trimEnd !== undefined ? trimEnd : (scene.videoLayer?.trimEnd ?? null),
        }
        updateScene(world, sceneId, { videoLayer })
        emitAgentAction(
          {
            type: 'scene/update',
            params: { sceneId, patch: { videoLayer }, prior: { videoLayer: priorVideoLayer } },
          },
          emitterDeps(world),
        )
        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, `Updated video layer`)
      }

      case 'use_asset_in_scene': {
        const { assetId, usage, position } = args as {
          assetId: string
          usage: 'fullscreen' | 'overlay' | 'watermark' | 'background' | 'inline'
          position?: { x?: number; y?: number; width?: number; anchor?: string }
        }
        // Resolve the asset for real. The tool's contract is "returns the asset
        // URL + metadata to embed in scene HTML", so it must actually look the
        // asset up and FAIL when it's missing — the old version returned success
        // with no URL and never validated the id, so a wrong/stale assetId
        // silently produced nothing and the agent believed the asset was placed.
        if (!assetId) return err('assetId is required.')
        const projectId = world.projectId
        if (!projectId) return err('Project id is unavailable — cannot resolve the asset.')
        // Lazy imports: keep the DB connection out of this module's top-level so
        // importers that never touch the library (and tests) don't spin up libsql.
        const { db } = await import('@/lib/db')
        const { projectAssets } = await import('@/lib/db/schema')
        const { and, eq } = await import('drizzle-orm')
        let rows: Array<{
          type: string
          publicUrl: string | null
          thumbnailUrl: string | null
          width: number | null
          height: number | null
          name: string | null
        }>
        try {
          rows = await db
            .select({
              type: projectAssets.type,
              publicUrl: projectAssets.publicUrl,
              thumbnailUrl: projectAssets.thumbnailUrl,
              width: projectAssets.width,
              height: projectAssets.height,
              name: projectAssets.name,
            })
            .from(projectAssets)
            .where(and(eq(projectAssets.id, assetId), eq(projectAssets.projectId, projectId)))
            .limit(1)
        } catch (e) {
          return err(`Failed to look up asset ${assetId}: ${(e as Error).message}`)
        }
        const asset = rows[0]
        if (!asset) return err(`Asset ${assetId} not found in this project's media library.`)
        if (!asset.publicUrl) return err(`Asset ${assetId} has no usable URL yet (still generating?).`)
        return ok(
          null,
          `Asset "${asset.name ?? assetId}" (${asset.type}) resolved for ${usage} usage — embed it in the scene HTML using publicUrl.`,
          {
            assetId,
            usage,
            position,
            publicUrl: asset.publicUrl,
            thumbnailUrl: asset.thumbnailUrl,
            type: asset.type,
            width: asset.width,
            height: asset.height,
          },
        )
      }

      case 'add_watermark': {
        const {
          assetId,
          position: pos,
          opacity: op,
          sizePercent: sp,
        } = args as {
          assetId: string
          position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
          opacity?: number
          sizePercent?: number
        }
        // Validate the asset for real. The watermark renders via
        // the asset's publicUrl (sceneTemplate resolves assetId → publicUrl at
        // render time), so a wrong/stale assetId previously produced an
        // invisible watermark while the agent reported success.
        if (!assetId) return err('assetId is required.')
        const projectId = world.projectId
        if (!projectId) return err('Project id is unavailable — cannot resolve the watermark asset.')
        const { db } = await import('@/lib/db')
        const { projectAssets } = await import('@/lib/db/schema')
        const { and, eq } = await import('drizzle-orm')
        let rows: Array<{ publicUrl: string | null; name: string | null }>
        try {
          rows = await db
            .select({ publicUrl: projectAssets.publicUrl, name: projectAssets.name })
            .from(projectAssets)
            .where(and(eq(projectAssets.id, assetId), eq(projectAssets.projectId, projectId)))
            .limit(1)
        } catch (e) {
          return err(`Failed to look up watermark asset ${assetId}: ${(e as Error).message}`)
        }
        const asset = rows[0]
        if (!asset) return err(`Asset ${assetId} not found in this project's media library — no watermark was set.`)
        if (!asset.publicUrl) {
          return err(`Asset ${assetId} has no usable URL yet (still generating?) — no watermark was set.`)
        }
        const watermarkConfig = {
          assetId,
          position: pos || ('bottom-right' as const),
          opacity: typeof op === 'number' ? Math.max(0, Math.min(1, op)) : 0.8,
          sizePercent: typeof sp === 'number' ? Math.max(1, Math.min(50, sp)) : 12,
        }
        // Store on world state. Consumed for real: the in-app path
        // carries it on the final state_change (agent-runner.ts) → store
        // setWatermark → project.watermark; the MCP path persists it via
        // persistMcpSceneWrite's version-checked projects update.
        world.watermark = watermarkConfig
        return ok(
          null,
          `Watermark set: asset "${asset.name ?? assetId}" at ${watermarkConfig.position}, opacity ${watermarkConfig.opacity}, size ${watermarkConfig.sizePercent}%. It is injected into every scene at render and rides exports.`,
          { watermark: watermarkConfig },
        )
      }

      default:
        return err(`Unknown asset/media tool: ${toolName}`)
    }
  }
}
