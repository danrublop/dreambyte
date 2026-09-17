/**
 * TODOS "saveProjectToDb conflict retry" part (c): concurrent direct calls to
 * saveProjectToDb (30s poll × manual / branch-switch callers; the unload
 * flush bypasses the chain by design and is nonce-protected)
 * used to interleave — both proceeded, racing the shared crash-marker key, so
 * one call's clear could delete the other's IN-FLIGHT marker and a crash
 * between them recorded the wrong sceneIds at next boot. The fix serializes
 * every call through a module-level promise chain; this pins that two
 * concurrent calls never overlap (the second's IPC write starts only after
 * the first fully completes) and that a FAILED save doesn't wedge the chain.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createProjectActions } from './project-actions'

function makeHarness(updateImpl: () => Promise<Record<string, unknown>>) {
  const journal: string[] = []
  const state: Record<string, any> = {
    project: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'P',
      updatedAt: new Date().toISOString(),
      mp4Settings: {},
    },
    scenes: [{ id: 's1', duration: 5, sceneType: 'react', reactCode: 'X' }],
    globalStyle: {},
    audioProviderEnabled: false,
    mediaGenEnabled: false,
    _dbLoadComplete: true,
    _isDirty: true,
    projectActiveBranchId: null,
    projectSaveStatus: 'idle',
    projectSaveError: null,
  }
  const get = () => state as any
  const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
  const actions = createProjectActions(set as any, get as any)
  // The actions object IS part of the store state in production; the chained
  // wrapper reaches the inner via get()._saveProjectToDbUnchained.
  Object.assign(state, actions)

  ;(globalThis as any).window = {
    dreambyteApi: {
      projects: {
        update: vi.fn(async (...args: unknown[]) => {
          journal.push('update:start')
          const res = await updateImpl()
          journal.push('update:end')
          return res
        }),
        getVersion: vi.fn(async () => null),
        get: vi.fn(async () => null),
      },
    },
  }
  return { state, actions, journal }
}

describe('saveProjectToDb re-entrancy chain (item 8c)', () => {
  const realWindow = (globalThis as any).window
  afterEach(() => {
    ;(globalThis as any).window = realWindow
    vi.clearAllMocks()
  })

  it('two concurrent calls serialize: the second write starts only after the first ends', async () => {
    let resolveFirst!: (v: Record<string, unknown>) => void
    let call = 0
    const { actions, journal } = makeHarness(() => {
      call += 1
      if (call === 1) return new Promise((r) => (resolveFirst = r)) // first save hangs until released
      return Promise.resolve({ updatedAt: new Date().toISOString() })
    })

    const first = actions.saveProjectToDb()
    const second = actions.saveProjectToDb()
    // Give the second every chance to (wrongly) start while the first hangs.
    await new Promise((r) => setTimeout(r, 20))
    expect(journal).toEqual(['update:start']) // second has NOT started
    resolveFirst({ updatedAt: new Date().toISOString() })
    await Promise.all([first, second])
    expect(journal).toEqual(['update:start', 'update:end', 'update:start', 'update:end'])
  })

  it('a failed save does not wedge the chain — the next call still runs', async () => {
    let call = 0
    const { state, actions, journal } = makeHarness(() => {
      call += 1
      if (call === 1) return Promise.reject(new Error('disk on fire'))
      return Promise.resolve({ updatedAt: new Date().toISOString() })
    })
    // The save body records failures on the store slot (UI contract) rather
    // than rejecting — what matters here is the chain isn't wedged.
    await actions.saveProjectToDb()
    expect(state.projectSaveStatus).toBe('error')
    expect(state.projectSaveError).toContain('disk on fire')
    await actions.saveProjectToDb()
    expect(state.projectSaveStatus).toBe('saved')
    expect(journal).toEqual(['update:start', 'update:start', 'update:end'])
  })
})
