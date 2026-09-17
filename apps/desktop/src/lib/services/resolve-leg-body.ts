/**
 * Cross-project isolation boundary (Phase C — isolation CORE).
 *
 * One function, routed on EVERY agent run at the transport entry point
 * (src/electron/ipc/agent.ts) BEFORE reserveRunSlot + mergeServerScenes:
 *
 *   resolveLegBody(body, targetProjectId, originProjectId, loadTargetRow)
 *
 *   target == origin  → IDENTITY: returns `body` (same reference), byte-identical
 *                       to single-project behavior, no DB read. This is the only
 *                       path that runs in production today (no cross-project
 *                       producer yet), so the function is exercised every run and
 *                       cannot rot the way the reverted inert "foundation" did.
 *   target != origin  → ISOLATION: build a FRESH leg body from the TARGET
 *                       project's own row + a small explicit allowlist of
 *                       user/machine-global fields. Everything else is absent by
 *                       construction (fail-closed). Unreadable target row →
 *                       throw CrossProjectLegAbort (never fall back to `body`).
 *
 * WHY an allowlist and not a drop-list: a drop-list defaults any missed or future
 * field to pass-through = leak. A drop-list review once missed ~12
 * fields (including `branchId`, which corrupts data). With an allowlist, a field
 * leaks only if someone explicitly classifies it as safe — and the compile-time
 * FIELD_CLASS record below forces every `AgentAPIRequest` key (incl. future ones)
 * to be classified or the build fails.
 *
 *     ┌─ LOAD_FROM_TARGET  read from B's project row (B's real settings/content)
 *     ├─ USER_GLOBAL       machine/user-scoped — same user runs B, copy from body
 *     ├─ PRODUCER_SUPPLIED set per-leg by the C.2 producer (carried via body)
 *     └─ DROP              A's session/active-project state — never written to leg
 *
 * See docs/plans/CROSS-PROJECT-ISOLATION.md for the locked design + rationale.
 */

import type { APIPermissions, GlobalStyle, MP4Settings, Scene, SceneGraph } from '@/lib/types'
import type { AgentAPIRequest } from './agent-runner'

/** Thrown when a cross-project leg's target row cannot be read. Caller aborts the
 *  leg — it must NOT run under the origin project's settings. */
export class CrossProjectLegAbort extends Error {
  readonly targetProjectId: string
  constructor(targetProjectId: string, cause?: unknown) {
    super(`Cross-project leg aborted: target project ${targetProjectId} unreadable`)
    this.name = 'CrossProjectLegAbort'
    this.targetProjectId = targetProjectId
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

export type FieldClass = 'load-from-target' | 'user-global' | 'producer-supplied' | 'drop'

/**
 * Exhaustive classification of every AgentAPIRequest field. `Record<keyof
 * AgentAPIRequest, FieldClass>` makes this a COMPILE-TIME gate: add a field to
 * AgentAPIRequest and this object fails to typecheck until the new field is
 * classified — so a new field can never silently default to leak.
 */
export const FIELD_CLASS: Record<keyof AgentAPIRequest, FieldClass> = {
  // ── LOAD_FROM_TARGET — B's own settings + content (from B's project row) ──
  projectId: 'load-from-target', // repoint to target
  scenes: 'load-from-target', // B's branch-scoped scenes (orchestration bypasses mergeServerScenes)
  globalStyle: 'load-from-target',
  projectName: 'load-from-target',
  outputMode: 'load-from-target',
  sceneGraph: 'load-from-target',
  timeline: 'load-from-target', // B's own NLE timeline — A's clips/tracks corrupt B (v6 TIMELINE)
  mp4Settings: 'load-from-target', // not cosmetic: A's aspect ratio → wrong HTML for B
  apiPermissions: 'load-from-target',
  audioProviderEnabled: 'load-from-target',
  audioSettings: 'load-from-target', // B's own default TTS provider / local URLs
  mediaGenEnabled: 'load-from-target',
  branchId: 'load-from-target', // → B's default branch; A's branchId corrupts B scoping

  // ── USER_GLOBAL — machine/user-scoped; same user runs B, safe to carry ──
  enabledModelIds: 'user-global',
  modelConfigs: 'user-global', // user's keys; B's apiPermissions still gates use
  ytDlpConsentedProjectIds: 'user-global', // keyed by projectId → self-filters to B
  mediaUnderstandingEngines: 'user-global',
  modelOverride: 'user-global',
  modelTier: 'user-global',
  researchModelId: 'user-global', // machine/user-scoped research-model preference; same user runs B
  thinkingMode: 'user-global',
  activeTools: 'user-global',
  directorTemplate: 'user-global',
  planFirstMode: 'user-global',
  localMode: 'user-global',
  mockMode: 'user-global',
  previewMode: 'user-global',
  sandboxMode: 'user-global',
  permissionPosture: 'user-global',
  disableFanout: 'user-global',
  subAgents: 'user-global', // "Use sub-agents" preference (Settings → Agents); same user runs B
  runBudgetUsd: 'user-global', // C.2 producer overrides with a per-leg reservation

  // ── PRODUCER_SUPPLIED — carried from the request body (same copy path as
  //    user-global); the C.2 producer is responsible for setting the per-leg
  //    instruction on the body before dispatch. NOT loaded from B, NOT dropped:
  //    a broadcast ("apply this to all projects") runs the same instruction per leg. ──
  message: 'producer-supplied', // broadcast instruction — copied from body, producer-owned

  // ── DROP — A's session / active-project state; never written to the leg ──
  referenceMedia: 'drop', // project-specific attached media — leak
  history: 'drop', // A's chat history — leak
  conversationId: 'drop', // A's session; B gets none (no rule-match against A)
  selectedSceneId: 'drop', // A's selection
  sceneContext: 'drop', // A's 'selected' refers to A's scenes
  sessionPermissions: 'drop', // A's session grants would bypass B's always_ask gate
  generationOverrides: 'drop', // A's "always fal" must not steer B
  autoChooseDefaults: 'drop',
  webSearchEnabled: 'drop', // not per-project; A's session choice
  aiQualityReview: 'drop', // session-level UX preference, not per-project
  webFetchEnabled: 'drop',
  autoAcceptWebSearch: 'drop',
  researchProviderEnabled: 'drop',
  initialScenePlan: 'drop', // A's scene plan
  resumeToolCall: 'drop', // A's resume state
  resumeCheckpoint: 'drop', // A's checkpoint flag
  resumeSpentUsd: 'drop', // A's pre-pause spend carry
  editorState: 'drop', // A's editor UI snapshot
  userId: 'drop', // server-authoritative (authenticatedUserId resolved from leg.projectId)
}

/** The subset of a target project's row the isolation transform reads. Loaded by
 *  an injected loader so the builder stays pure + unit-testable without a DB. */
export interface TargetProjectRow {
  apiPermissions: APIPermissions
  audioProviderEnabled: Record<string, boolean>
  mediaGenEnabled: Record<string, boolean>
  globalStyle: GlobalStyle
  projectName: string
  outputMode: 'mp4' | 'interactive'
  mp4Settings?: MP4Settings
  sceneGraph?: SceneGraph
  /** B's own NLE timeline (from B's description blob). Null when B has none. */
  timeline?: import('@/lib/types').Timeline | null
  /** B's own branch-scoped scenes. The orchestration bypasses mergeServerScenes,
   *  so the leg must start with B's scenes (not the origin's, not []). */
  scenes: Scene[]
  /** B's is_default branch id (never A's). null if B has no branch yet. */
  defaultBranchId: string | null
}

/** Loads the target row, or null if the project does not exist. MUST surface
 *  read errors (throw) rather than swallow them — the existing select at
 *  agent-runner.ts:324 does `.catch(() => [])`, which cannot back a fail-closed
 *  abort, so the isolation path uses its own loader. */
export type LoadTargetRow = (projectId: string) => Promise<TargetProjectRow | null>

/**
 * Resolve the effective body a run will execute under.
 *
 * @param body            the inbound request body (origin project's state)
 * @param targetProjectId the project this leg should run against
 * @param originProjectId the project the request originated from
 * @param loadTargetRow   loader for the target row (required for cross-project)
 */
export async function resolveLegBody(
  body: AgentAPIRequest,
  targetProjectId: string | undefined,
  originProjectId: string | undefined,
  loadTargetRow?: LoadTargetRow,
): Promise<AgentAPIRequest> {
  // INVARIANT: whenever the body carries a projectId, it MUST equal originProjectId.
  // This makes the resolver hard to misuse — a cross-project producer must pass the
  // ORIGIN's body with originProjectId=origin and targetProjectId=target, NOT
  // pre-repoint body.projectId to the target (which would let A's body run under B
  // via the identity short-circuit). Requiring origin even when it's omitted closes
  // the bypass where a pre-repointed body with no origin falls through to identity.
  if (body.projectId !== undefined && body.projectId !== originProjectId) {
    throw new Error(
      `resolveLegBody: body.projectId (${body.projectId}) must equal originProjectId (${originProjectId}) — ` +
        'pass the origin project body with its origin id; do not pre-repoint it to the target.',
    )
  }

  // IDENTITY — single-project run. Same reference, no DB read, zero overhead.
  if (!targetProjectId || targetProjectId === originProjectId) return body

  // CROSS-PROJECT — fail-closed: a loader is mandatory, and the target row must
  // be readable, or we abort rather than run under the origin's settings.
  if (!loadTargetRow) throw new CrossProjectLegAbort(targetProjectId)
  let row: TargetProjectRow | null
  try {
    row = await loadTargetRow(targetProjectId)
  } catch (e) {
    throw new CrossProjectLegAbort(targetProjectId, e)
  }
  if (!row) throw new CrossProjectLegAbort(targetProjectId)
  // Malformed row contents are as unsafe as an unreadable row: a null/absent
  // apiPermissions reads downstream as "no config → allow-all" (the {} = allow
  // hazard), so a legacy/corrupt B row would silently disable B's gate. Fail closed.
  if (row.apiPermissions == null) throw new CrossProjectLegAbort(targetProjectId)

  // ALLOWLIST BUILD — start empty; copy only user-global + producer-supplied
  // fields from the body (DROP fields are never written), then set
  // load-from-target fields from B's row. New unclassified fields would have
  // failed FIELD_CLASS's typecheck, so they cannot reach here unhandled.
  const leg: Partial<Record<keyof AgentAPIRequest, unknown>> = {}
  for (const key of Object.keys(FIELD_CLASS) as (keyof AgentAPIRequest)[]) {
    const cls = FIELD_CLASS[key]
    if ((cls === 'user-global' || cls === 'producer-supplied') && body[key] !== undefined) {
      // Shallow-clone arrays/objects so parallel legs built from one producer
      // body never alias (and can't mutate) each other's user-global state.
      // Deep isolation of nested values is the producer's job (pass per-leg bodies).
      const v = body[key]
      leg[key] = Array.isArray(v)
        ? [...v]
        : v !== null && typeof v === 'object'
          ? { ...(v as Record<string, unknown>) }
          : v
    }
  }

  // LOAD_FROM_TARGET (explicit — these come from B, not the body)
  leg.projectId = targetProjectId
  leg.scenes = row.scenes // B's own branch-scoped scenes (the orchestration bypasses mergeServerScenes)
  leg.globalStyle = row.globalStyle
  leg.projectName = row.projectName
  leg.outputMode = row.outputMode
  leg.sceneGraph = row.sceneGraph
  leg.timeline = row.timeline ?? null // B's own timeline (never A's)
  leg.mp4Settings = row.mp4Settings
  leg.apiPermissions = row.apiPermissions
  leg.audioProviderEnabled = row.audioProviderEnabled
  leg.mediaGenEnabled = row.mediaGenEnabled
  leg.branchId = row.defaultBranchId

  // message is required; the allowlist only copies it when present. A producer
  // that forgot to set the per-leg instruction would otherwise yield a leg with
  // no message and no error (the cast below hides it). Fail closed.
  if (leg.message === undefined) throw new CrossProjectLegAbort(targetProjectId)

  return leg as AgentAPIRequest
}
