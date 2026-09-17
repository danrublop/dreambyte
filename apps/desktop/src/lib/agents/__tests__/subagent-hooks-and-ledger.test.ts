/**
 * IT11/T12 — sub-agent visual hooks: prove-first + D7 ledger gating.
 *
 * PROVE-FIRST OUTCOME (Codex C14 confirmed): the audit's claim that built-in
 * hooks "don't fire for sub-agents" is FALSE. Hooks live in a module-global
 * registry in tool-executor and run inside executeTool for every caller;
 * sub-agents are recursive runAgent() calls whose worlds get modelId the same
 * way the parent's does (runner.ts world construction). The first describe
 * pins that: the auto-capture hook fires on a world carrying the sub-agent
 * scope markers (enforcedToolNames, scopeForeignSceneIds).
 *
 * THE REAL GAP (D7 / TODOS #4): visual-check spend was tracked only on
 * runProgress.visualCheckCostUsd — and every sub-agent carries its OWN
 * runProgress, so an orchestrated build paid N × the visual cap while the
 * shared RunCostLedger (the run-level cost cap) never saw any of it. The
 * second describe pins the fix: spend commits to the shared ledger, and a
 * run already over its cap skips checks with the pause note.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerBuiltInHooks,
  resetBuiltInHooksRegistration,
  __resetReadSceneCodeMemoForTesting,
} from '../built-in-hooks'
import { clearToolHooks } from '../tool-executor'
import type { WorldStateMutable } from '../world-state'
import type { ToolResult } from '../types'
import {
  runVisualQualityCheck,
  VISUAL_CHECK_COST_CAP_USD,
  __setVisualQualityCheckImplForTesting,
} from '../services/visual-quality-check'
import { makeRunCostLedger } from '../run-cost-ledger'

function subAgentWorld(): WorldStateMutable {
  return {
    projectId: 'p1',
    modelId: 'claude-sonnet-4-6',
    // Sub-agent scope markers — exactly what the runner sets for orchestrator
    // sub-agents (enforced toolset + foreign-scene scope). If hook execution
    // were ever gated on their absence, this test catches the regression.
    enforcedToolNames: new Set(['write_scene_code', 'verify_scene']),
    scopeForeignSceneIds: new Set(['other-scene']),
    scenes: [
      {
        id: 's1',
        name: 'Scene 1',
        sceneType: 'react',
        reactCode: 'export default function S() { return null }',
        svgObjects: [],
        aiLayers: [],
      },
    ],
  } as unknown as WorldStateMutable
}

async function runPostHooksForTool(
  toolName: string,
  result: ToolResult,
  world: WorldStateMutable,
): Promise<ToolResult> {
  const mod = await import('../tool-executor')
  type HookResult = { modifiedResult?: ToolResult; warning?: string }
  type RegisteredHook = {
    pattern: string
    name: string
    hook: (ctx: {
      toolName: string
      args: Record<string, unknown>
      result: ToolResult
      world: WorldStateMutable
      durationMs: number
    }) => HookResult | Promise<HookResult>
  }
  const hooks = (
    mod as unknown as { __getPostToolHooksForTesting?: () => RegisteredHook[] }
  ).__getPostToolHooksForTesting?.()
  if (!hooks) throw new Error('Test seam __getPostToolHooksForTesting missing')
  let currentResult = result
  for (const h of hooks) {
    if (h.pattern !== '*' && h.pattern !== toolName) continue
    const r = await h.hook({ toolName, args: { sceneId: 's1' }, result: currentResult, world, durationMs: 100 })
    if (r.modifiedResult) currentResult = r.modifiedResult
  }
  return currentResult
}

describe('prove-first: built-in hooks fire on sub-agent-shaped worlds (C14)', () => {
  beforeEach(() => {
    // A5: runVisualQualityCheck key-gates before reserving cost.
    process.env.ANTHROPIC_API_KEY = 'test-key'
    clearToolHooks()
    resetBuiltInHooksRegistration()
    __resetReadSceneCodeMemoForTesting()
    registerBuiltInHooks()
  })

  it('auto-capture sets clientAction on a world carrying sub-agent scope markers', async () => {
    const world = subAgentWorld()
    const result = await runPostHooksForTool(
      'write_scene_code',
      { success: true, affectedSceneId: 's1', data: {} },
      world,
    )
    const data = result.data as Record<string, unknown>
    expect(data.clientAction).toBe('capture_frame') // hooks are NOT parent-only
    expect(data.sceneId).toBe('s1')
  })
})

describe('D7: visual-check spend debits the shared run ledger', () => {
  beforeEach(() => {
    // Stub the vision call via the module's test seam — the charge happens
    // regardless of the check outcome (by design), which is what we measure.
    __setVisualQualityCheckImplForTesting(async () => null)
  })

  function makeArgs() {
    const result: { success: boolean; data?: unknown } = { success: true, data: {} }
    const runProgress: Record<string, unknown> = { visualCheckCostUsd: 0 }
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    return { result, runProgress, logger }
  }

  it('commits the estimated check cost to the shared ledger', async () => {
    const { result, runProgress, logger } = makeArgs()
    const ledger = makeRunCostLedger(5)
    await runVisualQualityCheck(
      'data:image/png;base64,AAAA',
      'image/png',
      result,
      runProgress as never,
      logger as never,
      ledger,
    )
    // Charged on every attempt (even null/error outcomes) — so the ledger
    // must have received exactly the same estimated amount runProgress did.
    expect(ledger.spentUsd).toBeGreaterThan(0)
    expect(ledger.spentUsd).toBeCloseTo(runProgress.visualCheckCostUsd as number, 10)
  })

  it('skips the check (pause note, no spend) when the shared ledger is over cap', async () => {
    const { result, runProgress, logger } = makeArgs()
    const ledger = makeRunCostLedger(1)
    ledger.spentUsd = 1.5 // over cap — generation already consumed the budget
    await runVisualQualityCheck(
      'data:image/png;base64,AAAA',
      'image/png',
      result,
      runProgress as never,
      logger as never,
      ledger,
    )
    expect(runProgress.visualCheckCostUsd).toBe(0) // no new spend
    expect(ledger.spentUsd).toBe(1.5) // ledger untouched
    const warnings = (result.data as { _visualWarnings?: Array<{ code: string }> })._visualWarnings
    expect(warnings?.[0]?.code).toBe('VISUAL_CHECK_COST_CAP')
  })

  it('still respects the per-run visual cap independently of the ledger', async () => {
    const { result, runProgress, logger } = makeArgs()
    runProgress.visualCheckCostUsd = VISUAL_CHECK_COST_CAP_USD + 0.01
    const ledger = makeRunCostLedger(100) // ledger has plenty of room
    await runVisualQualityCheck(
      'data:image/png;base64,AAAA',
      'image/png',
      result,
      runProgress as never,
      logger as never,
      ledger,
    )
    expect(ledger.spentUsd).toBe(0) // visual cap blocked it before any spend
    const warnings = (result.data as { _visualWarnings?: Array<{ code: string }> })._visualWarnings
    expect(warnings?.[0]?.code).toBe('VISUAL_CHECK_COST_CAP')
  })

  it('works without a ledger (headless callers keep the old contract)', async () => {
    const { result, runProgress, logger } = makeArgs()
    await expect(
      runVisualQualityCheck('data:image/png;base64,AAAA', 'image/png', result, runProgress as never, logger as never),
    ).resolves.toBeUndefined()
    expect(runProgress.visualCheckCostUsd).toBeGreaterThan(0)
  })

  it('R4: reserve-before-await — a concurrent burst cannot overshoot the shared cap', async () => {
    // Old order was gate-check → await vision → commit: M concurrent
    // sub-agent checks all passed the gate before any committed, overshooting
    // by ~M × estimate. The fix reserves BEFORE the await, so the second
    // in-flight caller already sees the ledger over cap.
    let release!: () => void
    const inFlight = new Promise<void>((r) => {
      release = r
    })
    __setVisualQualityCheckImplForTesting(async () => {
      await inFlight // hold every call "at the provider" simultaneously
      return null
    })
    const ledger = makeRunCostLedger(0.004) // one estimated check (~$0.005) puts it over
    const argsPerCall = Array.from({ length: 3 }, () => makeArgs())
    const runs = argsPerCall.map(({ result, runProgress, logger }) =>
      runVisualQualityCheck(
        'data:image/png;base64,AAAA',
        'image/png',
        result,
        runProgress as never,
        logger as never,
        ledger,
      ),
    )
    release()
    await Promise.all(runs)
    // Exactly ONE caller charged (each sub-agent carries its own runProgress —
    // the shared ledger is the only cross-caller gate, mirroring production).
    const charged = argsPerCall.filter(({ runProgress }) => (runProgress.visualCheckCostUsd as number) > 0)
    expect(charged).toHaveLength(1)
    expect(ledger.spentUsd).toBeCloseTo(charged[0].runProgress.visualCheckCostUsd as number, 10)
  })
})
