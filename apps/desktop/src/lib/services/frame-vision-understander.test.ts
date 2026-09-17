// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createFrameVisionUnderstander } from './frame-vision-understander'
import type { KeyframeExtractor, KeyframeImage } from './video-understander'

function fakeFrames(n: number): KeyframeImage[] {
  return Array.from({ length: n }, (_, i) => ({ timeSec: i, bytes: new Uint8Array([i]), mimeType: 'image/jpeg' }))
}

describe('createFrameVisionUnderstander', () => {
  it('extracts, down-selects to the frame budget, runs vision + transcript, maps result', async () => {
    const extractor: KeyframeExtractor = {
      extract: vi.fn(async () => ({ durationSec: 20, frames: fakeFrames(20) })),
    }
    const runVision = vi.fn(async (frames: KeyframeImage[]) => {
      // The understander must cap to maxFrames before calling vision.
      expect(frames.length).toBeLessThanOrEqual(5)
      return { scene: 'a busy street', events: [{ start: 0, end: 5, description: 'cars pass' }] }
    })
    const transcribe = vi.fn(async () => 'someone narrates the scene')

    const u = createFrameVisionUnderstander({ extractor, runVision, transcribe })
    const result = await u.understand('dreambyte://uploads/x.mp4', {
      visionEngineId: 'local:qwen2.5vl:7b',
      maxFrames: 5,
    })

    expect(result.scene).toBe('a busy street')
    expect(result.events).toHaveLength(1)
    expect(result.transcript).toBe('someone narrates the scene')
    expect(result.backend).toBe('frame-vision:local:qwen2.5vl:7b')
    expect(runVision).toHaveBeenCalledOnce()
  })

  it('degrades when vision fails but still returns transcript', async () => {
    const extractor: KeyframeExtractor = {
      extract: async () => ({ durationSec: 3, frames: fakeFrames(3) }),
    }
    const u = createFrameVisionUnderstander({
      extractor,
      runVision: async () => {
        throw new Error('vision down')
      },
      transcribe: async () => 'transcript survives',
    })
    const result = await u.understand('dreambyte://uploads/x.mp4')
    expect(result.events).toEqual([])
    expect(result.transcript).toBe('transcript survives')
  })
})
