/**
 * Software-owned track naming + default-track selection (NLE track logic).
 *
 * The agent (and UI) must NOT manage track names or pick tracks by hand — that
 * led to custom/duplicate names ("V1-lower", a second "A1") and a new lane spun
 * up on every clip placement. Instead:
 *
 *  - `normalizeTrackNames` re-derives EVERY track's name from its type + rank by
 *    position: video → V1, V2, …; audio → A1, A2, …; (image → I, text → T,
 *    graphics → G, scene → S). Run it after any add/remove/reorder so names are
 *    always sequential, gap-free, and never duplicated.
 *
 *  - `pickTrackForClip` chooses the LOWEST existing track of the right kind that
 *    has free space for [startTime, startTime+duration); returns null when none
 *    fits (caller appends a new lane, then normalizes). This routes clips onto
 *    the default V1/A1 and only spills upward when they genuinely overlap.
 */

import type { Track, TrackType, Clip } from '@/lib/types'

const PREFIX: Record<TrackType, string> = {
  video: 'V',
  audio: 'A',
  image: 'I',
  text: 'T',
  graphics: 'G',
  scene: 'S',
}

/** The bus a track type belongs to for clip routing: video-likes share the visual
 *  lanes, audio is its own. (Scene clips live on video tracks.) */
export function trackPrefix(type: TrackType): string {
  return PREFIX[type] ?? 'T'
}

/**
 * Return a copy of `tracks` with every `name` re-derived as `<prefix><rank>`,
 * where rank is the 1-based index of the track WITHIN ITS TYPE, ordered by
 * `position`. Pure — does not reorder or mutate the input.
 */
export function normalizeTrackNames<T extends Pick<Track, 'type' | 'position' | 'name'>>(tracks: T[]): T[] {
  const rank = new Map<TrackType, number>()
  // Assign ranks in position order so V1 is the lowest video lane, etc.
  const order = tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.position - b.t.position || a.i - b.i)
  const nameById = new Map<number, string>()
  for (const { t, i } of order) {
    const n = (rank.get(t.type) ?? 0) + 1
    rank.set(t.type, n)
    nameById.set(i, `${trackPrefix(t.type)}${n}`)
  }
  return tracks.map((t, i) => ({ ...t, name: nameById.get(i) ?? t.name }))
}

/** Does any clip on `track` overlap the half-open window [start, start+duration)? */
function trackHasOverlap(track: Pick<Track, 'clips'>, start: number, duration: number, epsilon = 0.001): boolean {
  const end = start + duration
  return track.clips.some((c) => {
    const cEnd = c.startTime + c.duration
    return c.startTime < end - epsilon && cEnd > start + epsilon
  })
}

/**
 * Pick the LOWEST (smallest position) non-locked track of `type` with free space
 * for a clip at [startTime, startTime+duration). Returns the track id, or null
 * when every track of that type is occupied there (caller should append a new
 * lane and re-normalize). This is what routes a clip onto the default V1/A1 and
 * only spills to V2/A2 on a real overlap.
 */
export function pickTrackForClip(
  tracks: Track[],
  type: TrackType,
  startTime: number,
  duration: number,
): string | null {
  const candidates = tracks
    .filter((t) => t.type === type && !t.locked)
    .sort((a, b) => a.position - b.position)
  for (const t of candidates) {
    if (!trackHasOverlap(t, startTime, duration)) return t.id
  }
  return null
}

/** The track type a clip of `sourceType` belongs on (scene/video/image/title → visual lane). */
export function trackTypeForSource(sourceType: Clip['sourceType']): TrackType {
  return sourceType === 'audio' ? 'audio' : 'video'
}
