// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { afterEach, describe, it, expect } from 'vitest'

import { autoReframeForClip } from './auto-reframe'
import { setFrameDetector } from './frame-detector'
import type { Clip } from '@/lib/types'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    sourceType: 'video',
    sourceId: 'dreambyte://uploads/sample.mp4',
    label: '',
    startTime: 0,
    duration: 10,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...overrides,
  }
}

afterEach(() => setFrameDetector(null))

describe('autoReframeForClip', () => {
  it('throws a useful error when no detector is configured', async () => {
    await expect(
      autoReframeForClip({
        clip: clip(),
        sourceUri: 'dreambyte://uploads/sample.mp4',
        targetWidth: 1920,
        targetHeight: 1080,
      }),
    ).rejects.toThrow(/Frame detector not configured/)
  })

  it('produces keyframe/add actions for each downsampled detection', async () => {
    setFrameDetector({
      async detect() {
        return {
          sourceWidth: 1920,
          sourceHeight: 1080,
          detections: [
            { time: 0, centerX: 200, centerY: 200, confidence: 1 },
            { time: 1, centerX: 400, centerY: 400, confidence: 1 },
            { time: 2, centerX: 600, centerY: 600, confidence: 1 },
          ],
        }
      },
    })
    const result = await autoReframeForClip({
      clip: clip(),
      sourceUri: 'dreambyte://uploads/sample.mp4',
      targetWidth: 1920,
      targetHeight: 1080,
      maxKeyframes: 3,
    })
    expect(result.detectionCount).toBe(3)
    expect(result.actions.length).toBe(6) // 3 × (x + y)
    expect(result.actions.every((a) => a.type === 'keyframe/add')).toBe(true)
    expect(result.sourceWidth).toBe(1920)
    expect(result.sourceHeight).toBe(1080)
    const first = result.actions[0]
    const params = first.params as { clipId: string; keyframe: { property: string } }
    expect(params.clipId).toBe('c1')
    expect(['x', 'y']).toContain(params.keyframe.property)
  })

  it('forwards detector options (fps, time window)', async () => {
    let received: unknown = null
    setFrameDetector({
      async detect(_source, options) {
        received = options
        return {
          sourceWidth: 1280,
          sourceHeight: 720,
          detections: [{ time: 0, centerX: 640, centerY: 360, confidence: 1 }],
        }
      },
    })
    await autoReframeForClip({
      clip: clip(),
      sourceUri: 'dreambyte://uploads/sample.mp4',
      targetWidth: 1080,
      targetHeight: 1920,
      detectOptions: { fps: 12, startTime: 0, endTime: 5 },
    })
    expect(received).toEqual({ fps: 12, startTime: 0, endTime: 5 })
  })

  it('returns an empty plan when detections are all sub-confidence', async () => {
    setFrameDetector({
      async detect() {
        return {
          sourceWidth: 1920,
          sourceHeight: 1080,
          detections: [
            { time: 0, centerX: 100, centerY: 100, confidence: 0.1 },
            { time: 1, centerX: 200, centerY: 200, confidence: 0.2 },
          ],
        }
      },
    })
    const result = await autoReframeForClip({
      clip: clip(),
      sourceUri: 'dreambyte://uploads/sample.mp4',
      targetWidth: 1920,
      targetHeight: 1080,
      minConfidence: 0.5,
    })
    expect(result.detectionCount).toBe(2)
    expect(result.actions.length).toBe(0)
  })

  // G2 pre-ship gate (v0.3.0): MediaPipe stub fails loud rather than returning
  // empty detections. Verifies the propagation chain — stub throws → host
  // re-throws → frame-detector logs + re-throws → autoReframeForClip rejects.
  // Replaces the manual "invoke auto_reframe and check it returns unavailable"
  // verification step from the v0.3.0 ship plan.
  describe('G2 — fail-loud propagation', () => {
    it('rejects when the configured detector throws (MediaPipe stub behavior)', async () => {
      setFrameDetector({
        async detect() {
          throw new Error('MediaPipe detector is not yet wired in v0.3.0. auto_reframe requires a follow-on release.')
        },
      })

      await expect(
        autoReframeForClip({
          clip: clip(),
          sourceUri: 'dreambyte://uploads/sample.mp4',
          targetWidth: 1920,
          targetHeight: 1080,
        }),
      ).rejects.toThrow(/MediaPipe detector is not yet wired/)
    })

    it('does NOT swallow detector errors and produce a misleading empty plan', async () => {
      // Negative test: the v0.2.x behavior would have returned an empty
      // result here. v0.3.0's contract is that detector errors must surface.
      setFrameDetector({
        async detect() {
          throw new Error('detector unavailable')
        },
      })

      const promise = autoReframeForClip({
        clip: clip(),
        sourceUri: 'dreambyte://uploads/sample.mp4',
        targetWidth: 1920,
        targetHeight: 1080,
      })

      await expect(promise).rejects.toThrow()
      // If a future change accidentally restores silent-empty behavior, this
      // assertion would fail because the promise would resolve, not reject.
    })
  })
})
