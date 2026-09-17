// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGenerationActions } from './generation-actions'

/**
 * Renderer-side HeyGen avatar reconcile (T1) — the durable half of the avatar
 * timeout. `get_avatar_status` enforces the 15-min deadline only while the agent
 * polls; once the run ends a wedged render sits 'processing' forever. The Editor
 * fires reconcilePendingAvatarPolls() on every scenes change, which keeps a
 * renderer poll alive for each processing avatar, applies the SAME scene-fit as
 * get_avatar_status on completion (no cutoff regression), and flips a wedged
 * render to error past the deadline.
 */

type HeygenResult = { status: string; videoUrl?: string; thumbnailUrl?: string; durationSeconds?: number; error?: string }

function avatarLayer(id: string, heygenVideoId: string | null, status = 'processing', extra: Record<string, unknown> = {}) {
  return { id, type: 'avatar', status, heygenVideoId, videoUrl: null, startAt: 0, renderStartedAt: Date.now(), ...extra }
}

function makeHarness(pollHeygen: (videoId: string) => Promise<HeygenResult>) {
  const state: any = { project: { id: 'p1' }, scenes: [] as any[], showTransientStatus: vi.fn() }
  const get = () => state
  const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
  Object.assign(state, createGenerationActions(set as any, get as any))

  state.updateAILayer = vi.fn((sceneId: string, layerId: string, patch: Record<string, unknown>) => {
    const ly = state.scenes.find((s: any) => s.id === sceneId)?.aiLayers?.find((l: any) => l.id === layerId)
    if (ly) Object.assign(ly, patch)
  })
  state.updateScene = vi.fn((sceneId: string, patch: Record<string, unknown>) => {
    const sc = state.scenes.find((s: any) => s.id === sceneId)
    if (sc) Object.assign(sc, patch)
  })
  state.saveSceneHTML = vi.fn(async () => {})

  const pollHeygen_ = vi.fn(pollHeygen)
  ;(globalThis as any).window = { dreambyteApi: { generate: { pollHeygen: pollHeygen_ } } }
  return { state, pollHeygen: pollHeygen_ }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  delete (globalThis as any).window
})

describe('reconcilePendingAvatarPolls', () => {
  it('completes a processing avatar: ready + videoUrl, saves', async () => {
    const { state, pollHeygen } = makeHarness(async () => ({ status: 'completed', videoUrl: '/a.mp4', thumbnailUrl: '/t.png' }))
    state.scenes = [{ id: 's1', duration: 8, aiLayers: [avatarLayer('L1', 'vid-ready')] }]
    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(pollHeygen).toHaveBeenCalledTimes(1)
    expect(state.scenes[0].aiLayers[0].status).toBe('ready')
    expect(state.scenes[0].aiLayers[0].videoUrl).toBe('/a.mp4')
    expect(state.saveSceneHTML).toHaveBeenCalledWith('s1')
  })

  it('CRITICAL: a renderer-completed avatar gets the same scene-fit as get_avatar_status (not cut off)', async () => {
    // 25s avatar in an 8s scene → the scene must EXTEND to 25, exactly like the
    // agent path. This is the regression a dumb pollVeo3-clone would have shipped.
    const { state } = makeHarness(async () => ({ status: 'completed', videoUrl: '/a.mp4', durationSeconds: 25 }))
    state.scenes = [{ id: 's1', duration: 8, aiLayers: [avatarLayer('L1', 'vid-long', 'processing', { startAt: 0 })] }]
    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.scenes[0].duration).toBe(25)
    expect(state.scenes[0].aiLayers[0].estimatedDuration).toBe(25)
  })

  it('does NOT shrink a scene already longer than the avatar', async () => {
    const { state } = makeHarness(async () => ({ status: 'completed', videoUrl: '/a.mp4', durationSeconds: 6 }))
    state.scenes = [{ id: 's1', duration: 20, aiLayers: [avatarLayer('L1', 'vid-short')] }]
    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.scenes[0].duration).toBe(20)
  })

  it('fails loud: a failed render → error, no save', async () => {
    const { state } = makeHarness(async () => ({ status: 'failed' }))
    state.scenes = [{ id: 's1', duration: 8, aiLayers: [avatarLayer('L1', 'vid-fail')] }]
    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.scenes[0].aiLayers[0].status).toBe('error')
    expect(state.saveSceneHTML).not.toHaveBeenCalled()
  })

  it('treats completed-without-videoUrl as a failure (matches get_avatar_status), not endless polling', async () => {
    const { state, pollHeygen } = makeHarness(async () => ({ status: 'completed' /* no videoUrl */ }))
    state.scenes = [{ id: 's1', duration: 8, aiLayers: [avatarLayer('L1', 'vid-noresult')] }]
    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(pollHeygen).toHaveBeenCalledTimes(1)
    expect(state.scenes[0].aiLayers[0].status).toBe('error')
    expect(state.showTransientStatus).toHaveBeenCalled()
  })

  it('dedupes: two reconciles for the same videoId start one loop', async () => {
    const { state, pollHeygen } = makeHarness(async () => ({ status: 'processing' }))
    state.scenes = [{ id: 's1', duration: 8, aiLayers: [avatarLayer('L1', 'vid-dedup')] }]
    state.reconcilePendingAvatarPolls()
    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(pollHeygen).toHaveBeenCalledTimes(1)
  })

  it('durable deadline: a render past 15 min flips to error with no agent', async () => {
    const { state, pollHeygen } = makeHarness(async () => ({ status: 'processing' }))
    const startedAt = Date.now() - 16 * 60 * 1000
    state.scenes = [{ id: 's1', duration: 8, aiLayers: [avatarLayer('L1', 'vid-stuck', 'processing', { renderStartedAt: startedAt })] }]
    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.scenes[0].aiLayers[0].status).toBe('error')
    expect(pollHeygen).not.toHaveBeenCalled() // deadline checked before the provider call
  })

  it('ignores non-processing and non-avatar layers', async () => {
    const { state, pollHeygen } = makeHarness(async () => ({ status: 'completed', videoUrl: '/x.mp4' }))
    state.scenes = [
      { id: 's1', duration: 8, aiLayers: [avatarLayer('ready', 'vid-x', 'ready')] },
      { id: 's2', duration: 8, aiLayers: [{ id: 'veo', type: 'veo3', status: 'generating' }] },
      { id: 's3', duration: 8, aiLayers: [avatarLayer('noid', null)] },
    ]
    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(pollHeygen).not.toHaveBeenCalled()
  })
})
