/**
 * Integration test for the auto-capture-frame post-tool hook.
 *
 * The hook fires after code-write tools on Anthropic models and sets
 * clientAction: 'capture_frame' on the tool result so the runner's
 * pending-captures round-trip emits a visual frame to the agent.
 *
 * Tests:
 *   - Anthropic model: result gets clientAction when scene is clean.
 *   - Non-Anthropic model: no clientAction (hook no-ops).
 *   - Runtime errored scene: no clientAction (skip crashed scenes).
 *   - Duplicate state: no clientAction (codeHash cache hit).
 *   - Both verify warning AND capture flag coexist in result.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerBuiltInHooks,
  resetBuiltInHooksRegistration,
  __resetReadSceneCodeMemoForTesting,
} from '../built-in-hooks'
import { clearToolHooks, writeRecentRuntimeVerify, writeRecentCapture, computeCodeHash } from '../tool-executor'
import type { WorldStateMutable } from '../world-state'
import type { ToolResult } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function worldWithAnthropicModel(reactCode = 'export default function S() { return null }'): WorldStateMutable {
  return {
    projectId: 'p1',
    modelId: 'claude-sonnet-4-6',
    scenes: [
      {
        id: 's1',
        name: 'Scene 1',
        sceneType: 'react',
        reactCode,
        svgObjects: [],
        aiLayers: [],
      } as any,
    ],
  } as unknown as WorldStateMutable
}

function successResult(): ToolResult {
  return {
    success: true,
    affectedSceneId: 's1',
    data: { someKey: 'someValue' },
  }
}

// Simulate runPostToolHooks for a single post-hook name pattern.
// This mirrors what the built-in-hooks tests do to avoid wiring the full executeTool.
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
    const r = await h.hook({
      toolName,
      args: { sceneId: 's1' },
      result: currentResult,
      world,
      durationMs: 100,
    })
    if (r.modifiedResult) currentResult = r.modifiedResult
    if (r.warning) {
      currentResult = {
        ...currentResult,
        data: {
          ...(typeof currentResult.data === 'object' ? (currentResult.data as Record<string, unknown>) : {}),
          _hookWarning: r.warning,
        },
      }
    }
  }
  return currentResult
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('auto-capture-frame hook', () => {
  beforeEach(() => {
    clearToolHooks()
    resetBuiltInHooksRegistration()
    __resetReadSceneCodeMemoForTesting()
    registerBuiltInHooks()
  })

  it('sets clientAction on result for Anthropic model after clean write', async () => {
    const world = worldWithAnthropicModel()
    // Stamp a successful verify so the hook sees a clean scene.
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })

    const finalResult = await runPostHooksForTool('write_scene_code', successResult(), world)

    expect((finalResult.data as any)?.clientAction).toBe('capture_frame')
    expect((finalResult.data as any)?.sceneId).toBe('s1')
    expect((finalResult.data as any)?.time).toBe(1)
  })

  it('sets clientAction for a non-Anthropic model too (A5 — capture is provider-agnostic)', async () => {
    const world = worldWithAnthropicModel()
    ;(world as any).modelId = 'gpt-4o'
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })

    const finalResult = await runPostHooksForTool('write_scene_code', successResult(), world)

    // The capture round-trip is renderer-side; the provider only changes how
    // the frame is CONSUMED (image block on Anthropic, text warnings elsewhere).
    expect((finalResult.data as any)?.clientAction).toBe('capture_frame')
  })

  it('does NOT set clientAction when the most recent verify errored', async () => {
    const world = worldWithAnthropicModel()
    // Stamp an errored verify — capturing a crashed scene is useless.
    writeRecentRuntimeVerify(world, 's1', {
      status: 'errored',
      error: { kind: 'runtime', message: 'ReferenceError: foo is not defined', line: 42 } as any,
      durationMs: 100,
    })

    const finalResult = await runPostHooksForTool('patch_layer_code', successResult(), world)

    expect((finalResult.data as any)?.clientAction).toBeUndefined()
  })

  it('does NOT set clientAction when the codeHash cache already has an entry', async () => {
    const world = worldWithAnthropicModel()
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })

    // Pre-populate the cache with the same hash the hook would compute.
    const code = (world.scenes[0] as any).reactCode as string
    const hash = computeCodeHash(code)
    writeRecentCapture(world, 's1', hash)

    const finalResult = await runPostHooksForTool('write_scene_code', successResult(), world)

    expect((finalResult.data as any)?.clientAction).toBeUndefined()
  })

  it('preserves existing data fields (including _hookWarning from auto-verify)', async () => {
    const world = worldWithAnthropicModel()
    // Simulate verified so capture fires.
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })

    // Inject a warning that the auto-verify hook would have added.
    const resultWithWarning: ToolResult = {
      success: true,
      affectedSceneId: 's1',
      data: { someKey: 'original', _hookWarning: 'RUNTIME ERROR: something broke.' },
    }

    const finalResult = await runPostHooksForTool('write_scene_code', resultWithWarning, world)

    // Both the warning AND the capture flag should be present.
    const d = finalResult.data as Record<string, any>
    expect(d._hookWarning).toBe('RUNTIME ERROR: something broke.')
    expect(d.clientAction).toBe('capture_frame')
    expect(d.someKey).toBe('original')
  })

  it('fires for every code-write tool name', async () => {
    const toolNames = ['write_scene_code', 'patch_layer_code', 'add_layer', 'regenerate_layer']
    for (const toolName of toolNames) {
      // Fresh world per tool to avoid cache hits from prior iterations.
      const world = worldWithAnthropicModel(`export default function S_${toolName}() { return null }`)
      writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })

      const finalResult = await runPostHooksForTool(toolName, successResult(), world)

      expect((finalResult.data as any)?.clientAction, `Expected capture for ${toolName}`).toBe('capture_frame')
    }
  })

  it('second call with same code skips capture (cache idempotency)', async () => {
    const world = worldWithAnthropicModel()
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })

    // First call should set clientAction.
    const first = await runPostHooksForTool('write_scene_code', successResult(), world)
    expect((first.data as any)?.clientAction).toBe('capture_frame')

    // Second call with the same world (same codeHash in cache now) should skip.
    const second = await runPostHooksForTool('write_scene_code', successResult(), world)
    expect((second.data as any)?.clientAction).toBeUndefined()
  })
})
