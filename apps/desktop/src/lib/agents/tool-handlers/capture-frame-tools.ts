/**
 * Visual-feedback tools: capture_frame (structured scene snapshot) and review_video (whole-cut review input).
 *
 * Extracted from tool-executor.ts — the handler body is unchanged;
 * only the registration wiring moved. Relative dynamic imports were
 * rewritten to `@/` aliases since this file lives one directory deeper.
 */
import { resolveProjectDimensions } from '@/lib/dimensions'
import { buildAudioTimingText } from '../services/audio-timing-text'
import type { AgentLogger } from '../logger'
import type { ToolResult, WorldStateMutable } from './_shared'
import type { buildCutReviewInput as BuildCutReviewInput } from '../tool-executor'

// review(scope) is the MODEL-facing name. Both handler cases only VALIDATE and return
// a clientAction stub — the real work is the runner's interception, which still keys on
// the two original clientAction values, so those branches are untouched.
export const CAPTURE_FRAME_TOOL_NAMES = ['capture_frame', 'review'] as const

interface CaptureFrameToolDeps {
  buildCutReviewInput: typeof BuildCutReviewInput
}

export function createCaptureFrameToolHandler(deps: CaptureFrameToolDeps) {
  const { buildCutReviewInput } = deps
  return async function handleCaptureFrameTools(
    toolName: string,
    args: Record<string, unknown>,
    w: WorldStateMutable,
    _logger?: AgentLogger,
  ): Promise<ToolResult> {
    // review(scope) → the two original op names the switch below dispatches on.
    if (toolName === 'review') {
      const scope = (args as { scope?: string }).scope ?? 'cut'
      if (scope !== 'cut' && scope !== 'motion') {
        return { success: false, error: `review: unknown scope "${String(scope)}" — expected cut or motion.` }
      }
      toolName = scope === 'motion' ? 'review_scene_motion' : 'review_video'
    }
    switch (toolName) {
      case 'capture_frame': {
        const world = w as WorldStateMutable
        const { sceneId, time } = args as { sceneId: string; time?: number }
        const scene = world.scenes.find((s) => s.id === sceneId)
        if (!scene) return { success: false, error: `Scene ${sceneId} not found` }

        // Build a structured description of the scene's visual state
        const layers: string[] = []
        const t = Math.max(0, time ?? 1)

        // Main renderer
        if (scene.sceneType) layers.push(`Main renderer: ${scene.sceneType}`)
        if (scene.svgContent) layers.push(`SVG content: ${scene.svgContent.length} chars`)
        if (scene.canvasCode) layers.push(`Canvas2D code: ${scene.canvasCode.length} chars`)
        if (scene.sceneCode) layers.push(`Scene code (${scene.sceneType}): ${scene.sceneCode.length} chars`)

        // Text overlays
        for (const t of scene.textOverlays ?? []) {
          layers.push(
            `Text overlay "${t.content?.slice(0, 40) ?? ''}" at (${t.x ?? 0}%, ${t.y ?? 0}%) size=${t.size ?? 24}px color=${t.color ?? '#fff'} animation=${t.animation ?? 'none'}`,
          )
        }

        // SVG objects
        for (const obj of scene.svgObjects ?? []) {
          layers.push(
            `SVG object at (${obj.x ?? 0}%, ${obj.y ?? 0}%) width=${obj.width ?? 10}% opacity=${obj.opacity ?? 1}`,
          )
        }

        // AI layers
        for (const ai of scene.aiLayers ?? []) {
          layers.push(
            `AI layer "${ai.type}" at (${Math.round(ai.x ?? 0)}, ${Math.round(ai.y ?? 0)}) ${Math.round(ai.width ?? 0)}x${Math.round(ai.height ?? 0)} opacity=${ai.opacity ?? 1} startAt=${ai.startAt ?? 0}s`,
          )
        }

        // Chart layers
        for (const ch of (scene as any).chartLayers ?? []) {
          layers.push(`Chart "${ch.chartType ?? 'unknown'}" title="${ch.title ?? ''}"`)
        }

        // Video layer
        if (scene.videoLayer?.enabled && scene.videoLayer.src) {
          layers.push(
            `Video layer: ${scene.videoLayer.src.slice(0, 60)} opacity=${scene.videoLayer.opacity ?? 1} trim=${scene.videoLayer.trimStart ?? 0}-${scene.videoLayer.trimEnd ?? 'end'}`,
          )
        }

        // Audio
        if (scene.audioLayer?.enabled) {
          const al = scene.audioLayer
          const parts: string[] = []
          if (al.src) parts.push(`audio: ${al.src.slice(0, 40)}`)
          if ((al as any).tts?.src) parts.push(`TTS narration`)
          if ((al as any).music?.src) parts.push(`background music`)
          if ((al as any).sfx?.length) parts.push(`${(al as any).sfx.length} SFX`)
          if (parts.length) layers.push(`Audio: ${parts.join(', ')}`)
        }

        // Camera motion
        if (scene.cameraMotion?.length) {
          layers.push(`Camera: ${scene.cameraMotion.map((m: any) => m.type).join(' → ')}`)
        }

        // Code-level checks for common issues
        const codeIssues: string[] = []
        const code = scene.sceneCode || scene.canvasCode || scene.svgContent || ''
        if (code.length > 0) {
          if (code.includes('Math.random()') && !code.includes('mulberry32') && scene.sceneType === 'canvas2d') {
            codeIssues.push('Uses Math.random() instead of seeded PRNG — will produce different results each render')
          }
          if (code.includes('setInterval') || code.includes('requestAnimationFrame')) {
            if (!code.includes('clearInterval') && !code.includes('cancelAnimationFrame')) {
              codeIssues.push('Has setInterval/rAF without cleanup — may leak when scene ends')
            }
          }
          if (scene.sceneType === 'svg' && code.includes('<svg') && !code.includes('viewBox')) {
            codeIssues.push('SVG missing viewBox attribute — may not scale correctly')
          }
          if (scene.sceneType === 'd3' && code.includes('d3.event')) {
            codeIssues.push('Uses d3.event (removed in D3 v7) — use event parameter in callbacks instead')
          }
        }

        const description = [
          `Scene "${scene.name}" (${scene.id.slice(0, 8)}…)`,
          `Type: ${scene.sceneType ?? 'svg'} | Duration: ${scene.duration}s | BG: ${scene.bgColor}`,
          `Capture time: ${t}s`,
          (() => {
            const d = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
            return `Dimensions: ${d.width}×${d.height}`
          })(),
          '',
          `Layers (${layers.length}):`,
          ...layers.map((l) => `  • ${l}`),
          ...(codeIssues.length > 0
            ? ['', `Code issues (${codeIssues.length}):`, ...codeIssues.map((i) => `  ⚠ ${i}`)]
            : []),
        ].join('\n')

        return {
          success: true,
          affectedSceneId: sceneId,
          data: {
            clientAction: 'capture_frame',
            sceneId,
            time: t,
            description,
            codeIssueCount: codeIssues.length,
          },
        }
      }

      // ── Review the whole cut (Gap 2) ──
      // Returns the ordered, capped scene set for the runner to capture + vision-review.
      // The runner intercepts clientAction:'review_video' (it needs emit + the cost
      // ledger); this handler only reads the live scenes. On a non-runner path the
      // default reviewBrief note survives, so the caller learns it wasn't reviewed.
      case 'review_video': {
        const world = w as WorldStateMutable
        const scenes = world.scenes ?? []
        if (scenes.length === 0) return { success: false, error: 'No scenes to review yet — build the cut first.' }
        const { sceneIds, timing } = buildCutReviewInput(scenes)
        return {
          success: true,
          data: {
            clientAction: 'review_video',
            sceneIds,
            timing,
            // Overwritten by the runner once the cut is actually reviewed. If this
            // survives, the tool ran on a path without the runner capture round-trip.
            reviewBrief: { reviewable: false, findings: [], note: 'Cut review runs only on the in-app agent path.' },
          },
        }
      }

      // ── Review how ONE scene actually plays (motion + audio-sync) ──
      // Validates the target scene and gathers the prompt context (timing,
      // narration) + the fallback audio-timing text. The runner intercepts
      // clientAction:'review_scene_motion' (it needs emit + the cost ledger +
      // engine resolution + the clip round-trip); this handler only reads the
      // live scene. On a non-runner path the default reviewBrief note survives.
      case 'review_scene_motion': {
        const world = w as WorldStateMutable
        const { sceneId } = args as { sceneId?: string }
        if (!sceneId || typeof sceneId !== 'string') {
          return { success: false, error: 'review_scene_motion requires a sceneId' }
        }
        const scene = world.scenes.find((s) => s.id === sceneId)
        if (!scene) return { success: false, error: `Scene ${sceneId} not found` }
        const narration = scene.audioLayer?.tts?.text?.trim() || undefined
        return {
          success: true,
          affectedSceneId: sceneId,
          data: {
            clientAction: 'review_scene_motion',
            sceneId,
            scene: {
              name: scene.name ?? 'Scene',
              durationSec: typeof scene.duration === 'number' ? scene.duration : 0,
              narration,
            },
            // Fallback-path-only context (Gemini hears the muxed audio directly).
            audioTimingText: buildAudioTimingText(scene),
            // Overwritten by the runner once the scene is actually reviewed. If this
            // survives, the tool ran on a path without the runner clip round-trip.
            reviewBrief: {
              reviewable: false,
              findings: [],
              note: 'Motion review runs only on the in-app agent path.',
            },
          },
        }
      }

      default:
        return { success: false, error: `Unknown capture tool: ${toolName}` }
    }
  }
}
