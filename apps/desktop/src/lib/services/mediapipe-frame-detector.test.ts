// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'

import { createMediaPipeFrameDetector } from './mediapipe-frame-detector'

/**
 * Unit coverage for the main-process FrameDetector wrapper. The actual
 * MediaPipe page lives in `src/electron/mediapipe-detector.html` and is
 * exercised by the runtime test in the test guide.
 */

describe('createMediaPipeFrameDetector', () => {
  it('rejects when source URI is empty', async () => {
    const detector = createMediaPipeFrameDetector({
      executeDetect: async () => ({ detections: [], sourceWidth: 0, sourceHeight: 0 }),
    })
    await expect(detector.detect('')).rejects.toThrow(/source URI is required/)
  })

  it('forwards source + options to the transport and maps the response', async () => {
    const executeDetect = vi.fn(async (req: unknown) => ({
      detections: [
        { time: 0, centerX: 500, centerY: 250, confidence: 0.9 },
        { time: 1, centerX: 520, centerY: 260, confidence: 0.85 },
      ],
      sourceWidth: 1920,
      sourceHeight: 1080,
    }))
    const detector = createMediaPipeFrameDetector({ executeDetect })

    const result = await detector.detect('dreambyte://uploads/clip.mp4', { fps: 6 })
    expect(executeDetect).toHaveBeenCalledWith({
      source: 'dreambyte://uploads/clip.mp4',
      options: { fps: 6 },
    })
    expect(result.sourceWidth).toBe(1920)
    expect(result.sourceHeight).toBe(1080)
    expect(result.detections.length).toBe(2)
    expect(result.detections[0]).toEqual({ time: 0, centerX: 500, centerY: 250, confidence: 0.9 })
  })

  it('omits confidence from detections that lack it', async () => {
    const detector = createMediaPipeFrameDetector({
      executeDetect: async () => ({
        detections: [{ time: 0, centerX: 100, centerY: 100 }],
        sourceWidth: 200,
        sourceHeight: 200,
      }),
    })
    const result = await detector.detect('x')
    expect(result.detections[0]).toEqual({ time: 0, centerX: 100, centerY: 100 })
    // No `confidence` key when the page didn't supply one.
    expect('confidence' in result.detections[0]).toBe(false)
  })

  it('propagates transport errors with the original message', async () => {
    const detector = createMediaPipeFrameDetector({
      executeDetect: async () => {
        throw new Error('mediapipe page crashed during init')
      },
    })
    await expect(detector.detect('x')).rejects.toThrow(/mediapipe page crashed during init/)
  })

  it('uses default options when none are passed', async () => {
    const executeDetect = vi.fn(async () => ({
      detections: [],
      sourceWidth: 1280,
      sourceHeight: 720,
    }))
    const detector = createMediaPipeFrameDetector({ executeDetect })
    await detector.detect('x')
    expect(executeDetect).toHaveBeenCalledWith({ source: 'x', options: {} })
  })
})
