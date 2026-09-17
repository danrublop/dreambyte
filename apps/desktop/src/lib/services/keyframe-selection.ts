/**
 * Adaptive keyframe selection (Phase 2, plan §3a).
 *
 * Model-agnostic frame down-selection that maximizes useful information within a
 * fixed frame budget — the lever that lets a small/cheap VLM punch above its
 * weight, and that cuts tokens for cloud VLMs alike (AKS / AdaRD, CVPR-2025).
 *
 * Two modes:
 *   - scene-scored: when candidates carry an ffmpeg scene-change score, prefer
 *     high-novelty frames (scene boundaries) — that's where the content changes.
 *   - uniform: no scores → spread evenly across the clip, always keeping the
 *     first and last frame so the model sees the full arc.
 *
 * Pure + deterministic so the understander stays testable without ffmpeg.
 */

export interface FrameCandidate {
  /** Clip-relative timestamp in seconds. */
  timeSec: number
  /** Optional ffmpeg scene-change score (0..1); higher = bigger visual change. */
  sceneScore?: number
}

/**
 * Pick at most `maxFrames` of the candidates. Returns them in chronological
 * order. `maxFrames <= 0` yields an empty list; fewer candidates than the
 * budget returns all of them (sorted by time).
 */
export function selectKeyframes<T extends FrameCandidate>(candidates: T[], maxFrames: number): T[] {
  if (maxFrames <= 0 || candidates.length === 0) return []
  const byTime = [...candidates].sort((a, b) => a.timeSec - b.timeSec)
  if (byTime.length <= maxFrames) return byTime

  const anyScored = byTime.some((c) => typeof c.sceneScore === 'number')
  if (anyScored) {
    // Keep the highest-novelty frames, but guarantee the first and last so the
    // model always sees the clip's start and end.
    const first = byTime[0]
    const last = byTime[byTime.length - 1]
    const middle = byTime.slice(1, -1)
    const ranked = [...middle].sort((a, b) => (b.sceneScore ?? 0) - (a.sceneScore ?? 0))
    const picked = new Set<T>([first, last])
    for (const c of ranked) {
      if (picked.size >= maxFrames) break
      picked.add(c)
    }
    return [...picked].sort((a, b) => a.timeSec - b.timeSec)
  }

  // Uniform: evenly spaced indices across the full range, inclusive of ends.
  const out: T[] = []
  const step = (byTime.length - 1) / (maxFrames - 1)
  for (let i = 0; i < maxFrames; i++) {
    out.push(byTime[Math.round(i * step)])
  }
  // Round() can collide on adjacent indices for small ranges — dedupe by identity.
  return [...new Set(out)]
}
