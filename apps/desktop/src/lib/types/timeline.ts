// ── Clip / Track / Timeline (NLE model) ─────────────────────────────────────

export type ClipSourceType = 'scene' | 'video' | 'image' | 'audio' | 'title' | 'avatar'

export interface Keyframe {
  time: number // seconds relative to clip start
  property: string // 'x' | 'y' | 'scaleX' | 'scaleY' | 'opacity' | 'rotation' | 'speed'
  value: number
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | string
}

export interface ClipFilter {
  type: 'blur' | 'brightness' | 'contrast' | 'saturate' | 'grayscale' | 'sepia' | 'hue-rotate' | 'tone-curve'
  /** Scalar amount; for `tone-curve` this is the curve intensity (0..1, 1 = full). */
  value: number
  /**
   * `tone-curve` only: per-channel control points in unit space. `rgb` is the
   * master curve; `r`/`g`/`b` compose after it. Missing channel = identity.
   * See src/lib/edit-engines/tone-curve.ts for evaluation semantics.
   */
  curve?: {
    rgb?: Array<{ x: number; y: number }>
    r?: Array<{ x: number; y: number }>
    g?: Array<{ x: number; y: number }>
    b?: Array<{ x: number; y: number }>
  }
}

export interface Clip {
  id: string
  trackId: string
  sourceType: ClipSourceType
  sourceId: string // scene ID, file path, asset URL, etc.
  label: string
  startTime: number // position on global timeline (seconds)
  duration: number // playback duration after trim+speed
  trimStart: number // source in-point (seconds)
  trimEnd: number | null // source out-point (seconds, null = end)
  speed: number // playback rate (1 = normal)
  opacity: number // 0–1
  position: { x: number; y: number } // offset in pixels (0,0 = top-left)
  scale: { x: number; y: number } // 1,1 = 100%
  rotation: number // degrees
  filters: ClipFilter[]
  /**
   * Clip color grade (lift/gamma/gain wheels, master/RGB + hue curves,
   * .cube LUT, highlights/shadows, levels, vignette). Applied INSIDE the composite
   * step so preview == export. See src/lib/edit-engines/clip-grade.ts (`ClipColorGrade`).
   * Absent / neutral = no grade (zero cost).
   */
  grade?: import('@/lib/edit-engines/clip-grade').ClipColorGrade
  blendMode?: string // normal, multiply, screen, overlay, etc.
  blendOpacity?: number // 0-1 layered onto blendMode; defaults to opacity if unset
  /** Fade-in length in seconds (linear ramp from 0 → opacity over the head). 0 = no fade. */
  fadeIn?: number
  /** Fade-out length in seconds (linear ramp from opacity → 0 at the tail). 0 = no fade. */
  fadeOut?: number
  /** Lock audio pitch when changing playback speed (varispeed off). Audio clips only. */
  lockAudioPitch?: boolean
  keyframes: Keyframe[]
  transition?: {
    type: string // crossfade, wipe, dissolve, etc.
    duration: number // seconds
  } | null
  /**
   * NLE-style link group. Clips sharing the same `linkGroupId`
   * are treated as one selection: moving/trimming/deleting one applies to
   * all. Used for avatar video + its narration audio (same overlay, two
   * tracks). Optional — most clips have no link group.
   */
  linkGroupId?: string
  /**
   * "Group" (Cmd+G) — a looser association than `linkGroupId`.
   * Grouped clips move together as a selection but do NOT propagate
   * trim/duration changes. Authored by the user via Group / Ungroup
   * actions. Independent from link semantics.
   */
  groupId?: string
  /**
   * Per-clip audio gain in linear scale (1.0 = unchanged, 0 = silent).
   * Audio clips use this directly; video clips with embedded audio also
   * honour it during playback/export. Stored as linear so 6 dB = 2.0.
   */
  audioGain?: number
  /**
   * Per-clip mute. Hides only the audio side of an A/V pair (use clip
   * enable for both). Defaults to false.
   */
  audioMuted?: boolean
  /**
   * "Enable" toggle (E key). Disabled clips skip render but
   * stay on the timeline as a placeholder. Defaults to true via absence.
   */
  enabled?: boolean
  /**
   * "Label" colour — a CSS colour used for this clip's block on the
   * timeline instead of the sourceType default. Organisational only; it has
   * no effect on render or export. Absent = the sourceType colour.
   */
  color?: string
}

/**
 * Track kinds. Expanded from the original
 * `video | audio | overlay` to the six explicit kinds the agent and UI
 * need for NLE-class editing. `'overlay'` is the legacy alias kept for
 * back-compat with existing rows; migration `0009_track_type_expansion.sql`
 * rewrites them to `'graphics'`.
 *
 * The `'scene'` kind is the new track type that holds a generated Dreambyte
 * scene as one clip — same data path, just one of many sources. This is
 * the move that makes the agent's existing scene tooling compose with NLE
 * editing.
 */
export type TrackType = 'video' | 'audio' | 'image' | 'text' | 'graphics' | 'scene'

/** Legacy enum, retained so DB read paths can recognise + remap old rows. */
export type LegacyTrackType = TrackType | 'overlay'

/**
 * Overlap rules per track type (locked decision from code-quality findings).
 * `reject` = the validator refuses an overlap. `allow` = clips may sit at
 * the same time on the same track. `warn` = action proceeds with a
 * warning in the result.
 */
export const TRACK_OVERLAP_RULES: Record<TrackType, 'reject' | 'allow' | 'warn'> = {
  video: 'reject',
  image: 'reject',
  graphics: 'reject',
  scene: 'reject',
  audio: 'allow',
  text: 'allow',
}

export interface Track {
  id: string
  name: string
  type: TrackType
  clips: Clip[]
  muted: boolean
  locked: boolean
  position: number // top-to-bottom order in UI (0 = top)
  /** Solo: when any track on the timeline has solo=true, all non-solo tracks are muted in playback. */
  solo?: boolean
  /** Hide: render-time visibility toggle (does not remove clips). */
  hidden?: boolean
  /**
   * Mixer fader gain for this track — a LINEAR multiplier (1.0 = unity = 0 dB),
   * 0..2 (+6 dB ceiling). `undefined` means unity. Only meaningful for audio
   * (and video, whose linked audio rides the same fader). The mixer reads/writes
   * this via the track/setVolume reducer; the engine folds it into the voice
   * gain via mix-math `resolveVoiceGain`.
   */
  volume?: number
  /** Stereo pan, -1 (hard left) … 0 (center) … +1 (hard right). `undefined` = center. */
  pan?: number
}

/**
 * A point of interest on the timeline ruler. Used as a navigation aid and
 * a snap target. Mirrors NLE sequence markers.
 */
export interface TimelineMarker {
  id: string
  time: number
  /** Optional label rendered next to the glyph. */
  label?: string
  /** Hex color; defaults to the accent. */
  color?: string
}

export interface Timeline {
  tracks: Track[]
  markers?: TimelineMarker[]
  /** Sequence "in" point — start of the work area used for play in/out
   * and (later) three-point edits. `undefined` means no mark. */
  inPoint?: number
  /** Sequence "out" point — end of the work area. `undefined` = none. */
  outPoint?: number
}
