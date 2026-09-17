import { describe, it, expect } from 'vitest'
import { createPlanSurfaceToolHandler } from './plan-surface-tools'
import type { WorldStateMutable } from '../world-state'

// Minimal world — the plan-surface tools only touch world.plan / world.todos.
function makeWorld(): WorldStateMutable {
  return {
    scenes: [],
    globalStyle: {} as never,
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: '' },
  } as WorldStateMutable
}

const handle = createPlanSurfaceToolHandler()

describe('write_plan', () => {
  it('stores a written plan on the world and returns it', async () => {
    const world = makeWorld()
    const res = await handle('write_plan', { title: 'My Video', plan: '## Plan\nBuild three scenes.' }, world)

    expect(res.success).toBe(true)
    expect(world.plan).toBeDefined()
    expect(world.plan!.title).toBe('My Video')
    expect(world.plan!.body).toBe('## Plan\nBuild three scenes.')
    expect(world.plan!.createdAt).toBeTypeOf('number')
    expect((res.data as { plan: unknown }).plan).toEqual(world.plan)
  })

  it('rejects an empty plan body', async () => {
    const world = makeWorld()
    const res = await handle('write_plan', { title: 'x', plan: '   ' }, world)
    expect(res.success).toBe(false)
    expect(world.plan).toBeUndefined()
  })

  it('defaults the title when omitted', async () => {
    const world = makeWorld()
    const res = await handle('write_plan', { plan: 'just a body' }, world)
    expect(res.success).toBe(true)
    expect(world.plan!.title).toBe('Plan')
  })

  it('seeds initial todos with ids + pending status', async () => {
    const world = makeWorld()
    await handle('write_plan', { plan: 'body', todos: [{ text: 'Scene 1' }, { text: 'Scene 2' }] }, world)
    expect(world.todos).toHaveLength(2)
    expect(world.todos!.every((t) => t.status === 'pending' && t.id && t.text)).toBe(true)
  })

  it('a re-issued write_plan supersedes the prior plan + checklist (reply-to-revise)', async () => {
    const world = makeWorld()
    await handle('write_plan', { plan: 'v1', todos: [{ text: 'old' }] }, world)
    const res = await handle('write_plan', { plan: 'v2', todos: [{ text: 'new' }] }, world)
    expect(res.success).toBe(true)
    expect(world.plan!.body).toBe('v2')
    expect(world.todos).toHaveLength(1)
    expect(world.todos![0].text).toBe('new')
  })
})

describe('update_todos', () => {
  it('replaces the checklist and normalizes statuses', async () => {
    const world = makeWorld()
    await handle('write_plan', { plan: 'body', todos: [{ text: 'a' }, { text: 'b' }] }, world)
    const res = await handle(
      'update_todos',
      {
        todos: [
          { id: '1', text: 'a', status: 'completed' },
          { id: '2', text: 'b', status: 'in-progress' }, // hyphen normalizes
        ],
      },
      world,
    )
    expect(res.success).toBe(true)
    expect(world.todos).toHaveLength(2)
    expect(world.todos![0].status).toBe('completed')
    expect(world.todos![1].status).toBe('in_progress')
    expect((res.data as { message: string }).message).toContain('1/2 done')
  })

  it('works without a prior plan (live progress during the separate build run)', async () => {
    const world = makeWorld() // no plan — the build run starts fresh
    const res = await handle('update_todos', { todos: [{ text: 'building', status: 'in_progress' }] }, world)
    expect(res.success).toBe(true)
    expect(world.todos).toHaveLength(1)
    expect(world.todos![0].status).toBe('in_progress')
  })

  it('coerces an unknown status to pending', async () => {
    const world = makeWorld()
    const res = await handle('update_todos', { todos: [{ text: 'x', status: 'frobnicate' }] }, world)
    expect(res.success).toBe(true)
    expect(world.todos![0].status).toBe('pending')
  })

  it('rejects a non-array todos arg', async () => {
    const world = makeWorld()
    const res = await handle('update_todos', { todos: 'nope' as never }, world)
    expect(res.success).toBe(false)
  })

  it('dedupes repeated ids so the checklist has unique React keys', async () => {
    const world = makeWorld()
    await handle(
      'update_todos',
      {
        todos: [
          { id: 'dup', text: 'first', status: 'completed' },
          { id: 'dup', text: 'second', status: 'pending' },
        ],
      },
      world,
    )
    expect(world.todos).toHaveLength(2)
    const ids = world.todos!.map((t) => t.id)
    expect(new Set(ids).size).toBe(2) // no duplicate keys
  })
})

describe('write_plan body clamp', () => {
  it('clamps an oversized plan body', async () => {
    const world = makeWorld()
    await handle('write_plan', { plan: 'x'.repeat(50_000) }, world)
    expect(world.plan!.body.length).toBeLessThanOrEqual(20_000)
  })
})
