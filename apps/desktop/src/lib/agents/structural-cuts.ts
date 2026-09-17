/**
 * Pure helpers for the structural-cuts review card (Gap 3.1).
 *
 * Kept out of the React component so the live-re-read + cascade-impact logic is
 * unit-testable without a DOM. The card renders `computeSurvivingCuts(...)`.
 */

import type { StructuralCut } from './types'
import type { Scene, Timeline } from '@/lib/types'
import { makeSceneClipCascadeFilter } from '@/lib/actions/reducers/scene-clip-cascade'

export interface SurvivingCut {
  cut: StructuralCut
  scene: Scene
  /** 1-based position in the live scenes array. */
  position: number
  /** Timeline clips the cascade-safe delete will also remove. */
  clipImpact: number
}

/**
 * Live re-read: drop any proposed cut whose scene no longer EXISTS, and
 * compute each survivor's impact (position + dependent timeline clips) from the
 * CURRENT scenes/timeline — never a frozen snapshot. A scene the user deleted
 * elsewhere falls out of the card; impact is always shown against reality.
 *
 * Scope note: this detects existence, not edits. A scene that was rewritten (so
 * the "redundant" finding is now stale) but kept its id still shows — there is
 * no per-scene revision/hash to compare against (out of scope per the plan).
 * Opt-in selection + the visible scene name/duration are the guard there.
 *
 * Defensively dedups by sceneId so a malformed/legacy persisted proposal can't
 * produce duplicate rows (the emit path already dedups at the source).
 */
export function computeSurvivingCuts(
  proposed: StructuralCut[] | null | undefined,
  scenes: Scene[],
  timeline: Timeline | null | undefined,
): SurvivingCut[] {
  if (!proposed || proposed.length === 0) return []
  const out: SurvivingCut[] = []
  const seen = new Set<string>()
  for (const cut of proposed) {
    if (seen.has(cut.sceneId)) continue // dedup — one row per scene
    const idx = scenes.findIndex((s) => s.id === cut.sceneId)
    if (idx === -1) continue // vanished — drop it
    seen.add(cut.sceneId)
    const scene = scenes[idx]
    let clipImpact = 0
    if (timeline) {
      const isDependent = makeSceneClipCascadeFilter(cut.sceneId, scene)
      for (const track of timeline.tracks) {
        for (const clip of track.clips) if (isDependent(clip)) clipImpact++
      }
    }
    out.push({ cut, scene, position: idx + 1, clipImpact })
  }
  return out
}
