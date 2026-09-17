import type { ToolResult } from '@/lib/agents/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene } from '@/lib/types'

/**
 * State-query tools.
 *
 * `describe_scene_state` answers "what is in this scene / video right now?"
 * WITHOUT code bodies. Before this, the agent's only options were
 * read_scene_code (returns up to ~50KB of source per scene) or verify_scene
 * (spins an offscreen render) — both absurdly expensive for structural
 * questions like "what layers exist?", "what's the z-order?", or "how long
 * is the video so far?". Token cost: a 20-layer scene summarizes in well
 * under 4KB (pinned by test).
 *
 * Read-only by contract: never mutates the world, never regenerates HTML.
 */

// inspect(kind) covers describe_scene_state / list_snapshots (plus read_scene_code and
// read_editor_state, which live in other handlers — tool-executor registers the router).
// rollback_to_snapshot MUTATES, so it stays its own tool.
export const STATE_QUERY_TOOL_NAMES = ['rollback_to_snapshot'] as const

const TEXT_PREVIEW_CHARS = 60

function preview(text: unknown): string {
  const s = typeof text === 'string' ? text : ''
  return s.length > TEXT_PREVIEW_CHARS ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…` : s
}

function codeLen(s: unknown): number {
  return typeof s === 'string' ? s.length : 0
}

/** Compact, code-free structural summary of one scene. */
function describeScene(scene: Scene, index: number) {
  const sc = scene as Scene & { reactCode?: string; canvasBackgroundCode?: string }
  const renderers: Array<{ kind: string; codeChars: number }> = []
  if (codeLen(sc.reactCode) > 0) renderers.push({ kind: 'react', codeChars: codeLen(sc.reactCode) })
  if (codeLen(scene.sceneCode) > 0) renderers.push({ kind: 'sceneCode', codeChars: codeLen(scene.sceneCode) })
  if (codeLen(scene.svgContent) > 0) renderers.push({ kind: 'svg', codeChars: codeLen(scene.svgContent) })
  if (codeLen(scene.canvasCode) > 0) renderers.push({ kind: 'canvas2d', codeChars: codeLen(scene.canvasCode) })
  if (codeLen(sc.canvasBackgroundCode) > 0)
    renderers.push({ kind: 'canvasBackground', codeChars: codeLen(sc.canvasBackgroundCode) })
  if (codeLen(scene.lottieSource) > 0) renderers.push({ kind: 'lottie', codeChars: codeLen(scene.lottieSource) })

  const hiddenIds = new Set(scene.layerHiddenIds ?? [])

  return {
    index,
    id: scene.id,
    name: scene.name,
    sceneType: scene.sceneType,
    durationSec: scene.duration,
    bgColor: scene.bgColor,
    transition: scene.transition,
    renderers,
    textOverlays: (scene.textOverlays ?? []).map((t) => {
      const o = t as unknown as Record<string, unknown>
      return {
        id: o.id,
        text: preview(o.text),
        hidden: hiddenIds.has(String(o.id)),
      }
    }),
    svgObjects: (scene.svgObjects ?? []).map((s) => {
      const o = s as unknown as Record<string, unknown>
      return { id: o.id, label: o.label ?? o.name ?? null, hidden: hiddenIds.has(String(o.id)) }
    }),
    aiLayers: (scene.aiLayers ?? []).map((l) => {
      const o = l as unknown as Record<string, unknown>
      return {
        id: o.id,
        type: o.type,
        prompt: preview(o.prompt),
        hasAsset: !!(o.imageUrl || o.stickerUrl || o.videoUrl),
        hidden: hiddenIds.has(String(o.id)),
      }
    }),
    chartLayerCount: (scene.chartLayers ?? []).length,
    interactionCount: (scene.interactions ?? []).length,
    cameraMoveCount: (scene.cameraMotion ?? []).length,
    // Real layer fields: VideoLayer is {enabled, src}; narration lives at
    // audioLayer.tts (set by add_narration). There is no .url/.narration.
    hasVideoLayer: !!(
      (scene.videoLayer as unknown as { enabled?: boolean; src?: string | null } | null)?.enabled &&
      (scene.videoLayer as unknown as { enabled?: boolean; src?: string | null } | null)?.src
    ),
    audio: {
      narration: !!(scene.audioLayer as unknown as { tts?: unknown } | null)?.tts,
      music: !!(scene.audioLayer as unknown as { music?: unknown } | null)?.music,
      sfxCount: Array.isArray((scene.audioLayer as unknown as { sfx?: unknown[] } | null)?.sfx)
        ? ((scene.audioLayer as unknown as { sfx: unknown[] }).sfx?.length ?? 0)
        : 0,
    },
    /** Top-to-bottom stack order when the user has rearranged layers. */
    layerPanelOrder: scene.layerPanelOrder ?? null,
  }
}

/**
 * Rollback target resolution: NAMED checkpoints are the curated,
 * agent-visible points (created before destructive ops). When none exist yet,
 * fall back to the most recent per-tool pre-snapshot ("before:<tool>") so
 * "undo my last change" still works early in a run — documented fallback, not
 * a leak of the whole noisy history into list_snapshots.
 */
function checkpointSummaries(world: WorldStateMutable) {
  return (world.checkpoints ?? []).map((c) => ({
    id: c.id,
    label: c.description,
    timestamp: c.timestamp,
    sceneCount: c.scenes.length,
  }))
}

export function createStateQueryToolHandler() {
  return async function handleStateQueryTool(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
  ): Promise<ToolResult> {
    if (toolName === 'list_snapshots') {
      const checkpoints = checkpointSummaries(world)
      return {
        success: true,
        affectedSceneId: null,
        data: {
          checkpoints,
          note:
            checkpoints.length === 0
              ? 'No named checkpoints yet — they are created automatically before destructive operations. rollback_to_snapshot with no id falls back to the state before the last tool call.'
              : undefined,
        },
      }
    }

    if (toolName === 'rollback_to_snapshot') {
      const { restoreSnapshot } = await import('@/lib/agents/tool-executor')
      const checkpointId = typeof args.checkpointId === 'string' ? args.checkpointId : null
      const named = world.checkpoints ?? []
      let target = checkpointId ? (named.find((c) => c.id === checkpointId) ?? null) : (named[named.length - 1] ?? null)
      let usedFallback = false
      if (!target && !checkpointId) {
        // Documented fallback: the per-tool pre-snapshot of the last tool call.
        // CRITICAL subtlety: executeTool creates a
        // `before:rollback_to_snapshot` snapshot for THIS very call before the
        // handler runs — taking the literal last entry would "restore" the
        // current state and report success while undoing nothing. Skip the
        // state-query tools' own pre-snapshots and take the newest one created
        // before a real (potentially mutating) tool.
        const ownSnapshots = new Set(STATE_QUERY_TOOL_NAMES.map((n) => `before:${n}`))
        const perTool = world.snapshots ?? []
        for (let i = perTool.length - 1; i >= 0; i--) {
          if (!ownSnapshots.has(perTool[i].description)) {
            target = perTool[i]
            break
          }
        }
        usedFallback = !!target
      }
      if (!target) {
        const available = checkpointSummaries(world)
          .map((c) => `"${c.label}" (${c.id.slice(0, 8)})`)
          .join(', ')
        return {
          success: false,
          error: checkpointId
            ? `Checkpoint ${checkpointId} not found. Available: ${available || 'none'}`
            : 'No checkpoints or snapshots exist yet — nothing to roll back to.',
        }
      }

      // Pre-restore HTML map: only scenes whose sceneHTML actually changes get
      // their disk file rewritten below.
      const htmlBefore = new Map(world.scenes.map((s) => [s.id, s.sceneHTML]))
      restoreSnapshot(world, target)

      // World↔disk reconciliation: verify_scene
      // and capture render the DISK file (dreambyte://scenes/{id}.html). A
      // memory-only restore leaves disk holding the rolled-AWAY code, so the
      // agent would re-verify — and "confirm" — the exact version it just
      // discarded. Write each restored scene's HTML back and drop its stale
      // playback errors. Best-effort per scene; failures are reported, not
      // silently swallowed.
      const diskFailures: string[] = []
      try {
        const [{ default: path }, fsMod, { resolveScenesDir }, { clearSceneErrors }] = await Promise.all([
          import('node:path'),
          import('node:fs/promises'),
          import('@/lib/scene-html-paths'),
          import('@/lib/agents/scene-error-buffer'),
        ])
        const fs = fsMod.default ?? fsMod
        const scenesDir = resolveScenesDir()
        await fs.mkdir(scenesDir, { recursive: true })
        for (const scene of world.scenes) {
          if (!scene.sceneHTML || htmlBefore.get(scene.id) === scene.sceneHTML) continue
          try {
            const finalPath = path.join(scenesDir, `${scene.id}.html`)
            const tmpPath = `${finalPath}.tmp-rollback`
            await fs.writeFile(tmpPath, scene.sceneHTML, 'utf-8')
            await fs.rename(tmpPath, finalPath)
            clearSceneErrors(scene.id)
          } catch {
            diskFailures.push(scene.name || scene.id.slice(0, 8))
          }
        }
      } catch {
        diskFailures.push('(scene file writes unavailable in this environment)')
      }

      return {
        success: true,
        affectedSceneId: null,
        changes: [
          {
            type: 'global_updated',
            description: `Rolled back to ${usedFallback ? 'the state before the last tool call' : `checkpoint "${target.description}"`} (${target.scenes.length} scenes restored, previews updated on disk${diskFailures.length > 0 ? `; HTML rewrite failed for: ${diskFailures.join(', ')}` : ''}). AI layers restore by value — existing asset URLs come back as-is, nothing is regenerated.`,
          },
        ],
        data: {
          restoredCheckpointId: target.id,
          restoredLabel: target.description,
          usedFallback,
          ...(diskFailures.length > 0 ? { diskFailures } : {}),
        },
      }
    }

    if (toolName !== 'describe_scene_state') {
      return { success: false, error: `Unknown state-query tool: ${toolName}` }
    }

    const sceneId = typeof args.sceneId === 'string' && args.sceneId.length > 0 ? args.sceneId : null
    const totalDurationSec = world.scenes.reduce((sum, s) => sum + (s.duration || 0), 0)

    if (sceneId) {
      const idx = world.scenes.findIndex((s) => s.id === sceneId)
      if (idx === -1) {
        const available = world.scenes.map((s) => `${s.name} (${s.id.slice(0, 8)})`).join(', ')
        return {
          success: false,
          error: `Scene ${sceneId} not found. Available scenes: ${available || 'none'}`,
        }
      }
      return {
        success: true,
        affectedSceneId: null, // read-only — nothing changed
        data: {
          scene: describeScene(world.scenes[idx], idx),
          project: { sceneCount: world.scenes.length, totalDurationSec },
        },
      }
    }

    // Project-level: every scene's compact summary + total runtime.
    return {
      success: true,
      affectedSceneId: null,
      data: {
        scenes: world.scenes.map((s, i) => describeScene(s, i)),
        project: { sceneCount: world.scenes.length, totalDurationSec },
      },
    }
  }
}
