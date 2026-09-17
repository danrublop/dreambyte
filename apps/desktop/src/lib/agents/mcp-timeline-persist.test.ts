// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { clampCaptureTime } from './mcp-handler'
import { readProjectSceneBlob, writeProjectSceneBlob } from '@/lib/db/project-scene-storage'

/**
 * T16 — capture_frame timestamp clamp. The runner seeks within
 * [0, durationSeconds]; the caption must never claim a time the frame isn't at.
 */
describe('clampCaptureTime (T16)', () => {
  it('clamps an in-range request to itself', () => {
    expect(clampCaptureTime(2, 5)).toBe(2)
  })

  it('clamps an over-range request down to the duration', () => {
    expect(clampCaptureTime(99, 5)).toBe(5)
  })

  it('returns 0 (not the raw time) when duration is 0 — the false-timestamp bug', () => {
    // The runner produces frame 0 for a 0-duration scene; caption must read 0,
    // not 999.
    expect(clampCaptureTime(999, 0)).toBe(0)
  })

  it('returns 0 when duration is missing/invalid', () => {
    expect(clampCaptureTime(12, undefined)).toBe(0)
    expect(clampCaptureTime(12, NaN)).toBe(0)
    expect(clampCaptureTime(12, -3)).toBe(0)
  })

  it('never returns a negative time', () => {
    expect(clampCaptureTime(-4, 5)).toBe(0)
  })

  it('defaults to a representative frame (<=1s) when no time is requested', () => {
    expect(clampCaptureTime(undefined, 5)).toBe(1)
    expect(clampCaptureTime('not-a-number', 0.5)).toBe(0.5)
    expect(clampCaptureTime(undefined, 0)).toBe(0)
  })
})

/**
 * T2 — the persistence contract the MCP fix relies on: the timeline lives in
 * the project `description` blob (the only place the renderer reads it), and a
 * timeline write must NOT clobber scenes/graph the in-app path stored there.
 */
describe('timeline blob persistence contract (T2)', () => {
  const timeline = { tracks: [{ id: 't1', name: 'Main', type: 'video', clips: [], position: 0 }], inPoint: 1, outPoint: 4 }

  it('round-trips the timeline through the description blob', () => {
    const desc = writeProjectSceneBlob(null, { timeline })
    expect(readProjectSceneBlob(desc).timeline).toEqual(timeline)
  })

  it('preserves scenes/graph when only the timeline is written (no clobber)', () => {
    // Simulate an existing blob the in-app path wrote (scenes + graph).
    const existing = JSON.stringify({ scenes: [{ id: 's1' }], sceneGraph: { nodes: ['n'], edges: [] }, zdogLibrary: ['z'] })
    const merged = writeProjectSceneBlob(existing, { timeline })
    const blob = readProjectSceneBlob(merged)
    expect(blob.timeline).toEqual(timeline)
    expect(blob.scenes).toEqual([{ id: 's1' }])
    expect(blob.sceneGraph).toEqual({ nodes: ['n'], edges: [] })
    expect(blob.zdogLibrary).toEqual(['z'])
  })

  it('preserves lossy-in-tables fields (inPoint/outPoint) the relational tables would drop', () => {
    // This is WHY we persist to the blob, not the timeline_* tables: those
    // tables have no columns for inPoint/outPoint/markers/blendMode.
    const blob = readProjectSceneBlob(writeProjectSceneBlob(null, { timeline }))
    expect(blob.timeline.inPoint).toBe(1)
    expect(blob.timeline.outPoint).toBe(4)
  })
})
