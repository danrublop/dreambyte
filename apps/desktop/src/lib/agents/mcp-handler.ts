/**
 * Shared MCP tool execution logic.
 *
 * Pure function (no HTTP, no Next runtime), called from the Electron main
 * process via `src/electron/mcp-bridge.ts` — the 127.0.0.1 bridge that
 * `scripts/mcp/mcp-server.ts` calls back into for Claude Code / Cursor / Codex
 * (external MCP clients and CLI-routed agent runs).
 *
 * The packaged desktop stamps `DREAMBYTE_SCENES_DIR` / `DREAMBYTE_UPLOADS_DIR` etc.
 * into `process.env` at boot (see src/electron/main.ts), so `generateSceneHTML`
 * + the scene writer below resolve to `<userData>/scenes` instead of the
 * read-only `<Resources>/public/scenes` in the packaged bundle.
 */

import type { Scene, GlobalStyle } from '@/lib/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { ToolResult } from '@/lib/agents/types'
import { createExportJob, updateExportJob, getExportJob, errorJobPatch } from '@/lib/agents/export-jobs'
import {
  isExportClientAction,
  isVisualFeedbackClientAction,
  isPrimaryVisualFeedbackTool,
  reviewToolUnfulfillable,
} from '@/lib/agents/client-action'
import { executeTool, SCENE_ID_RE } from '@/lib/agents/tool-executor'
import { db } from '@/lib/db'
import * as schema from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { readProjectScenesFromTables, writeProjectScenesToTablesTx } from '@/lib/db/project-scene-table'
import { readProjectSceneBlob, writeProjectSceneBlob } from '@/lib/db/project-scene-storage'
import { TIMELINE_TOOL_NAMES } from '@/lib/agents/tool-handlers/timeline-tools'
import { getOrCreateDefaultBranch, backfillProjectBranch } from '@/lib/db/queries/branches'
import { withWriterGate } from '@/lib/db/queries/branch-locks'
import { createDefaultAPIPermissions } from '@/lib/permissions'
import { getResearchSessionGrant, researchGrantWorldFields } from '@/lib/agents/research-session-grants'
import { createLogger } from '@/lib/logger'
import { generateSceneHTML } from '@/lib/sceneTemplate'
import { resolveProjectDimensions } from '@/lib/dimensions'
import { resolveStyle } from '@/lib/styles/presets'
import { makeRunCostLedger, refundCost, type RunCostLedger } from '@/lib/agents/run-cost-ledger'
import fs from 'fs/promises'
import path from 'path'
import { resolveScenesDir } from '@/lib/scene-html-paths'

const log = createLogger('agent.mcp-handler')

// Optional callback registered by src/electron/main.ts so the renderer's Zustand
// store is refreshed after any MCP tool writes scenes. Without this, the UI
// never learns that terminal-Claude added scenes to the DB.
let _rendererNotifier: ((projectId: string) => void) | null = null

export function setRendererNotifier(fn: (projectId: string) => void): void {
  _rendererNotifier = fn
}

/** Fire the renderer notifier directly. Used by bridge endpoints whose writes
 *  happen outside executeMcpTool (create_project) or that change which project
 *  the terminal session is driving (select_project) — the window should follow. */
export function notifyRenderer(projectId: string): void {
  if (_rendererNotifier) _rendererNotifier(projectId)
}

// Optional callback registered by src/electron/main.ts that runs the renderer's
// headless exportVideo() (Pixi/WebCodecs lives in the renderer) and resolves
// with the written file path. Lets the MCP / external-agent path finish an
// MP4 export itself instead of only opening the export modal.
export type ExportProgressPatch = { progress?: number; currentScene?: number; totalScenes?: number }
type ExportRunner = (
  settings: { resolution?: string; fps?: number },
  // The project to render. The MCP/agent path selects a project independently
  // of which one the editor window has open, so the runner must load this
  // project before exporting — otherwise it would render whatever happens to be
  // open in the editor.
  projectId: string,
  onProgress?: (p: ExportProgressPatch) => void,
) => Promise<{ outputPath: string }>
let _exportRunner: ExportRunner | null = null

export function setExportRunner(fn: ExportRunner): void {
  _exportRunner = fn
}

// Optional callback registered by src/electron/main.ts that captures ONE rendered
// frame of a scene at time `t` via the offscreen tier-3 engine (export-tier3.ts)
// and resolves with a base64 PNG. This is how the headless MCP path fulfils
// capture_frame with REAL pixels. Defined as a local type — like
// ExportRunner — so this pure module never imports electron (the hosted web
// build calls executeMcpTool too). Null when no desktop renderer is attached;
// capture_frame then falls back to the honest "unavailable" response.
export interface CaptureFrameSpec {
  id: string
  /** Fully assembled scene HTML (generateSceneHTML output). */
  html: string
  durationSeconds: number
  sceneType?: string
  bgColor?: string
}
export interface CaptureFrameResult {
  pngBase64: string
  mimeType: string
  width: number
  height: number
}
type CaptureRunner = (
  spec: CaptureFrameSpec,
  timeSeconds: number,
  opts: { width: number; height: number; maxWidth?: number },
) => Promise<CaptureFrameResult>
let _captureRunner: CaptureRunner | null = null

export function setCaptureRunner(fn: CaptureRunner): void {
  _captureRunner = fn
}

// Multi-frame variant: captures N frames of ONE scene at the
// given times with a single offscreen window load — the efficient source for
// review_scene_motion's timeline-frame review. Frames are returned in `times`
// order. Null when no desktop renderer is attached.
type MultiCaptureRunner = (
  spec: CaptureFrameSpec,
  times: number[],
  opts: { width: number; height: number; maxWidth?: number },
) => Promise<CaptureFrameResult[]>
let _multiCaptureRunner: MultiCaptureRunner | null = null

export function setMultiCaptureRunner(fn: MultiCaptureRunner): void {
  _multiCaptureRunner = fn
}

// Live editor-state reader. Registered by src/electron/main.ts to
// read the renderer's Zustand store (window.__dreambyteStore) — the user's
// current selection / playhead / zoom — so read_editor_state over MCP reflects
// what the user is LOOKING AT right now, not the empty start-of-run snapshot the
// in-app path captures. Returns null when no renderer is attached (headless /
// web build) so the tool can answer honestly. `projectId` is the project the
// EDITOR has open, which may differ from the one the MCP session is editing.
export interface McpEditorState {
  projectId: string | null
  selectedSceneId: string | null
  selectedClipIds: string[]
  currentTime: number
  isPlaying: boolean
  totalDuration: number
  timelineZoom: number
  capturedAt: string
}
type EditorStateReader = () => Promise<McpEditorState | null>
let _editorStateReader: EditorStateReader | null = null

export function setEditorStateReader(fn: EditorStateReader | null): void {
  _editorStateReader = fn
}

// ── Human consent for spend-raising MCP tools ────────────────────────────────
//
// The MCP socket hands a full tool surface to whoever connects. `set_max_run_cost`
// and `approve_pending_generation` are ordinary model-callable tools that between
// them raise the spend ceiling and self-grant the paid-generation consent — i.e.
// anything that can call them can spend the user's API credits without limit. A
// prompt instruction is not a gate. These two therefore round-trip to a real
// human, the same injected-dependency shape as the editor-state reader above
// (src/lib/ must never import electron).
//
// DENY BY DEFAULT when nothing is wired: no confirmer means no human is reachable
// (headless / web / CLI), and "no one can be asked" must read as "no consent",
// not as "granted". Revoking and LOWERING the cap need no confirmation — they
// only ever reduce spend.
export interface McpConfirmRequest {
  title: string
  body: string
  confirmLabel: string
}
type HumanConfirmer = (req: McpConfirmRequest) => Promise<boolean>
let _humanConfirmer: HumanConfirmer | null = null

export function setMcpHumanConfirmer(fn: HumanConfirmer | null): void {
  _humanConfirmer = fn
}

/** True only if a human affirmatively approved. Never throws. */
async function confirmWithHuman(req: McpConfirmRequest): Promise<{ ok: boolean; reason?: string }> {
  if (!_humanConfirmer) {
    return { ok: false, reason: 'no_human' }
  }
  try {
    return { ok: await _humanConfirmer(req) }
  } catch {
    return { ok: false, reason: 'confirm_failed' }
  }
}

// Per-project mutex: serializes concurrent MCP tool calls against the same
// project so they read-modify-write sequentially rather than racing on DB state.
// Without this, two parallel calls (e.g., an agent generating 8 scenes) both
// read the same 0-scene state and the second write clobbers the first.
const _projectLocks = new Map<string, Promise<void>>()

// Run-scoped cost ceiling: one in-memory RunCostLedger per
// the whole desktop app run, shared BY REFERENCE into each call's
// world.mcpCostLedger so paid-generation spend accumulates across calls.
//
// SECURITY: this is ONE ledger for the entire run, NOT keyed by project. A
// per-project ledger (the original implementation) let an adversarial agent
// reset the cap by calling create_project in a loop — each fresh project minted
// a fresh $25 cap, so total spend was unbounded ($25 × N projects) and the
// ceiling was merely advisory. A single ledger is the real backstop: total
// paid-gen spend across the session is bounded no matter how many projects the
// agent touches. Resets when the desktop app restarts (= a new run), per the
// Tension C decision ("in-memory daemon SESSION ledger", no DB row).
const MCP_DEFAULT_MAX_RUN_COST_USD = 25
const _mcpCostLedger: RunCostLedger = makeRunCostLedger(MCP_DEFAULT_MAX_RUN_COST_USD)

export function getMcpCostLedger(): RunCostLedger {
  return _mcpCostLedger
}

/** Adjust the cost cap for the MCP session (set_max_run_cost tool). Returns the
 *  ledger so the caller can report current spend + the new cap. */
export function setMcpMaxRunCost(capUsd: number): RunCostLedger {
  _mcpCostLedger.capUsd = Math.max(0, capUsd)
  return _mcpCostLedger
}

// Inline generation approvals: per-project in-memory set of paid
// providers the client has approved this session. Read into world.sessionPermissions
// (api -> 'allow') so checkApiPermission's always_ask + session-allow path proceeds,
// turning the dead-end "go change a setting in the app" into a chat-consent flow.
// In-memory ONLY (resets on app restart) — a grant in one session never authorizes
// paid spend in a later one (no persisted grants). The run cost ceiling
// still bounds total spend on top of any approval.
const _mcpApprovedApis = new Map<string, Set<string>>()

function getMcpApprovedApis(projectId: string): Set<string> {
  let set = _mcpApprovedApis.get(projectId)
  if (!set) {
    set = new Set()
    _mcpApprovedApis.set(projectId, set)
  }
  return set
}

/** Grant or revoke a project session's approval for a paid provider
 *  (approve_pending_generation tool). Returns the current approved provider list. */
export function setMcpGenerationApproval(projectId: string, api: string, approved: boolean): string[] {
  const set = getMcpApprovedApis(projectId)
  if (approved) set.add(api)
  else set.delete(api)
  return [...set]
}

function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _projectLocks.get(projectId) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  _projectLocks.set(projectId, next)
  return prev.then(fn).finally(() => {
    resolve()
    // Only delete the lock entry if no other call queued behind this one.
    if (_projectLocks.get(projectId) === next) _projectLocks.delete(projectId)
  })
}

/**
 * Clamp a requested capture timestamp to the frame the runner will actually
 * produce, so the caption can never claim a time the frame isn't at.
 *
 * The runner seeks within [0, durationSeconds]. When the duration is 0 or
 * invalid it produces frame 0, so the caption MUST read 0 — the old code let an
 * out-of-range request (e.g. t=999 on a 0-duration scene) flow straight into
 * the caption, a false timestamp the model then reasoned from. When no time is
 * requested we default to ~1s (a representative frame), bounded by duration.
 */
export function clampCaptureTime(rawTime: unknown, duration: unknown): number {
  const dur = typeof duration === 'number' && duration > 0 ? duration : 0
  if (typeof rawTime === 'number' && Number.isFinite(rawTime)) {
    return dur > 0 ? Math.max(0, Math.min(rawTime, dur)) : 0
  }
  return dur > 0 ? Math.min(1, dur) : 0
}

/**
 * Optimistic-concurrency project write for the MCP/Claude-Code path (v4 #9).
 *
 * The external MCP path runs in the Electron main process against the same DB an
 * in-app autosave writes. The old code wrote the scene TABLES unguarded and then a
 * versionless `projects` update, so an autosave that committed in the same window
 * was silently clobbered (and left `version` stale for the next save). This mirrors
 * the in-app autosave's contract (`persistScenesFromAgentRun`): inside ONE
 * transaction, read `version` + `description`, version-check the `projects` update,
 * write the scene tables in the SAME tx, bump `version`, and retry on a conflict —
 * re-reading the FRESH `description` each attempt so a `timeline` merge lands on the
 * latest blob, not stale state. Returns false if the lock can't be won in
 * `maxAttempts` (caller logs), or if the project no longer exists.
 */
export async function persistMcpSceneWrite(opts: {
  projectId: string
  scenes: unknown
  sceneGraph: unknown
  branchId: string | null
  /** When non-null, merged into the description blob (the only place the renderer reads it). */
  timeline: unknown | null
  /** When defined, written to the projects.watermark column INSIDE the
   *  version-checked update — the MCP exit for add_watermark. */
  watermark?: unknown
  /** When defined, written to the projects.globalStyle column INSIDE the
   *  version-checked update. Replaces the old bare versionless
   *  `db.update(projects).set({ globalStyle })` that sat NEXT to the guarded
   *  write and could clobber / be clobbered by a racing autosave. */
  globalStyle?: unknown
  fallbackDescription?: string | null
  maxAttempts?: number
}): Promise<boolean> {
  const { projectId, scenes, sceneGraph, branchId, timeline, watermark, globalStyle } = opts
  const maxAttempts = opts.maxAttempts ?? 4
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ version: schema.projects.version, description: schema.projects.description })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .limit(1)
      if (!row) return { found: false, updated: false }
      const currentVersion = row.version ?? 1
      // Advance updatedAt 1s past now: the DB stores second-precision Unix integers
      // but the renderer caches a millisecond ISO string, so without the buffer
      // saveProjectToDb sees dbTime <= ourTime and overwrites with stale state.
      const updateSet: Record<string, unknown> = {
        updatedAt: new Date(Date.now() + 1000),
        version: currentVersion + 1,
      }
      // Merge ONLY `.timeline` into the FRESH (this-tx) description so a racing
      // writer's scenes/graph aren't clobbered.
      if (timeline != null) {
        updateSet.description = writeProjectSceneBlob(row.description ?? opts.fallbackDescription ?? null, { timeline })
      }
      // Watermark and globalStyle ride the SAME version-checked update
      // — never separate versionless writes that a racing
      // autosave could clobber. Style + scenes land in ONE transaction.
      if (watermark !== undefined) {
        updateSet.watermark = watermark
      }
      if (globalStyle !== undefined) {
        updateSet.globalStyle = globalStyle
      }
      const [updated] = await tx
        .update(schema.projects)
        .set(updateSet as any)
        .where(and(eq(schema.projects.id, projectId), eq(schema.projects.version, currentVersion)))
        .returning({ id: schema.projects.id })
      if (!updated) return { found: true, updated: false } // version conflict — retry
      // Scene-table write INSIDE the tx so it's atomic with the version bump (the
      // unguarded write was the actual autosave clobber). branchId skips the
      // project-wide node/edge cleanup (closes the old null-branch wipe bug).
      await writeProjectScenesToTablesTx(tx, projectId, scenes as any, sceneGraph as any, branchId)
      return { found: true, updated: true }
    })
    if (!res.found) return false // no such project — retrying won't help
    if (res.updated) return true
  }
  return false
}

/**
 * The MCP tool response when a scene mutation could not be persisted
 * (optimistic lock exhausted, project row gone, or the persist threw).
 * Exported so tests pin the exact contract the external agent sees.
 */
export const MCP_PERSIST_FAILED_MESSAGE =
  'Your edit did not persist — the project changed concurrently or no longer exists. Re-read the scene and retry.'

/**
 * Run the persist step and gate ALL side effects on its outcome.
 *
 * The old code had two lying exits: (1) when `persistMcpSceneWrite` returned
 * false it only `log.warn`ed — the scene HTML was still written to disk, the
 * renderer was still notified, and the client was told success; (2) the
 * surrounding `catch` swallowed a THROWN persist error with the HTML write
 * sitting after it — the identical lie. Now: persist returns false OR throws
 * → no HTML write, no renderer notify, and the caller returns an explicit
 * error response (MCP_PERSIST_FAILED_MESSAGE) instead of `result.success`
 * (which was computed BEFORE persistence and knows nothing about it).
 *
 * Extracted with injectable steps so both failure paths are unit-testable
 * (mcp-persist-write.test.ts) without standing up the full executeMcpTool
 * project-load/lock pipeline.
 */
export async function persistThenSideEffects(opts: {
  persist: () => Promise<boolean>
  /** Renderer notify — only fired when the persist actually landed. */
  notifyRenderer: (() => void) | null
  /** Scene HTML write (+ verify stamp) — only run when the persist landed. */
  writeSceneHtml: (() => Promise<void>) | null
  onPersistError?: (e: unknown) => void
}): Promise<boolean> {
  let persisted = false
  try {
    persisted = await opts.persist()
  } catch (e) {
    opts.onPersistError?.(e)
    persisted = false
  }
  if (!persisted) return false
  if (opts.notifyRenderer) opts.notifyRenderer()
  if (opts.writeSceneHtml) await opts.writeSceneHtml()
  return true
}

export interface McpToolRequest {
  projectId: string
  toolName: string
  args?: Record<string, unknown>
  /**
   * Sandbox run mode for the MCP/Claude-Code path. When true, paid asset
   * generation is replaced by free-local / placeholder assets (same resolveAsset
   * gateway + fail-closed gate as the in-app agent). Set by the `set_run_mode`
   * MCP tool and carried on every subsequent tool call. Default false (Auto).
   */
  sandboxMode?: boolean
}

export interface McpToolResponse {
  success: boolean
  content: string
  data?: unknown
  affectedSceneId?: string | null
  permissionNeeded?: ToolResult['permissionNeeded']
  error?: string
}

// Status-type MCP tools that ONLY read the in-memory export-job registry — no
// scene state, no DB row. They get a fast path that bypasses the project load
// AND the per-project lock (decision 8A): the canonical handler loads the
// project, resolves the branch, and serializes behind withProjectLock so a
// concurrent multi-scene generate doesn't race DB state. A `get_export_status`
// poll needs none of that, and forcing it behind the lock would make a render
// in progress block its own progress polls. This is the one documented
// exception to "everything goes through the canonical project-locked handler."
const STATUS_FASTPATH_TOOLS = new Set(['get_status'])

export async function executeMcpTool(req: McpToolRequest): Promise<McpToolResponse> {
  const { projectId, toolName } = req

  if (!projectId || !toolName) {
    return { success: false, content: 'projectId and toolName are required', error: 'bad_request' }
  }

  // Fast path: status reads hit the global job map directly (no project load,
  // no lock). See STATUS_FASTPATH_TOOLS above for the rationale.
  if (STATUS_FASTPATH_TOOLS.has(toolName) && (req.args as { kind?: unknown } | undefined)?.kind === 'export') {
    return executeStatusFastPath(req)
  }

  // set_max_run_cost: session-config tool that adjusts the in-memory cost
  // cap for the whole MCP session. No scene state, no DB, no lock needed —
  // handled here rather than executeTool (which only knows canonical scene tools).
  if (toolName === 'set_max_run_cost') {
    const capUsd = (req.args as { capUsd?: unknown } | undefined)?.capUsd
    if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd < 0) {
      return {
        success: false,
        content: 'set_max_run_cost requires capUsd: a finite number >= 0 (USD).',
        error: 'bad_request',
      }
    }
    // Raising the ceiling is the money path — gate it on a real human. Lowering
    // it (or holding it) can only reduce spend, so it goes straight through.
    const currentCap = getMcpCostLedger().capUsd
    if (capUsd > currentCap) {
      const { ok, reason } = await confirmWithHuman({
        title: 'Raise the AI spend limit?',
        body:
          `An external tool connected over MCP is asking to raise this session's paid-generation ` +
          `ceiling from $${currentCap.toFixed(2)} to $${capUsd.toFixed(2)}. ` +
          `Approve only if you asked for this.`,
        confirmLabel: 'Raise limit',
      })
      if (!ok) {
        return {
          success: false,
          content:
            reason === 'no_human'
              ? `Refused: raising the spend ceiling to $${capUsd.toFixed(2)} needs a person to confirm it in the ` +
                `Dreambyte window, and no window is reachable. The ceiling stays at $${currentCap.toFixed(2)}.`
              : `Refused: the user did not approve raising the spend ceiling. It stays at $${currentCap.toFixed(2)}.`,
          error: 'user_declined',
        }
      }
    }
    const ledger = setMcpMaxRunCost(capUsd)
    return {
      success: true,
      content:
        `Paid-generation spend ceiling set to $${ledger.capUsd.toFixed(2)} for this session ` +
        `(current spend $${ledger.spentUsd.toFixed(2)}).` +
        (capUsd === 0 ? ' All paid generation is now blocked until you raise the cap.' : ''),
      data: { capUsd: ledger.capUsd, spentUsd: ledger.spentUsd },
    }
  }

  // approve_pending_generation: grant/revoke a session approval for a paid
  // provider so a subsequent gen call proceeds. In-memory, no DB, no lock.
  if (toolName === 'approve_pending_generation') {
    const a = req.args as { api?: unknown; revoke?: unknown } | undefined
    const api = typeof a?.api === 'string' ? a.api.trim() : ''
    if (!api) {
      return {
        success: false,
        content:
          'approve_pending_generation requires `api`: the provider name from the permission-needed ' +
          'response (e.g. "imageGen", "veo3", "elevenLabs", "heygen"). Pass `revoke: true` to withdraw it.',
        error: 'bad_request',
      }
    }
    const revoke = a?.revoke === true
    // Granting is the money path — a tool must not be able to self-grant the
    // consent that unlocks paid generation. Revoking always goes through.
    if (!revoke) {
      const { ok, reason } = await confirmWithHuman({
        title: `Allow paid ${api} generation?`,
        body:
          `An external tool connected over MCP is asking to approve paid "${api}" generation for this ` +
          `session, billed to your API keys. Approve only if you asked for this.`,
        confirmLabel: `Allow ${api}`,
      })
      if (!ok) {
        return {
          success: false,
          content:
            reason === 'no_human'
              ? `Refused: approving paid ${api} generation needs a person to confirm it in the Dreambyte ` +
                `window, and no window is reachable. ${api} remains unapproved.`
              : `Refused: the user did not approve paid ${api} generation. It remains unapproved.`,
          error: 'user_declined',
        }
      }
    }
    const approved = setMcpGenerationApproval(projectId, api, !revoke)
    const list = approved.length ? approved.join(', ') : '(none)'
    return {
      success: true,
      content: revoke
        ? `Revoked approval for ${api}. Approved providers this session: ${list}.`
        : `Approved ${api} for this project session — paid ${api} generation can now run, still ` +
          `bounded by the cost ceiling (large single calls may re-prompt). Approved providers: ${list}. ` +
          `This resets when the desktop app restarts.`,
      data: { approved },
    }
  }

  // read_editor_state: LIVE read of the renderer's current selection /
  // playhead / zoom — what the user is looking at right now — instead of the
  // empty start-of-run snapshot. No project load / lock (it reads renderer UI
  // state, not scene data). Honest when no renderer is attached or the editor is
  // showing a different project than this MCP session is editing.
  if (toolName === 'read_editor_state') {
    if (!_editorStateReader) {
      return {
        success: true,
        content:
          'No live editor state — no desktop renderer is attached (headless or web build). ' +
          'Use list_scenes / read_scene for context.',
        data: { active: false },
      }
    }
    let state: McpEditorState | null = null
    try {
      state = await _editorStateReader()
    } catch {
      state = null
    }
    if (!state) {
      return {
        success: true,
        content:
          'No live editor state — the editor window is unavailable or has no project open. ' +
          'Use list_scenes / read_scene for context.',
        data: { active: false },
      }
    }
    const mismatch = !!state.projectId && state.projectId !== projectId
    if (mismatch) {
      // Cross-project guard: the renderer is focused on a DIFFERENT project than
      // this MCP session is editing. Do NOT disclose the other project's selection,
      // scene IDs, clips, or playhead — that would leak one project's state to a
      // session scoped to another, and an agent could act on a foreign scene ID
      // thinking it belonged to its own project. Return only the mismatch signal.
      return {
        success: true,
        content:
          `The editor is currently showing a DIFFERENT project (${state.projectId}) than the one ` +
          `this session is editing (${projectId}), so there is no live selection to report for your ` +
          `project. Use list_scenes / read_scene for context.`,
        data: { active: true, projectMatches: false },
      }
    }
    const sel = state.selectedSceneId ? `scene ${state.selectedSceneId} selected` : 'no scene selected'
    return {
      success: true,
      content:
        `Live editor state: ${sel}, playhead ${state.currentTime.toFixed(1)}s` +
        `${state.isPlaying ? ' (playing)' : ''}, ${state.selectedClipIds.length} clip(s) selected.`,
      data: { active: true, projectMatches: true, ...state },
    }
  }

  return withProjectLock(projectId, () => _executeMcpToolUnlocked(req))
}

/**
 * Fast-path executor for status-only tools (decision 8A). Reads the in-memory
 * export-job registry directly and formats an McpToolResponse without loading
 * the project or taking the project lock.
 */
async function executeStatusFastPath(req: McpToolRequest): Promise<McpToolResponse> {
  const { toolName, args } = req

  // Only kind:'export' is a pure registry read. kind:'video' / kind:'avatar' write the
  // scene's layer back on completion, so they MUST take the project lock like any other
  // mutating tool — fall through to the normal path for those.
  if (toolName === 'get_status' && (args as { kind?: unknown } | undefined)?.kind === 'export') {
    const jobId = (args as { jobId?: unknown } | undefined)?.jobId
    if (!jobId || typeof jobId !== 'string') {
      return {
        success: false,
        content: "get_status(kind:'export') requires a jobId (returned by `export`). Poll with that exact jobId.",
        error: 'bad_request',
      }
    }
    const job = getExportJob(jobId)
    if (!job) {
      // Honest "no active export" — also the correct answer after a main-
      // process restart wipes the in-memory registry (item: edge case).
      return {
        success: true,
        content: `No export job found for ${jobId}`,
        data: { status: 'none', jobId },
      }
    }
    // Mirror the overall/monotonic progress math the in-app handler computes
    // (planning-export-tools.ts), so both poll surfaces agree.
    const totalScenes = job.totalScenes && job.totalScenes > 0 ? job.totalScenes : 1
    const currentScene = Math.min(totalScenes, job.currentScene && job.currentScene > 0 ? job.currentScene : 1)
    const sceneProgress = Math.max(0, Math.min(100, job.progress ?? 0))
    const overallProgress =
      job.status === 'complete'
        ? 100
        : Math.min(99, Math.max(0, Math.round(((currentScene - 1 + sceneProgress / 100) / totalScenes) * 100)))
    // 11b: lead with the failing scene when the error was scene-scoped so the
    // agent can re-generate exactly that scene instead of parsing the string.
    const errorSceneTag =
      job.status === 'error' && job.errorSceneIndex != null
        ? ` (failed at scene ${job.errorSceneIndex}/${job.totalScenes ?? '?'}${job.errorSceneId ? `, sceneId ${job.errorSceneId}` : ''})`
        : ''
    const content =
      job.status === 'complete'
        ? `Export complete: ${job.outputPath}`
        : job.status === 'error'
          ? `Export failed${errorSceneTag}: ${job.error}`
          : `Export rendering: scene ${currentScene}/${job.totalScenes ?? '?'}, ${overallProgress}% overall`
    return {
      success: true,
      content,
      data: { ...job, currentScene, progress: overallProgress, sceneProgress },
    }
  }

  // Defensive: STATUS_FASTPATH_TOOLS gates entry, so this is unreachable unless
  // a tool name is added to the set without a handler here.
  return { success: false, content: `No fast-path handler for ${toolName}`, error: 'bad_request' }
}

async function _executeMcpToolUnlocked(req: McpToolRequest): Promise<McpToolResponse> {
  const { projectId, toolName, args } = req

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)

  if (!project) {
    return { success: false, content: 'Project not found', error: 'project_not_found' }
  }

  // Headless/external (Claude Code) tools have no branch selector, so the MCP
  // path operates on the project's DEFAULT branch. Resolving it up front lets the
  // read AND the write be branch-scoped. The old code read every branch's scenes
  // mixed together and wrote them back with a null branchId — which deletes ALL
  // project scenes (writeProjectScenesToTablesTx) and collapses every branch into
  // null on a multi-branch project. Fail closed (return, not throw) if the branch
  // can't be resolved — executeMcpTool's contract is to return a McpToolResponse,
  // and running the tool branch-blind is exactly the corruption we're avoiding.
  // Backfill first (matches the in-app load at src/electron/ipc/projects.ts): stamps
  // any legacy/null-branch scene rows onto the default branch so a scoped read
  // sees them — otherwise readProjectScenesFromTables(projectId, branchId) returns
  // {scenes:[]} (rows exist, none on this branch), suppressing the blob fallback
  // and hiding existing scenes from the headless tool.
  let branchId: string
  try {
    await backfillProjectBranch(projectId)
    branchId = (await getOrCreateDefaultBranch(projectId)).id
  } catch (e) {
    log.error('mcp: could not resolve default branch', { error: e })
    return { success: false, content: 'Could not resolve the project branch', error: 'branch_resolution_failed' }
  }
  const tableBacked = await readProjectScenesFromTables(projectId, branchId)
  const blob = readProjectSceneBlob((project as any).description)
  const scenes: Scene[] = tableBacked?.scenes ?? blob.scenes ?? []

  const globalStyle: GlobalStyle = (project as any).globalStyle ?? {
    presetId: null,
    fontOverride: null,
    bodyFontOverride: null,
    bgColorOverride: null,
    paletteOverride: null,
    strokeColorOverride: null,
  }

  // Agent-grantable Research mode (set_research_mode): the MCP world is
  // rebuilt per call, so the session grant lives in a main-process registry.
  // Without a grant the gates stay CLOSED (the MCP path has no in-app toggle
  // to read — Research remains opt-in per session).
  const researchGrant = getResearchSessionGrant(projectId)

  const world: WorldStateMutable = {
    scenes: JSON.parse(JSON.stringify(scenes)),
    globalStyle: JSON.parse(JSON.stringify(globalStyle)),
    projectName: (project as any).name ?? 'Untitled',
    projectId,
    outputMode: (project as any).outputMode ?? 'interactive',
    // From the BLOB, not a `sceneGraph` column — that column does not exist
    // (src/lib/db/schema.ts has only sceneGraphStartSceneId), so this read was always
    // the empty literal. It then flowed into the unconditional
    // `.set({ sceneGraphStartSceneId: sceneGraph?.startSceneId || null })` in
    // src/lib/db/project-scene-table.ts, so every MCP scene write silently nulled an
    // interactive project's start scene whenever it wasn't the first scene.
    sceneGraph: blob.sceneGraph ?? { nodes: [], edges: [] },
    apiPermissions: (project as any).apiPermissions ?? createDefaultAPIPermissions(),
    audioProviderEnabled: (project as any).audioProviderEnabled ?? {},
    mediaGenEnabled: (project as any).mediaGenEnabled ?? {},
    // Inline approvals: providers approved this session via
    // approve_pending_generation become session-allow grants the permission gate honors.
    sessionPermissions: Object.fromEntries([...getMcpApprovedApis(projectId)].map((a) => [a, 'allow'])),
    zdogLibrary: (project as any).zdogLibrary ?? [],
    // Load the timeline from the description blob (where it actually lives and
    // where the renderer reads it). The old `(project as any).timeline` read a
    // column that does not exist, so the MCP world always started with a null
    // timeline — every clip-targeting tool then failed "clip not found" and the
    // edits the agent thought it made were dropped on return.
    timeline: blob.timeline ?? null,
    mp4Settings: (project as any).mp4Settings ?? undefined,
    // MCP requests are runless; tag every emitted action under a stable "mcp"
    // run so external edits group together (and undo as a unit) instead of
    // logging with runId: null.
    currentRunId: 'mcp',
    // External-agent session: set_research_mode treats the MCP client's own
    // tool-permission prompt as the user grant (no in-app card on this path).
    mcpSession: true,
    // Run-scoped cost ceiling: per-project in-memory ledger so checkApiPermission
    // can block paid generation past the cap. Shared by reference across calls for
    // the same project (the spend accumulates); resets when the desktop app restarts.
    mcpCostLedger: getMcpCostLedger(),
    ...researchGrantWorldFields(researchGrant),
    // Sandbox: paid asset gen → placeholders; fail-closed gate blocks any paid
    // call that bypasses resolveAsset. Carried from the MCP request (set_run_mode).
    ...(req.sandboxMode ? { sandboxMode: true } : {}),
  }

  // Snapshot the cost ledger so a DENIED tool refunds whatever the cost-ceiling
  // gate reserved for it. The ceiling reserves the estimate when the gate passes,
  // then a later posture/rule gate can still DENY the call (permissionNeeded) —
  // a denial means checkApiPermission returned before any provider call, so no
  // spend occurred and the reservation must be released.
  //
  // SECURITY: we refund ONLY on a permission denial, NOT on
  // every failure. A generic !result.success refund would refund spend that DID
  // happen — e.g. generate_image bills the provider, then a later step throws and
  // the tool returns success:false; refunding there lets an agent get free,
  // off-ledger generations by reliably triggering a post-generation failure. For
  // a spend ceiling the safe bias is to KEEP the reservation on any non-denial
  // failure (over-count, fail-safe) rather than risk refunding billed spend. The
  // residual over-count on a pre-spend validation error is acceptable — raise the
  // cap with set_max_run_cost if a buggy retry loop erodes it.
  const ledgerForRefund = world.mcpCostLedger
  const spentBeforeTool = ledgerForRefund?.spentUsd ?? 0

  const result = await executeTool(toolName, args ?? {}, world)

  if (ledgerForRefund && result.permissionNeeded && ledgerForRefund.spentUsd > spentBeforeTool) {
    refundCost(ledgerForRefund, ledgerForRefund.spentUsd - spentBeforeTool)
  }

  // ask_user (clarificationNeeded) can only pause+resume on the in-app runner via
  // the clarification card. The stateless MCP / Claude-Code path has no card and
  // no resume — so HONEST-FAIL instead of letting the success+question-JSON ride
  // back as if answered (a silent false-success). Mirrors the review-
  // tool honest-fail. The model is told to state its assumption and proceed.
  if (result.clarificationNeeded) {
    return {
      success: false,
      content:
        `ask_user (clarifying questions) is unavailable on this path — there is no interactive card here to answer it. ` +
        `Do NOT wait for an answer. State your assumption explicitly ("Assuming ${result.clarificationNeeded.question.slice(0, 80)}…"), proceed, ` +
        `and let the user correct you in their next message.`,
      error: 'clarification_unavailable',
    }
  }

  // Visual-feedback TOOLS (capture_frame / review_video / review_scene_motion)
  // return a text-stub description plus a clientAction the RENDERER must fulfil.
  // The in-app runner fulfils them; the stateless MCP path fulfils what it can
  // here via the offscreen tier-3 engine and fails honestly for the rest.
  //
  // CRITICAL: key this on the TOOL NAME, not just the clientAction value. The
  // same `clientAction: 'capture_frame'` is ALSO piggybacked onto OTHER tools'
  // results — verify_scene (to attach a visual to its report) and the code-write
  // auto-capture hook (write_scene_code / patch_layer_code / add_layer / …). If we
  // keyed on the value alone we'd hijack those: return only a frame and, because
  // this runs before the persistence block, DROP their mutations. Those piggyback
  // captures are handled after persistence (secondary-capture block below).
  //
  // Safe to handle these read-only tools before persistence (they never mutate
  // world.scenes — they build a description / cut-review input).
  if (result.success && isPrimaryVisualFeedbackTool(toolName) && isVisualFeedbackClientAction(result.data)) {
    const action = result.data.clientAction

    // HONEST-FAIL review tools that cannot be fulfilled on this path (no
    // offscreen render runner). Otherwise the handler's `reviewBrief.reviewable
    // = false` fallback rides back as a SUCCESS the model misreads as "the cut
    // was reviewed" — a silent-false-success over MCP (#honest-review-mcp).
    if (reviewToolUnfulfillable(action, { capture: !!_captureRunner, multiCapture: !!_multiCaptureRunner })) {
      return {
        success: false,
        content:
          'Visual review is unavailable on this path — no offscreen render runner is registered. Open the Dreambyte desktop app (the in-app agent reviews the cut/motion), or skip the review step and ship without it.',
        error: 'review_runner_unavailable',
      }
    }

    // capture_frame: fulfil with a REAL headless frame when the offscreen
    // capture runner is registered (desktop). Build the scene HTML here and hand
    // a self-contained spec to the runner so this module never imports electron.
    if (action === 'capture_frame' && _captureRunner) {
      const sceneId = (args as { sceneId?: unknown } | undefined)?.sceneId
      const rawTime = (args as { time?: unknown } | undefined)?.time
      const scene = typeof sceneId === 'string' ? world.scenes.find((s) => s.id === sceneId) : undefined
      if (!scene) {
        return { success: false, content: `Scene ${String(sceneId ?? '')} not found`, error: 'scene_not_found' }
      }
      // Clamp to [0, duration] BEFORE building the caption. The runner clamps the
      // seek internally, so an out-of-range time would capture the end frame while
      // the caption claimed "t=999s" — a false timestamp the model reasons from.
      const t = clampCaptureTime(rawTime, scene.duration)
      try {
        resolveStyle(world.globalStyle.presetId, world.globalStyle)
        const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
        const html = generateSceneHTML(scene, world.globalStyle, undefined, undefined, dims)
        const frame = await _captureRunner(
          {
            id: scene.id,
            html,
            durationSeconds: scene.duration,
            sceneType: (scene as { sceneType?: string }).sceneType,
            bgColor: scene.bgColor,
          },
          t,
          { width: dims.width, height: dims.height },
        )
        return {
          success: true,
          content: `Captured frame of scene "${scene.name}" at t=${t}s (${frame.width}×${frame.height}).`,
          data: {
            image: {
              dataUri: `data:${frame.mimeType};base64,${frame.pngBase64}`,
              mimeType: frame.mimeType,
              width: frame.width,
              height: frame.height,
            },
            sceneId: scene.id,
            time: t,
          },
        }
      } catch (e) {
        return {
          success: false,
          content: `capture_frame failed to render scene "${scene.name}": ${e instanceof Error ? e.message : String(e)}`,
          error: 'capture_failed',
        }
      }
    }

    // review_video: whole-cut review. The handler returned the even-sampled
    // sceneIds (one representative frame per scene, capped at MAX_REVIEW_FRAMES).
    // Capture one mid-scene frame each via the offscreen runner and return them
    // as an image set — the MCP server emits one image content block per frame so
    // the model sees the whole cut in order. Captures run concurrently; the
    // runner's own MAX_CAPTURE_WINDOWS semaphore bounds the actual parallelism.
    if (action === 'review_video' && _captureRunner) {
      // result.data is narrowed to VisualFeedbackClientAction (just clientAction);
      // the handler also stamped sceneIds/timing on it — read via unknown.
      const reviewData = result.data as unknown as { sceneIds?: unknown }
      const sceneIds = Array.isArray(reviewData.sceneIds)
        ? (reviewData.sceneIds.filter((x) => typeof x === 'string') as string[])
        : []
      if (sceneIds.length === 0) {
        return { success: false, content: 'No scenes to review yet — build the cut first.', error: 'no_scenes' }
      }
      const captureRunner = _captureRunner
      resolveStyle(world.globalStyle.presetId, world.globalStyle)
      const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
      const captured = await Promise.all(
        sceneIds.map(async (sid, i) => {
          const scene = world.scenes.find((s) => s.id === sid)
          if (!scene) return { index: i + 1, name: `Scene ${i + 1}`, error: 'scene not found' }
          const dur = typeof scene.duration === 'number' && scene.duration > 0 ? scene.duration : 2
          try {
            const html = generateSceneHTML(scene, world.globalStyle, undefined, undefined, dims)
            const frame = await captureRunner(
              {
                id: scene.id,
                html,
                durationSeconds: dur,
                sceneType: (scene as { sceneType?: string }).sceneType,
                bgColor: scene.bgColor,
              },
              dur / 2,
              // Up to MAX_REVIEW_FRAMES (12) images in ONE result, so keep each
              // small to bound aggregate response bytes + vision tokens (12×768px
              // could blow past downstream per-request image limits).
              { width: dims.width, height: dims.height, maxWidth: 600 },
            )
            return { index: i + 1, name: scene.name ?? `Scene ${i + 1}`, frame }
          } catch (e) {
            return {
              index: i + 1,
              name: scene.name ?? `Scene ${i + 1}`,
              error: e instanceof Error ? e.message : String(e),
            }
          }
        }),
      )
      const ok = captured.filter((c): c is { index: number; name: string; frame: CaptureFrameResult } => 'frame' in c)
      if (ok.length === 0) {
        return { success: false, content: 'Could not render any scene for review.', error: 'review_failed' }
      }
      const failed = captured.filter((c): c is { index: number; name: string; error: string } => 'error' in c)
      const order = ok.map((c) => `[${c.index}] ${c.name}`).join(', ')
      const failNote = failed.length ? ` ${failed.length} scene(s) failed to render and were skipped.` : ''
      return {
        success: true,
        content:
          `Cut review: ${ok.length} representative frame(s), one mid-scene per scene, in order: ${order}.${failNote} ` +
          `Each image below is that scene's frame.`,
        data: {
          images: ok.map((c) => ({
            dataUri: `data:${c.frame.mimeType};base64,${c.frame.pngBase64}`,
            mimeType: c.frame.mimeType,
            width: c.frame.width,
            height: c.frame.height,
            label: `[${c.index}] ${c.name}`,
          })),
        },
      }
    }

    // review_scene_motion: single-scene MOTION review. MCP has no video
    // content type and the MCP consumer (Claude) can't ingest video anyway — the
    // in-app path uses Gemini's native video for this; that's impossible here. So
    // sample the scene at N timepoints across its duration (one window load, N
    // seeks) and return them as an ordered frame sequence the model CAN read,
    // plus the handler's audio-timing text so it can reason about sync.
    if (action === 'review_scene_motion' && _multiCaptureRunner) {
      const rd = result.data as unknown as {
        sceneId?: unknown
        scene?: { name?: string; durationSec?: number; narration?: string }
        audioTimingText?: unknown
      }
      const rawSceneId =
        typeof rd.sceneId === 'string' ? rd.sceneId : (args as { sceneId?: unknown } | undefined)?.sceneId
      const scene = typeof rawSceneId === 'string' ? world.scenes.find((s) => s.id === rawSceneId) : undefined
      if (!scene) {
        return { success: false, content: `Scene ${String(rawSceneId ?? '')} not found`, error: 'scene_not_found' }
      }
      const dur = typeof scene.duration === 'number' && scene.duration > 0 ? scene.duration : 2
      try {
        resolveStyle(world.globalStyle.presetId, world.globalStyle)
        const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
        const html = generateSceneHTML(scene, world.globalStyle, undefined, undefined, dims)
        // Midpoint sampling across the duration (avoids exact 0 / end, which can
        // be blank): t = dur * (i + 0.5) / N.
        const N = 6
        const times = Array.from({ length: N }, (_, i) => Number(((dur * (i + 0.5)) / N).toFixed(3)))
        const frames = await _multiCaptureRunner(
          {
            id: scene.id,
            html,
            durationSeconds: dur,
            sceneType: (scene as { sceneType?: string }).sceneType,
            bgColor: scene.bgColor,
          },
          times,
          { width: dims.width, height: dims.height, maxWidth: 768 },
        )
        if (frames.length === 0) {
          return { success: false, content: 'Could not render the scene for motion review.', error: 'review_failed' }
        }
        const narration = rd.scene?.narration ? `\nNarration: "${rd.scene.narration}"` : ''
        const audioText =
          typeof rd.audioTimingText === 'string' && rd.audioTimingText.trim()
            ? `\n\nAudio timeline (for sync):\n${rd.audioTimingText}`
            : ''
        return {
          success: true,
          content:
            `Motion review of scene "${scene.name}" (${dur}s): ${frames.length} frames sampled across the timeline ` +
            `(t=${times.join('s, ')}s). Read them in order to judge motion, pacing, and entrance/exit timing. ` +
            `Note: MCP can't carry video, so this is a frame sequence, not a clip.${narration}${audioText}`,
          data: {
            images: frames.map((f, i) => ({
              dataUri: `data:${f.mimeType};base64,${f.pngBase64}`,
              mimeType: f.mimeType,
              width: f.width,
              height: f.height,
              label: `t=${times[i]}s`,
            })),
          },
        }
      } catch (e) {
        return {
          success: false,
          content: `review_scene_motion failed to render scene "${scene.name}": ${e instanceof Error ? e.message : String(e)}`,
          error: 'review_failed',
        }
      }
    }

    // capture_frame/review_video/review_scene_motion with no runner attached:
    // not fulfillable headless. Fail loud instead of returning the text stub as
    // success — that made Claude Code "confidently blind". verify_scene already
    // works over MCP for render errors.
    return {
      success: false,
      content:
        `${action} is not available over MCP yet: visual feedback (rendered pixels/video) ` +
        `requires a renderer round-trip that the headless MCP path does not wire up. ` +
        `It is NOT a confirmation that the scene looks correct. ` +
        `Use verify_scene to check the scene actually renders without errors.`,
      error: 'visual_feedback_unavailable',
      data: result.data,
    }
  }

  // export_mp4 reads the project and renders — it mutates nothing. Persisting
  // world.scenes back + notifying the renderer would fire an async
  // refreshProjectFromServer() that can replace the Zustand scenes array mid-
  // render (the export loops scenes for minutes). Skip the mutation branch for it.
  const isExportRequest = result.success && isExportClientAction(result.data)
  // set_research_mode mutates only the session grant registry + world gate
  // flags (neither is persisted) — rewriting every scene row and notifying the
  // renderer for it is pure churn (version bumps, writer-gate traffic).
  const isSessionOnly = toolName === 'set_research_mode'

  // A code-authoring tool that produced a scene the verifier classified as a
  // SYNTAX error is flipped to success:false by tool-executor's hard-fail gate,
  // but it DID write a (broken) scene into `world` that must still be persisted —
  // the in-app runner keeps it (the scene is already in the store) so the model
  // can fetch + patch it. Without this, the stateless MCP path would discard the
  // write on return, diverging from in-app and leaving the Claude Code agent
  // unable to read the broken code it just wrote. Persist on this case too.
  const isSyntaxHardFail =
    !result.success && (result.data as { _verify?: { kind?: string } } | undefined)?._verify?.kind === 'syntax'

  if ((result.success || isSyntaxHardFail) && !isExportRequest && !isSessionOnly) {
    // Gate the scene DB + HTML persistence behind the branch writer gate. This
    // MCP path runs in the Electron main process (src/electron/mcp-bridge.ts) against
    // the same project database a fork/restore/delete mutates, so an ungated
    // write here can interleave with a destructive op on both the DB rows and the
    // on-disk HTML — the exact data-loss this lane prevents. The gate queues
    // behind any in-process destructive op and defers (bounded) to a live
    // cross-process destructive lock, failing loud past the bound rather than
    // writing into the middle of another window's revert/copy.
    let persistFailed = false
    try {
      await withWriterGate({ branchId, projectId }, async () => {
        // The persist outcome gates EVERYTHING downstream. The old
        // shape warned-and-continued on a false return and its catch swallowed a
        // thrown persist error — either way the HTML still hit disk, the renderer
        // was notified, and the client read success for an edit that never landed.
        const persisted = await persistThenSideEffects({
          // world.sceneGraph is effectively always empty here (projects has no
          // sceneGraph column, so world.sceneGraph = { nodes: [], edges: [] }), so the
          // MCP path does not manage the scene graph — and passing branchId skips the
          // project-wide node/edge cleanup, which also closes a pre-existing bug where
          // the old null-branch write wiped ALL sceneNodes/sceneEdges on every call.
          // Optimistic-concurrency write (v4 #9): an in-app autosave can commit
          // between an MCP read and write. The old code wrote the scene TABLES
          // unguarded and then a versionless `projects` update, so a racing autosave
          // was silently clobbered (and left version stale for the next save).
          // persistMcpSceneWrite mirrors the autosave's contract: one transaction,
          // version-checked projects update, scene-table write in the same tx, version
          // bump, retry-on-conflict (re-reading the FRESH description each attempt).
          persist: () =>
            persistMcpSceneWrite({
              projectId,
              scenes: world.scenes,
              sceneGraph: world.sceneGraph,
              branchId,
              // Persist the timeline only when a timeline tool ran; it lives in the
              // description blob (the only place the renderer reads it).
              timeline:
                (TIMELINE_TOOL_NAMES as readonly string[]).includes(toolName) && world.timeline != null
                  ? world.timeline
                  : null,
              // Only set when add_watermark ran this call (the MCP
              // world is rebuilt per call and nothing else writes it), so this
              // is undefined — a no-op — for every other tool.
              watermark: world.watermark,
              // globalStyle rides the SAME version-checked update —
              // the old bare versionless `db.update(projects).set({ globalStyle })`
              // that sat after the guarded write is gone.
              globalStyle: result.changes?.some((c) => c.type === 'global_updated') ? world.globalStyle : undefined,
              fallbackDescription: (project as any).description ?? null,
            }),
          // Notify the renderer so its Zustand store reloads the project —
          // only when the persist actually landed.
          notifyRenderer: _rendererNotifier ? () => _rendererNotifier!(projectId) : null,
          writeSceneHtml: result.affectedSceneId
            ? async () => {
                const scene = world.scenes.find((s) => s.id === result.affectedSceneId)
                if (!scene) return
                // Same guard the in-app choke point enforces (regenerateHTML,
                // tool-executor.ts). The id is used verbatim as the `<id>.html`
                // filename below, so an id containing a path separator would
                // write outside the scenes dir. The MCP path skipped this check.
                if (!SCENE_ID_RE.test(scene.id)) {
                  log.error('mcp: refusing to write scene HTML for invalid scene id', {
                    extra: { sceneId: scene.id },
                  })
                  return
                }
                try {
                  resolveStyle(world.globalStyle.presetId, world.globalStyle)
                  // v5 review: resolve the project watermark exactly like the
                  // in-app saveSceneHTML does (generation-actions.ts:473-481) —
                  // an MCP edit on a watermarked project must not write scene
                  // HTML missing the overlay. Prefer this call's world.watermark
                  // (add_watermark just ran); fall back to the persisted row.
                  type WatermarkParam = Parameters<typeof generateSceneHTML>[2]
                  let watermarkWithUrl: WatermarkParam = undefined
                  const wm = (world.watermark ?? (project as { watermark?: { assetId?: string } | null }).watermark) as
                    | { assetId?: string }
                    | null
                    | undefined
                  if (wm?.assetId) {
                    const assetRows = await db
                      .select({ publicUrl: schema.projectAssets.publicUrl })
                      .from(schema.projectAssets)
                      .where(eq(schema.projectAssets.id, wm.assetId))
                      .limit(1)
                    const publicUrl = assetRows[0]?.publicUrl
                    if (publicUrl) watermarkWithUrl = { ...wm, publicUrl } as NonNullable<WatermarkParam>
                  }
                  const html = generateSceneHTML(
                    scene,
                    world.globalStyle,
                    watermarkWithUrl,
                    undefined,
                    resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution),
                  )
                  const scenesDir = resolveScenesDir()
                  await fs.mkdir(scenesDir, { recursive: true })
                  await fs.writeFile(path.join(scenesDir, `${scene.id}.html`), html, 'utf-8')
                  // Do NOT re-verify here. Code-mutating tools already
                  // verified+stamped this scene via regenerateHTML (executeTool)
                  // BEFORE persist; a second offscreen verify here just contends
                  // for the window pool and was a major slice of patch_layer_code's
                  // over-timeout latency. A watermark overlay can't blank a scene
                  // that already verified, so the verify#1 stamp stands. (Non-code
                  // tools that reach this path don't change scene code, so the
                  // prior verifyStatus remains valid.)
                } catch (e) {
                  log.error('failed to write scene HTML', { error: e })
                }
              }
            : null,
          onPersistError: (e) => log.error('failed to persist scenes to tables', { error: e }),
        })
        if (!persisted) {
          log.warn('mcp persist failed (lock exhausted, project gone, or threw) — no HTML write, no notify', {
            extra: { projectId, toolName },
          })
          persistFailed = true
        }
      })
    } catch (e) {
      // Writer gate failed loud (a destructive op held the branch past the bound).
      // Surface it instead of silently dropping the write.
      log.error('mcp: writer gate blocked scene persistence', { error: e })
      return {
        success: false,
        content: e instanceof Error ? e.message : 'Branch is busy with a destructive operation; try again',
        error: 'branch_busy',
      }
    }
    if (persistFailed) {
      // result.success was computed BEFORE persistence — the
      // persist outcome overrides it. The world re-reads scenes per tool call
      // (no stale in-memory state), so "re-read and retry" is the real fix.
      return {
        success: false,
        content: MCP_PERSIST_FAILED_MESSAGE,
        error: 'persist_failed',
        affectedSceneId: result.affectedSceneId,
      }
    }
  }

  // Headless MP4 export for the MCP / external-agent path. A multi-scene 1080p
  // render takes minutes — longer than the MCP client timeout — so we do NOT
  // await it. Register a job, kick the render off in the background (the
  // renderer reports progress via onProgress), and return the jobId now. The
  // agent polls get_export_status for progress and the final output path.
  if (isExportRequest && isExportClientAction(result.data)) {
    const settings = result.data.exportSettings ?? {}
    // FCPXML and the interactive embed are fulfilled by the RENDERER (the File-menu
    // writer and publish.run both live there). The MCP export runner only knows how to
    // drive exportVideo, so anything else must honest-fail rather than silently render
    // an MP4 under a different name.
    if (settings.format && settings.format !== 'mp4') {
      result.success = false
      result.error = `export(format:'${settings.format}') is only available in the app — the MCP path can render MP4 only.`
      result.changes = [{ type: 'project_updated', description: result.error }]
    } else if (settings.sceneId) {
      result.success = false
      result.error = "export(scope:'scene') is only available in the app — the MCP path exports the whole project."
      result.changes = [{ type: 'project_updated', description: result.error }]
    } else if (_exportRunner) {
      const job = createExportJob(world.scenes.length)
      // Fire-and-forget: the render continues after this handler returns. Pass
      // the request's projectId so the runner renders the agent-selected
      // project, not whatever the editor window currently has open.
      void _exportRunner(settings, projectId, (p) => updateExportJob(job.jobId, p))
        .then(({ outputPath }) => updateExportJob(job.jobId, { status: 'complete', outputPath, progress: 100 }))
        .catch((e) => {
          // 11b: the runner (src/electron/main.ts) re-attaches the failing-scene
          // context the executeJavaScript bridge drops; errorJobPatch maps it
          // onto the job so get_export_status can name the broken scene.
          updateExportJob(job.jobId, errorJobPatch(e))
        })
      result.data.exportJobId = job.jobId
      result.changes = [
        {
          type: 'project_updated',
          description: `Export started (job ${job.jobId}). Poll get_status(kind:'export') with this jobId for progress and the output path.`,
        },
      ]
    } else {
      // No editor window means no offscreen runner to render through. Fail
      // honestly — a success without an exportJobId would make the agent believe
      // the export started, then get_export_status would find no job.
      // Mirror the in-app runner's honest-fail (runner.ts ~4315): flip to
      // success:false with an error so the agent knows the export never ran.
      result.success = false
      result.error = 'MP4 export unavailable — no editor window attached.'
      result.changes = [{ type: 'project_updated', description: 'MP4 export unavailable — no editor window attached.' }]
    }
  }

  // ── Secondary visual: fulfil the capture_frame PIGGYBACK over MCP ─────────
  // Code-write tools (write_scene_code / patch_layer_code / add_layer /
  // regenerate_layer — via the auto-capture hook) and
  // verify_scene stamp `clientAction:'capture_frame'` (+ sceneId/time) on their
  // result so the IN-APP runner attaches a rendered frame of the edit. The
  // primary-visual branch above deliberately does NOT hijack these (it keys on
  // tool NAME, so their mutation/report survives) — but that left the MCP agent
  // editing BLIND: it got the write/report with no pixels. Now that the mutation
  // has persisted, fulfil the same piggyback here — render ONE frame of the
  // affected scene via the offscreen runner and attach it as data.image, so
  // mcp-server emits an image block alongside the normal text result.
  //
  // Driven by the PAYLOAD (clientAction === 'capture_frame'), not a tool list, so
  // any current/future piggyback carrier is covered. BEST-EFFORT: unlike the
  // primary tools (where a capture failure IS the result), a failure here must
  // NOT fail the tool — the edit already succeeded and persisted, so on any error
  // we skip the frame and return the normal result. Guarded on result.success so
  // we never render a scene the tool itself rejected (a failed verify / errored
  // write), mirroring the in-app hook that skips broken scenes.
  // Surgical code-edit tools skip the bonus frame entirely: it's a second
  // offscreen render purely to attach a preview, and stacking it after the
  // edit's own verify+persist pushed patch_layer_code past the MCP client
  // timeout (measured ~2.5s of pure overhead). The edit succeeds and the agent
  // calls verify_scene/capture_frame when it actually wants to see the result.
  // Mutating tools that don't need a bonus preview frame: surgical code edits and
  // non-visual adjustments (timing / transitions / audio). The second offscreen
  // render stacked on their verify+persist blew the MCP client timeout (measured
  // on patch_layer_code AND set_scene_duration). The edit succeeds; the agent
  // calls verify_scene / capture_frame when it actually wants a visual.
  const SKIP_BONUS_CAPTURE_TOOLS = new Set([
    'patch_layer_code',
    'scene_props',
    'set_audio_mix',
    'set_master_volume',
    'set_track_props',
    'add_narration',
    'add_music',
    'add_sfx',
  ])
  let secondaryCaptureTime: number | null = null
  if (
    result.success &&
    !isPrimaryVisualFeedbackTool(toolName) &&
    !SKIP_BONUS_CAPTURE_TOOLS.has(toolName) &&
    isVisualFeedbackClientAction(result.data) &&
    result.data.clientAction === 'capture_frame' &&
    _captureRunner
  ) {
    const piggyback = result.data as unknown as Record<string, unknown>
    const sceneId = piggyback.sceneId
    const rawTime = piggyback.time
    const scene = typeof sceneId === 'string' ? world.scenes.find((s) => s.id === sceneId) : undefined
    if (scene) {
      // Clamp to [0, duration] like the primary capture_frame path — an
      // out-of-range time captures the end frame while the caption claims t=999s.
      const dur = typeof scene.duration === 'number' && scene.duration > 0 ? scene.duration : 0
      const t =
        typeof rawTime === 'number' && Number.isFinite(rawTime)
          ? Math.max(0, dur > 0 ? Math.min(rawTime, dur) : rawTime)
          : 1
      try {
        resolveStyle(world.globalStyle.presetId, world.globalStyle)
        const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
        const html = generateSceneHTML(scene, world.globalStyle, undefined, undefined, dims)
        // This bonus frame is best-effort (the edit already succeeded). Bound it so
        // a slow/contended offscreen render can't stall the tool response past the
        // MCP client timeout — the cause of patch_layer_code "timing out" even
        // though the edit landed. On timeout we fall through to the non-fatal catch
        // and return the successful edit WITHOUT the image.
        const frame = await Promise.race([
          _captureRunner(
            {
              id: scene.id,
              html,
              durationSeconds: scene.duration,
              sceneType: (scene as { sceneType?: string }).sceneType,
              bgColor: scene.bgColor,
            },
            t,
            { width: dims.width, height: dims.height, maxWidth: 1280 },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('secondary capture_frame timed out (edit succeeded; skipping bonus frame)')),
              2500,
            ),
          ),
        ])
        // Attach to the EXISTING result.data (already carries the tool's own
        // report/changes). mcp-server reads data.image → image content block; the
        // base64 is stripped from the text content below so it never bloats text.
        piggyback.image = {
          dataUri: `data:${frame.mimeType};base64,${frame.pngBase64}`,
          mimeType: frame.mimeType,
          width: frame.width,
          height: frame.height,
        }
        secondaryCaptureTime = t
      } catch (e) {
        // Non-fatal: the edit stands; we just couldn't attach a visual.
        log.error('mcp: secondary capture_frame failed (non-fatal)', { error: e })
      }
    }
  }

  return {
    success: result.success,
    content: assembleMcpResultText(result, secondaryCaptureTime),
    data: result.data,
    affectedSceneId: result.affectedSceneId,
    permissionNeeded: result.permissionNeeded,
  }
}

/**
 * Assemble the TEXT content for an MCP tool result.
 *
 * Image payloads (`data.image` / `data.images`) are emitted as their OWN MCP
 * image content blocks by the server (imageContentsFromResultData), so their
 * base64 data URIs are kept OUT of this text — a multi-KB data URI dumped into
 * text wastes tokens and buries the real result. This applies to the
 * secondary frame attached above AND to any future tool that returns inline
 * image bytes in `data.image`/`data.images`. When a secondary frame was
 * attached, a short caption points the model at it. Exported for unit testing.
 */
export function assembleMcpResultText(
  result: { success: boolean; error?: string; changes?: { description: string }[]; data?: unknown },
  secondaryCaptureTime: number | null,
): string {
  if (!result.success) {
    // A failed tool usually carries its reason in `error` — but verify_scene is
    // an honest exception: a verify that FAILS returns success:false with NO
    // error field, putting its full verdict (checks, runtime error + location,
    // every issue, layers) in `data.report` instead. Returning the bare
    // 'Tool execution failed' there would tell the MCP agent its scene is broken
    // WITHOUT telling it why — the exact blind spot verify_scene exists to fix.
    // So on failure: surface `error` if present, then `data.report` verbatim
    // (it's a formatted multi-line string — do NOT JSON-escape it). Fall back to
    // the generic message only when the tool gave us nothing to show.
    const failParts: string[] = []
    if (result.error) failParts.push(result.error)
    if (result.data && typeof result.data === 'object') {
      const report = (result.data as { report?: unknown }).report
      if (typeof report === 'string' && report.trim()) failParts.push(report)
    }
    return failParts.length > 0 ? failParts.join('\n\n') : 'Tool execution failed'
  }
  const parts: string[] = []
  if (result.changes?.length) {
    parts.push(result.changes.map((c) => c.description).join('; '))
  }
  if (result.data && typeof result.data === 'object') {
    // Strip image bytes from the TEXT for ANY image-bearing result (the secondary
    // frame here, or any future tool with inline image bytes) — the server emits
    // them as image blocks, so base64 in text is pure waste.
    const { image: _img, images: _imgs, ...dataForText } = result.data as Record<string, unknown>
    if (Object.keys(dataForText).length > 0) {
      parts.push(JSON.stringify(dataForText, null, 2))
    }
    // Caption ONLY the frame WE attached (secondaryCaptureTime set). A tool whose
    // own output is an inline image is not "the edited scene", so it gets no
    // caption — just its own image block + the tool's normal text.
    if (secondaryCaptureTime !== null && _img && typeof _img === 'object') {
      const im = _img as { width?: number; height?: number }
      parts.push(
        `[Attached a rendered frame (${im.width ?? '?'}×${im.height ?? '?'}px) at t=${secondaryCaptureTime}s ` +
          `of the edited scene — review it to confirm the change looks right.]`,
      )
    }
  }
  return parts.join('\n\n') || 'Done'
}
