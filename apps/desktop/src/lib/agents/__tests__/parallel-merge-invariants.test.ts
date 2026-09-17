/**
 * Parallel-batch invariants (eng-review IT5 / D12).
 *
 * The parallel tool path is safe WITHOUT a conflict resolver only while three
 * properties hold (see src/lib/agents/parallel-batch.ts). These tests pin them so
 * a one-line edit to PARALLELIZABLE_TOOLS — or a refactor of the batch gating
 * or the merge-back — fails CI instead of silently reintroducing
 * last-write-wins data loss.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  GENERATION_TOOLS,
  PARALLELIZABLE_TOOLS,
  isParallelizableBlock,
  collectParallelBatch,
  assertParallelBatchSafe,
  mergeIsolatedWorldEntry,
  type ParallelCandidateBlock,
  type MergeableWorld,
} from '../parallel-batch'
import type { Scene } from '../../types'

function block(name: string, sceneId?: string, inputError?: string): ParallelCandidateBlock {
  return { name, inputError, parsedInput: sceneId ? { sceneId } : {} }
}

function scene(id: string, code = ''): Scene {
  return { id, name: id, sceneType: 'react', duration: 5, sceneCode: code } as unknown as Scene
}

function world(scenes: Scene[], style: Record<string, unknown> = { palette: ['#000'] }): MergeableWorld {
  return { scenes, globalStyle: JSON.parse(JSON.stringify(style)) }
}

describe('invariant 1 — the parallelizable tool set is EXACTLY the scene-confined generation tools', () => {
  it('pins the set: add_layer, regenerate_layer — nothing else', () => {
    // If this fails you added/removed a tool from PARALLELIZABLE_TOOLS.
    // Before updating this assertion, prove the new tool's mutations are
    // confined to its input sceneId (merge-back drops everything else).
    expect([...PARALLELIZABLE_TOOLS].sort()).toEqual(['add_layer', 'regenerate_layer'])
    expect(PARALLELIZABLE_TOOLS).toBe(GENERATION_TOOLS)
  })

  it('broad-mutation tools are not parallelizable even with a sceneId', () => {
    expect(isParallelizableBlock(block('set_global_style', 'scene-1'))).toBe(false)
    expect(isParallelizableBlock(block('write_scene_code', 'scene-1'))).toBe(false)
  })

  it('generation tools without a sceneId, or with input errors, are not parallelizable', () => {
    expect(isParallelizableBlock(block('add_layer'))).toBe(false)
    expect(isParallelizableBlock(block('add_layer', 'scene-1', 'bad args'))).toBe(false)
    expect(isParallelizableBlock(block('add_layer', 'scene-1'))).toBe(true)
  })
})

describe('invariant 2 — a batch never contains two calls for the same scene', () => {
  it('stops collecting at a repeated sceneId', () => {
    const blocks = [block('add_layer', 'a'), block('regenerate_layer', 'b'), block('add_layer', 'a')]
    const { batch, sceneIds, nextIndex } = collectParallelBatch(blocks, 0)
    expect(batch).toHaveLength(2)
    expect([...sceneIds]).toEqual(['a', 'b'])
    expect(nextIndex).toBe(2) // the repeat runs sequentially after the batch
  })

  it('stops at the first non-parallelizable block (contiguity preserved)', () => {
    const blocks = [block('add_layer', 'a'), block('set_global_style', 'b'), block('add_layer', 'c')]
    const { batch, nextIndex } = collectParallelBatch(blocks, 0)
    expect(batch).toHaveLength(1)
    expect(nextIndex).toBe(1)
  })
})

describe('dev assertion (D12) — unsafe batches fail loudly outside production', () => {
  const origEnv = process.env.NODE_ENV
  afterEach(() => {
    vi.stubEnv('NODE_ENV', origEnv ?? 'test')
    vi.unstubAllEnvs()
  })

  it('throws on a tool outside PARALLELIZABLE_TOOLS', () => {
    expect(() => assertParallelBatchSafe([block('add_layer', 'a'), block('set_global_style', 'b')])).toThrow(
      /not in PARALLELIZABLE_TOOLS/,
    )
  })

  it('throws on duplicate sceneIds and on a missing sceneId', () => {
    expect(() => assertParallelBatchSafe([block('add_layer', 'a'), block('regenerate_layer', 'a')])).toThrow(
      /duplicate/,
    )
    expect(() => assertParallelBatchSafe([block('add_layer')])).toThrow(/no sceneId/)
  })

  it('passes a well-formed batch', () => {
    expect(() => assertParallelBatchSafe([block('add_layer', 'a'), block('regenerate_layer', 'b')])).not.toThrow()
  })

  it('is a no-op in production (never crashes a real run)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => assertParallelBatchSafe([block('set_global_style', 'x')])).not.toThrow()
  })
})

describe('invariant 3 — merge-back writes ONLY the affected scene', () => {
  it('merges the affected scene back into the live world', () => {
    const live = world([scene('a', 'old'), scene('b', 'untouched')])
    const iso = world([scene('a', 'NEW'), scene('b', 'untouched')])
    mergeIsolatedWorldEntry(live, iso, 'a', JSON.stringify(live.globalStyle))
    expect((live.scenes[0] as { sceneCode: string }).sceneCode).toBe('NEW')
    expect((live.scenes[1] as { sceneCode: string }).sceneCode).toBe('untouched')
  })

  it('drops mutations a tool made to NON-target scenes in its clone (no leakage)', () => {
    const live = world([scene('a', 'old-a'), scene('b', 'old-b')])
    // The tool for scene "a" also (incorrectly) mutated scene "b" in its clone.
    const iso = world([scene('a', 'NEW-a'), scene('b', 'ROGUE-b')])
    mergeIsolatedWorldEntry(live, iso, 'a', JSON.stringify(live.globalStyle))
    expect((live.scenes[0] as { sceneCode: string }).sceneCode).toBe('NEW-a')
    expect((live.scenes[1] as { sceneCode: string }).sceneCode).toBe('old-b') // rogue write dropped
  })

  it('a NEW scene created in the clone is pushed when it is the affected scene', () => {
    const live = world([scene('a')])
    const iso = world([scene('a'), scene('fresh', 'created')])
    mergeIsolatedWorldEntry(live, iso, 'fresh', JSON.stringify(live.globalStyle))
    expect(live.scenes.map((s) => s.id)).toEqual(['a', 'fresh'])
  })

  it('globalStyle merges only when it diverged from the pre-batch snapshot', () => {
    const base = { palette: ['#000'], roughness: 1 }
    const live = world([scene('a')], base)
    const baseStr = JSON.stringify(live.globalStyle)

    // Non-diverged clone: style untouched.
    const isoSame = world([scene('a')], base)
    mergeIsolatedWorldEntry(live, isoSame, 'a', baseStr)
    expect(live.globalStyle).toEqual(base)

    // Diverged clone: full replacement (nested objects reverted wholesale).
    const isoChanged = world([scene('a')], { palette: ['#fff'], roughness: 2 })
    mergeIsolatedWorldEntry(live, isoChanged, 'a', baseStr)
    expect(live.globalStyle).toEqual({ palette: ['#fff'], roughness: 2 })
  })
})
