// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import {
  MediaGenerationRunner,
  type GenerationUpdate,
  type MediaGenerationRunnerDeps,
  type PollResult,
} from './media-generation-runner'
import type { MediaGenerationRow, MediaGenerationStatus } from '@/lib/db/queries/media-generations'

// An in-memory media_generations store backing the injected deps, so the runner's state machine is
// exercised end-to-end (transition guards + push) without a real DB or provider.
function makeHarness(opts: {
  poll: (row: MediaGenerationRow) => Promise<PollResult>
}) {
  const rows = new Map<string, MediaGenerationRow>()
  const emitted: GenerationUpdate[] = []
  const patched: Array<{
    projectId: string
    sceneId: string
    layerId: string
    kind: string
    status: string
    resultUrl?: string | null
    resultDurationMs?: number | null
  }> = []

  function addRow(partial: Partial<MediaGenerationRow> & { id: string }): MediaGenerationRow {
    const row: MediaGenerationRow = {
      id: partial.id,
      projectId: partial.projectId ?? 'p1',
      kind: partial.kind ?? 'video',
      provider: partial.provider ?? 'kling',
      operationName: partial.operationName ?? 'op',
      status: partial.status ?? 'queued',
      prompt: partial.prompt ?? null,
      sceneId: partial.sceneId ?? 's1',
      layerId: partial.layerId ?? 'l1',
      clipId: partial.clipId ?? null,
      resultUrl: partial.resultUrl ?? null,
      resultDurationMs: partial.resultDurationMs ?? null,
      error: partial.error ?? null,
      attempts: partial.attempts ?? 0,
      deadlineAt: partial.deadlineAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    rows.set(row.id, row)
    return row
  }

  const deps: MediaGenerationRunnerDeps = {
    poll: opts.poll,
    getMediaGeneration: async (id) => rows.get(id) ?? null,
    listActiveMediaGenerations: async () =>
      [...rows.values()].filter((r) => r.status === 'queued' || r.status === 'running' || r.status === 'downloading'),
    transitionMediaGeneration: async (id, to, patch, from) => {
      const row = rows.get(id)
      if (!row) return false
      if (from) {
        const allowed = Array.isArray(from) ? from : [from]
        if (!allowed.includes(row.status)) return false
      }
      row.status = to as MediaGenerationStatus
      row.attempts += 1
      if (patch && 'resultUrl' in patch) row.resultUrl = patch.resultUrl ?? null
      if (patch && 'resultDurationMs' in patch) row.resultDurationMs = patch.resultDurationMs ?? null
      if (patch && 'error' in patch) row.error = patch.error ?? null
      return true
    },
    emit: (u) => emitted.push(u),
    patchPersistedLayer: async (p) => {
      patched.push(p)
    },
  }

  return { deps, rows, emitted, patched, addRow }
}

describe('MediaGenerationRunner state machine', () => {
  it('heartbeats queued→running while polling, then succeeds + pushes once', async () => {
    let calls = 0
    const h = makeHarness({
      poll: async () => {
        calls += 1
        return calls < 2 ? { done: false } : { done: true, resultUrl: '/media/cat.mp4', resultDurationMs: 5000 }
      },
    })
    h.addRow({ id: 'j1' })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('j1')

    await runner.tick() // poll #1 → still running
    expect(h.rows.get('j1')?.status).toBe('running')
    expect(h.emitted).toHaveLength(0)
    expect(runner.activeCount).toBe(1)

    await runner.tick() // poll #2 → done
    const row = h.rows.get('j1')
    expect(row?.status).toBe('succeeded')
    expect(row?.resultUrl).toBe('/media/cat.mp4')
    expect(runner.activeCount).toBe(0) // dequeued on terminal
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0]).toMatchObject({
      jobId: 'j1',
      status: 'succeeded',
      resultUrl: '/media/cat.mp4',
      resultDurationMs: 5000,
      layerId: 'l1',
    })

    runner.stop()
  })

  it('marks failed + pushes the error on a provider failure', async () => {
    const h = makeHarness({ poll: async () => ({ done: true, error: 'boom' }) })
    h.addRow({ id: 'j2' })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('j2')
    await runner.tick()
    expect(h.rows.get('j2')?.status).toBe('failed')
    expect(h.emitted[0]).toMatchObject({ jobId: 'j2', status: 'failed', error: 'boom' })
    runner.stop()
  })

  it('P2: patches the PERSISTED layer main-side on terminal success (headless — no renderer)', async () => {
    // In a headless MCP run there is no renderer store to run applyGenerationUpdate,
    // so the runner itself must land the finished clip on the persisted scene layer.
    const h = makeHarness({ poll: async () => ({ done: true, resultUrl: '/media/clip.mp4', resultDurationMs: 4200 }) })
    h.addRow({ id: 'jp', kind: 'video', projectId: 'proj-x', sceneId: 'scene-x', layerId: 'layer-x' })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('jp')
    await runner.tick()
    expect(h.patched).toHaveLength(1)
    expect(h.patched[0]).toMatchObject({
      projectId: 'proj-x',
      sceneId: 'scene-x',
      layerId: 'layer-x',
      kind: 'video',
      status: 'succeeded',
      resultUrl: '/media/clip.mp4',
      resultDurationMs: 4200,
    })
    runner.stop()
  })

  it('P2: patches the persisted layer with status failed on a terminal failure', async () => {
    const h = makeHarness({ poll: async () => ({ done: true, error: 'render failed' }) })
    h.addRow({ id: 'jpf', kind: 'avatar', sceneId: 's9', layerId: 'l9' })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('jpf')
    await runner.tick()
    expect(h.patched).toHaveLength(1)
    expect(h.patched[0]).toMatchObject({ sceneId: 's9', layerId: 'l9', status: 'failed' })
    runner.stop()
  })

  it('P2: does NOT patch the persisted layer when another poller already won (no double-write)', async () => {
    const h = makeHarness({
      poll: async (row) => {
        const stored = h.rows.get(row.id)
        if (stored) stored.status = 'succeeded' // a renderer/agent poller finalized it first
        return { done: true, resultUrl: '/race.mp4' }
      },
    })
    h.addRow({ id: 'jp-race', status: 'running' })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('jp-race')
    await runner.tick() // won=false → the winner (the open renderer) owns the persist
    expect(h.patched).toHaveLength(0)
    runner.stop()
  })

  it('does not re-push a job another poller already finalized (win-once)', async () => {
    const h = makeHarness({ poll: async () => ({ done: true, resultUrl: '/x.mp4' }) })
    // Row is already terminal (the renderer reconcile / agent get_status won the race).
    h.addRow({ id: 'j3', status: 'succeeded', resultUrl: '/x.mp4' })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('j3')
    await runner.tick()
    expect(h.emitted).toHaveLength(0)
    expect(runner.activeCount).toBe(0)
    runner.stop()
  })

  it('leaves a job active when a concurrent poller wins the terminal transition mid-tick', async () => {
    const h = makeHarness({
      // Simulate another poller (renderer reconcile / agent get_status) finalizing the row AFTER we
      // fetched it but BEFORE our transition — our from-guarded transition then returns won=false.
      poll: async (row) => {
        const stored = h.rows.get(row.id)
        if (stored) stored.status = 'succeeded'
        return { done: true, resultUrl: '/race.mp4' }
      },
    })
    h.addRow({ id: 'j-race', status: 'running' })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('j-race')

    await runner.tick() // our transition loses the race (won=false) → must NOT drop the job
    expect(h.emitted).toHaveLength(0) // we didn't win, so we don't push
    expect(runner.activeCount).toBe(1) // still tracked — next tick reconciles via getMediaGeneration

    await runner.tick() // top-of-loop sees terminal 'succeeded' → dequeues cleanly
    expect(runner.activeCount).toBe(0)
    expect(h.emitted).toHaveLength(0)
    runner.stop()
  })

  it('drops a non-pollable (synchronous) row without finalizing it', async () => {
    const h = makeHarness({ poll: async () => ({ done: true, drop: true }) })
    h.addRow({ id: 'j-sync', kind: 'image', status: 'queued', operationName: null })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('j-sync')
    await runner.tick()
    // No bogus succeeded+null-URL transition, no empty-asset push — just removed from the active set.
    expect(h.rows.get('j-sync')?.status).toBe('queued')
    expect(h.emitted).toHaveLength(0)
    expect(runner.activeCount).toBe(0)
    runner.stop()
  })

  it('swallows a transient poll error and retries next tick', async () => {
    let calls = 0
    const h = makeHarness({
      poll: async () => {
        calls += 1
        if (calls === 1) throw new Error('network blip')
        return { done: true, resultUrl: '/ok.mp4' }
      },
    })
    h.addRow({ id: 'j4' })
    const runner = new MediaGenerationRunner(h.deps)
    runner.enqueue('j4')
    await runner.tick() // throws internally → swallowed, job stays active
    expect(h.rows.get('j4')?.status).not.toBe('failed')
    expect(runner.activeCount).toBe(1)
    await runner.tick() // recovers → succeeds
    expect(h.rows.get('j4')?.status).toBe('succeeded')
    runner.stop()
  })

  it('recoverOnBoot re-enqueues every active job', async () => {
    const h = makeHarness({ poll: async () => ({ done: false }) })
    h.addRow({ id: 'a', status: 'queued' })
    h.addRow({ id: 'b', status: 'running' })
    h.addRow({ id: 'c', status: 'succeeded' }) // terminal — not recovered
    const runner = new MediaGenerationRunner(h.deps)
    await runner.recoverOnBoot()
    expect(runner.activeCount).toBe(2)
    runner.stop()
  })

  it('arms a single interval timer across multiple enqueues', async () => {
    vi.useFakeTimers()
    try {
      const poll = vi.fn(async () => ({ done: false }) as PollResult)
      const h = makeHarness({ poll })
      h.addRow({ id: 'x' })
      h.addRow({ id: 'y' })
      const runner = new MediaGenerationRunner(h.deps)
      runner.enqueue('x')
      runner.enqueue('y')
      expect(runner.activeCount).toBe(2)
      await vi.advanceTimersByTimeAsync(15_000)
      // Both jobs polled on the single shared tick.
      expect(poll).toHaveBeenCalledTimes(2)
      runner.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
