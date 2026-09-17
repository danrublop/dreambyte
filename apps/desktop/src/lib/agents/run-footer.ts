/**
 * The honest run-end footer.
 *
 * One small terminal line summarizing what the run actually did, rendered from
 * RUN FACTS (the accumulated tool calls + the done event's usage), never from
 * the model's narration. This is what stops a failed/empty run from reading as a
 * cheerful success.
 *
 * Also: any scene left with `verifyStatus === 'errored'` at run end is
 * named so the run can't read as success while playback skips those scenes.
 */

import type { ToolCallRecord, UsageStats } from './types'

export type RunOutcome = 'completed' | 'error' | 'aborted'

export interface RunFooterFacts {
  outcome: RunOutcome
  /** Scenes created this run (create_scene successes). */
  created: number
  /** Scenes edited in place this run (write_scene_code/patch_layer_code on an existing scene). */
  edited: number
  /** Tool calls that failed (output.success === false). */
  toolsFailed: number
  /** Total spend for the run, in USD (from the done event's usage, not RunProgress). */
  spendUsd: number
  /** Names (or ids) of scenes left in an errored verify state at run end. */
  erroredScenes: string[]
}

const OUTCOME_LABEL: Record<RunOutcome, string> = {
  completed: 'Done',
  error: 'Failed',
  aborted: 'Stopped',
}

/**
 * Derive the run facts from the renderer's accumulated tool calls + the done
 * event usage. `create_scene` successes count as created; `write_scene_code` /
 * `patch_layer_code` successes on a scene NOT created this run count as edited
 * (a scene created then edited stays a create — matches the runner's RunProgress
 * accounting). A tool call with `output.success === false` counts as failed.
 */
export function deriveRunFooterFacts(input: {
  outcome: RunOutcome
  toolCalls: ToolCallRecord[]
  usage?: Pick<UsageStats, 'costUsd'> | null
  erroredScenes?: string[]
}): RunFooterFacts {
  const created = new Set<string>()
  const edited = new Set<string>()
  let toolsFailed = 0

  for (const tc of input.toolCalls) {
    const out = tc.output as { success?: boolean; affectedSceneId?: string | null } | undefined
    const ok = out?.success !== false
    if (!ok) {
      toolsFailed++
      continue
    }
    const sceneId = out?.affectedSceneId ?? undefined
    if (tc.toolName === 'create_scene' && sceneId) {
      created.add(sceneId)
    } else if ((tc.toolName === 'write_scene_code' || tc.toolName === 'patch_layer_code') && sceneId) {
      if (!created.has(sceneId)) edited.add(sceneId)
    }
  }
  // A scene both created and edited this run is a create only.
  for (const id of created) edited.delete(id)

  return {
    outcome: input.outcome,
    created: created.size,
    edited: edited.size,
    toolsFailed,
    spendUsd: input.usage?.costUsd ?? 0,
    erroredScenes: input.erroredScenes ?? [],
  }
}

/** Render the facts as a single terminal footer line. */
export function formatRunFooter(facts: RunFooterFacts): string {
  // Cost is intentionally NOT shown per-message — it lives in the live session
  // usage counter under the composer (toggle cost/tokens via the donut). The
  // per-message footer stays focused on the honest run FACTS.
  const parts = [
    OUTCOME_LABEL[facts.outcome],
    `${facts.created} created`,
    `${facts.edited} edited`,
    `${facts.toolsFailed} tools failed`,
  ]
  let line = parts.join(' · ')
  if (facts.erroredScenes.length > 0) {
    line += ` — broken scene${facts.erroredScenes.length > 1 ? 's' : ''}: ${facts.erroredScenes.join(', ')}`
  }
  return line
}

/** Convenience: derive + format in one call. */
export function buildRunFooter(input: Parameters<typeof deriveRunFooterFacts>[0]): string {
  return formatRunFooter(deriveRunFooterFacts(input))
}

/** Persisted chat-message status for a given run outcome. */
export type RunPersistStatus = 'complete' | 'error' | 'aborted'

/**
 * The single outcome decision the finalizer (`finalizeRunMessage`) keys on so
 * the error/done/abort handlers can't disagree about the result:
 *   - errored (an error event or a thrown non-rate-limit failure) → 'error'
 *   - else a user Stop → 'aborted'
 *   - else → 'completed'
 * Errored wins over aborted (a failure mid-Stop is still a failure).
 */
export function resolveRunOutcome(input: { errored: boolean; aborted: boolean }): RunOutcome {
  if (input.errored) return 'error'
  if (input.aborted) return 'aborted'
  return 'completed'
}

/** Map a run outcome to its persisted chat-message status. */
export function outcomeToPersistStatus(outcome: RunOutcome): RunPersistStatus {
  return outcome === 'error' ? 'error' : outcome === 'aborted' ? 'aborted' : 'complete'
}
