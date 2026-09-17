/**
 * The mutable world a tool run operates on. Lives in its own module so tool
 * handlers can type against it without importing tool-executor (which imports
 * every handler).
 */

import type { Scene, GlobalStyle, APIPermissions, SceneGraph, ZdogPersonAsset } from '../types'
import type { StateSnapshot } from './types'

export interface WorldStateMutable {
  scenes: Scene[]
  globalStyle: GlobalStyle
  projectName: string
  projectId?: string
  outputMode: 'mp4' | 'interactive'
  sceneGraph: SceneGraph
  activeTools?: string[]
  /**
   * Transient: set once when the runner has auto-dispatched an Explore because the
   * parent looped on inline research (see runner's research cap). Blocks a second
   * auto-dispatch and hard-stops further inline research for the rest of the run.
   */
  researchAutoDispatched?: boolean
  /**
   * True only on the in-app TOP-LEVEL run whose runner will consume a
   * `dispatch_scene_builder` call and run the scene-builder orchestrator.
   * Absent on the MCP path (no runner loop) and on sub-agents (the runner's
   * isSubAgent guard suppresses the handoff). dispatch_scene_builder honest-
   * fails when this is falsy instead of returning a "Delegating…" success-lie.
   */
  orchestratorAvailable?: boolean
  /**
   * True only when a `fanout_proposed` / `crossproject_proposed` emit will
   * actually reach a consumer — i.e. the top-level in-app run that is not
   * itself a dispatched leg (`!isSubAgent && !disableFanout`, the exact gate on
   * both emits). dispatch_to_branches / dispatch_to_projects honest-fail when
   * this is falsy instead of reporting a fan-out nobody will run.
   */
  fanoutAvailable?: boolean
  /**
   * Execution-time toolset enforcement (Workstream C.2b, claw-code pattern).
   * When set, `executeTool` rejects any tool whose name is not in this set —
   * enforcing the agent's resolved toolset at *execute* time, not just in the
   * offered list. Populated for sub-agents from the resolved `ctx.tools`; a
   * sub-agent dispatched to build a "d3" scene therefore cannot reach into,
   * say, avatar or export tools even if it hallucinates the name. Undefined on
   * the parent (no restriction beyond canonical-name validation).
   */
  enforcedToolNames?: Set<string>
  /**
   * Scene-scope enforcement (Workstream C.2a, TaskPacket scope). When set,
   * these are scene ids that existed when the sub-agent started but which it
   * does NOT own — a mutating tool targeting one of them (via a `sceneId` arg)
   * is rejected. The sub-agent may still freely mutate the scene it owns and
   * any scene it creates during the run (their ids aren't in this set).
   */
  scopeForeignSceneIds?: Set<string>
  /** Per-run snapshot store for undo/recovery (isolates concurrent runs) */
  snapshots?: StateSnapshot[]
  /** NAMED checkpoints — the agent-visible rollback points. Kept
   *  separate from `snapshots`: that array gets one entry before EVERY tool
   *  call (noisy implementation history); this one holds meaningful moments
   *  (before destructive ops, explicit saves) so list_snapshots reads like
   *  a story, not a log. */
  checkpoints?: StateSnapshot[]
  /** Set by the destructive-op pre-hook; executeTool promotes the per-tool
   *  pre-snapshot into `checkpoints` under this label (single-clone path). */
  _pendingNamedCheckpointLabel?: string
  /** Transient: most-recent layout-overflow advisory per scene, written by
   *  regenerateHTML after a verified write and read by the post-tool gate to
   *  attach a non-blocking `_layout` signal. Not persisted. */
  _recentSceneOverflows?: Record<string, import('../services/scene-verifier').SceneOverflow[]>
  /** Durable mirror of the latest layout-overflow reading per scene. Unlike
   *  `_recentSceneOverflows` (consumed-and-deleted by the fire-once advisory),
   *  this survives to the post-build corrective pass so a scene shipped with
   *  known overflow gets a guaranteed fix attempt. Cleared on a clean re-measure. */
  _sceneOverflowState?: Record<string, import('../services/scene-verifier').SceneOverflow[]>
  /** Transient: most-recent pixel-truth reading per scene (blank / broken-image
   *  detection), written by regenerateHTML after a verified write and read by the
   *  post-tool gate to apply the BLOCKING render check. Not persisted. */
  _recentSceneFrame?: Record<string, import('../services/scene-verifier').SceneFrameTruth>
  /** Transient (html-honesty): scenes whose most-recent `regenerateHTML`
   *  did NOT write the on-disk HTML for a reason that does NOT stamp the scene
   *  `verifyStatus:'errored'` — i.e. a mid-flight ABORT or an invalid/missing
   *  sceneId. Written by regenerateHTML and read+cleared by the post-tool gate,
   *  which surfaces an honest `htmlWritten:false` (an abort also flips the tool
   *  to a failure). Without this, those branches were reported as full success:
   *  the world-state mutation landed but the preview/export render did not. Not
   *  persisted. Value carries the reason for the message. */
  _recentHtmlUnwritten?: Record<string, { reason: 'aborted' | 'invalid-scene'; error?: string }>
  apiPermissions?: APIPermissions
  audioProviderEnabled?: Record<string, boolean>
  /** The project's audio settings (default TTS provider + local-server URLs).
   *  Threaded so add_narration honors the user's `defaultTTSProvider` pick
   *  (e.g. pocket-tts) and its `pocketTTSUrl`/`voxcpmUrl`/`edgeTTSUrl` — without
   *  this the resolver only sees process.env and silently ignores the setting. */
  audioSettings?: import('@/lib/types/audio').AudioSettings | null
  mediaGenEnabled?: Record<string, boolean>
  /** Web Search switch — web_search (native, model-gated) + stock/archival media search. */
  webSearchEnabled?: boolean
  /** Web Fetch switch — fetch_url_content + fetch_video_from_url (our code, all models). */
  webFetchEnabled?: boolean
  /** Auto-Accept Web Search — when false, native web_search is withheld until session-approved. */
  autoAcceptWebSearch?: boolean
  /** Per-provider enabled map for media providers (pexels, pixabay, unsplash, archive-org…). */
  researchProviderEnabled?: Record<string, boolean>
  /** Project IDs where the user has acknowledged the yt-dlp legal disclaimer. Downloads
   *  are refused for projects not in this set. Probe calls are always allowed. */
  ytDlpConsentedProjects?: Set<string>
  sessionPermissions?: Record<string, string>
  /** Reference media attached to this run. Lets the
   *  `analyze_reference_media` tool re-query a specific attachment by id. */
  referenceMedia?: import('./types').ReferenceMedia[]
  /**
   * Structured style tokens extracted from the most recent
   * `analyze_reference_media` call (design matching). Lets
   * create_design_brief seed the brief from a just-analyzed reference and lets
   * generate_image_from_reference enrich its prompt — without re-running intake.
   * Latest analysis wins (a single salient reference is the intent).
   */
  referenceStyleTokens?: import('./services/style-tokens').StyleTokens
  /** Per-modality understanding-engine choice from Settings (`auto`/concrete). */
  mediaUnderstandingEngines?: Partial<Record<import('./types').ReferenceMediaKind, string>>
  generationOverrides?: Record<string, { provider?: string; prompt?: string; config?: Record<string, any> }>
  autoChooseDefaults?: Record<string, { provider: string; config: Record<string, any> }>
  /**
   * Agent run id. One id per agent run, set by `runner.ts`
   * before tool dispatch begins so every action emitted from inside
   * tool handlers ends up grouped under the same runId. Locked decision
   * #4: "undo last agent run" reverts every action with this runId in
   * reverse order.
   */
  currentRunId?: string | null
  /**
   * Self-correction budget snapshot (Gap 5). Mirrored from RunProgress at
   * the runner level so pre-tool hooks (which only see `world`) can enforce
   * the cap on verify_scene without reaching into runner closures. Updated
   * by the runner immediately before each tool dispatch.
   */
  verificationCyclesUsed?: number
  verificationCyclesMax?: number
  /**
   * Per-scene cache of the most recent `verifyAndStampScene` outcome, used
   * to debounce duplicate runtime checks in the same agent turn. When the
   * auto-runtime-verify post-tool hook stamps a scene at T, the verify_scene
   * tool body at T+ε reads the cache and reuses the prior outcome —
   * avoiding a 5-8s redundant offscreen render per write→verify pair.
   * TTL is enforced at read time (see
   * RUNTIME_VERIFY_CACHE_TTL_MS in this file).
   */
  recentRuntimeVerify?: Record<
    string,
    {
      at: number
      status: 'verified' | 'errored' | 'unknown'
      error: import('@/lib/db/schema').SceneVerifyError | null
      durationMs: number
    }
  >

  /**
   * Per-scene capture cache keyed by `sceneId:codeHash`. When the
   * auto-capture post-hook fires after a code-write tool, it checks this
   * cache. If the scene code hasn't changed since the last capture we skip
   * the round-trip — the agent already saw these pixels.
   *
   * Cache is invalidated automatically when `writeRecentCapture` is called
   * with a new hash. No TTL — the hash itself is the freshness signal.
   */
  recentCaptureCache?: Record<string, { capturedAt: number }>

  /** Model ID used by the agent — forwarded to generateCode so it respects the user's model choice */
  modelId?: string
  /** Model tier — forwarded to generateCode so it respects the user's tier choice */
  modelTier?: 'auto' | 'premium' | 'budget'
  /** When true, prefer free/local providers for TTS and generation */
  localMode?: boolean
  /** Model configs for resolving local model endpoints */
  modelConfigs?: import('./model-config').ModelConfig[]
  /** ScenePlan set by plan_scenes — provides narrative context for downstream generation */
  scenePlan?: import('./types').ScenePlan
  /** Free-form written plan set by write_plan. The
   *  user-facing planning artifact; the scenePlan is derived from it silently on approval. */
  plan?: import('./types').AgentPlan
  /** Tracked todo checklist maintained by update_todos. Rendered in the plan card. */
  todos?: import('./types').AgentTodo[]
  zdogLibrary?: ZdogPersonAsset[]
  zdogStudioLibrary?: import('@/lib/types/zdog-studio').ZdogStudioAsset[]
  /** NLE timeline with clips on tracks */
  timeline?: import('../types').Timeline | null
  /** MP4/export settings including aspect ratio */
  mp4Settings?: import('../types').MP4Settings
  // Recording state (agent-controlled)
  recordingState?: import('@/types/electron').RecordingStoreState
  recordingConfig?: import('@/types/electron').RecordingConfig
  recordingCommand?: import('@/types/electron').RecordingCommand
  recordingCommandNonce?: number
  recordingResult?: import('@/types/electron').RecordingSessionManifest | null
  recordingError?: string | null
  recordingElapsed?: number
  recordingAttachSceneId?: string | null
  /** Project watermark set by add_watermark this run. Carried out
   *  on the final state_change (in-app) / persistMcpSceneWrite (MCP) — only
   *  set when the tool ran, so consumers can key on `!== undefined`. */
  watermark?: import('../types/media').WatermarkConfig
  /** Project assets (media library) for brand kit and SVG extrusion */
  projectAssets?: import('../types/media').ProjectAsset[]
  /** Brand kit data for branding tools */
  brandKit?: import('../types/media').BrandKit | null
  /** The structured project brief (intent/mediaStrategy/confidence). Already stamped
   *  onto the world at runner.ts (object-spread from opts.projectBrief) — declared here
   *  so handlers can read it (e.g. plan_scenes' brief-aware visual-coverage gate). */
  projectBrief?: import('../types/project').ProjectBrief | null
  /** Layered permission rules (user/workspace/project/session) resolved at
   *  request start. Supersedes the legacy apiPermissions enum modes for the
   *  allow/deny decision; apiPermissions still carries spend caps. */
  permissionRules?: import('../types/permissions').PermissionRule[]
  /** Authenticated userId (trusted, set server-side from session). Needed to
   *  author new session-scope rules from the dialog's "This session" button. */
  authUserId?: string | null
  /** Conversation id for session-scope rule authoring. */
  conversationId?: string | null
  /** Workspace id plumbed for evaluator context. */
  workspaceId?: string | null
  /** Renderer-captured snapshot of the editor UI (selection + playback +
   *  zoom) at run start. Exposed to the agent via `read_editor_state` so
   *  it can act on what the user is currently looking at. */
  editorState?: import('./types').EditorStateSnapshot
  /**
   * Diff-preview mode (accept/reject for destructive tools).
   *
   * - 'off' (default): all tools execute immediately
   * - 'destructive-only': tools tagged with `mutates` pause for user
   *   approval before running; all other tools execute immediately
   * - 'always': every tool pauses (rare — for high-stakes runs)
   *
   * On approval the same tool is replayed via the existing `resumeToolCall`
   * path with `__previewApproved: true` set so the gate skips itself.
   */
  previewMode?: 'off' | 'destructive-only' | 'always'
  /**
   * Sandbox mode: paid asset generation is substituted with free-local / placeholder
   * assets via the resolveAsset gateway. checkApiPermission fails closed when this
   * is set (see below) so no paid provider call can fire even if a handler bypasses
   * the gateway. The agent LLM still runs normally.
   */
  sandboxMode?: boolean
  /**
   * Set by the MCP bridge (executeMcpTool): this world serves a Claude Code /
   * external-agent session. set_research_mode treats the MCP client's own
   * tool-permission prompt as the user grant (there is no in-app approval
   * card to show on this path).
   */
  mcpSession?: boolean
  /**
   * Run-scoped cost ceiling for the MCP / external-agent path.
   * Set ONLY by executeMcpTool (a per-project in-memory ledger). When present,
   * checkApiPermission blocks a paid generation whose estimate would push the
   * session's committed spend past the cap, and reserves the estimate on pass.
   * The in-app agent NEVER sets this — its checkApiPermission cost branch is
   * inert — so the in-app spend cap stays governed by RunCostLedger in runner.ts.
   */
  mcpCostLedger?: import('./run-cost-ledger').RunCostLedger
  /**
   * Run-level permission posture layered over apiPermissions. 'auto' allows
   * (explicit always_deny still wins), 'ask' forces the confirm card, 'default'
   * leaves saved rules unchanged.
   */
  permissionPosture?: import('./types').PermissionPosture
}
