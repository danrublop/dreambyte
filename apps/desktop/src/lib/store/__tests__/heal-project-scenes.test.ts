// @vitest-environment jsdom
//
// Failure-path coverage for healProjectScenes (COMMIT 7b / T4 / D8):
//   - readHtml rejection → treated as missing, heal proceeds (saveSceneHTML called)
//   - saveSceneHTML rejection → sceneWriteErrors[id] set + sceneSaveStatus 'error'
//   - generateSceneHTML throw on scene 1 does not stop scene 2
//   - empty expectedHtml → scene skipped (no heal write)
// The active-run guard (COMMIT 6) is satisfied by an empty activeRunIds list.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { generateSceneHTML } = vi.hoisted(() => ({
  generateSceneHTML: vi.fn((scene: any) => `<html>${scene.id}</html>`),
}))
vi.mock('@/lib/sceneTemplate', () => ({ generateSceneHTML }))

import { createGenerationActions } from '../generation-actions'

type AnyRecord = Record<string, any>

function makeHarness(scenes: AnyRecord[], saveSceneHTML: any) {
  const state: AnyRecord = {
    project: { mp4Settings: { aspectRatio: '16:9', resolution: '1080p' }, watermark: null },
    projectAssets: [],
    audioSettings: {},
    globalStyle: {},
    scenes,
    sceneWriteErrors: {},
    sceneSaveStatus: {},
    saveSceneHTML,
  }
  const get = () => state as any
  const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
  const actions = createGenerationActions(set as any, get as any)
  return { state, actions }
}

describe('healProjectScenes — failure paths (COMMIT 7b)', () => {
  let readHtml: any
  let activeRunIds: any

  beforeEach(() => {
    generateSceneHTML.mockClear()
    generateSceneHTML.mockImplementation((scene: any) => `<html>${scene.id}</html>`)
    activeRunIds = vi.fn(async () => ({ runIds: [] }))
    readHtml = vi.fn(async () => ({ exists: false, html: null }))
    ;(globalThis as any).window.dreambyteApi = {
      scene: { readHtml },
      agent: { activeRunIds },
    }
  })
  afterEach(() => {
    delete (globalThis as any).window.dreambyteApi
  })

  it('readHtml rejection is treated as missing → heal proceeds', async () => {
    readHtml.mockRejectedValueOnce(new Error('disk read failed'))
    const saveSceneHTML = vi.fn(async () => {})
    const { actions } = makeHarness([{ id: 's1' }], saveSceneHTML)
    await actions.healProjectScenes()
    // Missing → decision needsHeal → saveSceneHTML called for s1.
    expect(saveSceneHTML).toHaveBeenCalledWith('s1', true)
  })

  it('saveSceneHTML rejection records sceneWriteErrors + sceneSaveStatus error', async () => {
    const saveSceneHTML = vi.fn(async () => {
      throw new Error('save blew up')
    })
    const { state, actions } = makeHarness([{ id: 's1' }], saveSceneHTML)
    await actions.healProjectScenes()
    expect(state.sceneWriteErrors.s1).toMatch(/could not be regenerated/i)
    expect(state.sceneSaveStatus.s1).toBe('error')
  })

  it('generateSceneHTML throwing on scene 1 does not stop scene 2', async () => {
    generateSceneHTML.mockImplementation((scene: any) => {
      if (scene.id === 's1') throw new Error('gen failed')
      return `<html>${scene.id}</html>`
    })
    const saveSceneHTML = vi.fn(async () => {})
    const { actions } = makeHarness([{ id: 's1' }, { id: 's2' }], saveSceneHTML)
    await actions.healProjectScenes()
    // s1 skipped (gen threw); s2 healed.
    expect(saveSceneHTML).toHaveBeenCalledWith('s2', true)
    expect(saveSceneHTML).not.toHaveBeenCalledWith('s1', true)
  })

  it('empty expectedHtml is skipped (never clobbers with blank)', async () => {
    generateSceneHTML.mockImplementation(() => '')
    const saveSceneHTML = vi.fn(async () => {})
    const { actions } = makeHarness([{ id: 's1' }], saveSceneHTML)
    await actions.healProjectScenes()
    expect(saveSceneHTML).not.toHaveBeenCalled()
  })

  it('skips the entire heal when an agent run is active (COMMIT 6 guard)', async () => {
    activeRunIds.mockResolvedValueOnce({ runIds: ['run-1'] })
    const saveSceneHTML = vi.fn(async () => {})
    const { actions } = makeHarness([{ id: 's1' }], saveSceneHTML)
    await actions.healProjectScenes()
    expect(readHtml).not.toHaveBeenCalled()
    expect(saveSceneHTML).not.toHaveBeenCalled()
  })
})
