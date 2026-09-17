// Pure decisions for preview auto-advance between scene clips.
//
// A scene iframe only fires `ended` at the end of its full animation length. When a
// clip is right-trimmed (clip.trimEnd < the iframe's natural duration) the preview
// must advance earlier, at the trimmed out-point — otherwise playback runs past the
// trim into footage the user cut. PreviewPlayer's tick watches for that out-point
// (the "trimEnd watchdog") and routes through the SAME advance path as `onEnded`.
//
// Because the watchdog and a later `onEnded` can both target one scene — and the tick
// keeps firing for a few frames after an advance until `selectedSceneId` settles —
// the advance must be idempotent per scene. These helpers encode that.

/**
 * The trimmed out-point has been reached. `currentTime` is scene-local
 * (`masterTL.time()` inside the iframe) and `trimEnd` is the scene-local out-point
 * set by a split/trim, so the comparison is direct (no speed/trimStart math). A clip
 * with no `trimEnd` (untrimmed) never triggers the watchdog — it ends via `onEnded`.
 */
export function reachedTrimEnd(trimEnd: number | null | undefined, currentTime: number): boolean {
  return trimEnd != null && currentTime >= trimEnd
}

/**
 * Whether an advance request for `fromSceneId` should proceed. Two guards keep it
 * single-fire:
 *  - `selectedSceneId !== fromSceneId` rejects a stale request for a scene we've
 *    already left (e.g. a late `onEnded` arriving after the watchdog moved us on).
 *  - `advancingSceneId === fromSceneId` rejects a repeat while this scene is mid-advance
 *    (the tick re-firing before `selectedSceneId` updates to the next scene).
 */
export function shouldAdvance(opts: {
  fromSceneId: string
  selectedSceneId: string | null
  advancingSceneId: string | null
}): boolean {
  if (opts.selectedSceneId !== opts.fromSceneId) return false
  if (opts.advancingSceneId === opts.fromSceneId) return false
  return true
}

/**
 * Transport replay decision. When the last clip ends the transport parks in a
 * `completed` state; a subsequent explicit play must restart from the timeline start
 * (scene 1, t=0) — for both multi-scene and single-scene projects — rather than
 * resuming the last scene in place.
 *
 * Returns the scene id to replay from when a replay is warranted, or `null` to play
 * normally (resume the selected scene). `firstSceneId` is the timeline's first
 * renderable scene (V1 clip order, falling back to scene-array order). Single-scene
 * projects pass the same id as both first and last — replay still restarts it.
 */
export function replayTargetOnPlay(opts: {
  completed: boolean
  firstSceneId: string | null | undefined
}): string | null {
  if (!opts.completed) return null
  return opts.firstSceneId ?? null
}
