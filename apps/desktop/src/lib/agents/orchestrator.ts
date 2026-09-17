/**
 * Orchestrator: Delegates scene-building to sub-agents.
 *
 * When a Director has a scenePlan with 3+ scenes, instead of building
 * everything in a single 15-iteration loop, the orchestrator spawns
 * focused SceneMaker sub-agents — one per scene — each with its own
 * tool budget and narrowed context.
 *
 * Sub-agents are recursive runAgent() calls (not separate processes).
 * They share the parent's emit function for SSE streaming and operate
 * on isolated world state clones (same pattern as parallel tool execution).
 */

import { v4 as uuidv4 } from 'uuid'
import type { Scene } from '../types'
import type {
  AcceptanceCheck,
  AgentType,
  SSEEvent,
  ScenePlan,
  SceneSelectionTrace,
  SceneSpec,
  TaskPacket,
  UsageStats,
  ToolCallRecord,
} from './types'
import { DEFAULT_RUN_CONFIG, type RunnerOptions } from './runner'
import { runScopedSubAgent } from './subagent-dispatch'
import { createSceneShell } from './scene-shell'
import { deriveStoryboard, renderStoryboardBlock } from './storyboard'
import { loadSkillForSceneType } from '../skills/registry'
import { classifyBridgeSkills, bridgeSkillsForVisualForm } from './scene-type-rules'
import type { SkillContent } from '../skills/types'
import { type RunCostLedger, commitCost, refundCost, isOverCap } from './run-cost-ledger'
import type { WorldStateMutable } from './world-state'
import type { CutReviewBrief } from './services/cut-review'
import type { CompositeVerifyScene } from './services/composite-verify'
import { buildContinuityContext } from './cross-scene-continuity'
import { sceneHasImagery } from './imagery-floor'
import { AgentLogger } from './logger'

/** Max iterations per sub-agent (much smaller than the parent's 40) */
// A scene builder does research → write_scene_code → verify → fix; 5 was too
// tight (scenes landed half-built). 15 gives room, bounded by SUB_AGENT_TIMEOUT_MS
// (wall-clock) and the per-sub-agent cost budget. (Workstream C: 5→15.)
const SUB_AGENT_MAX_ITERATIONS = 15
// A sub-agent builds ONE scene — it must NOT inherit the parent's raised
// maxToolCalls (150). Cap it explicitly so a batch of N sub-agents can't authorize
// N×150 tool calls. (The parent runConfig only overrides maxRunCostUsd otherwise.)
const SUB_AGENT_MAX_TOOL_CALLS = 50

/**
 * Wall-clock timeout per sub-agent attempt. This is a BACKSTOP against a hung
 * run, not the primary limiter — that's SUB_AGENT_MAX_ITERATIONS and the cost
 * budget, both of which return normally when hit.
 *
 * The old flat 90s was a bug: it was *below* a single generation tool's own
 * timeout (DEFAULT_RUN_CONFIG.generationToolTimeoutMs = 120s), so a sub-agent
 * that ran one image/TTS/video generation got aborted mid-call before it could
 * finish even one iteration — scenes landed half-built on a timeout, not on the
 * iteration cap. Derive from the generation timeout so the invariant
 * "a sub-agent outlives at least a couple of its slowest tool calls" can't
 * regress: enough headroom for ~2 back-to-back generations plus model turns,
 * floored at 5 minutes.
 */
export const SUB_AGENT_TIMEOUT_MS = Math.max(5 * 60_000, DEFAULT_RUN_CONFIG.generationToolTimeoutMs * 2)

/** Admission-control estimate for ONE corrective fix, reserved on the shared cost
 *  ledger at dispatch (composite-verify's reserve-before-await pattern). It is NOT
 *  the accounting: the corrective sub-agent's runner commits its ACTUAL cost to the
 *  same ledger as it runs, and this reservation is refunded once the fix returns.
 *  Its only job is to make admission atomic — so N concurrent correctives can't all
 *  read the same pre-spend, all pass the cap gate, and overshoot. A realistic
 *  per-fix figure so near-cap dispatch admits at most what the cap allows. */
export const CORRECTIVE_FIX_RESERVE_USD = 0.15

/** Bound on how many corrective fixes run at once. The build itself is sequential
 *  (each beat sees its predecessors' real code — continuity), but correctives don't
 *  hand off to each other, so they can run concurrently under the ledger reserve. */
export const CORRECTIVE_MAX_PARALLEL = 3

/**
 * Build a focused activeTools list for a sub-agent based on scene type.
 * This ensures the sub-agent only sees tools relevant to the scene it's building,
 * reducing cognitive load and irrelevant tool options.
 *
 * Always includes: audio (narration/SFX/music) + assets (images/media overlays).
 * Conditionally includes: scene-type-specific tools from TOOL_CATEGORY_MAP.
 */
export function buildActiveToolsForSceneType(
  sceneType: string,
  parentActiveTools?: string[],
  featureFlags?: { narration?: boolean; music?: boolean; sfx?: boolean; interactions?: boolean },
): string[] {
  // Scene type → tool category mapping
  const SCENE_TYPE_TO_CATEGORIES: Record<string, string[]> = {
    svg: ['svg'],
    canvas2d: ['canvas2d'],
    d3: ['d3'],
    three: ['three'],
    motion: ['motion'],
    lottie: ['lottie'],
    zdog: ['zdog'],
    avatar_scene: ['motion', 'avatars'],
    '3d_world': ['three'],
    // react is the DEFAULT renderer and composes every bridge (ThreeJS/D3/
    // Canvas2D/SVG/Lottie). Without this entry it silently fell back to ['motion']
    // (below), so react scenes were tool-scoped as generic motion slides.
    react: ['motion', 'three', 'd3', 'canvas2d', 'svg', 'lottie'],
  }

  const categories = new Set<string>(SCENE_TYPE_TO_CATEGORIES[sceneType] ?? ['motion'])

  // Always include audio for narration/music/sfx (unless parent explicitly disabled)
  if (!parentActiveTools || parentActiveTools.includes('audio')) {
    categories.add('audio')
  }

  // Always include assets for image placement and media overlays
  if (!parentActiveTools || parentActiveTools.includes('assets')) {
    categories.add('assets')
  }

  // Include video so a scene can place/overlay a video clip (set_media_layer,
  // stock/generated clips). No scene type mapped to 'video' before, so the
  // category never reached a scene-builder — video tooling was stranded. Paid
  // generate_video is still key-gated + cost-reserved downstream.
  if (!parentActiveTools || parentActiveTools.includes('video')) {
    categories.add('video')
  }

  // Include avatars if parent allows and scene type benefits. react is the DEFAULT
  // renderer (a presenter scene is normally authored as react), so it
  // must be avatar-eligible too — otherwise avatar tools were stranded on every
  // default scene. Still key-gated (hasAvatar) + cost-reserved downstream.
  if (
    (!parentActiveTools || parentActiveTools.includes('avatars')) &&
    (sceneType === 'avatar_scene' || sceneType === 'motion' || sceneType === 'react')
  ) {
    categories.add('avatars')
  }

  // Include interactions if feature flags request it
  if (featureFlags?.interactions && (!parentActiveTools || parentActiveTools.includes('interactions'))) {
    categories.add('interactions')
  }

  return Array.from(categories)
}

export interface OrchestratorOptions {
  scenePlan: ScenePlan
  /** The parent's mutable world state — sub-agent results are merged back into this */
  parentWorld: WorldStateMutable
  /** The parent's full RunnerOptions (used to inherit settings) */
  parentOpts: RunnerOptions
  /** SSE emitter shared with parent */
  emit: (event: SSEEvent) => void
  /** Parent's logger for correlation */
  logger: AgentLogger
  /** Parent's accumulated tool calls at handoff — used to land media the parent
   *  found via INLINE research (never dispatched). See landResearchMedia. */
  researchToolCalls?: ToolCallRecord[]
  /** Remaining tool call budget from parent (stops spawning sub-agents when exhausted) */
  toolBudgetRemaining?: number
  /** Parent's accumulated LLM cost at handoff time (fallback when no ledger). */
  parentCostUsd?: number
  /** Max cost for the entire run (parent + sub-agents). Fallback when no ledger. */
  maxRunCostUsd?: number
  /**
   * Shared run-scoped cost ledger (Workstream C hardening). When present it is
   * the authoritative real-time total (parent + every sub-agent, including
   * aborted attempts) and is threaded into each sub-agent so they enforce the
   * run cap live. When absent, the orchestrator falls back to the
   * parentCostUsd + cumulative between-batch math.
   */
  costLedger?: RunCostLedger
  /**
   * Optional whole-video composite verify (director loop only). When
   * provided, the director runs a boundary+motion cut review after the initial
   * build and folds real cross-scene defects into the corrective pass. The runner
   * wires this to captureOneFrame + the cut-review VLM. Absent (headless/tests, or
   * the fan-out path) → the director honestly skips it, never a silent clean pass.
   */
  reviewCut?: (scenes: CompositeVerifyScene[]) => Promise<CutReviewBrief>
}

export interface SubAgentResult {
  sceneIndex: number
  sceneName: string
  success: boolean
  sceneId?: string
  usage: UsageStats
  toolCalls: ToolCallRecord[]
  error?: string
  /**
   * The sub-agent's own verify_scene verdict (Workstream C.2a — verification as
   * contract). `true` = the last verify_scene passed, `false` = it reported
   * issues, `undefined` = the sub-agent never ran verify_scene. `success` only
   * means "produced mergeable content" — a scene can be built-but-broken, and
   * this is how the orchestrator/Director sees that.
   */
  verifyPassed?: boolean
  verifyIssues?: string[]
  /** Labels of the packet's machine-checked structural acceptance criteria that
   *  the built scene did NOT satisfy (e.g. "narration was added"). Empty = all met. */
  unmetCriteria?: string[]
}

/**
 * Run orchestrated scene-building: spawn a sub-agent for each scenePlan scene.
 *
 * Preconditions (enforced by caller):
 * - Director has already planned the scenePlan
 * - Director has already set global style and transitions
 *
 * If scene shells were created by the Director, sub-agents will populate them.
 * If no shells exist, sub-agents will create the scenes themselves.
 *
 * The orchestrator:
 * 1. Matches scenePlan scenes to existing scene shells (by name or index)
 * 2. For each scene, spawns a SceneMaker sub-agent with focused context
 * 3. Merges results back into the parent world state
 * 4. Returns aggregated results
 */
/**
 * Deterministic scene identity — pre-create shells so every planned scene resolves
 * to a concrete world id BEFORE dispatch. Shared by the fan-out orchestrator and the
 * director loop so neither can regress the 0/N persist bug.
 *
 * matchScenePlanToScenes only maps planned scenes onto scenes that ALREADY exist in
 * the world; a planned scene with no match would otherwise be created by the builder
 * under a name/id the caller then has to *guess* at merge time. That guess is fragile:
 * a renamed scene, a plan whose names drifted across re-plans, or a short-id write into
 * a different id-space all leave the built scene unmatched → "no content produced" →
 * nothing merges → 0/N lands and the parent loops re-planning. Pinning an id here makes
 * the merge a pure id lookup. Anchor on the plan scene's stable id (plan_scenes assigns
 * and carries it forward across re-plans) so a re-dispatch/re-plan re-finds THIS shell
 * by id instead of minting a duplicate; fall back to a fresh uuid when a plan carries no
 * id (e.g. an initialScenePlan built outside plan_scenes). The empty shell renders as
 * "Building…" until content lands.
 */
export function ensureSceneShells(
  scenePlan: ScenePlan,
  parentWorld: WorldStateMutable,
  logger: AgentLogger,
): Map<number, Scene> {
  const sceneMap = matchScenePlanToScenes(scenePlan.scenes, parentWorld.scenes)
  for (let i = 0; i < scenePlan.scenes.length; i++) {
    if (sceneMap.has(i)) continue
    const planned = scenePlan.scenes[i]
    const shell = createSceneShell({
      id: planned.id,
      name: planned.name,
      prompt: planned.purpose,
      duration: planned.duration,
      sceneType: planned.sceneType as Scene['sceneType'],
      // Seed the plan's transition deterministically (the agent forgetting to set
      // it, or set_all_transitions flattening it, is the "all dissolve" defect).
      transition: planned.transition ? (planned.transition as Scene['transition']) : undefined,
    })
    parentWorld.scenes.push(shell)
    sceneMap.set(i, shell)
    logger.log('orchestrator', `Pre-created scene shell for "${planned.name}"`, { sceneId: shell.id })
  }
  return sceneMap
}

/** Check for visual/structural inconsistencies across scenes built by different sub-agents */
export function checkCrossSceneConsistency(scenes: Scene[], scenePlan: ScenePlan, results: SubAgentResult[]): string[] {
  const issues: string[] = []
  const builtScenes = results.filter((r) => r.success && r.sceneId)

  // Check for scenes that failed to build
  const failedScenes = results.filter((r) => !r.success)
  if (failedScenes.length > 0) {
    issues.push(`${failedScenes.length} scene(s) failed to build: ${failedScenes.map((r) => r.sceneName).join(', ')}`)
  }

  // Verification as contract (C.2a): a scene can build (have content) yet fail
  // its own verify_scene, or never be verified at all. Surface both so they
  // don't pass silently — "built" is not "works".
  for (const r of builtScenes) {
    if (r.verifyPassed === false) {
      const detail = (r.verifyIssues ?? []).join('; ') || 'see the sub-agent verify_scene output'
      issues.push(`Scene "${r.sceneName}" built but FAILED verification: ${detail}`)
    } else if (r.verifyPassed === undefined) {
      issues.push(`Scene "${r.sceneName}" was not verified — the sub-agent never ran verify_scene.`)
    }
    // Machine-checked acceptance: objective structural gaps, independent of the
    // sub-agent's own verdict.
    if (r.unmetCriteria && r.unmetCriteria.length > 0) {
      issues.push(`Scene "${r.sceneName}" did not meet acceptance: ${r.unmetCriteria.join('; ')}`)
    }
  }

  // Check for missing audio on scenes that should have narration
  if (scenePlan.featureFlags?.narration !== false) {
    for (const result of builtScenes) {
      const scene = scenes.find((s) => s.id === result.sceneId)
      if (scene && !scene.audioLayer?.enabled) {
        issues.push(`Scene "${scene.name}" has no audio — narration may be missing`)
      }
    }
  }

  // (Consecutive-renderer monotony moved to scanCrossSceneContinuity, which
  // runs over the full scene list and also covers monotone-plan / transition /
  // narration-run patterns. Surfaced separately as a SOFT continuity signal.)

  // Check for scenes with very different durations from their scenePlan spec
  for (const result of builtScenes) {
    const scene = scenes.find((s) => s.id === result.sceneId)
    const planned = scenePlan.scenes[result.sceneIndex]
    if (scene && planned && Math.abs(scene.duration - planned.duration) > 3) {
      issues.push(
        `Scene "${scene.name}" duration ${scene.duration}s differs from planned ${planned.duration}s by ${Math.abs(scene.duration - planned.duration)}s`,
      )
    }
  }

  return issues
}

// ── Sub-agent execution ──────────────────────────────────────────────────────

interface BuildSceneOptions {
  planned: SceneSpec
  /** The whole-video approach (scenePlan.approach) — the reasoned through-line, so a
   *  per-scene fan-out builder makes THIS scene serve the video and flow with the rest. */
  videoApproach?: string
  sceneIndex: number
  existingScene: Scene | undefined
  parentWorld: WorldStateMutable
  parentOpts: RunnerOptions
  emit: (event: SSEEvent) => void
  logger: AgentLogger
  subAgentId: string
  featureFlags?: { narration?: boolean; music?: boolean; sfx?: boolean; interactions?: boolean }
  /**
   * Per-sub-agent cost ceiling (USD). The orchestrator divides the run's
   * remaining budget across the current batch so N parallel sub-agents can't
   * collectively blow past the user's run cap (each previously defaulted to the
   * full $25, so a 3-scene batch could spend 3× the cap before the between-batch
   * check fired). undefined = use the runner default.
   */
  budgetUsd?: number
  /** Shared run-scoped cost ledger, threaded into the sub-agent's runAgent so it
   *  enforces the run-wide ceiling live (not just its own slice). */
  costLedger?: RunCostLedger
  /** Auto-redispatch: when set, this is a corrective build — the sub-agent gets
   *  a fix-focused packet listing these prior failures to resolve in place. */
  priorIssues?: string[]
  /** Auto-load: the project-wide distilled style (top-1 match) injected into
   *  every scene prompt via the selectSkillsForScene seam. null/undefined = none. */
  projectStyle?: SkillContent | null
  /** The planned scenes before/after this one, so the builder makes the
   *  scene flow (continue the prev beat, set up the next) instead of building an
   *  isolated slide. undefined = no neighbor context injected.
   *  prevBuiltCode carries the predecessor's REAL built code (sequential dispatch
   *  guarantees it exists), so continuity is observed, not imagined from prose. */
  neighbors?: { prev: SceneSpec | null; next: SceneSpec | null; prevBuiltCode?: string | null }
}

export interface BuildSceneResult {
  success: boolean
  sceneId?: string
  updatedScene?: Scene
  /** The sub-agent's final timeline, present ONLY when it actually ran a timeline
   *  tool (runAgent's `timelineCarryOut` gate). Callers merge it into the parent
   *  world; undefined means "this builder never touched the sequence", so merging
   *  can never clobber the parent's timeline with an untouched clone. */
  updatedTimeline?: import('../types').Timeline | null
  usage: UsageStats
  toolCalls: ToolCallRecord[]
  error?: string
  verifyPassed?: boolean
  verifyIssues?: string[]
  unmetCriteria?: string[]
}

/**
 * Run one sub-agent build with a wall-clock timeout (SUB_AGENT_TIMEOUT_MS)
 * composed with the parent's abort signal (parent abort cascades). Shared by the
 * orchestrator's parallel batch, its corrective pass (via the buildWithTimeout
 * closure), and the post-build cut-review coordinator (via runScopedSceneFix).
 * Throws on timeout/abort/crash.
 */
async function buildSceneWithTimeout(
  buildOpts: BuildSceneOptions,
  parentAbortSignal?: AbortSignal,
): Promise<BuildSceneResult> {
  const subAbort = new AbortController()
  const timer = setTimeout(() => subAbort.abort(), SUB_AGENT_TIMEOUT_MS)
  const onParentAbort = () => subAbort.abort()
  parentAbortSignal?.addEventListener('abort', onParentAbort, { once: true })
  try {
    return await buildSceneWithSubAgent({
      ...buildOpts,
      parentOpts: { ...buildOpts.parentOpts, abortSignal: subAbort.signal },
    })
  } finally {
    clearTimeout(timer)
    parentAbortSignal?.removeEventListener('abort', onParentAbort)
  }
}

export interface ScopedSceneFixOptions {
  /** The scene to fix (must already exist in parentWorld). */
  sceneId: string
  /** Scene index for the SSE sub_agent_* events. */
  sceneIndex: number
  /** Scene name for events/logs. */
  sceneName: string
  /** The scenePlan scene that drives the task packet (scope/acceptance). */
  planned: SceneSpec
  /** The current built scene being corrected, edited in place. */
  existingScene: Scene
  /** Specific failures the corrective sub-agent must resolve. */
  priorIssues: string[]
  parentWorld: WorldStateMutable
  parentOpts: RunnerOptions
  emit: (event: SSEEvent) => void
  logger: AgentLogger
  featureFlags?: { narration?: boolean; music?: boolean; sfx?: boolean; interactions?: boolean }
  /** Shared run cost ledger — authoritative when present. */
  costLedger?: RunCostLedger
  /** Fallback run cap when no ledger is threaded. */
  maxRunCostUsd?: number
  /** Fallback spend-so-far inputs when no ledger is threaded. */
  parentCostUsd?: number
  priorCumulativeCostUsd?: number
  /** Total scene count for the SSE sub_agent_* events. */
  totalScenes: number
  /** Auto-load: project-wide distilled style injected into the corrective
   *  build's prompt too, so a fix honours the same style as the initial build. */
  projectStyle?: SkillContent | null
}

export interface ScopedSceneFixOutcome {
  fix?: BuildSceneResult
  /** Fix produced mergeable content and was merged into parentWorld in place. */
  applied: boolean
  /** Skipped without building because the run cost cap was already exceeded. */
  skippedOverCap: boolean
  /** Cost of an applied fix (0 otherwise) — for the no-ledger fallback math. */
  costUsd: number
}

/**
 * Run ONE scoped corrective fix on an already-built scene: a sub-agent pinned to
 * that scene, handed the specific prior issues, editing in place. Extracted from
 * runOrchestrated's corrective pass so the post-build cut-review coordinator can
 * reuse the exact same primitive — cost-gated, timeout-bounded, parent-abort-aware.
 *
 * Merges a successful fix into parentWorld.scenes and emits sub_agent_start/
 * complete + preview_update. The caller owns any result bookkeeping (e.g.
 * refreshing a SubAgentResult entry) from the returned `fix`.
 */
export async function runScopedSceneFix(opts: ScopedSceneFixOptions): Promise<ScopedSceneFixOutcome> {
  const {
    sceneId,
    sceneIndex,
    sceneName,
    planned,
    existingScene,
    priorIssues,
    parentWorld,
    parentOpts,
    emit,
    logger,
    totalScenes,
  } = opts

  // Cost guardrail. With a shared ledger, ATOMICALLY reserve this fix's estimate
  // BEFORE any await so N concurrent correctives can't all read the same pre-spend,
  // all pass the gate, and overshoot the cap (composite-verify's reserve pattern).
  // The reservation is refunded in `finally` — the sub-agent runner commits the
  // ACTUAL cost to the same ledger as it runs, so only real spend stands. Without a
  // ledger, fall back to the read-only check on the threaded spend inputs.
  let reservedUsd = 0
  if (opts.costLedger) {
    if (isOverCap(opts.costLedger) || opts.costLedger.spentUsd + CORRECTIVE_FIX_RESERVE_USD > opts.costLedger.capUsd) {
      logger.warn('orchestrator', `Cost cap reached — skipping corrective pass for "${sceneName}"`)
      return { applied: false, skippedOverCap: true, costUsd: 0 }
    }
    commitCost(opts.costLedger, CORRECTIVE_FIX_RESERVE_USD)
    reservedUsd = CORRECTIVE_FIX_RESERVE_USD
  } else {
    const runCap = opts.maxRunCostUsd
    const spentSoFar = (opts.parentCostUsd ?? 0) + (opts.priorCumulativeCostUsd ?? 0)
    if (runCap != null && Number.isFinite(runCap) && spentSoFar > runCap) {
      logger.warn('orchestrator', `Cost cap reached — skipping corrective pass for "${sceneName}"`)
      return { applied: false, skippedOverCap: true, costUsd: 0 }
    }
  }

  const runCap = opts.costLedger ? opts.costLedger.capUsd : opts.maxRunCostUsd
  const spentSoFar = opts.costLedger
    ? opts.costLedger.spentUsd
    : (opts.parentCostUsd ?? 0) + (opts.priorCumulativeCostUsd ?? 0)

  const fixId = uuidv4().slice(0, 8)

  emit({
    type: 'sub_agent_start',
    subAgentId: fixId,
    subAgentSceneIndex: sceneIndex,
    subAgentTotal: totalScenes,
    subAgentSceneName: sceneName,
  })
  logger.log('orchestrator', `Corrective sub-agent ${fixId}: fixing "${sceneName}"`, { sceneId, priorIssues })

  let fix: BuildSceneResult | undefined
  try {
    fix = await buildSceneWithTimeout(
      {
        planned,
        sceneIndex,
        existingScene,
        parentWorld,
        parentOpts,
        featureFlags: opts.featureFlags,
        emit,
        logger,
        subAgentId: fixId,
        budgetUsd: runCap != null && Number.isFinite(runCap) ? Math.max(0, runCap - spentSoFar) : undefined,
        costLedger: opts.costLedger,
        priorIssues,
        projectStyle: opts.projectStyle,
      },
      parentOpts.abortSignal,
    )
  } catch (err) {
    logger.warn('orchestrator', `Corrective sub-agent ${fixId} failed: ${(err as Error).message}`, { sceneId })
  } finally {
    // Release the admission reservation now that the fix has returned — the runner
    // already committed this fix's ACTUAL cost to the same shared ledger, so keeping
    // the estimate would double-count and wrongly starve later work. Paired 1:1 with
    // the commitCost above; refundCost clamps at zero.
    if (reservedUsd > 0 && opts.costLedger) refundCost(opts.costLedger, reservedUsd)
  }

  // Don't land a corrective fix if the parent was aborted mid-build: the user
  // cancelled, so a fix that completed in the abort window must not mutate the
  // world. (buildSceneWithTimeout cascades the abort, so this is usually already
  // !success — this closes the completed-just-as-abort-fired race.)
  const applied = !parentOpts.abortSignal?.aborted && !!(fix?.success && fix.updatedScene)
  if (applied && fix?.updatedScene) {
    const idx = parentWorld.scenes.findIndex((s) => s.id === fix!.updatedScene!.id)
    if (idx !== -1) parentWorld.scenes[idx] = fix.updatedScene
  }
  // Same timeline merge as the build loop — a corrective that (re)places timeline audio
  // must not silently lose it either. Correctives run up to
  // CORRECTIVE_MAX_PARALLEL at once, so two that BOTH edit the timeline are
  // last-writer-wins; the carry-out gate makes that rare (a fix that never calls a
  // timeline tool returns undefined and can't clobber). Upgrade to a per-clip merge only
  // if concurrent sequence edits ever become a real pattern.
  if (!parentOpts.abortSignal?.aborted && fix?.updatedTimeline) parentWorld.timeline = fix.updatedTimeline

  emit({
    type: 'sub_agent_complete',
    subAgentId: fixId,
    subAgentSceneIndex: sceneIndex,
    subAgentTotal: totalScenes,
    subAgentSceneName: sceneName,
    subAgentSuccess: fix?.success ?? false,
  })
  if (fix?.success && fix.sceneId) {
    emit({
      type: 'preview_update',
      sceneId: fix.sceneId,
      changes: [{ type: 'scene_updated', sceneId: fix.sceneId, description: `Corrective fix for "${sceneName}"` }],
    })
  }

  return { fix, applied, skippedOverCap: false, costUsd: applied && fix ? fix.usage.costUsd : 0 }
}

/**
 * Deterministic per-scene skill selection (base renderer + bridges).
 *
 * SINGLE SOURCE OF TRUTH shared by the injection point (buildSceneWithSubAgent)
 * and the selection trace — so what the trace REPORTS is exactly what gets
 * injected, never a parallel re-derivation that can drift.
 *
 * - `base`    = the dedicated renderer skill for `planned.sceneType` (null
 *               for 'react', the composed default, which carries its own guidance).
 * - `bridges` = skills implied by bridge intent in the scene's text, so a
 *               react scene leaning on `<ThreeJSLayer>`/`<D3Layer>` still gets that
 *               guide even though sceneType alone would miss it.
 * - `guides`  = dedupe([base, ...bridges]) — what is actually injected, in order.
 *
 * Pure: no model, no IO beyond the in-memory skill registry.
 */
export function selectSkillsForScene(
  planned: SceneSpec,
  projectStyle?: SkillContent | null,
): {
  base: SkillContent | null
  bridges: SkillContent[]
  /** The project-wide distilled style injected into every scene, if any. */
  projectStyle: SkillContent | null
  guides: SkillContent[]
} {
  const base = loadSkillForSceneType(planned.sceneType)
  // Route the renderer bridge off the committed visualForm (art_direct) when present —
  // a 'chart' beat deterministically gets the D3 guide, unlike the old keyword match on
  // name+purpose that missed "The Scoreline". Falls back to keyword classify when no
  // visualForm is set (blind fan-out / branch-variant path has no art_direct pass).
  const bridges =
    bridgeSkillsForVisualForm(planned.visualForm) ??
    classifyBridgeSkills(`${planned.purpose ?? ''} ${planned.name ?? ''}`)
  const style = projectStyle ?? null
  const guides: SkillContent[] = []
  const seen = new Set<string>()
  // Style first so its project-wide identity frames the per-scene renderer/bridge
  // guides that follow.
  for (const s of [style, base, ...bridges]) {
    if (!s || seen.has(s.metadata.id)) continue
    seen.add(s.metadata.id)
    guides.push(s)
  }
  return { base, bridges, projectStyle: style, guides }
}

/**
 * Assemble the full sub-agent prompt for a planned scene: the rendered TaskPacket
 * plus every injected skill guide (base renderer + bridge guides, deduped).
 *
 * Pure string assembly — no model call — so the injection WIRE is unit-testable
 * for $0: a react SceneSpec whose purpose mentions a 3D globe produces a prompt
 * that contains the threejs guide, proving the bridge guide reaches the sub-agent.
 */
export function assembleScenePrompt(
  packet: TaskPacket,
  planned: SceneSpec,
  projectStyle?: SkillContent | null,
  neighbors?: { prev: SceneSpec | null; next: SceneSpec | null; prevBuiltCode?: string | null },
): string {
  const { guides, projectStyle: style } = selectSkillsForScene(planned, projectStyle)
  // Neighbor context so the builder knows what comes before/after and
  // makes this scene FLOW instead of building a context-isolated slide.
  // `planned` is self — its handoffToNext/carriedElements drive how this scene
  // ENDS into the next (prev's drive how it OPENS). prevBuiltCode
  // is the predecessor's REAL code so continuity is observed, not imagined.
  const continuity = neighbors
    ? buildContinuityContext(neighbors.prev, neighbors.next, planned, neighbors.prevBuiltCode)
    : ''
  return (
    renderTaskPacket(packet) +
    guides
      .map((g) => {
        // The distilled project style gets a distinct, project-wide framing so the
        // sub-agent treats it as the identity to honour, not a per-scene renderer guide.
        if (style && g.metadata.id === style.metadata.id) {
          return `\n\n## Project style — ${g.metadata.name}\nThis distilled style was learned from a related project and applies to the WHOLE build. Honour its palette, fonts, and feel across this scene.\n\n${g.guide}`
        }
        return `\n\n## Loaded skill — ${g.metadata.name}\nThis ${g.metadata.sceneType} skill is already loaded for you — follow it.\n\n${g.guide}`
      })
      .join('') +
    continuity
  )
}

/**
 * Build the deterministic selection trace entry for one planned scene: which skill
 * guides will be injected and why. Soft signal — `override` is a human-readable
 * note on a sceneType↔bridge mismatch, never an applied change to `sceneType`.
 */
export function buildSceneSelectionTrace(planned: SceneSpec, projectStyle?: SkillContent | null): SceneSelectionTrace {
  const { bridges, guides, projectStyle: style } = selectSkillsForScene(planned, projectStyle)
  // The planner kept this sceneType, but bridge intent pulled in a guide for a
  // DIFFERENT renderer (e.g. react scene + threejs bridge). Surface it; don't act.
  const mismatched = bridges.filter((b) => b.metadata.sceneType !== planned.sceneType)
  const override =
    mismatched.length > 0
      ? `planner sceneType='${planned.sceneType}', bridge intent injected ${mismatched
          .map((b) => b.metadata.id)
          .join(', ')} (sceneType left unchanged — soft signal)`
      : undefined
  return {
    sceneId: planned.id ?? planned.name,
    sceneType: planned.sceneType,
    injected: guides.map((g) => g.metadata.id),
    bridgeHints: bridges.map((b) => b.metadata.id),
    flowWarnings: [], // reserved: surfaced post-build by the FLOW scan (quickValidateScene)
    override,
    styleApplied: style ? style.metadata.id : null,
  }
}

/** Render a selection trace as a compact, human-readable plan-phase block. */
export function formatSelectionTrace(trace: SceneSelectionTrace[]): string {
  const lines = ['Skill selection trace (deterministic — base renderer + bridge guides):']
  // The auto-loaded distilled style is project-wide (same across scenes) — report it once.
  const style = trace.find((t) => t.styleApplied)?.styleApplied
  if (style) lines.push(`  ★ project style: ${style} (auto-loaded, applied to every scene)`)
  for (const t of trace) {
    const injected = t.injected.length > 0 ? t.injected.join(', ') : 'none (react default)'
    let line = `  • [${t.sceneType}] "${t.sceneId}" → ${injected}`
    if (t.override) line += `  ⚠ ${t.override}`
    lines.push(line)
  }
  return lines.join('\n')
}

async function buildSceneWithSubAgent(opts: BuildSceneOptions): Promise<BuildSceneResult> {
  const { planned, existingScene, parentWorld, parentOpts, emit, logger, subAgentId } = opts

  // Build the TaskPacket — the structured per-scene contract (scope / acceptance
  // / verification) that pins this sub-agent to ONE scene instead of letting it
  // roam the whole scenePlan. (Workstream C.2a, claw-code pattern.)
  const packet = buildTaskPacket(planned, existingScene, opts.priorIssues)
  // Reliability: inject the matched skill GUIDES straight into the sub-agent's
  // prompt (never left to the model to load). Base = the dedicated renderer
  // skill for sceneType (null for 'react'). Bridges = bridge guides for the bridge
  // layers a react scene leans on (<ThreeJSLayer>/<D3Layer>/...), which the
  // sceneType key alone would miss. selectSkillsForScene is the single source the
  // selection trace also reads, so the trace can't drift from what's injected.
  const approachPreamble = opts.videoApproach?.trim()
    ? `## The video's approach (make THIS scene serve it, and flow with the others — not an isolated slide)\n${opts.videoApproach.trim()}\n\n`
    : ''
  const scenePrompt = approachPreamble + assembleScenePrompt(packet, planned, opts.projectStyle, opts.neighbors)

  // Scene-scope: the packet owns one scene id (or none, when it must create it).
  // Every other scene that already exists is read-only for this sub-agent — list
  // them so the runner rejects out-of-scope mutations at execute time. (Scene IDs
  // are identical whether read from parentWorld or its clone, so derive them here;
  // runScopedSubAgent does the actual world clone.)
  const scopeForeignSceneIds = parentWorld.scenes.map((s) => s.id).filter((id) => id !== packet.sceneId)

  // Spawn the sub-agent via the shared scoped-dispatch primitive. The world clone,
  // sub-logger, and runAgent plumbing now live in runScopedSubAgent; this builder
  // owns only the scene-specific contract (TaskPacket) and result extraction below.
  // Per-sub-agent caps: maxToolCalls is always pinned so sub-agents don't inherit
  // the parent's raised 150; budgetUsd = the run's remaining budget split across the
  // batch (without it each sub-agent used the $25 default, so a parallel batch could
  // blow past the user's run cap before the between-batch check).
  const result = await runScopedSubAgent({
    agentType: 'scene-maker' as AgentType,
    prompt: scenePrompt,
    activeTools: buildActiveToolsForSceneType(planned.sceneType, parentOpts.activeTools, opts.featureFlags),
    parentWorld,
    parentOpts,
    emit, // shared SSE stream
    logger,
    subAgentId,
    label: planned.name,
    scopeForeignSceneIds,
    budgetUsd: opts.budgetUsd,
    costLedger: opts.costLedger,
    maxIterations: SUB_AGENT_MAX_ITERATIONS,
    maxToolCalls: SUB_AGENT_MAX_TOOL_CALLS,
    // Focused prompt: only include guidance for this scene's type.
    focusedSceneType: planned.sceneType,
    selectedSceneId: existingScene?.id ?? null,
    sceneContext: existingScene?.id ?? 'all',
  })

  // Find the scene that was built/updated by the sub-agent
  const updatedScene = existingScene
    ? result.updatedScenes.find((s) => s.id === existingScene.id)
    : result.updatedScenes.find((s) => s.name === planned.name || s.prompt?.includes(planned.purpose))

  const success =
    !!updatedScene &&
    (!!updatedScene.svgContent ||
      !!updatedScene.canvasCode ||
      !!updatedScene.sceneCode ||
      !!updatedScene.lottieSource ||
      (updatedScene.aiLayers?.length ?? 0) > 0 ||
      (updatedScene.svgObjects?.length ?? 0) > 0 ||
      ((updatedScene as any).chartLayers?.length ?? 0) > 0)

  // Verification as contract (C.2a): read the sub-agent's own last verify_scene
  // verdict on the scene it owns. `success` above only means "produced content";
  // this captures whether the sub-agent actually verified it passed.
  const ownId = updatedScene?.id
  const verifyCalls = result.toolCalls.filter(
    (tc) => tc.toolName === 'verify_scene' && (!ownId || (tc.input as { sceneId?: string })?.sceneId === ownId),
  )
  const lastVerify = verifyCalls[verifyCalls.length - 1]
  const verifyPassed = lastVerify ? lastVerify.output?.success === true : undefined
  const verifyIssues = ((lastVerify?.output?.data as { issues?: string[] } | undefined)?.issues ?? []).filter(
    (i): i is string => typeof i === 'string',
  )

  // Machine-checked acceptance (C.2a): objectively evaluate the packet's
  // structural checks against the built scene — independent of what the
  // sub-agent claimed. Empty when the scene didn't build.
  const unmetCriteria = updatedScene
    ? evaluateAcceptance(packet.checks, updatedScene)
    : packet.checks.map((c) => c.label)

  // Pixel-truth as acceptance: the post-tool gate flips a write that renders
  // blank/broken to success:false and stamps `_render` on the result. The
  // sub-agent normally self-corrects within its own iterations, but if it
  // exhausted them with the scene still blank, the orchestrator's corrective pass
  // must re-run it — the multi-scene safety net behind the per-tool loop.
  const endedBlank = endedOnBlankRender(result.toolCalls, ownId)

  // A wall-clock timeout aborts the runner's signal, and the runner RETURNS
  // a partial world (`stopReason: 'aborted'`) instead of throwing. Without reading
  // it here, a scene that half-built before the deadline trips `success` (it has
  // some content) and ships on whatever verify verdict happened to exist — often a
  // STALE pass captured earlier in the same run, or `undefined`. Treat a timeout
  // like a blank render: force it unverified and record the timeout as an unmet
  // criterion so the corrective pass re-dispatches the scene instead of shipping it
  // half-built. `success` stays content-based on purpose — the corrective pass only
  // re-runs scenes that produced a scene id, so we must not zero it here.
  const timedOut = result.stopReason === 'aborted'

  const extraUnmet: string[] = []
  if (endedBlank) extraUnmet.push('scene rendered a blank or broken frame')
  if (timedOut) extraUnmet.push('sub-agent timed out before finishing this scene')

  return {
    success,
    sceneId: updatedScene?.id,
    updatedScene,
    updatedTimeline: result.updatedTimeline,
    usage: result.usage,
    toolCalls: result.toolCalls,
    error: success ? undefined : 'Sub-agent did not produce content for this scene',
    verifyPassed: endedBlank || timedOut ? false : verifyPassed,
    verifyIssues,
    unmetCriteria: extraUnmet.length ? [...unmetCriteria, ...extraUnmet] : unmetCriteria,
  }
}

/**
 * Content-producing tools whose successful, non-blocked call recovers a scene
 * from an earlier blank/broken render verdict. Used by `endedOnBlankRender` to
 * decide whether a render block was the scene's FINAL state.
 */
const CONTENT_WRITE_TOOLS = new Set(['write_scene_code', 'patch_layer_code', 'regenerate_layer', 'add_layer'])

/**
 * True when the sub-agent's LAST render-affecting tool call for its scene was a
 * pixel-truth block (success:false + `_render`) that no later clean content write
 * recovered — i.e. the scene's FINAL state is blank/broken. Conservative by
 * construction: a sub-agent that fixed the scene leaves a clean write after the
 * block, so this never false-fires. `ownId` undefined → consider all calls.
 * Exported for unit tests.
 */
export function endedOnBlankRender(toolCalls: ToolCallRecord[], ownId?: string): boolean {
  const forOwn = (tc: ToolCallRecord) => !ownId || (tc.input as { sceneId?: string })?.sceneId === ownId
  const hasRenderBlock = (tc: ToolCallRecord) => !!(tc.output?.data as { _render?: unknown } | undefined)?._render
  let lastBlockIdx = -1
  let lastCleanWriteIdx = -1
  toolCalls.forEach((tc, i) => {
    if (!forOwn(tc)) return
    if (hasRenderBlock(tc) && tc.output?.success === false) lastBlockIdx = i
    else if (CONTENT_WRITE_TOOLS.has(tc.toolName) && tc.output?.success === true) lastCleanWriteIdx = i
  })
  return lastBlockIdx !== -1 && lastBlockIdx > lastCleanWriteIdx
}

/**
 * Evaluate a TaskPacket's structural acceptance checks against a built scene.
 * Returns the labels of the UNMET checks. Structural only — mirrors the field
 * access verify_scene uses; semantic criteria are left to verify_scene/vision.
 */
export function evaluateAcceptance(checks: AcceptanceCheck[], scene: Scene): string[] {
  const hasContent =
    !!scene.svgContent ||
    !!scene.canvasCode ||
    !!scene.sceneCode ||
    !!scene.lottieSource ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    !!(scene as any).reactCode ||
    (scene.aiLayers?.length ?? 0) > 0 ||
    (scene.svgObjects?.length ?? 0) > 0 ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((scene as any).chartLayers?.length ?? 0) > 0
  // Chart EVIDENCE, not presence: a chart layer that actually carries data. A
  // layer with empty data compiles and "renders" but shows an empty plot — the
  // old length-only check passed that as "chart rendered". `data` shape varies by
  // chart type: an ARRAY for bar/line/pie/scatter/area, but an OBJECT for
  // number (`{value,label}`), gauge (`{value,max}`), and plotly (`{traces}`) — so
  // an array-only check would false-negative those valid types (e.g. a big-number
  // KPI callout) into an endless corrective loop. Accept either shape; reject only
  // genuinely-empty data.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartLayers = ((scene as any).chartLayers ?? []) as Array<{ data?: unknown }>
  const hasChart = chartLayers.some((l) => chartLayerHasData(l.data))

  // Imagery EVIDENCE: a real placed media layer (stock/upload/AI image or an enabled
  // video layer), reusing the imagery-floor definition. A CSS gradient standing in for
  // planned imagery has no such layer and fails.
  const hasImagery = sceneHasImagery(scene)

  // 3D EVIDENCE: a real Three.js render, not a flat CSS mock. The React path composes
  // via the <ThreeJSLayer> bridge; the legacy path is sceneType 'three' with THREE.* in
  // sceneCode. Either signature counts; a plain div/gradient has neither.
  const has3d =
    scene.sceneType === 'three' ||
    /ThreeJSLayer|@react-three|\bTHREE\./.test(scene.reactCode || '') ||
    /\bTHREE\.|WebGLRenderer/.test(scene.sceneCode || '')

  // Narration EVIDENCE, not presence: `audioLayer.enabled === true` was true even
  // with no TTS track, empty narration text, or a track that errored — the
  // silent-narration class the audit flagged. Require the layer enabled, real
  // narration text, no error — AND a real audio file (`tts.src`). The src guard
  // is the key one: a client-only TTS provider (web-speech / puter) stores
  // `src: null, status: 'ready'` and add_narration itself warns "the exported
  // MP4 will be SILENT", yet it passed this gate. add_narration sets `src`
  // synchronously (the server path writes a URL before returning, the
  // client-only path leaves it null), so requiring src fails only the
  // exports-silent case, never an in-flight server voiceover.
  const tts = scene.audioLayer?.tts
  const hasNarration =
    scene.audioLayer?.enabled === true &&
    !!tts &&
    (tts.text?.trim().length ?? 0) >= MIN_NARRATION_CHARS &&
    tts.status !== 'error' &&
    (tts.src?.trim().length ?? 0) > 0

  const unmet: string[] = []
  for (const check of checks) {
    let met: boolean
    switch (check.kind) {
      case 'content':
        met = hasContent
        break
      case 'chart':
        met = hasChart
        break
      case 'imagery':
        met = hasImagery
        break
      case '3d':
        met = has3d
        break
      case 'narration':
        met = hasNarration
        break
      case 'duration': {
        // VO-driven growth is legitimate: a narrated scene must be at least as
        // long as its voiceover, and shortening it would truncate the audio — so
        // a scene that carries narration is always exempt. Otherwise flag only a
        // material OVER-run vs the plan (the dead-air defect that ballooned an
        // 87s plan to 193s). An under-duration scene is fine and must NOT trigger
        // a corrective.
        const planned = check.expectedDuration
        met =
          hasNarration ||
          planned == null ||
          typeof scene.duration !== 'number' ||
          scene.duration <= planned * DURATION_OVERRUN_FACTOR
        break
      }
      case 'transition':
        // Only set when the plan called for a specific transition; fails when the
        // built scene doesn't match it (e.g. a `set_all_transitions` clobber to
        // `dissolve`, or the shell's default `none`).
        met = check.expectedTransition == null || scene.transition === check.expectedTransition
        break
      default: {
        // Exhaustiveness guard: a new AcceptanceCheckKind MUST add a branch here.
        // Without this the closed union silently fell through to `narration`,
        // evaluating an unrelated check against `hasNarration`.
        const _exhaustive: never = check.kind
        void _exhaustive
        met = true
      }
    }
    if (!met) unmet.push(check.label)
  }
  return unmet
}

/** A scene may run up to this factor over its planned duration before the
 *  duration acceptance check flags it as dead-air overrun. VO-narrated scenes
 *  are exempt entirely (their length is dictated by the audio). */
const DURATION_OVERRUN_FACTOR = 1.3

/**
 * Turn the durable overflow reading for a scene into an unmet-criteria issue, or
 * null when the scene has no known overflow. Read from `world._sceneOverflowState`
 * (the persistent mirror that survives the fire-once `_layout` advisory), so a
 * scene shipped with known text overflow gets a guaranteed corrective shot
 * instead of shipping the defect when the run hits its iteration cap.
 */
export function overflowIssueFor(
  world: { _sceneOverflowState?: Record<string, Array<{ id: string; overflowPx: number }>> },
  sceneId: string | undefined,
): string | null {
  if (!sceneId) return null
  const overflows = world._sceneOverflowState?.[sceneId]
  if (!overflows || overflows.length === 0) return null
  const sample = overflows
    .slice(0, 3)
    .map((o) => o.id)
    .join(', ')
  return `text overflow: ${overflows.length} element(s) spill past the frame (${sample}) — resize or reflow so they fit within WIDTH×HEIGHT`
}

/** Minimum narration text length to count as real narration vs. an enabled-but-empty
 *  track. Short enough to allow terse callouts ("Net profit up 40%."), long enough to
 *  reject placeholders / a stray character. */
const MIN_NARRATION_CHARS = 8

/**
 * Whether a chart layer's `data` carries real content. Shape is type-dependent:
 *  - array (bar/line/pie/scatter/area/stacked/grouped): non-empty array
 *  - number `{value,label}` / gauge `{value,max}`: a numeric `value`
 *  - plotly `{traces:[...]}`: a non-empty traces array
 *  - any other object: at least one key (don't false-negative an unknown future type)
 * Rejects only genuinely-empty data (`[]`, `{}`, null/undefined).
 */
function chartLayerHasData(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    // Number.isFinite, not `typeof === 'number'`: the old check passed
    // `{value: NaN}` (typeof NaN is 'number') as a rendered chart with data.
    if (Number.isFinite(o.value)) return true
    if (Array.isArray(o.traces)) return o.traces.length > 0
    // Catch-all for unknown/future chart shapes — require at least one value
    // that's real: non-null, and (if numeric) finite. Rejects `{}`, `{foo: null}`,
    // and `{value: NaN}` (a numeric NaN is not null, so a bare null-check passed it).
    return Object.values(o).some((v) => v != null && (typeof v !== 'number' || Number.isFinite(v)))
  }
  return false
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the TaskPacket for a scene: the structured contract (scope, acceptance
 * criteria, verification) a scene-builder sub-agent must satisfy. Derives
 * concrete, checkable acceptance criteria from the scenePlan scene spec rather
 * than handing the sub-agent a vague free-form prompt. (Workstream C.2a.)
 */
export function buildTaskPacket(planned: SceneSpec, existingScene?: Scene, priorIssues?: string[]): TaskPacket {
  const acceptanceCriteria: string[] = []

  if (planned.visualElements) {
    acceptanceCriteria.push(`Renders the key visual elements: ${planned.visualElements}`)
  } else {
    acceptanceCriteria.push(
      `Visually communicates the scene's purpose with a complete ${planned.sceneType} composition`,
    )
  }
  if (planned.narrationDraft) {
    acceptanceCriteria.push(`Narration added (via add_narration) with text: "${planned.narrationDraft}"`)
  }
  if (planned.audioNotes) {
    acceptanceCriteria.push(`Audio cues handled: ${planned.audioNotes}`)
  }
  if (planned.chartSpec) {
    acceptanceCriteria.push(
      `Chart rendered (via chart): ${planned.chartSpec.type} — ${planned.chartSpec.dataDescription}`,
    )
  }
  if (planned.cameraMovement) {
    acceptanceCriteria.push(`Camera motion applied: ${planned.cameraMovement}`)
  }
  // Planned media (AI image/video/stock the scene calls for). Surfacing it here is
  // what makes the plan's imagery actually get built — without it the sub-agent never
  // saw the mediaLayers note and defaulted to CSS.
  if (planned.mediaLayers) {
    acceptanceCriteria.push(
      `Media realized: ${planned.mediaLayers} — generate it (generate_image / generate_veo3_video) or place a stock/library clip; do NOT fake it with CSS`,
    )
  }
  // Storyboard is a required artifact (Lane 1). It's set on planned scenes by
  // plan_scenes; derive as a safety net for specs built outside that path (tests,
  // legacy callers) so the sub-agent ALWAYS gets a shot list to realize.
  const storyboard =
    planned.storyboard && planned.storyboard.length > 0 ? planned.storyboard : deriveStoryboard(planned)
  acceptanceCriteria.push(
    `Realizes the ${storyboard.length}-beat storyboard as camera stations (build the beats in order; the camera travels between them)`,
  )
  if (planned.transition) {
    acceptanceCriteria.push(`Transition to the next scene set: ${planned.transition}`)
  }
  acceptanceCriteria.push(`Fits the planned duration of ${existingScene?.duration ?? planned.duration}s`)

  // The machine-checkable subset (structural). The orchestrator evaluates these
  // against the built scene after the sub-agent returns. Always require content;
  // narration/chart only when the scenePlan called for them.
  const checks: AcceptanceCheck[] = [{ kind: 'content', label: 'scene has renderable content' }]
  if (planned.narrationDraft) checks.push({ kind: 'narration', label: 'narration was added' })
  // Build-time chart gate — the REAL guarantee against "chart planned → CSS text shipped"
  // (the sole machine gate, chartLayerHasData, must key off visualForm now that
  // the art_direct pass owns the decision; chartSpec is kept as a fallback so this stays
  // backward-compatible for plans made before art_direct runs). A 'chart' beat that ships
  // no chart data fails acceptance → corrective rebuild.
  if (planned.visualForm === 'chart' || planned.chartSpec)
    checks.push({
      kind: 'chart',
      label: `chart rendered${planned.chartSpec ? ` (${planned.chartSpec.type})` : ''}`,
    })
  // Build-time imagery/3d gates — the visualForm siblings of the chart gate. A beat the
  // plan marked 'imagery' that ships pure CSS, or a '3d' beat that ships a flat div, fails
  // acceptance → corrective rebuild. (diagram/stat have no gate: pure JSX/CSS is a valid
  // build for them, so a structural check would false-reject — see AcceptanceCheckKind.)
  if (planned.visualForm === 'imagery')
    checks.push({ kind: 'imagery', label: 'planned imagery placed (media layer, not CSS)' })
  if (planned.visualForm === '3d') checks.push({ kind: '3d', label: '3D rendered (Three.js, not a flat mock)' })
  // Duration: flag only a material over-run vs the plan (dead-air), and only when
  // the length isn't VO-driven — evaluateAcceptance exempts narrated scenes.
  if (typeof planned.duration === 'number' && planned.duration > 0) {
    checks.push({
      kind: 'duration',
      label: `stays within ~${Math.round(planned.duration * DURATION_OVERRUN_FACTOR)}s (planned ${planned.duration}s, no dead air)`,
      expectedDuration: planned.duration,
    })
  }
  // Transition: only when the plan specified a real (non-default) transition, so a
  // `set_all_transitions` clobber to `dissolve` is caught instead of silently
  // flattening the plan's match-cut/zoom/hard-cut intent.
  if (planned.transition && planned.transition !== 'none') {
    checks.push({
      kind: 'transition',
      label: `transition to next scene is "${planned.transition}" (as planned)`,
      expectedTransition: planned.transition,
    })
  }

  return {
    sceneId: existingScene?.id ?? null,
    sceneName: planned.name,
    sceneType: planned.sceneType,
    purpose: planned.purpose,
    storyboard,
    acceptanceCriteria,
    checks,
    verification: 'Call verify_scene after building and resolve any issues it reports before reporting done.',
    ...(priorIssues && priorIssues.length > 0 ? { priorIssues } : {}),
  }
}

/** Render a TaskPacket into the prompt handed to the scene-builder sub-agent. */
export function renderTaskPacket(packet: TaskPacket): string {
  const parts: string[] = []
  const corrective = !!packet.priorIssues && packet.priorIssues.length > 0

  parts.push(
    corrective ? `# Task: FIX the scene "${packet.sceneName}"` : `# Task: build the scene "${packet.sceneName}"`,
  )

  // Corrective: the previous build failed — name the exact problems and require
  // an in-place edit (PATCH, don't fork).
  if (corrective) {
    parts.push(
      `\n## Fix required\nA previous build of this scene did not pass. Address these specific problems, then call verify_scene again:\n` +
        packet.priorIssues!.map((p) => `- ${p}`).join('\n') +
        `\n\nEdit the EXISTING scene in place. Read_scene_code first, then PREFER patch_layer_code with a SMALL exact oldCode anchor (a few lines around the defect) — a targeted patch is far faster and cheaper than re-emitting the whole scene. Only fall back to write_scene_code if the fix restructures more than roughly a third of the scene, or patch_layer_code fails because you can't find an exact anchor after re-reading. Use the SAME sceneId; do NOT create a new scene.`,
    )
  }

  // Scope — what this sub-agent owns and may touch.
  if (packet.sceneId) {
    parts.push(
      `\n## Scope\nYou own exactly one scene: "${packet.sceneName}" (ID: ${packet.sceneId}). ` +
        `${corrective ? 'Fix' : 'Build'} its visual content. Do NOT create or modify any other scene — other scenes in the project are read-only context.`,
    )
  } else {
    parts.push(
      `\n## Scope\nCreate and build one scene called "${packet.sceneName}". ` +
        `Do NOT modify any pre-existing scene — those are read-only context.`,
    )
  }

  // Storyboard — the mandatory shot list this scene must realize (camera stations).
  const storyboardBlock = renderStoryboardBlock(packet.storyboard)
  if (storyboardBlock) parts.push(storyboardBlock)

  // Acceptance — the bar for "done".
  parts.push(
    `\n## Acceptance criteria\nPurpose: ${packet.purpose}\nScene type: ${packet.sceneType}\n` +
      packet.acceptanceCriteria.map((c) => `- ${c}`).join('\n'),
  )

  // Verification — how to prove it's done.
  parts.push(`\n## Verification\n${packet.verification}`)

  return parts.join('\n')
}

/** Match scenePlan scene specs to existing scene shells in the world by stable id,
 *  then name, then index. Each world scene can only be matched once — prevents
 *  duplicate sub-agent builds. The id pass is the re-plan drift guard: a plan scene
 *  whose stable id was carried forward (plan_scenes) re-finds the exact scene it was
 *  pinned to, independent of a drifted name or reordered position. */
export function matchScenePlanToScenes(planned: SceneSpec[], worldScenes: Scene[]): Map<number, Scene> {
  const map = new Map<number, Scene>()
  const claimedIds = new Set<string>()

  for (let i = 0; i < planned.length; i++) {
    // Stable-id match first — survives name drift and reordering across re-plans.
    const plannedId = planned[i].id
    if (plannedId) {
      const byId = worldScenes.find((s) => !claimedIds.has(s.id) && s.id === plannedId)
      if (byId) {
        map.set(i, byId)
        claimedIds.add(byId.id)
        continue
      }
    }

    // Then exact name match
    const byName = worldScenes.find(
      (s) => !claimedIds.has(s.id) && s.name.toLowerCase() === planned[i].name.toLowerCase(),
    )
    if (byName) {
      map.set(i, byName)
      claimedIds.add(byName.id)
      continue
    }

    // Fall back to index-based match (scenes created in scenePlan order)
    if (i < worldScenes.length && !claimedIds.has(worldScenes[i].id)) {
      map.set(i, worldScenes[i])
      claimedIds.add(worldScenes[i].id)
    }
    // If no match, sub-agent will create the scene itself
  }

  return map
}
