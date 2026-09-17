import { describe, it, expect } from 'vitest'
import { computeLineDiff } from './line-diff'
import { computeToolCodeDiff } from './tool-code-diff'
import type { Scene } from '@/lib/types'

describe('computeLineDiff', () => {
  it('returns null for identical inputs', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nb\nc')).toBeNull()
  })

  it('reports a simple one-line change with context', () => {
    const before = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n')
    const after = ['l1', 'l2', 'l3', 'CHANGED', 'l5', 'l6', 'l7'].join('\n')
    const diff = computeLineDiff(before, after)!
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.truncated).toBe(false)
    const del = diff.lines.find((l) => l.type === 'del')
    const add = diff.lines.find((l) => l.type === 'add')
    expect(del?.text).toBe('l4')
    expect(add?.text).toBe('CHANGED')
    // 3 lines of context on each side
    expect(diff.lines.filter((l) => l.type === 'ctx')).toHaveLength(6)
  })

  it('collapses long unchanged runs into gap markers', () => {
    const mid = Array.from({ length: 40 }, (_, i) => `same-${i}`)
    const before = ['start', ...mid, 'end'].join('\n')
    const after = ['START!', ...mid, 'END!'].join('\n')
    const diff = computeLineDiff(before, after)!
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(2)
    expect(diff.lines.some((l) => l.type === 'gap')).toBe(true)
    // The 40-line middle must NOT be fully emitted.
    expect(diff.lines.length).toBeLessThan(20)
  })

  it('pure insertion and pure deletion count correctly', () => {
    const ins = computeLineDiff('a\nc', 'a\nb\nc')!
    expect(ins.added).toBe(1)
    expect(ins.removed).toBe(0)
    const del = computeLineDiff('a\nb\nc', 'a\nc')!
    expect(del.added).toBe(0)
    expect(del.removed).toBe(1)
  })

  it('falls back to summary-only for huge rewrites (DP cap)', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old-${i}`).join('\n')
    const after = Array.from({ length: 2000 }, (_, i) => `new-${i}`).join('\n')
    const diff = computeLineDiff(before, after)!
    expect(diff.truncated).toBe(true)
    expect(diff.lines).toHaveLength(0)
    expect(diff.added).toBe(2000)
    expect(diff.removed).toBe(2000)
  })

  it('caps emitted rows but keeps exact counts', () => {
    // 600 alternating changes → way past MAX_OUTPUT_LINES.
    const before = Array.from({ length: 600 }, (_, i) => `before-${i}`).join('\n')
    const after = Array.from({ length: 600 }, (_, i) => `after-${i}`).join('\n')
    const diff = computeLineDiff(before, after)!
    expect(diff.truncated).toBe(true)
    expect(diff.lines.length).toBeLessThanOrEqual(400)
    expect(diff.added).toBe(600)
    expect(diff.removed).toBe(600)
  })
})

describe('computeToolCodeDiff', () => {
  const scene = { id: 's1', name: 'Intro', sceneType: 'react', reactCode: 'old-a\nold-b' } as unknown as Scene

  it('diffs write_scene_code against the store scene code', () => {
    const map = new Map<string, string>()
    const diff = computeToolCodeDiff('write_scene_code', { sceneId: 's1', sceneCode: 'old-a\nnew-b' }, [scene], map)!
    expect(diff.label).toBe('Intro')
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    // Map updated for sequential-write chaining.
    expect(map.get('scene:s1')).toBe('old-a\nnew-b')
  })

  it('chains sequential writes through the per-run map', () => {
    const map = new Map<string, string>()
    computeToolCodeDiff('write_scene_code', { sceneId: 's1', sceneCode: 'v1' }, [scene], map)
    const second = computeToolCodeDiff('write_scene_code', { sceneId: 's1', sceneCode: 'v2' }, [scene], map)!
    // Diffs v1 → v2, not store code → v2.
    expect(second.removed).toBe(1)
    expect(second.lines.find((l) => l.type === 'del')?.text).toBe('v1')
  })

  it('uses oldCode/newCode for patch_layer_code', () => {
    const diff = computeToolCodeDiff('patch_layer_code', { oldCode: 'foo()', newCode: 'bar()' }, [], new Map())!
    expect(diff.label).toBe('patch')
    expect(diff.lines.find((l) => l.type === 'del')?.text).toBe('foo()')
    expect(diff.lines.find((l) => l.type === 'add')?.text).toBe('bar()')
  })

  it('returns null for unknown tools, identical code, and missing fields', () => {
    expect(computeToolCodeDiff('add_layer', { prompt: 'x' }, [], new Map())).toBeNull()
    expect(computeToolCodeDiff('patch_layer_code', { oldCode: 'a', newCode: 'a' }, [], new Map())).toBeNull()
    expect(computeToolCodeDiff('write_scene_code', { sceneId: 's1' }, [scene], new Map())).toBeNull()
  })
})
