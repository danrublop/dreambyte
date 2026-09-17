/**
 * MEDIA-GEO T14 / D5 — durable failure surfacing.
 *
 * When a RENDERER poll marks a media layer 'error' (often after the agent run
 * has ended, when only a 3.6s toast used to fire), the store posts a PERSISTENT
 * assistant-style chat message naming the scene + what failed + a suggested
 * action, and persists it so it survives reload. These tests drive the real
 * pollVeo3Status / pollAvatarStatus loops and pin the message + persist call.
 *
 * (layerIds are unique per test — postMediaFailureMessage dedupes by layerId in
 * a module-level set that survives across tests.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGenerationActions } from './generation-actions'

function makeHarness(opts: {
  pollVideo?: (a: { operationName: string }) => Promise<{ done?: boolean; videoUrl?: string; error?: string }>
  pollHeygen?: (id: string) => Promise<{ status?: string; videoUrl?: string }>
}) {
  const state: any = {
    project: { id: 'p1' },
    scenes: [] as any[],
    chatMessages: [] as any[],
    showTransientStatus: vi.fn(),
  }
  const get = () => state
  const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
  Object.assign(state, createGenerationActions(set as any, get as any))

  state.updateAILayer = vi.fn((sceneId: string, layerId: string, patch: Record<string, unknown>) => {
    const sc = state.scenes.find((s: any) => s.id === sceneId)
    const ly = sc?.aiLayers?.find((l: any) => l.id === layerId)
    if (ly) Object.assign(ly, patch)
  })
  state.updateScene = vi.fn()
  state.saveSceneHTML = vi.fn(async () => {})
  state.addChatMessage = vi.fn((m: any) => state.chatMessages.push(m))
  state.persistChatMessage = vi.fn(async () => {})
  ;(globalThis as any).window = {
    dreambyteApi: { generate: { pollVideo: opts.pollVideo, pollHeygen: opts.pollHeygen } },
  }
  return state
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  delete (globalThis as any).window
})

describe('D5: renderer poll failure posts a persistent chat message', () => {
  it('veo3 provider error → assistant message naming the scene + persisted', async () => {
    const state = makeHarness({ pollVideo: async () => ({ done: true, error: 'provider exploded' }) })
    state.scenes = [
      {
        id: 's1',
        name: 'Opening shot',
        aiLayers: [{ id: 'mf-vid-1', type: 'veo3', status: 'generating', operationName: 'op-mf-1', videoUrl: null }],
      },
    ]

    state.reconcilePendingVideoPolls()
    await vi.advanceTimersByTimeAsync(5000)

    expect(state.addChatMessage).toHaveBeenCalledTimes(1)
    const msg = state.addChatMessage.mock.calls[0][0]
    expect(msg.role).toBe('assistant')
    expect(msg.content).toContain('Opening shot')
    expect(msg.content).toContain('AI video')
    expect(msg.content).toContain('provider exploded')
    expect(state.persistChatMessage).toHaveBeenCalledWith(msg.id)
  })

  it('avatar render failure → assistant message + persisted', async () => {
    const state = makeHarness({ pollHeygen: async () => ({ status: 'failed' }) })
    state.scenes = [
      {
        id: 's2',
        name: 'Narrated intro',
        aiLayers: [{ id: 'mf-av-1', type: 'avatar', status: 'processing', heygenVideoId: 'hg-mf-1' }],
      },
    ]

    state.reconcilePendingAvatarPolls()
    await vi.advanceTimersByTimeAsync(5000)

    expect(state.addChatMessage).toHaveBeenCalledTimes(1)
    const msg = state.addChatMessage.mock.calls[0][0]
    expect(msg.content).toContain('Narrated intro')
    expect(msg.content).toContain('Avatar')
    expect(state.persistChatMessage).toHaveBeenCalledWith(msg.id)
  })

  it('does not double-post for the same layer across re-entrant polls', async () => {
    const state = makeHarness({ pollVideo: async () => ({ done: true, error: 'boom' }) })
    state.scenes = [
      {
        id: 's3',
        name: 'Scene',
        aiLayers: [
          { id: 'mf-vid-dedup', type: 'veo3', status: 'generating', operationName: 'op-mf-dedup', videoUrl: null },
        ],
      },
    ]

    state.reconcilePendingVideoPolls()
    await vi.advanceTimersByTimeAsync(5000)
    // Re-mark generating + reconcile again — the dedupe set must suppress a 2nd post.
    state.scenes[0].aiLayers[0].status = 'generating'
    state.reconcilePendingVideoPolls()
    await vi.advanceTimersByTimeAsync(5000)

    expect(state.addChatMessage).toHaveBeenCalledTimes(1)
  })
})
