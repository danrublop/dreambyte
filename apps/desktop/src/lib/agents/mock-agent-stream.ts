/**
 * Mock agent SSE stream — for offline UI testing without burning API credits.
 *
 * Activated via the `Mock Agent (no API credits)` toggle in the Settings
 * panel, which sets `mockMode: true` on the agent request body. The IPC
 * handler in `src/electron/ipc/agent.ts` skips the BYOK pre-flight check when
 * mockMode is set; `src/lib/services/agent-runner.ts` dispatches here instead
 * of calling `runAgent()` against a real provider.
 *
 * The point: produce a Cursor-style chat experience. Short narration
 * sentence before each tool call ("I'll start with the title scene...")
 * → tool card pops up → confirmation sentence after ("Done. Now I'll add
 * the chart...") → next tool card → final summary. AgentChat already has
 * the segment-interleaving logic to render this — see `streamingSegments`
 * in `src/components/AgentChat.tsx`. We just need to emit events that produce
 * the pattern.
 *
 * Scenarios are picked from keywords in the user's message:
 *   - "multi"       → 3-scene plan with narrated build-up
 *   - "error"       → mid-run tool failure to test error rendering
 *   - "permission"  → emits a permissionNeeded result (paid_api spend gate)
 *   - "mutation"    → mutation_preview permission (destructive-tool gate)
 *   - "websearch"   → web_search permission (one-time session approval)
 *   - "biometric"   → biometric_consent permission (Tier 3 Cast voice clone)
 *   - "plan"        → plan-first flow: write_plan → plan card + live todos
 *   - default       → single-scene Cursor-style narrate-act-confirm flow
 *
 * Payload bodies come from `src/lib/dev/sample-payloads.ts` — the
 * same builders that drive the static chat UI showcase, so the two prongs of
 * the harness can never drift apart.
 *
 * Timing is tuned to feel real: ~25ms per token chunk, ~600ms tool
 * execution stall, ~150ms between text and tool transitions. Total runtime
 * for the default scenario is ~6s — long enough to actually watch the UI
 * update, short enough to iterate quickly.
 */

import type { SSEEvent, AgentType, ModelId, ToolResult, UsageStats } from './types'
import { samplePermission, samplePlan, samplePlanTodos, type SamplePermissionKind } from '../dev/sample-payloads'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wait `ms` milliseconds, but bail early if the abort signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Stream a sentence as if the model is producing tokens. Splits on word
 * boundaries to make the cadence feel natural — chunks of 1-3 words with
 * small jitter between them. Aborts cleanly mid-sentence.
 */
async function streamTokens(
  text: string,
  emit: (event: SSEEvent) => void,
  signal?: AbortSignal,
  perChunkMs = 25,
): Promise<void> {
  const words = text.split(/(\s+)/)
  let buf = ''
  for (let i = 0; i < words.length; i++) {
    buf += words[i]
    // Flush every 1-3 word chunk so the UI gets multiple paint frames per
    // sentence. The exact size matters less than the cadence.
    if (i % 3 === 2 || i === words.length - 1) {
      emit({ type: 'token', token: buf })
      buf = ''
      if (i < words.length - 1) await sleep(perChunkMs + Math.random() * 15, signal)
    }
  }
}

/** A canonical "success" tool result — fabricated in-memory, no DB writes. */
function fakeToolSuccess(input: { sceneId?: string; description?: string }): ToolResult {
  return {
    success: true,
    affectedSceneId: input.sceneId,
    changes: input.sceneId
      ? [
          {
            type: 'scene_updated',
            sceneId: input.sceneId,
            description: input.description ?? 'Mock tool succeeded',
          },
        ]
      : [],
  } as ToolResult
}

function fakeToolError(message: string): ToolResult {
  return { success: false, error: message } as ToolResult
}

/** Cosmetic usage stats — the runner skips real accounting in mock mode. */
function mockUsage(inputTokens: number, outputTokens: number, costUsd: number): UsageStats {
  return {
    inputTokens,
    outputTokens,
    apiCalls: 0,
    costUsd,
    totalDurationMs: 0,
  }
}

// ── Scenario picker ──────────────────────────────────────────────────────────

type Scenario =
  | 'multi'
  | 'error'
  | 'permission'
  | 'permission_mutation'
  | 'permission_websearch'
  | 'permission_biometric'
  | 'plan'
  | 'default'

function pickScenario(message: string): Scenario {
  const m = message.toLowerCase()
  if (m.includes('multi')) return 'multi'
  if (m.includes('error')) return 'error'
  // Specific permission kinds before the generic spend gate.
  if (m.includes('mutation')) return 'permission_mutation'
  if (m.includes('websearch') || m.includes('web search')) return 'permission_websearch'
  if (m.includes('biometric') || m.includes('consent')) return 'permission_biometric'
  if (m.includes('permission')) return 'permission'
  if (m.includes('plan')) return 'plan'
  return 'default'
}

/** Map a scenario to the PendingPermission kind it exercises. */
const PERMISSION_SCENARIO_KIND: Partial<Record<Scenario, SamplePermissionKind>> = {
  permission: 'paid_api',
  permission_mutation: 'mutation_preview',
  permission_websearch: 'web_search',
  permission_biometric: 'biometric_consent',
}

// ── Public entry ─────────────────────────────────────────────────────────────

export interface MockAgentStreamOptions {
  /** Latest user message — drives scenario selection by keyword. */
  message: string
  /** ID of the currently selected scene, if any — used as the affected
   *  scene for tool results so `preview_update` events have a target. */
  selectedSceneId: string | null
  /** Sink — same `emit(event)` callback the real runner uses. */
  emit: (event: SSEEvent) => void
  /** Cancellation — fires when the user clicks the abort button. */
  signal: AbortSignal
}

/**
 * Run a mock agent loop. Resolves when the scripted sequence completes or
 * the abort signal fires. Never throws — abort produces a clean shutdown.
 *
 * The caller (src/lib/services/agent-runner.ts) owns generation-log persistence
 * and post-run side effects. This function is pure event emission.
 */
export async function runMockAgentStream(opts: MockAgentStreamOptions): Promise<void> {
  const { message, selectedSceneId, emit, signal } = opts
  const scenario = pickScenario(message)

  const agentType: AgentType = 'scene-maker'
  const modelId: ModelId = 'claude-sonnet-4-6' // cosmetic; UI shows this in the badge

  try {
    emit({
      type: 'agent_routed',
      agentType,
      modelId,
      routeMethod: 'default',
      toolCount: 40,
    })
    emit({ type: 'iteration_start', iteration: 1, maxIterations: 8 })

    if (scenario === 'plan') {
      // Plan-first flow: narrate → write_plan tool → plan card with
      // todos, then two live todo updates so the checklist visibly progresses.
      await streamTokens('Let me write a plan before building anything.', emit, signal)
      await sleep(200, signal)
      const planInput = { title: 'Build the Q3 recap video' }
      emit({ type: 'tool_start', toolName: 'write_plan', toolInput: planInput })
      await sleep(600, signal)
      emit({
        type: 'tool_complete',
        toolName: 'write_plan',
        toolInput: planInput,
        toolResult: fakeToolSuccess({ description: 'Plan written' }),
      })
      const todos = samplePlanTodos().map((t) => ({ ...t, status: 'pending' as const }))
      emit({ type: 'plan_proposed', plan: samplePlan(), todos })
      // Stream two checklist transitions so the in-progress/completed icon
      // states render live (the static showcase only shows them frozen).
      await sleep(700, signal)
      emit({
        type: 'todos_updated',
        todos: todos.map((t, i) => (i === 0 ? { ...t, status: 'in_progress' as const } : t)),
      })
      await sleep(700, signal)
      emit({
        type: 'todos_updated',
        todos: todos.map((t, i) =>
          i === 0 ? { ...t, status: 'completed' as const } : i === 1 ? { ...t, status: 'in_progress' as const } : t,
        ),
      })
      await streamTokens(' Plan is up — approve it and I will build the scenes.', emit, signal)
      emit({ type: 'done', agentType, modelId, fullText: '', usage: mockUsage(300, 120, 0) })
      return
    }

    // Common opening — mirrors how Cursor leads with intent.
    await streamTokens("I'll start with a title scene that fades in over 2 seconds.", emit, signal)
    await sleep(150, signal)

    // ── Tool 1 — write_scene_code ──────────────────────────────────────────
    const tool1Input = { sceneId: selectedSceneId ?? 'mock-scene-1', sceneType: 'react' }
    emit({ type: 'tool_start', toolName: 'write_scene_code', toolInput: tool1Input })
    await sleep(600, signal) // simulated tool execution

    const permissionKind = PERMISSION_SCENARIO_KIND[scenario]
    if (permissionKind) {
      // All four permission kinds ride the same gate path: a failed tool
      // result carrying permissionNeeded. Payload from the shared builder —
      // PendingPermission and ToolResult.permissionNeeded are field-compatible
      // for everything the cards read (kind/api/cost/prompt/providers/consent).
      const perm = samplePermission(permissionKind)
      emit({
        type: 'tool_complete',
        toolName: perm.toolName,
        toolInput: perm.toolArgs ?? tool1Input,
        toolResult: {
          success: false,
          error: `Permission required: ${perm.reason ?? `this generation would cost ${perm.estimatedCost}.`}`,
          permissionNeeded: { ...perm, toolArgs: perm.toolArgs ?? tool1Input },
        } as unknown as ToolResult,
      })
      emit({ type: 'done', agentType, modelId, fullText: '', usage: mockUsage(100, 50, 0.001) })
      return
    }

    if (scenario === 'error') {
      emit({
        type: 'tool_complete',
        toolName: 'write_scene_code',
        toolInput: tool1Input,
        toolResult: fakeToolError('Mock failure: scene generator returned empty code.'),
      })
      await streamTokens(" Hmm, that didn't work. Let me try a different approach for the title.", emit, signal)
      emit({ type: 'done', agentType, modelId, fullText: '', usage: mockUsage(200, 80, 0.002) })
      return
    }

    emit({
      type: 'tool_complete',
      toolName: 'write_scene_code',
      toolInput: tool1Input,
      toolResult: fakeToolSuccess({ sceneId: tool1Input.sceneId, description: 'Wrote title scene' }),
    })
    // Bump the per-scene preview version so PreviewPlayer would refetch the
    // iframe — the same path real `preview_update` events take.
    emit({ type: 'preview_update', sceneId: tool1Input.sceneId, changes: [] })
    await sleep(200, signal)

    await streamTokens(' Done. Now adding a chart scene to back the claim with data.', emit, signal)
    await sleep(150, signal)

    // ── Tool 2 — generate_chart ────────────────────────────────────────────
    const tool2Input = { sceneId: 'mock-scene-2', chartType: 'bar' }
    emit({ type: 'tool_start', toolName: 'generate_chart', toolInput: tool2Input })
    await sleep(700, signal)
    emit({
      type: 'tool_complete',
      toolName: 'generate_chart',
      toolInput: tool2Input,
      toolResult: fakeToolSuccess({ sceneId: tool2Input.sceneId, description: 'Generated bar chart' }),
    })
    emit({ type: 'preview_update', sceneId: tool2Input.sceneId, changes: [] })
    await sleep(200, signal)

    if (scenario === 'multi') {
      // Third tool call to exercise the longer-conversation rendering.
      await streamTokens(' One more — an outro card with the call to action.', emit, signal)
      await sleep(150, signal)

      const tool3Input = { sceneId: 'mock-scene-3', sceneType: 'react' }
      emit({ type: 'tool_start', toolName: 'add_layer', toolInput: tool3Input })
      await sleep(500, signal)
      emit({
        type: 'tool_complete',
        toolName: 'add_layer',
        toolInput: tool3Input,
        toolResult: fakeToolSuccess({ sceneId: tool3Input.sceneId, description: 'Added outro CTA' }),
      })
      emit({ type: 'preview_update', sceneId: tool3Input.sceneId, changes: [] })
      await sleep(200, signal)
      await streamTokens(' All three scenes ready. Total duration: ~13 seconds.', emit, signal)
    } else {
      await streamTokens(' Both scenes are ready on the timeline.', emit, signal)
    }

    emit({
      type: 'done',
      agentType,
      modelId,
      fullText: '',
      usage: mockUsage(800, 320, 0),
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // Clean cancellation — emit nothing more; the IPC layer's __stream_end__
      // sentinel will resolve the renderer's promise.
      return
    }
    emit({ type: 'error', error: `Mock agent error: ${(err as Error).message}` })
  }
}
