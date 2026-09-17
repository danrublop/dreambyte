import { describe, it, expect, vi } from 'vitest'
import { createPendingClip, resolvePendingClip, rejectPendingClip, captureSceneClip } from './pending-clips'

const BYTES = new Uint8Array([1, 2, 3, 4])

describe('pending-clips', () => {
  it('resolves with the posted clip bytes', async () => {
    const { clipId, promise } = createPendingClip(2000)
    const ok = resolvePendingClip(clipId, BYTES, 'video/mp4')
    expect(ok).toBe(true)
    const clip = await promise
    expect(clip.bytes).toEqual(BYTES)
    expect(clip.mimeType).toBe('video/mp4')
  })

  it('rejects when explicitly cancelled', async () => {
    const { clipId, promise } = createPendingClip(2000)
    expect(rejectPendingClip(clipId, 'client refused')).toBe(true)
    await expect(promise).rejects.toThrow('client refused')
  })

  it('times out when no response arrives', async () => {
    const { promise } = createPendingClip(50)
    await expect(promise).rejects.toThrow(/clip timeout/)
  })

  it('returns false when resolving an unknown clipId', () => {
    expect(resolvePendingClip('no-such-id', BYTES)).toBe(false)
  })

  it('can only be resolved once', async () => {
    const { clipId, promise } = createPendingClip(2000)
    expect(resolvePendingClip(clipId, BYTES)).toBe(true)
    await promise
    expect(resolvePendingClip(clipId, BYTES)).toBe(false)
  })
})

describe('captureSceneClip', () => {
  it('emits a clip_request with maxRes/fps and resolves with the posted bytes', async () => {
    const emit = vi.fn((e: { clipId: string; sceneId: string; maxRes: number; fps: number }) => {
      resolvePendingClip(e.clipId, BYTES, 'video/mp4')
    })
    const clip = await captureSceneClip('scene-1', emit, { maxRes: 480, fps: 24 })
    expect(clip).toEqual({ bytes: BYTES, mimeType: 'video/mp4' })
    const evt = emit.mock.calls[0][0]
    expect(evt.sceneId).toBe('scene-1')
    expect(evt.maxRes).toBe(480)
    expect(evt.fps).toBe(24)
    expect(typeof evt.clipId).toBe('string')
  })

  it('defaults maxRes=720 / fps=24 when unspecified', async () => {
    const emit = vi.fn((e: { clipId: string }) => resolvePendingClip(e.clipId, BYTES))
    await captureSceneClip('scene-1', emit)
    expect(emit.mock.calls[0][0]).toMatchObject({ maxRes: 720, fps: 24 })
  })

  it('returns null on timeout (no client response)', async () => {
    const emit = vi.fn()
    const clip = await captureSceneClip('scene-1', emit, { timeoutMs: 30 })
    expect(clip).toBeNull()
  })

  it('degrades to null on client error', async () => {
    const emit = vi.fn((e: { clipId: string }) => rejectPendingClip(e.clipId, 'export failed'))
    await expect(captureSceneClip('scene-1', emit, { timeoutMs: 1000 })).resolves.toBeNull()
  })
})
