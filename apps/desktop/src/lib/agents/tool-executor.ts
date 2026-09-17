/**
 * Tool execution engine for the Dreambyte agent system.
 *
 * Each tool creates a snapshot before execution, performs the operation
 * against the world state (passed as mutable objects), and returns a
 * structured result with success/failure and affected scene info.
 *
 * Note: This module is SERVER-SIDE only and should be used inside API routes.
 * It does NOT directly access the Zustand store — instead it operates on
 * plain Scene[] and GlobalStyle objects, returning updated versions that
 * the API route then forwards to the client to apply via store actions.
 */

import { v4 as uuidv4 } from 'uuid'
import fs from 'fs/promises'
import { createLogger } from '../logger'

const log = createLogger('agent.tool-executor')
import path from 'path'
import type { Scene, GlobalStyle, SceneType, APIPermissions, SceneGraph, ZdogPersonAsset } from '../types'
import type { ToolResult, StateSnapshot } from './types'
import type { AgentLogger } from './logger'
import { toolRegistry } from './tool-registry'
import type { ClaudeToolDefinition } from './types'
import { generateSceneHTML } from '../sceneTemplate'
import { resolveProjectDimensions } from '../dimensions'
import type { CutSceneTiming } from './services/cut-review'
import { resolveStyle } from '../styles/presets'

/** Cut-review (Gap 2): max scenes sampled into the one-frame-per-scene contact sheet. */
const MAX_REVIEW_FRAMES = 12

/** Evenly sample at most `n` items across `arr` (keeps first + last). Used to cap the
 *  review contact sheet on long cuts without clustering at one end. */
function evenSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr
  if (n <= 1) return arr.slice(0, n)
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))])
  return out
}

/** Build the cut-review capture input from the current cut: one representative
 *  frame per scene (even-sampled to MAX_REVIEW_FRAMES on long cuts), with the live
 *  per-scene timing. `timing[i]` corresponds to `sceneIds[i]`. Shared by the
 *  on-demand `review_video` tool and the post-build cut-review coordinator so both
 *  sample the cut identically. */
export function buildCutReviewInput(scenes: Scene[]): { sceneIds: string[]; timing: CutSceneTiming[] } {
  const picked = evenSample(scenes, MAX_REVIEW_FRAMES)
  const sceneIds = picked.map((s) => s.id)
  const timing: CutSceneTiming[] = picked.map((s, i) => ({
    index: i,
    name: s.name ?? `Scene ${i + 1}`,
    durationSec: typeof s.duration === 'number' ? s.duration : 0,
  }))
  return { sceneIds, timing }
}
import {
  API_COST_ESTIMATES,
  API_DISPLAY_NAMES,
  checkPermission,
  estimateApiCostUsd,
  spendCapExceeded,
} from '../permissions'
import { evaluatePermission } from '../permissions/evaluator'
import { commitCost } from './run-cost-ledger'
import { generateCode } from '../generation/generate'
import { scanForNondeterminism } from '../generation/determinism-scan'
import { scanForSlop } from '../generation/slop-scan'
import { scanForFlow, hasTimeDrivenMotion } from '../generation/flow-scan'
import { trace, tclip, traceEnabled } from './trace'
import { evaluateRenderBlock } from '../services/scene-verifier'
import { TOOL_TIMEOUT_MS, GENERATION_TOOL_TIMEOUT_MS, MEDIA_GEN_TOOL_TIMEOUT_MS } from './tool-timeouts'
import { ALL_TOOLS } from './tools'
import { resolveScenesDir } from '../scene-html-paths'
import { collectIdUniverse, expandIdPrefix, AmbiguousIdError, shortenIdsDeep } from './short-id'
import { updateScene as updateSceneShared } from './tool-handlers/_shared'

/**
 * Lazy map from tool name → ClaudeToolDefinition. Used by the diff-preview
 * gate to look up `mutates` tags. Built once on first read so
 * we don't pay the cost when previewMode is off.
 */
let _toolDefsByName: Map<string, ClaudeToolDefinition> | null = null
function getToolDef(name: string): ClaudeToolDefinition | undefined {
  if (!_toolDefsByName) {
    _toolDefsByName = new Map(ALL_TOOLS.map((t) => [t.name, t]))
  }
  return _toolDefsByName.get(name)
}
import { createSceneToolHandler, SCENE_TOOL_NAMES } from './tool-handlers/scene-tools'

/** Scene ids are used verbatim as `<id>.html` filenames — anything outside this
 *  set could escape the scenes dir. Exported so the MCP write path enforces the
 *  same rule as this in-app choke point. */
export const SCENE_ID_RE = /^[a-zA-Z0-9-]+$/
import { createStyleToolHandler, STYLE_TOOL_NAMES, SET_ALL_TRANSITIONS_OP } from './tool-handlers/style-tools'
import { createInteractionToolHandler, INTERACTION_TOOL_NAMES } from './tool-handlers/interaction-tools'
import { AUDIO_TOOL_NAMES, createAudioToolHandler } from './tool-handlers/audio-tools'
import { createImageVideoToolHandler, IMAGE_VIDEO_TOOL_NAMES } from './tool-handlers/image-video-tools'
import { createMediaLibraryExtHandler, MEDIA_LIBRARY_EXT_TOOL_NAMES } from './tool-handlers/media-library-tools'
import { AVATAR_TOOL_NAMES, createAvatarToolHandler } from './tool-handlers/avatar-tools'
import { createLayerToolHandler, LAYER_TOOL_NAMES } from './tool-handlers/layer-tools'
import { createChartToolHandler, CHART_TOOL_NAMES } from './tool-handlers/chart-tools'
import { createElementToolHandler, ELEMENT_TOOL_NAMES } from './tool-handlers/element-tools'
import { createAILayerToolHandler, AI_LAYER_TOOL_NAMES } from './tool-handlers/ai-layer-tools'
import { createAssetMediaToolHandler, ASSET_MEDIA_TOOL_NAMES } from './tool-handlers/asset-media-tools'
import { createRecordingToolHandler, RECORDING_TOOL_NAMES } from './tool-handlers/recording-tools'
import { createTemplateToolHandler, TEMPLATE_TOOL_NAMES } from './tool-handlers/template-tools'
import { createPlanningExportToolHandler, PLANNING_EXPORT_TOOL_NAMES } from './tool-handlers/planning-export-tools'
import { createClarifyToolHandler, CLARIFY_TOOL_NAMES } from './tool-handlers/clarify-tools'
import { createPlanSurfaceToolHandler, PLAN_SURFACE_TOOL_NAMES } from './tool-handlers/plan-surface-tools'
import { createStateQueryToolHandler, STATE_QUERY_TOOL_NAMES } from './tool-handlers/state-query-tools'
import { err, findScene, noteMediaGenDispatch } from './tool-handlers/_shared'
import { clearSceneErrors } from './scene-error-buffer'
import { createThreeWorldToolHandler } from './tool-handlers/three-world-tools'
import { createSkillToolHandler, SKILL_TOOL_NAMES } from './tool-handlers/skill-tools'
import {
  createResearchToolHandler,
  RESEARCH_TOOL_NAMES,
  REQUEST_WEB_SEARCH_TOOL_NAME,
} from './tool-handlers/research-tools'
import { createDesignToolHandler, DESIGN_SYSTEM_TOOL_NAMES } from './tool-handlers/design-tools'
import { createOkfToolHandler, OKF_TOOL_NAMES } from './tool-handlers/okf-tools'
import { createCaptureFrameToolHandler, CAPTURE_FRAME_TOOL_NAMES } from './tool-handlers/capture-frame-tools'
import { createVerifyToolHandler, VERIFY_TOOL_NAMES } from './tool-handlers/verify-tools'
import { createTimelineToolHandler, TIMELINE_TOOL_NAMES } from './tool-handlers/timeline-tools'
import { createFeedbackToolHandler, FEEDBACK_TOOL_NAMES, recordFeedbackTool } from './tool-handlers/feedback-tools'

// ── Run Abort Signal ─────────────────────────────────────────────────────────
//
// The run's AbortSignal can't live ON the world object: world is JSON-cloned for
// snapshots and parallel-batch isolation, and an AbortSignal is neither
// serializable nor cloneable. A WeakMap keyed by the world instance gives each run
// (and each isolated sub-world, re-registered after cloning) its own signal without
// touching the world's shape. Handlers doing long/expensive work — generation calls,
// capture round-trips — read it via getWorldAbortSignal and bail BEFORE persisting.
//
// DECLARED FIRST, DELIBERATELY. This module sits in an import cycle with its own
// handlers: tool-executor imports tool-handlers/*, and several handlers reach back
// with `await import('@/lib/agents/tool-executor')` to read the signal. A dynamic
// import does NOT protect against re-entrancy — if this module is still evaluating,
// the importer gets the partial namespace, and any binding declared BELOW the
// re-entry point is in its temporal dead zone. This const used to live ~1,800 lines
// down, so a handler that re-entered early threw "Cannot access 'worldAbortSignals'
// before initialization" and the tool reported a bogus failure instead of an abort
// check (it surfaced as "SFX synthesis failed: …" in synthesize_sfx). Keeping the
// declaration above every handler-reachable statement shrinks that window to zero.
const worldAbortSignals = new WeakMap<WorldStateMutable, AbortSignal>()

export function setWorldAbortSignal(world: WorldStateMutable, signal: AbortSignal): void {
  worldAbortSignals.set(world, signal)
}

export function getWorldAbortSignal(world: WorldStateMutable): AbortSignal | undefined {
  return worldAbortSignals.get(world)
}

// ── Tool Error Rate Tracking ─────────────────────────────────────────────────

const toolStats = new Map<string, { success: number; failure: number }>()

function recordToolResult(toolName: string, success: boolean): void {
  const entry = toolStats.get(toolName) ?? { success: 0, failure: 0 }
  if (success) entry.success++
  else entry.failure++
  toolStats.set(toolName, entry)
}

/** Get per-tool success/failure counts accumulated during the current run */
export function getToolStats(): Record<string, { success: number; failure: number }> {
  return Object.fromEntries(toolStats)
}

/** Reset tool stats (call at the start of each agent run) */
export function resetToolStats(): void {
  toolStats.clear()
}

// ── Snapshot System ───────────────────────────────────────────────────────────

export function createSnapshot(world: WorldStateMutable, description: string): StateSnapshot {
  if (!world.snapshots) world.snapshots = []
  const snapshot: StateSnapshot = {
    id: uuidv4(),
    timestamp: Date.now(),
    description,
    // Deep clone
    scenes: JSON.parse(JSON.stringify(world.scenes)),
    globalStyle: JSON.parse(JSON.stringify(world.globalStyle)),
  }
  world.snapshots.push(snapshot)
  if (world.snapshots.length > 20) world.snapshots.shift() // per-run cap
  return snapshot
}

/** Cap on NAMED checkpoints per run. Each holds a deep scene clone, so
 *  the cap bounds memory the same way the per-tool snapshot cap does. */
const MAX_NAMED_CHECKPOINTS = 20

/** Cap-respecting push shared by direct creation and per-tool promotion. */
function pushNamedCheckpoint(world: WorldStateMutable, checkpoint: StateSnapshot): StateSnapshot {
  if (!world.checkpoints) world.checkpoints = []
  world.checkpoints.push(checkpoint)
  if (world.checkpoints.length > MAX_NAMED_CHECKPOINTS) world.checkpoints.shift()
  return checkpoint
}

/**
 * Create a NAMED checkpoint — an agent-visible rollback point with
 * a human-meaningful label ("before delete_scene: Intro"). Separate from the
 * per-tool `snapshots` noise; this is what list_snapshots/rollback_to_snapshot
 * read. Returns the checkpoint so callers can reference its id.
 *
 * Inside executeTool, prefer the marker-promotion path
 * (world._pendingNamedCheckpointLabel) — it reuses the per-tool pre-snapshot's
 * clone instead of paying a second full JSON round-trip of every scene's code
 * (destructive ops would otherwise clone the world TWICE).
 */
export function createNamedCheckpoint(world: WorldStateMutable, label: string): StateSnapshot {
  return pushNamedCheckpoint(world, {
    id: uuidv4(),
    timestamp: Date.now(),
    description: label,
    scenes: JSON.parse(JSON.stringify(world.scenes)),
    globalStyle: JSON.parse(JSON.stringify(world.globalStyle)),
  })
}

/** Restore world state from a snapshot. Used for rollback when a tool throws.
 *  Replaces scenes and globalStyle entirely (not shallow merge) to ensure
 *  nested objects like palette arrays are fully reverted. */
export function restoreSnapshot(world: WorldStateMutable, snapshot: StateSnapshot): void {
  world.scenes = JSON.parse(JSON.stringify(snapshot.scenes))
  // Clear all existing keys then apply snapshot to avoid stale nested refs
  for (const key of Object.keys(world.globalStyle)) {
    delete (world.globalStyle as unknown as Record<string, unknown>)[key]
  }
  Object.assign(world.globalStyle, JSON.parse(JSON.stringify(snapshot.globalStyle)))
}

// ── Tool timeouts ────────────────────────────────────────────────────────────
// The tiers (60s default / 120s generation / 180s paid-media) live in the leaf
// module ./tool-timeouts so the MCP bridge derives from the SAME source (it
// can't import tool-executor — that would run all tool registrations). See the
// leaf for the full rationale on the 180s paid-media ceiling.

/**
 * Runtime-verify cache TTL. The auto-runtime-verify post-tool hook stamps a
 * scene's render outcome on `world.recentRuntimeVerify[sceneId]` after a
 * write tool succeeds. If the agent calls `verify_scene` on the same scene
 * within this window, we reuse the cached outcome instead of re-rendering.
 *
 * 30s is long enough to debounce a typical write→verify pair (sub-second
 * apart) and short enough that a delayed verify after intervening
 * non-write work still re-runs against the latest state. Code mutations
 * implicitly invalidate the cache because the post-hook fires again on
 * the next write and overwrites the entry.
 */
export const RUNTIME_VERIFY_CACHE_TTL_MS = 30_000

/**
 * Read the cached runtime-verify outcome for a scene if it's fresh. Used by
 * `verify_scene` to skip a redundant offscreen render. Returns `null` if no
 * entry exists or the entry is older than the TTL.
 */
export function readRecentRuntimeVerify(
  world: WorldStateMutable,
  sceneId: string,
): {
  status: 'verified' | 'errored' | 'unknown'
  error: import('@/lib/db/schema').SceneVerifyError | null
  durationMs: number
} | null {
  const entry = world.recentRuntimeVerify?.[sceneId]
  if (!entry) return null
  if (Date.now() - entry.at > RUNTIME_VERIFY_CACHE_TTL_MS) return null
  return { status: entry.status, error: entry.error, durationMs: entry.durationMs }
}

/**
 * Write a runtime-verify outcome to the cache. Idempotent. The cache map is
 * lazily initialized so callers don't have to.
 */
export function writeRecentRuntimeVerify(
  world: WorldStateMutable,
  sceneId: string,
  outcome: {
    status: 'verified' | 'errored' | 'unknown'
    error: import('@/lib/db/schema').SceneVerifyError | null
    durationMs: number
  },
): void {
  if (!world.recentRuntimeVerify) world.recentRuntimeVerify = {}
  world.recentRuntimeVerify[sceneId] = { at: Date.now(), ...outcome }
}

// ── Auto-capture cache ────────────────────────────────────────────────────────
//
// Keyed by `${sceneId}:${codeHash}`. If the key exists, the agent has already
// seen a rendered frame for this exact code state and another round-trip is
// skipped. Hash is a cheap 8-char hex of the code string length + a checksum.

/** Compute a lightweight hash for scene code content. Not cryptographic — we
 *  only need collision resistance across typical code edits. */
export function computeCodeHash(code: string): string {
  let h = 0x811c9dc5 // FNV-1a 32-bit basis
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i)
    h = (h * 0x01000193) >>> 0 // FNV prime, keep 32-bit
  }
  return h.toString(16).padStart(8, '0')
}

/** True if we already have a cached capture for this sceneId+codeHash pair. */
export function hasCachedCapture(world: WorldStateMutable, sceneId: string, codeHash: string): boolean {
  return Boolean(world.recentCaptureCache?.[`${sceneId}:${codeHash}`])
}

/** Record that we fired (or are about to fire) a capture for this state. */
export function writeRecentCapture(world: WorldStateMutable, sceneId: string, codeHash: string): void {
  if (!world.recentCaptureCache) world.recentCaptureCache = {}
  world.recentCaptureCache[`${sceneId}:${codeHash}`] = { capturedAt: Date.now() }
}

// ── Generation tools that benefit from auto-validation ───────────────────────
const GENERATION_TOOL_SET = new Set([
  'add_layer',
  'regenerate_layer',
  'generate_chart',
  'generate_physics_scene',
  'world_scene',
  'write_scene_code',
])

// Tools that AUTHOR/rewrite a scene's code. A SYNTAX error from any of these is
// unambiguously the tool's own fault (deterministic, never intentional), so the
// post-tool gate hard-fails them (see the syntax escalation below). This is the
// GENERATION set plus patch_layer_code — the primary edit tool, which rewrites
// reactCode/sceneCode/canvasCode directly but is not a "generation" tool for
// timeout/quick-validation purposes, so it gets its own membership here only.
// (migrate_to_react used to be the third member — it emitted reactCode by wrapping
// a legacy scene's existing code in a bridge shell. The tool is gone: it was a pure
// string transform on code the model can read and rewrite itself, and no scene it
// could target can still be created.)
const CODE_AUTHORING_TOOL_SET = new Set([...GENERATION_TOOL_SET, 'patch_layer_code'])

// ── Paid media-gen tools (longer-timeout tier) ───────────────────────
// Tools that make a synchronous, blocking PAID provider call (image, sticker,
// narration/TTS, SFX gen, background music, music gen, the sync avatar-narration
// path, dubbing, voice cloning). These get MEDIA_GEN_TOOL_TIMEOUT_MS so a normal
// slow round-trip doesn't time out under the 60s default and roll back an asset
// the provider already billed. NOT included: async-start tools that return fast
// after kicking off a poll (generate_avatar, generate_veo3_video) — their wait is
// in get_avatar_status / get_video_status, which are bounded by their own deadlines
// and must stay on the short timeout so a wedged poll fails fast. Names verified
// against IMAGE_VIDEO_TOOL_NAMES / AUDIO_TOOL_NAMES / AVATAR_TOOL_NAMES.
export const MEDIA_GEN_TOOL_SET = new Set([
  'generate_image',
  'add_narration',
  'add_music', // merged: library/generate/compose — hits paid providers on generate
  'add_sfx', // merged: library/synthesize — library path can hit paid providers
  'generate_avatar_narration', // the sync (fal lipsync) avatar path
  'generate_avatar_scene', // twin of avatar_narration — also blocks on sync fal lipsync render
  'dub_video',
  'clone_voice',
  // The REAL canonical paid image tools (the names above — generate_image /
  // generate_sticker — are not canonical defs). A 70-110s Flux i2i round-trip
  // billed by the provider; without the 180s tier they hit the 60s default,
  // get rolled back as a timeout, and the MCP retry re-bills the same asset
  // These DO bill (checkApiPermission → commitMediaSpend).
  // Both are reached as generate_image(source:'reference'|'regenerate') and so are
  // already covered by 'generate_image' above; the executor sees only the merged name.
])

/**
 * The subset of MEDIA_GEN_TOOL_SET that counts against the run's paid VISUAL/VIDEO
 * generation backstop (RunCostLedger.mediaGenCap). Deliberately EXCLUDES per-scene
 * audio (narration / SFX / music / TTS): those scale one-per-scene with the video
 * and are usually local/cheap, so counting them would false-trip a legitimate
 * narrated build. This set is the class that can balloon a run — image / sticker /
 * i2i / variation / avatar / veo3 video — and includes the free/$0-provider paths
 * the dollar cap can't see. */
export const MEDIA_GEN_COUNT_SET = new Set([
  // 'generate_image' covers text-to-image, i2i and re-roll — one merged tool, three sources.
  'generate_image',
  'generate_veo3_video',
  'generate_avatar_narration',
  'generate_avatar_scene',
])

/** Per-tool dispatch timeout (ms). Media-gen > generation > default. Exported so the
 *  tier is unit-testable without reaching into the private sets. */
export function toolTimeoutMs(toolName: string): number {
  if (MEDIA_GEN_TOOL_SET.has(toolName)) return MEDIA_GEN_TOOL_TIMEOUT_MS
  if (GENERATION_TOOL_SET.has(toolName)) return GENERATION_TOOL_TIMEOUT_MS
  return TOOL_TIMEOUT_MS
}

/**
 * Render-gate flip decision. Returns a
 * RenderBlock when the tool should be flipped to failure for a blank/broken
 * render, or null to leave the result alone. Exported so the SCOPE is
 * unit-testable without driving the whole executeTool path.
 *
 * Scoped to CODE_AUTHORING_TOOL_SET, mirroring the syntax gate: a camera /
 * transition / background tool regenerates HTML and so measures a frame, but
 * it did not author the pixels. Failing it for a scene that was already blank
 * (e.g. a legitimately dark scene caught mid animate-in) blames the wrong tool
 * and triggers a destructive delete/recreate churn. The blank is the scene
 * code's problem — surface it when a generation tool next touches the scene.
 */
export function renderBlockForTool(
  toolName: string,
  verifyStatus: string | undefined,
  frame: import('../services/scene-verifier').SceneFrameTruth | undefined,
): ReturnType<typeof evaluateRenderBlock> {
  if (!frame || verifyStatus !== 'verified') return null
  if (!CODE_AUTHORING_TOOL_SET.has(toolName)) return null
  return evaluateRenderBlock(frame)
}

/**
 * Verifier honesty. When the render verifier infrastructure was UNAVAILABLE
 * (`verifyStatus === 'unknown'`: no Electron window, or window-creation failed),
 * the blank/broken render gate never ran, so "does this scene actually render?"
 * went UNANSWERED — a clean success with zero signal would let some scenes slip
 * through unverified under infra pressure. This returns a signal for
 * code-authoring tools (the only kind a render gate would have run for) so the
 * caller can surface a VISIBLE, NON-BLOCKING `_verifySkipped` marker. Pure +
 * scoped to CODE_AUTHORING_TOOL_SET, mirroring renderBlockForTool's posture.
 * Non-blocking by design (visible soft-fail, never a hard block) — a
 * genuinely fine scene must still ship when the machine merely lacks a verifier.
 */
export function verifySkippedForTool(
  toolName: string,
  verifyStatus: string | undefined,
): { reason: 'verifier-unavailable' } | null {
  if (verifyStatus !== 'unknown') return null
  if (!CODE_AUTHORING_TOOL_SET.has(toolName)) return null
  return { reason: 'verifier-unavailable' }
}

/**
 * FLOW gate decision (pure) — promoted from an advisory warning to a BLOCKING
 * check for code-authoring tools on react/motion scenes (quality by construction).
 * NOT a taste judgment: it blocks ONLY
 * the unambiguous structural violation — code with NO time-driven motion of any
 * kind, i.e. a genuinely static slide. `hasTimeDrivenMotion` recognizes the
 * Remotion `interpolate`/`spring` idiom AND CSS `@keyframes`/`animation`,
 * requestAnimationFrame, a 3D camera anim, and any hook-driven (`${…}`) style —
 * so a legitimate single-reveal card or a `@keyframes`/`useDreambyteTime` scene is
 * NOT blocked (that over-fire would push good builds into a corrective loop, the
 * render-gate churn lesson). Mirrors renderBlockForTool's conservative posture.
 */
export function flowBlockForTool(
  toolName: string,
  sceneType: string | undefined,
  code: string | undefined,
  hasCameraMotionTrack?: boolean,
): { reason: string; hint: string } | null {
  if (!CODE_AUTHORING_TOOL_SET.has(toolName)) return null
  if (sceneType !== 'react' && sceneType !== 'motion') return null
  // A structured cameraMotion track (set_camera_motion → injected <script>) is a
  // real time-driven camera move the code-only scan can't see. Treat it as motion
  // so a camera-driven-but-statically-coded scene isn't blocked as a static slide. (③.4)
  if (hasCameraMotionTrack) return null
  if (!code || hasTimeDrivenMotion(code)) return null
  return {
    reason: 'the scene has no time-driven motion — it renders as a single static slide.',
    hint: 'Animate it: drive element transforms from the frame clock (interpolate/spring), move a camera (translate + scale), or add a CSS @keyframes reveal. Every scene must move — pick whatever motion fits the beat; it must not hold one static frame.',
  }
}

/**
 * Detect `${...}` interpolation inside a PLAIN quoted string. This is the
 * single most common AI-codegen render bug that the runtime syntax gate can't
 * catch — it is syntactically valid JSX/JS but renders the literal text
 * "${expr}" instead of a value (e.g. an SVG `d="M110 ${x}"` draws a broken
 * path; a `transform="translateY(${y}px)"` does nothing). Interpolation only
 * works inside a backtick template literal, so a `${` inside a single/double
 * quoted string is never intentional. High precision, zero false positives on
 * legitimate template literals (those use backticks). Exported for unit tests.
 */
export function hasTemplateInterpInQuotedString(code: string): boolean {
  // Opening quote, then any run of non-quote / escaped chars (lazy), then `${`.
  return /(["'])(?:[^"'\\\n]|\\.)*?\$\{/.test(code)
}

/** Quick validation checks run automatically after generation tools succeed.
 *  Returns a list of warning strings (empty = no issues detected). */
/**
 * Concatenate the renderable CODE fields of a scene for static scanning
 * (determinism lint). Covers every field that can hold generated scene code
 * across renderer types — react (reactCode), canvas2d (canvasCode), the
 * Canvas2D background loop (canvasBackgroundCode), and motion/d3/three/zdog
 * (sceneCode). Returns '' for image/video/audio-only layers, which
 * carry no code — the caller then skips the scan entirely.
 */
export function collectSceneCode(scene: Scene): string {
  return [scene.reactCode, scene.canvasCode, scene.canvasBackgroundCode, scene.sceneCode]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .join('\n')
}

export function quickValidateScene(scene: Scene, dims?: { width: number; height: number }): string[] {
  const warnings: string[] = []
  const hasContent = !!(
    scene.svgContent ||
    scene.canvasCode ||
    scene.sceneCode ||
    scene.lottieSource ||
    scene.reactCode
  )
  const layerCount = (scene.svgObjects?.length ?? 0) + (scene.aiLayers?.length ?? 0)
  if (!hasContent && layerCount === 0) {
    warnings.push('EMPTY: Scene has no visual content after generation.')
  }
  if (scene.duration < 3) {
    warnings.push(`SHORT: Duration is ${scene.duration}s — minimum recommended is 6s.`)
  }
  // Check for suspiciously short generated code (likely failed generation)
  const codeLength =
    (scene.sceneCode?.length ?? 0) +
    (scene.canvasCode?.length ?? 0) +
    (scene.svgContent?.length ?? 0) +
    (scene.reactCode?.length ?? 0)
  if (hasContent && codeLength < 100) {
    warnings.push(`MINIMAL: Generated code is only ${codeLength} chars — may be incomplete.`)
  }
  // Anti-slop scan (Motion Design Contract): emoji-as-content, scene-number kickers,
  // whole-scene frame%N loops. Surfaces as a post-generation warning to the agent.
  warnings.push(...scanForSlop(collectSceneCode(scene)))
  // FLOW soft-signal: warn when the camera-travel structure is absent (static
  // slideshow, sub-72px text, navy/grey "almost-black" bg). High-precision and SOFT —
  // surfaced to the agent, never blocks. Gated to the explainer renderers where THE FLOW
  // is the contract (react/motion); charts and 3d have their own motion logic.
  if (scene.sceneType === 'react' || scene.sceneType === 'motion') {
    warnings.push(
      ...scanForFlow(collectSceneCode(scene), {
        ...dims,
        hasCameraMotionTrack: (scene.cameraMotion?.length ?? 0) > 0,
      }).warnings,
    )
  }
  return warnings
}

/** One decomposed operation: the legacy tool name, its args, and which handler owns it. */
export type LayerPropOp = [op: string, args: Record<string, unknown>, handler: 'layer' | 'ai']

/**
 * Decompose ONE set_layer_props entry into the legacy per-property ops.
 *
 * set_layer_props replaced seven single-verb setters. Rather than reimplement their
 * bodies (and re-derive every clamp, layer-type check and regenerate path), its executor
 * delegates to the original handler cases — this function decides which ones to call and
 * with what args. That mapping is the only genuinely new logic in the merge, so it lives
 * at module scope where it can be tested without standing up a whole tool registry.
 *
 * ORDER IS DELIBERATE: geometry (transform, crop) runs before paint (opacity, filter,
 * grade). Resizing a layer and grading it in the same call must land the same way every
 * time, and crop rewrites width/height that transform also touches.
 */
export function planLayerPropOps(sceneId: string, u: Record<string, unknown>): LayerPropOp[] {
  const layerId = u.layerId as string | undefined
  const ops: LayerPropOp[] = []

  if (u.transform && typeof u.transform === 'object') {
    ops.push(['update_ai_layer', { sceneId, layerId, ...(u.transform as object) }, 'ai'])
  }
  if (u.crop && typeof u.crop === 'object') {
    const c = u.crop as { x?: number; y?: number; width?: number; height?: number }
    ops.push([
      'crop_image_layer',
      { sceneId, layerId, cropX: c.x, cropY: c.y, cropWidth: c.width, cropHeight: c.height },
      'ai',
    ])
  }
  if (u.startAt !== undefined) ops.push(['set_layer_timing', { sceneId, layerId, startAt: u.startAt }, 'layer'])
  if (u.visible !== undefined) ops.push(['set_layer_visibility', { sceneId, layerId, visible: u.visible }, 'layer'])
  if (u.opacity !== undefined) ops.push(['set_layer_opacity', { sceneId, layerId, opacity: u.opacity }, 'layer'])
  if (u.filter !== undefined) ops.push(['set_layer_filter', { sceneId, layerId, filter: u.filter }, 'ai'])
  // resetGrade wins over grade — the schema says it ignores the other grade fields.
  if (u.resetGrade) ops.push(['set_layer_grade', { sceneId, layerId, reset: true }, 'layer'])
  else if (u.grade) ops.push(['set_layer_grade', { sceneId, layerId, grade: u.grade }, 'layer'])

  return ops
}

// ── World State Container ─────────────────────────────────────────────────────

export type { WorldStateMutable } from './world-state'
import type { WorldStateMutable } from './world-state'

/**
 * B1 (v6 TIMELINE / OV#4): the LIVE timeline shape read_editor_state surfaces.
 * Derived from `world.timeline` each call so it reflects clip-targeting tool
 * mutations made earlier in the same run (the run-start UI snapshot is frozen).
 * Returns null when no timeline exists — the agent then knows to init_timeline
 * (or that there are no clips to target) rather than reading stale UI state.
 */
export function summarizeWorldTimelineForEditorState(timeline: import('../types').Timeline | null | undefined): {
  trackCount: number
  clipCount: number
  markerCount: number
  tracks: Array<{
    id: string
    name: string
    type: string
    clips: Array<{
      id: string
      sourceType: string
      sourceId: string
      label: string
      startTime: number
      duration: number
      trimStart: number
      trimEnd: number | null
    }>
  }>
} | null {
  if (!timeline) return null
  const tracks = (timeline.tracks ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    clips: (t.clips ?? []).map((c) => ({
      id: c.id,
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      label: c.label ?? '',
      startTime: c.startTime,
      duration: c.duration,
      trimStart: c.trimStart ?? 0,
      trimEnd: c.trimEnd ?? null,
    })),
  }))
  return {
    trackCount: tracks.length,
    clipCount: tracks.reduce((n, t) => n + t.clips.length, 0),
    markerCount: timeline.markers?.length ?? 0,
    tracks,
  }
}

// ── Tool Hook Pipeline ───────────────────────────────────────────────────────
//
// Pre-tool hooks run before execution and can deny or modify tool inputs.
// Post-tool hooks run after execution and can augment or flag results.
// Hooks are registered globally and matched by tool name or wildcard '*'.

export interface PreToolHookContext {
  toolName: string
  args: Record<string, unknown>
  world: WorldStateMutable
}

export interface PreToolHookResult {
  /** If true, tool execution is blocked with the provided reason */
  deny?: boolean
  reason?: string
  /** Optionally modify tool args before execution */
  modifiedArgs?: Record<string, unknown>
}

export interface PostToolHookContext {
  toolName: string
  args: Record<string, unknown>
  result: ToolResult
  world: WorldStateMutable
  durationMs: number
}

export interface PostToolHookResult {
  /** Optionally override or augment the tool result */
  modifiedResult?: ToolResult
  /** Warning message appended to result data */
  warning?: string
}

export type PreToolHook = (ctx: PreToolHookContext) => PreToolHookResult | Promise<PreToolHookResult>
export type PostToolHook = (ctx: PostToolHookContext) => PostToolHookResult | Promise<PostToolHookResult>

interface RegisteredHook<T> {
  /** Tool name pattern: exact name or '*' for all tools */
  pattern: string
  name: string
  hook: T
}

const preToolHooks: RegisteredHook<PreToolHook>[] = []
const postToolHooks: RegisteredHook<PostToolHook>[] = []

/** Register a pre-tool hook. Pattern can be an exact tool name or '*' for all. */
export function registerPreToolHook(pattern: string, name: string, hook: PreToolHook): void {
  preToolHooks.push({ pattern, name, hook })
}

/** Register a post-tool hook. Pattern can be an exact tool name or '*' for all. */
export function registerPostToolHook(pattern: string, name: string, hook: PostToolHook): void {
  postToolHooks.push({ pattern, name, hook })
}

/** Remove all hooks (useful for testing). */
export function clearToolHooks(): void {
  preToolHooks.length = 0
  postToolHooks.length = 0
}

/** Test-only: snapshot of registered pre-tool hooks. */
export function __getPreToolHooksForTesting(): RegisteredHook<PreToolHook>[] {
  return preToolHooks.slice()
}

/** Test-only: snapshot of registered post-tool hooks. */
export function __getPostToolHooksForTesting(): RegisteredHook<PostToolHook>[] {
  return postToolHooks.slice()
}

// removeHooksByName lived here to clean up loadProjectHooks' user-configured
// hooks. loadProjectHooks (hook-config.ts) is gone and nothing else ever
// unregistered a hook — the built-ins register once at module load and stay.

function matchesPattern(pattern: string, toolName: string): boolean {
  return pattern === '*' || pattern === toolName
}

async function runPreToolHooks(ctx: PreToolHookContext, logger?: AgentLogger): Promise<PreToolHookResult> {
  let currentArgs = ctx.args
  for (const { pattern, name, hook } of preToolHooks) {
    if (!matchesPattern(pattern, ctx.toolName)) continue
    try {
      const result = await hook({ ...ctx, args: currentArgs })
      if (result.deny) {
        logger?.log('hook', `Pre-tool hook "${name}" denied ${ctx.toolName}: ${result.reason}`)
        return result
      }
      if (result.modifiedArgs) {
        currentArgs = result.modifiedArgs
      }
    } catch (err) {
      logger?.warn('hook', `Pre-tool hook "${name}" threw: ${(err as Error).message}`)
      // Hook errors don't block execution
    }
  }
  return { modifiedArgs: currentArgs }
}

/**
 * Is this hook warning a DEFECT the model must act on, or an FYI? Warnings are
 * accumulated and the defect-shaped ones are ordered first, so a perf note
 * ("took 34.0s") can't bury a runtime crash on the same call.
 * A substring test, not a severity field on every hook — the producers of defect
 * warnings all lead with RUNTIME/ERROR/FAILED. If one appears that doesn't, give
 * HookResult a `severity`.
 */
const DEFECT_WARNING_RE = /\b(runtime|error|failed|broken|invalid)\b/i

async function runPostToolHooks(ctx: PostToolHookContext, logger?: AgentLogger): Promise<ToolResult> {
  let currentResult = ctx.result
  const warnings: string[] = []
  for (const { pattern, name, hook } of postToolHooks) {
    if (!matchesPattern(pattern, ctx.toolName)) continue
    try {
      const hookResult = await hook({ ...ctx, result: currentResult })
      if (hookResult.modifiedResult) {
        currentResult = hookResult.modifiedResult
      }
      if (hookResult.warning) {
        warnings.push(hookResult.warning)
        logger?.log('hook', `Post-tool hook "${name}" warning on ${ctx.toolName}: ${hookResult.warning}`)
      }
    } catch (err) {
      logger?.warn('hook', `Post-tool hook "${name}" threw: ${(err as Error).message}`)
    }
  }
  if (warnings.length > 0) {
    // Stable partition: defects first, everything else in hook order.
    const ordered = [
      ...warnings.filter((w) => DEFECT_WARNING_RE.test(w)),
      ...warnings.filter((w) => !DEFECT_WARNING_RE.test(w)),
    ]
    currentResult = {
      ...currentResult,
      data: {
        ...(typeof currentResult.data === 'object' && currentResult.data ? currentResult.data : {}),
        _hookWarning: ordered.join(' | '),
      },
    }
  }
  return currentResult
}

// ── Helper Functions ──────────────────────────────────────────────────────────

/**
 * regenerateHTML's scene writes go through the shared `updateScene` so they
 * invalidate the runtime-verify cache like every handler write. Unlike the
 * handlers, this path also stamps `updatedAt`, which the checkpoint-resume
 * merge in src/lib/services/agent-runner.ts compares.
 */
function updateScene(world: WorldStateMutable, sceneId: string, updates: Partial<Scene>): Scene | null {
  return updateSceneShared(world, sceneId, { ...updates, updatedAt: Date.now() })
}

/** Clear code fields that don't belong to the given scene type */
export function clearStaleCodeFields(sceneType: SceneType): Partial<Scene> {
  const clear: Partial<Scene> = {}
  if (sceneType !== 'svg') {
    clear.svgContent = ''
    clear.svgObjects = []
  }
  if (sceneType !== 'canvas2d') clear.canvasCode = ''
  if (sceneType !== 'lottie') clear.lottieSource = ''
  if (sceneType !== 'react') clear.reactCode = ''
  if (sceneType !== 'd3') {
    clear.d3Data = null
    clear.chartLayers = [] as any
  }
  if (!['d3', 'three', 'motion', 'zdog'].includes(sceneType)) clear.sceneCode = ''
  if (sceneType === 'canvas2d' || !['motion', 'd3', 'svg'].includes(sceneType)) {
    clear.canvasBackgroundCode = ''
  }
  return clear
}

// ── Permission Helpers ────────────────────────────────────────────────────────

type APIName = keyof APIPermissions

/**
 * Check whether an API is permitted to be called based on the project's
 * APIPermissions config. Returns an error ToolResult when the call should be
 * blocked, or null when execution should proceed.
 *
 * For always_ask / ask_once modes: returns a structured result with
 * `permissionNeeded` so the chat UI can render approve/deny buttons.
 * For ask_once: checks sessionPermissions first — if already approved this
 * session, allows the call without prompting.
 */
/**
 * Layered permission-rule evaluation (user/workspace/project/session). Shared by
 * the agentRunMode posture path and the default path so a rule-based DENY is
 * honored in every posture (Auto must not bypass a rule deny). Returns null when
 * rules aren't plumbed in (no authUserId / no rules).
 */
function evaluateRules(
  world: WorldStateMutable,
  api: APIName,
  estimatedCostUsd: number,
  context: { details?: { prompt?: string; duration?: number; model?: string; resolution?: string } } | undefined,
  config: { sessionSpend: number; sessionLimit: number | null; monthlySpend: number; monthlyLimit: number | null },
) {
  if (!(world.permissionRules && world.authUserId)) return null
  return evaluatePermission(
    {
      userId: world.authUserId,
      workspaceId: world.workspaceId ?? null,
      projectId: world.projectId ?? null,
      conversationId: world.conversationId ?? null,
      api,
      call: {
        prompt: context?.details?.prompt,
        duration: context?.details?.duration,
        model: context?.details?.model,
        resolution: context?.details?.resolution,
        estimatedCostUsd,
      },
    },
    world.permissionRules,
    {
      sessionSpend: config.sessionSpend,
      sessionLimit: config.sessionLimit,
      monthlySpend: config.monthlySpend,
      monthlyLimit: config.monthlyLimit,
    },
  )
}

export async function checkApiPermission(
  world: WorldStateMutable,
  api: APIName,
  context?: {
    reason?: string
    details?: {
      prompt?: string
      duration?: number
      model?: string
      resolution?: string
      textLength?: number
    }
  },
): Promise<ToolResult | null> {
  // ── Demo fail-closed (must precede the allow-shortcuts below) ────────────
  // In Sandbox, paid generation is substituted by the resolveAsset gateway and must
  // never reach a provider. If a paid call reaches here it means a handler bypassed
  // the gateway — block it loudly rather than spend. Free stock search
  // (unsplash/pixabay/freesound) is NOT substituted and is allowed to run in Sandbox.
  if (world.sandboxMode && api !== 'unsplash' && api !== 'pixabay' && api !== 'freesound') {
    return err(
      `${api} is blocked in Sandbox mode — paid generation must route through the asset gateway (resolveAsset). No spend occurred. (If you see this, a handler skipped the gateway.)`,
    )
  }

  if (!world.apiPermissions) return null
  const config = world.apiPermissions[api]
  if (!config) return null

  // Re-hydrate live per-api spend from the ledger so the IN-RUN cap reflects spend the agent
  // already committed this run. logSpend writes the apiSpend ledger but NOT this in-memory
  // config, so without this a second paid call in the same run sees a stale (run-start) total
  // and slips past a cap the user set. Mutated in place: `config` IS world.apiPermissions[api],
  // so both spendCapExceeded(config) below and checkPermission(world.apiPermissions, ...) see it.
  // Skipped entirely when no cap is set (the common case) so we don't add a DB read per gated call.
  if (world.projectId && (config.sessionLimit !== null || config.monthlyLimit !== null)) {
    try {
      const { getProjectApiSpend } = await import('@/lib/db')
      const live = await getProjectApiSpend(world.projectId, api)
      config.sessionSpend = live.session
      config.monthlySpend = live.monthly
    } catch {
      /* DB unavailable → fall back to the in-memory snapshot (no worse than before this fix) */
    }
  }

  const sessionPermissionsMap = new Map<string, string>(Object.entries(world.sessionPermissions ?? {}))
  const sessionDecision = world.sessionPermissions?.[api]

  // Compute the scalar cost estimate up front — we need it both to evaluate
  // the threshold AND to keep an "approved but expensive" call honest.
  const estimatedCostUsd = estimateApiCostUsd(api, context?.details)

  // ── MCP run-scoped cost ceiling ──────────────────────────
  // GUARDED on world.mcpCostLedger, set ONLY by executeMcpTool. The in-app agent
  // never sets it, so this whole branch is inert there (its spend cap stays
  // governed by RunCostLedger in runner.ts) — zero blast radius on the in-app
  // path. Free stock search (unsplash/pixabay/freesound) estimates to $0, so it
  // is never gated. This runs before the posture/rule logic below so the ceiling
  // is a hard backstop in every posture.
  //
  // We RESERVE the estimate on pass (not the actual cost — there is no uniform
  // actual-spend signal across gen tools, and MCP calls are serialized per
  // project so a stale running total can't race). The reservation is REFUNDED by
  // executeMcpTool when the tool then fails (denied below, validation error, or a
  // provider throw billed nothing) — see the refundCost call in mcp-handler.
  //
  // A non-finite estimate is unknowable cost: Infinity for an unpriced catalog
  // model, or NaN if a caller computes a bad duration/textLength. A spend ceiling
  // can't guarantee an unknowable cost fits, so block it (the safe direction) —
  // otherwise `NaN > 0` being false would silently skip the gate and let an
  // unpriced/expensive call through uncapped. A clean $0 estimate (free stock
  // search) is never gated.
  if (world.mcpCostLedger && estimatedCostUsd !== 0) {
    const ledger = world.mcpCostLedger
    const wouldExceed = !Number.isFinite(estimatedCostUsd) || ledger.spentUsd + estimatedCostUsd > ledger.capUsd
    if (wouldExceed) {
      const costStr = Number.isFinite(estimatedCostUsd)
        ? `~$${estimatedCostUsd.toFixed(2)}`
        : 'an unknown/unbounded amount (unpriced model)'
      return err(
        `MCP cost ceiling: this ${API_DISPLAY_NAMES[api] ?? api} call (${costStr}) ` +
          `can't be guaranteed under the $${ledger.capUsd.toFixed(2)} cap ` +
          `(session spend $${ledger.spentUsd.toFixed(2)}). Raise the cap with set_max_run_cost, ` +
          `use sandbox mode (set_run_mode) for free placeholder generation, or restart the app.`,
      )
    }
    // estimatedCostUsd is finite and > 0 here.
    commitCost(ledger, estimatedCostUsd)
  }

  // ── Run-mode posture (agentRunMode → Auto/Ask) ───────────────────────────
  // Layered over saved per-provider rules, but only when an explicit posture is
  // active. 'default' (Plan mode + legacy/MCP runs) falls through to the existing
  // rule/enum path below, unchanged. Within Auto/Ask an explicit always_deny wins,
  // so a deliberately-blocked provider is never auto-spent.
  const posture = world.permissionPosture ?? 'default'
  if (posture === 'auto' || posture === 'ask') {
    // Explicit deny always wins, even over Auto.
    if (config.mode === 'always_deny') {
      return err(`${API_DISPLAY_NAMES[api] ?? api} is set to never run (always deny).`)
    }
    // Spend caps apply in every posture — Auto must never blow past a session/
    // monthly cap the user deliberately set. Shared with checkPermission.
    const capReason = spendCapExceeded(config)
    if (capReason) return err(capReason)
    // Layered rule deny also wins over Auto/Ask (rules supersede enum modes).
    const ruleDeny = evaluateRules(world, api, estimatedCostUsd, context, config)
    if (ruleDeny?.action === 'deny') return err(ruleDeny.reason)
    // Auto: run without per-call prompts. The cap above is the only gate — this
    // is the "completely auto" contract (a single-call cost backstop is a
    // separate, opt-in setting, deferred per the plan's TODO).
    if (posture === 'auto') return null
    // Ask: surface the existing GenerationConfirmCard, but a prior session-allow
    // ("allow for this session") suppresses repeats.
    if (sessionDecision === 'allow') return null
    return {
      success: false,
      error: `Permission required: ${api} usage needs approval.`,
      permissionNeeded: {
        api,
        estimatedCost: API_COST_ESTIMATES[api] ?? 'unknown',
        estimatedCostUsd,
        reason: context?.reason ?? `Agent requested ${API_DISPLAY_NAMES[api]}`,
        details: context?.details ?? {},
      },
    }
  }

  // ── Rule-based evaluation (layered: user/workspace/project/session) ──────
  // If rules are plumbed in, they supersede the enum-mode path for the
  // allow/deny decision. Spend caps are still enforced via the legacy gate
  // below so the existing sessionSpend/monthlySpend tracking keeps working.
  const ruleResult = evaluateRules(world, api, estimatedCostUsd, context, config)
  if (ruleResult) {
    if (ruleResult.action === 'deny') return err(ruleResult.reason)
    if (ruleResult.action === 'allow') {
      // Rule-based allow wins — still honor the per-API single-call threshold
      // as an orthogonal cost guard.
      const threshold =
        config.singleCallCostThreshold ?? (api === 'freesound' || api === 'pixabay' || api === 'unsplash' ? null : 0.5)
      if (threshold === null || estimatedCostUsd <= threshold) return null
      // Fall through to the legacy cost-gate flow to produce the permissionNeeded
      // response with costThresholdExceeded=true.
    } else if (ruleResult.action === 'ask') {
      return {
        success: false,
        error: ruleResult.costTriggered
          ? `Cost approval required: ${api} call estimated at ${Number.isFinite(estimatedCostUsd) ? `$${estimatedCostUsd.toFixed(2)}` : 'an unknown amount (unpriced model)'} exceeds the rule cap.`
          : `Permission required: ${api} usage needs approval.`,
        permissionNeeded: {
          api,
          estimatedCost: API_COST_ESTIMATES[api] ?? 'unknown',
          estimatedCostUsd,
          costThresholdExceeded: ruleResult.costTriggered,
          reason: ruleResult.reason,
          details: context?.details ?? {},
        },
      }
    }
  }

  // Preserve current UX: once approved in session, skip repeated prompts —
  // UNLESS this particular call is above the single-call threshold, in which
  // case the gate re-asks even after a blanket session approval.
  if (config.mode === 'always_ask' && sessionDecision === 'allow') {
    const threshold =
      config.singleCallCostThreshold ?? (api === 'freesound' || api === 'pixabay' || api === 'unsplash' ? null : 0.5)
    if (threshold === null || estimatedCostUsd <= threshold) {
      return null
    }
  }

  const permission = checkPermission(
    world.apiPermissions,
    api,
    API_COST_ESTIMATES[api] ?? 'unknown',
    context?.reason ?? `Agent requested ${API_DISPLAY_NAMES[api]}`,
    context?.details ?? {},
    sessionPermissionsMap,
    { estimatedCostUsd },
  )

  if (permission.action === 'allow') return null
  if (permission.action === 'deny') return err(permission.reason)

  return {
    success: false,
    error: permission.request.costThresholdExceeded
      ? `Cost approval required: ${api} call estimated at ${Number.isFinite(estimatedCostUsd) ? `$${estimatedCostUsd.toFixed(2)}` : 'an unknown amount (unpriced model)'} exceeds your threshold.`
      : `Permission required: ${api} usage needs approval.`,
    permissionNeeded: {
      api,
      estimatedCost: API_COST_ESTIMATES[api] ?? 'unknown',
      estimatedCostUsd,
      costThresholdExceeded: permission.request.costThresholdExceeded,
      reason: permission.request.reason,
      details: context?.details ?? {},
    },
  }
}

/** Check if a media gen provider is enabled. Returns error ToolResult if disabled, null if ok. */
function checkMediaEnabled(world: WorldStateMutable, providerId: string, label: string): ToolResult | null {
  if (world.mediaGenEnabled && world.mediaGenEnabled[providerId] === false) {
    return err(`${label} is disabled in media settings`)
  }
  return null
}

/** Enrich a permission-blocked ToolResult with generation context for the universal confirmation card */
function enrichPermission(
  result: ToolResult,
  context: {
    generationType: import('../types').GenerationType
    prompt?: string
    provider?: string
    availableProviders?: import('../types').GenerationProviderOption[]
    config?: Record<string, any>
    toolArgs?: Record<string, any>
  },
): ToolResult {
  if (result.permissionNeeded) {
    result.permissionNeeded = {
      ...result.permissionNeeded,
      ...context,
    }
  }
  return result
}

// ── Registration & Coverage ──────────────────────────────────────────────────
// All tool implementations are now in explicit handler files under ./tool-handlers/

let registryCoverageChecked = false
const CANONICAL_TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name))
let registryCoverageLogged = false
let handlersRegistered = false

/**
 * Tools that are DISPATCHABLE but deliberately never offered to the model —
 * our own code calls them by name. Every entry must name a real caller.
 *
 * This is the escape hatch for `ensureRegistryCoverage`'s handler→schema
 * direction. Before it existed, "keep the handler, drop the schema" — the
 * technique every consolidation pass uses — silently produced a tool that
 * dispatch could resolve but the gate below rejected. That is how the research
 * auto-placer died: `reuse_asset` kept its handler, lost its schema, and every
 * call came back `Unknown tool` into a `log.warn`.
 *
 * "Handler retained for replay/MCP" is NOT a justification — nothing replays
 * tool calls, and the MCP bridge (mcp-handler.ts) routes through this same
 * gate. If no caller exists, delete the handler.
 */
export const INTERNAL_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  // src/lib/research/land-media.ts:101 — the research auto-placer places staged
  // stock/archival images into bare scenes: executeTool('reuse_asset', …).
  'reuse_asset',
  // planLayerPropOps (this file) fans ONE set_layer_props call out to these
  // seven legacy per-property ops; the set_layer_props registration dispatches
  // them straight at layerHandler/aiLayerHandler. Pinned by set-layer-props.test.ts.
  'update_ai_layer',
  'crop_image_layer',
  'set_layer_filter',
  'set_layer_timing',
  'set_layer_visibility',
  'set_layer_opacity',
  'set_layer_grade',
])

// ── Unified Handler Registration ──────────────────────────────────────────────
// All tool families are now explicitly registered. No legacy fallback needed.

// Exported so the phantom-name guard can read the REAL dispatch table. A name
// that still dispatches but no longer has a schema is exactly the class of bug
// this codebase keeps reintroducing via "delete the offered schema, keep the
// handler" — deriving it beats maintaining a hand-written list of retired names.
export function ensureAllHandlersRegistered(): void {
  if (handlersRegistered) return

  // ── Scene tools ──
  const sceneHandler = createSceneToolHandler({ regenerateHTML })
  // scene_props(op:'transition_all') is served by the STYLE handler — it carries the
  // plan-fidelity guard that refuses to flatten a plan which deliberately varies
  // transitions per scene (the "all 8 scenes → dissolve" defect). Every other op is a
  // scene-tools op. Registered after both handlers exist, just below.
  toolRegistry.registerMany([...SCENE_TOOL_NAMES], (toolName, args, world, logger) =>
    sceneHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── Style tools ──
  const styleHandler = createStyleToolHandler({ regenerateHTML })
  toolRegistry.registerMany([...STYLE_TOOL_NAMES], (toolName, args, world, logger) =>
    styleHandler(toolName, args, world as WorldStateMutable, logger),
  )
  // Overrides the registration above for this one name (see the note there).
  toolRegistry.register('scene_props', (toolName, args, world, logger) =>
    (args as { op?: string }).op === 'transition_all'
      ? styleHandler(SET_ALL_TRANSITIONS_OP, args, world as WorldStateMutable, logger)
      : sceneHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── Interaction tools ──
  const interactionHandler = createInteractionToolHandler()
  toolRegistry.registerMany([...INTERACTION_TOOL_NAMES], (toolName, args, world) =>
    interactionHandler(toolName, args, world as WorldStateMutable),
  )

  // ── Audio tools ──
  const audioHandler = createAudioToolHandler({
    checkApiPermission,
    enrichPermission,
  })
  toolRegistry.registerMany([...AUDIO_TOOL_NAMES], (toolName, args, world) =>
    audioHandler(toolName, args, world as WorldStateMutable),
  )

  // ── Image/Video tools ──
  const imageVideoHandler = createImageVideoToolHandler({
    checkMediaEnabled,
    checkApiPermission,
    enrichPermission,
    regenerateHTML,
  })

  // ── Media-library tools (query / reuse / regenerate / i2i / variation) ──
  const mediaLibraryExtHandler = createMediaLibraryExtHandler({
    checkMediaEnabled,
    checkApiPermission,
    enrichPermission,
    regenerateHTML,
  })
  toolRegistry.registerMany([...MEDIA_LIBRARY_EXT_TOOL_NAMES], (toolName, args, world, logger) =>
    mediaLibraryExtHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // generate_image is ONE model-facing tool whose three sources live in TWO handler
  // files: source:'prompt' is the image-video handler, source:'reference'/'regenerate'
  // are the media-library handler (i2i and re-roll, with their own provenance and
  // lineage writes). Routing here keeps both handler bodies — and every permission,
  // spend and timeout path inside them — completely untouched by the merge.
  toolRegistry.registerMany([...IMAGE_VIDEO_TOOL_NAMES], (toolName, args, world, logger) => {
    const source = toolName === 'generate_image' ? (args as { source?: string }).source : undefined
    return source === 'reference' || source === 'regenerate'
      ? mediaLibraryExtHandler(toolName, args, world as WorldStateMutable, logger)
      : imageVideoHandler(toolName, args, world as WorldStateMutable, logger)
  })

  // ── Research tools — gated per-tool on webSearchEnabled / webFetchEnabled world flags ──
  const researchHandler = createResearchToolHandler()
  toolRegistry.registerMany([...RESEARCH_TOOL_NAMES], (toolName, args, world) =>
    researchHandler(toolName, args, world as WorldStateMutable),
  )
  // find_media absorbed search_3d_models + search_lottie as two more `kind`s. They
  // live in the three/world handler (a local catalogue + the LottieFiles API), not in
  // research-tools, so the split is a HANDLER boundary, not a model-facing one — route
  // those two kinds here and leave the other three to the research handler untouched.
  // Registered after the research registration so it wins for this one name.
  // threeWorldHandler is built further down in this same function; the closure only
  // runs at tool-call time, long after registration finishes, so the reference is safe.
  toolRegistry.register('find_media', (toolName, args, world, logger) => {
    const kind = (args as { kind?: string }).kind
    if (kind === '3d' || kind === 'lottie') {
      const a = args as { query?: string; category?: string; count?: number }
      return threeWorldHandler(
        kind === '3d' ? 'search_3d_models' : 'search_lottie',
        { query: a.query, category: a.category, limit: a.count },
        world as WorldStateMutable,
        logger,
      )
    }
    return researchHandler(toolName, args, world as WorldStateMutable)
  })

  // ── Avatar tools ──
  const avatarHandler = createAvatarToolHandler({
    checkMediaEnabled,
    checkApiPermission,
    enrichPermission,
  })
  toolRegistry.registerMany([...AVATAR_TOOL_NAMES], (toolName, args, world) =>
    avatarHandler(toolName, args, world as WorldStateMutable),
  )

  // ── Layer tools ──
  const layerHandler = createLayerToolHandler({ regenerateHTML })
  toolRegistry.registerMany([...LAYER_TOOL_NAMES], (toolName, args, world, logger) =>
    layerHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── Chart tools ──
  const chartHandler = createChartToolHandler({ regenerateHTML })
  toolRegistry.registerMany([...CHART_TOOL_NAMES], (toolName, args, world, logger) =>
    chartHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── Element tools ──
  const elementHandler = createElementToolHandler({ regenerateHTML })
  toolRegistry.registerMany([...ELEMENT_TOOL_NAMES], (toolName, args, world, logger) =>
    elementHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── AI Layer tools ──
  const aiLayerHandler = createAILayerToolHandler({ regenerateHTML })
  toolRegistry.registerMany([...AI_LAYER_TOOL_NAMES], (toolName, args, world, logger) =>
    aiLayerHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // (planLayerPropOps is defined at module scope, below, so it can be unit-tested.)

  // ── set_layer_props — the merged layer-property editor ──
  // Decomposes one batched call into the SEVEN pre-existing per-property handler
  // cases (three in layerHandler, three in aiLayerHandler, plus grade). Registered
  // here because it is the only scope where both handlers are already built.
  //
  // Deliberately delegates rather than reimplements: every clamp, validation, layer-type
  // check and regenerateHTML call stays byte-identical to the single-property tools it
  // replaced, so merging seven schemas into one carries no behaviour risk. The old names
  // are no longer OFFERED to the model — they remain live internal ops.
  toolRegistry.register('set_layer_props', async (_toolName, args, world, logger) => {
    const { sceneId, updates } = args as { sceneId?: string; updates?: Record<string, unknown>[] }
    if (!sceneId) return { success: false, error: 'sceneId is required.' }
    if (!Array.isArray(updates) || updates.length === 0) {
      return { success: false, error: 'updates must be a non-empty array of { layerId, ...props }.' }
    }

    const w = world as WorldStateMutable
    const applied: string[] = []
    const failures: string[] = []
    let lastSceneId: string | null = null

    for (const u of updates) {
      const layerId = u.layerId as string | undefined
      const ops = planLayerPropOps(sceneId, u)

      if (ops.length === 0) {
        failures.push(`${layerId ?? '(scene video)'}: no properties given`)
        continue
      }

      for (const [op, opArgs, which] of ops) {
        const res = await (which === 'ai' ? aiLayerHandler : layerHandler)(op, opArgs, w, logger)
        if (res.success) {
          applied.push(`${layerId ?? 'video'}.${op.replace(/^(set_layer_|crop_image_|update_ai_)/, '')}`)
          if (res.affectedSceneId) lastSceneId = res.affectedSceneId
        } else {
          failures.push(`${layerId ?? 'video'} ${op}: ${res.error ?? 'failed'}`)
        }
      }
    }

    // Partial success is reported honestly rather than collapsed to a single verdict —
    // the model needs to know WHICH property failed to retry just that one.
    if (applied.length === 0) {
      return { success: false, error: `No layer properties applied. ${failures.join('; ')}` }
    }
    return {
      success: true,
      affectedSceneId: lastSceneId ?? sceneId,
      data: { applied, ...(failures.length > 0 ? { failed: failures } : {}) },
    }
  })

  // ── Design system selection (aesthetic "voice" layer). ──
  const designHandler = createDesignToolHandler()
  toolRegistry.registerMany([...DESIGN_SYSTEM_TOOL_NAMES], (toolName, args, world, logger) =>
    designHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── OKF intent-routing tool (knowledge parity for the MCP / Claude Code path) ──
  const okfHandler = createOkfToolHandler()
  toolRegistry.registerMany([...OKF_TOOL_NAMES], (toolName, args, world, logger) =>
    okfHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── Asset/Media tools ──
  const assetMediaHandler = createAssetMediaToolHandler({
    checkApiPermission: checkApiPermission as (
      world: WorldStateMutable,
      api: string,
      context?: { reason?: string; details?: Record<string, any> },
    ) => ToolResult | null | Promise<ToolResult | null>,
    regenerateHTML,
  })
  toolRegistry.registerMany([...ASSET_MEDIA_TOOL_NAMES], (toolName, args, world, logger) =>
    assetMediaHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── Recording tools ──
  const recordingHandler = createRecordingToolHandler()
  toolRegistry.registerMany([...RECORDING_TOOL_NAMES], (toolName, args, world, logger) =>
    recordingHandler(toolName, args, world as WorldStateMutable, logger),
  )

  // ── Template tools ──
  const templateHandler = createTemplateToolHandler()
  toolRegistry.registerMany([...TEMPLATE_TOOL_NAMES], (toolName, args, world) =>
    templateHandler(toolName, args, world as WorldStateMutable),
  )

  // ── Planning & Export tools ──
  const planningExportHandler = createPlanningExportToolHandler()
  toolRegistry.registerMany([...PLANNING_EXPORT_TOOL_NAMES], (toolName, args, world) =>
    planningExportHandler(toolName, args, world as WorldStateMutable),
  )

  const clarifyHandler = createClarifyToolHandler()
  toolRegistry.registerMany([...CLARIFY_TOOL_NAMES], (toolName, args, world) =>
    clarifyHandler(toolName, args, world as WorldStateMutable),
  )

  // ── Plan surface tools: write_plan / update_todos ──
  const planSurfaceHandler = createPlanSurfaceToolHandler()
  toolRegistry.registerMany([...PLAN_SURFACE_TOOL_NAMES], (toolName, args, world) =>
    planSurfaceHandler(toolName, args, world as WorldStateMutable),
  )

  // ── State-query tools: describe_scene_state — read-only, no code bodies ──
  const stateQueryHandler = createStateQueryToolHandler()
  toolRegistry.registerMany([...STATE_QUERY_TOOL_NAMES], (toolName, args, world) =>
    stateQueryHandler(toolName, args, world as WorldStateMutable),
  )

  // ── Three.js / World / Model Library / Lottie tools ──
  // No names of its own any more: world_scene was deleted and both searches are
  // reached as find_media(kind:'3d' | 'lottie') — see the find_media router below.
  const threeWorldHandler = createThreeWorldToolHandler({ regenerateHTML })

  // ── style_skill (distill / apply / delete) ──
  const skillHandler = createSkillToolHandler()
  toolRegistry.registerMany([...SKILL_TOOL_NAMES], (toolName, args, world) =>
    skillHandler(toolName, args as Record<string, unknown>, world as WorldStateMutable),
  )

  // ── Editor-state introspection ──
  // Surfaces the renderer's UI selection + playback + zoom snapshot to the
  // agent. Snapshot is captured at run start (`RunnerOptions.editorState` →
  // `world.editorState`); if absent (e.g. headless MCP path), returns a
  // zeroed-but-valid shape with `selectedSceneId: null` and an explicit hint
  // so the agent knows to fall back to scene scanning.
  const readEditorState = async (w: unknown): Promise<ToolResult> => {
    const world = w as WorldStateMutable
    // B1 (v6 TIMELINE / OV#4): the timeline section is derived LIVE from
    // world.timeline — the same object clip-targeting tools mutate — so the
    // agent never reads two contradictory timelines (one frozen in the run-
    // start UI snapshot, one mutated by move/trim/remove). The snapshot's
    // transport fields (currentTime/zoom/selection) stay frozen by design.
    const liveTimeline = summarizeWorldTimelineForEditorState(world.timeline)
    if (!world.editorState) {
      return {
        success: true,
        data: {
          selectedSceneId: null,
          selectedClipIds: [],
          currentTime: 0,
          isPlaying: false,
          totalDuration: 0,
          timelineZoom: 0,
          capturedAt: null,
          timeline: liveTimeline,
          _hint:
            'No editor snapshot was captured for this run (likely a headless or MCP invocation). Fall back to list_scenes / read_scene for context.',
        },
      }
    }
    return { success: true, data: { ...world.editorState, timeline: liveTimeline } }
  }

  // ── inspect(kind) — the four read-only introspection tools ──
  // Registered here because it is the only scope where all three handlers exist.
  // Each kind runs the ORIGINAL handler body, so every summary, code read and
  // checkpoint listing is byte-identical to the tools it replaced.
  toolRegistry.register('inspect', (_toolName, args, world, logger) => {
    const kind = (args as { kind?: string }).kind ?? 'scene'
    const w = world as WorldStateMutable
    switch (kind) {
      case 'scene':
        return stateQueryHandler('describe_scene_state', args, w)
      case 'snapshots':
        return stateQueryHandler('list_snapshots', args, w)
      case 'code':
        return layerHandler('read_scene_code', args, w, logger)
      case 'editor':
        return readEditorState(w)
      default:
        return Promise.resolve({
          success: false,
          error: `inspect: unknown kind "${String(kind)}" — expected scene, code, editor or snapshots.`,
        })
    }
  })

  // ── get_status(kind) — the three async-job pollers ──
  // export / video / avatar were three tools of the same shape. Each kind runs its
  // ORIGINAL handler case, so the job registry, the layer write-back and every
  // honest-failure path are unchanged.
  toolRegistry.register('get_status', (_toolName, args, world) => {
    const kind = (args as { kind?: string }).kind
    const w = world as WorldStateMutable
    switch (kind) {
      case 'export':
        return planningExportHandler('get_export_status', args, w)
      case 'video':
        return imageVideoHandler('get_video_status', args, w)
      case 'avatar':
        return avatarHandler('get_avatar_status', args, w)
      default:
        return Promise.resolve({
          success: false,
          error: `get_status: unknown kind "${String(kind)}" — expected export, video or avatar.`,
        })
    }
  })

  // Multimodal intake: re-analyze one attached reference media item in
  // detail (beyond the up-front brief). Reuses the intake pipeline for a single
  // item so engine selection + degradation behave identically.
  toolRegistry.register('analyze_reference_media', async (_toolName, args, w) => {
    const world = w as WorldStateMutable
    const mediaId = (args as { mediaId?: string }).mediaId
    const media = world.referenceMedia?.find((m) => m.id === mediaId)
    if (!media) {
      const have = world.referenceMedia?.map((m) => m.id).join(', ') || 'none'
      return { success: false, error: `No reference media with id "${mediaId}". Attached ids: ${have}.` }
    }
    const { buildUnderstandingBrief } = await import('./services/multimodal-intake')
    const { createDbMediaAnalysisCache } = await import('./services/media-analysis-cache')
    const { extractStyleTokens, hasStyleSignal } = await import('./services/style-tokens')
    const brief = await buildUnderstandingBrief([media], {
      engines: world.mediaUnderstandingEngines,
      cache: createDbMediaAnalysisCache(),
    })
    // Reshape intake output into STRUCTURED, consumable style tokens
    // (palette, fonts, mood, lighting, composition, subjects) and stash the
    // latest on `world` so create_design_brief / generate_image_from_reference
    // can seed from this reference without re-running intake. Pure reshape —
    // no extra model call.
    const styleTokens = extractStyleTokens(brief)
    if (hasStyleSignal(styleTokens)) {
      world.referenceStyleTokens = styleTokens
    }
    return {
      success: true,
      data: {
        analysis: brief.perMedia[0] ?? null,
        summary: brief.summary,
        modelsUsed: brief.modelsUsed,
        styleTokens,
      },
    }
  })

  // ── Visual feedback tools ──
  // dispatch_scene_builder is acknowledged here, but the real work (running the
  // orchestrator over the scenePlan) happens in the runner's handoff, which has
  // the SSE emitter, cost state, and parent RunnerOptions a tool handler lacks.
  // The runner detects this tool call in allToolCalls and orchestrates, then ends.
  //
  // Reject honestly when there's nothing to delegate: a scenePlan is required.
  // This is also the discriminator that stops a sub-agent (which runs as
  // 'scene-maker' and is offered this tool, but has no scenePlan) from getting a
  // false "delegating" success and believing scenes are being built when the
  // runner's isSubAgent guard will suppress the handoff.
  toolRegistry.register('dispatch_scene_builder', async (_toolName, _args, w) => {
    const world = w as WorldStateMutable
    // Honest-fail when no orchestrator will consume this call (the MCP /
    // Claude-Code path has no runner loop; a sub-agent's handoff is suppressed).
    // A "Delegating…" success here would make the caller (e.g. Claude Code over
    // MCP) believe scenes were in progress. Tell it to build per-scene directly.
    if (!world.orchestratorAvailable) {
      return {
        success: false,
        error:
          'dispatch_scene_builder is not available on this path — no scene-builder orchestrator will run. Build each planned scene directly: call create_scene then write_scene_code (or write_scene_code with the planned name + duration) for every scene in the plan.',
      }
    }
    if (!world.scenePlan || world.scenePlan.scenes.length < 1) {
      return {
        success: false,
        error: 'No scenePlan to build. Call plan_scenes first, then dispatch_scene_builder.',
      }
    }
    return {
      success: true,
      data: {
        delegated: true,
        sceneCount: world.scenePlan.scenes.length,
        // Neutral wording: the runner routes this to the director loop, which builds
        // the whole video in one context — don't claim "parallel sub-agents".
        message: `Building all ${world.scenePlan.scenes.length} planned scenes.`,
      },
    }
  })

  // dispatch_to_branches: acknowledged here; the real fan-out happens
  // in the renderer (the runner emits a fanout_proposed spec on this call and
  // ends the run). A sub-agent must never fan out — the runner's isSubAgent
  // guard suppresses the handoff, so reject here too to avoid a false success.
  // Clamp count to [2,8] to match the variant pipeline.
  toolRegistry.register('dispatch_to_branches', async (_toolName, args, w) => {
    const a = (args ?? {}) as { count?: number; instruction?: string }
    const count = Math.max(2, Math.min(8, Math.floor(Number(a.count) || 0)))
    if (!a.instruction || typeof a.instruction !== 'string' || !a.instruction.trim()) {
      return { success: false, error: 'dispatch_to_branches requires a non-empty instruction.' }
    }
    // The comment above promised this "rejects to avoid a false success" —
    // but only for the invalid-args cases. Nothing checked that a consumer of
    // `fanout_proposed` exists. On the MCP path (no runner), inside a sub-agent,
    // and inside a dispatched leg (disableFanout), the emit never happens and
    // this returned "Fanning out N takes" to a caller that got nothing.
    if (!(w as WorldStateMutable).fanoutAvailable) {
      return {
        success: false,
        error:
          'dispatch_to_branches is not available on this path — no branch fan-out will run, so nothing would be built. ' +
          'Do the work inline instead (build the variants yourself, or pick one direction and build it).',
      }
    }
    if (count < 2) {
      return {
        success: false,
        error: 'dispatch_to_branches requires count >= 2 (use dispatch_scene_builder for one build).',
      }
    }
    return {
      success: true,
      data: { fanout: true, count, message: `Fanning out ${count} alternative takes to parallel branches.` },
    }
  })

  // dispatch_to_projects: acknowledged here; the real cross-project
  // fan-out happens in the renderer (the runner emits a crossproject_proposed spec
  // on this call and ends the run; the user picks the target projects). A sub-agent
  // must never cross-project dispatch — reject to avoid a false success.
  toolRegistry.register('dispatch_to_projects', async (_toolName, args, w) => {
    const a = (args ?? {}) as { instruction?: string }
    if (!a.instruction || typeof a.instruction !== 'string' || !a.instruction.trim()) {
      return { success: false, error: 'dispatch_to_projects requires a non-empty instruction.' }
    }
    // Same missing consumer-check as dispatch_to_branches — the
    // crossproject_proposed emit is gated on !isSubAgent && !disableFanout and
    // does not exist at all off the runner.
    if (!(w as WorldStateMutable).fanoutAvailable) {
      return {
        success: false,
        error:
          'dispatch_to_projects is not available on this path — no cross-project dispatch will run, so nothing ' +
          'would happen. Apply the change to this project directly.',
      }
    }
    return {
      success: true,
      data: { crossProject: true, instruction: a.instruction, message: 'Proposing a cross-project dispatch.' },
    }
  })

  // dispatch_subagent is intercepted by the runner BEFORE executeTool on the
  // primary (provider-adapter) path — see runner executeAndEmit. This registry
  // entry is only a fallback for non-adapter paths (e.g. local/Ollama parents),
  // where the runner can't spawn; surface that honestly rather than failing with
  // "no handler" or silently claiming success.
  toolRegistry.register('dispatch_subagent', async () => ({
    success: false,
    error:
      'dispatch_subagent is only available on the primary agent path. The current model/provider path does not support sub-agent dispatch; do the task inline instead.',
  }))

  // ── Visual feedback: capture_frame / review_video ──
  const captureFrameHandler = createCaptureFrameToolHandler({ buildCutReviewInput })
  toolRegistry.registerMany([...CAPTURE_FRAME_TOOL_NAMES], (toolName, args, world) =>
    captureFrameHandler(toolName, args, world as WorldStateMutable),
  )

  // ── Verify scene (self-verification loop) ──
  const verifyHandler = createVerifyToolHandler({ readRecentRuntimeVerify, writeRecentRuntimeVerify })
  toolRegistry.registerMany([...VERIFY_TOOL_NAMES], (toolName, args, world) =>
    verifyHandler(toolName, args, world as WorldStateMutable),
  )

  // ── Timeline / Clip tools ──
  const timelineHandler = createTimelineToolHandler({ executeTool })
  toolRegistry.registerMany([...TIMELINE_TOOL_NAMES], (toolName, args, world) =>
    timelineHandler(toolName, args, world as WorldStateMutable),
  )

  // ── send_feedback (tool-gap flywheel) ──
  const feedbackHandler = createFeedbackToolHandler()
  toolRegistry.registerMany([...FEEDBACK_TOOL_NAMES], (toolName, args, world) =>
    feedbackHandler(toolName, args, world as WorldStateMutable),
  )

  handlersRegistered = true
}

/**
 * BOTH directions of the schema↔handler contract, checked once.
 *
 * schema→handler: an offered tool with no handler is an instant runtime failure.
 * handler→schema: a handler with no schema is WORSE — it looks alive (dispatch
 * resolves it, tests exercise it directly) but `executeTool` rejects it below,
 * so the only symptom is a swallowed `Unknown tool` far from the cause.
 */
export function ensureRegistryCoverage(): void {
  if (registryCoverageChecked) return
  const unresolved = [...CANONICAL_TOOL_NAMES].filter((name) => !toolRegistry.hasExplicit(name))
  if (unresolved.length > 0) {
    throw new Error(`Tool registry missing explicit handlers for canonical tools: ${unresolved.join(', ')}`)
  }
  const unreachable = toolRegistry
    .getRegisteredToolNames()
    .filter((name) => !CANONICAL_TOOL_NAMES.has(name) && !INTERNAL_ONLY_TOOL_NAMES.has(name))
  if (unreachable.length > 0) {
    throw new Error(
      `Tool registry has handlers the model can never reach (no schema in ALL_TOOLS): ${unreachable.join(', ')}. ` +
        'Either add the schema back, or delete the handler, or — if OUR code calls it by name — ' +
        'add it to INTERNAL_ONLY_TOOL_NAMES with the caller cited.',
    )
  }
  if (process.env.NODE_ENV !== 'production' && !registryCoverageLogged) {
    log.debug('all canonical tools explicitly registered', { extra: { count: CANONICAL_TOOL_NAMES.size } })
    registryCoverageLogged = true
  }
  registryCoverageChecked = true
}

// Throttle the stale-reservation sweep — once per minute is plenty, and
// keeps us off the hot path for every single tool call.
let lastReservationSweepMs = 0
const RESERVATION_SWEEP_INTERVAL_MS = 60_000
// video_jobs prune: the table grows one row per generation and is never otherwise
// cleaned. Prune terminal rows older than a week, at most hourly (low-urgency desktop).
let lastVideoJobPruneMs = 0
const VIDEO_JOB_PRUNE_INTERVAL_MS = 60 * 60_000
const VIDEO_JOB_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/** Arg keys that carry a single scene id, across every scene-targeting tool. */
const SCENE_ID_ARG_KEYS = ['sceneId', 'fromSceneId', 'toSceneId', 'sourceSceneId', 'targetSceneId'] as const
/** Arg keys that carry an array of scene ids. */
const SCENE_ID_ARRAY_ARG_KEYS = ['sceneIds'] as const

/**
 * Read-only allowlist for the inverted scene-scope guard.
 *
 * A scene-builder sub-agent (`world.scopeForeignSceneIds` set) owns ONE scene
 * and must not touch any pre-existing foreign scene. The old guard only blocked
 * tools tagged `mutates`, but the VAST majority of mutators are untagged
 * (`add_layer`, `place_image`, `add_narration`, `set_camera_motion`,
 * `regenerate_layer`, `generate_chart`, `add_element`, `set_video_layer`,
 * `write_scene_code`, …) — so a sub-agent could stomp a foreign scene through
 * any untagged mutator. We INVERT the guard: block ANY tool whose
 * `collectTargetedSceneIds(args)` hits a foreign scene UNLESS the tool is on
 * this allowlist.
 *
 * Membership rule: the tool must PURELY read/inspect a scene and persist
 * nothing (no `updateScene` / `regenerateHTML` / DB write) — legit cross-scene
 * reads a sub-agent needs (e.g. "look at what scene X did"). Enumerated by
 * cross-referencing every scene-id-accepting tool in `tools.ts` against its
 * handler:
 *   - read_scene_code        (layer-tools.ts)      — returns code, no write
 *   - describe_scene_state   (state-query-tools.ts)— returns state summary
 *   - verify_scene           (verify-tools.ts)     — static analysis, no write
 *   - capture_frame          (capture-frame-tools) — reads scene, returns desc
 *   - review_scene_motion    (capture-frame-tools) — reads scene, returns brief
 *   - analyze_reference_media(design/media-library)— reads a reference asset
 *
 * DELIBERATELY EXCLUDED (they persist scene changes, so foreign-scene calls are
 * real stomps): `get_video_status` / `get_avatar_status` patch the layer +
 * regenerate HTML on completion; `save_as_template`, `annotate_simulation`,
 * every `add_*`/`set_*`/`update_*`/`create_*`/`generate_*`/`apply_*`/`move_*`/
 * `remove_*`/`reorder_*`/`resize_*` tool mutates. `analyze_reference_media`
 * doesn't declare a `sceneId` in its schema today, but the guard checks ARG keys
 * (not schema), so a stray `sceneId` arg would still be caught — keep it here so
 * that legit read never over-blocks.
 */
export const READ_ONLY_FOREIGN_SCENE_TOOLS: ReadonlySet<string> = new Set([
  // inspect covers what read_scene_code + describe_scene_state used to.
  'inspect',
  'verify_scene',
  'capture_frame',
  // review is scope-checked by the RUNNER (scope:'motion' may review only the
  // builder's OWN scene); it is allowlisted here so the generic guard doesn't
  // pre-empt that more precise check.
  'review',
  'analyze_reference_media',
])

// ── Min-unique id-prefix expansion ───────────────────────────────────
// The high-traffic READ tools emit shortened id prefixes; every tool ACCEPTS
// them back. We expand any prefix in an id-valued arg to the full id here — at
// the one chokepoint both the in-app agent and the executeMcpTool bridge pass
// through — BEFORE scope/scene resolution sees it, so downstream code only ever
// deals with full ids. An ambiguous prefix is surfaced as a tool error; an
// unknown value passes through so the tool emits its own not-found error.

/** Single-id arg keys that carry an entity id the agent might pass as a prefix.
 *  Scene ids plus the layer/clip/track/checkpoint/marker id keys used across the
 *  tool surface. */
const ID_PREFIX_SCALAR_KEYS = [
  ...SCENE_ID_ARG_KEYS,
  'layerId',
  'objectId',
  'elementId',
  'interactionId',
  'overlayId',
  'clipId',
  'sourceClipId',
  'targetClipId',
  'trackId',
  'sourceTrackId',
  'targetTrackId',
  'markerId',
  'checkpointId',
  'chartId',
] as const
/** Array-id arg keys (parallel to the scalar set). */
const ID_PREFIX_ARRAY_KEYS = [...SCENE_ID_ARRAY_ARG_KEYS, 'clipIds', 'targetClipIds', 'layerIds'] as const

/**
 * Expand id-prefix arguments back to full ids against the live universe.
 * Mutates nothing — returns a new args object only when something changed.
 * Throws AmbiguousIdError (caught by executeTool → tool error) on a prefix that
 * matches more than one id.
 */
export function expandIdArgs(args: Record<string, unknown>, world: WorldStateMutable): Record<string, unknown> {
  const universe = collectIdUniverse(world)
  if (universe.size === 0) return args
  let changed = false
  const out: Record<string, unknown> = { ...args }
  for (const k of ID_PREFIX_SCALAR_KEYS) {
    const v = out[k]
    if (typeof v === 'string' && v.length > 0) {
      const full = expandIdPrefix(v, universe)
      if (full !== v) {
        out[k] = full
        changed = true
      }
    }
  }
  for (const k of ID_PREFIX_ARRAY_KEYS) {
    const v = out[k]
    if (Array.isArray(v)) {
      const mapped = v.map((e) => (typeof e === 'string' && e.length > 0 ? expandIdPrefix(e, universe) : e))
      if (mapped.some((e, i) => e !== v[i])) {
        out[k] = mapped
        changed = true
      }
    }
  }
  return changed ? out : args
}

/** Collect every scene id a tool call targets, for scene-scope enforcement.
 *  Exported for direct unit testing — no current mutating tool uses the alt arg
 *  names (fromSceneId/toSceneId/sceneIds[]), so this generalization is
 *  future-proofing and can't be exercised through a real tool yet. */
export function collectTargetedSceneIds(args: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const k of SCENE_ID_ARG_KEYS) {
    if (typeof args[k] === 'string') ids.push(args[k] as string)
  }
  for (const k of SCENE_ID_ARRAY_ARG_KEYS) {
    const v = args[k]
    if (Array.isArray(v)) for (const e of v) if (typeof e === 'string') ids.push(e)
  }
  return ids
}

// ── Abort signal side-channel ───────────────────────────────────────────
// worldAbortSignals + setWorldAbortSignal + getWorldAbortSignal moved to the top of
// this module — they must be initialized before any handler can re-enter. See the
// "Run Abort Signal" block up there.

/** Build the canonical aborted ToolResult — keeps the marker flag and the
 *  human-readable message together so no consumer substring-matches. */
export function abortResult(message: string): ToolResult {
  return { success: false, error: message, aborted: true }
}

/** The one sanctioned way to ask "was this failure a user Stop?". */
export function isAbortResult(result: ToolResult): boolean {
  return result.aborted === true
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  world: WorldStateMutable,
  logger?: AgentLogger,
): Promise<ToolResult> {
  ensureAllHandlersRegistered()
  ensureRegistryCoverage()
  // INTERNAL_ONLY names are not offered to the model but ARE called by our own
  // code through this same chokepoint (see the set's per-entry citations).
  if (!CANONICAL_TOOL_NAMES.has(toolName) && !INTERNAL_ONLY_TOOL_NAMES.has(toolName)) {
    return err(`Unknown tool: ${toolName}`)
  }

  // A Stop that lands while a tool is already being dispatched must not
  // start the work. The runner has its own per-block abort checks, but this
  // gate also covers callers that don't (sub-agent worlds, parallel-batch
  // isolated worlds, future direct callers) — defense in depth at the one
  // choke point every tool passes through.
  if (getWorldAbortSignal(world)?.aborted) {
    logger?.log('tool_exec', `Skipped ${toolName} — run aborted`)
    return abortResult('Run aborted by user — tool not executed')
  }

  // ── Min-unique id-prefix expansion ────────────────────────────────
  // The READ tools emit shortened id prefixes; expand any back to full ids here,
  // before scope/scene resolution reads them, so the model can name ids back by
  // their short form. An ambiguous prefix is a clear, recoverable tool error.
  try {
    args = expandIdArgs(args, world)
  } catch (e) {
    if (e instanceof AmbiguousIdError) {
      logger?.log('tool_exec', `Ambiguous id prefix for ${toolName}: ${e.prefix}`)
      return err(e.message)
    }
    throw e
  }

  // ── Execution-time toolset enforcement (Workstream C.2b) ──────────────────
  // A sub-agent is offered only the tools relevant to its scene. Enforce that
  // here too, not just in the offered list: the model can still emit a tool
  // name that was filtered out (hallucination, stale memory, or a provider that
  // isn't configured). Reject it so the sub-agent stays inside its assigned
  // toolset.
  if (world.enforcedToolNames && !world.enforcedToolNames.has(toolName)) {
    logger?.log('tool_exec', `Blocked out-of-toolset tool: ${toolName}`)
    return err(
      `Tool "${toolName}" is not available for this scene — it is outside this scene-builder's toolset, ` +
        `or it needs a provider (e.g. audio/video/avatar) that is not configured. Use the tools offered for this scene.`,
    )
  }

  // ── Scene-scope enforcement (Workstream C.2a — TaskPacket scope) ──────────
  // A scene-builder sub-agent owns ONE scene. If ANY tool targets a pre-existing
  // scene it doesn't own, reject — this is what stops cross-scene stomping when
  // several sub-agents build in parallel. We check every scene-id-valued arg
  // (sceneId, fromSceneId/toSceneId, sceneIds[], etc.), not just `sceneId`, so
  // multi-scene tools can't slip through. Tools targeting only the owned/created
  // scene are unaffected; scenes the sub-agent creates aren't in the foreign set
  // so they remain writable.
  //
  // INVERTED GUARD: block by default, allow only known read-only tools.
  // The prior version gated on `getToolDef(toolName).mutates`, but almost all
  // mutators are UNTAGGED (add_layer, place_image, add_narration,
  // set_camera_motion, regenerate_layer, generate_chart, add_element,
  // set_video_layer, write_scene_code, …), so a sub-agent could freely stomp a
  // foreign scene through any untagged mutator. Now: if the tool targets a
  // foreign scene, reject UNLESS it is on the READ_ONLY_FOREIGN_SCENE_TOOLS
  // allowlist. This is scope-only; the separate destructive-preview gate below
  // keeps its own `def?.mutates` predicate untouched.
  if (world.scopeForeignSceneIds && world.scopeForeignSceneIds.size > 0) {
    if (!READ_ONLY_FOREIGN_SCENE_TOOLS.has(toolName)) {
      const foreign = collectTargetedSceneIds(args).find((id) => world.scopeForeignSceneIds!.has(id))
      if (foreign) {
        logger?.log('tool_exec', `Blocked out-of-scope tool: ${toolName} on ${foreign}`)
        return err(
          `Scene "${foreign}" is outside your assigned scope. You may only modify the scene you were dispatched to build (and any scene you create yourself). ` +
            `If you only need to inspect it, use a read-only tool (inspect, verify_scene, capture_frame).`,
        )
      }
    }
  }

  // Housekeeping: sweep any budget reservations that never got reconciled
  // (crashed tool handlers, network failures). Running once per minute is a
  // good balance between leak protection and overhead.
  const now = Date.now()
  if (now - lastReservationSweepMs > RESERVATION_SWEEP_INTERVAL_MS) {
    lastReservationSweepMs = now
    try {
      const { sweepStaleReservations } = await import('./budget-tracker')
      const swept = sweepStaleReservations()
      if (swept > 0) logger?.log('budget', `Swept ${swept} stale budget reservation(s)`)
    } catch {
      /* best-effort */
    }
  }

  // Housekeeping: prune old terminal video_job rows so the durability table doesn't grow
  // unbounded. Hourly, best-effort — pending rows are untouched.
  if (now - lastVideoJobPruneMs > VIDEO_JOB_PRUNE_INTERVAL_MS) {
    lastVideoJobPruneMs = now
    try {
      const { pruneTerminalVideoJobs } = await import('@/lib/db/queries/video-jobs')
      const pruned = await pruneTerminalVideoJobs(VIDEO_JOB_MAX_AGE_MS)
      if (pruned > 0) logger?.log('budget', `Pruned ${pruned} old video job row(s)`)
    } catch {
      /* best-effort */
    }
  }

  // Log tool inputs (truncate large string values like code/prompt)
  const inputSummary: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 150) {
      inputSummary[k] = `${v.slice(0, 150)}… [${v.length} chars]`
    } else {
      inputSummary[k] = v
    }
  }
  logger?.log('tool_exec', `executeTool(${toolName})`, inputSummary)

  // ── Web Search approval gate ─────────────────────────────────────────────
  // request_web_search is the proxy the agent calls when Web Search is ON, Auto-Accept is OFF,
  // and the user hasn't approved this chat yet (native search can't be paused mid-stream, so we
  // gate at tool-injection time + surface this proxy). Pause for a one-time approval card; on
  // approval sessionPermissions['web_search'] becomes 'allow' and the resumed run's
  // context-builder injects the real native web_search.
  if (toolName === REQUEST_WEB_SEARCH_TOOL_NAME) {
    // Approval comes ONLY from the user-set session grant — never from a model-supplied
    // arg. The model controls its own tool-call input (no additionalProperties:false /
    // removeAdditional on this tool), so trusting an `__approved` flag here would let the
    // model suppress its own consent card. The resume path sets sessionPermissions, which
    // this reads on the next request.
    if (world.sessionPermissions?.['web_search'] !== 'allow') {
      return {
        success: false,
        error: 'Web search requires the user to approve it once for this session.',
        permissionNeeded: {
          api: 'web_search' as never,
          toolName,
          kind: 'web_search',
          estimatedCost: 'approve once per session',
          toolArgs: args,
        },
      }
    }
  }

  // ── Diff-preview gate ────────────────────────────────────────
  // When previewMode requires it, intercept BEFORE side effects and surface
  // the call to the user as a pending mutation. The runner reuses the
  // existing permission/resume infrastructure: on approval the same tool is
  // re-dispatched with `__previewApproved: true` set, which short-circuits
  // this check so the second pass executes normally.
  const previewApproved = args['__previewApproved'] === true
  if (previewApproved) {
    delete args['__previewApproved']
  }
  const def = getToolDef(toolName)
  const previewMode = world.previewMode ?? 'off'
  const shouldPreview =
    !previewApproved && ((previewMode === 'destructive-only' && !!def?.mutates) || previewMode === 'always')
  if (shouldPreview) {
    return {
      success: false,
      error: `Preview required: ${toolName} is tagged as ${def?.mutates ?? 'mutating'} and previewMode is "${previewMode}". Awaiting user approval.`,
      permissionNeeded: {
        api: 'mutation_preview' as never,
        toolName,
        kind: 'mutation_preview',
        mutationScope: def?.mutates ?? 'scene',
        estimatedCost: '$0',
        toolArgs: args,
      },
    }
  }

  // Run pre-tool hooks (can deny or modify args)
  const preResult = await runPreToolHooks({ toolName, args, world }, logger)
  if (preResult.deny) {
    return err(`Hook denied: ${preResult.reason ?? 'blocked by pre-tool hook'}`)
  }
  const finalArgs = preResult.modifiedArgs ?? args

  // Snapshot before every execution for undo/recovery
  const preSnapshot = createSnapshot(world, `before:${toolName}`)
  // Named-checkpoint promotion (single-clone): the destructive-op pre-hook
  // sets a label instead of cloning the world itself; the per-tool snapshot
  // above already deep-cloned everything, so the named checkpoint SHARES those
  // frozen arrays (snapshots are immutable after creation) — same safety, half
  // the clone cost.
  if (world._pendingNamedCheckpointLabel) {
    pushNamedCheckpoint(world, {
      ...preSnapshot,
      id: uuidv4(),
      description: world._pendingNamedCheckpointLabel,
    })
    delete world._pendingNamedCheckpointLabel
  }

  const timeoutMs = toolTimeoutMs(toolName)
  trace('tool.call', {
    name: toolName,
    sceneId: (finalArgs as { sceneId?: unknown }).sceneId,
    scenes: world.scenes.length,
  })
  // Count paid visual/video generation dispatches against the run's media-gen
  // backstop — at dispatch (not on success), so a loop of failing gens is bounded
  // too. The runner drains this per-world count into the shared RunCostLedger and
  // stops the run past the cap. Counts $0/free-provider gens the dollar cap skips.
  if (MEDIA_GEN_COUNT_SET.has(toolName)) noteMediaGenDispatch(world)

  const startMs = Date.now()
  let result: ToolResult
  try {
    let timer: ReturnType<typeof setTimeout>
    result = await Promise.race([
      toolRegistry.execute(toolName, finalArgs, world, logger),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer!))
  } catch (thrown) {
    // Rollback world state to the pre-execution snapshot so partial
    // mutations from a failed/timed-out tool don't persist.
    restoreSnapshot(world, preSnapshot)
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    logger?.error('tool_exec', `Tool ${toolName} threw: ${message}`)
    result = { success: false, error: `Tool ${toolName} failed: ${message}` }
  }
  const durationMs = Date.now() - startMs
  recordToolResult(toolName, result.success)
  // Feed the send_feedback diagnostics trail (recent tools + last error).
  recordFeedbackTool(toolName, result)

  // Trace the outcome + the affected scene's code/HTML/verify state. This is the
  // smoking gun for the "two empty Not-found scenes" loop: a create_scene that
  // leaves reactLen:0 / htmlLen:0, then a verify/capture that errors on it.
  if (traceEnabled()) {
    const sc = result.affectedSceneId ? world.scenes.find((s) => s.id === result.affectedSceneId) : undefined
    trace('tool.done', {
      name: toolName,
      ok: result.success,
      sceneId: result.affectedSceneId,
      err: result.error ? tclip(result.error) : undefined,
      ms: durationMs,
      ...(sc
        ? {
            sceneName: sc.name,
            reactLen: (sc as { reactCode?: string }).reactCode?.length ?? 0,
            htmlLen: (sc as { sceneHTML?: string }).sceneHTML?.length ?? 0,
            verify: (sc as { verifyStatus?: string }).verifyStatus,
          }
        : {}),
    })
  }

  // Per-result scene resolution: both the generation-tool quick-validation
  // and the verify-error gate look at the affected scene's stamped state.
  if (result.success && result.affectedSceneId) {
    const scene = world.scenes.find((s) => s.id === result.affectedSceneId)
    if (scene) {
      // Auto-validate after GENERATION tools only — append quick checks so the
      // agent gets immediate feedback without a separate verify_scene call.
      // (Quick-validation is a generation-intent heuristic; it stays gated.)
      if (GENERATION_TOOL_SET.has(toolName)) {
        const warnings = quickValidateScene(
          scene,
          resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution),
        )
        if (warnings.length > 0) {
          result.data = {
            ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
            _autoValidation: {
              status: 'warnings',
              issues: warnings,
              hint: 'Fix these issues with patch_layer_code or regenerate_layer, then call verify_scene.',
            },
          }
          logger?.warn('auto_validate', `${toolName} succeeded but scene has issues`, {
            sceneId: result.affectedSceneId,
            warnings,
          })
        }
      }

      // Verify-scene gate (surfaced to the agent for ALL tools, not
      // just GENERATION_TOOL_SET). Many tools call regenerateHTML
      // (patch_layer_code, set_layer_opacity, set_scene_background,
      // set_global_style, motion/element/chart tools, ...). When
      // regenerateHTML fails under those, the scene gets verifyStatus
      // 'errored' and the USER sees it — but previously the AGENT got
      // success:true with no signal. Inject the recoverable `_verify` signal
      // whenever the affected scene errored, regardless of tool membership,
      // so the LLM can self-correct on its next turn. For runtime/timeout the
      // tool stays "successful" — verify is advisory there, because those are
      // environment/timing-sensitive and can false-positive (a slow-init scene
      // on a loaded machine), so we don't want to roll back an otherwise-fine
      // action. SYNTAX is the exception (see escalation below): it's
      // deterministic and never intentional.
      if (scene.verifyStatus === 'errored' && scene.verifyError) {
        const err = scene.verifyError
        const where = typeof err.line === 'number' ? ` at line ${err.line}` : ''
        const hint =
          err.kind === 'syntax'
            ? 'Fix the syntax error with patch_layer_code, then call regenerate_layer.'
            : err.kind === 'timeout'
              ? 'Scene script likely has an infinite loop or extremely slow init. Simplify with patch_layer_code.'
              : 'Use patch_layer_code or regenerate_layer to fix the runtime error.'
        result.data = {
          ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
          _verify: {
            status: 'errored',
            kind: err.kind,
            message: `Scene had ${err.kind} error${where}: ${err.message}`,
            hint,
          },
        }
        logger?.warn('verify_scene', `${toolName} produced an errored scene`, {
          sceneId: result.affectedSceneId,
          verifyError: err,
        })

        // Hard-fail on SYNTAX errors from a code-authoring (generation) tool.
        // A syntax error is deterministic and never intentional, so a tool
        // whose job is to emit renderable scene code has objectively failed —
        // a weaker/budget model can otherwise ignore the advisory above and
        // end its turn, leaving the user a scene that throws on playback while
        // the chat reports success. Flipping to failure forces a corrective
        // pass (it does NOT roll back the write — the broken scene stays so the
        // model can patch it, mirroring the pixel-truth render gate below).
        // Scoped to code-authoring tools so an unrelated edit (e.g.
        // set_layer_opacity) that merely touched a pre-broken scene isn't blamed
        // for it. Includes patch_layer_code (the primary edit tool) so a patch
        // that introduces a syntax error is forced to be fixed, not reported as
        // a cheerful success.
        if (err.kind === 'syntax' && CODE_AUTHORING_TOOL_SET.has(toolName)) {
          result.success = false
          result.error = `Scene has a syntax error${where} and will not render: ${err.message}`
        }
      } else if (verifySkippedForTool(toolName, scene.verifyStatus)) {
        // The scene wasn't 'errored' but 'unknown':
        // the verifier infra was unavailable, so the blank/broken render gate
        // never ran. Do NOT silently pass it (the old behavior). Surface a
        // VISIBLE, NON-BLOCKING `_verifySkipped` marker so the agent and UI know
        // the scene shipped unverified and can confirm it with verify_scene /
        // capture_frame. success stays true (soft-fail): a fine scene must still
        // ship when the machine simply lacks a verifier window.
        result.data = {
          ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
          _verifySkipped: {
            reason: 'verifier-unavailable',
            message:
              'Scene shipped WITHOUT render verification (verifier infra unavailable) — could not confirm it is not blank/broken. Call verify_scene or capture_frame to confirm.',
          },
        }
        logger?.warn('verify_scene', `${toolName} shipped a scene unverified (verifier unavailable)`, {
          sceneId: result.affectedSceneId,
        })
      }

      // Html-honesty gate. `regenerateHTML` can decline to write the
      // on-disk HTML for a reason that does NOT stamp verifyStatus:'errored' —
      // a mid-flight ABORT or an unknown/invalid sceneId — and handlers discard
      // its `{ htmlWritten:false }` result, returning a cheerful ok(). The world
      // mutation is real but the preview/export render did NOT refresh. Surface
      // that honestly: attach `htmlWritten:false`, and for an abort flip the
      // tool to a failure (the run is ending; a "success" here is a lie the user
      // sees as a landed render that never wrote). Read-and-clear the transient
      // flag so it can't leak into the next tool. (The `verifyStatus:'errored'`
      // write-throw case is already handled by the `_verify` gate above.)
      const unwritten = world._recentHtmlUnwritten?.[scene.id]
      if (unwritten && world._recentHtmlUnwritten) delete world._recentHtmlUnwritten[scene.id]
      if (unwritten) {
        result.data = {
          ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
          htmlWritten: false,
          _htmlWrite: { status: 'unwritten', reason: unwritten.reason },
        }
        if (unwritten.reason === 'aborted') {
          result.success = false
          result.aborted = true
          result.error =
            unwritten.error ??
            'Run aborted by user — the scene HTML did not write; the preview/export render did not refresh.'
        } else {
          logger?.warn('html', `${toolName} left ${scene.id} HTML unwritten (${unwritten.reason})`, {
            sceneId: scene.id,
          })
        }
      }

      // Scene-determinism lint (advisory). Frame-by-frame export requires the
      // scene to render identically on every seek — `Math.random`, wall-clock
      // time, and real timers all make a frame vary between runs (flicker /
      // non-reproducible MP4). The prompt already tells the model to use
      // `mulberry32(SEED)` and the frame clock, but prompting isn't
      // enforcement, so statically scan the WRITTEN scene code and surface any
      // violation as a non-blocking `_determinism` signal. This does NOT set
      // success:false or mark the scene errored — it sits alongside `_verify`
      // (a scene can carry both) so the agent can patch on its next turn.
      const sceneCodeForScan = collectSceneCode(scene)
      if (sceneCodeForScan) {
        const violations = scanForNondeterminism(sceneCodeForScan, scene.sceneType)
        if (violations.length > 0) {
          result.data = {
            ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
            _determinism: {
              violations,
              note: 'These break frame-accurate export — fix before final render.',
            },
          }
          logger?.warn('determinism', `${toolName} wrote non-deterministic scene code`, {
            sceneId: result.affectedSceneId,
            constructs: violations.map((v) => v.construct),
          })
        }
      }

      // ${...}-in-quoted-string lint (#6, ADVISORY for code-authoring tools).
      // `${expr}` inside a plain quoted string renders as the literal text
      // "${expr}" — the bug that drew broken SVG paths / dead transforms in the
      // captured trace. The runtime syntax gate can't catch it (it isn't a
      // syntax error). But this is deliberately NON-blocking: a code-walkthrough
      // / instructional scene can legitimately DISPLAY `${...}` as on-screen
      // text ("Claude Code for videos" is a stated use case), and a regex over
      // un-lexed source can't tell an intended literal from the bug. Hard-failing
      // would block valid builds — the exact regression class this set out to
      // remove. Surface it as a `_codegen` advisory (like _determinism /
      // _layout) so the model fixes a real bug on its next turn but is never
      // blocked on an intentional literal. Scoped to CODE_AUTHORING_TOOL_SET so
      // an unrelated edit isn't blamed for pre-existing code.
      if (
        CODE_AUTHORING_TOOL_SET.has(toolName) &&
        sceneCodeForScan &&
        hasTemplateInterpInQuotedString(sceneCodeForScan)
      ) {
        result.data = {
          ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
          _codegen: {
            issue: 'template-interp-in-quoted-string',
            note: '${...} appears inside a plain quoted string. If it is an SVG `d`/`transform`/CSS value, it renders as literal text — switch to a backtick template literal {`...${value}...`} or string concatenation. If the literal "${...}" is intentional on-screen text (e.g. a code walkthrough), ignore this.',
          },
        }
        logger?.warn('codegen', `${toolName} wrote \${...} inside a quoted string (advisory)`, {
          sceneId: result.affectedSceneId,
        })
      }

      // Layout-overflow lint (advisory). The single most common ugly-demo
      // defect is TEXT spilling outside the frame. regenerateHTML measures the
      // verified scene at its settled hold frame and stashes any overflowing
      // text runs on world._recentSceneOverflows. Surface them as a
      // NON-BLOCKING `_layout` signal alongside `_verify` / `_determinism` (a
      // scene can carry all three) so the agent self-corrects on its next turn.
      // This NEVER sets success:false or marks the scene errored — overflow is
      // quality, not an error. (Could later also carry contrast / animation
      // findings via this same channel.)
      // CONSUME-and-delete: only the tool whose regenerateHTML (or verify_scene)
      // just measured this scene should surface its overflows. Reading without
      // deleting let non-regenerating tools (capture_frame, a clean re-verify)
      // re-surface a STALE advisory on the same scene. Fire once for the tool
      // that produced it, then clear.
      const overflows = world._recentSceneOverflows?.[scene.id]
      if (world._recentSceneOverflows) delete world._recentSceneOverflows[scene.id]
      if (overflows && overflows.length > 0) {
        result.data = {
          ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
          _layout: {
            overflows,
            note: 'Text overflows the frame — keep text within WIDTH×HEIGHT (use smaller font / wrap / reposition).',
          },
        }
        logger?.warn('layout', `${toolName} produced text overflowing the frame`, {
          sceneId: result.affectedSceneId,
          overflows: overflows.map((o) => o.id),
        })
      }

      // Pixel-truth gate (BLOCKING — the single hard render gate). Unlike the
      // advisory _verify / _determinism / _layout signals above, a scene that
      // VERIFIED (ran clean) but rendered an essentially BLANK frame, or whose
      // images ALL failed to load, is a broken build the audience would see.
      // Flip the tool to failure so the agent is forced into a corrective pass.
      // Both the direct loop and scene-builder sub-agents run through executeTool,
      // so this closes the loop on EVERY build path without a vision engine and at
      // zero LLM cost. Scoped to the unambiguous cases only (see evaluateRenderBlock)
      // per the chosen veto posture. Consume-and-delete like the overflow advisory
      // so a stale blank verdict can't re-fire on a later non-rendering tool.
      // Scoped to code-authoring tools — mirrors the syntax gate above. A
      // camera / transition / background tool (set_camera_motion,
      // set_transition, set_scene_background) regenerates HTML and so measures
      // a frame, but it did NOT author the pixels: failing it for a scene that
      // was already blank (e.g. a legitimately dark scene caught mid animate-in)
      // blames the wrong tool and sends the agent into a destructive
      // delete/recreate churn. The
      // blank is the SCENE CODE's problem; surface it when a generation tool
      // next touches the scene, not when an unrelated edit brushes past it.
      const frame = world._recentSceneFrame?.[scene.id]
      if (world._recentSceneFrame) delete world._recentSceneFrame[scene.id]
      const block = renderBlockForTool(toolName, scene.verifyStatus, frame)
      if (block && frame) {
        result.success = false
        result.error = `Render check failed: ${block.reason}`
        result.data = {
          ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
          _render: {
            status: block.kind,
            nonblankRatio: frame.nonblankRatio,
            brokenImages: frame.brokenImages,
            totalImages: frame.totalImages,
            hint: block.hint,
          },
        }
        logger?.warn('render', `${toolName} produced a ${block.kind} render — flipped to failure`, {
          sceneId: result.affectedSceneId,
          frame,
        })
      }

      // FLOW gate (BLOCKING — structural quality by construction, Lane 1). A
      // code-authoring write on a react/motion scene that produced a genuinely
      // motionless slide is flipped to failure so the agent is forced to animate
      // it — the motion analog of the render gate forcing a non-blank frame. Gated
      // on CODE_AUTHORING_TOOL_SET at the call site so it neither runs nor scans
      // for camera/transition/background tools that can't author pixels, and
      // skipped once the render gate already failed the tool (no stacked verdicts).
      // Uses hasTimeDrivenMotion (a single cheap regex) — no scanForFlow here, so
      // no double scan on the hot write path.
      if (
        result.success &&
        sceneCodeForScan &&
        CODE_AUTHORING_TOOL_SET.has(toolName) &&
        (scene.sceneType === 'react' || scene.sceneType === 'motion')
      ) {
        const flowBlock = flowBlockForTool(
          toolName,
          scene.sceneType,
          sceneCodeForScan,
          (scene.cameraMotion?.length ?? 0) > 0,
        )
        if (flowBlock) {
          result.success = false
          result.error = `FLOW check failed: ${flowBlock.reason}`
          result.data = {
            ...(typeof result.data === 'object' && result.data !== null ? result.data : {}),
            _flow: { staticSlide: true, hint: flowBlock.hint },
          }
          logger?.warn('flow', `${toolName} produced a static slide — flipped to failure (FLOW gate)`, {
            sceneId: result.affectedSceneId,
          })
        }
      }
    }
  }

  // Trace the FINAL signals the agent receives — the blocking render-gate flip
  // (_render blank), an errored verify (_verify), and the advisory autoValidation
  // / determinism / layout notes. This is the smoking gun for the "agent thinks
  // its verified code is blank and loops simplifying it": a write_scene_code that
  // returns ok=false with _render.status:'blank' despite verify:'verified'.
  if (traceEnabled()) {
    const d = (result.data ?? {}) as Record<string, unknown>
    const render = d._render as { status?: string; nonblankRatio?: number } | undefined
    const av = d._autoValidation as { issues?: unknown[] } | undefined
    trace('tool.result', {
      name: toolName,
      ok: result.success,
      sceneId: result.affectedSceneId,
      err: result.error ? tclip(result.error) : undefined,
      renderBlock: render ? `${render.status}(nonblank=${render.nonblankRatio})` : undefined,
      verifyErr: (d._verify as { status?: string } | undefined)?.status,
      autoVal: Array.isArray(av?.issues) ? av!.issues.length : undefined,
      flow: Array.isArray(av?.issues) ? tclip(JSON.stringify(av!.issues), 200) : undefined,
    })
  }

  // ── Min-unique id shortening (OUTPUT side) ────────────────────────
  // The high-traffic READ tools dominate the agent's token budget with full
  // 36-char UUIDs. Shorten every KNOWN id in their structured `data` to its
  // min-unique prefix on the way out; executeTool's expandIdArgs accepts the
  // prefix back on the next call. Scoped to read-only tools so we never rewrite
  // an id a mutation just minted (which isn't in the universe yet anyway). Run
  // AFTER post-hooks would also work, but data is settled here and hooks don't
  // touch ids — keep it adjacent to the return.
  if (result.success && SHORTEN_ID_OUTPUT_TOOLS.has(toolName) && result.data != null) {
    const universe = collectIdUniverse(world)
    if (universe.size > 0) {
      result = { ...result, data: shortenIdsDeep(result.data, universe) }
    }
  }

  // Run post-tool hooks (can augment or flag results)
  return runPostToolHooks({ toolName, args: finalArgs, result, world, durationMs }, logger)
}

/** Read-only tools whose structured output carries entity ids worth compressing.
 *  Kept narrow (the high-traffic context reads) so id shortening never touches a
 *  mutation result. read_scene / list_scenes are the MCP-server's own handlers
 *  (scripts/mcp/mcp-server.ts) and are shortened there. */
const SHORTEN_ID_OUTPUT_TOOLS = new Set(['read_timeline', 'describe_scene_state', 'list_snapshots'])

// ── HTML Regeneration ─────────────────────────────────────────────────────────

/** @internal exported for tests (abort persist-boundary gate) */
export async function regenerateHTML(
  world: WorldStateMutable,
  sceneId: string,
  logger?: AgentLogger,
): Promise<{
  htmlWritten: boolean
  verifyStatus?: 'unknown' | 'pending' | 'verifying' | 'verified' | 'errored'
  verifyError?: import('@/lib/db/schema').SceneVerifyError | null
  /**
   * Leaf text runs that overflow the scene frame at the settled hold frame
   * (advisory; present only when the scene verified and the measurement ran).
   * Surfaced non-blockingly to the agent via `result.data._layout` — see the
   * post-tool gate. Could later carry contrast / animation findings too.
   */
  overflows?: import('../services/scene-verifier').SceneOverflow[]
  /** Pixel-truth reading of the verified scene (blank / broken-image detection).
   *  Present only when the scene verified and the capture+probe ran. The post-tool
   *  gate turns a confident blank/all-broken reading into a hard failure. */
  frame?: import('../services/scene-verifier').SceneFrameTruth
  /** Set when the HTML write itself threw — distinct from a verify error. */
  error?: string
}> {
  const scene = findScene(world, sceneId)
  if (!scene) {
    // An unknown scene id can't stamp verifyStatus (there's no scene to
    // stamp). Record it so the post-tool gate surfaces htmlWritten:false rather
    // than letting the handler's ok() report a phantom render.
    ;(world._recentHtmlUnwritten ??= {})[sceneId] = { reason: 'invalid-scene' }
    return { htmlWritten: false }
  }
  if (!SCENE_ID_RE.test(sceneId)) {
    logger?.error('html', `Invalid sceneId rejected: ${sceneId}`)
    ;(world._recentHtmlUnwritten ??= {})[sceneId] = { reason: 'invalid-scene' }
    return { htmlWritten: false }
  }
  // Persist-boundary gate: this is the single disk-write choke point every
  // mutating handler funnels through. A Stop landing while a tool is mid-
  // flight must not flip the on-disk preview after the user said stop — the
  // dispatch gate can't help here (the tool already started), and the
  // generation-helper check is one layer too low (the write happens after it
  // returns). Skip the write; the run is ending and nothing consumes it.
  if (getWorldAbortSignal(world)?.aborted) {
    logger?.log('html', `Skipped HTML write for ${sceneId} — run aborted`)
    // Record the skipped write so the post-tool gate degrades the tool
    // result to an honest aborted failure — the world mutation happened but no
    // HTML landed, and the handler would otherwise return a cheerful ok().
    ;(world._recentHtmlUnwritten ??= {})[sceneId] = {
      reason: 'aborted',
      error: 'Run aborted by user — HTML write skipped',
    }
    return { htmlWritten: false, error: 'Run aborted by user — HTML write skipped' }
  }
  // Declared outside the try so the catch can clean up an orphaned temp file
  // if writeFile succeeded but rename threw (otherwise the timestamped .tmp
  // lingers in the scenes dir forever).
  let tmpPath: string | null = null
  try {
    const start = Date.now()
    const html = generateSceneHTML(
      scene,
      world.globalStyle,
      undefined,
      undefined,
      resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution),
    )
    updateScene(world, sceneId, { sceneHTML: html })
    // Write to disk immediately so preview iframes can load the latest content
    const scenesDir = resolveScenesDir()
    await fs.mkdir(scenesDir, { recursive: true })
    // Atomic write: write to temp file then rename to prevent partial HTML
    // from concurrent tool calls writing to the same scene
    const finalPath = path.join(scenesDir, `${sceneId}.html`)
    tmpPath = path.join(scenesDir, `${sceneId}.tmp.${Date.now()}.html`)
    await fs.writeFile(tmpPath, html, 'utf-8')
    await fs.rename(tmpPath, finalPath)
    tmpPath = null // renamed successfully — nothing to clean up
    // New HTML invalidates the scene's playback-error history. The
    // Electron scene.writeHtml IPC clears too — this covers the AGENT's
    // direct write path, otherwise an old playback error keeps failing
    // verify_scene after the agent already fixed the scene.
    clearSceneErrors(sceneId)
    const durationMs = Date.now() - start
    logger?.log('html', `Wrote ${sceneId}.html`, { sceneId, htmlLength: html.length, durationMs })

    // Verify-scene gate. Failures surface back through the tool result so
    // the LLM sees the kind+line on its next turn and can self-correct via
    // regenerate_layer / patch_layer_code. `unknown` (no Electron context,
    // e.g. CLI tests) is silently treated as passthrough.
    trace('html', { sceneId, codeLen: html.length, wrote: true })
    const { verifyAndStampScene } = await import('../services/scene-verifier')
    const verifyOutcome = await verifyAndStampScene(sceneId)
    trace('html.verify', { sceneId, status: verifyOutcome.status, err: verifyOutcome.error?.message })
    updateScene(world, sceneId, {
      verifyStatus: verifyOutcome.status,
      verifyError: verifyOutcome.error,
    })
    if (verifyOutcome.status === 'errored') {
      logger?.warn('html', `Scene ${sceneId} verify errored: ${verifyOutcome.error?.message}`, {
        sceneId,
        verifyError: verifyOutcome.error,
      })
    }
    // Stash the layout-overflow advisory on a transient world map keyed by
    // sceneId so the post-tool gate (which only sees `world`, not this return)
    // can attach a non-blocking `_layout` signal alongside `_verify` /
    // `_determinism`. `undefined` (no measurement) leaves any prior entry as-is
    // is undesirable, so we always reset the slot to the latest reading.
    if (verifyOutcome.overflows && verifyOutcome.overflows.length > 0) {
      ;(world._recentSceneOverflows ??= {})[sceneId] = verifyOutcome.overflows
      // Persistent mirror: `_recentSceneOverflows` is consumed-and-deleted the
      // moment the fire-once `_layout` advisory surfaces, so it's unreliable at
      // post-build acceptance time. Keep a durable copy of the LATEST overflow
      // reading per scene that the orchestrator/director corrective pass can read
      // so flagged overflow gets a guaranteed corrective shot instead of relying
      // on the same-turn advisory. Cleared only on a CLEAN measurement (below).
      ;(world._sceneOverflowState ??= {})[sceneId] = verifyOutcome.overflows
    } else if (world._recentSceneOverflows) {
      delete world._recentSceneOverflows[sceneId]
    }
    // Clear the persistent mirror only on an explicit clean measurement (empty
    // array), NOT on "no measurement" (undefined) — otherwise a later non-
    // measuring tool turn would wipe a real, still-unfixed overflow signal.
    if (verifyOutcome.overflows && verifyOutcome.overflows.length === 0 && world._sceneOverflowState) {
      delete world._sceneOverflowState[sceneId]
    }
    // Stash the pixel-truth reading on a transient world map keyed by sceneId so
    // the post-tool gate (which only sees `world`, not this return) can apply the
    // BLOCKING render check. Always reset the slot to the latest reading; clear
    // it when no measurement was taken so a stale blank verdict can't re-fire.
    if (verifyOutcome.frame) {
      ;(world._recentSceneFrame ??= {})[sceneId] = verifyOutcome.frame
    } else if (world._recentSceneFrame) {
      delete world._recentSceneFrame[sceneId]
    }
    // The write landed — clear any stale unwritten flag from a prior tool so
    // the post-tool gate can't surface a false htmlWritten:false for this scene.
    if (world._recentHtmlUnwritten) delete world._recentHtmlUnwritten[sceneId]
    return {
      htmlWritten: true,
      verifyStatus: verifyOutcome.status,
      verifyError: verifyOutcome.error,
      overflows: verifyOutcome.overflows,
      frame: verifyOutcome.frame,
    }
  } catch (e) {
    const message = (e as Error).message
    logger?.error('html', `HTML regeneration failed for ${sceneId}: ${message}`)
    log.error('HTML regeneration failed', { error: e })
    // Clean up the orphaned temp file if writeFile succeeded but rename threw.
    // Best-effort: a failed unlink (e.g. file already gone) must not mask the
    // original HTML-regen error we're about to report.
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {})
    // Don't swallow the failure. Stamp the scene with an errored verify
    // state so the post-tool gate surfaces a visible `_verify` signal to the
    // agent + user, and return the error so callers that inspect the result
    // (and the post-tool block) can act on it. The last-good sceneHTML on
    // disk is left untouched (atomic temp+rename above never replaced it),
    // so export/preview keep the prior working render.
    const verifyError: import('@/lib/db/schema').SceneVerifyError = {
      kind: 'runtime',
      message: `HTML regeneration failed: ${message}`,
    }
    updateScene(world, sceneId, { verifyStatus: 'errored', verifyError })
    return { htmlWritten: false, verifyStatus: 'errored', verifyError, error: message }
  }
}

// ── Layer Generation ──────────────────────────────────────────────────────────

interface GenerationResult {
  success: boolean
  code?: string
  error?: string
  /** Mirrors ToolResult.aborted: the failure is a user Stop, not a
   *  generation error — handlers map it to abortResult(), never retry it. */
  aborted?: boolean
}

export async function generateLayerContent(
  layerType: SceneType,
  prompt: string,
  scene: Scene,
  globalStyle: GlobalStyle,
  modelId?: string,
  modelTier?: 'auto' | 'premium' | 'budget',
  logger?: AgentLogger,
  modelConfigs?: import('./model-config').ModelConfig[],
  signal?: AbortSignal,
): Promise<GenerationResult> {
  try {
    // Don't START a paid generation for a run the user already stopped.
    if (signal?.aborted) {
      return { success: false, error: 'Run aborted by user — generation not started', aborted: true }
    }
    const resolved = resolveStyle(globalStyle.presetId, globalStyle)
    logger?.log('generation', `Generating ${layerType} code`, { layerType, promptLength: prompt.length, modelId })
    const genStart = Date.now()
    const hasPreset = globalStyle.presetId != null
    const result = await generateCode(layerType, prompt, {
      palette: hasPreset ? resolved.palette : undefined,
      bgColor: scene.bgColor,
      duration: scene.duration,
      font: hasPreset ? resolved.font : undefined,
      strokeWidth: globalStyle.strokeWidth ?? 2,
      d3Data: scene.d3Data ?? undefined,
      modelId,
      modelTier,
      modelConfigs,
    })
    const genMs = Date.now() - genStart

    // The abort landed mid-generation — that spend is already gone, but
    // the WRITE must not happen. Returning failure here is what keeps stale
    // scene code from landing after the user pressed Stop.
    if (signal?.aborted) {
      logger?.log('generation', `Discarding ${layerType} generation — run aborted mid-call`)
      return { success: false, error: 'Run aborted by user — generated content discarded', aborted: true }
    }

    // Basic validation: ensure we got non-trivial code
    const code = result.code?.trim() ?? ''
    logger?.log('generation', `Generation complete`, {
      layerType,
      durationMs: genMs,
      codeLength: code.length,
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
    })
    if (!code) {
      logger?.warn('generation', 'Generation returned empty code')
      return { success: false, error: 'Generation returned empty code — please retry' }
    }
    if (result.truncated) {
      logger?.warn(
        'generation',
        `Generation was truncated (${result.usage?.output_tokens} tokens) — code is incomplete`,
      )
      return {
        success: false,
        error: 'Scene code was too long and got cut off — try a simpler prompt or break into multiple scenes',
      }
    }
    if (layerType === 'svg' && !code.includes('<svg')) {
      logger?.warn('generation', `SVG generation missing <svg> tag (length=${code.length})`)
    }

    return { success: true, code }
  } catch (e) {
    logger?.error('generation', `Generation failed: ${String(e)}`)
    return { success: false, error: `Generation failed: ${String(e)}` }
  }
}
