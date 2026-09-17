// @vitest-environment node
//
// Covers the multi-instance safety surface of the terminal bridge:
//  - deleteBridgeDiscoveryFile ownership check (quitting one instance must
//    never delete another instance's bridge.json)
//  - POST /api/open-project (window-follow): auth gate, 400/404 negatives,
//    and the renderer notify on success + on create_project
//
// HOME is redirected to a temp dir BEFORE the bridge module loads — its
// BRIDGE_DISCOVERY_FILE is computed at module load from homedir(), and static
// imports are hoisted above env assignments, so the module (and everything
// that transitively loads it) must be imported DYNAMICALLY after the redirect.

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-test-'))
const tmpDb = path.join(tmpRoot, 'test.db')
process.env.HOME = tmpRoot
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'

const migrationsFolder = path.resolve(__dirname, '../lib/db/migrations')
const BRIDGE_FILE = path.join(tmpRoot, '.dreambyte', 'bridge.json')

type BridgeModule = typeof import('./mcp-bridge')
type HandlerModule = typeof import('@/lib/agents/mcp-handler')
type DbModule = typeof import('@/lib/db')
type SchemaModule = typeof import('@/lib/db/schema')

let bridgeMod: BridgeModule
let handlerMod: HandlerModule
let dbMod: DbModule
let schemaMod: SchemaModule
let bridge: Awaited<ReturnType<BridgeModule['startMcpBridge']>>

beforeAll(async () => {
  const { runMigrations } = await import('@/lib/db/migrate')
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
  bridgeMod = await import('./mcp-bridge')
  handlerMod = await import('@/lib/agents/mcp-handler')
  dbMod = await import('@/lib/db')
  schemaMod = await import('@/lib/db/schema')
  bridge = await bridgeMod.startMcpBridge()
})

afterAll(async () => {
  await bridge.close()
  await dbMod.closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('bridge discovery file ownership', () => {
  it('deletes the file when WE wrote it', async () => {
    await bridgeMod.writeBridgeDiscoveryFile('http://127.0.0.1:50000', 'tok')
    // Sanity: the redirect worked — the file landed in the sandbox.
    await expect(fsp.access(BRIDGE_FILE)).resolves.toBeUndefined()
    await bridgeMod.deleteBridgeDiscoveryFile()
    await expect(fsp.access(BRIDGE_FILE)).rejects.toThrow()
  })

  it('leaves the file alone when ANOTHER instance wrote it (foreign pid)', async () => {
    await fsp.mkdir(path.dirname(BRIDGE_FILE), { recursive: true })
    await fsp.writeFile(
      BRIDGE_FILE,
      JSON.stringify({ url: 'http://127.0.0.1:50001', token: 'other', pid: process.pid + 1 }),
      'utf8',
    )
    await bridgeMod.deleteBridgeDiscoveryFile()
    // Still there — quitting this instance must not sever the other's MCP.
    await expect(fsp.access(BRIDGE_FILE)).resolves.toBeUndefined()
    await fsp.rm(BRIDGE_FILE, { force: true })
  })

  it('removes an unreadable/corrupt file (fail-open cleanup)', async () => {
    await fsp.mkdir(path.dirname(BRIDGE_FILE), { recursive: true })
    await fsp.writeFile(BRIDGE_FILE, 'not json', 'utf8')
    await bridgeMod.deleteBridgeDiscoveryFile()
    await expect(fsp.access(BRIDGE_FILE)).rejects.toThrow()
  })
})

describe('POST /api/open-project (window-follow)', () => {
  function post(p: string, body: unknown, token?: string) {
    return fetch(`${bridge.url}${p}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  }

  it('rejects without the bearer token (auth gate runs before routing)', async () => {
    const res = await post('/api/open-project', { projectId: 'x' })
    expect(res.status).toBe(401)
  })

  it('400s on a missing projectId and 404s on an unknown one — no notify', async () => {
    const notify = vi.fn()
    handlerMod.setRendererNotifier(notify)
    expect((await post('/api/open-project', {}, bridge.token)).status).toBe(400)
    expect((await post('/api/open-project', { projectId: crypto.randomUUID() }, bridge.token)).status).toBe(404)
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies the renderer for an existing project', async () => {
    const [project] = await dbMod.db.insert(schemaMod.projects).values({ name: 'follow-me' }).returning()
    const notify = vi.fn()
    handlerMod.setRendererNotifier(notify)
    const res = await post('/api/open-project', { projectId: project.id }, bridge.token)
    expect(res.status).toBe(200)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(project.id)
  })

  it('create_project notifies the renderer with the new id', async () => {
    const notify = vi.fn()
    handlerMod.setRendererNotifier(notify)
    const res = await post('/api/projects', { name: 'created-via-bridge' }, bridge.token)
    expect(res.status).toBe(200)
    const created = (await res.json()) as { id: string }
    expect(notify).toHaveBeenCalledWith(created.id)
  })
})
