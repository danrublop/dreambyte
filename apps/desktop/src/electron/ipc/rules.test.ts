// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB layer so the handler test stays a pure unit (no SQLite).
vi.mock('@/lib/db/queries/rules', () => ({
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
}))

import * as queries from '@/lib/db/queries/rules'
import { register } from './rules'

// Minimal ipcMain that captures handlers so we can invoke them directly.
function fakeIpcMain() {
  const handlers = new Map<string, (e: unknown, ...args: any[]) => unknown>()
  return {
    handle: (channel: string, handler: (e: unknown, ...args: any[]) => unknown) => handlers.set(channel, handler),
    invoke: (channel: string, ...args: any[]) => {
      const h = handlers.get(channel)
      if (!h) throw new Error(`no handler for ${channel}`)
      return h({}, ...args)
    },
    has: (channel: string) => handlers.has(channel),
  }
}

const mocked = queries as unknown as Record<string, ReturnType<typeof vi.fn>>

describe('rules IPC handlers', () => {
  let ipc: ReturnType<typeof fakeIpcMain>
  beforeEach(() => {
    vi.clearAllMocks()
    ipc = fakeIpcMain()
    register(ipc as never)
  })

  it('registers all rule channels', () => {
    for (const ch of ['dreambyte:rules.list', 'dreambyte:rules.create', 'dreambyte:rules.update', 'dreambyte:rules.delete']) {
      expect(ipc.has(ch)).toBe(true)
    }
  })

  it('list forwards to queries.listRules', async () => {
    mocked.listRules.mockResolvedValue([{ id: '1' }])
    const res = await ipc.invoke('dreambyte:rules.list', { scope: 'user' })
    expect(queries.listRules).toHaveBeenCalledWith({ scope: 'user' })
    expect(res).toEqual({ rules: [{ id: '1' }] })
  })

  it('list rejects an invalid scope', async () => {
    await expect(ipc.invoke('dreambyte:rules.list', { scope: 'bogus' })).rejects.toThrow()
  })

  it('create validates required name/body before hitting the DB', async () => {
    await expect(ipc.invoke('dreambyte:rules.create', { scope: 'user', name: '', body: 'x' })).rejects.toThrow()
    await expect(ipc.invoke('dreambyte:rules.create', { scope: 'user', name: 'x', body: '' })).rejects.toThrow()
    expect(queries.createRule).not.toHaveBeenCalled()
  })

  it('create forwards a valid payload', async () => {
    mocked.createRule.mockResolvedValue({ id: 'r1' })
    const res = await ipc.invoke('dreambyte:rules.create', { scope: 'user', name: 'N', body: 'B' })
    expect(queries.createRule).toHaveBeenCalledWith({ scope: 'user', name: 'N', body: 'B' })
    expect(res).toEqual({ rule: { id: 'r1' } })
  })

  it('delete forwards the id and returns ok', async () => {
    mocked.deleteRule.mockResolvedValue(true)
    const res = await ipc.invoke('dreambyte:rules.delete', 'r1')
    expect(queries.deleteRule).toHaveBeenCalledWith('r1')
    expect(res).toEqual({ ok: true })
  })
})
