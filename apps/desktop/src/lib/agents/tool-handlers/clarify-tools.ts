/**
 * Clarify tools — `ask_user`, the human-in-the-loop pause/ask primitive.
 *
 * The agent calls `ask_user({ question, options? })` when it is genuinely unsure
 * (ambiguous request, low-confidence format/type). The flow REUSES the existing
 * permission-pause machinery — this handler only decides between two states:
 *
 *   1. FIRST call (no answer yet) → return `clarificationNeeded`. The runner sees
 *      it (same sites that handle `permissionNeeded`), pauses the run, and the
 *      client renders a clarification card.
 *   2. RESUME call → the client re-issues the tool with the user's answer threaded
 *      in as `_answer` (resumeToolCall.toolInput). The handler returns that answer
 *      as the tool result, and the loop continues.
 *
 * Pure: no IO. `_answer` / `_clarifyId` are internal fields the client injects on
 * resume — they are NOT in the agent-facing schema, so the model never sets them
 * (and AJV allows the extra props: no additionalProperties:false on tool schemas).
 */

import type { ToolResult } from '@/lib/agents/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'

export const CLARIFY_TOOL_NAMES = ['ask_user'] as const

/** A short, stable id from the question text — used as the card key (no Date/random). */
function clarifyId(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join('-')
  return `clarify-${slug || 'q'}`
}

function cleanOptions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const opts = raw.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).map((o) => o.trim())
  return opts.length > 0 ? opts : undefined
}

export function createClarifyToolHandler() {
  return async function handleClarifyTools(
    toolName: string,
    args: Record<string, unknown>,
    _world: WorldStateMutable,
  ): Promise<ToolResult> {
    if (toolName !== 'ask_user') {
      return { success: false, error: `Unknown clarify tool: ${toolName}` }
    }

    const question = typeof args.question === 'string' ? args.question.trim() : ''
    if (!question) {
      return { success: false, error: 'ask_user requires a non-empty `question`.' }
    }
    const options = cleanOptions(args.options)

    // Resume: the client threaded the user's answer in as `_answer`. A blank /
    // whitespace answer is treated as NOT answered — re-pause rather than return
    // an empty string as if the user confirmed it (edge case in the plan).
    const answer = typeof args._answer === 'string' ? args._answer.trim() : ''
    if (answer) {
      return { success: true, affectedSceneId: null, changes: [], data: { answer } }
    }

    // First call (or blank resume): pause the run and surface the question.
    const id =
      typeof args._clarifyId === 'string' && args._clarifyId.trim() ? args._clarifyId.trim() : clarifyId(question)
    return {
      success: true,
      affectedSceneId: null,
      changes: [],
      data: { clientAction: 'ask_user', question, options },
      clarificationNeeded: { id, question, options },
    }
  }
}
