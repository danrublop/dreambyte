/**
 * Scene-audio materializer — the ONE place that decides how a scene's
 * audioLayer becomes timeline clips.
 *
 * `initTimeline` and `syncTimelineFromScenes` both route narration → A1,
 * music → A2, SFX → A3 with the same offsets/durations/labels. The ~80
 * near-identical lines drifted once already (the scenes-sig / orphaned-SFX
 * episode); this module makes the lane rules a pure function so they can't.
 *
 * The materializer returns SPECS (lane + offset-from-scene-start + reuse
 * semantics), not clips: init places specs at the scene's accumulated start
 * with fresh clips, sync places them at the existing scene clip's start and
 * REUSES existing clips by sourceId (preserving clip identity — ids, user
 * trims, gain envelopes — per the spec's `reuse` mode).
 */

import type { Scene } from '@/lib/types'

/**
 * Audio lanes: 'a1' (voice/file), 'a2' (music), and SFX lanes 'a3', 'a4', 'a5'…
 * SFX cascade across the a3+ lanes when they overlap in time — the same "spill
 * to a new track" rule video clips use (V2/V3) — instead of stacking on one
 * track. The numeric suffix ≥3 is the SFX sub-lane (a3 = sub-lane 0).
 */
export type SceneAudioLane = 'a1' | 'a2' | `a${number}`

/** First SFX lane is A3 (A1 = voice, A2 = music). */
export const FIRST_SFX_LANE = 3

/** 0-based SFX sub-lane index: 'a3' → 0, 'a4' → 1, … (NaN-safe → 0). */
export function sfxLaneIndex(lane: SceneAudioLane): number {
  const n = Number(lane.slice(1)) - FIRST_SFX_LANE
  return Number.isInteger(n) && n >= 0 ? n : 0
}

export interface SceneAudioClipSpec {
  lane: SceneAudioLane
  sourceId: string
  label: string
  /** Seconds from the scene clip's start. */
  offset: number
  duration: number
  /** Scene-SFX ownership marker (see timeline-actions for why). */
  linkGroupId?: string
  /**
   * What a sync overrides when it reuses an existing clip with this sourceId:
   * - 'position+duration': track the scene (aud/music/SFX follow scene edits)
   * - 'position': move only — TTS keeps its existing duration on reuse (the
   *   narration length is the narration length; a user trim survives syncs).
   */
  reuse: 'position+duration' | 'position'
}

/** Pure lane rules: scene.audioLayer → clip specs. */
export function materializeSceneAudio(scene: Scene): SceneAudioClipSpec[] {
  const out: SceneAudioClipSpec[] = []
  const al = scene.audioLayer
  if (!al) return out
  const off = Math.max(0, Math.min(scene.duration, al.startOffset ?? 0))

  // A1: file audio.
  // Both narration paths (agent audio-tools, renderer audio-actions) write the
  // narration URL into BOTH al.src AND al.tts.src. When the two point at the
  // SAME url it's one narration, not a file + a narration — emit only the tts
  // spec (it carries the narration semantics: reuse:'position', tts duration).
  // Genuine imported file audio (al.src distinct from any tts.src) still emits.
  const ttsSrc = al.tts?.src?.trim()
  const fileIsNarrationMirror = !!(al.src?.trim() && ttsSrc && al.src.trim() === ttsSrc)
  if (al.enabled && al.src?.trim() && !fileIsNarrationMirror) {
    out.push({
      lane: 'a1',
      sourceId: `aud-${scene.id}`,
      label: 'Audio',
      offset: off,
      duration: Math.max(0.1, scene.duration - off),
      reuse: 'position+duration',
    })
  }

  // A1: TTS narration
  const tts = al.tts
  if (tts && (tts.text?.trim() || tts.src?.trim())) {
    const d =
      tts.duration != null && tts.duration > 0
        ? Math.min(tts.duration, scene.duration - off)
        : Math.max(0.2, scene.duration - off)
    out.push({
      lane: 'a1',
      sourceId: `tts-${scene.id}`,
      label: 'TTS',
      offset: off,
      duration: d,
      reuse: 'position',
    })
  }

  // A2: music
  if (al.music?.src?.trim()) {
    out.push({
      lane: 'a2',
      sourceId: `mus-${scene.id}`,
      label: al.music.name || 'Music',
      offset: off,
      duration: Math.max(0.1, scene.duration - off),
      reuse: 'position+duration',
    })
  }

  // A3+: SFX. Overlapping SFX cascade to new lanes (a3, a4, a5, …) — the same
  // "spill to a free track" rule video clips use — instead of stacking on one
  // track. Greedy minimal interval partition: process SFX in start order and
  // give each the lowest sub-lane whose previous clip has already ended.
  // linkGroupId marks the clip as scene-owned (SFX ids have no aud-/tts-/mus-
  // prefix, so without the marker a deleted SFX is mistaken for user-imported
  // audio and orphaned on sync). Unique per SFX so move/delete stays per-clip.
  const ordered = (al.sfx ?? [])
    .map((sfx, idx) => {
      const at = Math.max(0, Math.min(scene.duration, sfx.triggerAt))
      const duration = Math.max(0.05, Math.min(sfx.duration ?? 0.2, scene.duration - at))
      return { sfx, idx, at, duration }
    })
    .sort((a, b) => a.at - b.at || a.idx - b.idx)

  const laneEnds: number[] = [] // laneEnds[k] = end time of the last clip on SFX sub-lane k
  for (const { sfx, at, duration } of ordered) {
    // EPS so an SFX starting exactly when another ends shares the lane (touching
    // is not overlapping — mirrors findFreeAudioTrack's `start < end` test).
    let lane = laneEnds.findIndex((end) => end <= at + 1e-9)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(at + duration)
    } else {
      laneEnds[lane] = at + duration
    }
    out.push({
      lane: `a${FIRST_SFX_LANE + lane}`,
      sourceId: sfx.id,
      label: sfx.name || 'SFX',
      offset: at,
      duration,
      linkGroupId: `scene-sfx:${scene.id}:${sfx.id}`,
      reuse: 'position+duration',
    })
  }

  return out
}
