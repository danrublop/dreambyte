// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { framesToReframeKeyframes, type FrameDetection } from './reframe-planner'

function uniformDetections(n: number, startSec = 0, stepSec = 0.5): FrameDetection[] {
  const out: FrameDetection[] = []
  for (let i = 0; i < n; i++) {
    out.push({ time: startSec + i * stepSec, centerX: 100, centerY: 200, confidence: 1 })
  }
  return out
}

describe('framesToReframeKeyframes', () => {
  it('returns [] when no detections survive the confidence filter', () => {
    const out = framesToReframeKeyframes({
      detections: [
        { time: 0, centerX: 100, centerY: 200, confidence: 0.1 },
        { time: 1, centerX: 110, centerY: 210, confidence: 0.2 },
      ],
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 1920,
      targetHeight: 1080,
      minConfidence: 0.5,
    })
    expect(out).toEqual([])
  })

  it('emits two keyframes (x and y) per downsampled detection', () => {
    const out = framesToReframeKeyframes({
      detections: uniformDetections(4),
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 1920,
      targetHeight: 1080,
      maxKeyframes: 4,
    })
    expect(out.length).toBe(8) // 4 detections × (x + y)
    const props = new Set(out.map((k) => k.property))
    expect(props).toEqual(new Set(['x', 'y']))
  })

  it('translates centroid to (targetCenter - centroid) per axis', () => {
    const out = framesToReframeKeyframes({
      detections: [{ time: 0, centerX: 100, centerY: 200, confidence: 1 }],
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 1920,
      targetHeight: 1080,
      maxKeyframes: 1,
      smoothing: 1, // disable smoothing so first sample lands at its raw centroid
    })
    const x = out.find((k) => k.property === 'x')!
    const y = out.find((k) => k.property === 'y')!
    expect(x.value).toBe(1920 / 2 - 100) // 860
    expect(y.value).toBe(1080 / 2 - 200) // 340
  })

  it('downsamples to at most maxKeyframes per axis (first + last preserved)', () => {
    const detections = uniformDetections(30, 0, 0.1) // 0..2.9s
    const out = framesToReframeKeyframes({
      detections,
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 1920,
      targetHeight: 1080,
      maxKeyframes: 5,
    })
    expect(out.length).toBe(10) // 5 × (x + y)
    const times = Array.from(new Set(out.map((k) => k.time))).sort((a, b) => a - b)
    expect(times[0]).toBe(0)
    expect(times[times.length - 1]).toBeCloseTo(2.9, 5)
  })

  it('EMA smoothing pulls the trajectory toward the running mean', () => {
    // Single big jump in the middle — smoothed output should NOT match raw.
    const detections: FrameDetection[] = [
      { time: 0, centerX: 100, centerY: 100, confidence: 1 },
      { time: 1, centerX: 100, centerY: 100, confidence: 1 },
      { time: 2, centerX: 1000, centerY: 100, confidence: 1 }, // spike
      { time: 3, centerX: 100, centerY: 100, confidence: 1 },
    ]
    const out = framesToReframeKeyframes({
      detections,
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 1920,
      targetHeight: 1080,
      maxKeyframes: 4,
      smoothing: 0.25,
    })
    const spikeKf = out.find((k) => k.time === 2 && k.property === 'x')!
    // raw value would be 1920/2 - 1000 = -40. Smoothed must be much closer
    // to "100"-centroid output (1920/2 - 100 = 860) than to -40.
    expect(spikeKf.value).toBeGreaterThan(0)
  })

  it('applies the requested easing to every emitted keyframe', () => {
    const out = framesToReframeKeyframes({
      detections: uniformDetections(3),
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 1920,
      targetHeight: 1080,
      maxKeyframes: 3,
      easing: 'linear',
    })
    expect(out.every((k) => k.easing === 'linear')).toBe(true)
  })
})
