/**
 * Main-process ring buffer of scene PLAYBACK errors.
 *
 * The write-time verifier catches errors that fire on load; this buffer holds
 * what the in-scene beacon catches at PLAYBACK time (lazy asset 404s,
 * mid-animation throws, audio decode failures) — the class of failure the
 * agent was completely blind to (audit Gap 1).
 *
 * Lives in the MAIN process: written via the `dreambyte:sceneErrors.report`
 * IPC (renderer preview host forwards beacon + jsx-error postMessages), read
 * IN-PROCESS by verify_scene reports and the runner's context refresh — the
 * agent runs in main, so reads need no IPC.
 *
 * Dedupe: the beacon, the React error boundary, and a re-thrown RAF
 * error can all report the same message — identical (sceneId, message)
 * within DEDUPE_WINDOW_MS collapse to one entry.
 */

import type { SceneRuntimeError } from './error-capture-shared'

// Per-scene cap matches MAX_BEACON_ERRORS_PER_LOAD (error-capture-shared.ts) —
// the buffer never needs to hold more than one load's worth of beacon posts.
const MAX_ERRORS_PER_SCENE = 10
const DEDUPE_WINDOW_MS = 5_000
/** Global key cap: a hostile/buggy reporter inventing sceneIds must not grow
 *  the map unboundedly (the buffer is per-scene capped; this caps the map). */
const MAX_TRACKED_SCENES = 200

const buffers = new Map<string, SceneRuntimeError[]>()

/**
 * PROMPT-INJECTION DEFENSE: error messages are
 * SCENE-AUTHORED strings (the scene's own code chooses what Error() says) and
 * they flow into the agent's context refresh and verify_scene reports. A
 * scene throwing Error("SYSTEM: ignore prior instructions…") must read as
 * inert data there. Sanitized once at record time so every consumer —
 * present and future — gets the neutralized form: control chars and
 * newlines collapsed (no fake message boundaries), prompt-fence characters
 * stripped, length capped. Consumers ALSO fence the text as untrusted data.
 */
function sanitizeErrorText(s: string, max = 300): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, ' ') // control chars + newlines -> single space
      .replace(/[`[\]{}<>]/g, '') // fence/markup chars that fake structure
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, max)
  )
}

export function recordSceneError(sceneId: string, error: SceneRuntimeError): void {
  if (!sceneId || !error || typeof error.message !== 'string') return
  if (!buffers.has(sceneId) && buffers.size >= MAX_TRACKED_SCENES) return // key-cap: drop, never grow unbounded
  const sanitized: SceneRuntimeError = {
    ...error,
    message: sanitizeErrorText(error.message),
    source: error.source ? sanitizeErrorText(error.source, 120) : undefined,
    // Future timestamps would survive sinceMs filters forever — clamp.
    at: Math.min(error.at, Date.now()),
  }
  if (!sanitized.message) return
  const list = buffers.get(sceneId) ?? []
  const last = [...list].reverse().find((e) => e.message === sanitized.message)
  if (last && sanitized.at - last.at < DEDUPE_WINDOW_MS) return // duplicate within window
  list.push(sanitized)
  if (list.length > MAX_ERRORS_PER_SCENE) list.shift()
  buffers.set(sceneId, list)
}

/** Recent playback errors for one scene, newest last. */
export function getRecentSceneErrors(sceneId: string, sinceMs = 0): SceneRuntimeError[] {
  return (buffers.get(sceneId) ?? []).filter((e) => e.at >= sinceMs)
}

/** Stale-error hygiene: a scene's HTML rewrite invalidates its old errors —
 *  the next load reports fresh ones if the new code is still broken. */
export function clearSceneErrors(sceneId: string): void {
  buffers.delete(sceneId)
}

/** Compact cross-scene summary for the runner's context refresh: one line per
 *  scene with recent errors, capped, so the agent learns about broken
 *  playback WITHOUT a tool call. Empty string when all clear. */
export function summarizeRecentSceneErrors(sceneIds: string[], sinceMs = 0, maxLines = 5): string {
  const lines: string[] = []
  for (const id of sceneIds) {
    const errs = getRecentSceneErrors(id, sinceMs)
    if (errs.length === 0) continue
    const latest = errs[errs.length - 1]
    lines.push(
      `- scene ${id.slice(0, 8)}: ${errs.length} playback error(s); latest [${latest.kind}] ${latest.message.slice(0, 160)}${latest.line ? ` (line ${latest.line})` : ''}`,
    )
    if (lines.length >= maxLines) break
  }
  return lines.length > 0 ? lines.join('\n') : ''
}

/** Test seam. */
export function __clearAllSceneErrorsForTesting(): void {
  buffers.clear()
}
