import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import type { ToolResult } from '@/lib/agents/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { track } from '@/lib/telemetry'

/**
 * `send_feedback` lets the agent report a tool gap (something missing, broken,
 * or plainly wrong) so the team can see where the tool surface falls short.
 *
 * The model writes only a paraphrased summary. Context comes from us: the
 * executor feeds every tool result through `recordFeedbackTool`, which keeps a
 * short trail of tool names and the latest error. The runner calls
 * `resetFeedbackState` at the start of each run, which also clears dedupe and
 * the per-run send budget.
 *
 * Each accepted report is appended in full to a local JSONL file (telemetry has
 * no endpoint by default, so the file is the record that always exists). The
 * `agent_feedback` telemetry event carries no text at all: only the category,
 * severity, lengths/counts and short hashes (see `toTelemetryProps`).
 */

export const FEEDBACK_TOOL_NAMES = ['send_feedback'] as const

const CATEGORIES = ['missing_capability', 'wrong_result', 'confusing_ux', 'failure', 'suggestion'] as const
const SEVERITIES = ['low', 'medium', 'high'] as const

const TRAIL_LENGTH = 15
const MAX_SENDS_PER_RUN = 8
const ERROR_CLIP = 200
const TEXT_CLIP = 500
const PROJECT_ID_PREFIX = 8

interface FeedbackState {
  recentTools: string[]
  lastError: string | null
  /** Dedupe keys of reports accepted this run; its size is the send count. */
  sentKeys: Set<string>
}

let state: FeedbackState = freshState()

function freshState(): FeedbackState {
  return { recentTools: [], lastError: null, sentKeys: new Set() }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function resetFeedbackState(): void {
  state = freshState()
}

/** Called by the executor after every tool; builds the diagnostics trail. */
export function recordFeedbackTool(toolName: string, result: ToolResult): void {
  if ((FEEDBACK_TOOL_NAMES as readonly string[]).includes(toolName)) return
  state.recentTools.push(toolName)
  if (state.recentTools.length > TRAIL_LENGTH) state.recentTools.splice(0, state.recentTools.length - TRAIL_LENGTH)
  if (!result.success && result.error) state.lastError = clip(result.error, ERROR_CLIP)
}

export function __getFeedbackStateForTesting(): Readonly<FeedbackState> {
  return state
}

export function getFeedbackLogPath(): string {
  return path.join(os.homedir(), '.dreambyte', 'agent-feedback.jsonl')
}

function appendToLog(record: Record<string, unknown>): void {
  try {
    const file = getFeedbackLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Best-effort: an unwritable home dir must not break the agent run.
  }
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Telemetry view of a report: enums, counts and hashes only — never the text. */
export function toTelemetryProps(payload: {
  category: string
  severity: string | null
  summary: string
  details: string | null
  recent_tools: string
  last_error: string | null
}): Record<string, string | number | boolean | null> {
  return {
    category: payload.category,
    severity: payload.severity,
    summary_hash: shortHash(payload.summary.toLowerCase()),
    summary_chars: payload.summary.length,
    details_chars: payload.details?.length ?? 0,
    recent_tool_count: payload.recent_tools ? payload.recent_tools.split(',').length : 0,
    has_last_error: payload.last_error !== null,
    last_error_hash: payload.last_error === null ? null : shortHash(payload.last_error),
  }
}

function fail(error: string): ToolResult {
  return { success: false, error }
}

export function createFeedbackToolHandler() {
  return async (_toolName: string, args: Record<string, unknown>, world: WorldStateMutable): Promise<ToolResult> => {
    const { category, summary, details, severity } = args

    if (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category)) {
      return fail(`Invalid category. Use one of: ${CATEGORIES.join(', ')}.`)
    }
    if (typeof summary !== 'string' || summary.trim() === '') {
      return fail('summary is required: one short paraphrased line describing the issue.')
    }
    if (
      severity !== undefined &&
      (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity))
    ) {
      return fail(`Invalid severity. Use one of: ${SEVERITIES.join(', ')}, or omit it.`)
    }

    const cleanSummary = clip(summary.trim(), TEXT_CLIP)
    const key = `${category}|${cleanSummary.toLowerCase()}`
    if (state.sentKeys.has(key)) {
      return {
        success: true,
        data: { sent: false, reason: 'duplicate', message: 'Already reported this run; no need to send it again.' },
      }
    }
    if (state.sentKeys.size >= MAX_SENDS_PER_RUN) {
      return {
        success: true,
        data: {
          sent: false,
          reason: 'session_limit',
          message:
            'Feedback limit for this run reached. Stop sending reports; mention any remaining issues to the user briefly instead.',
        },
      }
    }
    const payload = {
      category,
      summary: cleanSummary,
      details: typeof details === 'string' && details.trim() ? clip(details.trim(), TEXT_CLIP) : null,
      severity: typeof severity === 'string' ? severity : null,
      recent_tools: state.recentTools.join(','),
      last_error: state.lastError,
      project_id: world.projectId ? world.projectId.slice(0, PROJECT_ID_PREFIX) : null,
      model_id: world.modelId ?? null,
    }

    appendToLog({ at: new Date().toISOString(), ...payload })
    try {
      track('agent_feedback', toTelemetryProps(payload))
    } catch {
      // Telemetry is optional; the local log above is the durable record.
    }
    // Counted only once the report has been persisted (or at least attempted).
    state.sentKeys.add(key)

    return {
      success: true,
      data: {
        sent: true,
        message: 'Feedback logged for the team. Tell the user in a few words that you flagged it, then carry on.',
      },
      // The in-app runner surfaces `changes` to the chat as a state_change notice.
      changes: [{ type: 'ui_action', description: 'Logged this for the team.' }],
    }
  }
}
