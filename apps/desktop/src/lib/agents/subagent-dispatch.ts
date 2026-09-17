/**
 * Scoped sub-agent dispatch — the generic "spawn one sub-agent" primitive.
 *
 * A sub-agent is a recursive `runAgent()` call that operates on an isolated
 * clone of the parent world, shares the parent's SSE `emit`, runs with a
 * narrowed toolset (enforced at execute time via `enforcedToolNames`), and is
 * bounded by its own iteration / tool-call / cost / wall-clock limits.
 *
 * This module owns ONLY the spawn mechanics (clone, sub-logger, the runAgent
 * call). Callers own what's specific to their kind of sub-agent:
 *   - the scene builder (orchestrator.ts) layers a TaskPacket prompt, scene
 *     success detection, verify-as-contract, and machine-checked acceptance on
 *     top of it.
 *   - the typed-subagent dispatch layers a per-type toolset + prompt
 *     and returns a structured summary.
 *
 * Dependency note: this module statically imports `runAgent` from './runner'.
 * The runner must NOT statically import this module back — when the runner
 * needs to spawn (dispatch interception) it uses a dynamic
 * `await import('./subagent-dispatch')`, mirroring how it already dynamic-imports
 * './orchestrator'. That keeps the static graph acyclic
 * (orchestrator → subagent-dispatch → runner, no back-edges).
 */

import { randomUUID } from 'crypto'
import type { Scene, GlobalStyle } from '../types'
import { runAgent, type RunnerOptions } from './runner'
import { isOverCap, type RunCostLedger } from './run-cost-ledger'
import type { WorldStateMutable } from './world-state'
import { AgentLogger } from './logger'
import type { AgentType, ToolResult } from './types'
import type { ModelConfig } from './model-config'
import { isSearxngReady } from '@/lib/research/providers/searxng'
import { isTavilyReady } from '@/lib/research/providers/tavily'

/**
 * Resolve the research-model setting to a concrete model id (or undefined =
 * inherit the parent). `'auto'` (the default) picks DeepSeek V4 Flash ONLY when
 * it can actually work — a search backend is configured (DeepSeek has no native
 * web search) and a DeepSeek model is enabled with a key — otherwise it inherits
 * the frontier parent (which has native search). Explicit ids pass through;
 * falsy / `'inherit'` means inherit. Pure so it can be unit-tested.
 */
export function resolveResearchModelId(
  researchModelId: string | null | undefined,
  modelConfigs: ModelConfig[] | undefined,
  searchReady: boolean,
  deepseekKeyPresent: boolean,
): string | undefined {
  if (!researchModelId || researchModelId === 'inherit') return undefined
  if (researchModelId !== 'auto') return researchModelId // explicit model choice
  const deepseek = modelConfigs?.find((m) => m.provider === 'deepseek' && m.enabled)
  return searchReady && deepseek && deepseekKeyPresent ? deepseek.id : undefined
}

export interface ScopedSubAgentOptions {
  /**
   * Which agent persona/toolset the sub-agent runs as. Typed Explore / Plan /
   * Verification toolsets come from the allowedToolsForSubagent table.
   */
  agentType: AgentType
  /** The task prompt handed to the sub-agent. */
  prompt: string
  /**
   * The toolset the sub-agent is offered. Becomes its `enforcedToolNames` set in
   * the runner (`runner.ts` sets it from `ctx.tools` for any sub-agent), so any
   * tool not in this list is rejected at execute time.
   */
  activeTools: string[]
  /**
   * Strict tool allowlist — when set, the sub-agent is offered EXACTLY these tools
   * (see ContextOpts.toolAllowlist), bypassing activeTools' category-enable semantics.
   * Typed sub-agents set this to enforce a read-only / narrowed toolset; scene
   * builders leave it unset (they need the always-on builder toolset).
   */
  toolAllowlist?: string[]
  parentWorld: WorldStateMutable
  parentOpts: RunnerOptions
  /** Model this sub-agent runs on, overriding the parent's model. Used to route
   *  research onto a local model (researchModelId) so it runs for $0 tokens while
   *  the parent build stays on the frontier model. Undefined → inherit parent. */
  modelOverride?: string | null
  /** Read-only research worker: use the lean research system prompt (not the full
   *  ~95K builder prompt). Cuts tokens and lets small local models drive the loop. */
  leanResearchPrompt?: boolean
  /** Shared SSE stream — the sub-agent streams into the same channel as the parent. */
  emit: (event: SSEEventLike) => void
  /** Parent logger, used only to correlate the sub-agent's logger to the parent run. */
  logger: AgentLogger
  subAgentId: string
  /** Correlation label for the sub-agent's start log (e.g. the scene name). */
  label: string
  /** Scenes this sub-agent may NOT mutate (everything it does not own). */
  scopeForeignSceneIds?: string[]
  /** Per-sub-agent cost ceiling (USD). undefined → runner default. */
  budgetUsd?: number
  /** Shared run-scoped cost ledger, threaded by reference so the run-wide cap holds live. */
  costLedger?: RunCostLedger
  /** Log this sub-agent's own agent_usage / api_spend row (see RunnerOptions.selfLogUsage).
   *  Set ONLY by typed dispatch — the orchestrator handoff aggregates its builders into
   *  the parent instead, and doing both double-counts. */
  selfLogUsage?: boolean
  /** Iteration cap for this sub-agent. */
  maxIterations: number
  /** Tool-call cap for this sub-agent. */
  maxToolCalls: number
  /** Optional scene-builder focus hints. */
  focusedSceneType?: RunnerOptions['focusedSceneType']
  selectedSceneId?: RunnerOptions['selectedSceneId']
  sceneContext?: RunnerOptions['sceneContext']
}

// The emit signature is intentionally structural to avoid importing the SSEEvent
// union here; callers pass their typed emit and it widens to this.
type SSEEventLike = Parameters<NonNullable<RunnerOptions['emit']>>[0]

/**
 * Spawn one sub-agent and return its raw `runAgent` result. Behavior is identical
 * to what the orchestrator's scene builder did inline before extraction — the
 * world is deep-cloned, the sub-agent runs with `isSubAgent: true` (which the
 * runner uses to enforce the toolset), and all run plumbing (model, permissions,
 * abort, ledger) is threaded from the parent.
 */
export async function runScopedSubAgent(opts: ScopedSubAgentOptions): Promise<Awaited<ReturnType<typeof runAgent>>> {
  const { parentWorld, parentOpts, emit, logger, subAgentId } = opts

  // Clone the parent world for isolation (deep clone to prevent cross-agent mutations).
  const isolatedScenes = JSON.parse(JSON.stringify(parentWorld.scenes)) as Scene[]
  const isolatedGlobalStyle = JSON.parse(JSON.stringify(parentWorld.globalStyle)) as GlobalStyle

  // Sub-agent logger correlated to the parent run.
  const subLogger = new AgentLogger()
  subLogger.log('sub_agent', `Starting: ${opts.label}`, {
    parentRunId: logger.runId,
    subAgentId,
  })

  // Ground the scene-builder in this project's research. The sub-agent runs with
  // history:[] so it can't see the parent's research tool-results; without this the
  // facts + staged assets the research gathered never reach the agent that writes the
  // scenes (they evaporated in the parent transcript). Dynamic-import keeps server-only
  // out of the dispatch unit tests; best-effort (never blocks a build).
  let researchGrounding = ''
  try {
    const { renderResearchGrounding } = await import('@/lib/research/research-memory')
    researchGrounding = await renderResearchGrounding(parentOpts.projectId)
  } catch {
    /* best-effort grounding — a failure here never blocks the build */
  }

  return runAgent({
    message: opts.prompt + researchGrounding,
    // A per-sub-agent modelOverride (research → local model) wins over the
    // parent's; resolveModel honors an explicit enabled override across every
    // internal role, so the whole sub-agent runs on it. Falls back to the
    // parent's model when unset.
    modelOverride: (opts.modelOverride ?? parentOpts.modelOverride) as RunnerOptions['modelOverride'],
    leanResearchPrompt: opts.leanResearchPrompt,
    modelTier: parentOpts.modelTier,
    // WITHOUT THIS every sub-agent builds a landscape scene in a portrait project.
    // resolveProjectDimensions() falls back to 16:9 / 1920x1080 when mp4Settings is
    // absent (src/lib/dimensions.ts), and this literal forwards ~35 fields but used to
    // omit this one — so a 9:16 project's scene builders got WIDTH=1920 HEIGHT=1080 in
    // their prompt, their patched tool schemas, and regenerateHTML, while the brief in
    // the same prompt said "Format: 9:16". Export regenerates the wrapper, so it cannot
    // undo a layout authored to the wrong frame. Both default build paths route here.
    mp4Settings: parentOpts.mp4Settings,
    thinkingMode: parentOpts.thinkingMode ?? 'adaptive',
    sceneContext: opts.sceneContext ?? 'all',
    activeTools: opts.activeTools,
    toolAllowlist: opts.toolAllowlist,
    history: [], // fresh context per sub-agent
    projectId: parentOpts.projectId,
    scenes: isolatedScenes,
    globalStyle: isolatedGlobalStyle,
    projectName: parentOpts.projectName,
    outputMode: parentOpts.outputMode,
    sceneGraph: parentWorld.sceneGraph ? JSON.parse(JSON.stringify(parentWorld.sceneGraph)) : undefined,
    // The NLE timeline. `init_timeline` / `read_timeline` / `add_track` / `place_clip`
    // are deliberately NOT stripped from sub-agents (see NLE_EDIT_TOOL_NAMES) and the
    // builder prompt points at add_track+place_clip for timeline audio — but this
    // literal never forwarded the timeline, so a builder read an EMPTY sequence,
    // init_timeline fabricated a throwaway one, and every clip it placed was dropped on
    // the way home. Forward it (runAgent deep-clones, so tool mutations stay in the
    // clone) and the callers merge `updatedTimeline` back. Falsy → null, which is the
    // shape init_timeline's fabricate-fallback expects.
    timeline: parentWorld.timeline ?? null,
    // Forward the whole-video build spec so the scene-BUILDING sub-agent (director +
    // fan-out) seeds world.scenePlan. Without it plannedDurationFor() reads undefined →
    // the add_narration word-cap is DEAD → the builder writes 150s of narration against
    // a 90s plan ("same stubborn logic, 2+ minutes despite saying 90s"). It also enters
    // at phase:'build' so the sub-agent doesn't re-plan (plan_scenes is parent-only now).
    // Only builders (no toolAllowlist); a research/typed dispatch must NOT enter build.
    ...(!opts.toolAllowlist && parentWorld.scenePlan
      ? { initialScenePlan: JSON.parse(JSON.stringify(parentWorld.scenePlan)) }
      : {}),
    selectedSceneId: opts.selectedSceneId ?? null,
    apiPermissions: parentOpts.apiPermissions,
    enabledModelIds: parentOpts.enabledModelIds,
    // Forward modelConfigs too — without it a sub-agent routed to a custom model
    // (e.g. a local research model via researchModelId) can't resolve that model's
    // endpoint/localModelName/pricing, so a local Ollama research model falls back
    // to using its config id as the Ollama model name → 404. enabledModelIds alone
    // gates which ids are allowed; modelConfigs carries HOW to reach them.
    modelConfigs: parentOpts.modelConfigs,
    audioProviderEnabled: parentOpts.audioProviderEnabled,
    mediaGenEnabled: parentOpts.mediaGenEnabled,
    // Web-research flags must inherit from the parent — Explore/Plan sub-agents are
    // built around web_search/fetch, and these now default ON. Without forwarding they
    // arrive undefined (falsy) and every web tool is filtered out of the sub-agent.
    webSearchEnabled: parentOpts.webSearchEnabled,
    webFetchEnabled: parentOpts.webFetchEnabled,
    autoAcceptWebSearch: parentOpts.autoAcceptWebSearch,
    sessionPermissions: parentOpts.sessionPermissions,
    generationOverrides: parentOpts.generationOverrides,
    autoChooseDefaults: parentOpts.autoChooseDefaults,
    // Run-mode must propagate or a sub-agent would spend real money / skip
    // placeholders while the parent run is in Sandbox / a non-default posture.
    sandboxMode: parentOpts.sandboxMode,
    permissionPosture: parentOpts.permissionPosture,
    // OKF: the brief is what get_routed_craft routes off when it is called with no
    // `pack` — a brief-less sub-agent gets an empty result (the one recorded call in
    // 36 runs got exactly that, because no brief was stored). It is also read for the
    // pacing profile and the media/avatar lanes. Forward it so the agent that actually
    // writes the scenes sees the same intent the planner did.
    projectBrief: parentOpts.projectBrief,
    // Forward the USER'S provided assets to the scene-building sub-agent — without
    // these, a prompt like "use the assets you were given" points at empty state
    // (the builder is the agent that actually writes scenes). referenceMedia =
    // uploaded reference media; projectAssets = the media library.
    referenceMedia: parentOpts.referenceMedia,
    projectAssets: parentOpts.projectAssets,
    abortSignal: parentOpts.abortSignal,
    logger: subLogger,
    emit, // shared SSE stream
    userMemories: parentOpts.userMemories,
    userId: parentOpts.userId,
    // Sub-agent specific
    maxIterations: opts.maxIterations,
    isSubAgent: true,
    parentRunId: logger.runId,
    selfLogUsage: opts.selfLogUsage,
    focusedSceneType: opts.focusedSceneType,
    // TaskPacket scope: reject mutations to any scene this sub-agent doesn't own.
    scopeForeignSceneIds: opts.scopeForeignSceneIds,
    // Shared cost ledger: enforce the run-wide ceiling live across all sub-agents.
    costLedger: opts.costLedger,
    // Per-sub-agent caps. maxToolCalls is always pinned so sub-agents don't inherit
    // the parent's raised limit. maxRunCostUsd = the slice of the run's remaining
    // budget assigned to this sub-agent (omitted → runner default).
    runConfig: {
      maxToolCalls: opts.maxToolCalls,
      ...(opts.budgetUsd != null ? { maxRunCostUsd: opts.budgetUsd } : {}),
    },
  })
}

// ── Typed sub-agents ───────────────────────────────────────────────
//
// A typed sub-agent is the parent dispatching a focused worker of a known KIND
// (research, plan, verification) rather than a scene builder. The kind maps to
// a scoped toolset (claw-code's allowed_tools_for_subagent pattern) and a role
// prompt. The toolset is enforced at execute time by the runner's existing
// enforcedToolNames mechanism (set from the offered tools), so a read-only
// Explore worker physically cannot mutate scenes regardless of what it tries.

export type SubagentType = 'Explore' | 'Plan' | 'Verification' | 'general-purpose'

/**
 * Map a loose/aliased type string to a canonical SubagentType. Unknown →
 * 'general-purpose' (the safe, full-toolset default). Mirrors claw-code's
 * normalize_subagent_type.
 */
export function normalizeSubagentType(raw: string | undefined | null): SubagentType {
  const t = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  switch (t) {
    case 'explore':
    case 'explorer':
    case 'research':
    case 'researcher':
      return 'Explore'
    case 'plan':
    case 'planner':
    case 'planning':
      return 'Plan'
    case 'verify':
    case 'verification':
    case 'verifier':
    case 'review':
    case 'reviewer':
      return 'Verification'
    default:
      return 'general-purpose'
  }
}

/**
 * The toolset a typed sub-agent is offered (and, via enforcedToolNames, limited
 * to). Returns `null` for 'general-purpose', meaning "inherit the parent's full
 * toolset — no narrowing". Tool names not yet registered (e.g. write_plan /
 * update_todos) are harmless here: the context builder
 * drops any name that isn't a real tool, so they simply don't appear in the
 * sub-agent's offered set until they exist.
 */
export function allowedToolsForSubagent(type: SubagentType): string[] | null {
  switch (type) {
    case 'Explore':
      // Read-only research: web + media discovery + docs + skills + read-only
      // scene/editor inspection. request_web_search is the approval proxy the
      // context-builder injects in place of web_search when Auto-Accept is off —
      // allowlist it so it isn't dropped post-filter. The find_stock_* / archival
      // tools are read-only, free/local provider APIs (no LLM cost) — with them the
      // research loop can surface real, licensed asset URLs, not just prose, which
      // the parent then places with its own media tools.
      return ['web_search', 'request_web_search', 'fetch_url_content', 'find_media', 'inspect']
    case 'Plan':
      // Explore set + the plan/todo writers. No scene mutations.
      return ['web_search', 'request_web_search', 'fetch_url_content', 'inspect', 'write_plan', 'update_todos']
    case 'Verification':
      // Inspect-and-report on already-built work. No mutation. review(scope:'cut') reviews
      // the whole cut (pacing/redundancy/continuity); verify_scene/capture_frame are per-scene.
      return ['inspect', 'verify_scene', 'capture_frame', 'review']
    case 'general-purpose':
      return null // inherit parent toolset
  }
}

/** Role-framing prefix prepended to the task. The toolset does the hard limiting;
 *  this tells the worker what game it's playing and what to return. */
const SUBAGENT_PROMPTS: Record<SubagentType, string> = {
  Explore: `You are an Explore sub-agent: a deep-research worker. Run a disciplined multi-hop research loop (the "IterResearch" method) using only your read-only tools (web_search, fetch_url_content, skill lookup, read-only scene/editor inspection). You have NO tools to build or modify anything.

Method — follow it even when a shortcut looks tempting:
1. PLAN: break the question into 2–4 concrete sub-questions and what "enough" looks like.
2. SEARCH broad: web_search each sub-question; scan titles/snippets to pick the best sources.
3. VISIT: fetch_url_content on the most promising 2–3 URLs and extract only the facts that answer a sub-question (with the source URL).
4. SYNTHESIZE: keep a running set of findings; note which sub-questions are still open.
5. SEARCH focused: issue tighter follow-up queries aimed at the gaps. Repeat 3–4.
6. STOP when every sub-question is answered or further searches stop adding new facts — don't loop for its own sake.

When the task needs visual assets, use your media tool — find_media(kind:'image') for photos, kind:'video' for footage, kind:'archival' for Archive.org / NASA / Wikimedia public-domain material — to find REAL, licensed assets rather than describing them. List each asset you recommend by pasting the tool's returned URL VERBATIM (with attribution) in your brief — the assets you cite are automatically downloaded into the project library and handed to the parent as stable ids, so cite the exact URLs from the tool results.

Finish with a concise, well-organized brief: the answer, the key findings grouped by sub-question, and a Sources list of the URLs you actually used. Put any media you found in a clearly-labeled "Media" section with one direct asset URL per line. Your final message IS the deliverable handed back to the parent agent.`,
  Plan: `You are a Plan sub-agent: you draft a clear, written plan for the task. Research read-only as needed, then write the plan and any todo items. Do NOT build or modify scenes — you have no tools to do so. Your final message IS the plan handed back to the parent agent.`,
  Verification: `You are a Verification sub-agent: you inspect already-built work and report. Use your read-only inspection tools to check the task against its acceptance criteria. For a single scene, use verify_scene / capture_frame. To review how the FINISHED CUT reads as a whole (pacing, redundancy, continuity across scenes), call review (scope:'cut') once and fold its brief into your report. Do NOT modify anything. Finish with a concise pass/fail verdict and a list of concrete issues. Your final message IS the report handed back to the parent agent.`,
  'general-purpose': `You are a focused sub-agent. Work only on the delegated task, use only the tools available to you, do not ask the user questions, and finish with a concise result handed back to the parent agent.`,
}

// Typed sub-agents are read-light vs scene builders; cap them tighter. The cost
// ledger remains the real ceiling.
const TYPED_SUBAGENT_MAX_ITERATIONS = 12
const TYPED_SUBAGENT_MAX_TOOL_CALLS = 25

/** Run context the runner threads into a typed dispatch (everything runScopedSubAgent
 *  needs that a tool handler can't reach — hence dispatch lives in the runner). */
export interface TypedDispatchContext {
  parentWorld: WorldStateMutable
  parentOpts: RunnerOptions
  emit: (event: SSEEventLike) => void
  logger: AgentLogger
  costLedger?: RunCostLedger
}

/**
 * Execute a `dispatch_subagent` tool call: spawn a typed sub-agent and return its
 * brief as a ToolResult (which the runner hands back as the tool_result so the
 * parent continues with it — runner-level interception). Blocking + return-summary-only.
 */
export async function runTypedSubAgent(
  args: { subagentType?: string; task?: string } | undefined,
  ctx: TypedDispatchContext,
): Promise<ToolResult> {
  // Recursion guard: a sub-agent cannot spawn further sub-agents. (Blocking,
  // single-level delegation — deliberate; deeper trees are not supported.)
  if (ctx.parentOpts.isSubAgent) {
    return { success: false, error: 'A sub-agent cannot dispatch another sub-agent.' }
  }

  const task = args?.task?.trim()
  if (!task) {
    return {
      success: false,
      error: 'dispatch_subagent requires a non-empty "task" describing what the sub-agent should do.',
    }
  }

  const type = normalizeSubagentType(args?.subagentType)
  const scoped = allowedToolsForSubagent(type)
  // general-purpose (null) inherits the parent's offered toolset (no allowlist).
  // Scoped types pass a strict toolAllowlist so the runner offers EXACTLY those tools
  // — activeTools alone does NOT narrow (it's an enable model, not an allowlist), so
  // without toolAllowlist the always-on mutating base toolset would leak in.
  const activeTools = scoped ?? ctx.parentOpts.activeTools ?? []
  const toolAllowlist = scoped ?? undefined
  const prompt = `${SUBAGENT_PROMPTS[type]}\n\n## Task\n${task}`

  // Route research (Explore/Plan) onto the configured research model when set —
  // a local Ollama model runs the whole deep-research loop for $0 tokens while
  // the parent build stays on the frontier model. Verification/general-purpose
  // inherit the parent (they inspect built work; keep them on the same brain).
  const isResearch = type === 'Explore' || type === 'Plan'
  const researchModel = isResearch
    ? resolveResearchModelId(
        ctx.parentOpts.researchModelId,
        ctx.parentOpts.modelConfigs,
        isSearxngReady() || isTavilyReady(),
        !!process.env.DEEPSEEK_API_KEY,
      )
    : undefined

  // Research memory: before dispatch, semantically reuse prior notes for this
  // project and wrap emit to collect native-search citations (the frontier Inherit
  // path emits sources via SSE, not via a web_search tool call). Dynamic-imported so
  // dispatch's unit tests never pull server-only / the embedder / the db.
  const projectId = ctx.parentWorld?.projectId
  let researchPrompt = prompt
  let taskEmbedding: number[] | null = null
  const nativeSources: { title: string; url: string }[] = []
  let researchEmit = ctx.emit
  if (isResearch && projectId) {
    try {
      const mem = await import('@/lib/research/research-memory')
      const built = await mem.buildPriorResearchPreamble(projectId, task)
      researchPrompt = prompt + built.preamble
      taskEmbedding = built.taskEmbedding
    } catch {
      /* reuse is best-effort — the embedder/db helpers log their own failures */
    }
    researchEmit = (event: SSEEventLike) => {
      const ev = event as unknown as { type?: string; sources?: Array<{ title?: string; url?: string }> }
      if (ev?.type === 'sources' && Array.isArray(ev.sources)) {
        for (const s of ev.sources) {
          const url = typeof s?.url === 'string' ? s.url : ''
          if (url) nativeSources.push({ title: typeof s?.title === 'string' ? s.title : url, url })
        }
      }
      ctx.emit(event)
    }
  }

  const result = await runScopedSubAgent({
    agentType: 'scene-maker' as AgentType, // proven sub-agent persona; the toolset + role prompt scope behavior
    prompt: researchPrompt,
    activeTools,
    toolAllowlist,
    modelOverride: researchModel,
    // Explore/Plan are pure read-only researchers — give them the lean research
    // prompt (the full ~95K builder prompt swamps small local models and wastes
    // tokens). Verification keeps the full prompt (it reasons about built scenes).
    leanResearchPrompt: isResearch,
    parentWorld: ctx.parentWorld,
    parentOpts: ctx.parentOpts,
    emit: researchEmit,
    logger: ctx.logger,
    subAgentId: randomUUID().slice(0, 8),
    label: `${type} sub-agent`,
    costLedger: ctx.costLedger,
    // Nobody aggregates a typed sub-agent's tokens (the parent only folds in
    // ORCHESTRATOR scene builders), so without this every Explore/Plan/
    // Verification dispatch was invisible in agent_usage and api_spend. It logs
    // its own row, priced at its own model — which matters because research
    // often runs on a cheaper or local model than the parent.
    selfLogUsage: true,
    maxIterations: TYPED_SUBAGENT_MAX_ITERATIONS,
    maxToolCalls: TYPED_SUBAGENT_MAX_TOOL_CALLS,
  })

  // Degenerate-termination guard: a sub-agent cut off by an abort or the run-wide
  // cost cap returns whatever partial text it had — and the runner even APPENDS a
  // "Cost limit reached …" notice to fullText. That text is NOT a real brief, so
  // inferring success from non-empty text would hand the parent a budget notice as
  // if it were research/verification. Catch the two degenerate cases explicitly.
  // (A clean stopReason on the runAgent return would also catch the iteration-cap
  // partial-text case — not added, to avoid widening the runAgent contract.)
  if (ctx.parentOpts.abortSignal?.aborted) {
    return { success: false, error: `${type} sub-agent was aborted before completing.`, data: { subagentType: type } }
  }
  if (ctx.costLedger && isOverCap(ctx.costLedger)) {
    return {
      success: false,
      error: `${type} sub-agent stopped at the run cost cap before completing — its output is incomplete and was not treated as a result.`,
      data: { subagentType: type, partial: (result.fullText ?? '').trim().slice(0, 500) },
    }
  }

  // The sub-agent's final text is the brief. Empty text → surface that honestly
  // rather than a silent success.
  const brief = (result.fullText ?? '').trim()
  if (!brief) {
    return {
      success: false,
      error: `${type} sub-agent finished without producing a brief (ran ${result.toolCalls.length} tool call(s)).`,
      data: { subagentType: type, toolCallsUsed: result.toolCalls.length },
    }
  }
  // Research memory: after the brief, stage the media it cited into the project
  // library (deterministic, by direct URL — outside-voice #4) and persist the note
  // (sources = harvested web_search ⊕ native citations). Appends a "Staged assets"
  // block; never mutates the model's text. Best-effort — failures don't fail the run.
  let finalBrief = brief
  if (isResearch && projectId) {
    try {
      const mem = await import('@/lib/research/research-memory')
      finalBrief = await mem.persistAndStageResearch({
        projectId,
        task,
        brief,
        toolCalls: result.toolCalls,
        nativeSources,
        taskEmbedding,
      })
    } catch {
      /* stage/persist is best-effort — helpers log their own failures */
    }
  }

  return {
    success: true,
    // `report` (not `brief`) is the key the runner's summarizeToolResult
    // preserves VERBATIM — a `brief` string over 500 chars is truncated to a
    // "[N chars generated]" husk, which would drop the research findings and any
    // asset URLs before they reach the parent. Return the full text under
    // `report` (same channel web_search uses); keep `brief` for readability.
    data: { subagentType: type, report: finalBrief, brief: finalBrief, toolCallsUsed: result.toolCalls.length },
  }
}
