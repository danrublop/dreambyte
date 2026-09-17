// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    // instance-registry (per-instance discovery) surface — default to "no
    // registry" so legacy-path tests are unaffected.
    readdir: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    rm: vi.fn(),
    rename: vi.fn(),
  },
}))

global.fetch = vi.fn() as any

import fs from 'node:fs/promises'
import {
  clearBridgeDiscoveryCache,
  listProjects,
  executeToolCall,
  loadWorldState,
  getMcpIdUniverse,
  GENERATION_FETCH_TIMEOUT_MS,
} from './mcp-adapter'

const mockReadFile = vi.mocked(fs.readFile as any)
const mockFetch = vi.mocked(global.fetch)

const FAKE_BRIDGE = {
  url: 'http://127.0.0.1:54321',
  token: 'test-token-abc',
  pid: 99999,
}

describe('bridge discovery (Terminal Claude Code path)', () => {
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearBridgeDiscoveryCache()
    vi.clearAllMocks()
    // Default: pid alive
    killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearBridgeDiscoveryCache()
  })

  it('throws "Dreambyte is not running" when discovery file is missing', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(listProjects()).rejects.toThrow('Dreambyte is not running')
  })

  it('uses discovery url + token from file when BASE_URL is empty', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(FAKE_BRIDGE))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'proj-1', name: 'Test Project' }],
    } as any)

    const result = await listProjects()

    expect(mockFetch).toHaveBeenCalledWith(
      `${FAKE_BRIDGE.url}/api/projects`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${FAKE_BRIDGE.token}`,
        }),
      }),
    )
    expect(result).toEqual([{ id: 'proj-1', name: 'Test Project' }])
  })

  it('reads file only once across multiple calls (cache hit)', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(FAKE_BRIDGE))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'proj-1', name: 'Test' }],
    } as any)

    await listProjects()
    await listProjects()
    await listProjects()

    expect(mockReadFile).toHaveBeenCalledTimes(1)
  })

  it('clears cache and re-reads file after app restarts with new pid', async () => {
    const oldBridge = { ...FAKE_BRIDGE, pid: 99999 }
    const newBridge = { ...FAKE_BRIDGE, pid: 11111 }
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'proj-1', name: 'Test' }],
    } as any)

    // First call: old pid alive
    mockReadFile.mockResolvedValueOnce(JSON.stringify(oldBridge))
    killSpy.mockImplementation((pid: number, sig: string | number) => {
      if (sig === 0 && pid === oldBridge.pid) return true as any
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    await listProjects()
    expect(mockReadFile).toHaveBeenCalledTimes(1)

    // App restarts: old pid dead, file updated with new pid
    killSpy.mockImplementation((pid: number, sig: string | number) => {
      if (sig === 0 && pid === oldBridge.pid) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      if (sig === 0 && pid === newBridge.pid) return true as any
      return true as any
    })
    mockReadFile.mockResolvedValueOnce(JSON.stringify(newBridge))

    // Second call: cache check fails → re-reads file with new pid
    await listProjects()
    expect(mockReadFile).toHaveBeenCalledTimes(2)
  })

  it('returns null and throws if discovery file has malformed JSON', async () => {
    mockReadFile.mockResolvedValue('not-json-at-all')
    await expect(listProjects()).rejects.toThrow('Dreambyte is not running')
  })

  it('throws "Dreambyte is not running" when bridge file is missing required fields', async () => {
    // Valid JSON but missing token — readBridgeDiscovery returns null
    mockReadFile.mockResolvedValue(JSON.stringify({ url: 'http://127.0.0.1:54321', pid: 99999 }))
    await expect(listProjects()).rejects.toThrow('Dreambyte is not running')
  })

  it('throws "Dreambyte is not running" when bridge url is not loopback', async () => {
    // Poisoned bridge.json pointing to a non-loopback host must be rejected
    mockReadFile.mockResolvedValue(JSON.stringify({ url: 'http://evil.example.com:54321', token: 'tok', pid: 99999 }))
    await expect(listProjects()).rejects.toThrow('Dreambyte is not running')
  })

  it('throws "Dreambyte is not running" when bridge url is not a valid URL', async () => {
    // Malformed url field triggers the inner URL-parse catch → returns null
    mockReadFile.mockResolvedValue(JSON.stringify({ url: 'not-a-url', token: 'tok', pid: 99999 }))
    await expect(listProjects()).rejects.toThrow('Dreambyte is not running')
  })

  it('prefers the own-instance manifest (DREAMBYTE_INSTANCE_ID) over legacy bridge.json', async () => {
    // The daemon is spawned with its instance id; after an app restart it must
    // reconnect to ITS instance — not whichever instance last wrote the
    // legacy singleton file. The registry's liveness/containment guards check
    // the REAL filesystem (node:fs, unmocked), so the manifest's socketPath
    // must be a real file inside a real DREAMBYTE_INSTANCES_BASE.
    const id = 'deadbeef1234'
    const realFs = await import('node:fs')
    const os = await import('node:os')
    const nodePath = await import('node:path')
    const realBase = realFs.mkdtempSync(nodePath.join(os.tmpdir(), 'adapter-registry-'))
    const socketPath = nodePath.join(realBase, 'instances', id, 'mcp.sock')
    realFs.mkdirSync(nodePath.dirname(socketPath), { recursive: true })
    realFs.writeFileSync(socketPath, '')
    process.env.DREAMBYTE_INSTANCE_ID = id
    process.env.DREAMBYTE_INSTANCES_BASE = realBase
    try {
      const manifest = {
        v: 1,
        instanceId: id,
        pid: 88888,
        userDataPath: '/p',
        repoPath: null,
        socketPath,
        url: 'http://127.0.0.1:60001',
        token: 'instance-token',
        startedAt: 5,
      }
      vi.mocked(fs.readdir as any).mockResolvedValueOnce([id])
      mockReadFile.mockImplementation(async (p: unknown) => {
        if (String(p).includes(`${id}/instance.json`)) return JSON.stringify(manifest)
        return JSON.stringify(FAKE_BRIDGE) // legacy — must NOT win
      })
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'proj-1', name: 'Test' }],
      } as any)

      await listProjects()

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:60001/api/projects',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer instance-token' }),
        }),
      )
    } finally {
      delete process.env.DREAMBYTE_INSTANCE_ID
      delete process.env.DREAMBYTE_INSTANCES_BASE
      realFs.rmSync(realBase, { recursive: true, force: true })
    }
  })

  it('falls back to legacy bridge.json when DREAMBYTE_INSTANCE_ID matches no live manifest', async () => {
    // Registry empty/unreadable (the default readdir mock rejects) — the env
    // id must not strand discovery; the legacy file is the fallback contract
    // for older app builds.
    process.env.DREAMBYTE_INSTANCE_ID = 'nomatch000000'
    try {
      mockReadFile.mockResolvedValue(JSON.stringify(FAKE_BRIDGE))
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'proj-1', name: 'Test' }],
      } as any)

      await listProjects()

      expect(mockFetch).toHaveBeenCalledWith(
        `${FAKE_BRIDGE.url}/api/projects`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${FAKE_BRIDGE.token}` }),
        }),
      )
    } finally {
      delete process.env.DREAMBYTE_INSTANCE_ID
    }
  })
})

describe('id universe (mint = expand reconciliation)', () => {
  const SCENE = '11111111-1111-4111-8111-111111111111'
  const LAYER = '22222222-2222-4222-8222-222222222222'
  const CLIP = '33333333-3333-4333-8333-333333333333'

  beforeEach(() => {
    clearBridgeDiscoveryCache()
    vi.clearAllMocks()
    vi.spyOn(process, 'kill').mockReturnValue(true as any)
    mockReadFile.mockResolvedValue(JSON.stringify(FAKE_BRIDGE))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearBridgeDiscoveryCache()
  })

  /** Route the two loadWorldState fetches by URL. */
  function mockBridge(sceneBody: any) {
    mockFetch.mockImplementation((url: any) => {
      const u = String(url)
      if (u.includes('/api/projects')) {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'proj-1', name: 'P' }] } as any)
      }
      if (u.includes('/api/scene')) {
        return Promise.resolve({ ok: true, json: async () => sceneBody } as any)
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any)
    })
  }

  it('serves the FULL universe the bridge ships (layer + clip ids), not just scene ids', async () => {
    mockBridge({
      scenes: [{ id: SCENE, name: 'S', sceneType: 'react', duration: 5 }],
      idUniverse: [SCENE, LAYER, CLIP],
    })
    await loadWorldState('proj-1')
    const u = getMcpIdUniverse()
    // The minting universe now matches what the write path expands against.
    expect(u.has(SCENE)).toBe(true)
    expect(u.has(LAYER)).toBe(true)
    expect(u.has(CLIP)).toBe(true)
  })

  it('falls back to scene ids only when an older bridge omits idUniverse', async () => {
    mockBridge({
      scenes: [{ id: SCENE, name: 'S', sceneType: 'react', duration: 5 }],
      // no idUniverse field
    })
    await loadWorldState('proj-1')
    const u = getMcpIdUniverse()
    expect(u.has(SCENE)).toBe(true)
    expect(u.has(LAYER)).toBe(false)
  })
})

describe('apiFetch per-tool timeout routing', () => {
  let abortTimeoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearBridgeDiscoveryCache()
    vi.clearAllMocks()
    vi.spyOn(process, 'kill').mockReturnValue(true as any)
    mockReadFile.mockResolvedValue(JSON.stringify({ url: 'http://127.0.0.1:54321', token: 'tok', pid: 99999 }))
    abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, content: 'ok' }),
    } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearBridgeDiscoveryCache()
  })

  it('uses 8s timeout for read/list calls (listProjects)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 'proj-1', name: 'Test' }],
    } as any)
    await listProjects()
    expect(abortTimeoutSpy).toHaveBeenCalledWith(8_000)
  })

  it('uses the derived media-tier timeout for generation tools (add_narration)', async () => {
    // executeToolCall needs a project selected first; inject via env or module state.
    // We call it via executeToolCall directly with a projectId arg. The slow-tool
    // fetch timeout is DERIVED from the shared media tier (Lane D) — assert against
    // the exported constant, not a hardcode, so it can't silently re-diverge.
    await executeToolCall('add_narration', { sceneId: 'abc', text: 'hello' }, 'proj-1')
    expect(abortTimeoutSpy).toHaveBeenCalledWith(GENERATION_FETCH_TIMEOUT_MS)
  })

  it('uses 8s timeout for non-generation tools (list_scenes)', async () => {
    await executeToolCall('list_scenes', {}, 'proj-1')
    expect(abortTimeoutSpy).toHaveBeenCalledWith(8_000)
  })
})
