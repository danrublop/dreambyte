/**
 * Scene-duration clamping shared by write_scene_code and set_scene_duration.
 *
 * The absolute floor/ceiling [3, 30]s always applies. When the scene belongs to
 * a multi-scene build with a PLANNED per-scene duration, the upper bound is
 * additionally capped at `planned * PLAN_OVERRUN_FACTOR` so scenes can't drift
 * toward the 30s ceiling and create long static holds with no audio (the
 * "87s plan → 193s build" dead-air defect).
 *
 * This does NOT fight narration: `add_narration` grows a scene to fit its
 * voiceover through a SEPARATE, unclamped `updateScene` path, so a scene that
 * needs to be longer for real audio still gets there — this clamp only reins in
 * padding the agent adds at authoring time.
 */
const HARD_MIN_SEC = 3
const HARD_MAX_SEC = 30
/** A scene may be authored up to this factor over its planned duration. Mirrors
 *  DURATION_OVERRUN_FACTOR in the acceptance evaluator so the clamp and the
 *  check agree on what counts as an over-run. */
export const PLAN_OVERRUN_FACTOR = 1.3

/** Structural view of the world's active plan — kept minimal so this helper has
 *  no import cycle with tool-executor / types. */
interface PlanBearingWorld {
  scenePlan?: { scenes?: Array<{ id?: string; duration?: number }> }
}

/** The planned duration (seconds) for a scene id, or undefined when there's no
 *  active plan or the scene isn't in it (single-scene / chat edits). */
export function plannedDurationFor(world: PlanBearingWorld, sceneId: string): number | undefined {
  const s = world.scenePlan?.scenes?.find((p) => p.id === sceneId)
  return typeof s?.duration === 'number' && s.duration > 0 ? s.duration : undefined
}

/** Clamp a requested duration to [3, 30], additionally capping the upper bound at
 *  `planned * 1.3` when a planned duration is known. */
export function clampSceneDuration(requested: number, planned?: number): number {
  const hi = typeof planned === 'number' && planned > 0 ? Math.min(HARD_MAX_SEC, Math.round(planned * PLAN_OVERRUN_FACTOR)) : HARD_MAX_SEC
  return Math.max(HARD_MIN_SEC, Math.min(hi, requested))
}
