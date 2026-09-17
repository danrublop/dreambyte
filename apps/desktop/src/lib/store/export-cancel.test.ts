import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ExportProgress } from '../types'
import { shouldCancel, isCancellable, cancelledProgress } from './export-cancel'

describe('shouldCancel', () => {
  it('true only when a cancel is requested AND an export is in flight', () => {
    expect(shouldCancel(true, true)).toBe(true)
    expect(shouldCancel(true, false)).toBe(false)
    expect(shouldCancel(false, true)).toBe(false)
    expect(shouldCancel(false, false)).toBe(false)
  })
})

describe('isCancellable', () => {
  it('cancellable only during per-scene render', () => {
    expect(isCancellable('rendering')).toBe(true)
  })
  it('NOT cancellable once finalize/mux starts (torn-MP4 guard)', () => {
    expect(isCancellable('stitching')).toBe(false)
    expect(isCancellable('mixing_audio')).toBe(false)
  })
  it('NOT cancellable in terminal phases', () => {
    expect(isCancellable('complete')).toBe(false)
    expect(isCancellable('error')).toBe(false)
    expect(isCancellable('cancelled')).toBe(false)
    expect(isCancellable(null)).toBe(false)
    expect(isCancellable(undefined)).toBe(false)
  })
})

describe('cancelledProgress', () => {
  it('produces a cancelled slot with no filePath/downloadUrl (never a partial result)', () => {
    const prev: ExportProgress = {
      phase: 'rendering',
      currentScene: 2,
      totalScenes: 4,
      sceneProgress: 50,
      downloadUrl: 'blob:partial',
      filePath: '/tmp/partial.mp4',
      error: null,
      diagnostics: ['a', 'b'],
    }
    const next = cancelledProgress(prev, 4)
    expect(next.phase).toBe('cancelled')
    expect(next.filePath).toBeNull()
    expect(next.downloadUrl).toBeNull()
    expect(next.error).toBeNull()
    expect(next.currentScene).toBe(2) // counters preserved for display
    expect(next.diagnostics).toEqual(['a', 'b'])
  })
  it('falls back to the passed totalScenes when there is no prior slot', () => {
    const next = cancelledProgress(null, 7)
    expect(next.phase).toBe('cancelled')
    expect(next.totalScenes).toBe(7)
    expect(next.filePath).toBeNull()
  })
})

// ── Integration: a cancel mid-render ends in 'cancelled', never 'success' ────
//
// We drive the legacy/pixi path (window.electronAPI present, no exportTier3).
// The per-scene render is mocked to request a cancel on the FIRST scene, so the
// loop's bailIfCancelled() trips before scene 2. The export must end in phase
// 'cancelled' + lastExportStatus 'cancelled', NEVER complete/success, and must
// not reject (cancel is not a failure).
const cancelHook = { onScene: undefined as undefined | (() => void) }

vi.mock('../export2/pixi-mp4', () => ({
  exportSolidSceneMp4: vi.fn(async () => {
    cancelHook.onScene?.()
    return new Uint8Array([0])
  }),
}))
vi.mock('../sceneTemplate', () => ({
  generateSceneHTML: () => '<html></html>',
}))

import { createExportActions } from './export-actions'

describe('exportVideo cancel → phase cancelled, no success (T16)', () => {
  const realWindow = (globalThis as any).window

  beforeEach(() => {
    ;(globalThis as any).window = {
      electronAPI: {
        // No exportTier3 → forces the legacy per-scene loop.
        writeFile: vi.fn(async () => ({})),
        concatMp4: vi.fn(async () => ({})),
        cleanupExportArtifacts: vi.fn(async (args: { paths: string[] }) => ({ ok: true, deleted: args.paths })),
      },
    }
  })
  afterEach(() => {
    ;(globalThis as any).window = realWindow
    cancelHook.onScene = undefined
    vi.clearAllMocks()
  })

  it('transitions to cancelled and never reports success', async () => {
    const state: Record<string, any> = {
      scenes: [
        { id: 's1', duration: 5, sceneType: 'react' },
        { id: 's2', duration: 5, sceneType: 'react' },
        { id: 's3', duration: 5, sceneType: 'react' },
      ],
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
    const actions = createExportActions(set as any, get as any)

    // Simulate the user hitting Cancel while scene 1 renders.
    cancelHook.onScene = () => {
      state.exportCancelRequested = true
    }

    // A cancel is NOT a failure — exportVideo must resolve, not reject.
    await expect(
      actions.exportVideo({ resolution: '1080p', fps: 30, format: 'mp4', outputPath: '/tmp/out.mp4' }),
    ).resolves.toBeUndefined()

    expect(state.exportProgress?.phase).toBe('cancelled')
    expect(state.exportProgress?.filePath).toBeNull()
    expect(state.lastExportStatus).toBe('cancelled')
    expect(state.lastExportStatus).not.toBe('success')
    // 11b: a user cancel is never scene-tagged (CANCEL_SENTINEL exemption).
    expect(state.exportProgress?.errorSceneIndex).toBeUndefined()
    // Latch + in-flight flags cleared so a fresh export can start.
    expect(state.isExporting).toBe(false)
    expect(state.exportCancelRequested).toBe(false)
    // concat (finalize) must NOT have run — we cancelled before it.
    expect((globalThis as any).window.electronAPI.concatMp4).not.toHaveBeenCalled()
    // COMMIT 3: the scene-1 part we wrote before cancelling must be cleaned up.
    const cleanup = (globalThis as any).window.electronAPI.cleanupExportArtifacts
    expect(cleanup).toHaveBeenCalledTimes(1)
    const cleanedPaths: string[] = cleanup.mock.calls[0][0].paths
    expect(cleanedPaths).toContain('/tmp/out.mp4.scene-001.mp4')
  })

  it('tier3 discard-on-cancel deletes the written output (COMMIT 3)', async () => {
    // Force the all-tier3 path: exportTier3 present. It "writes" a complete MP4
    // at outputPath, then we request cancel — the discard must delete it.
    const cleanup = vi.fn(async (args: { paths: string[] }) => ({ ok: true, deleted: args.paths }))
    ;(globalThis as any).window = {
      electronAPI: {
        exportTier3: vi.fn(async () => {
          // Simulate the user cancelling during the (uninterruptible) encode.
          state.exportCancelRequested = true
          return {}
        }),
        onExportTier3Progress: vi.fn(() => () => {}),
        writeFile: vi.fn(async () => ({})),
        cleanupExportArtifacts: cleanup,
      },
    }
    const state: Record<string, any> = {
      scenes: [{ id: 's1', duration: 5, sceneType: 'react' }],
      project: { id: 'p1', mp4Settings: { aspectRatio: '16:9', resolution: '1080p', engine: 'tier3' } },
      globalStyle: {},
      audioSettings: {},
      exportProgress: null,
      lastExportStatus: 'idle',
      isExporting: false,
      exportCancelRequested: false,
    }
    const get = () => state as any
    const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
    const actions = createExportActions(set as any, get as any)

    await expect(
      actions.exportVideo({ resolution: '1080p', fps: 30, format: 'mp4', outputPath: '/tmp/t3.mp4' }),
    ).resolves.toBeUndefined()

    expect(state.exportProgress?.phase).toBe('cancelled')
    expect(state.lastExportStatus).toBe('cancelled')
    expect(cleanup).toHaveBeenCalled()
    const cleanedPaths: string[] = cleanup.mock.calls[0][0].paths
    expect(cleanedPaths).toContain('/tmp/t3.mp4')
  })

  it('cancelExport is a no-op when nothing is exporting', () => {
    const state: Record<string, any> = { isExporting: false, exportCancelRequested: false }
    const get = () => state as any
    const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
    const actions = createExportActions(set as any, get as any)
    actions.cancelExport()
    expect(state.exportCancelRequested).toBe(false)
  })
})
