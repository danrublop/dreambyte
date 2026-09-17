// @vitest-environment node
/**
 * Triage eval (Workstream C.3) — the behavior that defines "Claude Code for video".
 *
 * The unified Master Builder must scale effort to the request, prompt-driven (no
 * classifier service):
 *   - trivial ask  → act directly (patch/build in place). NO write_plan/plan_scenes, NO delegation.
 *   - larger build → plan first (write_plan / create_design_brief), then delegate
 *                    the parallel build via dispatch_scene_builder.
 *
 * This is a LIVE eval: it drives the real runner against a real model and inspects
 * which tool the agent reaches for FIRST. It is the gate for removing the heuristic
 * orchestration fallback in `shouldHandoffToOrchestrator` — once this proves the
 * prompt path reliably routes effort, the director-only heuristic can go.
 *
 * Cost control: the run is aborted the instant the first *decisive* tool is seen
 * (a planning tool or a direct-edit tool), so each case costs ~one model turn and
 * never triggers a real parallel build. A tight cost cap is a backstop.
 *
 * It is OPT-IN — skipped unless you set both:
 *     RUN_AGENT_EVALS=1  ANTHROPIC_API_KEY=sk-...  npx vitest run src/lib/agents/triage.eval.test.ts
 * so the normal `npx vitest run src/lib/agents/` stays fast and offline.
 */

import { describe, it, expect } from 'vitest'

import { runAgent } from './runner'
import { AgentLogger } from './logger'
import type { SSEEvent } from './types'

const ENABLED = process.env.RUN_AGENT_EVALS === '1' && !!process.env.ANTHROPIC_API_KEY

// Tools that mean "I'm planning a larger build before touching scenes".
// Phase 3: write_plan is the user-facing planning artifact (it supersedes the
// plan_scenes form), so it counts as a planning first-move too.
const PLANNING_TOOLS = new Set(['write_plan', 'plan_scenes', 'create_design_brief', 'dispatch_scene_builder'])
// Tools that mean "I'm acting directly on the work" (the fast path).
const DIRECT_EDIT_TOOLS = new Set([
  'write_scene_code',
  'patch_layer_code',
  'add_layer',
  'create_scene',
  'set_scene_background',
  'set_scene_duration',
  'edit_element',
  'regenerate_layer',
])

type Decision = 'plan' | 'direct' | 'none'

/**
 * Run the Master Builder on a prompt and report which way it triaged, based on
 * the first decisive tool it calls. Aborts as soon as that tool appears.
 */
async function observeTriage(message: string): Promise<{ decision: Decision; firstTool?: string; tools: string[] }> {
  const tools: string[] = []
  const abort = new AbortController()
  let decision: Decision = 'none'
  let firstTool: string | undefined

  const emit = (e: SSEEvent) => {
    if (e.type !== 'tool_start' || !e.toolName) return
    tools.push(e.toolName)
    if (decision !== 'none') return
    if (PLANNING_TOOLS.has(e.toolName)) {
      decision = 'plan'
      firstTool = e.toolName
      abort.abort()
    } else if (DIRECT_EDIT_TOOLS.has(e.toolName)) {
      decision = 'direct'
      firstTool = e.toolName
      abort.abort()
    }
  }

  await runAgent({
    message,
    scenes: [],
    globalStyle: { presetId: null } as never,
    projectName: 'triage-eval',
    outputMode: 'mp4',
    emit,
    logger: new AgentLogger(),
    abortSignal: abort.signal,
    maxIterations: 4,
    runConfig: { maxRunCostUsd: 1 }, // backstop; abort should fire well before this
  }).catch((err) => {
    // An abort surfaces as a rejection on some provider paths — that's expected
    // once we've captured the decision. Re-throw only if we learned nothing.
    if (decision === 'none') throw err
  })

  return { decision, firstTool, tools }
}

describe.skipIf(!ENABLED)('Master Builder effort triage (live eval)', () => {
  it('takes the fast path on a trivial single-scene edit (no plan, no delegation)', async () => {
    const { decision, tools } = await observeTriage(
      'Add one simple title card scene that says "Hello World" in the center. Just the one scene.',
    )
    expect(decision).toBe('direct')
    expect(tools).not.toContain('write_plan')
    expect(tools).not.toContain('plan_scenes')
    expect(tools).not.toContain('dispatch_scene_builder')
  }, 120_000)

  it('plans first on a larger multi-scene build', async () => {
    const { decision, firstTool } = await observeTriage(
      'Make me a 60-second explainer video about how photosynthesis works, with a few scenes.',
    )
    expect(decision).toBe('plan')
    // It should reach for planning (write_plan, plan_scenes, or design brief), not
    // start hand-writing scene code first.
    expect(['write_plan', 'plan_scenes', 'create_design_brief', 'dispatch_scene_builder']).toContain(firstTool)
  }, 120_000)
})
