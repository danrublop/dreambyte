import { describe, it, expect, vi } from 'vitest'
import { planCrossProjectLegs, runCrossProjectDispatch, type CrossProjectDispatchDeps } from './cross-project-dispatch'
import type { TargetProjectRow } from '@/lib/services/resolve-leg-body'
import type { AgentAPIRequest } from '@/lib/services/agent-runner'

describe('planCrossProjectLegs', () => {
  it('dedupes targets and splits the group budget evenly', () => {
    const legs = planCrossProjectLegs(['B', 'B', 'C'], 'A', 10)
    expect(legs).toEqual([
      { targetProjectId: 'B', budgetUsd: 5 },
      { targetProjectId: 'C', budgetUsd: 5 },
    ])
  })

  it('excludes the origin project (a leg targeting origin is identity, not cross-project)', () => {
    const legs = planCrossProjectLegs(['A', 'B'], 'A', 12)
    expect(legs).toEqual([{ targetProjectId: 'B', budgetUsd: 12 }]) // origin dropped → 1 leg gets full budget
  })

  it('returns [] when no distinct non-origin targets remain', () => {
    expect(planCrossProjectLegs(['A', 'A'], 'A', 10)).toEqual([])
    expect(planCrossProjectLegs([], 'A', 10)).toEqual([])
  })

  it('applies a default group ceiling when no group budget is set (P2)', () => {
    // Small broadcast: each leg keeps the per-run default ($25); total ($50) ≤ ceiling.
    expect(planCrossProjectLegs(['B', 'C'], 'A', null)).toEqual([
      { targetProjectId: 'B', budgetUsd: 25 },
      { targetProjectId: 'C', budgetUsd: 25 },
    ])
    expect(planCrossProjectLegs(['B'], 'A', undefined)).toEqual([{ targetProjectId: 'B', budgetUsd: 25 }])
  })

  it('bounds a wide broadcast total by the default group ceiling (P2)', () => {
    // Before the fix a 24-leg broadcast with no group budget ran 24 × $25 = $600
    // uncapped. Now the aggregate is bounded at $150 and no leg exceeds $25.
    const targets = Array.from({ length: 24 }, (_, i) => `t${i}`)
    const legs = planCrossProjectLegs(targets, 'A', null)
    expect(legs).toHaveLength(24)
    const total = legs.reduce((sum, l) => sum + (l.budgetUsd ?? 0), 0)
    expect(total).toBeLessThanOrEqual(150 + 1e-9)
    expect(legs.every((l) => (l.budgetUsd ?? 0) <= 25)).toBe(true)
    expect(legs[0].budgetUsd).toBeCloseTo(150 / 24)
  })

  it('an explicit group budget still splits evenly, ignoring the default ceiling', () => {
    // Explicit $12 across 24 legs → $0.50 each (not the default ceiling).
    const targets = Array.from({ length: 24 }, (_, i) => `t${i}`)
    const legs = planCrossProjectLegs(targets, 'A', 12)
    expect(legs.every((l) => l.budgetUsd === 0.5)).toBe(true)
  })

  it('drops empty/falsy target ids', () => {
    expect(planCrossProjectLegs(['', 'B'], 'A', undefined)).toEqual([{ targetProjectId: 'B', budgetUsd: 25 }])
  })
})

// ── orchestrator ──

function makeTargetRow(id: string): TargetProjectRow {
  return {
    apiPermissions: { elevenLabs: 'deny' } as unknown as TargetProjectRow['apiPermissions'],
    audioProviderEnabled: {},
    mediaGenEnabled: {},
    globalStyle: { presetId: null } as TargetProjectRow['globalStyle'],
    projectName: `Project ${id}`,
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: '' } as TargetProjectRow['sceneGraph'],
    scenes: [{ id: `${id}-scene` }] as TargetProjectRow['scenes'],
    defaultBranchId: `${id}-branch`,
  }
}

function makeOriginBody(): AgentAPIRequest {
  return {
    message: 'origin instruction',
    scenes: [{ id: 'a-scene' }] as AgentAPIRequest['scenes'],
    globalStyle: { presetId: null } as AgentAPIRequest['globalStyle'],
    projectName: 'Project A',
    outputMode: 'mp4',
    projectId: 'A',
    modelConfigs: [{ id: 'm1', enabled: true }] as AgentAPIRequest['modelConfigs'],
  }
}

function makeDeps(overrides: Partial<CrossProjectDispatchDeps> = {}): CrossProjectDispatchDeps {
  let n = 0
  let t = 0
  return {
    loadTargetRow: vi.fn(async (id: string) => (id === 'missing' ? null : makeTargetRow(id))),
    ensureDefaultBranch: vi.fn(async (id: string) => `${id}-branch`),
    reserveRunSlot: vi.fn(() => ({ ok: true })),
    releaseRunSlot: vi.fn(),
    // Cross-process run lease (P1-5): free by default so existing legs run.
    acquireRunLease: vi.fn(async () => ({ acquired: true as const })),
    heartbeatRunLease: vi.fn(async () => true),
    releaseRunLease: vi.fn(async () => {}),
    mintRunLeaseToken: vi.fn(() => `token-${++t}`),
    leaseHeartbeatMs: 10_000,
    leaseInstanceId: 'test-window',
    resolveOwnerUserId: vi.fn(async () => 'owner-of-target'),
    runAgentRequest: vi.fn(async () => {}),
    emitLegEvent: vi.fn(),
    newRunId: () => `run-${++n}`,
    ...overrides,
  }
}

const input = (over: Partial<Parameters<typeof runCrossProjectDispatch>[0]> = {}) => ({
  originBody: makeOriginBody(),
  targets: ['B', 'C'],
  instruction: 'apply the fix',
  groupBudgetUsd: 10,
  groupId: 'g1',
  abortSignal: new AbortController().signal,
  ...over,
})

describe('runCrossProjectDispatch', () => {
  it('fires one runAgentRequest per target, each with B/C own projectId + scenes + the broadcast instruction + per-leg budget', async () => {
    const deps = makeDeps()
    const { outcomes, settled } = await runCrossProjectDispatch(input(), deps)
    await settled
    expect(outcomes.map((o) => o.status)).toEqual(['started', 'started'])
    expect(deps.runAgentRequest).toHaveBeenCalledTimes(2)
    const bodies = (deps.runAgentRequest as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].body)
    expect(bodies.map((b: AgentAPIRequest) => b.projectId)).toEqual(['B', 'C'])
    expect(bodies.every((b: AgentAPIRequest) => b.message === 'apply the fix')).toBe(true)
    expect(bodies[0].scenes).toEqual([{ id: 'B-scene' }]) // B's own scenes, not A's
    expect(bodies.every((b: AgentAPIRequest) => b.runBudgetUsd === 5)).toBe(true) // 10 / 2
    expect(bodies[0].branchId).toBe('B-branch') // B's default branch, not A's
    expect(bodies.every((b: AgentAPIRequest) => b.disableFanout === true)).toBe(true) // legs can't recursively spawn
  })

  it('tags every emitted event with groupId + targetProjectId + runId (separate-consumer routing)', async () => {
    const deps = makeDeps({ runAgentRequest: vi.fn(async (o) => o.emit({ type: 'thinking_token', token: 'x' })) })
    const { settled } = await runCrossProjectDispatch(input({ targets: ['B'] }), deps)
    await settled
    expect(deps.emitLegEvent).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g1', targetProjectId: 'B', runId: 'run-1' }),
    )
  })

  it('skips an unreadable target (loader → null): reserves then releases its slot, no run, surfaces an error', async () => {
    const deps = makeDeps()
    const { outcomes, settled } = await runCrossProjectDispatch(input({ targets: ['missing', 'B'] }), deps)
    await settled
    expect(outcomes.find((o) => o.targetProjectId === 'missing')?.status).toBe('unreadable')
    expect(deps.runAgentRequest).toHaveBeenCalledTimes(1) // only B ran
    // reserve-before-resolve: both reserved; the unreadable one is released immediately.
    expect(deps.reserveRunSlot).toHaveBeenCalledTimes(2)
    expect(deps.releaseRunSlot).toHaveBeenCalledWith('missing', 'missing-branch')
    expect(deps.emitLegEvent).toHaveBeenCalledWith(
      expect.objectContaining({ targetProjectId: 'missing', event: expect.objectContaining({ type: 'error' }) }),
    )
  })

  it('checks abort between legs: an already-aborted signal launches no legs', async () => {
    const ac = new AbortController()
    ac.abort()
    const deps = makeDeps()
    const { outcomes, settled } = await runCrossProjectDispatch(input({ abortSignal: ac.signal }), deps)
    await settled
    expect(outcomes.every((o) => o.status === 'aborted')).toBe(true)
    expect(deps.runAgentRequest).not.toHaveBeenCalled()
    expect(deps.reserveRunSlot).not.toHaveBeenCalled()
  })

  // The pre-launch check above only stops legs that HAVEN'T started. Stop pressed
  // while legs are already running has to reach INTO each running leg — which it
  // can only do if the group's signal is the same object handed to runAgentRequest.
  // Nothing asserted that before, so a dropped `abortSignal` here would have been a
  // silent, untestable "Stop does nothing" for every dispatched leg.
  it('hands the group abort signal to every launched leg, so Stop reaches a leg already running', async () => {
    const ac = new AbortController()
    const deps = makeDeps()
    const { settled } = await runCrossProjectDispatch(input({ abortSignal: ac.signal }), deps)
    await settled
    const calls = (deps.runAgentRequest as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    for (const [arg] of calls) expect(arg.abortSignal).toBe(ac.signal)
    // …and aborting the group flips the very signal the legs are holding.
    ac.abort()
    expect(calls.every(([arg]) => arg.abortSignal.aborted)).toBe(true)
  })

  it('emits a tagged __stream_end__ sentinel per started leg (with originProjectId)', async () => {
    const deps = makeDeps()
    const { settled } = await runCrossProjectDispatch(input({ targets: ['B'] }), deps)
    await settled
    expect(deps.emitLegEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        originProjectId: 'A',
        targetProjectId: 'B',
        event: expect.objectContaining({ type: '__stream_end__' }),
      }),
    )
  })

  it('skips a busy target (slot taken): no run for it', async () => {
    const reserveRunSlot = vi.fn((projectId?: string) => ({ ok: projectId !== 'B' }))
    const deps = makeDeps({ reserveRunSlot })
    const { outcomes, settled } = await runCrossProjectDispatch(input(), deps)
    await settled
    expect(outcomes.find((o) => o.targetProjectId === 'B')?.status).toBe('slot-busy')
    expect(deps.runAgentRequest).toHaveBeenCalledTimes(1) // only C ran
  })

  it('releases each started leg slot when its run completes', async () => {
    const deps = makeDeps()
    const { settled } = await runCrossProjectDispatch(input(), deps)
    await settled
    expect(deps.releaseRunSlot).toHaveBeenCalledTimes(2)
    expect(deps.releaseRunSlot).toHaveBeenCalledWith('B', 'B-branch')
  })

  it('contains a post-reserve owner-lookup failure: releases the slot, no run, dispatch survives', async () => {
    const resolveOwnerUserId = vi.fn(async (id?: string) => {
      if (id === 'B') throw new Error('owner lookup failed')
      return 'owner'
    })
    const deps = makeDeps({ resolveOwnerUserId })
    const { outcomes, settled } = await runCrossProjectDispatch(input(), deps) // targets B, C
    await settled
    // B's owner lookup threw AFTER reserving B's slot → released + skipped, not run.
    // C is unaffected. The dispatch did not throw (failure contained).
    expect(deps.runAgentRequest).toHaveBeenCalledTimes(1) // only C ran
    expect(deps.releaseRunSlot).toHaveBeenCalledWith('B', 'B-branch') // B's slot released despite no run
    expect(outcomes.find((o) => o.targetProjectId === 'B')?.status).toBe('unreadable')
    expect(outcomes.find((o) => o.targetProjectId === 'C')?.status).toBe('started')
  })

  it('excludes the origin project from targets', async () => {
    const deps = makeDeps()
    const { outcomes, settled } = await runCrossProjectDispatch(input({ targets: ['A', 'B'] }), deps)
    await settled
    expect(outcomes.map((o) => o.targetProjectId)).toEqual(['B']) // 'A' (origin) dropped
  })

  it('throws when the origin body has no projectId', async () => {
    const deps = makeDeps()
    const bad = input({ originBody: { ...makeOriginBody(), projectId: undefined } })
    await expect(runCrossProjectDispatch(bad, deps)).rejects.toThrow(/projectId/)
  })

  // ── Cross-process run lease (P1-5) ──

  it('refuses a leg whose target branch already holds a cross-process lease (P1-5)', async () => {
    // FAIL-WITHOUT-FIX: before threading the lease, the dispatch never consulted
    // it, so B would run concurrently with the window that already holds it.
    const acquireRunLease = vi.fn(async (projectId?: string) =>
      projectId === 'B'
        ? { acquired: false as const, heldBy: { instanceId: 'other-window', pid: 42, ageMs: 5000 } }
        : { acquired: true as const },
    )
    const deps = makeDeps({ acquireRunLease })
    const { outcomes, settled } = await runCrossProjectDispatch(input(), deps) // targets B, C
    await settled
    expect(outcomes.find((o) => o.targetProjectId === 'B')?.status).toBe('lease-held')
    // B is refused; only C actually runs — no concurrent run on the held branch.
    expect(deps.runAgentRequest).toHaveBeenCalledTimes(1)
    const ranProjects = (deps.runAgentRequest as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].body.projectId)
    expect(ranProjects).not.toContain('B')
    // In-memory slot released; the DB lease we never acquired is NOT released.
    expect(deps.releaseRunSlot).toHaveBeenCalledWith('B', 'B-branch')
    expect(deps.releaseRunLease).not.toHaveBeenCalledWith('B', 'B-branch', expect.anything())
    expect(deps.emitLegEvent).toHaveBeenCalledWith(
      expect.objectContaining({ targetProjectId: 'B', event: expect.objectContaining({ type: 'error' }) }),
    )
  })

  it('acquires + releases the cross-process lease per started leg, token-matched (P1-5)', async () => {
    const acquireRunLease = vi.fn(async () => ({ acquired: true as const }))
    const releaseRunLease = vi.fn(async () => {})
    const deps = makeDeps({ acquireRunLease, releaseRunLease })
    const { settled } = await runCrossProjectDispatch(input(), deps) // B, C
    await settled
    expect(acquireRunLease).toHaveBeenCalledTimes(2)
    expect(releaseRunLease).toHaveBeenCalledTimes(2)
    // Each leg's release used the SAME per-leg owner token as its acquire — so a
    // TTL-reclaimed row now owned by another window can never be freed by us.
    for (const call of acquireRunLease.mock.calls) {
      const [projectId, branchId, opts] = call as unknown as [string, string, { ownerToken: string }]
      expect(releaseRunLease).toHaveBeenCalledWith(projectId, branchId, opts.ownerToken)
    }
    // Distinct token per leg (no aliasing across concurrent legs).
    const tokens = acquireRunLease.mock.calls.map(
      (c) => (c as unknown as [string, string, { ownerToken: string }])[2].ownerToken,
    )
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('refuses a leg when the lease query itself errors — never runs unguarded (P1-5)', async () => {
    const acquireRunLease = vi.fn(async (projectId?: string) => {
      if (projectId === 'B') throw new Error('db down')
      return { acquired: true as const }
    })
    const deps = makeDeps({ acquireRunLease })
    const { outcomes, settled } = await runCrossProjectDispatch(input(), deps) // B, C
    await settled
    expect(outcomes.find((o) => o.targetProjectId === 'B')?.status).toBe('lease-error')
    expect(deps.runAgentRequest).toHaveBeenCalledTimes(1) // only C ran
    expect(deps.releaseRunSlot).toHaveBeenCalledWith('B', 'B-branch') // slot not leaked
  })

  it('heartbeats the lease on the wall clock while a leg runs — loop-decoupled (P1-5)', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const heartbeatRunLease = vi.fn(async () => true)
      const deps = makeDeps({
        heartbeatRunLease,
        leaseHeartbeatMs: 1000,
        runAgentRequest: vi.fn(() => gate), // leg stays mid-run until released
      })
      const { settled } = await runCrossProjectDispatch(input({ targets: ['B'] }), deps)
      // Leg is blocked mid-run; advancing wall time must still fire heartbeats.
      await vi.advanceTimersByTimeAsync(3500)
      expect(heartbeatRunLease).toHaveBeenCalledWith('B', 'B-branch', expect.any(String))
      expect(heartbeatRunLease.mock.calls.length).toBeGreaterThanOrEqual(3)
      release()
      await vi.runAllTimersAsync()
      await settled
      // Heartbeat stops once the leg finishes (interval cleared in the .finally).
      const afterFinish = heartbeatRunLease.mock.calls.length
      await vi.advanceTimersByTimeAsync(3000)
      expect(heartbeatRunLease.mock.calls.length).toBe(afterFinish)
    } finally {
      vi.useRealTimers()
    }
  })
})
