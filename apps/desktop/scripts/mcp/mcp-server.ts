#!/usr/bin/env npx tsx
/**
 * Dreambyte MCP Server
 *
 * Exposes the same tools as the in-app agent via the Model Context Protocol.
 * Works with Claude Code, Cursor, Windsurf, and any MCP-compatible AI tool.
 *
 * Two transport modes:
 *   stdio  — direct use: npx tsx scripts/mcp/mcp-server.ts
 *   socket — Electron daemon: DREAMBYTE_MCP_SOCKET=~/.dreambyte/mcp.sock (managed by app)
 *
 * Usage:
 *   npx tsx scripts/mcp/mcp-server.ts                    # auto-select most recent project
 *   PROJECT_ID=abc123 npx tsx scripts/mcp/mcp-server.ts  # specific project
 */

import net from 'node:net'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// The adapter uses HTTP only — no DB/env imports needed
import {
  executeToolCall,
  getToolDefinitions,
  setMcpRunMode,
  loadWorldState,
  openProjectInWindow,
  refreshWorld,
  listProjects,
  createProject,
  getSceneList,
  getCurrentProjectId,
  getProjectInfo,
  readScene,
  getMcpIdUniverse,
  expandMcpSceneId,
} from '../../src/lib/agents/mcp-adapter.js'
import { imageContentsFromResultData } from '../../src/lib/agents/mcp-image-content.js'
import { shortenIdsInText, shortenIdsDeep, CODE_BEARING_KEYS, AmbiguousIdError } from '../../src/lib/agents/short-id.js'

// ── Server Setup ────────────────────────────────────────────────────────────

// Build a fresh MCP Server with all handlers registered. In socket mode (see
// main) a NEW server is created per connection: the MCP SDK Server is not safe
// to reuse via close()/connect() across connections — a prior client's unclean
// disconnect leaves the shared instance half-closed, so the next connection's
// `await server.close()` (and thus `initialize`) hangs and wedges every
// reconnect. A per-connection server isolates that completely.
function createServer(): Server {
  const server = new Server(
  {
    name: 'dreambyte',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
    // Instructions are surfaced to every MCP client (Claude Code, Cursor, Codex).
    // Claude Code users also get the full SKILL.md via .claude/skills/dreambyte/.
    // This compact version ensures Cursor/Codex get the critical rules too.
    instructions: `You are generating animated React scenes for Dreambyte desktop.

Key rules:
- Always use sceneType: 'react' for new scenes
- write_scene_code takes top-level string args: sceneCode, styles, name, duration, bgColor, sceneType, sceneId
- Output a <planning> block before generating any scenes
- Call verify_scene after every write_scene_code, add_layer, or regenerate_layer call
- Scene duration formula: max(6, (totalWordCount / 2.5) + 3)
- Use WIDTH and HEIGHT globals (injected at runtime) — never hardcode 1920/1080
- If a tool returns "Dreambyte is not running", stop and tell the user to open the app
- Read tools return entity ids as SHORT prefixes — pass them back exactly as given; every tool accepts the prefix. If an id is reported ambiguous, re-read and use the longer form.
- When a tool is absent, fails, or gives obviously incorrect output, report it a single time with send_feedback, describing the problem in your own words rather than quoting the user.

Scenes render on the timeline automatically when tool calls complete. Do not tell the user to open the app or paste URLs.`,
  },
)

// ── List Tools ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = getToolDefinitions()

  const mcpTools = [
    {
      name: 'create_project',
      description: 'Create a new project and automatically switch to it. Use this before creating scenes for a new video.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string',
            description: 'Project name, e.g. "Product Launch Video" or "SDK Showcase".',
          },
          outputMode: {
            type: 'string',
            enum: ['mp4', 'interactive'],
            description: 'Output mode: "mp4" (default) for video export, "interactive" for published embeds.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'select_project',
      description:
        'Select which project to work with. Lists all projects if no ID provided, or switches to the specified project.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          projectId: {
            type: 'string',
            description: 'Project ID to switch to. Omit to list all projects.',
          },
        },
      },
    },
    {
      name: 'refresh_state',
      description: 'Reload project state from the server. Use after making changes in the app UI to sync.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'set_run_mode',
      description:
        'Set the run mode for this session. "sandbox" replaces ALL paid asset generation (image, video, avatar, narration) with free-local / placeholder assets so you can build and test a full video at $0 — no API spend. "auto" (default) uses the real paid providers. Carries to every subsequent tool call until changed. Call this BEFORE generating if you want a no-spend build.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          mode: { type: 'string', enum: ['auto', 'sandbox'], description: 'auto = real paid providers; sandbox = free placeholders, $0.' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'set_max_run_cost',
      description:
        'Set this MCP session\'s paid-generation spend ceiling in USD (default $25), across ALL projects this run. Once cumulative paid generation (image/video/avatar/narration) would exceed the cap, those calls are blocked until you raise the cap or restart the app. Set 0 to block all paid generation. Use this to bound spend on an autonomous run. Returns the current spend and the new cap.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          capUsd: { type: 'number', description: 'Spend ceiling in USD for this session, all projects (>= 0). 0 blocks all paid generation.' },
        },
        required: ['capUsd'],
      },
    },
    {
      name: 'approve_pending_generation',
      description:
        'Approve a paid generation provider for this project session. Paid providers default to "always ask", so an image/video/avatar/narration call returns a permission-needed response with the provider name and estimated cost. After confirming with the user, call this with that provider name to let the call (and further calls to that provider this session) proceed — still bounded by the cost ceiling (set_max_run_cost). Pass revoke:true to withdraw. Approvals are in-memory and reset when the app restarts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api: { type: 'string', description: 'Provider name from the permission-needed response (e.g. "imageGen", "veo3", "elevenLabs", "heygen").' },
          revoke: { type: 'boolean', description: 'Set true to withdraw a previously granted approval.' },
        },
        required: ['api'],
      },
    },
    {
      name: 'list_scenes',
      description: 'List all scenes in the current project with their IDs, names, types, and durations.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    // write_scene_code is NOT hand-defined here. It ships from the shared registry
    // via the ...tools.map() spread below. Defining it here too would list the name
    // twice with divergent schemas; the registry version is authoritative and is the
    // same schema the in-app agent uses, so MCP and in-app can't drift.
    {
      name: 'get_world_state',
      description:
        'Get the current project state including all scenes, global style, and project settings. Use this to refresh your context after creating or editing scenes — your initial context may be stale.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'read_scene',
      description:
        "Read a scene's full data including all layer code. Use this to inspect existing scene code before editing.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          sceneId: { type: 'string', description: 'Scene ID to read.' },
        },
        required: ['sceneId'],
      },
    },
    ...tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    })),
  ]

  return { tools: mcpTools }
})

// ── Call Tool ───────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'set_run_mode') {
    const mode = (args as any)?.mode === 'sandbox' ? 'sandbox' : 'auto'
    setMcpRunMode(mode)
    return {
      content: [
        {
          type: 'text' as const,
          text:
            mode === 'sandbox'
              ? 'Run mode: SANDBOX. All paid asset generation (image, video, avatar, narration) is now replaced with free placeholders / local system voice — $0 spend. Build the full video freely.'
              : 'Run mode: AUTO. Real paid providers are used for generation.',
        },
      ],
    }
  }

  if (name === 'create_project') {
    const projectName = (args as any)?.name
    const outputMode = (args as any)?.outputMode || 'mp4'
    if (!projectName) {
      return { content: [{ type: 'text' as const, text: 'name is required.' }], isError: true }
    }
    try {
      const project = await createProject(projectName, outputMode)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Created project "${project.name}" (${project.id}). Now active — 0 scenes. Ready for create_scene or write_scene_code.`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to create project: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }

  if (name === 'select_project') {
    const projectId = (args as any)?.projectId
    if (!projectId) {
      const projects = await listProjects()
      return {
        content: [
          {
            type: 'text' as const,
            text: `Available projects:\n${projects.map((p) => `- ${p.id} — ${p.name}`).join('\n')}\n\nCall select_project with a projectId to switch.`,
          },
        ],
      }
    }
    await loadWorldState(projectId)
    // Window-follow: the terminal session now drives this project, so the
    // app window opens it too (best-effort — older bridges lack the endpoint).
    await openProjectInWindow(projectId)
    const scenes = getSceneList()
    return {
      content: [
        {
          type: 'text' as const,
          text: `Switched to project: ${projectId}\n${scenes.length} scenes loaded:\n${scenes.map((s) => `- ${s.id} — "${s.name}" (${s.type}, ${s.duration}s)`).join('\n')}`,
        },
      ],
    }
  }

  if (name === 'refresh_state') {
    await refreshWorld()
    const scenes = getSceneList()
    return {
      content: [
        {
          type: 'text' as const,
          text: `State refreshed. ${scenes.length} scenes:\n${scenes.map((s) => `- ${s.id} — "${s.name}" (${s.type}, ${s.duration}s)`).join('\n')}`,
        },
      ],
    }
  }

  if (name === 'list_scenes') {
    try {
      await loadWorldState(getCurrentProjectId() ?? undefined)
    } catch {}
    const scenes = getSceneList()
    if (!scenes.length) {
      return { content: [{ type: 'text' as const, text: 'No scenes in current project.' }] }
    }
    // Shorten scene ids to their min-unique prefix. Every
    // tool accepts the prefix back (executeTool / executeMcpTool expand it).
    const universe = getMcpIdUniverse()
    return {
      content: [
        {
          type: 'text' as const,
          text: shortenIdsInText(
            scenes.map((s, i) => `${i + 1}. ${s.id} — "${s.name}" (${s.type}, ${s.duration}s)`).join('\n'),
            universe,
          ),
        },
      ],
    }
  }

  // get_world_state: Return full project state for context refresh
  if (name === 'get_world_state') {
    try {
      await refreshWorld()
      const info = getProjectInfo()
      const scenes = getSceneList()

      // Build scene type distribution
      const typeCounts: Record<string, number> = {}
      scenes.forEach((s) => {
        typeCounts[s.type] = (typeCounts[s.type] || 0) + 1
      })

      // Fetch code previews for each scene (lightweight — just first 200 chars)
      const sceneDetails = await Promise.all(
        scenes.map(async (s, i) => {
          try {
            const full = await readScene(s.id)
            const code =
              (full as any).reactCode ||
              (full as any).sceneCode ||
              (full as any).svgContent ||
              (full as any).canvasCode ||
              ''
            return {
              index: i,
              id: s.id,
              name: s.name,
              type: s.type,
              duration: s.duration,
              hasCode: !!code,
              codePreview: code ? code.slice(0, 200) + (code.length > 200 ? '...' : '') : undefined,
              hasAudio: !!(full as any).audioLayer?.enabled,
              hasInteractions: ((full as any).interactions?.length ?? 0) > 0,
            }
          } catch {
            return { index: i, id: s.id, name: s.name, type: s.type, duration: s.duration, hasCode: false }
          }
        }),
      )

      const state = {
        project: info,
        sceneCount: scenes.length,
        totalDuration: scenes.reduce((a, s) => a + s.duration, 0),
        sceneTypeMix: typeCounts,
        scenes: sceneDetails,
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(state, null, 2),
          },
        ],
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get world state: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }

  // read_scene: Read full scene data including layer code
  if (name === 'read_scene') {
    const rawSceneId = (args as any)?.sceneId
    if (!rawSceneId) {
      return { content: [{ type: 'text' as const, text: 'sceneId is required.' }], isError: true }
    }
    // Accept a min-unique id prefix (what list_scenes emits) and expand it.
    let sceneId: string
    const universe = getMcpIdUniverse()
    try {
      sceneId = expandMcpSceneId(String(rawSceneId))
    } catch (e) {
      if (e instanceof AmbiguousIdError) {
        return { content: [{ type: 'text' as const, text: e.message }], isError: true }
      }
      throw e
    }
    try {
      const scene = await readScene(sceneId)
      return {
        content: [
          {
            type: 'text' as const,
            // Shorten known ids on the way out, but KEY-SCOPED: walk the parsed
            // scene and skip code/markup fields (reactCode/sceneCode/html/…) so a
            // UUID baked into rendered code (var SCENE_ID = '<uuid>',
            // getElementById('<uuid>')) is never silently truncated — a later
            // patch_layer_code copies that code back verbatim and a shortened id
            // there would write broken code. Structural id fields still shrink.
            text: JSON.stringify(shortenIdsDeep(scene, universe, { skipKeys: CODE_BEARING_KEYS }), null, 2),
          },
        ],
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to read scene: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }

  // write_scene_code is handled by the executeToolCall path below — the
  // bridge's executeMcpTool covers both create and patch in one place.
  // The legacy direct-fetch branch was deleted along with the Next.js
  // /api/scene POST/PATCH routes in the desktop migration.

  // Execute agent tool
  try {
    const result = await executeToolCall(name, (args as Record<string, unknown>) ?? {})
    const content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    > = [{ type: 'text', text: result.content }]
    // If the tool rendered frame(s) (capture_frame → one image;
    // review_video → one per scene), surface them as image content blocks so the
    // model actually SEES the pixels, not just the caption.
    for (const image of imageContentsFromResultData(result.data)) content.push(image)
    return {
      content,
      ...(result.success ? {} : { isError: true }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    }
  }
})

// ── Resources ───────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'dreambyte://project/scenes',
        name: 'Current Scenes',
        description: 'List of all scenes in the current project',
        mimeType: 'application/json',
      },
      {
        uri: 'dreambyte://project/info',
        name: 'Project Info',
        description: 'Current project ID, name, and settings',
        mimeType: 'application/json',
      },
    ],
  }
})

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri

  if (uri === 'dreambyte://project/scenes') {
    try {
      await loadWorldState(getCurrentProjectId() ?? undefined)
    } catch {}
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(getSceneList(), null, 2) }],
    }
  }

  if (uri === 'dreambyte://project/info') {
    const info = getProjectInfo()
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(info, null, 2),
        },
      ],
    }
  }

  throw new Error(`Unknown resource: ${uri}`)
})

  return server
}

// ── Start ───────────────────────────────────────────────────────────────────

/** Constant-time string compare — never leak the token via response timing. */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

const AUTH_PREFIX = 'AUTH '
const MAX_AUTH_LINE = 512
const AUTH_TIMEOUT_MS = 5000

/**
 * Socket authentication.
 *
 * Previously ANY connection to `~/.dreambyte/instances/<id>/mcp.sock` was handed
 * a full MCP `Server` — the only protection was the 0700 parent dir. A client
 * must now open with `AUTH <bridge token>\n` before any JSON-RPC. The token
 * already exists (the daemon holds it for the HTTP bridge) and the connector
 * reads it from the same instance manifest it uses to FIND the socket, so this
 * adds no new plumbing and no new secret at rest.
 *
 * Honest scope: this raises the bar to "can read the instance manifest", which
 * under a 0700 dir is still the same UNIX user. The gate that actually stops a
 * rogue same-user process from spending the user's API credits is the human
 * confirmation on `set_max_run_cost` / `approve_pending_generation`
 * (src/lib/agents/mcp-handler.ts). This is defence in depth, not the lock.
 *
 * Resolves to the stream the transport should read (the socket's remainder
 * after the auth line), or null if the peer must be dropped.
 */
export function authenticateSocket(
  socket: net.Socket,
  authToken: string,
  timeoutMs = AUTH_TIMEOUT_MS,
): Promise<NodeJS.ReadableStream | null> {
  // No token configured (a hand-run daemon). Nothing to check against, and
  // refusing every client would just make the socket useless.
  if (!authToken) return Promise.resolve(socket)

  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    // A peer that connects and says nothing must not hold the single active
    // socket slot open forever.
    const timer = setTimeout(() => finish(null), timeoutMs)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl === -1) {
        if (buf.length > MAX_AUTH_LINE) finish(null)
        return
      }
      const line = buf.subarray(0, nl).toString('utf8').trim()
      const rest = buf.subarray(nl + 1)
      if (!line.startsWith(AUTH_PREFIX) || !timingSafeEqualString(line.slice(AUTH_PREFIX.length), authToken)) {
        finish(null)
        return
      }
      // Hand the transport a stream replaying whatever arrived after the auth
      // line. Simpler and safer than unshift()ing onto an already-flowing socket.
      const inbound = new PassThrough()
      if (rest.length) inbound.write(rest)
      socket.off('data', onData)
      socket.pipe(inbound)
      finish(inbound)
    }
    const onClose = () => finish(null)
    const finish = (result: NodeJS.ReadableStream | null) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      resolve(result)
    }
    socket.once('close', onClose)
    socket.on('data', onData)
  })
}

function preloadState(projectId?: string) {
  loadWorldState(projectId)
    .then(() => {
      console.error(
        `[dreambyte-mcp] Loaded project ${getCurrentProjectId()} with ${getSceneList().length} scenes`,
      )
    })
    .catch((e) => {
      console.error(`[dreambyte-mcp] Warning: Could not pre-load project state. Is the app running?`)
      console.error(`[dreambyte-mcp]   ${e instanceof Error ? e.message : String(e)}`)
      console.error(`[dreambyte-mcp] Tools are still available — state will load on first tool call.`)
    })
}

async function main() {
  const projectId = process.env.PROJECT_ID || undefined
  const socketPath = process.env.DREAMBYTE_MCP_SOCKET

  if (socketPath) {
    // ── Socket mode: Electron manages this process, clients connect per-session ──
    // Clean up any stale socket left by a prior crash.
    try { await fs.unlink(socketPath) } catch {}

    // One active session at a time, latest wins. We can't use
    // socketServer.maxConnections = 1 here: when a previous client exits
    // without cleanly closing (Claude Code session crash, OS reap, etc.),
    // node keeps counting the dead FD against the limit and silently
    // rejects every reconnect. Instead, track the live socket and
    // destroy() it when a new one arrives — this guarantees forward
    // progress even after a stale client.
    const authToken = process.env.DREAMBYTE_BRIDGE_TOKEN || ''
    if (!authToken) {
      console.error('[dreambyte-mcp] WARNING: no DREAMBYTE_BRIDGE_TOKEN — socket accepts unauthenticated clients')
    }

    let activeSocket: net.Socket | null = null
    const socketServer = net.createServer(async (socket) => {
      // Latest client wins: drop any prior socket. We can't use maxConnections
      // here — a dead FD keeps counting against the limit and silently rejects
      // every reconnect.
      if (activeSocket) activeSocket.destroy()
      activeSocket = socket
      // Authenticate BEFORE building a server for this connection — an
      // unauthenticated peer must never reach the MCP tool surface.
      const inbound = await authenticateSocket(socket, authToken)
      if (!inbound) {
        console.error('[dreambyte-mcp] rejected unauthenticated socket connection')
        if (activeSocket === socket) activeSocket = null
        socket.destroy()
        return
      }
      // Fresh server per connection. Reusing one shared server across
      // connections via close()/connect() wedges: a prior unclean disconnect
      // leaves it half-closed so the next `await server.close()` (and thus
      // `initialize`) never resolves. A per-connection server scopes all
      // lifecycle to this socket, so one stale client can't block reconnects.
      const connServer = createServer()
      const transport = new StdioServerTransport(inbound as any, socket as any)
      try {
        await connServer.connect(transport)
      } catch (err) {
        console.error(
          `[dreambyte-mcp] connect failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        if (activeSocket === socket) activeSocket = null
        socket.destroy()
        return
      }
      socket.on('close', () => {
        if (activeSocket === socket) activeSocket = null
        // Scoped to THIS connection's server — even if it hangs it can't block
        // future connections (they each build their own server).
        void connServer.close().catch(() => {})
      })
      // Suppress EPIPE — emitted when the other end closes while data is in flight.
      socket.on('error', () => {})
    })

    // Without this handler a listen failure (ENOENT — instance dir removed
    // under us, EADDRINUSE, EACCES) is an UNHANDLED 'error' event: the daemon
    // dies ungracefully and the manager respawns into the same failure. Exit
    // cleanly instead so the manager's controlled respawn (which re-creates
    // the socket dir + applies backoff) gets a fresh chance.
    socketServer.on('error', (err) => {
      console.error(`[dreambyte-mcp] socket server error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
    socketServer.listen(socketPath, () => {
      console.error(`[dreambyte-mcp] Listening on ${socketPath}`)
    })

    // Load state after the socket is listening — never blocks accepting connections.
    preloadState(projectId)
  } else {
    // ── Stdio mode: direct CLI use ──
    // Connect transport FIRST so Claude Code's MCP init sees the server
    // immediately. State loading happens async and never blocks tool availability.
    const server = createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('[dreambyte-mcp] Server started on stdio')

    preloadState(projectId)
  }
}

// Guarded so importing this module (mcp-server-auth.test.ts imports
// authenticateSocket) doesn't start a real server on the test process's stdio.
if (!process.env.VITEST) {
  main().catch((e) => {
    console.error('[dreambyte-mcp] Fatal:', e)
    process.exit(1)
  })
}
