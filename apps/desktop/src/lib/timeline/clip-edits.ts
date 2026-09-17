/**
 * Shared clip-edit geometry — the single source of truth for slip / slide /
 * roll math and clip adjacency, imported by BOTH the reducer
 * (`src/lib/actions/reducers/clip-reducer.ts`, which commits the edit) AND the
 * timeline UI (`src/components/timeline/TrackRow.tsx`, which previews it per frame).
 *
 * Before this module the formulas lived in two places and were kept in sync by
 * hand (the reducer carried `// Geometry mirrors … TrackRow.tsx` comments) — any
 * drift showed one result during the drag and a different one on release, with
 * no type error to catch it. Keep all trim/speed/adjacency arithmetic here.
 *
 * Pure + framework-free (src/lib/ only) so the reducer can import it without pulling
 * in src/components/. Callers own POLICY (clamp vs reject, MIN-duration bounds); this
 * module owns the GEOMETRY.
 */

import type { Clip } from '@/lib/types'
import type { ClipEditPatch } from '@/lib/actions/types'

/** Minimum clip length in seconds — the one definition in the codebase. */
export const MIN_CLIP_DURATION = 0.1

/** Tolerance for "these two times are the same edit point" (butt-joint test). */
export const ADJACENCY_EPS = 0.001

/** Source out-point implied by a timeline duration: `trimStart + duration*speed`. */
export function trimEndFor(trimStart: number, duration: number, speed: number): number {
  return trimStart + duration * (speed || 1)
}

/** Shift a source in-point by `deltaSec` timeline-seconds (clamped at 0). */
export function shiftTrimStart(trimStart: number, deltaSec: number, speed: number): number {
  return Math.max(0, trimStart + deltaSec * (speed || 1))
}

/**
 * The clip butting `clip`'s `prev` (left) or `next` (right) edge on `clips`,
 * or null. Single definition of "adjacent" so rolling and slide never disagree.
 */
export function findAdjacent(
  clips: readonly Clip[],
  clip: Pick<Clip, 'id' | 'startTime' | 'duration'>,
  edge: 'prev' | 'next',
  eps: number = ADJACENCY_EPS,
): Clip | null {
  const start = clip.startTime
  const end = clip.startTime + clip.duration
  for (const c of clips) {
    if (c.id === clip.id) continue
    if (edge === 'prev' && Math.abs(c.startTime + c.duration - start) < eps) return c
    if (edge === 'next' && Math.abs(c.startTime - end) < eps) return c
  }
  return null
}

/**
 * Slip: shift a clip's source window by `sourceDelta` source-seconds, keeping
 * position + duration fixed. Guards against inverting the source range.
 */
export function slipTrims(
  clip: Pick<Clip, 'trimStart' | 'trimEnd'>,
  sourceDelta: number,
): { trimStart: number; trimEnd: number | null } {
  let trimStart = Math.max(0, clip.trimStart + sourceDelta)
  let trimEnd = clip.trimEnd === null ? null : clip.trimEnd + (trimStart - clip.trimStart)
  if (trimEnd !== null && trimEnd <= trimStart) {
    trimEnd = trimStart + 0.01
    trimStart = Math.max(0, trimEnd - 0.01)
  }
  return { trimStart, trimEnd }
}

/**
 * Trim a clip's head (`'start'`) or tail (`'end'`) to the playhead (the
 * Q / W edits). Returns the partial-clip patch to feed `updateClip`. The caller
 * must guard that the playhead sits strictly inside the clip
 * (`startTime < playhead < startTime + duration`); this routes both edges
 * through `trimEndFor` / `shiftTrimStart` so the resulting `(duration, trimEnd)`
 * pair always satisfies `trimEnd === trimStart + duration*speed` (no divergent
 * MIN-duration floors as the two hand-rolled edges had).
 *
 * - `'start'`: head shaved to the playhead. The clip moves to `playhead`,
 *   `trimStart` advances by the removed source span; `trimEnd` is unchanged
 *   (the out-point doesn't move), preserving the invariant.
 * - `'end'`: tail shaved to the playhead. `duration` shrinks and `trimEnd` is
 *   re-derived from the new duration.
 */
export function trimToPlayhead(
  clip: Pick<Clip, 'startTime' | 'duration' | 'trimStart' | 'speed'>,
  edge: 'start' | 'end',
  playhead: number,
): Partial<Clip> {
  const speed = clip.speed || 1
  if (edge === 'start') {
    // Derive the source actually consumed from the FLOORED duration (not the raw
    // playhead delta) so an extreme head trim that bottoms out at
    // MIN_CLIP_DURATION keeps trimStart in lockstep with duration — the
    // (untouched) trimEnd then still equals trimStart + duration*speed. Without
    // this, the floored case advances trimStart the full distance while duration
    // stops at the floor, over-running the source out-point.
    const newDuration = Math.max(MIN_CLIP_DURATION, clip.duration - (playhead - clip.startTime))
    const consumed = clip.duration - newDuration
    return {
      startTime: clip.startTime + consumed,
      duration: newDuration,
      trimStart: shiftTrimStart(clip.trimStart, consumed, speed),
    }
  }
  const removed = clip.startTime + clip.duration - playhead
  const newDuration = Math.max(MIN_CLIP_DURATION, clip.duration - removed)
  return {
    duration: newDuration,
    trimEnd: trimEndFor(clip.trimStart, newDuration, speed),
  }
}

/**
 * Build the field set for an ⌥-drag (or copy/paste) duplicate of `clip`: strip
 * the identity + grouping fields the copy must not inherit (`id`, `trackId`,
 * `linkGroupId`, `groupId` — a fresh clip isn't bound to the original's A/V
 * link or selection group) and DEEP-CLONE the mutable nested fields
 * (`keyframes`, `filters`, `position`, `scale`, `transition`) so in-place edits
 * on the copy never bleed back into the source via a shared reference. The
 * result is a `addClip`-ready `Omit<Clip, 'id' | 'trackId'>`.
 */
export function cloneForDuplicate(clip: Clip): Omit<Clip, 'id' | 'trackId'> {
  const { id: _id, trackId: _trackId, linkGroupId: _link, groupId: _group, ...rest } = clip
  return {
    ...rest,
    keyframes: structuredClone(rest.keyframes),
    filters: structuredClone(rest.filters),
    position: { ...rest.position },
    scale: { ...rest.scale },
    transition: rest.transition ? { ...rest.transition } : rest.transition,
  }
}

/**
 * Roll the boundary between two butt-jointed clips by `delta` (>0 = later):
 * the left clip grows, the right clip shrinks and its head trims in. Returns
 * the patches for both; bounds-checking (MIN duration) is the caller's job.
 */
export function rollEdits(left: Clip, right: Clip, delta: number): ClipEditPatch[] {
  const newLeftDuration = left.duration + delta
  return [
    { clipId: left.id, duration: newLeftDuration, trimEnd: trimEndFor(left.trimStart, newLeftDuration, left.speed) },
    {
      clipId: right.id,
      startTime: right.startTime + delta,
      duration: right.duration - delta,
      trimStart: shiftTrimStart(right.trimStart, delta, right.speed),
    },
  ]
}

/**
 * Slide a clip by `delta` while its neighbors absorb the move (prev tail / next
 * head trim) so the sequence stays gapless and the same length. Returns patches
 * for the clip plus whichever neighbors exist; bounds-checking is the caller's.
 */
export function slideEdits(clip: Clip, prev: Clip | null, next: Clip | null, delta: number): ClipEditPatch[] {
  const newStart = clip.startTime + delta
  const edits: ClipEditPatch[] = [{ clipId: clip.id, startTime: newStart }]
  if (prev) {
    const prevNewDuration = newStart - prev.startTime
    edits.push({
      clipId: prev.id,
      duration: prevNewDuration,
      trimEnd: trimEndFor(prev.trimStart, prevNewDuration, prev.speed),
    })
  }
  if (next) {
    edits.push({
      clipId: next.id,
      startTime: next.startTime + delta,
      duration: next.duration - delta,
      trimStart: shiftTrimStart(next.trimStart, delta, next.speed),
    })
  }
  return edits
}
