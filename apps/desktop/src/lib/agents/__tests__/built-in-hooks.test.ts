/**
 * Tests for built-in pre/post tool hooks.
 *
 * Focus: the `require-read-before-patch` hook that blocks `patch_layer_code`
 * against a scene whose code field exceeds the preview window unless the
 * agent has called `inspect({kind:'code'})` first.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerBuiltInHooks,
  resetBuiltInHooksRegistration,
  __resetReadSceneCodeMemoForTesting,
} from '../built-in-hooks'
import { clearToolHooks } from '../tool-executor'
import type { WorldStateMutable } from '../world-state'
import { ALL_TOOLS } from '../tools'

// Minimal world-state factory. The hook only reads `scenes` so we keep
// everything else empty / undefined.
function worldWith(sceneCodeLength: number): WorldStateMutable {
  const code = 'x'.repeat(sceneCodeLength)
  return {
    projectId: 'p1',
    scenes: [
      {
        id: 's1',
        name: 'Scene 1',
        sceneType: 'react',
        reactCode: code,
        svgObjects: [],
        aiLayers: [],
      } as any,
    ],
  } as unknown as WorldStateMutable
}

// Re-import lazily so we exercise the actual registration path.
async function runPreHook(toolName: string, args: Record<string, unknown>, world: WorldStateMutable) {
  const mod = await import('../tool-executor')
  // We rely on the runner internals via a fresh import — easier: read the
  // hook arrays directly by re-calling registerBuiltInHooks and invoking
  // through executeTool would mean wiring the full registry. Instead test
  // the hook by simulating runPreToolHooks's loop ourselves: register,
  // then call each matching hook in registration order until one denies.
  // For these tests we know exactly two pre-hooks match patch_layer_code
  // (`validate-scene-exists` wildcard + `require-read-before-patch`).
  type HookResult = { deny?: boolean; reason?: string; modifiedArgs?: Record<string, unknown> }
  type RegisteredHook = {
    pattern: string
    name: string
    hook: (ctx: {
      toolName: string
      args: Record<string, unknown>
      world: WorldStateMutable
    }) => HookResult | Promise<HookResult>
  }
  const hooks = (
    mod as unknown as { __getPreToolHooksForTesting?: () => RegisteredHook[] }
  ).__getPreToolHooksForTesting?.()
  if (!hooks) throw new Error('Test seam __getPreToolHooksForTesting missing — add it to tool-executor.ts')
  for (const h of hooks) {
    if (h.pattern !== '*' && h.pattern !== toolName) continue
    const r = await h.hook({ toolName, args, world })
    if (r.deny) return r
  }
  return { deny: false }
}

describe('require-read-before-patch hook', () => {
  beforeEach(() => {
    clearToolHooks()
    resetBuiltInHooksRegistration()
    __resetReadSceneCodeMemoForTesting()
    registerBuiltInHooks()
  })

  it('allows patch_layer_code when code fits in the preview window', async () => {
    const world = worldWith(1000) // well under 16K
    const r = await runPreHook('patch_layer_code', { sceneId: 's1', oldCode: 'x', newCode: 'y' }, world)
    expect(r.deny).toBeFalsy()
  })

  it('denies patch_layer_code when code exceeds the preview window and inspect was not called', async () => {
    const world = worldWith(20000) // over 16K
    const r = await runPreHook('patch_layer_code', { sceneId: 's1', oldCode: 'x', newCode: 'y' }, world)
    expect(r.deny).toBe(true)
    // The deny's ONLY recovery path is the tool it names — so assert that tool is really
    // offered, not that it equals a literal. Pinning the literal is what let the last
    // rename ship a deny whose instruction pointed at a deleted tool.
    const cited = r.reason?.match(/Call (\w+)\(/)?.[1]
    expect(ALL_TOOLS.map((t) => t.name)).toContain(cited)
    expect(r.reason).toMatch(/20000 chars/)
  })

  it('passes SVG-object patches through even when scene code is long', async () => {
    const world = worldWith(20000)
    world.scenes[0].svgObjects = [{ id: 'svg-a', svgContent: '<svg/>' } as any]
    const r = await runPreHook(
      'patch_layer_code',
      { sceneId: 's1', layerId: 'svg-a', oldCode: '<svg', newCode: '<svg width="1"' },
      world,
    )
    expect(r.deny).toBeFalsy()
  })
})

describe('runtime-verify cache (M3 debounce)', () => {
  beforeEach(() => {
    clearToolHooks()
    resetBuiltInHooksRegistration()
    __resetReadSceneCodeMemoForTesting()
    registerBuiltInHooks()
  })

  it('readRecentRuntimeVerify returns null when no entry exists', async () => {
    const { readRecentRuntimeVerify } = await import('../tool-executor')
    const world = worldWith(100)
    expect(readRecentRuntimeVerify(world, 's1')).toBeNull()
  })

  it('readRecentRuntimeVerify returns the entry when fresh', async () => {
    const { readRecentRuntimeVerify, writeRecentRuntimeVerify } = await import('../tool-executor')
    const world = worldWith(100)
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 42 })
    const cached = readRecentRuntimeVerify(world, 's1')
    expect(cached).not.toBeNull()
    expect(cached!.status).toBe('verified')
    expect(cached!.durationMs).toBe(42)
  })

  it('readRecentRuntimeVerify returns null when entry is older than the TTL', async () => {
    const { readRecentRuntimeVerify, writeRecentRuntimeVerify, RUNTIME_VERIFY_CACHE_TTL_MS } =
      await import('../tool-executor')
    const world = worldWith(100)
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 42 })
    // Manually age the entry past the TTL
    world.recentRuntimeVerify!['s1'].at = Date.now() - (RUNTIME_VERIFY_CACHE_TTL_MS + 1000)
    expect(readRecentRuntimeVerify(world, 's1')).toBeNull()
  })

  it('writeRecentRuntimeVerify overwrites the entry for the same sceneId', async () => {
    const { readRecentRuntimeVerify, writeRecentRuntimeVerify } = await import('../tool-executor')
    const world = worldWith(100)
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 100 })
    writeRecentRuntimeVerify(world, 's1', {
      status: 'errored',
      error: { kind: 'syntax', message: 'oops' } as any,
      durationMs: 250,
    })
    const cached = readRecentRuntimeVerify(world, 's1')
    expect(cached!.status).toBe('errored')
    expect(cached!.durationMs).toBe(250)
  })

  it('keeps separate entries per sceneId', async () => {
    const { readRecentRuntimeVerify, writeRecentRuntimeVerify } = await import('../tool-executor')
    const world = worldWith(100)
    world.scenes.push({ id: 's2', name: 'B', sceneType: 'react', reactCode: '' } as any)
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })
    writeRecentRuntimeVerify(world, 's2', { status: 'errored', error: null, durationMs: 80 })
    expect(readRecentRuntimeVerify(world, 's1')!.status).toBe('verified')
    expect(readRecentRuntimeVerify(world, 's2')!.status).toBe('errored')
  })

  it('updateScene invalidates the cache when code-bearing fields change', async () => {
    // Adversarial-review fix (P1): cache invalidation routes through
    // updateScene so ANY code-mutating tool (not just the 5 in the
    // post-hook list) drops the cached verify outcome.
    const { readRecentRuntimeVerify, writeRecentRuntimeVerify } = await import('../tool-executor')
    const { updateScene } = await import('../tool-handlers/_shared')

    const world = worldWith(100)
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })
    expect(readRecentRuntimeVerify(world, 's1')).not.toBeNull()

    updateScene(world, 's1', { reactCode: 'export default function S() { return null }' })
    expect(readRecentRuntimeVerify(world, 's1')).toBeNull()
  })

  it('updateScene preserves the cache when only non-render fields change', async () => {
    // A scene rename or transition swap doesn't affect render output, so
    // the cache should stay valid. Otherwise harmless edits would force
    // costly re-renders.
    const { readRecentRuntimeVerify, writeRecentRuntimeVerify } = await import('../tool-executor')
    const { updateScene } = await import('../tool-handlers/_shared')

    const world = worldWith(100)
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })

    updateScene(world, 's1', { name: 'renamed' } as any)
    expect(readRecentRuntimeVerify(world, 's1')).not.toBeNull()
  })

  it('updateScene invalidates the cache for sceneType change without sceneCode change', async () => {
    // Migrating from canvas2d → react drops chartLayers/d3Data as a
    // side-effect. The cache must invalidate even when only sceneType is
    // in the patch — the render output changes.
    const { readRecentRuntimeVerify, writeRecentRuntimeVerify } = await import('../tool-executor')
    const { updateScene } = await import('../tool-handlers/_shared')

    const world = worldWith(100)
    writeRecentRuntimeVerify(world, 's1', { status: 'verified', error: null, durationMs: 50 })

    updateScene(world, 's1', { sceneType: 'canvas2d' })
    expect(readRecentRuntimeVerify(world, 's1')).toBeNull()
  })
})

describe('enforce-verification-budget hook', () => {
  beforeEach(() => {
    clearToolHooks()
    resetBuiltInHooksRegistration()
    __resetReadSceneCodeMemoForTesting()
    registerBuiltInHooks()
  })

  it('allows verify_scene when budget is fresh', async () => {
    const world = worldWith(100)
    ;(world as any).verificationCyclesUsed = 0
    ;(world as any).verificationCyclesMax = 2
    const r = await runPreHook('verify_scene', { sceneId: 's1' }, world)
    expect(r.deny).toBeFalsy()
  })

  it('allows verify_scene when 1/2 cycles used', async () => {
    const world = worldWith(100)
    ;(world as any).verificationCyclesUsed = 1
    ;(world as any).verificationCyclesMax = 2
    const r = await runPreHook('verify_scene', { sceneId: 's1' }, world)
    expect(r.deny).toBeFalsy()
  })

  it('denies verify_scene when budget is exhausted', async () => {
    const world = worldWith(100)
    ;(world as any).verificationCyclesUsed = 2
    ;(world as any).verificationCyclesMax = 2
    const r = await runPreHook('verify_scene', { sceneId: 's1' }, world)
    expect(r.deny).toBe(true)
    expect(r.reason).toMatch(/budget exhausted/)
    expect(r.reason).toMatch(/2\/2/)
  })

  it('defaults to max=2 when world has no budget fields set', async () => {
    const world = worldWith(100) // no budget fields stamped
    const r = await runPreHook('verify_scene', { sceneId: 's1' }, world)
    expect(r.deny).toBeFalsy() // used=0 default < max=2 default
  })
})
