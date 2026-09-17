/**
 * run_stopped emission helper.
 *
 * The runner's loop has four structural break paths that used to end the run
 * with nothing but a log line (or a bare streamed sentence): cost cap,
 * tool-call cap, invalid-tool-args stop, and checkpoint-save failure. Each
 * now emits exactly one structured `run_stopped` event through this helper so
 * the client can tell the user WHY the run ended instead of showing a silent
 * stop.
 *
 * Kept in its own module (not runner.ts) so tests can import it without
 * pulling the runner's provider dependency graph.
 */

import type { SSEEvent, RunStopReason } from './types'

/** Default human-readable detail per stop reason — used when the call site
 *  doesn't supply a more specific message (e.g. with live cost numbers). */
export const RUN_STOP_MESSAGES: Record<RunStopReason, string> = {
  cost_cap: 'Run stopped: the cost cap for this run was reached.',
  tool_call_cap: 'Run stopped: the tool-call limit for this run was reached.',
  round_cap: 'Run stopped: the round limit for this run was reached with work remaining.',
  stuck_invalid_args: 'Run stopped: the model produced invalid tool arguments and could not continue.',
  stuck: 'Run stopped: the model kept repeating tool calls with no effect and was stopped.',
  checkpoint_save_failed: 'Run checkpoint could not be saved — resuming this run may not be available.',
}

/**
 * Emit a single `run_stopped` event. Never throws: the emit sink can be a
 * closed IPC channel / aborted stream at exactly the moments this fires, and a reporting failure must not mask the original stop.
 */
export function emitRunStopped(emit: (e: SSEEvent) => void, stopReason: RunStopReason, detail?: string): void {
  try {
    emit({ type: 'run_stopped', stopReason, message: detail ?? RUN_STOP_MESSAGES[stopReason] })
  } catch {
    // Stream already closed — the stop itself is still logged by the caller.
  }
}

/** Visible text line + token + structured event for the invalid-tool-args
 *  stop. One home for the wording — the runner has two tool loops (Anthropic
 *  and OpenAI-compat) that both break on invalid args, and the 6-line block
 *  was duplicated verbatim between them.
 *  Returns the text appended so the caller can add it to fullText. */
export function emitInvalidArgsStop(emit: (e: SSEEvent) => void): string {
  const stopMsg = `\n\n⏹ Stopped: the model produced invalid tool arguments and the run cannot continue.`
  try {
    emit({ type: 'token', token: stopMsg })
  } catch {
    /* closed stream — same contract as emitRunStopped */
  }
  emitRunStopped(emit, 'stuck_invalid_args')
  return stopMsg
}
