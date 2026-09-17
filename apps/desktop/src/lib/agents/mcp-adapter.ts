/**
 * MCP Adapter — bridges MCP tool calls to the Dreambyte agent tool executor
 * via the HTTP API. This avoids importing DB modules directly, keeping the
 * MCP server lightweight and dependency-free.
 */

import { join as joinPath } from 'node:path'
import { homedir } from 'node:os'
import fs from 'node:fs/promises'
import { DEFAULT_ACTIVE_TOOLS, filterToolsForAgent } from './context-builder'
import { resolveProjectDimensions } from '../dimensions'
import type { ClaudeToolDefinition } from './types'
import { createLogger } from '../logger'
import { MEDIA_GEN_TOOL_TIMEOUT_MS, MCP_BRIDGE_MARGIN_MS } from './tool-timeouts'
import { collectIdUniverse, expandIdPrefix } from './short-id'

const log = createLogger('agent.mcp-adapter')

// Set to the Electron mcp-bridge URL when the MCP server is spawned by the
// desktop app. No silent fallback: running this against `next dev` was the
// historical fallback, but those /api/* routes were deleted in the desktop
// migration, so a default value would just produce 404s.
const BASE_URL = process.env.DREAMBYTE_STUDIO_URL || ''
// When the MCP server is spawned against the packaged desktop's ephemeral
// 127.0.0.1 bridge, the Electron main process hands us a per-invocation
// token in this env var. The bridge rejects requests without it, so any
// other local process that lucks into the port can't issue commands.
// Empty in dev (Next server doesn't enforce) — the header is simply absent.
const BRIDGE_TOKEN = process.env.DREAMBYTE_BRIDGE_TOKEN ?? ''

// ── Bridge discovery ────────────────────────────────────────────────────────
// When Terminal Claude Code runs outside the app's MCP subprocess (no env
// vars), fall back to the persistent terminal bridge written to disk by the
// Electron main process at launch.

const BRIDGE_DISCOVERY_FILE = joinPath(homedir(), '.dreambyte', 'bridge.json')

interface BridgeDiscovery {
  url: string
  token: string
  pid: number
}

let _bridgeDiscoveryCache: BridgeDiscovery | null = null

/** @internal test helper — resets the module-level discovery cache between tests */
export function clearBridgeDiscoveryCache(): void {
  _bridgeDiscoveryCache = null
}

async function readBridgeDiscovery(): Promise<BridgeDiscovery | null> {
  // Fast path: validate the cached entry's pid is still alive (app not restarted).
  if (_bridgeDiscoveryCache) {
    try {
      process.kill(_bridgeDiscoveryCache.pid, 0)
      return _bridgeDiscoveryCache
    } catch {
      _bridgeDiscoveryCache = null
    }
  }
  // Per-instance path first: the daemon is spawned with DREAMBYTE_INSTANCE_ID,
  // so after an app restart it re-discovers ITS OWN instance's manifest — not
  // whichever instance most recently overwrote the legacy singleton file
  // (the multi-instance wrong-window footgun). Same id ⇒ same userData dir ⇒
  // the restarted app this daemon belongs to.
  const instanceId = process.env.DREAMBYTE_INSTANCE_ID
  if (instanceId) {
    try {
      const { selectInstance } = await import('../mcp/instance-registry')
      const { manifest } = await selectInstance({ envId: instanceId })
      if (manifest && manifest.instanceId === instanceId) {
        _bridgeDiscoveryCache = { url: manifest.url, token: manifest.token, pid: manifest.pid }
        return _bridgeDiscoveryCache
      }
    } catch {
      // Registry unreadable — fall through to the legacy file.
    }
  }
  // Legacy slow path: read the singleton file, validate, cache.
  try {
    const raw = await fs.readFile(BRIDGE_DISCOVERY_FILE, 'utf8')
    const data = JSON.parse(raw) as BridgeDiscovery
    if (!data.url || !data.token || typeof data.pid !== 'number' || data.pid <= 0) return null
    // Guard against a poisoned bridge.json redirecting calls to a non-loopback host.
    try {
      if (new URL(data.url).hostname !== '127.0.0.1') return null
    } catch {
      return null
    }
    // Confirm the Electron process that wrote this file is still alive.
    process.kill(data.pid, 0)
    _bridgeDiscoveryCache = data
    return data
  } catch {
    _bridgeDiscoveryCache = null
    return null
  }
}

// ── HTTP Helpers ────────────────────────────────────────────────────────────

function connectionErrorCode(e: Error): string {
  const cause = e.cause as { code?: string; errors?: Array<{ code?: string }> } | undefined
  // undici wraps dial failures as TypeError('fetch failed') with the real
  // code on cause (or cause.errors[0] for AggregateError on multi-addr hosts).
  return cause?.code ?? cause?.errors?.[0]?.code ?? ''
}

/** A connection-level failure (dead bridge), as opposed to an HTTP error or a
 *  request timeout. These are what an app restart produces: the env-frozen
 *  BASE_URL points at the previous instance's port. Timeouts are deliberately
 *  excluded — a slow-but-alive app must not trigger re-discovery.
 *  @internal exported for tests */
export function isConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return false
  const code = connectionErrorCode(e)
  return (
    e.message.includes('fetch failed') ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'ENOENT' ||
    code === 'UND_ERR_SOCKET'
  )
}

/** PRE-SEND dial failures only — the request provably never reached the
 *  bridge, so re-sending the body cannot double-execute a mutation. Post-send
 *  resets (ECONNRESET/UND_ERR_SOCKET — the bridge may have processed the
 *  request and died before the response arrived) and cause-less failures are
 *  deliberately NOT retry-eligible: replaying a mutating POST across an app
 *  restart would e.g. duplicate a create_scene (server-minted uuid).
 *  @internal exported for tests */
export function isPreSendConnectionError(e: unknown): boolean {
  if (!isConnectionError(e)) return false
  const code = connectionErrorCode(e as Error)
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ENOENT' || code === 'EAI_AGAIN'
}

// When the app restarts, the env-var BASE_URL/BRIDGE_TOKEN this process was
// spawned with point at the DEAD instance. After a successful re-discovery,
// the live bridge is remembered here so subsequent calls skip the dead probe.
let _liveBridgeOverride: { url: string; token: string } | null = null

/** @internal test helper */
export function clearLiveBridgeOverride(): void {
  _liveBridgeOverride = null
}

async function apiFetch(path: string, options?: RequestInit, toolName?: string): Promise<any> {
  let baseUrl = _liveBridgeOverride?.url || BASE_URL
  let bridgeToken = _liveBridgeOverride?.token ?? BRIDGE_TOKEN

  if (!baseUrl) {
    const discovery = await readBridgeDiscovery()
    if (!discovery) {
      throw new Error(
        'Dreambyte is not running. Open the app and try again.\n' +
          '(If the app just launched, wait a moment for it to initialize then retry.)',
      )
    }
    baseUrl = discovery.url
    bridgeToken = discovery.token
  }

  const doFetch = async (base: string, token: string): Promise<any> => {
    const url = `${base}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string> | undefined),
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const timeoutMs = toolName && SLOW_GENERATION_TOOLS.has(toolName) ? GENERATION_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS
    const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API ${res.status}: ${path} — ${body}`)
    }
    return res.json()
  }

  try {
    return await doFetch(baseUrl, bridgeToken)
  } catch (e) {
    if (!isConnectionError(e)) throw e
    // The app likely RESTARTED under us: the env-frozen BASE_URL/BRIDGE_TOKEN
    // point at the dead instance. Re-discover the live bridge from bridge.json
    // (rewritten by the new instance at launch) and retry once — turning the
    // historical "every tool fails with a bare 'fetch failed' until the user
    // runs /mcp reconnect" into a transparent reconnect. RETRY SAFETY: the
    // body-replaying retry fires only for pre-send dial failures (the request
    // never reached a bridge); post-send resets get the clear error instead —
    // the old instance may have already executed the mutation, and replaying
    // it on the new instance would double-execute (duplicate create_scene etc.).
    clearBridgeDiscoveryCache()
    const discovery = await readBridgeDiscovery()
    if (isPreSendConnectionError(e) && discovery && (discovery.url !== baseUrl || discovery.token !== bridgeToken)) {
      log.warn('bridge unreachable — re-discovered live bridge after app restart', {
        extra: { dead: baseUrl, live: discovery.url },
      })
      const result = await doFetch(discovery.url, discovery.token)
      _liveBridgeOverride = { url: discovery.url, token: discovery.token }
      return result
    }
    throw new Error(
      `APP_RESTARTED: Dreambyte's MCP bridge at ${baseUrl} is unreachable — the app restarted or is not running. ` +
        'Launch (or restart) Dreambyte and retry; if tools still fail, run /mcp reconnect in your MCP client.',
      { cause: e },
    )
  }
}

// ── State ───────────────────────────────────────────────────────────────────

let currentProjectId: string | null = null
let cachedScenes: { id: string; name: string; sceneType: string; duration: number }[] = []
/** Full id universe (scenes + layers + timeline clips/markers) the bridge ships
 *  alongside the light scene list — the SAME set the MCP write path expands
 *  prefixes against. Used to mint min-unique prefixes that survive expansion.
 *  Empty until the first `loadWorldState`. */
let cachedIdUniverse: Set<string> = new Set()
let cachedProjectInfo: {
  name: string
  outputMode: string
  globalStyle: Record<string, unknown>
  mp4Settings: import('../types').MP4Settings | null
} | null = null

// Run mode for the MCP/Claude-Code session. 'sandbox' replaces paid asset
// generation with free-local / placeholder assets (carried on every tool call).
// Toggled by the `set_run_mode` MCP tool; defaults to 'auto' (paid, current behavior).
let mcpRunMode: 'auto' | 'sandbox' = 'auto'
export function setMcpRunMode(mode: 'auto' | 'sandbox'): void {
  mcpRunMode = mode
}

// ── Project Management ──────────────────────────────────────────────────────

export async function listProjects(): Promise<{ id: string; name: string }[]> {
  const projects = await apiFetch('/api/projects')
  return projects.map((p: any) => ({ id: p.id, name: p.name }))
}

export async function createProject(
  name: string,
  outputMode: 'mp4' | 'interactive' = 'mp4',
): Promise<{ id: string; name: string }> {
  const project = await apiFetch('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name, outputMode }),
  })
  await loadWorldState(project.id)
  return { id: project.id, name: project.name }
}

/** Ask the app window to open a project (select_project's window-follow).
 *  Best-effort: selection succeeds even when the window can't follow. NOT
 *  called from loadWorldState — internal refreshes must not yank the window. */
export async function openProjectInWindow(projectId: string): Promise<void> {
  try {
    await apiFetch('/api/open-project', { method: 'POST', body: JSON.stringify({ projectId }) })
  } catch {
    // Bridge without the endpoint (older app) or transient failure — fine.
  }
}

export async function loadWorldState(projectId?: string): Promise<void> {
  if (!projectId) {
    const projects = await listProjects()
    if (!projects.length) throw new Error('No projects found.')
    projectId = projects[0].id
  }

  currentProjectId = projectId

  // Load project info
  try {
    const projects = await apiFetch('/api/projects')
    const project = projects.find((p: any) => p.id === projectId)
    if (project) {
      // outputMode / globalStyle are real projects columns. They used to be read
      // out of the `description` blob, which forced the bridge to ship every
      // project's full scene source on every list call — see handleListProjects.
      cachedProjectInfo = {
        name: project.name,
        outputMode: project.outputMode ?? 'mp4',
        globalStyle: project.globalStyle ?? {},
        // mp4Settings is a projects column (set by set_aspect_ratio / export).
        // Surfaced so the headless agent can READ the aspect ratio it set.
        mp4Settings: project.mp4Settings ?? null,
      }
    }
  } catch {
    // Non-fatal — project info is optional context
  }

  // Load scene list
  const scenesData = await apiFetch(`/api/scene?projectId=${projectId}`)
  cachedScenes = (scenesData.scenes ?? []).map((s: any) => ({
    id: s.id,
    name: s.name,
    sceneType: s.sceneType ?? 'svg',
    duration: s.duration,
  }))
  // Full id universe shipped by the bridge (scenes + layers + clips + markers).
  // Fall back to scene ids only for an older bridge that doesn't send it — that
  // reproduces the pre-fix narrow universe (recoverable spurious-ambiguity, not
  // silent mis-resolution), never invents ids.
  cachedIdUniverse = Array.isArray(scenesData.idUniverse)
    ? new Set<string>(scenesData.idUniverse.filter((x: unknown): x is string => typeof x === 'string'))
    : collectIdUniverse({ scenes: cachedScenes })
}

export async function refreshWorld(): Promise<void> {
  return loadWorldState(currentProjectId ?? undefined)
}

export function getCurrentProjectId(): string | null {
  return currentProjectId
}

export function getSceneList(): { id: string; name: string; type: string; duration: number }[] {
  return cachedScenes.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.sceneType,
    duration: s.duration,
  }))
}

/**
 * Live id universe for the MCP server's own read handlers (list_scenes /
 * read_scene). This is the FULL universe (scenes + layers + timeline
 * clips/markers) shipped by the bridge — the exact set the MCP write path
 * expands prefixes against (executeTool → expandIdArgs → collectIdUniverse).
 * Minting and expanding against one universe means a min-unique prefix we emit
 * stays unique on the way back, so no scene prefix is ever spuriously rejected
 * as ambiguous against a layer/clip id. Falls back to
 * scene ids only when the cache is empty (no load yet) or an older bridge
 * omitted the universe.
 */
export function getMcpIdUniverse(): Set<string> {
  return cachedIdUniverse.size > 0 ? cachedIdUniverse : collectIdUniverse({ scenes: cachedScenes })
}

/** Expand a scene-id PREFIX to its full id against the live MCP universe. Throws
 *  AmbiguousIdError on a prefix matching several scenes; returns the input
 *  untouched when unknown (so read_scene surfaces its own not-found). */
export function expandMcpSceneId(ref: string): string {
  return expandIdPrefix(ref, getMcpIdUniverse())
}

export function getProjectInfo(): {
  projectId: string | null
  name: string
  outputMode: string
  globalStyle: Record<string, unknown>
  aspectRatio: string
  resolution: string
  dimensions: { width: number; height: number }
} {
  const mp4 = cachedProjectInfo?.mp4Settings ?? null
  const aspectRatio = mp4?.aspectRatio ?? '16:9'
  const resolution = mp4?.resolution ?? '1080p'
  const dimensions = resolveProjectDimensions(mp4?.aspectRatio, mp4?.resolution)
  return {
    projectId: currentProjectId,
    name: cachedProjectInfo?.name ?? 'Unknown',
    outputMode: cachedProjectInfo?.outputMode ?? 'mp4',
    globalStyle: cachedProjectInfo?.globalStyle ?? {},
    // The frame shape the agent's scenes actually render at — so it can confirm
    // set_aspect_ratio took, and reason about WIDTH/HEIGHT, without guessing.
    aspectRatio,
    resolution,
    dimensions,
  }
}

/** Fetch a single scene with full layer code from the API */
export async function readScene(sceneId: string): Promise<Record<string, unknown>> {
  const pid = currentProjectId
  if (!pid) throw new Error('No project selected.')
  const data = await apiFetch(`/api/scene?projectId=${pid}&sceneId=${sceneId}`)
  return data.scene ?? data
}

// ── Tool Execution ──────────────────────────────────────────────────────────

export interface MCPToolCallResult {
  success: boolean
  content: string
  data?: unknown
}

/** Generation tools that call external LLM/TTS/avatar APIs — use a long HTTP
 *  timeout to match tool-executor.ts's own 120s generation timeout.
 *  Read/list tools keep the 8s fast timeout for quick failure. */
const SLOW_GENERATION_TOOLS = new Set([
  'add_layer',
  'regenerate_layer',
  'write_scene_code',
  'chart',
  // Paid MEDIA_GEN tools (mirror tool-executor's MEDIA_GEN_TOOL_SET): a 70-110s
  // Flux/TTS/SFX/music round-trip blows the 8s read timeout, gets the call
  // retried, and orphans the already-billed asset on the MCP path — same bug as
  // the in-app getToolTimeout gap. Keep these in sync.
  'generate_image',
  'add_sfx',
  'add_music',
  'add_narration',
  'generate_avatar_narration',
  'generate_avatar_scene',
  'dub_video',
  'clone_voice',
  // i2i and re-roll are generate_image(source:…) — the merged name above covers them.
  // Visual-feedback tools render frames in an offscreen window. capture_frame is a single frame (seconds); review(scope:'cut') renders one
  // frame per scene (up to MAX_REVIEW_FRAMES) and review(scope:'motion') renders a
  // whole clip — all easily exceed the 8s read timeout, so they need the long one.
  'capture_frame',
  'review',
])

/** Fast timeout for read/list tools; long timeout for generation tools that
 *  invoke external APIs (TTS, avatar, LLM). */
const FETCH_TIMEOUT_MS = 8_000
/**
 * Long fetch timeout for slow tools. DERIVED from the shared paid-media tier
 * (+ bridge margin) so the client fetch always outlasts the server's 180s
 * deadline. The old flat 130s aborted a legitimate 150s Flux/avatar/dub call,
 * which then retried and double-billed the already-charged asset over MCP —
 * the one-definition fix for that divergence (Lane D). All slow tools share
 * the media ceiling; generation tools (120s) finish well within it.
 */
export const GENERATION_FETCH_TIMEOUT_MS = MEDIA_GEN_TOOL_TIMEOUT_MS + MCP_BRIDGE_MARGIN_MS

/** Tools that LLM-generate content — benefit from retry on transient failures
 *  (empty code, API timeout, rate limit, etc.). Surgical tools (reorder, patch)
 *  are NOT retried because a failure there likely indicates a real problem, not
 *  a transient one. Mirrors the in-app runner's GENERATION_TOOL_SET. */
const RETRYABLE_MCP_TOOLS = new Set([
  'add_layer',
  'regenerate_layer',
  'write_scene_code',
  'chart',
  'add_narration',
  'generate_avatar_narration',
  'generate_avatar_scene',
  'generate_image',
])

/** Patterns that indicate a transient failure worth retrying. */
function isTransientError(errText: string): boolean {
  const s = (errText ?? '').toLowerCase()
  return (
    s.includes('timeout') ||
    s.includes('timed out') ||
    s.includes('rate limit') ||
    s.includes('429') ||
    s.includes('503') ||
    s.includes('504') ||
    s.includes('econnreset') ||
    s.includes('empty code') ||
    s.includes('empty response') ||
    s.includes('failed to parse')
  )
}

/**
 * Execute a tool call via the HTTP API endpoint.
 * The endpoint loads world state, runs the tool handler, and persists changes.
 * For known-flaky generation tools, retries once on transient errors.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  projectId?: string,
): Promise<MCPToolCallResult> {
  const pid = projectId ?? currentProjectId
  if (!pid) throw new Error('No project selected. Call select_project first.')

  const maxAttempts = RETRYABLE_MCP_TOOLS.has(toolName) ? 2 : 1
  let result: any
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await apiFetch(
      '/api/mcp-tool',
      {
        method: 'POST',
        body: JSON.stringify({ projectId: pid, toolName, args, sandboxMode: mcpRunMode === 'sandbox' }),
      },
      toolName,
    )
    const shouldRetry =
      !result.success &&
      !result.permissionNeeded &&
      attempt < maxAttempts &&
      typeof result.error === 'string' &&
      isTransientError(result.error)
    if (!shouldRetry) break
    // Exponential-ish backoff with a small jitter.
    const waitMs = 400 * attempt + Math.floor(Math.random() * 250)
    log.warn('transient tool failure, retrying', {
      extra: { toolName, attempt, error: result.error?.slice(0, 120), waitMs },
    })
    await new Promise((r) => setTimeout(r, waitMs))
  }

  // Refresh scene cache after successful mutations
  if (result.success) {
    try {
      await refreshWorld()
    } catch {
      // Non-fatal
    }
  }

  // Surface permission blocks as clear, actionable messages so Claude Code
  // can inform the user (the MCP path has no interactive approval UI).
  if (result.permissionNeeded) {
    const pn = result.permissionNeeded
    return {
      success: false,
      content:
        `Permission required: ${pn.api ?? 'API'} usage needs approval.\n` +
        `Reason: ${pn.reason ?? 'Agent requested a paid API'}\n` +
        `Estimated cost: ${pn.estimatedCost ?? 'unknown'}\n\n` +
        `To approve, open the app's Settings → Permissions panel and set the API to "always allow", ` +
        `or use a free provider instead (e.g., provider: "openai-edge-tts" for TTS).`,
      data: result.data,
    }
  }

  return {
    success: result.success,
    content: result.content ?? result.error ?? 'Unknown result',
    data: result.data,
  }
}

// ── Tool Schema Export ──────────────────────────────────────────────────────

export function getToolDefinitions(): ClaudeToolDefinition[] {
  // Offered surface (MCP tools/list). This runs the SAME gate as an in-app run
  // (`filterToolsForAgent`), so a tool the agent can't be offered isn't offered to
  // Claude Code either. It previously returned MCP_TOOLS unfiltered — 107 tools vs
  // the agent's 65 — which meant every gating fix landed on one surface only.
  //
  // ONE exception, deliberate: `assumeProvidersReady`. Provider readiness is
  // `!!process.env[KEY]`, and this process is the mcp-server daemon, whose env is a
  // spawn-time copy of the app's (src/electron/mcp-server-manager.ts) that
  // `setProviderKey` never updates — plus the stdio path has no keys at all. Gating
  // on our own env would hide generate_image from a fully-keyed app. Those tools
  // honest-fail app-side instead, where the key actually is. See the param doc on
  // filterToolsForAgent.
  //
  // activeTools = DEFAULT_ACTIVE_TOOLS: chips are an in-app UI concept, and MCP has
  // no chip state to read, so it gets what a fresh run gets. `[]` would mean "the
  // user turned every chip off" — the smallest surface, not the neutral one.
  const gated = filterToolsForAgent(
    'scene-maker',
    [...DEFAULT_ACTIVE_TOOLS],
    undefined,
    undefined,
    undefined,
    true, // webSearch — the MCP client decides whether to call it
    true, // webFetch
    undefined,
    false, // not a sub-agent
    undefined, // outputMode unknown here; keeps use_template
    false, // sub-agent dispatch: no runner loop on this path (see MCP_IMPOSSIBLE below)
    true, // assumeProvidersReady — see above
  )
  return gated.filter((t) => !MCP_IMPOSSIBLE_TOOL_NAMES.has(t.name))
}

/**
 * Tools whose only consumer is the in-app runner loop or the renderer, so over MCP
 * they can never do anything. Each one already honest-fails at execution — this stops us charging ~1.9kB of schema per
 * tools/list for the privilege of letting the model discover that at turn cost.
 *
 * `start_recording` needs no entry: it isn't in AGENT_TOOLS['scene-maker'] at all
 * (MCP_TOOLS was the only thing adding it), so the gate drops it on its own.
 */
const MCP_IMPOSSIBLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // world.fanoutAvailable is set only by the in-app runner (tool-executor.ts).
  'dispatch_to_branches',
  'dispatch_to_projects',
  // clarificationNeeded needs the in-app card to answer + resume; mcp-handler.ts
  // turns it into an error telling the model to state its assumption and proceed.
  'ask_user',
])
