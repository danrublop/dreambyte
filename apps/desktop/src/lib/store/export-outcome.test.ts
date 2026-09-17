import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ExportProgress } from '../types'
import { assertExportSucceeded } from './export-outcome'

// The render lives in ../export2/pixi-mp4; force it to throw so exportVideo
// takes its catch branch (records phase='error' for the UI, then re-throws so
// the failure is loud — see assertExportSucceeded / T1).
vi.mock('../export2/pixi-mp4', () => ({
  exportSolidSceneMp4: vi.fn(async () => {
    throw new Error('encoder blew up')
  }),
}))

// Keep the test isolated from the real template machinery.
vi.mock('../sceneTemplate', () => ({
  generateSceneHTML: () => '<html></html>',
}))

import { createExportActions } from './export-actions'

const progress = (phase: ExportProgress['phase'], error: string | null = null): ExportProgress => ({
  phase,
  currentScene: 1,
  totalScenes: 1,
  sceneProgress: 0,
  downloadUrl: null,
  error,
})

describe('assertExportSucceeded', () => {
  it('throws on a null/undefined outcome', () => {
    expect(() => assertExportSucceeded(null)).toThrow()
    expect(() => assertExportSucceeded(undefined)).toThrow()
  })

  it('throws with the recorded error when phase is error', () => {
    expect(() => assertExportSucceeded(progress('error', 'render crashed'))).toThrow('render crashed')
  })

  it('does not throw when phase is complete', () => {
    expect(() => assertExportSucceeded(progress('complete'))).not.toThrow()
  })

  it('throws on a non-terminal phase (interrupted render left at rendering/stitching)', () => {
    expect(() => assertExportSucceeded(progress('rendering'))).toThrow()
    expect(() => assertExportSucceeded(progress('stitching'))).toThrow()
  })
})

describe('exportVideo failure is not reported as success (regression: TODO #1)', () => {
  const realWindow = (globalThis as any).window

  beforeEach(() => {
    // Headless export branch requires a truthy window.electronAPI.
    ;(globalThis as any).window = { electronAPI: {} }
  })
  afterEach(() => {
    ;(globalThis as any).window = realWindow
    vi.clearAllMocks()
  })

  it('THROWS when the render fails, and still records phase=error for the UI modal', async () => {
    const state: Record<string, any> = {
      scenes: [{ id: 's1', duration: 5, sceneType: 'react' }],
      project: { id: 'p1', mp4Settings: { aspectRatio: '16:9', resolution: '1080p' } },
      globalStyle: {},
      audioSettings: {},
      exportProgress: null,
      lastExportStatus: 'idle',
      isExporting: false,
    }
    const get = () => state as any
    const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)

    const actions = createExportActions(set as any, get as any)

    // eng-review T1: a failed render now REJECTS rather than resolving silently.
    await expect(
      actions.exportVideo({ resolution: '1080p', fps: 30, format: 'mp4', outputPath: '/tmp/out.mp4' }),
    ).rejects.toThrow('encoder blew up')

    // It STILL records the failure on the shared slot so the in-app export
    // modal (ExportPanel) can render its error state from the store.
    expect(state.exportProgress?.phase).toBe('error')
    expect(state.lastExportStatus).toBe('error')
    // And isExporting is cleared so a retry is possible.
    expect(state.isExporting).toBe(false)

    // The guard the headless callers use also still classifies this as a
    // failure, so a failed render is never reported back as a finished file.
    expect(() => assertExportSucceeded(state.exportProgress)).toThrow()
  })
})

// ── T1 mandatory: BOTH headless callers handle the new throw ────────────────
//
// exportVideo() now rejects on failure. The two headless callers
// (src/electron/main.ts's setExportRunner IIFE, AgentChat.tsx's export_request
// handler) both wrap the call in try/catch and report the failure rather than
// crashing. We can't boot Electron/React here, so we model each caller's exact
// control flow against a throwing exportVideo stub and assert: (a) the throw is
// caught, (b) a FAILURE (not success) is reported, (c) no crash escapes.
describe('headless callers handle exportVideo throwing (regression: TODO #1)', () => {
  // Caller A — src/electron/main.ts setExportRunner: awaits exportVideo, then a
  // defense-in-depth phase check; the whole thing is inside the runner promise
  // whose rejection mcp-handler turns into a job 'error'.
  it('src/electron/main.ts runner: a throw rejects the runner promise (job → error)', async () => {
    const exportProgress = { phase: 'error' as const, error: 'encoder blew up' }
    const exportVideo = vi.fn(async () => {
      throw new Error('encoder blew up')
    })

    // Mirror the runner IIFE: await export, then post-check; the outer caller
    // (mcp-handler) .catch()es the rejection and marks the job 'error'.
    const runner = async () => {
      await exportVideo()
      if (!exportProgress || (exportProgress as any).phase !== 'complete') {
        throw new Error((exportProgress as any)?.error || 'export failed')
      }
      return '/tmp/out.mp4'
    }

    let jobStatus: 'complete' | 'error' | 'rendering' = 'rendering'
    let jobError: string | undefined
    await runner()
      .then(() => {
        jobStatus = 'complete'
      })
      .catch((e: Error) => {
        jobStatus = 'error'
        jobError = e.message
      })

    expect(exportVideo).toHaveBeenCalledOnce()
    expect(jobStatus).toBe('error')
    expect(jobError).toBe('encoder blew up')
  })

  // Caller B — AgentChat.tsx export_request handler: try { await exportVideo();
  // assertExportSucceeded(...); postSuccess } catch { postError }. A throw must
  // route to the error post, never the success post.
  it('AgentChat export_request: a throw routes to the error response, not success', async () => {
    const exportVideo = vi.fn(async () => {
      throw new Error('encoder blew up')
    })
    const posted: Array<{ outputPath?: string; error?: string }> = []
    const postAgentExportResponse = async (msg: { exportId: string; outputPath?: string; error?: string }) => {
      posted.push({ outputPath: msg.outputPath, error: msg.error })
    }

    // Mirror AgentChat's handler body.
    const handle = async (expId: string, outputPath: string) => {
      try {
        await exportVideo()
        assertExportSucceeded({ phase: 'complete' } as any) // unreached
        await postAgentExportResponse({ exportId: expId, outputPath })
      } catch (err) {
        await postAgentExportResponse({ exportId: expId, error: (err as Error).message || 'export failed' }).catch(
          () => {},
        )
      }
    }

    await handle('e1', '/tmp/out.mp4')

    expect(exportVideo).toHaveBeenCalledOnce()
    expect(posted).toHaveLength(1)
    expect(posted[0].error).toBe('encoder blew up')
    expect(posted[0].outputPath).toBeUndefined()
  })

  // The in-app UI caller (ExportPanel) fire-and-forgets with .catch(() => {}):
  // a throw must not become an unhandled rejection; the modal reads phase from
  // the store. Model that contract.
  it('ExportPanel: .catch(() => {}) absorbs the throw without an unhandled rejection', async () => {
    const exportVideo = vi.fn(async () => {
      throw new Error('encoder blew up')
    })
    // This is exactly ExportPanel's call site.
    await expect(exportVideo().catch(() => {})).resolves.toBeUndefined()
  })
})
