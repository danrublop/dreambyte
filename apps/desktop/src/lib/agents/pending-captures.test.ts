import { describe, it, expect, vi } from 'vitest'
import { createPendingCapture, resolvePendingCapture, rejectPendingCapture, captureOneFrame } from './pending-captures'

describe('pending-captures', () => {
  it('resolves with the posted image', async () => {
    const { captureId, promise } = createPendingCapture(2000)
    const ok = resolvePendingCapture(captureId, 'data:image/png;base64,AAA', 'image/png')
    expect(ok).toBe(true)
    const img = await promise
    expect(img.dataUri).toBe('data:image/png;base64,AAA')
    expect(img.mimeType).toBe('image/png')
  })

  it('rejects when explicitly cancelled', async () => {
    const { captureId, promise } = createPendingCapture(2000)
    const ok = rejectPendingCapture(captureId, 'client refused')
    expect(ok).toBe(true)
    await expect(promise).rejects.toThrow('client refused')
  })

  it('times out when no response arrives', async () => {
    const { promise } = createPendingCapture(50)
    await expect(promise).rejects.toThrow(/capture timeout/)
  })

  it('returns false when resolving an unknown captureId', () => {
    expect(resolvePendingCapture('no-such-id', 'data:image/png;base64,x')).toBe(false)
  })

  it('can only be resolved once', async () => {
    const { captureId, promise } = createPendingCapture(2000)
    expect(resolvePendingCapture(captureId, 'data:image/png;base64,A')).toBe(true)
    await promise
    expect(resolvePendingCapture(captureId, 'data:image/png;base64,B')).toBe(false)
  })
})

describe('captureOneFrame', () => {
  it('emits a capture_request and resolves with the posted image', async () => {
    // Fake client: resolve the slot as soon as the request is emitted.
    const emit = vi.fn((e: { captureId: string; sceneId: string; captureTime: number }) => {
      resolvePendingCapture(e.captureId, 'data:image/png;base64,ZZZ', 'image/png')
    })
    const img = await captureOneFrame('scene-1', 2.5, emit)
    expect(img).toEqual({ dataUri: 'data:image/png;base64,ZZZ', mimeType: 'image/png' })
    const evt = emit.mock.calls[0][0]
    expect(evt.sceneId).toBe('scene-1')
    expect(evt.captureTime).toBe(2.5)
    expect(typeof evt.captureId).toBe('string')
  })

  it('returns null on timeout (no client response)', async () => {
    const emit = vi.fn() // client never posts back
    const img = await captureOneFrame('scene-1', 0, emit, 30)
    expect(img).toBeNull()
  })

  it('does not throw — failure degrades to null so a bulk caller can skip the frame', async () => {
    const emit = vi.fn((e: { captureId: string }) => rejectPendingCapture(e.captureId, 'client refused'))
    await expect(captureOneFrame('scene-1', 0, emit, 1000)).resolves.toBeNull()
  })
})
