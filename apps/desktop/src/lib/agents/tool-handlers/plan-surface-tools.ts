import { v4 as uuidv4 } from 'uuid'
import type { ToolResult, AgentPlan, AgentTodo } from '@/lib/agents/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'

/**
 * Agentic plan surface tool handlers.
 *
 * `write_plan` writes the free-form markdown plan (the user-facing planning
 * artifact that replaces the plan_scenes *form*). `update_todos`
 * maintains the tracked checklist. Both store onto the mutable world; the runner
 * emits `plan_proposed` / `todos_updated` SSE events off the result so the chat
 * plan card renders + updates in place.
 *
 * Todos live on `world.todos` (NOT folded into `world.plan`) on purpose: the plan
 * is written + approved in one run, but the checklist keeps updating live in the
 * separate build run (whose world starts fresh, with no plan). Keeping the list
 * independent lets `update_todos` work in both runs.
 */

export const PLAN_SURFACE_TOOL_NAMES = ['write_plan', 'update_todos'] as const

// Defense-in-depth: the plan body is adversarial LLM text rendered into the
// user's chat chrome. react-markdown escapes raw HTML by default (no live XSS),
// but we still clamp the length so a runaway model can't render megabytes of
// markdown into the panel.
const MAX_PLAN_BODY_CHARS = 20_000

function normalizeStatus(raw: unknown): AgentTodo['status'] {
  const s =
    typeof raw === 'string'
      ? raw
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_')
      : ''
  if (s === 'in_progress' || s === 'inprogress' || s === 'active' || s === 'doing') return 'in_progress'
  if (s === 'completed' || s === 'complete' || s === 'done') return 'completed'
  if (s === 'failed' || s === 'error' || s === 'blocked') return 'failed'
  return 'pending'
}

/** Coerce a loose todo input ({ text } or { id, text, status }) into an AgentTodo. */
function toTodo(raw: unknown): AgentTodo | null {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? { id: uuidv4(), text, status: 'pending' } : null
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const text = typeof obj.text === 'string' ? obj.text.trim() : ''
    if (!text) return null
    return {
      id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : uuidv4(),
      text,
      status: normalizeStatus(obj.status),
    }
  }
  return null
}

/** Coerce + dedupe a raw todos array. Models are told to reuse stable ids, so a
 *  repeated id is plausible — collapse duplicates (last write wins) to avoid
 *  duplicate React keys in the plan card checklist. Preserves first-seen order. */
function toTodoList(raw: unknown[]): AgentTodo[] {
  const byId = new Map<string, AgentTodo>()
  for (const item of raw) {
    const todo = toTodo(item)
    if (!todo) continue
    if (byId.has(todo.id)) todo.id = uuidv4() // collision → fresh id, keep both rows
    byId.set(todo.id, todo)
  }
  return [...byId.values()]
}

export function createPlanSurfaceToolHandler() {
  return async function handlePlanSurfaceTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'write_plan': {
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        const body = typeof args.plan === 'string' ? args.plan.trim() : ''
        if (!body) {
          return {
            success: false,
            error:
              'write_plan requires a non-empty "plan" — the free-form markdown body describing what you will build.',
          }
        }

        const plan: AgentPlan = {
          title: title || 'Plan',
          body: body.length > MAX_PLAN_BODY_CHARS ? body.slice(0, MAX_PLAN_BODY_CHARS) : body,
          createdAt: Date.now(),
        }
        world.plan = plan

        // Optional initial todos seed the checklist in the same call so the card
        // shows the plan + its steps at once. Replaces any prior list (a re-issued
        // write_plan supersedes the previous plan and its checklist).
        if (Array.isArray(args.todos)) {
          world.todos = toTodoList(args.todos as unknown[])
        } else if (!world.todos) {
          world.todos = []
        }

        return {
          success: true,
          affectedSceneId: null,
          changes: [],
          data: {
            message: `Plan "${plan.title}" written${world.todos.length ? ` with ${world.todos.length} todo(s)` : ''}.`,
            plan,
            todos: world.todos,
          },
        }
      }

      case 'update_todos': {
        if (!Array.isArray(args.todos)) {
          return {
            success: false,
            error:
              'update_todos requires a "todos" array. Pass the FULL current checklist (each item: { id?, text, status }); it replaces the prior list.',
          }
        }
        const todos = toTodoList(args.todos as unknown[])
        world.todos = todos

        const done = todos.filter((t) => t.status === 'completed').length
        const inProgress = todos.find((t) => t.status === 'in_progress')
        return {
          success: true,
          affectedSceneId: null,
          changes: [],
          data: {
            message: `Todos updated: ${done}/${todos.length} done${inProgress ? ` · ${inProgress.text}` : ''}.`,
            todos,
          },
        }
      }

      default:
        return { success: false, error: `Unknown plan-surface tool: ${toolName}` }
    }
  }
}
