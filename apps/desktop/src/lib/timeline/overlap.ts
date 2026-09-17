/**
 * The one timeline interval-overlap predicate. Before this, the same boolean
 * was written four ways (`<` in the reducer + addClip, `>` in snap-engine, the
 * negated `<=`/`>=` form in syncTimelineFromScenes) — all equivalent today, but
 * a future `<` → `<=` edit in one copy would silently disagree at the
 * touching-edge case. Butt-joined clips (a.end === b.start) do NOT overlap.
 */

/** True iff the half-open ranges [aStart, aEnd) and [bStart, bEnd) overlap. */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** True iff two clips overlap on the timeline (by startTime + duration). */
export function clipsOverlap(
  a: { startTime: number; duration: number },
  b: { startTime: number; duration: number },
): boolean {
  return rangesOverlap(a.startTime, a.startTime + a.duration, b.startTime, b.startTime + b.duration)
}
