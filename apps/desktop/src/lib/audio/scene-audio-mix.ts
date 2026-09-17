/**
 * scene-audio-mix — resolve the timeline mixer controls (per-track volume /
 * mute / solo / pan + project master volume) that apply to a scene's OWN audio
 * (narration / file audio / music / SFX) at export time.
 *
 * Why this exists: scene-owned audio is baked per-scene by the export mixers
 * (`pixi-mp4.renderAudioBlobForScene` and the tier3 `audio-mixer`), which read
 * only `scene.audioLayer`. They never see the timeline, so a track fader / mute /
 * solo / pan or the project master volume the user (or agent) set was silently
 * dropped from the exported MP4 even though the live preview honored it. This
 * module computes that missing factor ONCE in the renderer (where the timeline
 * and audioSettings live, and where global solo is decidable), so both export
 * backends just apply a number + a pan — they don't re-derive mixer math.
 *
 * Lane mapping mirrors `materializeSceneAudio`: narration (`tts-<scene>`) and
 * file audio (`aud-<scene>`) ride lane A1, music (`mus-<scene>`) rides A2, and
 * each SFX (bare id) rides A3. The actual track is found by the clip's sourceId
 * on the live timeline, so a user-reordered timeline still resolves correctly.
 */

import type { Scene, Track } from '@/lib/types'
import { resolveVoiceGain, clamp } from './mix-math'

/** The track-level mix factor for one scene-audio category at export. */
export interface CategoryMix {
  /**
   * `track.volume × project masterVolume`, gated by mute/solo (0 when dropped).
   * Multiply this INTO the category's existing per-bus gain in the backend — it
   * is the factor the per-scene mixers were missing, not a full replacement.
   */
  trackGain: number
  /** Stereo pan of the lane track, -1 (hard left) … +1 (hard right). */
  pan: number
  /** Lane track is muted or solo-excluded → omit the source from the mix. */
  drop: boolean
}

export interface SceneAudioMix {
  /** Narration (TTS), lane A1. */
  tts: CategoryMix
  /** Imported/base file audio (`aud-<scene>`), lane A1. */
  file: CategoryMix
  /** Background music, lane A2. */
  music: CategoryMix
  /** Per-SFX, keyed by the SFX id. Lane A3. */
  sfx: Record<string, CategoryMix>
}

/** The track whose clips include `sourceId`, or undefined if it isn't placed. */
function trackForSource(tracks: Track[], sourceId: string): Track | undefined {
  return tracks.find((t) => t.clips.some((c) => c.sourceId === sourceId))
}

function categoryMix(
  track: Track | undefined,
  clipMuted: boolean,
  masterVolume: number | null | undefined,
  anySolo: boolean,
): CategoryMix {
  // Per-clip mute (`clip.audioMuted`) silences just this clip even when its
  // track isn't muted — the preview engine honors it (clipVolumeAt → 0), so the
  // export must too. Fold it into `muted` so resolveVoiceGain gates to 0 and the
  // source is dropped from the bake.
  const muted = (track?.muted ?? false) || clipMuted
  const solo = track?.solo ?? false
  return {
    // resolveVoiceGain gates (mute / solo-exclusion) then multiplies — with
    // clipGain/busGain at unity it returns exactly track × master (0 if dropped).
    trackGain: resolveVoiceGain({
      clipGain: 1,
      trackVolume: track?.volume,
      masterVolume: masterVolume ?? undefined,
      muted,
      solo,
      anySolo,
    }),
    pan: clamp(track?.pan ?? 0, -1, 1),
    drop: muted || (anySolo && !solo),
  }
}

/**
 * Resolve the effective track-level mix for every audio category a scene owns,
 * against the live timeline `tracks` and the project `masterVolume`. A category
 * whose clip isn't on the timeline resolves to master-only (track unity, not
 * dropped) — the pre-fix behavior, so nothing regresses when audio was never
 * materialized onto a track.
 */
export function resolveSceneAudioMix(
  scene: Scene,
  tracks: Track[],
  masterVolume: number | null | undefined,
): SceneAudioMix {
  const anySolo = tracks.some((t) => t.solo === true)
  const at = (sourceId: string) => {
    const track = trackForSource(tracks, sourceId)
    const clip = track?.clips.find((c) => c.sourceId === sourceId)
    return categoryMix(track, !!clip?.audioMuted, masterVolume, anySolo)
  }
  const sfx: Record<string, CategoryMix> = {}
  for (const fx of scene.audioLayer?.sfx ?? []) sfx[fx.id] = at(fx.id)
  return {
    tts: at(`tts-${scene.id}`),
    file: at(`aud-${scene.id}`),
    music: at(`mus-${scene.id}`),
    sfx,
  }
}
