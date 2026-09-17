/**
 * Shared utilities for tool handlers.
 *
 * Every handler file was duplicating ok(), err(), findScene(), and updateScene().
 * This module provides a single canonical implementation.
 */

import { v4 as uuidv4 } from 'uuid'
import type { Scene } from '@/lib/types'
import type { ToolResult, StateChange } from '@/lib/agents/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { emitAgentAction, emitterDepsForWorld } from './action-emitter'

// Re-export types that handlers need so they can import from a single location.
export type { ToolResult } from '@/lib/agents/types'
export type { WorldStateMutable } from '@/lib/agents/world-state'

// ── Result helpers ───────────────────────────────────────────────────────────

/** Return a success result tied to a specific scene. */
export function ok(affectedSceneId: string | null, description: string, data?: unknown): ToolResult {
  const change: StateChange = affectedSceneId
    ? { type: 'scene_updated', sceneId: affectedSceneId, description }
    : { type: 'global_updated', description }
  return { success: true, affectedSceneId, changes: [change], data }
}

/** Return a success result for a global (non-scene) operation. */
export function okGlobal(description: string, data?: unknown): ToolResult {
  return ok(null, description, data)
}

/** Return an error result. */
export function err(message: string): ToolResult {
  return { success: false, error: message }
}

/**
 * Fail-honest refusal for a tool whose downstream consumer does not exist.
 *
 * Several tools used to return ok() with an action payload or world-state
 * write that NOTHING consumes — the agent then told users something happened
 * when nothing did. Until a tool's consumer is actually wired (and pinned in
 * src/lib/agents/__tests__/tool-consumer-registry.test.ts), it must refuse via
 * this helper: success:false, a "Nothing was changed" lead so the model never
 * reports phantom success, and a hint telling it / the user what to do
 * instead. Keep the schema description in src/lib/agents/tools.ts in lockstep
 * ("NOT AVAILABLE from the agent yet — … do not call it").
 */
export function toolNotAvailable(toolName: string, hint: string): ToolResult {
  return {
    success: false,
    error: `Nothing was changed. "${toolName}" isn't available from the agent yet — ${hint}`,
  }
}

/**
 * Honor `regenerateHTML`'s `{ htmlWritten }` result instead of
 * discarding it. Many media/layer handlers mutate world state, call
 * `await regenerateHTML(...)`, and then return `ok(...)` unconditionally — so a
 * failed on-disk HTML write (abort mid-flight, bad sceneId, or a generate/verify
 * throw) was reported to the agent as full success. The layer IS in world state,
 * but the preview/export HTML on disk did NOT update, so the agent (and user)
 * believe a render landed that didn't.
 *
 * Pass the result of `regenerateHTML` and the success result you'd otherwise
 * return. When `htmlWritten` is false this returns a DEGRADED result: still
 * `success:true` (the layer mutation is real and the post-tool verify gate may
 * already carry the `_verify` signal) but with a prepended WARNING in the
 * description and an `htmlWritten:false` flag on `data`, so the model knows the
 * scene HTML didn't refresh and can re-run a write tool. We keep success:true
 * rather than false because the world-state change is committed and rolling the
 * tool back would orphan it — the honest signal is the warning, not a failure.
 */
export function degradeIfHtmlUnwritten(
  htmlResult: { htmlWritten: boolean; error?: string } | undefined | null,
  result: ToolResult,
): ToolResult {
  if (htmlResult && htmlResult.htmlWritten === false) {
    const reason = htmlResult.error ? ` (${htmlResult.error})` : ''
    const priorDesc =
      result.changes?.[0] && 'description' in result.changes[0]
        ? (result.changes[0] as { description?: string }).description
        : undefined
    const warned =
      `WARNING: the scene HTML did not update on disk${reason} — the layer is set but the preview/export render did not refresh. Re-run the write (e.g. regenerate_layer) before relying on this scene. ${priorDesc ?? ''}`.trim()
    const data =
      typeof result.data === 'object' && result.data !== null
        ? { ...(result.data as Record<string, unknown>), htmlWritten: false }
        : { htmlWritten: false }
    return {
      ...result,
      data,
      changes: result.changes?.map((c) => ('description' in c ? { ...c, description: warned } : c)),
    }
  }
  return result
}

// ── World-state helpers ──────────────────────────────────────────────────────

/** Find a scene by ID, or undefined if not found. */
export function findScene(world: WorldStateMutable, sceneId: string): Scene | undefined {
  return world.scenes.find((s) => s.id === sceneId)
}

/**
 * Fields whose change invalidates any cached runtime-verify outcome for the
 * scene. Anything that affects render output goes here. Kept narrow: a name
 * or transition change shouldn't force a re-render. If you add a new
 * code-bearing field to Scene, list it.
 *
 * Invalidation hooks into `updateScene` rather than a per-tool list so it is
 * tool-agnostic — every code mutation routes through here, so the cache can
 * never go stale.
 */
const VERIFY_CACHE_INVALIDATING_FIELDS: ReadonlyArray<keyof Scene> = [
  'sceneType',
  'sceneCode',
  'sceneStyles',
  'reactCode',
  'canvasCode',
  'canvasBackgroundCode',
  'svgContent',
  'svgObjects',
  'lottieSource',
  'chartLayers',
  'd3Data',
  'worldConfig',
  'aiLayers',
  'textOverlays',
  'sceneHTML',
  'bgColor',
  'duration',
]

/** Update a scene in-place, returning the updated scene or null if not found. */
export function updateScene(world: WorldStateMutable, sceneId: string, updates: Partial<Scene>): Scene | null {
  const idx = world.scenes.findIndex((s) => s.id === sceneId)
  if (idx === -1) return null
  const prevScene = world.scenes[idx] as unknown as Record<string, unknown>
  const updated = { ...world.scenes[idx], ...updates }
  // Keep D3 structured data coherent when scene type changes away from d3.
  if (updates.sceneType && updates.sceneType !== 'd3') {
    updated.chartLayers = []
    updated.d3Data = null
  }
  world.scenes[idx] = updated

  // Invalidate runtime-verify cache if any render-affecting field changed.
  // The cache lets verify_scene skip a
  // redundant offscreen render when the auto-runtime-verify post-hook
  // already verified the scene. But if the scene's code changes after the
  // cache was written, the cached outcome is stale and would produce a
  // false PASS. Drop the entry — verify_scene will re-render against the
  // new state.
  if (world.recentRuntimeVerify?.[sceneId]) {
    const touchedRender = VERIFY_CACHE_INVALIDATING_FIELDS.some((field) => {
      const next = (updates as Record<string, unknown>)[field as string]
      if (!(field in updates) || next === undefined) return false
      // An identical primitive (e.g. regenerated sceneHTML that didn't change)
      // isn't a render change. Objects always count: callers often mutate a
      // layer array in place and pass the same reference back.
      return typeof next === 'object' || next !== prevScene[field as string]
    })
    if (touchedRender) {
      delete world.recentRuntimeVerify[sceneId]
    }
  }

  return updated
}

// ── Action-log emit helper ───────────────────────────────────────────────────

/**
 * Emit a `scene/update` action by diffing the pre-mutation snapshot against
 * the post-mutation scene currently in `world`. Auto-discovers every changed
 * top-level field (including side-effects `updateScene` applies, e.g.
 * clearing `chartLayers` when `sceneType` moves away from 'd3'). Callers
 * capture `before = findScene(...)` BEFORE mutation, then call this AFTER.
 * No-op if nothing changed or the scene was deleted.
 *
 * P1b-fanout: this is the single emit path every layer/scene-mutating tool
 * uses. Centralizing it here means new handlers get correct prior-snapshots
 * for free instead of hand-rolling per-field captures.
 *
 * ── INVARIANT — Detection uses referential equality (`a !== b`) ─────────────
 *
 * `updateScene` always REPLACES the scene at its array slot with a new
 * object via `{ ...world.scenes[idx], ...updates }`, so `before` continues
 * to point at the pre-mutation object while `after` is the new one. Top-
 * level fields the caller passed in `updates` become new references; the
 * diff detects them. Side-effects in `updateScene` (e.g., clearing
 * `chartLayers` on sceneType change) also create new references → detected.
 *
 * A tool that mutates nested arrays/objects in place WILL produce a silent
 * no-op emit:
 *   // BAD — invisible to the diff:
 *   scene.svgObjects[0].opacity = 0.5
 *   updateScene(world, sceneId, { svgObjects: scene.svgObjects })
 *   emitSceneUpdate(world, sceneId, scene) // scene.svgObjects === scene.svgObjects
 *
 *   // GOOD — new array reference:
 *   updateScene(world, sceneId, {
 *     svgObjects: scene.svgObjects.map(o => o.id === id ? { ...o, opacity: 0.5 } : o)
 *   })
 *   emitSceneUpdate(world, sceneId, scene)
 *
 * Every existing call site uses the GOOD pattern (verified). If you add a
 * new emit and undo "doesn't see" the change, this is why.
 */
export function emitSceneUpdate(world: WorldStateMutable, sceneId: string, before: Scene): void {
  const after = world.scenes.find((s) => s.id === sceneId)
  if (!after) return
  const patch: Record<string, unknown> = {}
  const prior: Record<string, unknown> = {}
  // Cast via `unknown` first — Scene has no index signature, so TS refuses
  // the direct conversion to Record<string, unknown>. Behaviour is the
  // same; this satisfies the typechecker without weakening the public type.
  const afterIdx = after as unknown as Record<string, unknown>
  const beforeIdx = before as unknown as Record<string, unknown>
  for (const key of Object.keys(after)) {
    const a = afterIdx[key]
    const b = beforeIdx[key]
    if (a !== b) {
      patch[key] = a
      prior[key] = b
    }
  }
  if (Object.keys(patch).length === 0) return
  emitAgentAction(
    { type: 'scene/update', params: { sceneId, patch: patch as Partial<Scene>, prior: prior as Partial<Scene> } },
    emitterDepsForWorld(world),
  )
}

// ── Image layer insertion ─────────────────────────────────────────────────────

/**
 * Insert a ready `image` AI-layer so it renders as a visible overlay via
 * `generateAILayersHTML` (works on any scene type, incl. react). Mirrors
 * `place_image`'s insertion path: append to `aiLayers` via `updateScene` + emit
 * a `layer/add` action for undo. Used by Sandbox substitutions so a placeholder
 * avatar/image/video actually APPEARS in the scene (not just returned as a URL).
 * `x`/`y` are the layer CENTER. Returns the new layer id, or null if the scene
 * is missing.
 */
export function insertImageLayer(
  world: WorldStateMutable,
  sceneId: string,
  opts: { imageUrl: string; x: number; y: number; width: number; height: number; label: string; zIndex?: number },
): string | null {
  const scene = world.scenes.find((s) => s.id === sceneId)
  if (!scene) return null
  const layer = {
    id: uuidv4(),
    type: 'image' as const,
    prompt: opts.label,
    model: 'flux-1.1-pro' as const,
    style: null,
    imageUrl: opts.imageUrl,
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: opts.height,
    rotation: 0,
    opacity: 1,
    zIndex: opts.zIndex ?? 50,
    status: 'ready' as const,
    label: opts.label,
  }
  updateScene(world, sceneId, { aiLayers: [...(scene.aiLayers ?? []), layer as unknown as Scene['aiLayers'][number]] })
  emitAgentAction(
    { type: 'layer/add', params: { sceneId, layerId: layer.id, layer: layer as unknown as Scene['aiLayers'][number] } },
    emitterDepsForWorld(world),
  )
  return layer.id
}

// ── Spend ledger commit (image / FAL-avatar / media-library) ──────────────

/**
 * Per-world pending tool spend, in USD, keyed by the WorldStateMutable object
 * the tool ran against. This is the side-channel that lets a MEDIA
 * generation's cost — committed here by `commitMediaSpend` DURING handler
 * execution — reach the runner's in-memory `RunCostLedger` (the ledger that
 * actually stops a run at the cap). The DB `apiSpend` ledger that `logSpend`
 * writes is a SEPARATE, project-scoped ledger; it is NOT the run cost cap, so
 * without this bridge a media-only run could bill past its cap and never stop.
 *
 * A WeakMap keyed by `world` (rather than a field on WorldStateMutable) keeps
 * the accumulator off the JSON-cloned world shape and out of tool-executor.ts:
 * parallel batches clone the world, so the runner drains the SAME world object
 * it passed to `executeTool` (see `drainToolSpend`). Entries auto-GC with the
 * world.
 */
const pendingToolSpendUsd = new WeakMap<object, number>()

/**
 * Drain and zero the pending tool spend accumulated against `world` since the
 * last drain. The runner calls this immediately after each `executeTool` (using
 * the exact world reference the tool ran on) and commits the returned amount to
 * the run cost ledger. Returns 0 for a world with no accumulated media spend.
 */
export function drainToolSpend(world: object): number {
  const v = pendingToolSpendUsd.get(world) ?? 0
  if (v !== 0) pendingToolSpendUsd.set(world, 0)
  return v
}

/**
 * Per-world count of paid VISUAL/VIDEO generation dispatches since the last drain
 * — the count analog of `pendingToolSpendUsd`. Counted at the executeTool choke
 * point (every dispatch, INCLUDING $0/sandbox/free-provider ones the dollar
 * ledger skips) and drained per-tool by the runner into the shared RunCostLedger's
 * mediaGenCount, so a runaway media loop that never bills is still bounded.
 */
const pendingMediaGenCount = new WeakMap<object, number>()

/** Note one paid visual/video generation dispatched against `world` (regardless of
 *  whether it billed). Called from executeTool for MEDIA_GEN_COUNT_SET tools. */
export function noteMediaGenDispatch(world: object): void {
  pendingMediaGenCount.set(world, (pendingMediaGenCount.get(world) ?? 0) + 1)
}

/** Drain and zero the media-gen dispatch count accumulated against `world`. The
 *  runner commits the returned count to the run's shared mediaGenCount. */
export function drainMediaGenCount(world: object): number {
  const v = pendingMediaGenCount.get(world) ?? 0
  if (v !== 0) pendingMediaGenCount.set(world, 0)
  return v
}

/**
 * Commit a paid MEDIA generation's spend to (1) the per-project apiSpend ledger
 * (so the session/monthly caps accumulate — mirrors what audio-tools.ts does for
 * narration/SFX/music and the IPC services do) AND (2) the per-world pending-spend
 * accumulator that feeds the runner's RUN cost cap.
 *
 * The image + FAL-avatar agent handlers call the paid provider DIRECTLY (generateImage /
 * AvatarService.generate) and never went through a service that bills — so without this the
 * caps would stay $0 and never fire. The DB apiSpend ledger reads ONLY
 * logSpend, and — critically — the runner's in-memory RunCostLedger reads NEITHER of those;
 * it reads the pending-spend accumulator drained per tool. So this is the one write that
 * makes a paid agent media call bind against BOTH the dollar ledger and the run cap.
 *
 * Cost basis: the generation result reports its ACTUAL USD cost (generateImage → `cost`,
 * AvatarService.generate → `costUsd`). We log that directly — NOT a re-estimate — so the ledger
 * matches what the provider charged. A $0 cost (sandbox placeholder, cache hit, free provider)
 * is skipped: it neither billed nor should advance the cap.
 *
 * apiName MUST be the dedicated billing identity for the provider (per src/lib/permissions
 * API_COST_SCALARS) — e.g. 'imageGen' for fal/OpenAI images, 'falAvatar' for musetalk/fabric/
 * aurora. Never reuse a cheaper apiName (the project's misbilling learning).
 *
 * Best-effort: a ledger-write failure must NOT lose the already-generated (already-paid) asset,
 * so it is swallowed (and warned) rather than thrown. The run-cap accumulation happens
 * regardless of the DB write outcome — the cost was incurred either way.
 */
export async function commitMediaSpend(
  world: WorldStateMutable,
  apiName: string,
  costUsd: number,
  description: string,
  opts?: { skipDbLog?: boolean },
): Promise<void> {
  if (!(costUsd > 0) || !Number.isFinite(costUsd)) return // $0 / cache hit / sandbox → nothing billed
  // Feed the RUN cost cap first — this is independent of a project id (a
  // project-less MCP/subagent context still spent real money that the run cap
  // must see) and of the DB write succeeding.
  pendingToolSpendUsd.set(world, (pendingToolSpendUsd.get(world) ?? 0) + costUsd)
  // skipDbLog: the caller (avatar / async video) ALREADY logged this spend to the
  // per-project apiSpend ledger itself — here we only need the RUN ledger to see it,
  // so writing logSpend again would double-count the project ledger.
  if (opts?.skipDbLog) return
  if (!world.projectId) return // no project to bill against the DB ledger (some MCP/subagent contexts)
  try {
    const { logSpend } = await import('@/lib/db')
    await logSpend(world.projectId, apiName, costUsd, description)
  } catch (e) {
    const { createLogger } = await import('@/lib/logger')
    createLogger('agent.commit-media-spend').warn('logSpend failed (asset already generated)', {
      extra: { apiName, costUsd },
      error: e,
    })
  }
}
