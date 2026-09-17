/**
 * program-audio — the standalone timeline audio that the export must render,
 * derived from the timeline the same way the preview engine derives its voices.
 *
 * Scene audio (tts/music/sfx/avatar) is baked into each scene's MP4 by the
 * per-scene mixer, so the export only needs the STANDALONE clips (files dropped
 * on audio tracks; `sourceId` is a media URL) overlaid onto the stitched video.
 * This module is the single place that decides which clips those are and what
 * gain each carries, so preview and export can't disagree about the program mix.
 *
 * Scene-mirror detection: the `aud-`/`tts-`/`mus-`/`avatar-audio:` prefixes are
 * matched by regex, but scene SFX clips carry a BARE `sfx.id` (no prefix). The
 * authoritative scene-mirror id set is the key set of `buildAudioUrlMap(scenes)`
 * — callers pass it as `sceneMirror` so SFX aren't misread as standalone.
 *
 * Pure (no React, no WebAudio): shared by the export arg builder (renderer) and
 * unit tests, and the predicates are imported back into the preview engine so
 * the standalone/scene-mirror split is defined exactly once.
 */

import type { Timeline, Clip, Scene, AvatarLayer } from '@/lib/types'
import type { AudioSettings } from '@/lib/types/audio'
import { evaluateKeyframes } from '@/lib/compositor/interpolate'
import { clamp, clipBaseGain, resolveVoiceGain, MAX_STAGE_GAIN, MAX_VOICE_GAIN } from './mix-math'

/** Scene-mirror clips (sound owned by a scene). The complement is standalone. */
export const SCENE_MIRROR_RE = /^(aud-|tts-|mus-|avatar-audio:)/

/** Avatar voice mirror clips: their voice lives INSIDE the HeyGen video
 *  file (the scene <video> renders muted), and — unlike tts/music/sfx — it is
 *  NOT baked by the per-scene mixer (which reads only audioLayer). So the export
 *  must overlay it via the program-audio bus or the avatar is silent. */
export const AVATAR_AUDIO_RE = /^avatar-audio:/

/** Anything with a `has(id)` lookup — a Set of ids or the scene url-map. */
type MirrorLookup = { has(id: string): boolean }
/** The scene url-map (Set + value lookup) — needed to resolve an avatar-audio
 *  mirror clip's id to the underlying media URL ffmpeg extracts audio from. */
type UrlLookup = MirrorLookup & { get(id: string): string | undefined }

/** A standalone audio clip — a media URL dropped onto an audio track. NOT a
 *  scene-mirror clip (prefix match OR present in the scene url-map, which is
 *  how bare-id SFX clips are caught). */
export function isStandaloneAudioClip(clip: Clip, sceneMirror?: MirrorLookup): boolean {
  if (clip.sourceType !== 'audio') return false
  if (SCENE_MIRROR_RE.test(clip.sourceId)) return false
  if (sceneMirror?.has(clip.sourceId)) return false
  return true
}

/**
 * Does this clip contribute a STANDALONE program-audio source (carries a media URL
 * directly, vs a scene-mirror id the url-map resolves)? True for a media URL on an
 * audio track (A2) AND for any bare VIDEO clip's embedded audio. NOT a pure "has an
 * audio stream" check — a video may be silent; we emit anyway and let ffmpeg's amix
 * no-op the stream-less input (OV-3b/c). Image clips never contribute audio.
 */
export function clipContributesProgramAudio(clip: Clip, sceneMirror?: MirrorLookup): boolean {
  if (clip.sourceType === 'video') return true
  return isStandaloneAudioClip(clip, sceneMirror)
}

/** A scene-mirror audio clip — sound that belongs to a scene (tts/music/sfx/avatar). */
export function isSceneMirrorAudioClip(clip: Clip, sceneMirror?: MirrorLookup): boolean {
  if (clip.sourceType !== 'audio') return false
  return SCENE_MIRROR_RE.test(clip.sourceId) || !!sceneMirror?.has(clip.sourceId)
}

/** One standalone clip in the program mix, with everything FFmpeg needs. */
export interface ProgramAudioClip {
  /** Media URL (clip.sourceId) — resolved to a file by the export. */
  src: string
  /** Timeline position, seconds. */
  startTime: number
  /** Clip length on the timeline, seconds. */
  duration: number
  /** In-point within the source media, seconds. */
  trimStart: number
  /** Playback rate. */
  speed: number
  /** Constant linear gain (clip volume × track fader), used when there's no gain
   *  envelope. Master is applied once on the program bus, not here. */
  gain: number
  /**
   * Volume automation samples in clip-LOCAL seconds (0..duration, after trim +
   * speed), present only when the clip has a `gain` keyframe envelope. `v` is the
   * full per-clip volume at that time (clipVolumeAt × track fader, pre-master),
   * computed with the SAME clipBaseGain the preview uses. Export builds a
   * piecewise-linear `volume` expression from these so fades match preview.
   */
  gainEnvelope?: Array<{ t: number; v: number }>
}

/**
 * The standalone clips to overlay at export, with mute/solo applied (silenced
 * clips are dropped, not emitted at gain 0). Per-clip gain comes from mix-math
 * `resolveVoiceGain` (no second copy of the formula); clips with a gain envelope
 * also carry sampled automation points so the export can reproduce the fade.
 *
 * @param sceneMirror key set / url-map of buildAudioUrlMap(scenes) — excludes
 *   scene SFX (bare ids) and tts/music scene audio from the standalone set, AND
 *   resolves avatar-audio mirror ids to their media URL.
 * @param scenes when provided, avatar voice is included: existing
 *   `avatar-audio:` mirror clips on the timeline ride the overlay, and a READY
 *   avatar layer with NO mirror clip yet (agent-placed, never renderer-synced)
 *   is SYNTHESIZED from the layer.
 */
export function buildProgramAudioClips(
  timeline: Timeline | null | undefined,
  sceneMirror?: MirrorLookup,
  _audioSettings?: Pick<AudioSettings, 'masterVolume'> | null,
  scenes?: Scene[],
  opts?: {
    /**
     * Single-stream export: there are no per-scene
     * MP4s, so scene audio (tts/music/sfx) is NOT baked by mixSceneAudioElectron.
     * Set this so scene-mirror clips also ride the program bus at clip.startTime
     * (resolved to a media file via the url-map). Default false keeps the legacy
     * per-scene-bake behavior (standalone + avatar only) byte-identical.
     */
    includeSceneMirror?: boolean
  },
): ProgramAudioClip[] {
  if (!timeline) return []
  const includeSceneMirror = opts?.includeSceneMirror === true
  // Solo is SCOPED TO THE AUDIO BUS: only a soloed AUDIO track silences other
  // audio. Soloing a VIDEO track is a visual-only action (it affects which video
  // composites — getActiveClips) and must NOT mute the music/voice. A global
  // any-track solo here meant "solo a video clip → all audio goes silent" in
  // preview, mixer, AND export. (Avatar-audio mirrors live on video tracks but
  // are governed by their own inclusion logic below, not this gate.)
  const anySolo = timeline.tracks.some((t) => t.type === 'audio' && t.solo === true)
  const out: ProgramAudioClip[] = []
  // D3: avatar-audio mirror ids already represented by a timeline clip, so the
  // avatar-layer synthesis pass below doesn't double-emit one we already overlaid.
  const seenAvatarAudioIds = new Set<string>()
  // OV-3a: `${src}|${startTime}|${duration}` keys already emitted — de-dupes a file
  // that is both a video clip (embedded audio) and a same-position audio clip.
  const emittedMediaKeys = new Set<string>()
  // Mirror-id → media-URL resolution needs a `.get`, but the param type allows a
  // bare Set ({has} only, which the docstring says callers may pass). Guard so a
  // Set with includeSceneMirror can't throw `urlMap.get is not a function` — it
  // just means those clips stay unresolved (skipped below), never a crash.
  const urlMap =
    sceneMirror && typeof (sceneMirror as Partial<UrlLookup>).get === 'function'
      ? (sceneMirror as UrlLookup)
      : undefined
  // Only HeyGen avatars deliver voice baked into the
  // muted <video> and so NEED the program-audio overlay. Lipsync (Cinema
  // Studio) avatars deliver voice via a SEPARATE `lipsync-<layerId>` SFX that
  // is already baked per-scene by mixSceneAudioElectron — including their
  // `avatar-audio:` mirror here too would play the narration TWICE. Collect
  // those layer ids and exclude them from both the inclusion branch and the avatar-layer synthesis pass.
  const lipsyncVoicedAvatarIds = new Set<string>()
  for (const scene of scenes ?? []) {
    for (const fx of scene.audioLayer?.sfx ?? []) {
      const id = (fx as { id?: string }).id
      if (id && id.startsWith('lipsync-')) lipsyncVoicedAvatarIds.add(id.slice('lipsync-'.length))
    }
  }
  const isLipsyncVoiced = (mirrorId: string) => lipsyncVoicedAvatarIds.has(mirrorId.replace(/^avatar-audio:/, ''))
  for (const track of timeline.tracks) {
    if (track.type !== 'audio' && track.type !== 'video') continue
    if (track.muted) continue
    if (anySolo && !track.solo) continue
    const trackVol = Number.isFinite(track.volume) ? (track.volume as number) : 1
    for (const clip of track.clips) {
      // D3: avatar voice mirror clips are NOT standalone files, but unlike other
      // scene-mirror audio they are NOT baked per-scene — so include them here,
      // resolving the id to the avatar video URL ffmpeg extracts audio from.
      const isAvatarAudio = AVATAR_AUDIO_RE.test(clip.sourceId)
      // Lipsync avatars are voiced by a separate baked SFX — skip their mirror
      // so the narration isn't overlaid on top of the already-baked track.
      if (isAvatarAudio && isLipsyncVoiced(clip.sourceId)) continue
      const isStandalone = isStandaloneAudioClip(clip, sceneMirror)
      // A bare VIDEO clip carries embedded audio (A2). We can't probe for an audio
      // stream here (pure/sync — no ffprobe), so we emit for EVERY video clip and let
      // ffmpeg's amix silently no-op a stream-less input (OV-3b/c). ffmpeg extracts
      // the audio straight from the same file the composite renders.
      const isEmbeddedVideoAudio = clip.sourceType === 'video'
      // Scene audio (tts/music/sfx) is normally excluded — baked per-scene. In
      // single-stream export (includeSceneMirror) nothing is baked, so it joins
      // the bus too, resolved id→file via the url-map below.
      const isSceneMirror =
        !isAvatarAudio && !isStandalone && !isEmbeddedVideoAudio && isSceneMirrorAudioClip(clip, sceneMirror)
      if (!isAvatarAudio && !isStandalone && !isEmbeddedVideoAudio && !(includeSceneMirror && isSceneMirror)) continue
      if (clip.audioMuted) continue // per-clip mute (mirrors clipVolumeAt)
      const opacity = Number.isFinite(clip.opacity) ? clip.opacity : 1
      // Single source of truth for the gain formula (clip × track, gated). A video
      // clip's `opacity` is VISUAL — it must not gate its audio — so embedded video
      // audio uses a full clip gain (the track fader / mute / solo still apply).
      const audioClipGain = isEmbeddedVideoAudio ? 1 : opacity
      const gain = resolveVoiceGain({ clipGain: audioClipGain, trackVolume: trackVol })
      if (gain <= 0 || clip.duration <= 0) continue
      // Standalone clips + embedded video carry a media URL directly; avatar +
      // scene-mirror clips carry an id the url-map resolves to the file ffmpeg reads.
      const src = isStandalone || isEmbeddedVideoAudio ? clip.sourceId : (urlMap?.get(clip.sourceId) ?? '')
      if (!src) continue // unresolvable mirror id (avatar/scene-mirror) — skip, no silent fake
      // OV-3a: de-dupe the SAME file at the SAME timeline position — e.g. a video
      // clip's embedded audio AND a manual audio-track copy of the same file would
      // otherwise overlay twice (+6dB / phasing). Distinct positions stay distinct
      // (a SFX reused at two times is two real sources).
      if (isStandalone || isEmbeddedVideoAudio) {
        // Key on the FULL source identity (file + timeline position + in-point +
        // speed) so only a genuine duplicate collapses; a same-file clip with a
        // different trimStart/speed is a real second source and must survive.
        const dupKey = `${src}|${clip.startTime}|${clip.duration}|${clip.trimStart ?? 0}|${clip.speed ?? 1}`
        if (emittedMediaKeys.has(dupKey)) continue
        emittedMediaKeys.add(dupKey)
      }
      if (isAvatarAudio) seenAvatarAudioIds.add(clip.sourceId)

      // #10: sample the gain envelope so the export can reproduce the fade.
      // Sampled DENSELY (10 Hz) — not just at keyframe times — because
      // evaluateKeyframes honors per-keyframe easing curves and the export
      // lerps linearly between samples; keyframe-only sampling would flatten an
      // eased fade into straight lines. v reuses the preview's clipBaseGain and
      // the same stage clamp the engine's bus applies to the track fader.
      let gainEnvelope: Array<{ t: number; v: number }> | undefined
      const gainKfs = (clip.keyframes ?? []).filter((k) => k.property === 'gain')
      if (gainKfs.length > 0) {
        const boundedTrackVol = clamp(trackVol, 0, MAX_STAGE_GAIN)
        // ≤ ~60 intermediate samples: the export builds a nested-if expression
        // from these, so unbounded density would blow up the filtergraph on
        // long clips while adding nothing audible.
        const step = Math.max(0.1, clip.duration / 60)
        const times = new Set<number>([0, clip.duration])
        for (const k of gainKfs) times.add(clamp(k.time, 0, clip.duration))
        for (let t = step; t < clip.duration; t += step) times.add(Number(t.toFixed(3)))
        gainEnvelope = Array.from(times)
          .sort((a, b) => a - b)
          .map((t) => {
            const env = evaluateKeyframes(gainKfs, 'gain', t, 1) ?? 1
            const v = Math.min(MAX_VOICE_GAIN, clipBaseGain(audioClipGain, env) * boundedTrackVol)
            return { t, v }
          })
      }

      out.push({
        src,
        startTime: Math.max(0, clip.startTime),
        duration: clip.duration,
        trimStart: Math.max(0, clip.trimStart ?? 0),
        speed: clip.speed > 0 ? clip.speed : 1,
        gain,
        gainEnvelope,
      })
    }
  }

  // A READY avatar layer placed by the agent may export before the
  // renderer ever minted its `avatar-audio:` mirror clip — synthesize the
  // overlay clip directly from the layer so its voice is never silently dropped.
  // The src is the same media URL the url-map resolves (the layer's videoUrl); ffmpeg extracts the audio stream from it.
  if (scenes && scenes.length) {
    for (const scene of scenes) {
      for (const layer of scene.aiLayers ?? []) {
        if (layer.type !== 'avatar') continue
        if (layer.status !== 'ready') continue
        const av = layer as AvatarLayer
        if (lipsyncVoicedAvatarIds.has(av.id)) continue // voiced by a separate baked lipsync SFX
        const mirrorId = `avatar-audio:${av.id}`
        if (seenAvatarAudioIds.has(mirrorId)) continue // already overlaid as a timeline clip
        const src = urlMap?.get(mirrorId) ?? av.videoUrl ?? null
        if (!src) continue
        const startTime = Math.max(0, Number(av.startAt) || 0)
        const duration = Number(av.estimatedDuration) || Number(scene.duration) || 0
        if (duration <= 0) continue
        out.push({
          src,
          startTime,
          duration,
          trimStart: 0,
          speed: 1,
          gain: 1,
        })
      }
    }
  }
  return out
}
