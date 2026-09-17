/**
 * T11/C13 — named checkpoints + agent-callable rollback.
 *
 * The snapshot machinery existed (a deep clone before EVERY tool) but was
 * never exposed — the agent couldn't experiment safely or undo a destructive
 * mistake. Raw per-tool snapshots are noisy implementation history, so the
 * agent surface is NAMED checkpoints: created automatically before
 * destructive ops (pre-tool hook), listed via list_snapshots, restored via
 * rollback_to_snapshot — with a documented fallback to the last per-tool
 * snapshot when no named checkpoint exists yet.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createStateQueryToolHandler } from '../tool-handlers/state-query-tools'
import { createNamedCheckpoint, createSnapshot, clearToolHooks } from '../tool-executor'
import type { WorldStateMutable } from '../world-state'
import { registerBuiltInHooks, resetBuiltInHooksRegistration } from '../built-in-hooks'

const handler = createStateQueryToolHandler()

function makeWorld(): WorldStateMutable {
  return {
    projectId: 'p1',
    scenes: [
      { id: 's1', name: 'Intro', sceneType: 'react', duration: 8, reactCode: 'v1' },
      { id: 's2', name: 'Outro', sceneType: 'react', duration: 5, reactCode: 'v1' },
    ],
    globalStyle: { palette: ['#000'] },
  } as unknown as WorldStateMutable
}

describe('named checkpoints — create / list / rollback cycle', () => {
  it('list_snapshots shows ONLY named checkpoints, never the per-tool noise', async () => {
    const world = makeWorld()
    createSnapshot(world, 'before:add_layer') // per-tool noise
    createNamedCheckpoint(world, 'before delete_scene: Intro')
    const result = await handler('list_snapshots', {}, world)
    expect(result.success).toBe(true)
    const checkpoints = (result.data as { checkpoints: Array<{ label: string }> }).checkpoints
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].label).toBe('before delete_scene: Intro')
  })

  it('rollback_to_snapshot restores scenes and globalStyle from a named checkpoint', async () => {
    const world = makeWorld()
    const cp = createNamedCheckpoint(world, 'before experiment')
    // The "experiment": delete a scene, mutate style + code.
    world.scenes = [{ ...world.scenes[0], reactCode: 'v2-broken' }] as typeof world.scenes
    ;(world.globalStyle as unknown as Record<string, unknown>).palette = ['#fff']

    const result = await handler('rollback_to_snapshot', { checkpointId: cp.id }, world)
    expect(result.success).toBe(true)
    expect(world.scenes).toHaveLength(2)
    expect((world.scenes[0] as { reactCode: string }).reactCode).toBe('v1')
    expect((world.globalStyle as { palette: string[] }).palette).toEqual(['#000'])
    expect((result.data as { usedFallback: boolean }).usedFallback).toBe(false)
  })

  it('no id → most recent named checkpoint wins', async () => {
    const world = makeWorld()
    createNamedCheckpoint(world, 'older')
    world.scenes[0] = { ...world.scenes[0], reactCode: 'v2' } as (typeof world.scenes)[0]
    createNamedCheckpoint(world, 'newer')
    world.scenes[0] = { ...world.scenes[0], reactCode: 'v3' } as (typeof world.scenes)[0]

    const result = await handler('rollback_to_snapshot', {}, world)
    expect(result.success).toBe(true)
    expect((result.data as { restoredLabel: string }).restoredLabel).toBe('newer')
    expect((world.scenes[0] as { reactCode: string }).reactCode).toBe('v2')
  })

  it('falls back to the last per-tool snapshot when no named checkpoints exist (documented)', async () => {
    const world = makeWorld()
    createSnapshot(world, 'before:write_scene_code')
    world.scenes[0] = { ...world.scenes[0], reactCode: 'broken' } as (typeof world.scenes)[0]
    const result = await handler('rollback_to_snapshot', {}, world)
    expect(result.success).toBe(true)
    expect((result.data as { usedFallback: boolean }).usedFallback).toBe(true)
    expect((world.scenes[0] as { reactCode: string }).reactCode).toBe('v1')
  })

  it('unknown id error lists the available checkpoints', async () => {
    const world = makeWorld()
    createNamedCheckpoint(world, 'before remove_layer: Intro')
    const result = await handler('rollback_to_snapshot', { checkpointId: 'nope' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toContain('before remove_layer: Intro')
  })

  it('caps named checkpoints at 20 (memory bound)', async () => {
    const world = makeWorld()
    for (let i = 0; i < 25; i++) createNamedCheckpoint(world, `cp-${i}`)
    expect(world.checkpoints).toHaveLength(20)
    expect(world.checkpoints![0].description).toBe('cp-5') // oldest evicted
  })
})

describe('destructive-op pre-hook creates the named checkpoint', () => {
  beforeEach(() => {
    clearToolHooks()
    resetBuiltInHooksRegistration()
    registerBuiltInHooks()
  })

  it('a delete_scene call sets the promotion marker; executeTool promotes the pre-snapshot under that label (single-clone)', async () => {
    const mod = await import('../tool-executor')
    type RegisteredHook = {
      pattern: string
      name: string
      hook: (ctx: unknown) => unknown | Promise<unknown>
    }
    const hooks = (
      mod as unknown as { __getPreToolHooksForTesting?: () => RegisteredHook[] }
    ).__getPreToolHooksForTesting?.()
    expect(hooks).toBeTruthy()
    const world = makeWorld()
    const h = hooks!.find((x) => x.name === 'named-checkpoint:delete_scene')
    expect(h).toBeTruthy()
    await h!.hook({ toolName: 'delete_scene', args: { sceneId: 's1' }, world })

    // The hook itself does NOT clone (perf: the per-tool snapshot already
    // will) — it leaves a labeled marker for executeTool's promotion path.
    expect(world.checkpoints ?? []).toHaveLength(0)
    expect(world._pendingNamedCheckpointLabel).toBe('before delete_scene: Intro')

    // Simulate executeTool's promotion: pre-snapshot exists → shared-clone
    // checkpoint appears under the hook's label, marker consumed.
    const pre = createSnapshot(world, 'before:delete_scene')
    if (world._pendingNamedCheckpointLabel) {
      world.checkpoints = world.checkpoints ?? []
      world.checkpoints.push({ ...pre, id: 'promoted', description: world._pendingNamedCheckpointLabel })
      delete world._pendingNamedCheckpointLabel
    }
    expect(world.checkpoints).toHaveLength(1)
    expect(world.checkpoints![0].description).toBe('before delete_scene: Intro')
    expect(world.checkpoints![0].scenes).toBe(pre.scenes) // shared clone, not a second one
  })
})

describe('fallback target selection skips the rollback call’s own pre-snapshot (/review PR2)', () => {
  it('rollback with no checkpoints undoes the last REAL tool, not itself', async () => {
    const world = makeWorld()
    // The last mutating tool's pre-snapshot (scenes at v1)…
    createSnapshot(world, 'before:write_scene_code')
    world.scenes[0] = { ...world.scenes[0], reactCode: 'broken-v2' } as (typeof world.scenes)[0]
    // …then executeTool snapshots the rollback call ITSELF (scenes at broken-v2).
    createSnapshot(world, 'before:rollback_to_snapshot')

    const result = await handler('rollback_to_snapshot', {}, world)
    expect(result.success).toBe(true)
    expect((result.data as { usedFallback: boolean }).usedFallback).toBe(true)
    // Without the skip, getLastSnapshot would "restore" broken-v2 and report
    // success while undoing nothing.
    expect((world.scenes[0] as { reactCode: string }).reactCode).toBe('v1')
  })
})
