// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useVideoStore } from '../index'
import * as projectActions from '../project-actions'

/**
 * P0-1, renderer half. `isAgentRunning` guarded exactly ONE save path
 * (scheduleSaveProjectToDb). The 30s poll calls saveProjectToDb and
 * visibilitychange (Cmd+Tab / Cmd+Q / Cmd+H) calls flushSaveProjectToDb —
 * neither checked it, so both could ship a pre-run scene array over an agent's
 * output with `intentionalClear: true` and report 'saved'.
 *
 * A renderer flag is raceable by construction, so the guard lives in main as a
 * compare-and-swap: every scene-bearing save must carry the `projects.version`
 * this renderer last OBSERVED, and main rejects the write if the row has moved
 * on. These tests pin the renderer half of that contract — that both entry
 * points actually send a baseline, and that the flush (which cannot await one)
 * refuses to write rather than writing blind.
 */

const PROJECT_ID = '22222222-2222-4222-8222-222222222222'

function makeProject(id: string) {
  return { id, name: 'BaseVersion', outputMode: 'mp4', updatedAt: new Date(0).toISOString() } as never
}

function makeScene(id: string) {
  return {
    id,
    name: id,
    sceneType: 'react' as const,
    duration: 5,
    sceneHTML: '<div>x</div>',
    reactCode: 'export default () => null',
    svgContent: '',
    canvasCode: '',
    sceneCode: '',
    lottieSource: '',
    messages: [],
  } as never
}

type UpdateArgs = { projectId: string; updates: Record<string, unknown> }
let updatePayloads: UpdateArgs[] = []

function installIpc(opts: { version: number; savedVersion: number }) {
  ;(window as never as Record<string, unknown>).dreambyteApi = {
    projects: {
      getVersion: vi
        .fn()
        .mockResolvedValue({ version: opts.version, updatedAt: new Date(0), sceneCount: 1, hasRichContent: true }),
      get: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString(), version: opts.version, scenes: [] }),
      create: vi.fn().mockResolvedValue({}),
      // Faithful to main: a scene write without a baseline is rejected, never
      // silently accepted as last-writer-wins.
      update: vi.fn(async (args: UpdateArgs) => {
        updatePayloads.push(args)
        if (args.updates.scenes !== undefined && typeof args.updates.baseVersion !== 'number') {
          throw new Error('baseVersion is required when writing scenes')
        }
        return { updatedAt: new Date().toISOString(), version: opts.savedVersion }
      }),
    },
  }
}

beforeEach(() => {
  window.localStorage.clear()
  updatePayloads = []
  projectActions.resetSceneBaseline()
  // Module state — a version left over from a previous test would mask the
  // "no baseline" case below. (Soft-called so this file still LOADS against
  // the pre-fix module, where the export doesn't exist and the assertions
  // below are what fail.)
  ;(projectActions as unknown as { resetDbVersion?: () => void }).resetDbVersion?.()
  useVideoStore.setState({
    project: makeProject(PROJECT_ID),
    scenes: [makeScene('s1')],
    _dbLoadComplete: true,
    _isDirty: false,
    projectActiveBranchId: null,
    projectSaveStatus: 'idle',
    projectSaveError: null,
  } as never)
})

afterEach(() => {
  delete (window as never as Record<string, unknown>).dreambyteApi
  vi.restoreAllMocks()
})

describe('every scene-bearing save carries a CAS baseline', () => {
  it('saveProjectToDb sends the observed projects.version as baseVersion', async () => {
    installIpc({ version: 7, savedVersion: 8 })
    await useVideoStore.getState().saveProjectToDb()

    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0].updates.baseVersion).toBe(7)
  })

  it('flushSaveProjectToDb (visibilitychange / Cmd+Q) sends it too, advanced by the last save', async () => {
    installIpc({ version: 7, savedVersion: 8 })
    await useVideoStore.getState().saveProjectToDb()

    const res = await useVideoStore.getState().flushSaveProjectToDb()
    expect(res.ok).toBe(true)
    expect(updatePayloads).toHaveLength(2)
    // The save's response version, not the stale pre-save one.
    expect(updatePayloads[1].updates.baseVersion).toBe(8)
  })

  it('a flush with no known baseline fails loudly instead of writing blind', async () => {
    installIpc({ version: 7, savedVersion: 8 })

    const res = await useVideoStore.getState().flushSaveProjectToDb()

    // It still enqueues (unload-safe), but with baseVersion null — which main
    // rejects, so the save reports failure rather than clobbering the DB.
    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0].updates.baseVersion).toBeNull()
    expect(res.ok).toBe(false)
    expect(useVideoStore.getState().projectSaveStatus).toBe('error')
  })
})
