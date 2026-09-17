/**
 * Phase 1 / Lane 1 (media orchestration): the renderer-side video completion poller.
 *
 * The agent inserts a veo3 layer with status:'generating' + operationName but never runs a
 * renderer poll loop — so agent-generated clips used to spin forever (the demo-killer).
 * `reconcilePendingVideoPolls()` walks the current scenes and starts `pollVeo3Status` for
 * any generating clip that lacks a running loop (dedup by operationName). The Editor fires
 * it on every scenes change, so it also RESUMES clips rehydrated by loadProject on restart.
 *
 * These tests pin: completion (generating→ready), failure (generating→error), dedup (two
 * reconciles → one poll loop), rehydrate (a pre-existing generating layer gets polled), and
 * that non-generating / non-video layers are ignored.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGenerationActions } from './generation-actions'

type PollResult = { done?: boolean; videoUrl?: string; error?: string }

function veo3Layer(id: string, operationName: string | null, status = 'generating') {
  return { id, type: 'veo3', status, operationName, prompt: 'a cat', videoUrl: null }
}

/**
 * Build a store harness wired to the real generation actions. `pollVideo` is the mocked IPC
 * the poll loop hits; `updateAILayer`/`saveSceneHTML` are stubbed so we observe transitions
 * without dragging in the real HTML regen path. The real pollVeo3Status + reconcile run.
 */
function makeHarness(pollVideo: (args: { operationName: string }) => Promise<PollResult>) {
  const state: any = {
    project: { id: 'p1' },
    scenes: [] as any[],
    showTransientStatus: vi.fn(),
  }
  const get = () => state
  const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
  Object.assign(state, createGenerationActions(set as any, get as any))

  // Stub the two store actions the poll loop writes through, mutating the in-memory layer so
  // status reflects reality (and a completed layer stops matching the 'generating' filter).
  state.updateAILayer = vi.fn((sceneId: string, layerId: string, patch: Record<string, unknown>) => {
    const sc = state.scenes.find((s: any) => s.id === sceneId)
    const ly = sc?.aiLayers?.find((l: any) => l.id === layerId)
    if (ly) Object.assign(ly, patch)
  })
  state.saveSceneHTML = vi.fn(async () => {})

  const pollVideo_ = vi.fn(pollVideo)
  ;(globalThis as any).window = { dreambyteApi: { generate: { pollVideo: pollVideo_ } } }
  return { state, pollVideo: pollVideo_ }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  delete (globalThis as any).window
})

describe('reconcilePendingVideoPolls', () => {
  it('completes a generating clip: status → ready + videoUrl, saves the scene', async () => {
    const { state, pollVideo } = makeHarness(async () => ({ done: true, videoUrl: '/scenes/clip-ready.mp4' }))
    state.scenes = [{ id: 's1', aiLayers: [veo3Layer('L1', 'op-ready')] }]

    state.reconcilePendingVideoPolls()
    await vi.advanceTimersByTimeAsync(5000) // first poll fires at 5s

    expect(pollVideo).toHaveBeenCalledTimes(1)
    const layer = state.scenes[0].aiLayers[0]
    expect(layer.status).toBe('ready')
    expect(layer.videoUrl).toBe('/scenes/clip-ready.mp4')
    expect(state.saveSceneHTML).toHaveBeenCalledWith('s1')
  })

  it('fails loud: a provider error marks the layer error and does not save', async () => {
    const { state, pollVideo } = makeHarness(async () => ({ done: true, error: 'provider exploded' }))
    state.scenes = [{ id: 's1', aiLayers: [veo3Layer('L1', 'op-error')] }]

    state.reconcilePendingVideoPolls()
    await vi.advanceTimersByTimeAsync(5000)

    expect(pollVideo).toHaveBeenCalledTimes(1)
    expect(state.scenes[0].aiLayers[0].status).toBe('error')
    expect(state.saveSceneHTML).not.toHaveBeenCalled()
  })

  it('dedupes: two reconciles for the same op start exactly one poll loop', async () => {
    const { state, pollVideo } = makeHarness(async () => ({ done: false })) // still generating
    state.scenes = [{ id: 's1', aiLayers: [veo3Layer('L1', 'op-dedup')] }]

    state.reconcilePendingVideoPolls()
    state.reconcilePendingVideoPolls() // second call must NOT spawn a second loop

    await vi.advanceTimersByTimeAsync(5000)
    expect(pollVideo).toHaveBeenCalledTimes(1) // one loop polled once, not two
  })

  it('rehydrates: a pre-existing generating layer (loadProject) gets polled to completion', async () => {
    // Simulates restart — the layer is already 'generating' with an op from a prior session.
    const { state, pollVideo } = makeHarness(async () => ({ done: true, videoUrl: '/scenes/resumed.mp4' }))
    state.scenes = [{ id: 's9', aiLayers: [veo3Layer('Lold', 'op-resumed')] }]

    state.reconcilePendingVideoPolls()
    await vi.advanceTimersByTimeAsync(5000)

    expect(pollVideo).toHaveBeenCalledTimes(1)
    expect(state.scenes[0].aiLayers[0].status).toBe('ready')
    expect(state.scenes[0].aiLayers[0].videoUrl).toBe('/scenes/resumed.mp4')
  })

  it('ignores non-generating and non-video layers', async () => {
    const { state, pollVideo } = makeHarness(async () => ({ done: true, videoUrl: '/x.mp4' }))
    state.scenes = [
      { id: 's1', aiLayers: [veo3Layer('ready', 'op-x', 'ready')] }, // already ready
      { id: 's2', aiLayers: [{ id: 'img', type: 'image', status: 'generating' }] }, // not video
      { id: 's3', aiLayers: [veo3Layer('noop', null)] }, // generating but no operationName
    ]

    state.reconcilePendingVideoPolls()
    await vi.advanceTimersByTimeAsync(5000)

    expect(pollVideo).not.toHaveBeenCalled()
  })
})
