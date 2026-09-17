// @vitest-environment node
//
// End-to-end smoke test for scripts/mcp-tier2-server.ts. Spawns the
// server as a child process speaking JSON-RPC over stdio (the standard
// MCP transport), exports a real Tier 2 folder, then sends `tools/list`
// and `tools/call` requests and asserts the responses look right.
//
// We deliberately exercise the full transport, not just the handler
// imports — that's what catches packaging issues (bad shebang, missing
// dep, broken tsx invocation) the unit suite can't see.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { exportProjectToTier2 } from '../../src/lib/storage/tier2-export'
import type { Project } from '../../src/lib/types/project'
import type { Scene } from '../../src/lib/types/scene'

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SERVER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mcp', 'mcp-tier2-server.ts')

let scopeRoot: string
let server: ChildProcessWithoutNullStreams
let stdoutBuffer = ''
let pendingResponses = new Map<number, (result: unknown) => void>()
const ORIGINAL_FLAG = process.env.DREAMBYTE_TIER2_EXPORT

function makeProject(): Project {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'MCP Smoke',
    outputMode: 'mp4',
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    mp4Settings: { resolution: '1080p', fps: 30, format: 'mp4', aspectRatio: '16:9' } as Project['mp4Settings'],
    interactiveSettings: {} as Project['interactiveSettings'],
    sceneGraph: { nodes: [], edges: [], startSceneId: '' } as unknown as Project['sceneGraph'],
    apiPermissions: {} as Project['apiPermissions'],
    audioSettings: {} as Project['audioSettings'],
    audioProviderEnabled: {},
    mediaGenEnabled: {},
    watermark: null,
    brandKit: null,
    timeline: null,
    tier2Path: null,
  }
}

function makeScene(id: string, name: string): Scene {
  return {
    id,
    name,
    prompt: '',
    summary: '',
    svgContent: '',
    usage: null,
    duration: 5,
    bgColor: '#000',
    thumbnail: null,
    videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: {} as Scene['audioLayer'],
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: 'cut' as Scene['transition'],
    sceneType: 'react',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: '',
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    interactions: [],
    variables: [],
    aiLayers: [],
    messages: [],
    styleOverride: {} as Scene['styleOverride'],
    cameraMotion: null,
    worldConfig: null,
  }
}

function rpcCall(id: number, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pendingResponses.set(id, resolve)
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    server.stdin.write(req, (err) => {
      if (err) reject(err)
    })
    setTimeout(() => {
      if (pendingResponses.has(id)) {
        pendingResponses.delete(id)
        reject(new Error(`Timed out waiting for ${method} response (id=${id})`))
      }
    }, 8000)
  })
}

function attachStdout(): void {
  server.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8')
    let idx: number
    while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, idx).trim()
      stdoutBuffer = stdoutBuffer.slice(idx + 1)
      if (!line) continue
      let msg: { id?: number; result?: unknown; error?: unknown }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.id === 'number' && pendingResponses.has(msg.id)) {
        const resolver = pendingResponses.get(msg.id)!
        pendingResponses.delete(msg.id)
        resolver(msg.error ?? msg.result)
      }
    }
  })
}

beforeAll(async () => {
  process.env.DREAMBYTE_TIER2_EXPORT = 'true'
  scopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tier2-smoke-'))
  await exportProjectToTier2({
    project: makeProject(),
    scenes: [makeScene('s-1', 'Opener'), makeScene('s-2', 'Closer')],
    tier2Path: scopeRoot,
  })
  server = spawn('npx', ['tsx', SERVER_SCRIPT, scopeRoot], {
    cwd: REPO_ROOT,
    env: { ...process.env, DREAMBYTE_TIER2_EXPORT: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  attachStdout()
  // Wait for "ready" line on stderr so the connect handshake is done.
  await new Promise<void>((resolve, reject) => {
    const onErr = (b: Buffer) => {
      const s = b.toString('utf-8')
      if (s.includes('ready')) {
        server.stderr.off('data', onErr)
        resolve()
      }
    }
    server.stderr.on('data', onErr)
    server.on('exit', (code) => reject(new Error(`server exited prematurely (${code})`)))
    setTimeout(() => reject(new Error('server boot timed out')), 15000)
  })
  // Initialize per the MCP protocol so requests after this are accepted.
  await rpcCall(0, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.0' },
  })
}, 30000)

afterAll(async () => {
  if (server && !server.killed) server.kill('SIGTERM')
  if (scopeRoot) await fs.rm(scopeRoot, { recursive: true, force: true })
  if (ORIGINAL_FLAG === undefined) delete process.env.DREAMBYTE_TIER2_EXPORT
  else process.env.DREAMBYTE_TIER2_EXPORT = ORIGINAL_FLAG
})

describe('mcp-tier2-server', () => {
  it('lists the five Tier 2 tools', async () => {
    const res = (await rpcCall(1, 'tools/list', {})) as { tools: Array<{ name: string }> }
    const names = res.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'tier2_list_assets',
      'tier2_list_scenes',
      'tier2_read_project',
      'tier2_read_scene',
      'tier2_read_scene_html',
    ])
  })

  it('tier2_read_project returns the parsed project.json', async () => {
    const res = (await rpcCall(2, 'tools/call', {
      name: 'tier2_read_project',
      arguments: {},
    })) as { content: Array<{ text: string }> }
    const parsed = JSON.parse(res.content[0].text)
    expect(parsed.formatVersion).toBe(1)
    expect(parsed.sceneOrder).toEqual(['s-1', 's-2'])
  })

  it('tier2_list_scenes returns one summary per scene', async () => {
    const res = (await rpcCall(3, 'tools/call', {
      name: 'tier2_list_scenes',
      arguments: {},
    })) as { content: Array<{ text: string }> }
    const summaries = JSON.parse(res.content[0].text) as Array<{ id: string; name: string }>
    expect(summaries.map((s) => s.id)).toEqual(['s-1', 's-2'])
    expect(summaries[0].name).toBe('Opener')
  })

  it('tier2_read_scene returns the full dreambyte.json', async () => {
    const res = (await rpcCall(4, 'tools/call', {
      name: 'tier2_read_scene',
      arguments: { sceneId: 's-1' },
    })) as { content: Array<{ text: string }> }
    const scene = JSON.parse(res.content[0].text) as { id: string; name: string }
    expect(scene.id).toBe('s-1')
    expect(scene.name).toBe('Opener')
  })

  it('tier2_read_scene rejects an out-of-scope sceneId', async () => {
    const res = (await rpcCall(5, 'tools/call', {
      name: 'tier2_read_scene',
      arguments: { sceneId: '../../etc/passwd' },
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/OUT_OF_SCOPE/)
  })

  it('tier2_read_scene_html returns the placeholder HTML', async () => {
    const res = (await rpcCall(6, 'tools/call', {
      name: 'tier2_read_scene_html',
      arguments: { sceneId: 's-1' },
    })) as { content: Array<{ text: string }> }
    expect(res.content[0].text).toContain('doctype html')
  })

  it('tier2_list_assets returns an empty array on a fresh export', async () => {
    const res = (await rpcCall(7, 'tools/call', {
      name: 'tier2_list_assets',
      arguments: {},
    })) as { content: Array<{ text: string }> }
    expect(JSON.parse(res.content[0].text)).toEqual([])
  })
})
