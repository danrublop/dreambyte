/**
 * NLE-style link groups for timeline clips.
 *
 * Two or more clips can share the same `linkGroupId`. Move/trim/delete
 * operations on any one of them apply to all members of the group, so
 * an A/V pair behaves as a single selection.
 *
 * Operations sit on top of the timeline data model — no DB or persistence
 * logic here. The store calls these helpers and writes the result back.
 */

import type { Clip, Timeline } from '../types'
import { MIN_CLIP_DURATION } from '@/lib/timeline/clip-edits'

export interface ClipRef {
  clip: Clip
  trackId: string
}

/** Walk every clip on every track. */
export function allClips(timeline: Timeline): ClipRef[] {
  const out: ClipRef[] = []
  for (const t of timeline.tracks) {
    for (const c of t.clips) out.push({ clip: c, trackId: t.id })
  }
  return out
}

/** Find the clip with this id (or null). */
export function findClip(timeline: Timeline, clipId: string): ClipRef | null {
  for (const t of timeline.tracks) {
    for (const c of t.clips) if (c.id === clipId) return { clip: c, trackId: t.id }
  }
  return null
}

/**
 * Return all clip ids in the same link group as `clipId`. Always includes
 * `clipId` itself. If the clip isn't linked, returns just [clipId].
 */
export function linkedClipIds(timeline: Timeline, clipId: string): string[] {
  const me = findClip(timeline, clipId)
  if (!me) return [clipId]
  const groupId = me.clip.linkGroupId
  if (!groupId) return [clipId]
  const ids = new Set<string>()
  for (const { clip } of allClips(timeline)) {
    if (clip.linkGroupId === groupId) ids.add(clip.id)
  }
  if (!ids.has(clipId)) ids.add(clipId)
  return Array.from(ids)
}

/**
 * Apply a startTime delta to all linked clips except `originId` (the
 * driver of the move — it already has its own new position written).
 * Returns updated tracks.
 */
export function shiftLinkedClips(
  timeline: Timeline,
  groupId: string | null | undefined,
  delta: number,
  originId: string,
): Timeline {
  if (!groupId || delta === 0) return timeline
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) =>
        c.linkGroupId === groupId && c.id !== originId ? { ...c, startTime: Math.max(0, c.startTime + delta) } : c,
      ),
    })),
  }
}

/**
 * Apply a duration delta to all linked clips on the trim-affected edge.
 * `edge='left'` shifts startTime + shrinks duration; `edge='right'` only
 * changes duration. Origin is excluded.
 */
export function trimLinkedClips(
  timeline: Timeline,
  groupId: string | null | undefined,
  edge: 'left' | 'right',
  delta: number,
  originId: string,
): Timeline {
  if (!groupId || delta === 0) return timeline
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.linkGroupId !== groupId || c.id === originId) return c
        if (edge === 'right') {
          return { ...c, duration: Math.max(MIN_CLIP_DURATION, c.duration + delta) }
        }
        // Left edge: move start AND shrink/grow duration by the same delta,
        // so the right edge stays put.
        return {
          ...c,
          startTime: Math.max(0, c.startTime + delta),
          duration: Math.max(MIN_CLIP_DURATION, c.duration - delta),
        }
      }),
    })),
  }
}

/** Remove every clip whose linkGroupId matches `groupId`. */
export function removeLinkedClips(timeline: Timeline, groupId: string): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => c.linkGroupId !== groupId),
    })),
  }
}

/** Strip the linkGroupId from every clip in the group. */
export function unlinkGroupInTimeline(timeline: Timeline, groupId: string): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.linkGroupId === groupId ? { ...c, linkGroupId: undefined } : c)),
    })),
  }
}

/** Assign the same linkGroupId to every clip in `clipIds`. */
export function linkClipsInTimeline(timeline: Timeline, clipIds: string[], groupId: string): Timeline {
  const ids = new Set(clipIds)
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (ids.has(c.id) ? { ...c, linkGroupId: groupId } : c)),
    })),
  }
}
