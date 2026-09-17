/**
 * Avatar/scene timing reconciliation at export.
 *
 * A generated clip's REAL length (HeyGen speech, fal lipsync, Veo) is whatever
 * the provider produced — today the authored `scene.duration` wins
 * unconditionally at export-spec build, so a long avatar take is silently cut
 * off mid-sentence (the offscreen capture stops at `durationSeconds * fps`).
 *
 * This pure helper computes the EFFECTIVE export duration for a scene by
 * applying each media layer's `timingPolicy` (default 'extend-scene'):
 * the scene grows to fit the longest policy-extended clip — including its
 * paired lipsync narration track (`lipsync-<layerId>` SFX), so speech audio is
 * never cut either. 'trim' / 'hold-last-frame' keep the authored duration
 * (hold = the renderer's natural freeze-on-last-frame; named separately so the
 * two can diverge later, e.g. trim gaining a fade-out).
 *
 * Used by the renderer's export-spec assembly (src/lib/store/export-actions.ts) —
 * src/electron/ipc/export-tier3.ts only consumes the reconciled `durationSeconds`.
 * Caption-bundle offsets MUST use the same reconciled durations or cues drift.
 */

import type { AILayer } from '../types/ai-layer'
import type { SFXTrack } from '../types/audio'

export interface ReconcileSceneLike {
  duration: number
  aiLayers?: AILayer[] | null
  audioLayer?: {
    sfx?: SFXTrack[] | null
    startOffset?: number | null
    tts?: { src?: string | null; duration?: number | null } | null
  } | null
}

export interface ReconciledDuration {
  /** Effective export duration in seconds (≥ the authored duration). */
  duration: number
  /** True when a layer's clip extended the scene past its authored length. */
  extended: boolean
  /** The layer that set the final end (null when nothing extended). */
  limitingLayerId: string | null
}

const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null)

/**
 * Extension ceiling (security hardening, review #147): `finite()` rejects
 * non-finite garbage but not magnitude — a corrupt/hostile sceneBlob with
 * `estimatedDuration: 1e12` would otherwise drive an unbounded render (the
 * pixi path has no disk preflight; totalFrames has a floor but no cap). Real
 * generated clips are seconds-to-minutes, so a 30-minute ceiling never clips a
 * legitimate narration; a longer AUTHORED duration still wins (user-typed).
 */
// Shared ceiling for how long an async-media layer may grow a scene. Exported so
// the avatar scene-fit (get_avatar_status) caps `scene.duration` at the SAME value
// the export reconcile does — otherwise preview (advances at scene.duration) and
// export (extends to layerContentEnd) would disagree above the cap.
export const MAX_EXTENSION_SECONDS = 30 * 60

/**
 * Where a media layer's content actually ends inside the scene, or null when
 * it can't extend the scene (not ready, looping, no usable duration, or its
 * policy keeps the authored duration).
 */
function layerContentEnd(layer: AILayer, sfx: SFXTrack[]): number | null {
  if (layer.type === 'avatar') {
    if ((layer.timingPolicy ?? 'extend-scene') !== 'extend-scene') return null
    // Only a clip that actually exists may extend the scene — pre-generation
    // placeholders carry a word-count ESTIMATE in estimatedDuration, and
    // stretching the export to an estimate would bake in dead air.
    if (layer.status !== 'ready' || !layer.videoUrl) return null
    const start = finite(layer.startAt) ?? 0
    const clipSeconds = finite(layer.estimatedDuration)
    const videoEnd = clipSeconds === null ? null : start + clipSeconds
    // The muted avatar <video> is paired with a narration SFX track
    // (`lipsync-<layerId>`, minted by addSFXToScene in
    // src/lib/store/generation-actions.ts) — export mixes the TRACK, so the
    // audible speech end is the one that must fit.
    const paired = sfx.find((t) => t.id === `lipsync-${layer.id}`)
    const pairedSeconds = paired ? finite(paired.duration) : null
    const audioEnd = pairedSeconds === null ? null : (finite(paired!.triggerAt) ?? 0) + pairedSeconds
    if (videoEnd === null && audioEnd === null) return null
    return Math.max(videoEnd ?? 0, audioEnd ?? 0)
  }
  if (layer.type === 'veo3') {
    if ((layer.timingPolicy ?? 'extend-scene') !== 'extend-scene') return null
    if (layer.loop) return null // a looping clip fills any scene length
    if (layer.status !== 'ready' || !layer.videoUrl) return null
    const clipSeconds = finite(layer.duration)
    if (clipSeconds === null) return null
    const rate = finite(layer.playbackRate) ?? 1
    return (finite(layer.startAt) ?? 0) + clipSeconds / rate
  }
  return null
}

export function reconcileSceneExportDuration(scene: ReconcileSceneLike): ReconciledDuration {
  const authored = finite(scene.duration) ?? 0
  const sfx = scene.audioLayer?.sfx ?? []
  const ceiling = Math.max(authored, MAX_EXTENSION_SECONDS)
  let duration = authored
  let limitingLayerId: string | null = null
  for (const layer of scene.aiLayers ?? []) {
    const end = layerContentEnd(layer, sfx)
    if (end === null) continue
    const capped = Math.min(end, ceiling)
    if (capped > duration) {
      duration = capped
      limitingLayerId = layer.id
    }
  }
  // Plain TTS narration is cut the same way an avatar take was: if the voiceover
  // runs longer than the scene, export (-shortest) chops it mid-sentence. Only a
  // real, exportable voice (server `src`) extends — a client-only narration is
  // silent at export, so stretching the scene for it would only bake dead air.
  const tts = scene.audioLayer?.tts
  const ttsSeconds = tts?.src ? finite(tts.duration) : null
  if (ttsSeconds !== null) {
    const ttsEnd = (finite(scene.audioLayer?.startOffset) ?? 0) + ttsSeconds
    const capped = Math.min(ttsEnd, ceiling)
    if (capped > duration) {
      duration = capped
      limitingLayerId = 'narration'
    }
  }
  return { duration, extended: duration > authored, limitingLayerId }
}
