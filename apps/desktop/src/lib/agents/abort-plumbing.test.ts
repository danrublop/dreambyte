// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A1 abort plumbing — Stop must actually stop work, not just stop the runner
 * from STARTING new iterations:
 *  - executeTool refuses to start a tool once the run's signal is aborted
 *    (defense in depth at the one choke point every tool passes through —
 *    covers callers without their own per-block checks: sub-agent worlds,
 *    parallel-batch isolated worlds, direct callers).
 *  - withTimeout races the signal and rejects with name='AbortError', which
 *    isRetryableError must never retry and mapToolError must render as a
 *    clean cancellation, not a crash.
 *  - generateLayerContent never starts a paid generation post-abort, and
 *    DISCARDS a result whose abort landed mid-call — that discard is what
 *    keeps stale scene writes from landing after Stop.
 *  - captureOneFrame neither opens a round-trip post-abort nor waits out its
 *    timeout when the abort lands mid-flight.
 */

vi.mock('../generation/generate', () => ({
  generateCode: vi.fn(),
}))

import { generateCode } from '../generation/generate'
import {
  executeTool,
  generateLayerContent,
  regenerateHTML,
  setWorldAbortSignal,
  getWorldAbortSignal,
  isAbortResult,
  abortResult,
  type WorldStateMutable,
} from './tool-executor'
import { captureOneFrame, resolvePendingCapture } from './pending-captures'
import { withTimeout, isRetryableError, mapToolError } from './runner'
import type { AgentLogger } from './logger'
import { createDefaultProject, createDefaultScene } from '../store/helpers'

function oneSceneWorld(): WorldStateMutable {
  const scene = { ...createDefaultScene(), id: 'scene-1', name: 'Scene 1' }
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([scene]).sceneGraph,
  }
}

describe('executeTool abort gate', () => {
  it('refuses to start a tool when the world signal is already aborted', async () => {
    const world = oneSceneWorld()
    const controller = new AbortController()
    setWorldAbortSignal(world, controller.signal)
    controller.abort()

    const result = await executeTool('scene_props', { op: 'duration', sceneId: 'scene-1', duration: 11 }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/aborted/i)
    // The canonical abort marker rides the result so the UI renders
    // "Cancelled" (not a red error) and accounting can branch on it.
    expect(isAbortResult(result)).toBe(true)
    // The mutation never ran.
    expect(world.scenes[0].duration).not.toBe(11)
  })

  it('executes normally while the signal is live', async () => {
    const world = oneSceneWorld()
    const controller = new AbortController()
    setWorldAbortSignal(world, controller.signal)

    const result = await executeTool('scene_props', { op: 'duration', sceneId: 'scene-1', duration: 12 }, world)
    expect(result.success).toBe(true)
    expect(world.scenes[0].duration).toBe(12)
  })

  it('keeps signals isolated per world (parallel sub-agents)', async () => {
    const worldA = oneSceneWorld()
    const worldB = oneSceneWorld()
    const ctrlA = new AbortController()
    const ctrlB = new AbortController()
    setWorldAbortSignal(worldA, ctrlA.signal)
    setWorldAbortSignal(worldB, ctrlB.signal)
    ctrlA.abort()

    expect(getWorldAbortSignal(worldA)?.aborted).toBe(true)
    expect(getWorldAbortSignal(worldB)?.aborted).toBe(false)
    // B still executes even though A is aborted.
    const result = await executeTool('scene_props', { op: 'duration', sceneId: 'scene-1', duration: 9 }, worldB)
    expect(result.success).toBe(true)
  })

  it('re-registers the abort signal on a JSON-cloned isolated world (parallel batch)', async () => {
    // Mirrors the production parallel-batch path: cloning drops the WeakMap
    // association; the runner must re-register or batch tools never abort.
    const world = oneSceneWorld()
    const controller = new AbortController()
    setWorldAbortSignal(world, controller.signal)
    const clone = JSON.parse(JSON.stringify(world)) as WorldStateMutable
    expect(getWorldAbortSignal(clone)).toBeUndefined() // clone dropped the entry

    setWorldAbortSignal(clone, controller.signal)
    controller.abort()
    const result = await executeTool('scene_props', { op: 'duration', sceneId: 'scene-1', duration: 11 }, clone)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/aborted/i)
  })
})

describe('withTimeout abort race', () => {
  it('rejects with AbortError immediately for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(withTimeout(new Promise(() => {}), 8000, 'tool:x', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('rejects with AbortError when abort fires mid-flight, long before the timeout', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const pending = withTimeout(new Promise(() => {}), 8000, 'tool:x', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('resolves normally when neither abort nor timeout fires', async () => {
    const controller = new AbortController()
    await expect(withTimeout(Promise.resolve(42), 8000, 'tool:x', controller.signal)).resolves.toBe(42)
  })
})

describe('abort retry/crash mapping', () => {
  it('never classifies an AbortError as retryable', () => {
    expect(isRetryableError(Object.assign(new Error('Run aborted: tool:x'), { name: 'AbortError' }))).toBe(false)
  })

  it('still retries transient timeouts (guard did not break existing behavior)', () => {
    expect(isRetryableError(new Error('Timeout after 8000ms: tool:x'))).toBe(true)
  })

  it('maps AbortError to a cancellation result without logging a crash', () => {
    const logger = { error: vi.fn(), log: vi.fn() } as unknown as AgentLogger
    const result = mapToolError(Object.assign(new Error('Run aborted: tool:x'), { name: 'AbortError' }), 'scene_props', logger)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cancelled/i)
    expect(isAbortResult(result)).toBe(true)
    expect((logger as unknown as { error: ReturnType<typeof vi.fn> }).error).not.toHaveBeenCalled()
  })

  it('genuine failures are NOT abort results (UI keeps the red error badge)', () => {
    const result = mapToolError(new Error('boom'), 'scene_props')
    expect(isAbortResult(result)).toBe(false)
    expect(isAbortResult(abortResult('Run aborted by user'))).toBe(true)
  })

  it('maps a genuine crash to a failure result and logs it', () => {
    const logger = { error: vi.fn(), log: vi.fn() } as unknown as AgentLogger
    const result = mapToolError(new Error('boom'), 'scene_props', logger)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/failed/i)
    expect((logger as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled()
  })
})

describe('generateLayerContent abort handling', () => {
  const scene = { ...createDefaultScene(), id: 'scene-1' }
  const style = { presetId: null } as unknown as Parameters<typeof generateLayerContent>[3]

  // Each test owns its mock state — no order coupling between tests.
  beforeEach(() => {
    vi.mocked(generateCode).mockReset()
  })

  it('does not start a generation for an already-aborted run', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await generateLayerContent(
      'react',
      'a scene',
      scene,
      style,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not started/i)
    expect(generateCode).not.toHaveBeenCalled()
  })

  it('discards a generation whose abort landed mid-call (no stale write)', async () => {
    const controller = new AbortController()
    vi.mocked(generateCode).mockImplementation(async () => {
      // Simulate the user pressing Stop while the provider call is in flight.
      controller.abort()
      return { code: 'const x = 1 // perfectly good code' } as Awaited<ReturnType<typeof generateCode>>
    })

    const result = await generateLayerContent(
      'react',
      'a scene',
      scene,
      style,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/discarded/i)
  })

  it('returns the generation when no abort happened', async () => {
    vi.mocked(generateCode).mockResolvedValue({ code: 'const ok = true' } as Awaited<ReturnType<typeof generateCode>>)
    const controller = new AbortController()

    const result = await generateLayerContent(
      'react',
      'a scene',
      scene,
      style,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    )
    expect(result.success).toBe(true)
    expect(result.code).toBe('const ok = true')
  })
})

describe('regenerateHTML persist-boundary gate', () => {
  it('skips the in-memory sceneHTML mutation and the disk write when the run is aborted', async () => {
    // regenerateHTML is the single disk-write choke point every mutating
    // handler funnels through — gating here is what stops an IN-FLIGHT tool
    // (dispatched before Stop) from flipping the on-disk preview after Stop.
    const world = oneSceneWorld()
    const controller = new AbortController()
    setWorldAbortSignal(world, controller.signal)
    controller.abort()

    const before = world.scenes[0].sceneHTML
    const result = await regenerateHTML(world, 'scene-1')
    expect(result.htmlWritten).toBe(false)
    expect(result.error).toMatch(/aborted/i)
    expect(world.scenes[0].sceneHTML).toBe(before) // mutation skipped too
  })
})

describe('captureOneFrame abort handling', () => {
  it('returns null immediately for an already-aborted run (no capture_request emitted)', async () => {
    const controller = new AbortController()
    controller.abort()
    const emit = vi.fn()

    const result = await captureOneFrame('scene-1', 1, emit, 8000, controller.signal)
    expect(result).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('resolves promptly (not at timeout) when the abort lands mid-flight', async () => {
    const controller = new AbortController()
    const emit = vi.fn()

    const start = Date.now()
    const pending = captureOneFrame('scene-1', 1, emit, 8000, controller.signal)
    controller.abort()
    const result = await pending
    expect(result).toBeNull()
    expect(Date.now() - start).toBeLessThan(1000) // nowhere near the 8s timeout
    expect(emit).toHaveBeenCalledTimes(1) // the request DID go out pre-abort
  })

  it('still resolves a normal capture with no abort', async () => {
    const controller = new AbortController()
    let captureId = ''
    const emit = vi.fn((e: { captureId: string }) => {
      captureId = e.captureId
    })

    const pending = captureOneFrame('scene-1', 1, emit, 8000, controller.signal)
    resolvePendingCapture(captureId, 'data:image/jpeg;base64,xxx')
    const result = await pending
    expect(result?.dataUri).toBe('data:image/jpeg;base64,xxx')
  })
})
