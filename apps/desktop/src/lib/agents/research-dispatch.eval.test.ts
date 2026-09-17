// @vitest-environment node
/**
 * Research-dispatch eval (Phase 2) — does the Master Builder reach for a focused
 * research sub-agent when a topic calls for it?
 *
 * The Builder prompt instructs: for something it genuinely needs to understand
 * before planning, call dispatch_subagent with subagentType "Explore" to get a
 * cited brief back, rather than guessing. This LIVE eval drives the real runner
 * against a real model and checks that an explicit research-needing prompt routes
 * to dispatch_subagent (not straight to building or to a bare inline web_search).
 *
 * Cost control: aborts the instant dispatch_subagent (or a decisive build tool)
 * appears, so each case is ~one model turn. Tight cost cap as a backstop.
 *
 * OPT-IN — skipped unless both are set:
 *     RUN_AGENT_EVALS=1  ANTHROPIC_API_KEY=sk-...  npx vitest run src/lib/agents/research-dispatch.eval.test.ts
 */

import { describe, it, expect } from 'vitest'

import { runAgent } from './runner'
import { AgentLogger } from './logger'
import type { SSEEvent } from './types'

const ENABLED = process.env.RUN_AGENT_EVALS === '1' && !!process.env.ANTHROPIC_API_KEY

// Decisive tools: dispatch_subagent means "I'm delegating focused research";
// the build/plan tools mean "I skipped research and went to work".
const RESEARCH_TOOL = 'dispatch_subagent'
const NON_RESEARCH_DECISIVE = new Set(['create_scene', 'write_scene_code', 'add_layer', 'plan_scenes'])

async function observeResearch(
  message: string,
): Promise<{ dispatched: boolean; firstDecisive?: string; tools: string[] }> {
  const tools: string[] = []
  const abort = new AbortController()
  let firstDecisive: string | undefined

  const emit = (e: SSEEvent) => {
    if (e.type !== 'tool_start' || !e.toolName) return
    tools.push(e.toolName)
    if (firstDecisive) return
    if (e.toolName === RESEARCH_TOOL || NON_RESEARCH_DECISIVE.has(e.toolName)) {
      firstDecisive = e.toolName
      abort.abort()
    }
  }

  await runAgent({
    message,
    scenes: [],
    globalStyle: { presetId: null } as never,
    projectName: 'research-eval',
    outputMode: 'mp4',
    emit,
    logger: new AgentLogger(),
    abortSignal: abort.signal,
    webSearchEnabled: true, // Explore needs web_search available to be worth dispatching
    maxIterations: 4,
    runConfig: { maxRunCostUsd: 1 },
  }).catch((err) => {
    if (!firstDecisive) throw err
  })

  return { dispatched: tools.includes(RESEARCH_TOOL), firstDecisive, tools }
}

describe.skipIf(!ENABLED)('Master Builder research dispatch (live eval)', () => {
  it('dispatches an Explore sub-agent when the user explicitly asks to research first', async () => {
    const { firstDecisive } = await observeResearch(
      'Research the current state of solid-state battery commercialization first, then make a short explainer video about it.',
    )
    expect(firstDecisive).toBe('dispatch_subagent')
  }, 120_000)

  it('does NOT dispatch research for a trivial edit', async () => {
    const { dispatched, firstDecisive } = await observeResearch('Change the title on the current scene to "Welcome".')
    expect(dispatched).toBe(false)
    expect(firstDecisive).not.toBe('dispatch_subagent')
  }, 120_000)
})
