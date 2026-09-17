import type { Timeline, Clip, Track, ClipSourceType, TrackType } from '@/lib/types'

/**
 * Timeline-authoritative sequence derivation (see docs/TIMELINE_AUTHORITATIVE.md).
 *
 * Playback order is owned by the V1 video track, NOT by `scenes[]` array order.
 * These helpers read the timeline so preview, export, and "scene N of M" all
 * agree on one source of truth. Gaps are first-class: a hole between two scene
 * clips is real empty time (rendered black + silent downstream).
 */

/** The lowest-position video track — the V1 sequence. */
export function getV1Track(timeline: Timeline | null | undefined) {
  if (!timeline) return null
  return (
    timeline.tracks
      .slice()
      .sort((a, b) => a.position - b.position)
      .find((t) => t.type === 'video') ?? null
  )
}

/** Scene clips on V1, sorted left-to-right by startTime (the playback sequence). */
export function getSequenceClips(timeline: Timeline | null | undefined): Clip[] {
  const v1 = getV1Track(timeline)
  if (!v1) return []
  return v1.clips
    .filter((c) => c.sourceType === 'scene')
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
}

/** Ordered scene ids as they play on the timeline (left-to-right by startTime). */
export function getSequenceOrder(timeline: Timeline | null | undefined): string[] {
  return getSequenceClips(timeline).map((c) => c.sourceId)
}

/**
 * The PLAYBACK sequence of scene clips: the V1 spine PLUS non-overlapping scene
 * clips from higher video tracks (V2 "gap-fillers" that sit in a V1 hole), as a
 * single monotonic, left-to-right order. This is what the preview advances through
 * AND what a fade crossfade's "next clip" is taken from — so preview and export
 * must agree on it. Extracted from PreviewPlayer's `getV1SceneClips` (was duplicated
 * there) so `applyFadeTransition` (export) and the preview pick the SAME incoming
 * clip. Differs from {@link getSequenceClips} (V1-only) only when a higher track
 * carries a non-overlapping scene clip.
 *
 * Sort: by startTime, then higher track-position first on a tie (a V2 clip butted
 * exactly at a V1 clip's start renders over it, matching getActiveClips z-order).
 */
export function getPlaybackSequenceClips(timeline: Timeline | null | undefined): Clip[] {
  if (!timeline) return []
  const videoTracks = timeline.tracks.filter((t) => t.type === 'video')
  if (videoTracks.length === 0) return []
  const trackPos = new Map(videoTracks.map((t) => [t.id, t.position]))
  const v1Pos = Math.min(...videoTracks.map((t) => t.position))
  const all = videoTracks.flatMap((t) => t.clips).filter((c) => c.sourceType === 'scene')
  const v1Clips = all.filter((c) => trackPos.get(c.trackId) === v1Pos)
  const overlapsV1 = (c: Clip) =>
    v1Clips.some((v) => v !== c && c.startTime < v.startTime + v.duration && v.startTime < c.startTime + c.duration)
  return all
    .filter((c) => trackPos.get(c.trackId) === v1Pos || !overlapsV1(c))
    .sort((a, b) => a.startTime - b.startTime || (trackPos.get(b.trackId) ?? 0) - (trackPos.get(a.trackId) ?? 0))
}

export interface SequenceSegment {
  /** 'scene' segments reference a scene clip; 'gap' segments are empty time. */
  kind: 'scene' | 'gap'
  startTime: number
  duration: number
  /** Present on 'scene' segments: the referenced scene id and its clip. */
  sceneId?: string
  clip?: Clip
}

/**
 * The full V1 timeline as an ordered list of segments, with explicit GAP
 * segments inserted wherever there is empty time between scene clips (or before
 * the first clip). This is the timeline-authoritative playback/export model:
 * total duration INCLUDES gaps, and gap segments render black + silent.
 *
 * `epsilon` ignores sub-frame slivers so floating-point butt-joins don't emit
 * spurious 0.0001s gaps.
 */
export function getSequenceSegments(
  timeline: Timeline | null | undefined,
  epsilon = 0.001,
): SequenceSegment[] {
  const clips = getSequenceClips(timeline)
  const segments: SequenceSegment[] = []
  let cursor = 0
  for (const clip of clips) {
    if (clip.startTime - cursor > epsilon) {
      segments.push({ kind: 'gap', startTime: cursor, duration: clip.startTime - cursor })
    }
    const start = Math.max(clip.startTime, cursor)
    segments.push({ kind: 'scene', startTime: start, duration: clip.duration, sceneId: clip.sourceId, clip })
    cursor = Math.max(cursor, clip.startTime + clip.duration)
  }
  return segments
}

/** Total V1 timeline duration including trailing-edge gaps (last clip end). */
export function getSequenceDuration(timeline: Timeline | null | undefined): number {
  const clips = getSequenceClips(timeline)
  return clips.reduce((max, c) => Math.max(max, c.startTime + (Number.isFinite(c.duration) ? c.duration : 0)), 0)
}

/**
 * Total composite duration: the last end across ALL video tracks' scene clips,
 * not just V1. The single-stream export walks [0, this) — a V2 clip extending
 * past the V1 spine (or a trailing gap under it) must be included or the export
 * truncates content the preview shows. Spans video tracks only (audio length is
 * handled by the program-audio bus).
 */
export function getCompositeDuration(timeline: Timeline | null | undefined): number {
  if (!timeline) return 0
  let max = 0
  for (const track of timeline.tracks) {
    if (track.type !== 'video') continue
    for (const clip of track.clips) {
      // Composite-renderable visual clips: scenes (iframes) + bare media (video/image).
      // OV-5: media-only timelines (footage, no scenes) must report a real duration or
      // the export would see 0 frames and bail. Title clips are not composited.
      if (clip.sourceType !== 'scene' && clip.sourceType !== 'video' && clip.sourceType !== 'image') continue
      const dur = Number.isFinite(clip.duration) ? clip.duration : 0
      const end = clip.startTime + dur
      if (end > max) max = end
    }
  }
  return max
}

/** One clip active at a moment in time, with its track and composite z-base. */
export interface ActiveClip {
  clip: Clip
  track: Track
  /** Z-stack base: higher = composited on top. Mirrors the Pixi compositor:
   *  `(sortedIndex + 1) * 100`, where tracks are sorted ascending by position,
   *  so a higher-position lane (V2 over V1) wins. */
  trackZBase: number
}

export interface ActiveClipsOpts {
  /** Restrict to these clip source types (e.g. 'scene' for the iframe preview,
   *  ['video','image'] for the Pixi compositor). Omit = all source types. */
  sourceType?: ClipSourceType | ClipSourceType[]
  /** Restrict to one track type (e.g. 'video'). Omit = all track types. */
  trackType?: TrackType
}

/**
 * Every clip active at global time `t`, across ALL tracks, in composite z-order.
 *
 * This is the single source of truth for "what is visible at time T" — extracted
 * from the Pixi compositor's inline collection loop (src/lib/compositor/pixi-preview.ts)
 * so the iframe preview, the Pixi compositor, and export all agree. Honors
 * muted / hidden tracks and solo semantics (any soloed track hides every
 * non-solo track), exactly as the compositor did. A clip is active when
 * `t ∈ [startTime, startTime + duration)`.
 *
 * The returned `trackZBase` uses the FULL sorted-track index (not the filtered
 * index), so filtering by `sourceType`/`trackType` never changes the z-order a
 * clip would have had in the full composite.
 */
export function getActiveClips(
  timeline: Timeline | null | undefined,
  t: number,
  opts?: ActiveClipsOpts,
): ActiveClip[] {
  if (!timeline) return []
  const sortedTracks = [...timeline.tracks].sort((a, b) => a.position - b.position)
  // Solo is SCOPED TO THE VISUAL BUS here: only a soloed NON-audio track hides
  // other video/scene tracks. Soloing an AUDIO track is an audio-only action and
  // must not blank the picture (its mirror is the audio bus's own solo scope in
  // buildProgramAudioClips). A global any-track solo cross-contaminated the buses.
  const anyTrackSoloed = sortedTracks.some((tr) => tr.type !== 'audio' && tr.solo === true)
  const wantSource =
    opts?.sourceType == null ? null : Array.isArray(opts.sourceType) ? opts.sourceType : [opts.sourceType]

  const out: ActiveClip[] = []
  for (let ti = 0; ti < sortedTracks.length; ti++) {
    const track = sortedTracks[ti]
    if (track.muted) continue
    if (track.hidden) continue
    if (anyTrackSoloed && !track.solo) continue
    if (opts?.trackType && track.type !== opts.trackType) continue
    for (const clip of track.clips) {
      if (wantSource && !wantSource.includes(clip.sourceType)) continue
      const clipEnd = clip.startTime + clip.duration
      if (t >= clip.startTime && t < clipEnd) {
        out.push({ clip, track, trackZBase: (ti + 1) * 100 })
      }
    }
  }
  return out
}

/**
 * The single TOP-MOST clip active at time `t` (highest z-base wins), or null in
 * a true gap (nothing active under the given filter). This is the clip-centric
 * replacement for the old `clips.find(c => c.sourceId === sceneId)` lookups: it
 * resolves the visible clip by TIME, so a split half plays its own trim range
 * instead of collapsing onto the first clip that shares a sourceId.
 */
export function findActiveClip(
  timeline: Timeline | null | undefined,
  t: number,
  opts?: ActiveClipsOpts,
): ActiveClip | null {
  const active = getActiveClips(timeline, t, opts)
  if (active.length === 0) return null
  return active.reduce((top, a) => (a.trackZBase > top.trackZBase ? a : top))
}
