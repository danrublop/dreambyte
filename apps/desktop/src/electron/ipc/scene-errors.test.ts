// @vitest-environment node

/**
 * Trust-boundary validation for the scene playback error report IPC:
 * a compromised/buggy renderer must not
 * poison the buffer with garbage that later lands in agent prompts.
 * Mirrors the fakeIpcMain pattern from rules.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { register } from './scene-errors'
import {
  getRecentSceneErrors,
  __clearAllSceneErrorsForTesting,
} from '../../lib/agents/scene-error-buffer'

function fakeIpcMain() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = new Map<string, (e: unknown, ...args: any[]) => unknown>()
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: (channel: string, handler: (e: unknown, ...args: any[]) => unknown) => handlers.set(channel, handler),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoke: (channel: string, ...args: any[]) => {
      const h = handlers.get(channel)
      if (!h) throw new Error(`no handler for ${channel}`)
      return h({}, ...args)
    },
  }
}

describe('dreambyte:sceneErrors.report validation', () => {
  let ipc: ReturnType<typeof fakeIpcMain>
  beforeEach(() => {
    __clearAllSceneErrorsForTesting()
    ipc = fakeIpcMain()
    register(ipc as never)
  })

  const report = (payload: unknown) => ipc.invoke('dreambyte:sceneErrors.report', payload) as { ok: boolean }

  it('accepts a valid payload and records it', () => {
    const r = report({ sceneId: 'scene_1-abc', error: { kind: 'runtime', message: 'boom', at: 1000 } })
    expect(r.ok).toBe(true)
    expect(getRecentSceneErrors('scene_1-abc')).toHaveLength(1)
  })

  it('rejects invalid scene ids (path-ish, empty, non-string)', () => {
    expect(report({ sceneId: '../etc', error: { kind: 'runtime', message: 'x', at: 1 } }).ok).toBe(false)
    expect(report({ sceneId: '', error: { kind: 'runtime', message: 'x', at: 1 } }).ok).toBe(false)
    expect(report({ sceneId: 42, error: { kind: 'runtime', message: 'x', at: 1 } }).ok).toBe(false)
    expect(getRecentSceneErrors('../etc')).toHaveLength(0)
  })

  it('accepts underscore ids — same charset as the scene WRITER', () => {
    expect(report({ sceneId: 'scene_with_underscores', error: { kind: 'runtime', message: 'x', at: 1 } }).ok).toBe(
      true,
    )
  })

  it('rejects empty/non-string messages', () => {
    expect(report({ sceneId: 's1', error: { kind: 'runtime', message: '', at: 1 } }).ok).toBe(false)
    expect(report({ sceneId: 's1', error: { kind: 'runtime', message: 42, at: 1 } }).ok).toBe(false)
  })

  it('coerces unknown kinds to runtime and truncates oversized fields', () => {
    const r = report({
      sceneId: 's1',
      error: { kind: 'evil-kind', message: 'm'.repeat(2000), source: 's'.repeat(900), at: 1 },
    })
    expect(r.ok).toBe(true)
    const [e] = getRecentSceneErrors('s1')
    expect(e.kind).toBe('runtime')
    expect(e.message.length).toBeLessThanOrEqual(500)
    expect((e.source ?? '').length).toBeLessThanOrEqual(200)
  })
})
