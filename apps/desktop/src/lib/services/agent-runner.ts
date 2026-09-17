/**
 * Agent runner service — transport-agnostic orchestration for the in-app agent.
 *
 * Callers:
 *   - Electron IPC handler (`src/electron/ipc/agent.ts`): forwards each event to
 *     `webContents.send('dreambyte:agent.event', runId, event)`.
 *   - The offline eval harness (`evals/benchmark/run.ts`): drives the real
 *     runner headless with an in-process `emit`.
 *
 * The service takes `emit(event)` as a callback — it does not know about HTTP,
 * SSE framing, or webContents. It DOES still emit `run_start` / `warning` /
 * `state_change` events inline, matching the original route's behavior exactly.
 *
 * Preconditions (caller's responsibility):
 *   - body already validated (message present, scenes array, size limits).
 *   - `authenticatedUserId` already resolved (or null for guest mode).
 *   - `abortSignal` wired to whatever cancellation the transport exposes
 *     (HTTP: req.signal; IPC: dreambyte:agent.abort handler).
 *
 * Postconditions:
 *   - Every event the runner needed to communicate has been passed to `emit`.
 *   - All side effects (generation log, scene persistence, memory extraction)
 *     have completed. The returned promise resolves on success, rejects on
 *     fatal error. Non-fatal errors are emitted via `emit({ type: 'error' })`
 *     and the promise still resolves.
 */

import crypto from 'crypto'
import type {
  AgentType,
  ModelId,
  ModelTier,
  ThinkingMode,
  SSEEvent,
  ChatMessage,
  MessageContent,
  ScenePlan,
} from '@/lib/agents/types'
import { messageContentToText, getModelProvider } from '@/lib/agents/types'
import type { Scene, GlobalStyle, APIPermissions, SceneGraph } from '@/lib/types'
import { isEmptyAgentShell, sceneHasRenderableContent } from '@/lib/store/helpers'
import { runAgent } from '@/lib/agents/runner'
import { trace, traceSetRun } from '@/lib/agents/trace'
import { AgentLogger } from '@/lib/agents/logger'
import { createGenerationLog, updateGenerationLog } from '@/lib/db/queries/generation-logs'
import { db } from '@/lib/db'
import { projectAssets as projectAssetsTable, projects as projectsTable } from '@/lib/db/schema'
import { persistScenesFromAgentRun } from '@/lib/db/queries/projects'
import { isPlaceholderContent } from '@/lib/scenes/placeholder-content'
import { getRunCheckpoint, clearRunCheckpoint } from '@/lib/db/queries/branch-proposals'
import { getMemoriesScoped, upsertMemory, adjustMemoryKeyConfidence } from '@/lib/db/queries/user-memory'
import { extractMemories } from '@/lib/agents/memory-extractor'
import { extractSemanticMemories, inferMemoryAdjustments } from '@/lib/agents/semantic-memory'
import { computeConfidenceAdjustments } from '@/lib/agents/confidence-pipeline'
import { registerBuiltInHooks } from '@/lib/agents/built-in-hooks'
import { detectFrustration, computeRunMetrics, logRunAnalytics, serializeRunMetrics } from '@/lib/agents/run-analytics'
import { runMockAgentStream } from '@/lib/agents/mock-agent-stream'
import { eq, desc } from 'drizzle-orm'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.runner')

// Ensure built-in hooks register once at module load. Moved here from the
// route so IPC callers pick them up too.
registerBuiltInHooks()

// Per-branch mutex: prevents concurrent agent runs on the same project+branch.
// Different branches of the same project CAN run in parallel — this is the
// unlock for multi-variant agent spawns (v0.3.8). Branches are independent
// data scopes (per-branch scenes/snapshots/action_log), so concurrent runs on
// different branches don't conflict at the data layer either. In-memory is
// fine for single-user Electron; multi-server would need Redis.
//
// Key shape: `${projectId}:${branchId ?? '__default__'}`. Callers that don't
// pass a branchId fall back to a project-level lock (back-compat with v0.3.7
// and earlier — no behavior change for single-branch callers).
const activeRuns = new Map<string, { startedAt: number; signal?: AbortSignal }>()
// Fallback staleness for slots reserved WITHOUT a liveness signal (older
// callers). A long but healthy run easily exceeds 10 min (agent loops + media
// gen + export), so a fixed wall-clock TTL would let a second same-branch
// request steal the slot mid-run and double-write the per-branch action_log
// When a signal is supplied we key staleness on it instead, and
// only fall back to this hard backstop for a genuinely hung run.
const STALE_RUN_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes (no-signal fallback)
const HARD_MAX_RUN_MS = 60 * 60 * 1000 // 1h absolute backstop even for "live" runs

function isStaleRun(entry: { startedAt: number; signal?: AbortSignal }): boolean {
  // A LIVE signal (not aborted) means the run is definitely still going — never
  // steal its slot (the point of signal-keyed staleness), up to a 1h backstop for a truly hung run.
  if (entry.signal && !entry.signal.aborted) {
    return Date.now() - entry.startedAt >= HARD_MAX_RUN_MS
  }
  // Aborted, or no signal: do NOT free instantly. An aborted run still needs to
  // unwind and flush per-branch persistence before releaseRunSlot fires in the
  // transport's .finally(); freeing the slot the moment the signal aborts would
  // let a concurrent same-branch run start mid-unwind and interleave the
  // action_log. The wall-clock TTL is the crash-recovery
  // fallback for when release never runs at all.
  return Date.now() - entry.startedAt >= STALE_RUN_TIMEOUT_MS
}

function runKey(projectId: string, branchId?: string | null): string {
  return `${projectId}:${branchId ?? '__default__'}`
}

export interface AgentAPIRequest {
  message: MessageContent
  /**
   * Reference media (Phase 2 multimodal intake) the user attached to this
   * prompt. Pre-digested into an understanding brief before the first agent
   * turn. Distinct from inline image blocks in `message`.
   */
  referenceMedia?: import('@/lib/agents/types').ReferenceMedia[]
  /** Per-modality engine choice from Settings → Media Understanding (default auto). */
  mediaUnderstandingEngines?: Partial<Record<import('@/lib/agents/types').ReferenceMediaKind, string>>
  modelOverride?: ModelId | null
  modelTier?: ModelTier
  thinkingMode?: ThinkingMode
  sceneContext?: 'all' | 'selected' | 'auto' | string
  activeTools?: string[]
  history?: ChatMessage[]
  projectId?: string
  conversationId?: string
  scenes: Scene[]
  globalStyle: GlobalStyle
  projectName: string
  outputMode: 'mp4' | 'interactive'
  sceneGraph?: SceneGraph
  /** B1 (v6 TIMELINE): the project's real NLE timeline, sent by the renderer so
   *  the agent world is seeded with the user's actual clips (not a fabricated
   *  single-track world). Null/undefined when no timeline exists yet. */
  timeline?: import('@/lib/types').Timeline | null
  selectedSceneId?: string | null
  apiPermissions?: APIPermissions
  enabledModelIds?: string[]
  audioProviderEnabled?: Record<string, boolean>
  audioSettings?: import('@/lib/types/audio').AudioSettings | null
  mediaGenEnabled?: Record<string, boolean>
  webSearchEnabled?: boolean
  aiQualityReview?: boolean
  webFetchEnabled?: boolean
  autoAcceptWebSearch?: boolean
  researchProviderEnabled?: Record<string, boolean>
  /** Model the deep-research sub-agent runs on. null/undefined → inherit the
   *  run's model. A model id (e.g. a local Ollama Tongyi model) → research runs
   *  there for $0 tokens while the build stays on the frontier model. */
  researchModelId?: string | null
  ytDlpConsentedProjectIds?: string[]
  sessionPermissions?: Record<string, string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generationOverrides?: Record<string, { provider?: string; prompt?: string; config?: Record<string, any> }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoChooseDefaults?: Record<string, { provider: string; config: Record<string, any> }>
  initialScenePlan?: ScenePlan | null
  resumeToolCall?: { toolName: string; toolInput: Record<string, unknown> } | null
  userId?: string
  resumeCheckpoint?: boolean
  /** Cumulative spend already incurred before a PAUSE (permission / clarification),
   *  carried by the client from the pause's `done.ledgerSpentUsd`, so the resumed
   *  run seeds its cost ledger instead of getting a fresh $cap budget. Preferred
   *  over the checkpoint cost when present. */
  resumeSpentUsd?: number
  directorTemplate?: string
  planFirstMode?: boolean
  localMode?: boolean
  mockMode?: boolean
  modelConfigs?: import('@/lib/agents/model-config').ModelConfig[]
  mp4Settings?: import('@/lib/types').MP4Settings
  branchId?: string | null
  /** Suppress dispatch_to_branches fan-out (set on per-variant fan-out runs so a
   *  variant can't recursively fan out). */
  disableFanout?: boolean
  /** Renderer editor UI snapshot for `read_editor_state` tool. */
  editorState?: import('@/lib/agents/types').EditorStateSnapshot
  /** Cursor-style accept/reject for destructive tools. Default 'off'. */
  previewMode?: 'off' | 'destructive-only' | 'always'
  /** Demo run: paid asset generation → free-local / placeholder via resolveAsset. */
  sandboxMode?: boolean
  /** Run-level permission posture derived from agentRunMode (auto/ask/default). */
  permissionPosture?: import('@/lib/agents/types').PermissionPosture
  /**
   * Per-run cost ceiling (circuit breaker) in USD, from Settings → Agents.
   * - `undefined` → use the runner default ($25)
   * - a positive number → that cap
   * - `null` → Unlimited (no cost-based stop; tool-call/iteration caps still apply)
   */
  runBudgetUsd?: number | null
  /**
   * Standing opt-in to sub-agents (Settings → Agents "Use sub-agents").
   * - `undefined`/`false` → SINGLE-AGENT unless the message explicitly asks for
   *   sub-agents (the runner checks `userRequestedSubAgents`).
   * - `true` → this run may delegate its build.
   */
  subAgents?: boolean
}

/**
 * Resolve the Settings → Agents "Run budget" value into a runner `runConfig`
 * override. Returns `undefined` when the request omits a budget (runner keeps
 * its default cap); `{ maxRunCostUsd: Infinity }` for Unlimited; otherwise the
 * chosen cap. A non-positive number is treated as Unlimited so a misconfigured
 * 0 never traps every run at the first token.
 */
export function resolveRunBudgetConfig(runBudgetUsd: number | null | undefined): { maxRunCostUsd: number } | undefined {
  if (runBudgetUsd === undefined) return undefined
  if (runBudgetUsd === null || runBudgetUsd <= 0) return { maxRunCostUsd: Infinity }
  return { maxRunCostUsd: runBudgetUsd }
}

export interface RunAgentRequestOptions {
  body: AgentAPIRequest
  /** Server-authoritative userId. Null for guest mode. Never trust body.userId. */
  authenticatedUserId: string | null
  /** Cancels the runner when the transport's client disconnects. */
  abortSignal: AbortSignal
  /** Sink for all SSE events. HTTP enqueues; IPC forwards to webContents.send. */
  emit: (event: SSEEvent) => void
  /** Transport-supplied run id. When set, the logger adopts it so the runner's
   *  logger.runId equals the id the transport uses to key the run (activeControllers
   *  + the event channel) — required so mid-run steering targets the same run.
   *  Omitted on paths with no external run registry (the logger mints its own). */
  runId?: string
}

export type RejectConcurrentResult = { ok: true } | { ok: false; reason: 'IN_PROGRESS' }

/**
 * Pre-flight concurrency gate. Transport uses this to return 409 before opening
 * the stream. Per (projectId, branchId) — runs on different branches of the
 * same project are allowed in parallel (variants), runs on the same branch
 * are still serialized (avoids stomping on the same per-branch action_log).
 *
 * Callers that don't pass a branchId fall back to a single project-wide slot
 * (back-compat). A run reserved without branchId still blocks a subsequent
 * run reserved with one, since the keys differ; in practice all callers
 * either always pass or never pass.
 */
export function reserveRunSlot(
  projectId: string | undefined,
  branchId?: string | null,
  signal?: AbortSignal,
): RejectConcurrentResult {
  if (!projectId) return { ok: true }
  const key = runKey(projectId, branchId)
  const existing = activeRuns.get(key)
  if (existing && !isStaleRun(existing)) {
    return { ok: false, reason: 'IN_PROGRESS' }
  }
  activeRuns.set(key, { startedAt: Date.now(), signal })
  return { ok: true }
}

/** Release a slot reserved by `reserveRunSlot`. Safe to call even if unreserved. */
export function releaseRunSlot(projectId: string | undefined, branchId?: string | null): void {
  if (projectId) activeRuns.delete(runKey(projectId, branchId))
}

/**
 * Persist agent scenes through `persistScenesFromAgentRun` with the same bounded
 * retry/backoff the success path has always used. Shared by the success path and
 * the error/abort persist so both go through one place (and the
 * placeholder guard inside persistScenesFromAgentRun applies to both). Returns
 * true iff a persist attempt succeeded. Never throws.
 */
async function persistWithRetry(
  projectId: string,
  payload: {
    scenes: Scene[]
    sceneGraph: SceneGraph
    globalStyle: GlobalStyle
    zdogLibrary?: any[]
    zdogStudioLibrary?: any[]
    // B2 (v6 TIMELINE): the agent run's timeline, merged into the description
    // blob only when a timeline tool ran (undefined leaves the stored timeline
    // untouched). Threaded through so the error/abort persist carries it too.
    timeline?: import('@/lib/types').Timeline | null
  },
  branchId: string | null,
  logger: AgentLogger,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ok = await persistScenesFromAgentRun(projectId, payload, branchId)
      if (ok) return true
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)))
    } catch (e) {
      logger.error('api', `persistScenesFromAgentRun threw (attempt ${attempt + 1}): ${(e as Error).message}`)
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)))
    }
  }
  return false
}

export function cleanScenesForAgentPersistence<T extends { id?: string }>(
  updatedScenes: T[],
  originalScenes: T[],
): T[] {
  const originalIds = new Set(originalScenes.map((o) => (o as { id?: string }).id))
  // 1) Restore placeholder content to the pre-run version (or empty).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const restored = updatedScenes.map((s: any) => {
    const hasPlaceholder =
      isPlaceholderContent(s.svgContent) ||
      isPlaceholderContent(s.canvasCode) ||
      isPlaceholderContent(s.sceneCode) ||
      isPlaceholderContent(s.lottieSource) ||
      isPlaceholderContent(s.reactCode)
    if (!hasPlaceholder) return s

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orig = originalScenes.find((os: any) => os.id === s.id) as any
    return {
      ...s,
      svgContent: isPlaceholderContent(s.svgContent) ? (orig?.svgContent ?? '') : s.svgContent,
      canvasCode: isPlaceholderContent(s.canvasCode) ? (orig?.canvasCode ?? '') : s.canvasCode,
      sceneCode: isPlaceholderContent(s.sceneCode) ? (orig?.sceneCode ?? '') : s.sceneCode,
      lottieSource: isPlaceholderContent(s.lottieSource) ? (orig?.lottieSource ?? '') : s.lottieSource,
      reactCode: isPlaceholderContent(s.reactCode) ? (orig?.reactCode ?? '') : s.reactCode,
      sceneHTML: isPlaceholderContent(s.sceneHTML) ? (orig?.sceneHTML ?? '') : s.sceneHTML,
    }
  })
  // 2) #5: drop NEW codeless shells so a never-coded create_scene placeholder
  // is not persisted (it would serve a dreambyte:// 404 "Not found" on reload).
  // Mirrors the renderer's gate (src/lib/store/agent-actions.ts): only sweep when
  // the run produced at least one renderable scene — if the whole run is
  // non-code (e.g. a single audio-bed scene), keep everything, exactly as the
  // renderer does. Pre-existing scenes are NEVER dropped (only restored), and
  // isEmptyAgentShell is conservative (also counts audio/overlays/svgObjects),
  // so the dropped set is a strict SUBSET of the renderer's — persist can't drop
  // a scene the live timeline keeps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasContentScene = restored.some((s: any) => sceneHasRenderableContent(s as Scene))
  if (!hasContentScene) return restored
  return restored.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => originalIds.has(s.id) || !isEmptyAgentShell(s as Scene),
  )
}

/**
 * Seed the resumed cost ledger from a checkpoint's prior spend (#checkpoint-harden).
 * A resumed run must continue from what it already spent, NOT get a fresh $cap
 * budget (stop→resume would otherwise spend N× the ceiling). The recorded
 * `partialUsage.costUsd` can be:
 *   - a finite >= 0 number → use it (valid prior spend, including a genuine 0)
 *   - absent (undefined/null) → 0 (no recorded prior spend)
 *   - CORRUPT (NaN / Infinity / negative — DB truncation, poison) → FAIL SAFE to
 *     the cap when one exists, so a corrupt checkpoint can't reset spend to $0
 *     and re-grant a full budget (a cost-cap BYPASS). Unlimited cap → 0 (no
 *     ceiling to protect). The conservative resume immediately hits the cap,
 *     which surfaces to the user instead of silently overspending.
 * Exported for unit testing.
 */
export function resolveResumeSpentUsd(priorCostUsd: unknown, capUsd: number | null | undefined): number {
  if (typeof priorCostUsd === 'number' && Number.isFinite(priorCostUsd) && priorCostUsd >= 0) return priorCostUsd
  if (priorCostUsd === undefined || priorCostUsd === null) return 0
  // present but corrupt → fail safe to the cap (block further paid spend)
  return typeof capUsd === 'number' && Number.isFinite(capUsd) && capUsd > 0 ? capUsd : 0
}

/**
 * Main agent orchestration — runs the agent, streams events via `emit`, and
 * handles all post-run side effects (persistence, log update, memory extraction).
 * Returns when the `runAgent` promise resolves AND all post-run work has
 * completed (or failed and been logged). Never throws — errors become emitted
 * `error` events. Caller is responsible for releasing the run slot.
 */
export async function runAgentRequest({
  body,
  authenticatedUserId,
  abortSignal,
  emit,
  runId,
}: RunAgentRequestOptions): Promise<void> {
  // Extract text portion of message for logging (images are not logged)
  const messageText = messageContentToText(body.message)

  // Adopt the transport's run id when provided so steering (which targets the
  // run via the transport's id) and the runner's logger.runId are the SAME run.
  const logger = new AgentLogger(runId)
  const frustration = detectFrustration(messageText)

  logger.log('api', 'Request received', {
    agent: 'scene-maker',
    model: body.modelOverride ?? 'auto',
    sceneCount: body.scenes.length,
    messageLength: messageText.length,
    hasImages: typeof body.message !== 'string',
    ...(frustration.detected ? { frustration: frustration.level, frustrationTriggers: frustration.triggers } : {}),
  })

  // run_start first so the client can correlate subsequent events with this runId.
  emit({ type: 'run_start', runId: logger.runId })

  // Mock mode short-circuit — for offline UI testing without API credits.
  // Skips all DB writes, provider calls, scene persistence, and post-run
  // accounting; emits a scripted Cursor-style event sequence and returns.
  // The toggle lives in Settings → "Mock Agent (no API credits)".
  if (body.mockMode) {
    log.info('Running in mock mode (no LLM calls)', { extra: { runId: logger.runId } })
    await runMockAgentStream({
      message: messageText,
      selectedSceneId: body.selectedSceneId ?? null,
      emit,
      signal: abortSignal,
    })
    return
  }

  // Generation log before starting
  const genStartTime = Date.now()
  let generationLogId: string | null = null
  let thinkingContentBuffer = ''

  try {
    generationLogId = await createGenerationLog({
      projectId: body.projectId,
      userPrompt: messageText,
      systemPromptHash: crypto
        .createHash('sha256')
        .update(messageText + (body.globalStyle?.presetId ?? ''))
        .digest('hex')
        .slice(0, 16),
      stylePresetId: body.globalStyle?.presetId ?? undefined,
      agentType: 'scene-maker',
      modelUsed: body.modelOverride ?? undefined,
      thinkingMode: body.thinkingMode ?? 'adaptive',
    })
  } catch (e) {
    log.error('failed to create generation log', { error: e })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit({ type: 'warning', message: 'Usage tracking unavailable for this run.' } as any)
  }

  // Wrap emit to capture thinking content for the log
  const wrappedEmit = (event: SSEEvent) => {
    if (event.type === 'thinking_token' && event.token) {
      thinkingContentBuffer += event.token
    }
    emit(event)
  }

  // Fetch project assets + brand kit + workspace id in parallel. Memories are
  // loaded AFTER (they need the resolved workspaceId for the workspace layer in
  // getMemoriesScoped) — passing it in avoids a redundant project re-fetch.
  const [assetsResult, projectRowResult] = await Promise.all([
    body.projectId
      ? db
          .select()
          .from(projectAssetsTable)
          .where(eq(projectAssetsTable.projectId, body.projectId))
          .orderBy(desc(projectAssetsTable.createdAt))
          .catch((e) => {
            log.warn('failed to fetch project assets', { error: e })
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return [] as any[]
          })
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Promise.resolve([] as any[]),
    body.projectId
      ? db
          .select({
            brandKit: projectsTable.brandKit,
            workspaceId: projectsTable.workspaceId,
            projectBrief: projectsTable.projectBrief,
          })
          .from(projectsTable)
          .where(eq(projectsTable.id, body.projectId))
          .limit(1)
          .catch((e) => {
            log.warn('failed to fetch project row', { error: e })
            return [] as Array<{ brandKit: unknown; workspaceId: string | null; projectBrief: unknown }>
          })
      : Promise.resolve([] as Array<{ brandKit: unknown; workspaceId: string | null; projectBrief: unknown }>),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchedAssets: any[] = assetsResult
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchedBrandKit = (projectRowResult[0]?.brandKit as any) ?? null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchedProjectBrief = ((projectRowResult[0] as any)?.projectBrief as any) ?? null
  const runWorkspaceId: string | null = projectRowResult[0]?.workspaceId ?? null

  // Debug trace (DREAMBYTE_TRACE=1): mark the start of this run so the whole
  // tool/scene lifecycle below correlates under one run id.
  traceSetRun(`${body.projectId ?? 'noproj'}-${Date.now()}`)
  trace('run.start', {
    projectId: body.projectId,
    model: body.modelOverride ?? `tier:${body.modelTier ?? 'auto'}`,
    promptLen: typeof body.message === 'string' ? body.message.length : undefined,
    scenes: body.scenes?.length ?? 0,
    hadBrief: !!fetchedProjectBrief,
  })

  // Scoped memory retrieval: project-memory > workspace.brandKit >
  // user-global, narrowest-wins. projectId scopes the rows; runWorkspaceId
  // (already fetched) supplies the workspace layer without a second query.
  const memoriesResult = authenticatedUserId
    ? await getMemoriesScoped(authenticatedUserId, body.projectId ?? null, {
        maxItems: 20,
        workspaceId: runWorkspaceId,
      }).catch((e) => {
        log.warn('failed to fetch user memories', { error: e })
        return [] as Awaited<ReturnType<typeof getMemoriesScoped>>
      })
    : []
  const userMemories = memoriesResult.map((r) => ({
    category: r.category,
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    // Which precedence layer this won from — used to target confidence
    // adjustments at the correct scope (project row vs user-global row).
    // The synthetic 'workspace' layer is derived from workspaces.brandKit and
    // has no user_memory row, so it is never a confidence-adjust target.
    layer: r.layer,
  }))
  if (userMemories.length > 0) {
    logger.log('api', `Loaded ${userMemories.length} scoped memories`, {
      userId: authenticatedUserId,
      projectId: body.projectId ?? null,
    })
  }

  // Permission rule fetch depends on the workspace id resolved above.
  let permissionRules: import('@/lib/types/permissions').PermissionRule[] = []
  if (authenticatedUserId) {
    try {
      const { findMatchingRules } = await import('@/lib/db/queries/permission-rules')
      permissionRules = await findMatchingRules({
        userId: authenticatedUserId,
        workspaceId: runWorkspaceId,
        projectId: body.projectId ?? null,
        conversationId: body.conversationId ?? null,
      })
      if (permissionRules.length > 0) {
        logger.log('api', `Loaded ${permissionRules.length} permission rules`, { userId: authenticatedUserId })
      }
    } catch (e) {
      log.warn('failed to fetch permission rules', { error: e })
    }
  }

  // Checkpoint resume — override message, scenes, and scenePlan from saved state
  let resumedCheckpoint: import('@/lib/agents/types').RunCheckpoint | null = null
  if (body.resumeCheckpoint && body.projectId) {
    try {
      resumedCheckpoint = await getRunCheckpoint(body.projectId, body.branchId ?? null)
      if (resumedCheckpoint) {
        const built = resumedCheckpoint.completedSceneIds.length
        const total = resumedCheckpoint.scenePlan?.scenes.length ?? 0
        const remaining = total - built
        logger.log('api', `Resuming checkpoint: ${built}/${total} scenes complete, ${remaining} remaining`, {
          runId: resumedCheckpoint.runId,
          reason: resumedCheckpoint.reason,
        })
        // Resume is a DEGRADED continuation, not a seamless one, and until now it
        // said so nowhere: the checkpoint carries no reference media and no
        // rendered frames, and the conversation comes back as a bounded text
        // digest rather than the provider-native message array. Say it out loud —
        // a user who watches the agent "continue" needs to know why it can no
        // longer see the reference image they attached. (Silent loss was the bug.)
        const lost = ['the full message history (a text digest is restored instead)']
        if (!resumedCheckpoint.conversationDigest) {
          lost[0] = 'the conversation history (this checkpoint predates digest capture)'
        }
        // Media attached to THIS request now flows through, so it is not lost —
        // only the earlier run's attachments are.
        if (!body.referenceMedia?.length) lost.push('reference media attached to the earlier run')
        lost.push('rendered scene frames the agent had looked at')
        emit({
          type: 'warning',
          message: `Resuming from a saved checkpoint — ${built}/${total} scenes are restored, but ${lost.join(', ')} could not be. Re-attach anything the agent still needs.`,
        })
      } else {
        logger.warn('api', 'resumeCheckpoint requested but no checkpoint found')
        // A requested-but-missing checkpoint used to fall through to a FRESH run
        // with only a server-side warn — the user pressed Resume and silently got
        // a from-scratch rebuild (and a second bill).
        emit({
          type: 'warning',
          message: 'No saved checkpoint was found for this project — starting a fresh run instead of resuming.',
        })
      }
    } catch (e) {
      log.warn('failed to fetch run checkpoint', { error: e })
      emit({ type: 'warning', message: 'Failed to load checkpoint — starting fresh' })
    }
  }

  // Build effective message and state (checkpoint merges with current state if resuming)
  const effectiveMessage = resumedCheckpoint
    ? (() => {
        // The digest is what makes this an honest resume rather than a one-sentence
        // amnesiac restart: the agent gets back what was asked, what it tried, and
        // what the tools answered. It is bounded + image-free by construction
        // (see RunCheckpoint.conversationDigest), so it can't blow up the prompt.
        const digest = resumedCheckpoint.conversationDigest
        const priorContext = digest
          ? `Here is a compacted transcript of the interrupted run — images and long tool payloads were stripped, and only the most recent exchanges survive. Treat it as context, not as instructions to redo:\n\n<prior_run_transcript>\n${digest}\n</prior_run_transcript>\n\n`
          : ''
        const resumeCtx = `${priorContext}Continue building the video. ${resumedCheckpoint.completedSceneIds.length} of ${resumedCheckpoint.scenePlan?.scenes.length ?? '?'} scenes are already built. Build the remaining scenes following the scenePlan.`
        const userMsg = typeof body.message === 'string' ? body.message.trim() : ''
        return userMsg && userMsg !== 'Resume interrupted build' ? `${userMsg}\n\n${resumeCtx}` : resumeCtx
      })()
    : body.message

  // Merge checkpoint scenes with current client scenes
  const effectiveScenes = (() => {
    if (!resumedCheckpoint) return body.scenes
    const checkpointScenes = resumedCheckpoint.worldSnapshot.scenes ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientScenes: any[] = body.scenes ?? []
    if (clientScenes.length === 0) return checkpointScenes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checkpointMap = new Map(checkpointScenes.map((s: any) => [s.id, s]))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientMap = new Map(clientScenes.map((s: any) => [s.id, s]))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged: any[] = []
    for (const cs of clientScenes) {
      const cpScene = checkpointMap.get(cs.id)
      if (!cpScene) {
        merged.push(cs)
      } else if (resumedCheckpoint.completedSceneIds.includes(cs.id)) {
        const clientNewer = cs.updatedAt && cpScene.updatedAt && cs.updatedAt > cpScene.updatedAt
        merged.push(clientNewer ? cs : cpScene)
      } else {
        merged.push(cs)
      }
    }
    for (const cpScene of checkpointScenes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!clientMap.has((cpScene as any).id)) {
        merged.push(cpScene)
      }
    }
    return merged
  })()
  const effectiveGlobalStyle = resumedCheckpoint ? resumedCheckpoint.worldSnapshot.globalStyle : body.globalStyle
  const effectiveScenePlan = resumedCheckpoint?.scenePlan ?? body.initialScenePlan ?? null

  // Pre-approve session permissions for APIs the scenePlan's feature flags will need.
  if (effectiveScenePlan?.featureFlags) {
    const sp = body.sessionPermissions ?? {}
    const flags = effectiveScenePlan.featureFlags
    if (flags.narration && !sp['elevenLabs']) sp['elevenLabs'] = 'allow'
    if (flags.music && !sp['elevenLabs']) sp['elevenLabs'] = 'allow'
    body.sessionPermissions = sp
  }

  if (body.localMode) {
    const localModelCount = body.modelConfigs?.length ?? 0
    logger.log('api', `Local mode enabled: modelOverride=${body.modelOverride}, ${localModelCount} local model configs`)
  }

  // OKF Layer 0: lazily extract the project brief once — on the first run that
  // has no brief yet (Mace's whiteboard / log-line phase). Best-effort: wrapped
  // so a missing API key or a parse failure never blocks or breaks the run. In
  // Phase A the brief is purely advisory — it's injected as context, nothing
  // routes off it.
  let effectiveProjectBrief = fetchedProjectBrief
  const briefPrompt = typeof effectiveMessage === 'string' ? effectiveMessage : ''
  if (!effectiveProjectBrief && body.projectId && briefPrompt.trim()) {
    try {
      const { hasAnyTextProviderKey } = await import('../generation/generate')
      // Skip cleanly when no text provider is configured at all (don't throw a
      // confusing 401 deep in extraction). Provider-agnostic: extraction uses
      // the run's own provider (DeepSeek/Kimi/Qwen/Anthropic/local).
      if (hasAnyTextProviderKey()) {
        const { extractProjectBrief, extractBriefWithRetry } = await import('../agents/extract-project-brief')
        const { setProjectBrief } = await import('../db/queries/projects')
        const { resolveModel, keyedProvidersFromEnv } = await import('../agents/context-builder')
        // Resolve the SAME model the run will use, so extraction bills the run's
        // own provider. Critically this covers the tier path (modelOverride null),
        // where the run resolves cost-first — extraction must follow, not fall to
        // Anthropic-first as resolveTextModel(undefined) would.
        const runModel =
          body.modelOverride ??
          resolveModel(
            'scene-maker',
            body.modelTier ?? 'auto',
            null,
            body.enabledModelIds,
            body.modelConfigs,
            keyedProvidersFromEnv(),
          )
        // Best-effort + time-boxed WITH ONE RETRY (#1): a transient timeout or
        // parse blip must not silently strip ALL OKF film craft from the run
        // (the craft gate is null-brief → skip). Each failed attempt is logged.
        const brief = await extractBriefWithRetry(
          () =>
            extractProjectBrief({
              prompt: briefPrompt,
              aspectRatio: body.mp4Settings?.aspectRatio ?? '16:9',
              model: runModel,
              modelConfigs: body.modelConfigs,
              projectId: body.projectId,
            }),
          {
            timeoutMs: 25_000,
            attempts: 2,
            // Bound the TOTAL added latency to ~25s (the original single-attempt
            // budget) — the retry only fits when attempt 1 fails fast (#1).
            deadlineMs: 25_000,
            onAttemptFail: (err, n) =>
              logger.warn('api', `Project brief extraction attempt ${n} failed`, {
                error: err instanceof Error ? err.message : String(err),
              }),
          },
        )
        if (brief) {
          // Set in-memory BEFORE persist so this run still uses the brief even if
          // the DB write loses a race (multi-worktree lock).
          effectiveProjectBrief = brief
          await setProjectBrief(body.projectId, brief)
          logger.log('api', 'Extracted project brief', { videoType: brief.videoType, confidence: brief.confidence })
          trace('brief', {
            ok: true,
            videoType: brief.videoType,
            lengthClass: brief.lengthClass,
            confidence: brief.confidence,
          })
        }
      }
    } catch (e) {
      log.warn('project brief extraction skipped', { error: e })
      // The OKF craft injection is gated on a non-null projectBrief — if
      // extraction throws/times-out, the run silently loses ALL film craft.
      trace('brief', { ok: false, err: e instanceof Error ? e.message : String(e) })
    }
  } else if (effectiveProjectBrief) {
    trace('brief', { ok: true, cached: true, videoType: effectiveProjectBrief.videoType })
  } else {
    trace('brief', { ok: false, reason: 'no-projectId-or-empty-prompt-or-no-text-key' })
  }

  // Loud signal: the OKF craft injection is gated on a non-null brief, so
  // building with `projectBrief === null` silently strips ALL film craft. That
  // silent path is a common "agent goes blind" regression — make it diagnosable
  // instead of invisible.
  if (!effectiveProjectBrief && body.projectId && briefPrompt.trim()) {
    logger.warn(
      'api',
      'Building WITHOUT a project brief — OKF film craft will NOT be injected this run (no provider key, or extraction failed twice)',
      { projectId: body.projectId },
    )
  }

  // Run agent — await it so the caller's release/teardown happens after all
  // post-run work completes.
  try {
    const result = await runAgent({
      message: effectiveMessage,
      // NOT `resumedCheckpoint ? undefined : …` — body.referenceMedia is what the
      // user attached to THIS request. Dropping it on resume made the warning below
      // ("Re-attach anything the agent still needs") an unescapable loop: re-attach,
      // press Resume, discarded again.
      referenceMedia: body.referenceMedia,
      mediaUnderstandingEngines: body.mediaUnderstandingEngines,
      modelOverride: body.modelOverride,
      modelTier: body.modelTier,
      thinkingMode: body.thinkingMode ?? 'adaptive',
      sceneContext: body.sceneContext,
      activeTools: body.activeTools,
      history: resumedCheckpoint ? [] : body.history,
      projectId: body.projectId,
      branchId: body.branchId ?? null,
      disableFanout: body.disableFanout,
      scenes: effectiveScenes,
      globalStyle: effectiveGlobalStyle ?? {
        palette: ['#181818', '#121212', '#e84545', '#151515', '#f0ece0'],
        strokeWidth: 2,
        font: 'Caveat',
        duration: 8,
        theme: 'dark',
      },
      projectName: body.projectName ?? 'Untitled Project',
      outputMode: body.outputMode ?? 'mp4',
      sceneGraph: body.sceneGraph,
      // Hand the project timeline to the runner's world seed (parity with
      // the MCP path, which seeds world.timeline from the description blob).
      timeline: body.timeline ?? null,
      selectedSceneId: body.selectedSceneId,
      apiPermissions: body.apiPermissions,
      enabledModelIds: body.enabledModelIds,
      audioProviderEnabled: body.audioProviderEnabled,
      audioSettings: body.audioSettings,
      mediaGenEnabled: body.mediaGenEnabled,
      webSearchEnabled: body.webSearchEnabled,
      aiQualityReview: body.aiQualityReview,
      webFetchEnabled: body.webFetchEnabled,
      autoAcceptWebSearch: body.autoAcceptWebSearch,
      researchProviderEnabled: body.researchProviderEnabled,
      researchModelId: body.researchModelId,
      ytDlpConsentedProjectIds: body.ytDlpConsentedProjectIds,
      sessionPermissions: body.sessionPermissions,
      permissionRules,
      workspaceId: runWorkspaceId,
      conversationId: body.conversationId ?? null,
      generationOverrides: body.generationOverrides,
      autoChooseDefaults: body.autoChooseDefaults,
      projectAssets: fetchedAssets,
      initialScenePlan: effectiveScenePlan,
      resumeToolCall: body.resumeToolCall ?? null,
      // Seed the cost ledger with spend already incurred before the
      // checkpoint, so a resumed cap stop continues from its prior total
      // instead of getting a fresh $cap budget (stop→resume would otherwise
      // spend N× the ceiling). A corrupt recorded cost fails SAFE to the cap
      // (block) rather than $0 (bypass) — see resolveResumeSpentUsd.
      // PREFER body.resumeSpentUsd: a permission/clarification PAUSE resume carries
      // it explicitly (those resume via resumeToolCall, NOT a checkpoint, so the
      // checkpoint cost is null and the ledger would otherwise restart at $0 every
      // pause — the carry-across-pause fix). Falls back to the checkpoint cost.
      resumeSpentUsd: resolveResumeSpentUsd(
        body.resumeSpentUsd ?? resumedCheckpoint?.partialUsage?.costUsd,
        resolveRunBudgetConfig(body.runBudgetUsd)?.maxRunCostUsd,
      ),
      abortSignal,
      logger,
      emit: wrappedEmit,
      userMemories: userMemories.length > 0 ? userMemories : undefined,
      userId: authenticatedUserId ?? undefined,
      modelConfigs: body.modelConfigs,
      planFirstMode: body.planFirstMode,
      directorTemplate: body.directorTemplate,
      mp4Settings: body.mp4Settings,
      brandKit: fetchedBrandKit,
      projectBrief: effectiveProjectBrief,
      editorState: body.editorState,
      previewMode: body.previewMode,
      sandboxMode: body.sandboxMode,
      permissionPosture: body.permissionPosture,
      // Per-run cost circuit breaker from Settings → Agents. null = Unlimited.
      // `subAgents` is folded in only when the request sets it explicitly, so an
      // omitted flag falls through to DEFAULT_RUN_CONFIG (single-agent).
      runConfig: {
        ...resolveRunBudgetConfig(body.runBudgetUsd),
        ...(body.subAgents !== undefined ? { subAgents: body.subAgents } : {}),
      },
    })

    logger.log('api', 'Runner complete', {
      agentType: result.agentType,
      modelId: result.modelId,
      toolCalls: result.toolCalls.length,
      durationMs: result.usage.totalDurationMs,
    })

    // Persist scenes first so the client can refetch after transport drops.
    // Restore real content when lightScenes placeholders survived into the result.
    const cleanScenesForPersistence = cleanScenesForAgentPersistence(result.updatedScenes, body.scenes)

    // The checkpoint-clear below must never run when scene persistence
    // failed all retries — the checkpoint may hold the last durable copy.
    let scenePersistOk = true
    if (body.projectId) {
      // Merge resolution (DURABILITY persistWithRetry + TIMELINE timeline payload):
      // the retry loop is DURABILITY's extracted helper; B2's timeline rides its
      // payload so a timeline-tool run persists the NLE timeline on the success
      // path (and, via the same helper, the error/abort path below).
      const persistOk = await persistWithRetry(
        body.projectId,
        {
          scenes: cleanScenesForPersistence,
          sceneGraph: result.updatedSceneGraph,
          globalStyle: result.updatedGlobalStyle,
          zdogLibrary: result.updatedZdogLibrary,
          zdogStudioLibrary: result.updatedZdogStudioLibrary,
          // B2 (v6 TIMELINE): persist the timeline into the description blob
          // (same place the renderer reads it) — only when a timeline tool ran
          // (undefined otherwise leaves the stored timeline untouched).
          timeline: result.updatedTimeline,
        },
        typeof body.branchId === 'string' ? body.branchId : null,
        logger,
      )
      if (!persistOk) {
        scenePersistOk = false
        logger.error('api', 'persistScenesFromAgentRun failed after 3 attempts — agent work may not be persisted to DB')
        emit({
          type: 'warning',
          message: 'Your changes were applied but could not be saved to the database. Please save manually.',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
      } else {
        logger.log('api', 'Agent run persisted to DB successfully')
      }
      // Signal the renderer that the durable write is done so its post-run
      // refresh waits for THIS instead of racing it. Out-of-band-forwarded by
      // the IPC layer, keyed by runId, so it survives a transport reject (abort).
      emit({ type: 'persist_done', runId: logger.runId, persistOk: scenePersistOk })
    }

    // Sandbox review: dump every captured generation request (the enriched
    // prompt/params each media tool WOULD have sent) to a per-run folder so the
    // generation-prompt quality can be reviewed. No paid provider ran — this is the
    // only place the assembled requests are reviewable. Best-effort, never fatal.
    if (body.sandboxMode) {
      const { writeSandboxReview } = await import('../agents/sandbox-capture')
      const { count, dir } = await writeSandboxReview(logger.runId, result.toolCalls)
      if (count > 0) {
        emit({ type: 'token', token: `\n\n🧪 Sandbox: captured ${count} generation prompt(s) for review → ${dir}` })
      }
    }

    // ── Checkpoint lifecycle ───────────────────────────────────────
    //
    //                  runAgent returns {…, stopReason}
    //                             │
    //         ┌───────────────────┼──────────────────────────┐
    //    'completed'         cap/round/abort/stuck         'error'
    //         │                   │                            │
    //  persist scenes OK?    checkpoint already            error checkpoint
    //    yes → CLEAR slot    persisted in-loop             already persisted
    //    no  → KEEP          → KEEP (never clear)          → KEEP
    //         │
    //  ANY successful completion clears the (projectId, branchId)
    //  slot — resumed or not. Completion supersedes; no stale snapshot
    //  outlives a finished build. (Stale-resume clobber is designed out.)
    //
    // This previously cleared whenever `resumedCheckpoint && body.projectId` —
    // i.e. a resumed run that stopped at a cap/abort DELETED the very
    // checkpoint it needed to resume again, while a fresh run's completion
    // left a stale snapshot around to clobber newer work on a later resume.
    if (body.projectId && result.stopReason === 'completed' && scenePersistOk) {
      try {
        await clearRunCheckpoint(body.projectId, body.branchId ?? null)
        logger.log(
          'api',
          resumedCheckpoint
            ? 'Cleared run checkpoint after successful resume'
            : 'Cleared run checkpoint slot after successful completion (completion supersedes)',
        )
      } catch (e) {
        log.warn('failed to clear run checkpoint', { error: e })
      }
    } else if (body.projectId && resumedCheckpoint) {
      logger.log(
        'api',
        `Run checkpoint retained (stopReason=${result.stopReason}, scenePersistOk=${scenePersistOk}) — resume stays available`,
      )
    }

    // Extract and persist user memories (fire-and-forget-ish — logged, not propagated)
    if (authenticatedUserId && result.toolCalls.length > 0) {
      try {
        const memories = extractMemories(result.agentType, result.toolCalls, result.updatedGlobalStyle)
        // Semantic pass — what the user SAID, not just what tools ran
        // (brand colors, audience, do/don't instructions). Additive: a
        // heuristic memory with the same key wins (direct observation beats
        // inference), and every failure path inside returns [] so this can
        // never break the post-run block. Existing memories ride along so
        // the model UPDATES keys instead of minting near-duplicates.
        const heuristicKeys = new Set(memories.map((m) => `${m.category}:${m.key}`))
        const semantic = (
          await extractSemanticMemories({
            userMessage: messageText,
            toolCalls: result.toolCalls,
            existingMemories: userMemories.map((m) => ({ key: m.key, value: m.value })),
          })
        ).filter((m) => !heuristicKeys.has(`${m.category}:${m.key}`))
        const all = [...memories, ...semantic]
        for (const mem of all) {
          await upsertMemory(authenticatedUserId, mem.category, mem.key, mem.value, mem.confidence, logger.runId)
        }
        if (all.length > 0) {
          logger.log('api', `Extracted ${all.length} memories (${semantic.length} semantic)`, {
            memories: all.map((m) => m.key),
          })
        }
      } catch (e) {
        log.warn('failed to extract/persist memories', { error: e })
      }

      // ── Taste confidence pipeline ─────────────────────────────
      // Route the three no-UI signals (regenerate / keep+export / inferred-
      // from-next-message) into PER-KEY confidence deltas. Applied to the
      // memory KEY each signal names, never blanket-by-run, so a re-roll of one
      // output never moves an unrelated memory. Best-effort — never blocks.
      try {
        const inferred = await inferMemoryAdjustments({
          userMessage: messageText,
          existingMemories: userMemories.map((m) => ({ category: m.category, key: m.key, value: m.value })),
        })
        const adjustments = computeConfidenceAdjustments({
          toolCalls: result.toolCalls,
          activeMemories: userMemories.map((m) => ({ category: m.category, key: m.key })),
          inferred,
        })
        if (adjustments.length > 0) {
          // Target the scope the active memory actually lives at: a 'project'
          // layer memory adjusts its project row; everything else (user layer;
          // inferred keys default) adjusts the user-global row. The 'workspace'
          // layer has no row, so adjustments for those keys hit the user-global
          // slot if one exists, else no-op (honest, logged below).
          const layerByKey = new Map(userMemories.map((m) => [`${m.category}:${m.key}`, m.layer]))
          let moved = 0
          for (const adj of adjustments) {
            const layer = layerByKey.get(`${adj.category}:${adj.key}`)
            const scopeProjectId = layer === 'project' ? (body.projectId ?? null) : null
            moved += await adjustMemoryKeyConfidence(
              authenticatedUserId,
              adj.category,
              adj.key,
              adj.delta,
              scopeProjectId,
            )
          }
          logger.log('api', `Applied ${moved}/${adjustments.length} per-key confidence adjustments`, {
            keys: adjustments.map((a) => `${a.key}${a.delta >= 0 ? '+' : ''}${a.delta}(${a.reason})`),
          })
        }
      } catch (e) {
        log.warn('failed to apply confidence adjustments', { error: e })
      }
    }

    // Compute run analytics metrics
    const scenesCreated = result.toolCalls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tc: any) => tc.toolName === 'create_scene' && tc.output?.success !== false,
    ).length
    const scenesVerified = result.toolCalls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tc: any) => tc.toolName === 'verify_scene' && tc.output?.success !== false,
    ).length
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const planCall = result.toolCalls.find((tc: any) => tc.toolName === 'plan_scenes' && tc.output?.success !== false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scenesPlanned = (planCall?.input as any)?.scenes?.length ?? 0

    const runMetrics = computeRunMetrics({
      toolCalls: result.toolCalls,
      usage: result.usage,
      durationMs: Date.now() - genStartTime,
      // Real top-level loop counters from the runner — NOT toolCalls.length, which
      // over-counts by every sub-agent's inner tool call on director/fan-out runs
      // and fired a bogus "hit iteration limit" warning on any multi-scene build.
      iterationsUsed: result.iterationsUsed,
      iterationsMax: result.iterationsMax,
      scenesPlanned,
      scenesCreated,
      scenesVerified,
      userMessage: messageText,
      wasAborted: false,
      wasPermissionBlocked: false,
    })
    // Attribute the run's telemetry to its provider (was defaulting to 'unknown').
    logRunAnalytics(logger, runMetrics, getModelProvider(result.modelId, body.modelConfigs))

    // Update generation log with results + trace + analytics
    if (generationLogId) {
      try {
        await updateGenerationLog(generationLogId, {
          agentType: result.agentType,
          modelUsed: result.modelId,
          generationTimeMs: Date.now() - genStartTime,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          thinkingContent: thinkingContentBuffer.slice(0, 2000),
          generatedCodeLength: result.fullText.length,
          runId: logger.runId,
          runTrace: result.logger.getTrace(),
          analysisNotes: serializeRunMetrics(runMetrics),
        })
      } catch (e) {
        log.error('failed to update generation log', { error: e })
      }
    }

    // Final state_change event. 'done' is already emitted inside runAgent.
    logger.log(
      'api',
      `Sending state_change: ${cleanScenesForPersistence.length} scenes, hasGlobalStyle=${!!result.updatedGlobalStyle}`,
    )
    for (const s of cleanScenesForPersistence) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sc = s as any
      logger.log(
        'api',
        `  scene ${sc.id?.slice(0, 8)}… type=${sc.sceneType} react=${sc.reactCode?.length ?? 0} html=${sc.sceneHTML?.length ?? 0}`,
      )
    }
    emit({
      type: 'state_change',
      changes: [
        {
          type: 'global_updated',
          description: '__final_state__',
        },
      ],
      updatedScenes: cleanScenesForPersistence,
      updatedGlobalStyle: result.updatedGlobalStyle,
      updatedSceneGraph: result.updatedSceneGraph,
      // Carry add_watermark's config to the renderer. Only present
      // when the tool ran this run (undefined otherwise), so the consumer
      // (use-agent-run.ts → store.setWatermark) never clobbers an existing
      // project watermark.
      updatedWatermark: result.updatedWatermark,
      // B2 (v6 TIMELINE): carry the run's timeline to the renderer. Present only
      // when a timeline tool ran (undefined otherwise), so the consumer
      // (use-agent-run.ts → applyAgentTimeline) never clobbers an existing
      // project timeline on a scene-only run.
      updatedTimeline: result.updatedTimeline,
      generationLogId: generationLogId ?? undefined,
      recordingCommand: result.recordingCommand,
      recordingCommandNonce: result.recordingCommandNonce,
      recordingConfig: result.recordingConfig,
      recordingAttachSceneId: result.recordingAttachSceneId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error('api', `Runner error: ${error?.message ?? 'Unknown error'}`, { stack: error?.stack })
    if (!error?._agentHandled) {
      emit({ type: 'error', error: `Agent error: ${error?.message ?? 'Unknown error'}` })
    }

    // The run threw, but the tools may have built real scenes before the
    // failure. runAgent attaches the live world to the rejection (`_worldScenes`
    // + `_world`); persist them through the SAME retry path the success path uses
    // — including the placeholder guard — so an error/abort no longer
    // silently drops the work. Best-effort: if the world never materialized
    // (failure before setup), there's nothing to persist.
    const worldScenes = error?._worldScenes as Scene[] | undefined
    let errorPersistOk = false
    if (body.projectId && Array.isArray(worldScenes) && worldScenes.length > 0) {
      const cleaned = cleanScenesForAgentPersistence(worldScenes, body.scenes)
      const errWorld = error?._world ?? {}
      errorPersistOk = await persistWithRetry(
        body.projectId,
        {
          scenes: cleaned,
          sceneGraph: errWorld.sceneGraph ?? { nodes: [], edges: [] },
          globalStyle: errWorld.globalStyle ?? body.globalStyle,
          // v6 merge (TIMELINE×DURABILITY): the gated timeline rides the error
          // path too (undefined unless a timeline tool ran — same contract as
          // the success path), so timeline edits survive an error/abort.
          timeline: errWorld.timeline,
        },
        typeof body.branchId === 'string' ? body.branchId : null,
        logger,
      )
      logger.log(
        'api',
        errorPersistOk
          ? `Error-path persist saved ${cleaned.length} world scenes`
          : 'Error-path persist failed after retries — checkpoint still holds the durable copy',
      )
    }
    // On the error/abort path too, tell the renderer the durable write is
    // done (or that there was nothing to write) so its refresh stops waiting and
    // refreshes from a settled DB rather than racing main's persist. Always emit
    // when there's a project so the renderer's wait always resolves on the fast
    // path; if no persist ran, persistOk:false routes the renderer to its
    // version-poll fallback (which simply refreshes once the version settles).
    if (body.projectId) {
      emit({ type: 'persist_done', runId: logger.runId, persistOk: errorPersistOk })
    }

    if (generationLogId) {
      try {
        await updateGenerationLog(generationLogId, {
          generationTimeMs: Date.now() - genStartTime,
          thinkingContent: thinkingContentBuffer.slice(0, 2000) || undefined,
          analysisNotes: `Error: ${error?.message ?? 'Unknown error'}`,
          runId: logger.runId,
          runTrace: logger.getTrace(),
        })
      } catch (e) {
        log.error('failed to update generation log on error', { error: e })
      }
    }
  }

  logger.log('api', 'Run complete')
}
