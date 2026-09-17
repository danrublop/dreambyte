/**
 * Per-invocation MCP bridge for the packaged desktop app.
 *
 * Purpose: when the user routes an agent run through their local Claude Code
 * or Codex CLI, that CLI spawns `scripts/mcp/mcp-server.ts` which expects to reach
 * a handful of HTTP endpoints (`GET /api/projects`, `GET /api/scene`,
 * `POST /api/mcp-tool`). In dev those are served by `next dev` on
 * `localhost:3000`, but the packaged app runs zero Next servers by design.
 *
 * This module spins up a tiny 127.0.0.1 HTTP server on an ephemeral port for
 * the lifetime of a single CLI subprocess. The server:
 *   - Binds only to the loopback interface.
 *   - Picks a random free port (port 0).
 *   - Exposes the minimum endpoint set the MCP adapter calls.
 *   - Shuts down when the CLI subprocess exits (or the app quits).
 *
 * This is *not* the main app's web server. The editor renderer never sees
 * this bridge. It exists only to bridge the MCP protocol's stdin/stdout host
 * requirements with our in-process database and tool executor.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { URL } from 'node:url'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { homedir } from 'node:os'
import { db } from '../lib/db'
import * as schema from '../lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { readProjectSceneBlob } from '../lib/db/project-scene-storage'
import { readProjectScenesFromTables } from '../lib/db/project-scene-table'
import { backfillProjectBranch, getOrCreateDefaultBranch } from '../lib/db/queries/branches'
import { executeMcpTool, notifyRenderer } from '../lib/agents/mcp-handler'
import { collectIdUniverse } from '../lib/agents/short-id'
import { createLogger } from '../lib/logger'

const log = createLogger('electron.mcp-bridge')

export interface McpBridge {
  /** Full origin including port, e.g. `http://127.0.0.1:53914`. */
  url: string
  port: number
  /** Shared secret the MCP subprocess must send as `Authorization: Bearer <token>`.
   *  Generated per-invocation; callers forward via the subprocess env so no
   *  other local process can issue commands against the bridge while the CLI
   *  run is in flight. */
  token: string
  close: () => Promise<void>
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString(),
    // The MCP client lives in the same process tree — no need to expose
    // cors-relaxed access to anything else.
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

// Covers the realistic ceiling — a power user with 2,000 projects on one
// machine is well past anything we've seen. If we ever need more, add
// offset/limit pagination here and on the MCP adapter's fetch.
const MCP_BRIDGE_PROJECT_CAP = 2000

async function handleListProjects(res: http.ServerResponse): Promise<void> {
  // Single-user desktop today — no session to resolve, so every project on
  // this machine is fair game. The `DREAMBYTE_MCP_USER_ID` env var is a seam
  // for the auth phase: once `src/electron/main.ts` resolves the logged-in
  // user, it stamps that id here and this filter lights up without
  // touching the bridge code.
  const userId = process.env.DREAMBYTE_MCP_USER_ID
  // Explicit projection. `db.select()` with no column list returned EVERY column
  // of EVERY project — including `description`, the authoritative scene blob, so
  // one list call handed back the full source of every scene of every project on
  // the machine. These are the only fields the MCP adapter reads (listProjects,
  // loadWorldState); outputMode/globalStyle/mp4Settings are real columns, so
  // dropping the blob costs the caller nothing.
  const columns = {
    id: schema.projects.id,
    name: schema.projects.name,
    outputMode: schema.projects.outputMode,
    globalStyle: schema.projects.globalStyle,
    mp4Settings: schema.projects.mp4Settings,
    status: schema.projects.status,
    updatedAt: schema.projects.updatedAt,
  }
  const base = db.select(columns).from(schema.projects)
  const rows = userId
    ? await base
        .where(eq(schema.projects.userId, userId))
        .orderBy(desc(schema.projects.updatedAt))
        .limit(MCP_BRIDGE_PROJECT_CAP)
    : await base.orderBy(desc(schema.projects.updatedAt)).limit(MCP_BRIDGE_PROJECT_CAP)
  sendJson(res, 200, rows)
}

async function handleGetScene(res: http.ServerResponse, projectId: string, sceneId: string | null): Promise<void> {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' })
    return
  }
  // Scope the read to the default branch so the MCP read/list surface shows the
  // SAME scenes the MCP write path (src/lib/agents/mcp-handler.ts) edits — otherwise
  // an unscoped read returns every branch's scenes mixed, and the headless tool
  // sees scenes it then can't edit (the writer only touches the default branch).
  // Backfill first (matches the in-app load) so legacy null-branch rows surface.
  await backfillProjectBranch(projectId)
  const branchId = (await getOrCreateDefaultBranch(projectId)).id
  const tableBacked = await readProjectScenesFromTables(projectId, branchId)
  const blob = readProjectSceneBlob((project as any).description)
  const scenes = tableBacked?.scenes ?? blob.scenes ?? []

  if (sceneId) {
    const scene = scenes.find((s: any) => s.id === sceneId)
    if (!scene) {
      sendJson(res, 404, { error: 'Scene not found' })
      return
    }
    sendJson(res, 200, { scene })
    return
  }

  // Full id universe (scenes + their layers + timeline tracks/clips/markers),
  // computed over the SAME world the MCP write path expands prefixes against
  // (mcp-handler builds `scenes` + `blob.timeline` identically). The light scene
  // list only carries scene ids, so the MCP server can't mint min-unique
  // prefixes that survive expansion against layer/clip ids — it would hand the
  // model an 8-char scene prefix that turns out ambiguous against some layer
  // UUID and get the call rejected. Shipping the full universe lets the read
  // surface mint prefixes unique across EVERYTHING the writer can see.
  const idUniverse = Array.from(collectIdUniverse({ scenes, timeline: blob.timeline ?? null }))
  sendJson(res, 200, {
    scenes: scenes.map((s: any) => ({
      id: s.id,
      name: s.name,
      sceneType: s.sceneType,
      duration: s.duration,
    })),
    idUniverse,
  })
}

async function handleCreateProject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    sendJson(res, 400, { error: 'name is required' })
    return
  }
  const outputMode = body.outputMode === 'interactive' ? 'interactive' : 'mp4'
  const userId = process.env.DREAMBYTE_MCP_USER_ID ?? null
  const [project] = await db
    .insert(schema.projects)
    .values({ name, outputMode, ...(userId ? { userId } : {}) })
    .returning()
  // The terminal session is about to drive this project — show it in the
  // window now rather than on the first scene write. (Scene writes already
  // notify via executeMcpTool.)
  notifyRenderer(project.id)
  sendJson(res, 200, project)
}

/** POST /api/open-project — select_project's window-follow. Validates the id
 *  exists, then asks the renderer to open it. */
async function handleOpenProject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  if (!projectId) {
    sendJson(res, 400, { error: 'projectId required' })
    return
  }
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  if (!project) {
    sendJson(res, 404, { error: 'project not found' })
    return
  }
  notifyRenderer(projectId)
  sendJson(res, 200, { success: true })
}

async function handleMcpTool(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const result = await executeMcpTool({
    projectId: body.projectId,
    toolName: body.toolName,
    args: body.args,
    sandboxMode: body.sandboxMode === true,
  })
  const status = result.error === 'bad_request' ? 400 : result.error === 'project_not_found' ? 404 : 200
  sendJson(res, status, result)
}

function timingSafeEqualString(a: string, b: string): boolean {
  // `crypto.timingSafeEqual` requires equal-length buffers; guard the early
  // bail so a length mismatch doesn't fast-path return false based on timing.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Start the bridge. Returns once it's listening. Caller is responsible for
 * `close()`-ing when the parent subprocess exits.
 *
 * Binds 127.0.0.1:0 — OS picks a free port, and the socket is unreachable
 * from any other interface. A per-invocation random token is issued and the
 * bridge rejects any request missing `Authorization: Bearer <token>`. The
 * token is handed to the MCP subprocess via its env (`DREAMBYTE_BRIDGE_TOKEN`),
 * which the adapter forwards on every fetch. Defense-in-depth — without the
 * token, any other local process on the user's machine (browser tabs, other
 * apps) could hit the bridge while a CLI run is alive and mutate the user's
 * project DB.
 */
export async function startMcpBridge(): Promise<McpBridge> {
  const token = crypto.randomBytes(32).toString('hex')

  const server = http.createServer((req, res) => {
    ;(async () => {
      try {
        if (!req.url || !req.method) {
          sendJson(res, 400, { error: 'Bad request' })
          return
        }

        // Auth gate before any handler touches the DB.
        const authHeader = req.headers.authorization ?? ''
        const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
        if (!presented || !timingSafeEqualString(presented, token)) {
          sendJson(res, 401, { error: 'Unauthorized' })
          return
        }

        // The MCP adapter only calls same-origin paths; `base` is unused for
        // resolution but required by WHATWG URL.
        const parsed = new URL(req.url, `http://127.0.0.1`)

        if (req.method === 'GET' && parsed.pathname === '/api/projects') {
          await handleListProjects(res)
          return
        }

        if (req.method === 'POST' && parsed.pathname === '/api/projects') {
          await handleCreateProject(req, res)
          return
        }

        if (req.method === 'GET' && parsed.pathname === '/api/scene') {
          const projectId = parsed.searchParams.get('projectId')
          const sceneId = parsed.searchParams.get('sceneId')
          if (!projectId) {
            sendJson(res, 400, { error: 'projectId required' })
            return
          }
          await handleGetScene(res, projectId, sceneId)
          return
        }

        if (req.method === 'POST' && parsed.pathname === '/api/mcp-tool') {
          await handleMcpTool(req, res)
          return
        }

        if (req.method === 'POST' && parsed.pathname === '/api/open-project') {
          await handleOpenProject(req, res)
          return
        }

        sendJson(res, 404, { error: 'Not found' })
      } catch (e) {
        log.error('bridge handler threw', { error: e })
        sendJson(res, 500, { error: 'Internal error' })
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('MCP bridge failed to bind an address')
  }
  const port = address.port
  const url = `http://127.0.0.1:${port}`
  log.info('MCP bridge listening', { extra: { url } })

  return {
    url,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        // closeAllConnections() terminates keep-alive connections so server.close()
        // resolves instead of hanging until the MCP subprocess drops its socket.
        if ('closeAllConnections' in server) (server as any).closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// ── Terminal bridge discovery file ──────────────────────────────────────────
// The persistent terminal bridge writes its url+token here so Terminal Claude
// Code can reach the in-process tool executor without being spawned by the app.

const BRIDGE_DISCOVERY_FILE = nodePath.join(homedir(), '.dreambyte', 'bridge.json')

export async function writeBridgeDiscoveryFile(url: string, token: string): Promise<void> {
  const dreambyteDir = nodePath.join(homedir(), '.dreambyte')
  await fs.mkdir(dreambyteDir, { recursive: true })
  // pid-suffixed temp: every instance writes this same legacy file at boot —
  // a FIXED temp name let two concurrent boots interleave write/rename and
  // publish the wrong instance's url+token.
  const tmpPath = BRIDGE_DISCOVERY_FILE + '.tmp-' + process.pid
  await fs.writeFile(tmpPath, JSON.stringify({ url, token, pid: process.pid }), {
    mode: 0o600,
    encoding: 'utf8',
  })
  await fs.rename(tmpPath, BRIDGE_DISCOVERY_FILE)
}

export async function deleteBridgeDiscoveryFile(): Promise<void> {
  // Ownership-checked: with multiple app instances (worktree-per-agent) the
  // legacy file is last-writer-wins — if another instance overwrote it after
  // us, deleting it on OUR quit would sever THAT instance's terminal MCP.
  try {
    const raw = await fs.readFile(BRIDGE_DISCOVERY_FILE, 'utf8')
    const data = JSON.parse(raw) as { pid?: number }
    if (data.pid !== process.pid) return
  } catch {
    // Unreadable/corrupt — fall through and remove it.
  }
  try {
    await fs.unlink(BRIDGE_DISCOVERY_FILE)
  } catch {
    // Already gone — fine.
  }
}
