/**
 * Typed client-action contract.
 *
 * Some tools don't do their work inline — they return `data.clientAction`,
 * a request the RENDERER (or the headless export runner) must fulfil, then
 * the result is reconciled. `export` is the load-bearing example: it
 * returns `{ clientAction: 'run_export', exportSettings }` and the runner /
 * MCP handler kicks off the actual Pixi/WebCodecs render.
 *
 * This module owns the EXPORT variant of that contract: a discriminated
 * union + a type guard that replace the unchecked
 * `(result.data as Record<string, unknown>)?.clientAction === 'run_export'`
 * cast in mcp-handler.ts (and is reusable by the runner / future callers).
 *
 * Scope is deliberately narrow (export path only). Other clientAction values
 * exist today (`capture_frame`, `review_video`, `review_scene_motion`); they
 * stay untyped here on purpose — broader tool-result typing is deferred to
 * `isExportClientAction` returns false for
 * them, so adding this type guard never changes their behaviour.
 *
 * W1 OWNS this type. Scene / runner work (W4) will import it later — do not
 * fork a second copy.
 */

/** Render settings carried by a `run_export` client action. */
export interface ExportClientActionSettings {
  /**
   * What to produce. Absent === 'mp4' (every pre-`export`-tool caller and every
   * replayed conversation omits it), so the renderer must treat undefined as mp4.
   * 'fcpxml' → electronAPI.exportFcpxml; 'embed' → publish.run. Both are whole-project.
   */
  format?: 'mp4' | 'fcpxml' | 'embed'
  resolution?: '720p' | '1080p' | '4k'
  fps?: number
  profile?: 'fast' | 'quality'
  burnCaptions?: boolean
  outputName?: string
  /** mp4 only — render just this scene instead of the whole video. */
  sceneId?: string
}

/** The export variant of the client-action contract. */
export interface RunExportClientAction {
  clientAction: 'run_export'
  /** Render settings to pass to the renderer's exportVideo(). */
  exportSettings?: ExportClientActionSettings
  /** Stamped by the handler once a job is registered (for status polling). */
  exportJobId?: string
  /** Stamped by the in-app runner when the synchronous round-trip succeeds. */
  exportedPath?: string
  /** Stamped by the in-app runner when the round-trip fails. */
  exportError?: string
}

/**
 * Visual-feedback client actions. These tools return pixels/video the RENDERER
 * must produce; only the in-app runner (src/lib/agents/runner.ts) fulfils them
 * today. The stateless MCP path does NOT yet wire them up, so over MCP they
 * must fail honestly rather than return their text-stub description as success
 * (the "silent false-success" failure). Follow-up work
 * fulfils these via export-tier3.ts; until then {@link isVisualFeedbackClientAction}
 * lets mcp-handler convert them to an explicit failure.
 */
export const VISUAL_FEEDBACK_CLIENT_ACTIONS = ['capture_frame', 'review_video', 'review_scene_motion'] as const

export type VisualFeedbackClientActionName = (typeof VISUAL_FEEDBACK_CLIENT_ACTIONS)[number]

/** A visual-feedback variant of the client-action contract. */
export interface VisualFeedbackClientAction {
  clientAction: VisualFeedbackClientActionName
}

/**
 * Discriminated union of client actions this module types. Today the export and
 * visual-feedback variants are modelled; the union exists so additional variants
 * can be added without changing the guards' call sites.
 */
export type ClientAction = RunExportClientAction | VisualFeedbackClientAction

/**
 * Narrowing type guard: is `data` an export client-action payload?
 *
 * Replaces the raw `(data as Record<string, unknown>)?.clientAction ===
 * 'run_export'` cast. Accepts `unknown` (tool results are loosely typed) and
 * narrows to {@link RunExportClientAction} so `exportSettings` / `exportJobId`
 * are typed at the call site instead of re-cast.
 */
export function isExportClientAction(data: unknown): data is RunExportClientAction {
  return typeof data === 'object' && data !== null && (data as { clientAction?: unknown }).clientAction === 'run_export'
}

/**
 * Narrowing type guard: is `data` a visual-feedback client action
 * (`capture_frame` / `review_video` / `review_scene_motion`)?
 *
 * The stateless MCP path can't fulfil these yet, so mcp-handler uses this to
 * fail honestly instead of returning the tool's text-stub description as a
 * success. See {@link VISUAL_FEEDBACK_CLIENT_ACTIONS}.
 */
export function isVisualFeedbackClientAction(data: unknown): data is VisualFeedbackClientAction {
  if (typeof data !== 'object' || data === null) return false
  const action = (data as { clientAction?: unknown }).clientAction
  return typeof action === 'string' && (VISUAL_FEEDBACK_CLIENT_ACTIONS as readonly string[]).includes(action)
}

/**
 * Is `toolName` a PRIMARY visual-feedback tool — one whose entire purpose is to
 * return rendered frame(s)? Only these three. Deliberately distinct from
 * {@link isVisualFeedbackClientAction}: the same `clientAction: 'capture_frame'`
 * value is ALSO piggybacked onto OTHER tools' results (verify_scene attaches it
 * for a visual alongside its report; the code-write auto-capture hook attaches it
 * to write_scene_code / patch_layer_code / add_layer / regenerate_layer /
 * regenerate_layer). The MCP handler keys its "replace the result with a frame"
 * fulfilment on the TOOL NAME, not the clientAction value — otherwise it hijacks
 * those tools, discarding verify's report and (worse) dropping the code-write
 * mutations by returning before the persistence step.
 */
export function isPrimaryVisualFeedbackTool(toolName: string): boolean {
  // `review` is ONE tool now (scope:'cut' | 'motion') but still emits the two original
  // clientAction values, so the value list above can no longer double as the tool list.
  return toolName === 'capture_frame' || toolName === 'review'
}

/**
 * A REVIEW tool (review_video / review_scene_motion) cannot be fulfilled on a
 * path whose offscreen render runner is absent — review_video needs the single-
 * frame capture runner, review_scene_motion needs the multi-frame one. When
 * unfulfillable the MCP path must HONEST-FAIL rather than letting the handler's
 * `reviewBrief: { reviewable:false }` fallback ride back as a SUCCESS the model
 * misreads as "the cut was reviewed". (#honest-review-mcp)
 */
export function reviewToolUnfulfillable(
  clientAction: string,
  runners: { capture: boolean; multiCapture: boolean },
): boolean {
  if (clientAction === 'review_video') return !runners.capture
  if (clientAction === 'review_scene_motion') return !runners.multiCapture
  return false
}
