/**
 * A4 integration regression (review #147): the reconciled export duration must
 * come from the DB-HYDRATED scene, not the in-memory snapshot.
 *
 * reconcileForExport memoizes per scene id, first-caller-wins. The original
 * wiring eagerly reconciled the IN-MEMORY scenes at exportVideo entry (via
 * burnGatedByXfade/totalCaptionSeconds), so the render loop's hydrated
 * fullScene always hit a stale cache — a poller or another window that
 * updated the DB after this window's snapshot would silently re-cut the clip
 * A4 exists to protect. The fix made those eager callers transitions-only /
 * lazy; this test pins the ordering by giving the DB a LONGER avatar clip
 * than the in-memory copy and asserting the exporter renders the DB value.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const renderedSpecs: Array<{ sceneId: string; durationSeconds: number }> = []

vi.mock('../export2/pixi-mp4', () => ({
  exportSolidSceneMp4: vi.fn(async (config: { sceneId: string; durationSeconds: number }) => {
    renderedSpecs.push({ sceneId: config.sceneId, durationSeconds: config.durationSeconds })
    return new Uint8Array([0])
  }),
}))
vi.mock('../sceneTemplate', () => ({
  generateSceneHTML: () => '<html></html>',
}))

import { createExportActions } from './export-actions'

describe('A4 reconciliation uses the DB-hydrated scene (memo ordering)', () => {
  const realWindow = (globalThis as any).window
  const writtenFiles: Array<{ filePath: string; bytes: Uint8Array }> = []

  beforeEach(() => {
    renderedSpecs.length = 0
    writtenFiles.length = 0
  })
  afterEach(() => {
    ;(globalThis as any).window = realWindow
    vi.clearAllMocks()
  })

  it('renders the hydrated avatar duration even though the in-memory copy is stale', async () => {
    // In-memory snapshot: avatar still mid-generation (stale window).
    const staleAvatar = {
      id: 'av1',
      type: 'avatar',
      status: 'generating',
      videoUrl: null,
      estimatedDuration: 4, // word-count estimate
      startAt: 0,
    }
    // DB truth: generation finished, the real clip is 12s.
    const freshAvatar = { ...staleAvatar, status: 'ready', videoUrl: 'dreambyte://generated/av1.mp4', estimatedDuration: 12 }

    const inMemoryScene = { id: 's1', duration: 5, sceneType: 'react', aiLayers: [staleAvatar] }

    const state: Record<string, any> = {
      scenes: [inMemoryScene],
      project: { id: 'p1', mp4Settings: { aspectRatio: '16:9', resolution: '1080p' } },
      globalStyle: {},
      audioSettings: {},
      exportProgress: null,
      lastExportStatus: 'idle',
      isExporting: false,
      exportCancelRequested: false,
    }
    const get = () => state as any
    const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)

    ;(globalThis as any).window = {
      electronAPI: {
        // No exportTier3 → legacy per-scene loop (the avatar path in prod).
        writeFile: vi.fn(async (args: { filePath: string; bytes: Uint8Array }) => {
          writtenFiles.push(args)
          return {}
        }),
        concatMp4: vi.fn(async () => ({})),
        cleanupExportArtifacts: vi.fn(async () => ({ ok: true, deleted: [] })),
      },
      dreambyteApi: {
        scene: {
          get: vi.fn(async () => ({ scene: { aiLayers: [freshAvatar] } })),
        },
      },
    }

    const actions = createExportActions(set as any, get as any)
    await actions.exportVideo({ resolution: '1080p', fps: 30, format: 'mp4', outputPath: '/tmp/out.mp4' })

    expect(state.exportProgress?.phase).toBe('complete')
    expect(renderedSpecs).toHaveLength(1)
    // The regression: a cache pre-warmed from the stale in-memory scene
    // (status 'generating' → no extension) would render 5s here.
    expect(renderedSpecs[0].durationSeconds).toBe(12)
    // The extension surfaced in diagnostics.
    expect(state.exportProgress?.diagnostics?.join('\n')).toContain('extended 5s → 12.00s')
  })
})
