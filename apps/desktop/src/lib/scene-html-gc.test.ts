// @vitest-environment node

/**
 * R3 (playback-telemetry residuals) — orphan scene-HTML GC.
 *
 * The sweep's value is bounded disk growth; its RISK is deleting a live
 * scene's HTML. These tests pin the conservative posture: refuse on an empty
 * live set (fresh DB / migration race), refuse on an unreadable dir, only
 * touch scene-id-shaped .html files, and swallow per-file unlink errors.
 */

import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { sweepOrphanSceneHtml, collectLiveSceneIds } from './scene-html-gc'

function makeFs(files: string[], opts?: { failUnlink?: Set<string> }) {
  const unlinked: string[] = []
  return {
    unlinked,
    fsImpl: {
      readdir: vi.fn(async () => files),
      unlink: vi.fn(async (p: string) => {
        const name = path.basename(p)
        if (opts?.failUnlink?.has(name)) throw new Error('EBUSY')
        unlinked.push(name)
      }),
    } as never,
  }
}

const DIR = '/scenes'

describe('sweepOrphanSceneHtml', () => {
  it('deletes orphaned scene html, keeps live scenes', async () => {
    const { fsImpl, unlinked } = makeFs(['live-1.html', 'orphan-1.html', 'orphan-2.html'])
    const result = await sweepOrphanSceneHtml({
      scenesDir: DIR,
      getLiveSceneIds: async () => new Set(['live-1']),
      fsImpl,
    })
    expect(result).toEqual({ scanned: 3, deleted: 2, skipped: false })
    expect(unlinked.sort()).toEqual(['orphan-1.html', 'orphan-2.html'])
  })

  it('REFUSES to run when the live set is empty (fresh DB must not nuke the dir)', async () => {
    const { fsImpl, unlinked } = makeFs(['a.html', 'b.html'])
    const result = await sweepOrphanSceneHtml({
      scenesDir: DIR,
      getLiveSceneIds: async () => new Set(),
      fsImpl,
    })
    expect(result.skipped).toBe(true)
    expect(unlinked).toEqual([])
  })

  it('REFUSES to run when getLiveSceneIds throws (malformed blob aborts, not orphans)', async () => {
    const { fsImpl, unlinked } = makeFs(['a.html'])
    const result = await sweepOrphanSceneHtml({
      scenesDir: DIR,
      getLiveSceneIds: async () => {
        throw new Error('malformed legacy blob')
      },
      fsImpl,
    })
    expect(result.skipped).toBe(true)
    expect(unlinked).toEqual([])
  })

  it('END-TO-END: a corrupt project blob aborts the sweep via the REAL collector (no deletions)', async () => {
    // /review PR #101 (multi-confirmed critical): the first version of this
    // suite mocked getLiveSceneIds to throw, while production read blobs via
    // readProjectSceneBlob — which SWALLOWS parse errors into {scenes: []},
    // silently turning a corrupt project's live files into "orphans". This
    // test wires the real collector the way src/electron/main.ts does, so the
    // abort-on-malformed-blob guarantee is pinned against real behavior.
    const { fsImpl, unlinked } = makeFs(['live-from-blob.html', 'other.html'])
    const result = await sweepOrphanSceneHtml({
      scenesDir: DIR,
      getLiveSceneIds: async () =>
        collectLiveSceneIds([], [{ description: '{ this is not json' }, { description: null }]),
      fsImpl,
    })
    expect(result.skipped).toBe(true)
    expect(unlinked).toEqual([])
  })

  it('skips silently when the scenes dir is unreadable/missing', async () => {
    const result = await sweepOrphanSceneHtml({
      scenesDir: DIR,
      getLiveSceneIds: async () => new Set(['x']),
      fsImpl: {
        readdir: vi.fn(async () => {
          throw new Error('ENOENT')
        }),
        unlink: vi.fn(),
      } as never,
    })
    expect(result.skipped).toBe(true)
  })

  it('only touches scene-id-shaped .html files — everything else is not ours', async () => {
    const { fsImpl, unlinked } = makeFs([
      'orphan.html',
      'notes.txt', // wrong extension
      'weird name.html', // space — not a scene id
      '../escape.html', // path-ish — not a scene id
      'sub.dir.html', // dot — not a scene id shape
      '.hidden.html',
    ])
    const result = await sweepOrphanSceneHtml({
      scenesDir: DIR,
      getLiveSceneIds: async () => new Set(['live']),
      fsImpl,
    })
    expect(result).toEqual({ scanned: 1, deleted: 1, skipped: false })
    expect(unlinked).toEqual(['orphan.html'])
  })

  it('swallows per-file unlink errors and keeps sweeping', async () => {
    const { fsImpl, unlinked } = makeFs(['orphan-a.html', 'orphan-b.html'], {
      failUnlink: new Set(['orphan-a.html']),
    })
    const result = await sweepOrphanSceneHtml({
      scenesDir: DIR,
      getLiveSceneIds: async () => new Set(['live']),
      fsImpl,
    })
    expect(result).toEqual({ scanned: 2, deleted: 1, skipped: false })
    expect(unlinked).toEqual(['orphan-b.html'])
  })
})

describe('collectLiveSceneIds (the production live-id source)', () => {
  it('unions scenes-table ids with legacy blob scene ids', () => {
    const ids = collectLiveSceneIds(
      [{ id: 'table-1' }, { id: 'table-2' }],
      [
        { description: JSON.stringify({ scenes: [{ id: 'blob-1' }, { id: 'blob-2' }] }) },
        { description: null }, // projects with no blob contribute nothing, harmlessly
      ],
    )
    expect(ids).toEqual(new Set(['table-1', 'table-2', 'blob-1', 'blob-2']))
  })

  it('THROWS on a malformed blob — never silently drops a project’s ids', () => {
    // readProjectSceneBlob swallows parse errors into {scenes: []}; this
    // collector must NOT (that silent empty-set is what would have deleted a
    // corrupt project's live scene HTML as orphans).
    expect(() => collectLiveSceneIds([], [{ description: '{ not json' }])).toThrow()
  })

  it('tolerates blobs with odd-but-valid shapes (no scenes array, non-object entries)', () => {
    const ids = collectLiveSceneIds(
      [{ id: 't' }],
      [
        { description: JSON.stringify({ sceneGraph: {} }) }, // valid JSON, no scenes
        { description: JSON.stringify({ scenes: [null, { noId: true }, { id: 'ok' }] }) },
        { description: JSON.stringify('a plain string description') }, // valid JSON, non-object
      ],
    )
    expect(ids).toEqual(new Set(['t', 'ok']))
  })
})
