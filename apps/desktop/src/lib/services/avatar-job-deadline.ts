/**
 * Avatar (HeyGen) render deadline policy — the avatar counterpart to
 * `video-job-deadline.ts`.
 *
 * Avatar generation is async + polled via `get_avatar_status`. Without a
 * deadline, a wedged HeyGen render is polled forever: the agent burns iterations
 * on a job that never reports `done`, the run eventually gives up, and the avatar
 * layer is left permanently `processing` with no video — silently absent, no
 * error surfaced. This policy bounds the wait: past the deadline a still-rendering
 * job is declared timed out and the layer is flipped to `error`.
 *
 * Pure + dependency-free so the policy is unit-testable without a DB or a clock.
 */

import { MAX_EXTENSION_SECONDS } from '@/lib/export/reconcile-scene-duration'

// HeyGen renders typically finish in 1-3 minutes; 15m is a generous ceiling that
// still bounds a stuck job (matches the video path's ceiling).
const AVATAR_MAX_MS = 15 * 60_000

/**
 * The scene duration needed to fit a finished avatar clip, or `null` when the
 * scene is already long enough (or the duration is unknown). EXTEND-ONLY, capped
 * at the SAME ceiling the export reconcile uses so preview (advances at
 * scene.duration) and export (layerContentEnd) agree.
 *
 * Shared by BOTH completion paths — the agent's `get_avatar_status` and the
 * renderer-side reconcile poll — so a renderer-completed avatar gets the exact
 * same scene-fit as an agent-completed one and the two can't drift (the video
 * poller's scene-fit-less completion is the regression this prevents).
 */
export function avatarSceneFitDuration(opts: {
  startAt: number
  realDuration: number | null | undefined
  sceneDuration: number
}): number | null {
  const real = typeof opts.realDuration === 'number' && opts.realDuration > 0 ? opts.realDuration : null
  if (real === null) return null
  const start = Number.isFinite(opts.startAt) ? Number(opts.startAt) : 0
  const needed = Math.min(MAX_EXTENSION_SECONDS, start + real)
  return needed > (Number(opts.sceneDuration) || 0) + 0.05 ? needed : null
}

export function avatarMaxJobDurationMs(): number {
  return AVATAR_MAX_MS
}

/** Deadline (epoch ms) for a render kicked off at `startedAtMs`. */
export function avatarDeadlineFor(startedAtMs: number): number {
  return startedAtMs + AVATAR_MAX_MS
}

/**
 * True once a render started at `startedAtMs` has blown its deadline at `nowMs`.
 * A missing/invalid start time returns false — never time out a job we can't age
 * (legacy layers created before renderStartedAt existed just poll as before).
 */
export function isAvatarExpired(startedAtMs: number | undefined, nowMs: number): boolean {
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return false
  return nowMs >= startedAtMs + AVATAR_MAX_MS
}

/**
 * True once a render has passed its PERSISTED deadline (avatar_videos.deadline_at)
 * at `nowMs`. Inclusive at the deadline (matches the video path's isJobExpired). A
 * missing/invalid deadline returns false — a legacy row with no deadline polls as
 * before, never timed out on data we can't age.
 */
export function isAvatarDeadlinePassed(deadlineAtMs: number | undefined | null, nowMs: number): boolean {
  if (typeof deadlineAtMs !== 'number' || !Number.isFinite(deadlineAtMs)) return false
  return nowMs >= deadlineAtMs
}

/** Human-facing timeout message for an avatar render that blew its deadline. */
export function avatarTimeoutMessage(): string {
  const minutes = Math.round(AVATAR_MAX_MS / 60_000)
  return `Avatar render timed out after ${minutes} minutes — HeyGen never returned a finished video. The layer was marked failed; try regenerating it.`
}
