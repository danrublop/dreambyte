// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// MCP bridge restart recovery (apiFetch reconnect flow). The env-frozen
// BASE_URL is captured in a module-load const — and ESM hoists imports above
// plain statements, so the env must be set in a vi.hoisted block to land
// before the adapter module evaluates.
vi.hoisted(() => {
  process.env.DREAMBYTE_STUDIO_URL = 'http://127.0.0.1:59999'
  process.env.DREAMBYTE_BRIDGE_TOKEN = 'dead-token'
})

// bridge.json discovery reads via node:fs/promises — mock it so tests never
// touch the real ~/.dreambyte/bridge.json (which may belong to a live app).
const readFileMock = vi.fn()
vi.mock('node:fs/promises', () => ({
  default: { readFile: (...a: unknown[]) => readFileMock(...a) },
}))

import {
  listProjects,
  isConnectionError,
  isPreSendConnectionError,
  clearLiveBridgeOverride,
  clearBridgeDiscoveryCache,
} from './mcp-adapter'

const LIVE_BRIDGE = JSON.stringify({ url: 'http://127.0.0.1:60001', token: 'live-token', pid: process.pid })

function dialFailure(): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
}
function postSendReset(): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
}

beforeEach(() => {
  clearLiveBridgeOverride()
  clearBridgeDiscoveryCache()
  readFileMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiFetch bridge restart recovery', () => {
  it('re-discovers the live bridge after a pre-send dial failure and caches the override', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(dialFailure()) // dead env bridge
      // fresh Response per call — a shared body can only be read once
      .mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    readFileMock.mockResolvedValue(LIVE_BRIDGE)

    await expect(listProjects()).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain('127.0.0.1:60001') // retried at the LIVE bridge

    // Subsequent calls skip the dead probe entirely (override cached).
    await listProjects()
    expect(String(fetchMock.mock.calls[2][0])).toContain('127.0.0.1:60001')
  })

  it('does NOT replay the request on a post-send reset — clear APP_RESTARTED instead', async () => {
    const fetchMock = vi.fn().mockRejectedValue(postSendReset())
    vi.stubGlobal('fetch', fetchMock)
    readFileMock.mockResolvedValue(LIVE_BRIDGE) // a live bridge EXISTS — still no replay

    await expect(listProjects()).rejects.toThrow(/APP_RESTARTED/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // the body was never re-sent
  })

  it('throws APP_RESTARTED when no live bridge exists', async () => {
    const fetchMock = vi.fn().mockRejectedValue(dialFailure())
    vi.stubGlobal('fetch', fetchMock)
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await expect(listProjects()).rejects.toThrow(/APP_RESTARTED/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry on an HTTP error (bridge alive, request failed)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listProjects()).rejects.toThrow(/API 500/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('connection-error classification', () => {
  it('pre-send dial failures are retry-eligible', () => {
    expect(isPreSendConnectionError(dialFailure())).toBe(true)
    expect(isPreSendConnectionError(Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }))).toBe(true)
    // AggregateError shape (multi-addr dial)
    expect(
      isPreSendConnectionError(
        Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ECONNREFUSED' }] } }),
      ),
    ).toBe(true)
  })

  it('post-send resets and cause-less failures are connection errors but NOT retry-eligible', () => {
    expect(isConnectionError(postSendReset())).toBe(true)
    expect(isPreSendConnectionError(postSendReset())).toBe(false)
    const causeless = new TypeError('fetch failed')
    expect(isConnectionError(causeless)).toBe(true)
    expect(isPreSendConnectionError(causeless)).toBe(false) // conservative: unknown ≠ provably unsent
  })
})
