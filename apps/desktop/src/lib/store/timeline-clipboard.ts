/**
 * Pure placement logic for clip paste.
 *
 * The store action (pasteClips) handles id/link/group remapping and the actual
 * mutation; this module owns the math that decides WHERE the pasted clips land
 * so they never overlap existing clips. Kept pure (no store, no Clip type beyond
 * the minimal shape it needs) so it's unit-testable in isolation.
 *
 * Multi-selection invariant: every pasted clip is laid out from a common anchor,
 * so applying ONE shared time-delta to all of them preserves their relative
 * offsets. We search for the smallest-magnitude delta that makes EVERY pasted
 * clip collision-free on its own track, biased toward shifting right (forward in
 * time) the way an NLE inserts after the playhead.
 */

/** A half-open [start, end) occupied range on a track. */
export interface Span {
  start: number
  end: number
}

/** Minimal shape the placer needs from a clip to be positioned. */
export interface PlaceableClip {
  trackId: string
  startTime: number
  duration: number
}

const EPSILON = 0.0001

/** Two half-open spans overlap iff each starts before the other ends. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aEnd - EPSILON > bStart && aStart + EPSILON < bEnd
}

/**
 * Does a clip of `duration` placed at `start` collide with any existing span on
 * the track? Existing spans need not be sorted.
 */
export function collidesOnTrack(start: number, duration: number, existing: Span[]): boolean {
  const end = start + duration
  for (const s of existing) {
    if (overlaps(start, end, s.start, s.end)) return true
  }
  return false
}

/**
 * Candidate shift-deltas that would resolve a single clip's collision with one
 * existing span: land flush before it, or flush after it. Both are returned
 * (relative to the clip's proposed start) so the multi-clip search can consider
 * each as a way to clear that obstacle.
 */
function candidateDeltasFor(proposedStart: number, duration: number, span: Span): number[] {
  const before = span.start - duration - proposedStart // place end flush to span.start
  const after = span.end - proposedStart // place start flush to span.end
  return [before, after]
}

/**
 * Find the single shared time-delta (added to every pasted clip's proposed
 * startTime) that makes ALL pasted clips collision-free on their respective
 * tracks, preserving relative offsets. Picks the delta of smallest magnitude;
 * on a tie, prefers the non-negative (forward) shift. A clip can never start
 * before 0, so any delta that would push a clip negative is rejected.
 *
 * @param clips         pasted clips at their PROPOSED (anchor-relative) positions
 * @param spansByTrack  existing occupied spans per trackId (excludes the pasted clips)
 */
export function resolvePasteDelta(clips: PlaceableClip[], spansByTrack: Map<string, Span[]>): number {
  if (clips.length === 0) return 0

  // Gather candidate deltas: 0 (no shift) plus, for every (clip, colliding span)
  // pair, the deltas that clear that span. The winning delta must clear ALL
  // clips simultaneously, so we test each candidate against the whole set.
  const candidates = new Set<number>([0])
  for (const clip of clips) {
    const spans = spansByTrack.get(clip.trackId) ?? []
    for (const span of spans) {
      for (const d of candidateDeltasFor(clip.startTime, clip.duration, span)) {
        candidates.add(d)
      }
    }
  }

  const valid: number[] = []
  for (const delta of candidates) {
    let ok = true
    for (const clip of clips) {
      const start = clip.startTime + delta
      if (start < -EPSILON) {
        ok = false
        break
      }
      const spans = spansByTrack.get(clip.trackId) ?? []
      if (collidesOnTrack(Math.max(0, start), clip.duration, spans)) {
        ok = false
        break
      }
    }
    if (ok) valid.push(delta)
  }

  if (valid.length === 0) {
    // Degenerate fallback: park the whole group after the furthest existing end
    // across all involved tracks so nothing overlaps. Always collision-free.
    let maxEnd = 0
    for (const clip of clips) {
      for (const s of spansByTrack.get(clip.trackId) ?? []) {
        if (s.end > maxEnd) maxEnd = s.end
      }
    }
    const minStart = Math.min(...clips.map((c) => c.startTime))
    return maxEnd - minStart
  }

  // Smallest magnitude wins; tie → prefer forward (>= 0).
  valid.sort((a, b) => {
    const diff = Math.abs(a) - Math.abs(b)
    if (Math.abs(diff) > EPSILON) return diff
    return b - a // prefer larger (forward) on a tie
  })
  return valid[0]
}
