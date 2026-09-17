// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnAgentVariants, __testing } from '../spawn-variants'

vi.mock('@/lib/agent-transport', () => ({
  streamAgentSse: vi.fn(),
}))

import { streamAgentSse } from '@/lib/agent-transport'

const mockedStream = streamAgentSse as ReturnType<typeof vi.fn>

interface MockBranchIpc {
  create: ReturnType<typeof vi.fn>
  delete?: ReturnType<typeof vi.fn>
}

function installBranchIpc(mock: MockBranchIpc) {
  Object.defineProperty(window, 'dreambyteApi', {
    value: { branches: mock },
    writable: true,
    configurable: true,
  })
}

function uninstallBranchIpc() {
  Object.defineProperty(window, 'dreambyteApi', {
    value: undefined,
    writable: true,
    configurable: true,
  })
}

describe('spawnAgentVariants', () => {
  beforeEach(() => {
    mockedStream.mockReset()
  })

  afterEach(() => {
    uninstallBranchIpc()
  })

  it('creates N branches off the source branch and runs the agent on each', async () => {
    const create = vi.fn(async (args: { projectId: string; name: string; sourceBranchId?: string }) => ({
      branch: { id: `${args.name}-id`, name: args.name },
    }))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })
    mockedStream.mockResolvedValue(undefined)

    const buildRequest = vi.fn((branchId: string) => ({ message: 'hi', branchId }))

    const results = await spawnAgentVariants({
      projectId: 'proj-1',
      sourceBranchId: 'main-branch',
      prompt: 'make a hero scene',
      n: 3,
      buildAgentRequest: buildRequest,
    })

    expect(create).toHaveBeenCalledTimes(3)
    // Branch names derived from prompt.
    expect(create.mock.calls.map((c) => c[0].name)).toEqual([
      'make-a-hero-scene-v1',
      'make-a-hero-scene-v2',
      'make-a-hero-scene-v3',
    ])
    // Every create uses the same sourceBranchId.
    expect(create.mock.calls.every((c) => c[0].sourceBranchId === 'main-branch')).toBe(true)

    expect(mockedStream).toHaveBeenCalledTimes(3)
    expect(buildRequest).toHaveBeenCalledTimes(3)
    // Each agent run targets a distinct branch id.
    const branchIdsUsed = buildRequest.mock.calls.map((c) => c[0])
    expect(branchIdsUsed).toEqual(['make-a-hero-scene-v1-id', 'make-a-hero-scene-v2-id', 'make-a-hero-scene-v3-id'])

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'success')).toBe(true)
  })

  it('clamps n to [MIN_VARIANTS, MAX_VARIANTS]', async () => {
    const create = vi.fn(async ({ name }: { name: string }) => ({ branch: { id: name, name } }))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })
    mockedStream.mockResolvedValue(undefined)

    const buildRequest = vi.fn(() => ({}))

    // n=1 clamps up to MIN_VARIANTS (2)
    await spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'x',
      n: 1,
      buildAgentRequest: buildRequest,
    })
    expect(create).toHaveBeenCalledTimes(__testing.MIN_VARIANTS)

    create.mockClear()
    buildRequest.mockClear()

    // n=99 clamps down to MAX_VARIANTS (8)
    await spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'x',
      n: 99,
      buildAgentRequest: buildRequest,
    })
    expect(create).toHaveBeenCalledTimes(__testing.MAX_VARIANTS)
  })

  it('continues past a failed variant — partial success returns failures alongside successes', async () => {
    const create = vi.fn(async ({ name }: { name: string }) => ({ branch: { id: `${name}-id`, name } }))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })
    // First run succeeds; second fails; third succeeds.
    mockedStream
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(undefined)

    const results = await spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 3,
      buildAgentRequest: () => ({}),
    })

    expect(results.map((r) => r.status)).toEqual(['success', 'failed', 'success'])
    expect(results[1].error).toBe('rate limited')
    // All three branches still got created (Phase 1) even though variant 2's agent run failed.
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('retries branch creation once with a uuid suffix on name collision', async () => {
    // First v1 attempt collides, retry with suffix succeeds. v2 succeeds first try.
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('A branch named "test-v1" already exists in this project'))
      .mockResolvedValueOnce({ branch: { id: 'b1', name: 'test-v1-abcd' } })
      .mockResolvedValueOnce({ branch: { id: 'b2', name: 'test-v2' } })
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })
    mockedStream.mockResolvedValue(undefined)

    const results = await spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 2,
      buildAgentRequest: () => ({}),
    })

    expect(create).toHaveBeenCalledTimes(3) // 2 base attempts + 1 retry
    expect(results).toHaveLength(2)
    expect(results[0].status).toBe('success')
    expect(results[0].branchId).toBe('b1')
  })

  it('throws if a non-collision branch create error happens (halts before any LLM credits burn)', async () => {
    const create = vi.fn().mockRejectedValue(new Error('quota exceeded'))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })

    await expect(
      spawnAgentVariants({
        projectId: 'p',
        sourceBranchId: 's',
        prompt: 'test',
        n: 3,
        buildAgentRequest: () => ({}),
      }),
    ).rejects.toThrow('quota exceeded')
    expect(mockedStream).not.toHaveBeenCalled()
  })

  it('cleans up orphan branches when Phase 1 fails partway through (review fix)', async () => {
    // Bug found in /review of v0.3.7: if branch create fails on variant 3
    // of 5, branches 1 and 2 were leaked. They're now deleted as cleanup.
    const created: Array<{ id: string; name: string }> = []
    const create = vi
      .fn()
      .mockImplementationOnce(async ({ name }: { name: string }) => {
        const b = { id: 'b1', name }
        created.push(b)
        return { branch: b }
      })
      .mockImplementationOnce(async ({ name }: { name: string }) => {
        const b = { id: 'b2', name }
        created.push(b)
        return { branch: b }
      })
      .mockRejectedValueOnce(new Error('quota exceeded'))
    const deleteFn = vi.fn(async () => ({ ok: true }))
    installBranchIpc({ create, delete: deleteFn })

    await expect(
      spawnAgentVariants({
        projectId: 'p',
        sourceBranchId: 's',
        prompt: 'test',
        n: 5,
        buildAgentRequest: () => ({}),
      }),
    ).rejects.toThrow('quota exceeded')

    // The two successfully-created branches should both be deleted.
    expect(deleteFn).toHaveBeenCalledTimes(2)
    const deletedIds = (deleteFn.mock.calls as unknown as Array<[{ projectId: string; id: string }]>)
      .map((c) => c[0].id)
      .sort()
    expect(deletedIds).toEqual(['b1', 'b2'])
    // No agent runs fired.
    expect(mockedStream).not.toHaveBeenCalled()
  })

  it('cleans up orphan branches when Phase 1 aborts partway through (review fix)', async () => {
    // Same bug, abort path. Each create is slow enough that an abort can
    // fire between branches.
    const create = vi.fn(async ({ name }: { name: string }) => {
      await new Promise((r) => setTimeout(r, 4))
      return { branch: { id: `${name}-id`, name } }
    })
    const deleteFn = vi.fn(async () => ({ ok: true }))
    installBranchIpc({ create, delete: deleteFn })

    const controller = new AbortController()
    const promise = spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 5,
      buildAgentRequest: () => ({}),
      signal: controller.signal,
    })
    // Abort after roughly two branches were created.
    setTimeout(() => controller.abort(), 9)

    await expect(promise).rejects.toThrow(/Aborted/)
    // At least one branch should have been created AND then cleaned up.
    expect(create.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(deleteFn.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(deleteFn.mock.calls.length).toBe(create.mock.calls.length)
  })

  it('cleanup is best-effort — a delete failure does NOT mask the original error (review fix)', async () => {
    // If quota fails AND cleanup fails too, the user should still see the
    // original quota error, not a misleading cleanup error.
    const create = vi
      .fn()
      .mockResolvedValueOnce({ branch: { id: 'b1', name: 'x-v1' } })
      .mockRejectedValueOnce(new Error('quota exceeded'))
    const deleteFn = vi.fn().mockRejectedValue(new Error('delete failed (network)'))
    installBranchIpc({ create, delete: deleteFn })

    await expect(
      spawnAgentVariants({
        projectId: 'p',
        sourceBranchId: 's',
        prompt: 'test',
        n: 3,
        buildAgentRequest: () => ({}),
      }),
    ).rejects.toThrow('quota exceeded') // NOT 'delete failed'
    expect(deleteFn).toHaveBeenCalledTimes(1)
  })

  it('respects abort signal mid-creation', async () => {
    const create = vi.fn(async ({ name }: { name: string }) => {
      // Slow create to give the abort time to fire
      await new Promise((r) => setTimeout(r, 5))
      return { branch: { id: `${name}-id`, name } }
    })
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })

    const controller = new AbortController()
    const promise = spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 5,
      buildAgentRequest: () => ({}),
      signal: controller.signal,
    })
    // Abort after the first create completes.
    setTimeout(() => controller.abort(), 8)

    await expect(promise).rejects.toThrow(/Aborted/)
  })

  it('respects abort signal mid-run (parallel batch — in-flight variants get aborted)', async () => {
    const create = vi.fn(async ({ name }: { name: string }) => ({ branch: { id: `${name}-id`, name } }))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })
    // Each variant's stream waits 50ms but listens for its variantController
    // abort signal — the orchestrator forwards the outer signal to each.
    mockedStream.mockImplementation(async (_body: any, { signal }: any) => {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
        const t = setTimeout(resolve, 50)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true },
        )
      })
    })

    const controller = new AbortController()
    const promise = spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 3,
      buildAgentRequest: () => ({}),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 15)

    const results = await promise
    // All 3 variants should be marked failed — they were aborted in-flight.
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'failed')).toBe(true)
  })

  it('emits creating events sequentially (Phase 1) then running events for the parallel batch', async () => {
    const create = vi.fn(async ({ name }: { name: string }) => ({ branch: { id: `${name}-id`, name } }))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })
    mockedStream.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'))

    const progress: Array<[number, string]> = []
    await spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 2,
      buildAgentRequest: () => ({}),
      onProgress: (i, status) => progress.push([i, status]),
    })

    // Phase 1 (creating) is still sequential — avoids name-collision races.
    // Phase 2 (running) is parallel within a batch — both 'running' events
    // fire BEFORE either completes, then 'done'/'failed' fire as they settle
    // (in promise resolution order, which here is the mock's order).
    expect(progress).toEqual([
      [0, 'creating'],
      [1, 'creating'],
      [0, 'running'],
      [1, 'running'],
      [0, 'done'],
      [1, 'failed'],
    ])
  })

  it('runs variants in parallel within a batch (v0.3.8 — per-branch lock unlock)', async () => {
    // Verifies the parallelism contract: with n=4 (which fits in one batch
    // of MAX_PARALLEL_VARIANTS), all four streams should be IN FLIGHT
    // before any completes. With sequential execution, we'd see one
    // in-flight at a time.
    const create = vi.fn(async ({ name }: { name: string }) => ({ branch: { id: `${name}-id`, name } }))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })

    let inFlight = 0
    let peakInFlight = 0
    mockedStream.mockImplementation(async () => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      // Yield so other batch members can start before we complete.
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
    })

    const results = await spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 4,
      buildAgentRequest: () => ({}),
    })

    expect(results).toHaveLength(4)
    expect(results.every((r) => r.status === 'success')).toBe(true)
    // All 4 streams should have been in flight simultaneously (parallel within batch).
    expect(peakInFlight).toBe(4)
  })

  it('does not leak abort listeners when buildAgentRequest throws (v0.3.8 review fix)', async () => {
    // Review finding: addEventListener was called BEFORE the try block
    // that contained removeEventListener in finally. If buildAgentRequest
    // threw, the listener was leaked. Now addEventListener is inside the
    // try, AFTER buildAgentRequest, so a throw short-circuits cleanly.
    const create = vi.fn(async ({ name }: { name: string }) => ({ branch: { id: `${name}-id`, name } }))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })

    const controller = new AbortController()
    let listenersAdded = 0
    let listenersRemoved = 0
    const origAdd = controller.signal.addEventListener.bind(controller.signal)
    const origRemove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
      if (args[0] === 'abort') listenersAdded++
      return origAdd(...args)
    }) as typeof controller.signal.addEventListener
    controller.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
      if (args[0] === 'abort') listenersRemoved++
      return origRemove(...args)
    }) as typeof controller.signal.removeEventListener

    const results = await spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 3,
      buildAgentRequest: () => {
        throw new Error('build threw')
      },
      signal: controller.signal,
    })

    expect(results.every((r) => r.status === 'failed')).toBe(true)
    expect(results.every((r) => r.error === 'build threw')).toBe(true)
    // The fix: no listener was added because buildAgentRequest threw FIRST.
    // Pre-fix would have shown listenersAdded > 0 with no matching removes.
    expect(listenersAdded).toBe(0)
    expect(listenersRemoved).toBe(0)
  })

  it('batches variants when n exceeds MAX_PARALLEL_VARIANTS', async () => {
    // n=8 should run as two parallel batches of 4 (cap at MAX_PARALLEL_VARIANTS).
    const create = vi.fn(async ({ name }: { name: string }) => ({ branch: { id: `${name}-id`, name } }))
    installBranchIpc({ create, delete: vi.fn(async () => ({ ok: true })) })

    let inFlight = 0
    let peakInFlight = 0
    mockedStream.mockImplementation(async () => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })

    const results = await spawnAgentVariants({
      projectId: 'p',
      sourceBranchId: 's',
      prompt: 'test',
      n: 8,
      buildAgentRequest: () => ({}),
    })

    expect(results).toHaveLength(8)
    expect(results.every((r) => r.status === 'success')).toBe(true)
    // Cap enforced — at most 4 in flight at any moment.
    expect(peakInFlight).toBe(__testing.MAX_PARALLEL_VARIANTS)
  })

  it('throws when branches IPC is unavailable (web build / pre-runtime)', async () => {
    uninstallBranchIpc()
    await expect(
      spawnAgentVariants({
        projectId: 'p',
        sourceBranchId: 's',
        prompt: 'test',
        n: 2,
        buildAgentRequest: () => ({}),
      }),
    ).rejects.toThrow(/desktop runtime/)
  })

  it('slugify produces url-safe short names with fallback', () => {
    expect(__testing.slugify('Make a Hero Scene!')).toBe('make-a-hero-scene')
    expect(__testing.slugify('   ')).toBe('variant') // empty fallback
    expect(__testing.slugify('a'.repeat(50), 10).length).toBe(10)
  })
})
