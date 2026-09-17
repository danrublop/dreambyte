/**
 * 11b — scene-indexed export errors: an injected per-scene render failure
 * must surface WHICH scene broke (message prefix + structured
 * errorSceneIndex/errorSceneId on exportProgress), so a polling agent can
 * re-generate just the broken scene instead of guessing from a bare string.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

let failOnCall = -1
let callCount = 0

vi.mock('../export2/pixi-mp4', () => ({
  exportSolidSceneMp4: vi.fn(async () => {
    callCount += 1
    if (callCount === failOnCall) throw new Error('render exploded')
    return new Uint8Array([0])
  }),
}))
vi.mock('../sceneTemplate', () => ({
  generateSceneHTML: () => '<html></html>',
}))

import { createExportActions } from './export-actions'

describe('exportVideo scene-indexed errors (11b)', () => {
  const realWindow = (globalThis as any).window

  afterEach(() => {
    ;(globalThis as any).window = realWindow
    callCount = 0
    failOnCall = -1
    vi.clearAllMocks()
  })

  function makeStore() {
    const state: Record<string, any> = {
      scenes: [
        { id: 'scene-1', name: 'Intro', duration: 5, sceneType: 'react' },
        { id: 'scene-2', name: 'Middle', duration: 5, sceneType: 'react' },
        { id: 'scene-3', name: 'Outro', duration: 5, sceneType: 'react' },
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
    ;(globalThis as any).window = {
      electronAPI: {
        // No exportTier3 → legacy per-scene loop.
        writeFile: vi.fn(async () => ({})),
        concatMp4: vi.fn(async () => ({})),
        cleanupExportArtifacts: vi.fn(async () => ({ ok: true, deleted: [] })),
      },
    }
    return { state, actions: createExportActions(set as any, get as any) }
  }

  it('an injected scene-2 failure reports errorSceneIndex=2 with the scene name in the message', async () => {
    failOnCall = 2
    const { state, actions } = makeStore()
    await expect(
      actions.exportVideo({ resolution: '1080p', fps: 30, format: 'mp4', outputPath: '/tmp/out.mp4' }),
    ).rejects.toThrow(/^scene 2\/3 \("Middle"\): render exploded/)
    expect(state.exportProgress?.phase).toBe('error')
    expect(state.exportProgress?.errorSceneIndex).toBe(2)
    expect(state.exportProgress?.errorSceneId).toBe('scene-2')
    expect(state.exportProgress?.error).toContain('scene 2/3')
    expect(state.lastExportStatus).toBe('error')
  })

  it('a failure outside the per-scene render (concat) carries no scene tag', async () => {
    const { state, actions } = makeStore()
    ;(globalThis as any).window.electronAPI.concatMp4 = vi.fn(async () => {
      throw new Error('concat failed')
    })
    await expect(
      actions.exportVideo({ resolution: '1080p', fps: 30, format: 'mp4', outputPath: '/tmp/out.mp4' }),
    ).rejects.toThrow('concat failed')
    expect(state.exportProgress?.errorSceneIndex ?? null).toBeNull()
    expect(state.exportProgress?.errorSceneId ?? null).toBeNull()
    expect(state.exportProgress?.error).not.toMatch(/^scene \d/)
  })
})

describe('tier3 batch slot fallback (11b)', () => {
  function makeTier3Store() {
    let progressListener: ((p: any) => void) | null = null
    const state: Record<string, any> = {
      scenes: [
        { id: 'scene-1', name: 'One', duration: 5, sceneType: 'react' },
        { id: 'scene-2', name: 'Two', duration: 5, sceneType: 'react' },
        { id: 'scene-3', name: 'Three', duration: 5, sceneType: 'react' },
      ],
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
    const electronAPI: Record<string, any> = {
      onExportTier3Progress: vi.fn((fn: (p: any) => void) => {
        progressListener = fn
        return () => {}
      }),
      writeFile: vi.fn(async () => ({})),
      cleanupExportArtifacts: vi.fn(async () => ({ ok: true, deleted: [] })),
    }
    ;(globalThis as any).window = { electronAPI }
    return {
      state,
      electronAPI,
      actions: createExportActions(set as any, get as any),
      fireProgress: (p: any) => progressListener?.(p),
    }
  }

  it('a batch failure AFTER progress advanced is attributed to the in-flight scene', async () => {
    const { state, electronAPI, actions, fireProgress } = makeTier3Store()
    electronAPI.exportTier3 = vi.fn(async () => {
      // Renderer saw scene 2 rendering, then the batch died.
      fireProgress({ phase: 'rendering', currentScene: 2, totalScenes: 3, sceneProgress: 40 })
      throw new Error('offscreen window crashed')
    })
    await expect(
      actions.exportVideo({ resolution: '1080p', fps: 30, format: 'mp4', outputPath: '/tmp/t3.mp4' }),
    ).rejects.toThrow(/^scene 2\/3 \("Two"\): offscreen window crashed/)
    expect(state.exportProgress?.errorSceneIndex).toBe(2)
    expect(state.exportProgress?.errorSceneId).toBe('scene-2')
  })

  it('a batch failure BEFORE any progress (disk preflight) is honestly UNTAGGED, not blamed on scene 1', async () => {
    const { state, electronAPI, actions } = makeTier3Store()
    electronAPI.exportTier3 = vi.fn(async () => {
      throw new Error('tier3 export: not enough free disk')
    })
    await expect(
      actions.exportVideo({ resolution: '1080p', fps: 30, format: 'mp4', outputPath: '/tmp/t3.mp4' }),
    ).rejects.toThrow(/^tier3 export: not enough free disk/)
    expect(state.exportProgress?.errorSceneIndex ?? null).toBeNull()
    expect(state.exportProgress?.errorSceneId ?? null).toBeNull()
    expect(state.exportProgress?.error).not.toMatch(/^scene \d/)
  })
})
