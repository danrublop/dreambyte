/**
 * Clip reducer.
 *
 * Pure (state, action) → ActionResult for the 5 clip primitives:
 *   - clip/add
 *   - clip/move
 *   - clip/trim
 *   - clip/split  ← redistributes keyframes per the code-quality finding
 *   - clip/rippleDelete
 *
 * Per-track-type overlap rules come from `TRACK_OVERLAP_RULES` in
 * `src/lib/types/timeline.ts`. Video / image / graphics / scene tracks reject
 * overlap; audio / text allow it.
 */

import type {
  Action,
  ActionResult,
  ProjectState,
  ClipAddAction,
  ClipMoveAction,
  ClipBatchMoveAction,
  ClipBatchEditAction,
  ClipEditPatch,
  ClipRollAction,
  ClipSlideAction,
  ClipSlipAction,
  ClipTrimAction,
  ClipSplitAction,
  ClipRippleDeleteAction,
  ClipRemoveAction,
  AgentApplyRunAction,
} from '../types'
import type { Clip, Keyframe, Timeline, Track } from '@/lib/types'
import { TRACK_OVERLAP_RULES } from '@/lib/types'
import { validateId, validateRange } from '../validators/_shared'
import { linkedClipIds, removeLinkedClips } from '@/lib/store/link-groups'
import { cascadeClipSourceMutations, makeSceneClipCascadeFilter } from './scene-clip-cascade'
import { MIN_CLIP_DURATION, findAdjacent, rollEdits, slideEdits, slipTrims } from '@/lib/timeline/clip-edits'
import { clipsOverlap } from '@/lib/timeline/overlap'

function ensureTimeline(state: ProjectState): Timeline {
  return state.project.timeline ?? { tracks: [] }
}

function withTimeline(state: ProjectState, timeline: Timeline): ProjectState {
  return {
    ...state,
    project: {
      ...state.project,
      timeline,
      updatedAt: new Date().toISOString(),
    },
  }
}

function findClip(timeline: Timeline, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of timeline.tracks) {
    const i = track.clips.findIndex((c) => c.id === clipId)
    if (i !== -1) return { track, clip: track.clips[i], index: i }
  }
  return null
}

function detectOverlap(track: Track, candidate: Clip, ignoreClipId?: string): Clip | null {
  for (const other of track.clips) {
    if (other.id === candidate.id || other.id === ignoreClipId) continue
    if (clipsOverlap(other, candidate)) return other
  }
  return null
}

function mapTrack(timeline: Timeline, trackId: string, fn: (t: Track) => Track): Timeline {
  return { ...timeline, tracks: timeline.tracks.map((t) => (t.id === trackId ? fn(t) : t)) }
}

export function reduceClipAdd(state: ProjectState, action: ClipAddAction): ActionResult {
  const { trackId, clipId, clip, position } = action.params

  const trackIdErr = validateId(trackId, 'trackId')
  if (trackIdErr) return { success: false, error: trackIdErr }
  const clipIdErr = validateId(clipId, 'clipId')
  if (clipIdErr) return { success: false, error: clipIdErr }
  if (clip.id !== clipId) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'clip.id must match params.clipId' } }
  }

  const timeline = ensureTimeline(state)
  const track = timeline.tracks.find((t) => t.id === trackId)
  if (!track) return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${trackId} not found` } }
  if (track.locked) return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${trackId} is locked` } }
  if (track.clips.some((c) => c.id === clipId)) {
    return { success: false, error: { code: 'DUPLICATE_ID', message: `Clip ${clipId} already exists` } }
  }

  // Per-track-type overlap rule (table from src/lib/types/timeline.ts).
  if (TRACK_OVERLAP_RULES[track.type] === 'reject') {
    const conflict = detectOverlap(track, { ...clip, trackId })
    if (conflict) {
      return {
        success: false,
        error: {
          code: 'OVERLAP_DETECTED',
          message: `Clip would overlap clip "${conflict.label || conflict.id}" on track "${track.name}"`,
          details: { conflictingClipId: conflict.id },
        },
      }
    }
  }

  if (typeof position === 'number') {
    const r = validateRange(position, 0, track.clips.length, 'position')
    if (r) return { success: false, error: r }
  }
  const idx = typeof position === 'number' ? position : track.clips.length
  const inserted: Clip = { ...clip, trackId }
  const newClips = [...track.clips.slice(0, idx), inserted, ...track.clips.slice(idx)]
  const newTimeline = mapTrack(timeline, trackId, (t) => ({ ...t, clips: newClips }))

  return {
    success: true,
    state: withTimeline(state, newTimeline),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/rippleDelete',
      params: { clipId, prior: { clip: inserted, index: idx, shifts: [] } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceClipMove(state: ProjectState, action: ClipMoveAction): ActionResult {
  const { clipId, startTime, newTrackId } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime < 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'startTime must be a non-negative number' } }
  }

  const timeline = ensureTimeline(state)
  const found = findClip(timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  let destTrack = found.track
  if (newTrackId && newTrackId !== found.track.id) {
    const dest = timeline.tracks.find((t) => t.id === newTrackId)
    if (!dest) return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${newTrackId} not found` } }
    if (dest.locked)
      return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${newTrackId} is locked` } }
    destTrack = dest
  }

  const candidate: Clip = { ...found.clip, startTime, trackId: destTrack.id }
  if (TRACK_OVERLAP_RULES[destTrack.type] === 'reject') {
    const conflict = detectOverlap(destTrack, candidate, candidate.id)
    if (conflict) {
      return {
        success: false,
        error: {
          code: 'OVERLAP_DETECTED',
          message: `Move would overlap clip "${conflict.label || conflict.id}"`,
          details: { conflictingClipId: conflict.id },
        },
      }
    }
  }

  let newTimeline: Timeline
  if (destTrack.id === found.track.id) {
    newTimeline = mapTrack(timeline, destTrack.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? candidate : c)),
    }))
  } else {
    // Cross-track move: remove from old, append to new.
    newTimeline = mapTrack(timeline, found.track.id, (t) => ({
      ...t,
      clips: t.clips.filter((c) => c.id !== clipId),
    }))
    newTimeline = mapTrack(newTimeline, destTrack.id, (t) => ({ ...t, clips: [...t.clips, candidate] }))
  }

  return {
    success: true,
    state: withTimeline(state, newTimeline),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/move',
      params: {
        clipId,
        startTime: found.clip.startTime,
        newTrackId: found.track.id,
        prior: { startTime, trackId: destTrack.id },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/**
 * clip/batchMove — move N clips atomically.
 *
 * Used by multi-select drag, Alt-arrow nudge, and linked/grouped co-movement.
 * Validation is all-or-nothing: the final timeline is assembled (every moved
 * clip removed from its source track, re-added to its dest track at the new
 * start), then each moved clip is checked for overlap on its dest `reject`
 * track — catching moved-vs-stationary AND moved-vs-moved collisions. Any
 * conflict refuses the WHOLE batch so the timeline never half-applies. The
 * single inverse restores every clip's prior (startTime, trackId).
 */
export function reduceClipBatchMove(state: ProjectState, action: ClipBatchMoveAction): ActionResult {
  const { moves } = action.params
  if (!Array.isArray(moves) || moves.length === 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'moves must be a non-empty array' } }
  }

  const seen = new Set<string>()
  for (const m of moves) {
    const idErr = validateId(m.clipId, 'clipId')
    if (idErr) return { success: false, error: idErr }
    if (seen.has(m.clipId)) {
      return { success: false, error: { code: 'INVALID_PARAMS', message: `Duplicate clipId "${m.clipId}" in batch` } }
    }
    seen.add(m.clipId)
    if (typeof m.startTime !== 'number' || !Number.isFinite(m.startTime) || m.startTime < 0) {
      return { success: false, error: { code: 'INVALID_PARAMS', message: 'startTime must be a non-negative number' } }
    }
  }

  const timeline = ensureTimeline(state)

  // Locate every clip + resolve its dest track; validate locks up front.
  const prior: Array<{ clipId: string; startTime: number; trackId: string }> = []
  const targets: Array<{ clip: Clip; destTrackId: string; startTime: number }> = []
  for (const m of moves) {
    const found = findClip(timeline, m.clipId)
    if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${m.clipId} not found` } }
    if (found.track.locked) {
      return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
    }
    let destTrackId = found.track.id
    if (m.newTrackId && m.newTrackId !== found.track.id) {
      const dest = timeline.tracks.find((t) => t.id === m.newTrackId)
      if (!dest)
        return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${m.newTrackId} not found` } }
      if (dest.locked) {
        return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${m.newTrackId} is locked` } }
      }
      destTrackId = dest.id
    }
    prior.push({ clipId: m.clipId, startTime: found.clip.startTime, trackId: found.track.id })
    targets.push({ clip: found.clip, destTrackId, startTime: m.startTime })
  }

  // Assemble the final timeline: drop all moved clips from their source tracks,
  // then re-add each at its new (startTime, destTrack).
  const nextTracks: Track[] = timeline.tracks.map((t) => ({
    ...t,
    clips: t.clips.filter((c) => !seen.has(c.id)),
  }))
  const trackIndex = new Map(nextTracks.map((t, i) => [t.id, i]))
  for (const tg of targets) {
    const idx = trackIndex.get(tg.destTrackId)
    if (idx === undefined) {
      return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${tg.destTrackId} not found` } }
    }
    const moved: Clip = { ...tg.clip, startTime: tg.startTime, trackId: tg.destTrackId }
    nextTracks[idx] = { ...nextTracks[idx], clips: [...nextTracks[idx].clips, moved] }
  }

  // All-or-nothing overlap check: each moved clip vs everything else on its
  // dest reject-track (detectOverlap skips the clip itself, so other moved
  // clips that landed on the same track are still checked).
  for (const tg of targets) {
    const idx = trackIndex.get(tg.destTrackId)!
    const track = nextTracks[idx]
    if (TRACK_OVERLAP_RULES[track.type] !== 'reject') continue
    const moved = track.clips.find((c) => c.id === tg.clip.id)!
    const conflict = detectOverlap(track, moved)
    if (conflict) {
      return {
        success: false,
        error: {
          code: 'OVERLAP_DETECTED',
          message: `Batch move would overlap clip "${conflict.label || conflict.id}" on track "${track.name}"`,
          details: { conflictingClipId: conflict.id },
        },
      }
    }
  }

  return {
    success: true,
    state: withTimeline(state, { ...timeline, tracks: nextTracks }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/batchMove',
      params: {
        moves: prior.map((p) => ({ clipId: p.clipId, startTime: p.startTime, newTrackId: p.trackId })),
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceClipTrim(state: ProjectState, action: ClipTrimAction): ActionResult {
  const { clipId, trimStart, trimEnd, duration } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }

  const timeline = ensureTimeline(state)
  const found = findClip(timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const nextTrimStart = trimStart ?? found.clip.trimStart
  const nextTrimEnd = trimEnd !== undefined ? trimEnd : found.clip.trimEnd
  const nextDuration = duration ?? found.clip.duration

  if (nextDuration <= 0) {
    return {
      success: false,
      error: { code: 'INVALID_TIME_RANGE', message: 'duration must be > 0' },
    }
  }
  if (nextTrimStart < 0) {
    return { success: false, error: { code: 'INVALID_TIME_RANGE', message: 'trimStart must be >= 0' } }
  }
  if (nextTrimEnd !== null && nextTrimEnd <= nextTrimStart) {
    return {
      success: false,
      error: { code: 'INVALID_TIME_RANGE', message: 'trimEnd must be > trimStart' },
    }
  }

  const updated: Clip = {
    ...found.clip,
    trimStart: nextTrimStart,
    trimEnd: nextTrimEnd,
    duration: nextDuration,
  }

  if (TRACK_OVERLAP_RULES[found.track.type] === 'reject') {
    const conflict = detectOverlap(found.track, updated, updated.id)
    if (conflict) {
      return {
        success: false,
        error: {
          code: 'OVERLAP_DETECTED',
          message: `Trim would overlap clip "${conflict.label || conflict.id}"`,
          details: { conflictingClipId: conflict.id },
        },
      }
    }
  }

  return {
    success: true,
    state: withTimeline(
      state,
      mapTrack(timeline, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? updated : c)),
      })),
    ),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/trim',
      params: {
        clipId,
        trimStart: found.clip.trimStart,
        trimEnd: found.clip.trimEnd,
        duration: found.clip.duration,
        prior: { trimStart: nextTrimStart, trimEnd: nextTrimEnd, duration: nextDuration },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/**
 * Shared all-or-nothing core for in-place multi-clip edits (clip/batchEdit and
 * the slip/slide/roll semantic actions). Applies `{startTime,duration,trimStart,
 * trimEnd}` patches to N clips on their existing tracks, validates each field,
 * then refuses the WHOLE batch if any edited clip overlaps on a `reject` track.
 * The combined inverse is a `clip/batchEdit` that restores every clip's prior
 * full tuple — so slip/slide/roll all undo in one step with exact restoration.
 */
function applyClipEdits(state: ProjectState, patches: ClipEditPatch[], action: Action): ActionResult {
  if (!Array.isArray(patches) || patches.length === 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'edits must be a non-empty array' } }
  }
  const timeline = ensureTimeline(state)
  const seen = new Set<string>()
  const priors: ClipEditPatch[] = []
  const updatedByTrack = new Map<string, Map<string, Clip>>()

  for (const p of patches) {
    const idErr = validateId(p.clipId, 'clipId')
    if (idErr) return { success: false, error: idErr }
    if (seen.has(p.clipId)) {
      return { success: false, error: { code: 'INVALID_PARAMS', message: `Duplicate clipId "${p.clipId}" in edits` } }
    }
    seen.add(p.clipId)

    const found = findClip(timeline, p.clipId)
    if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${p.clipId} not found` } }
    if (found.track.locked) {
      return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
    }
    const c = found.clip
    const startTime = p.startTime ?? c.startTime
    const duration = p.duration ?? c.duration
    const trimStart = p.trimStart ?? c.trimStart
    const trimEnd = p.trimEnd !== undefined ? p.trimEnd : c.trimEnd

    if (!Number.isFinite(startTime) || startTime < 0) {
      return { success: false, error: { code: 'INVALID_TIME_RANGE', message: 'startTime must be >= 0' } }
    }
    if (!(duration > 0)) {
      return { success: false, error: { code: 'INVALID_TIME_RANGE', message: 'duration must be > 0' } }
    }
    if (trimStart < 0) {
      return { success: false, error: { code: 'INVALID_TIME_RANGE', message: 'trimStart must be >= 0' } }
    }
    if (trimEnd !== null && trimEnd <= trimStart) {
      return { success: false, error: { code: 'INVALID_TIME_RANGE', message: 'trimEnd must be > trimStart' } }
    }

    priors.push({
      clipId: c.id,
      startTime: c.startTime,
      duration: c.duration,
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
    })
    if (!updatedByTrack.has(found.track.id)) updatedByTrack.set(found.track.id, new Map())
    updatedByTrack.get(found.track.id)!.set(c.id, { ...c, startTime, duration, trimStart, trimEnd })
  }

  const nextTracks = timeline.tracks.map((t) => {
    const ups = updatedByTrack.get(t.id)
    if (!ups) return t
    return { ...t, clips: t.clips.map((c) => ups.get(c.id) ?? c) }
  })

  for (const t of nextTracks) {
    const ups = updatedByTrack.get(t.id)
    if (!ups || TRACK_OVERLAP_RULES[t.type] !== 'reject') continue
    for (const updated of ups.values()) {
      const conflict = detectOverlap(t, updated)
      if (conflict) {
        return {
          success: false,
          error: {
            code: 'OVERLAP_DETECTED',
            message: `Edit would overlap clip "${conflict.label || conflict.id}" on track "${t.name}"`,
            details: { conflictingClipId: conflict.id },
          },
        }
      }
    }
  }

  return {
    success: true,
    state: withTimeline(state, { ...timeline, tracks: nextTracks }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/batchEdit',
      params: { edits: priors },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/** clip/batchEdit — apply arbitrary in-place patches to N clips atomically. */
export function reduceClipBatchEdit(state: ProjectState, action: ClipBatchEditAction): ActionResult {
  return applyClipEdits(state, action.params.edits, action)
}

/**
 * clip/roll — move the shared edit point between two butt-jointed clips.
 * `delta` > 0 moves the boundary later: the left clip grows, the right clip
 * shrinks and its head trims in. Total sequence duration is unchanged.
 * Geometry mirrors the rolling-trim path in `TrackRow.tsx`.
 */
export function reduceClipRoll(state: ProjectState, action: ClipRollAction): ActionResult {
  const { clipId, edge, delta } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  if (edge !== 'left' && edge !== 'right') {
    return { success: false, error: { code: 'INVALID_PARAMS', message: "edge must be 'left' or 'right'" } }
  }
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'delta must be a finite number' } }
  }

  const timeline = ensureTimeline(state)
  const found = findClip(timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  const clip = found.clip

  // (left, right) = the two clips sharing the edit point being rolled.
  let left: Clip
  let right: Clip
  if (edge === 'right') {
    const next = findAdjacent(found.track.clips, clip, 'next')
    if (!next) return { success: false, error: { code: 'INVALID_PARAMS', message: 'No adjacent clip to roll against' } }
    left = clip
    right = next
  } else {
    const prev = findAdjacent(found.track.clips, clip, 'prev')
    if (!prev) return { success: false, error: { code: 'INVALID_PARAMS', message: 'No adjacent clip to roll against' } }
    left = prev
    right = clip
  }

  if (
    left.duration + delta < MIN_CLIP_DURATION ||
    right.duration - delta < MIN_CLIP_DURATION ||
    right.startTime + delta < 0
  ) {
    return {
      success: false,
      error: { code: 'INVALID_TIME_RANGE', message: 'Roll would collapse a clip below the minimum duration' },
    }
  }

  return applyClipEdits(state, rollEdits(left, right, delta), action)
}

/**
 * clip/slide — shift a clip by `delta` while its two neighbors absorb the move
 * (the previous clip's tail and the next clip's head trim to keep the sequence
 * gapless and the same total length). The slid clip's own content is unchanged.
 * Geometry mirrors the slide-tool path in `TrackRow.tsx`.
 */
export function reduceClipSlide(state: ProjectState, action: ClipSlideAction): ActionResult {
  const { clipId, delta } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'delta must be a finite number' } }
  }

  const timeline = ensureTimeline(state)
  const found = findClip(timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  const clip = found.clip
  if (clip.startTime + delta < 0) {
    return { success: false, error: { code: 'INVALID_TIME_RANGE', message: 'Slide would push the clip before 0' } }
  }

  const prev = findAdjacent(found.track.clips, clip, 'prev')
  const next = findAdjacent(found.track.clips, clip, 'next')
  const edits = slideEdits(clip, prev, next, delta)
  // MIN-duration / non-negative guard on every clip the slide resizes or moves.
  for (const e of edits) {
    if (e.duration !== undefined && e.duration < MIN_CLIP_DURATION) {
      return {
        success: false,
        error: { code: 'INVALID_TIME_RANGE', message: 'Slide would collapse a clip below the minimum duration' },
      }
    }
    if (e.startTime !== undefined && e.startTime < 0) {
      return { success: false, error: { code: 'INVALID_TIME_RANGE', message: 'Slide would push a clip before 0' } }
    }
  }

  return applyClipEdits(state, edits, action)
}

/**
 * clip/slip — shift a clip's source window (`trimStart`/`trimEnd`) by
 * `sourceDelta` source-seconds while keeping its position and duration fixed.
 * With `linked: true`, every clip in the same linkGroup slips by the same delta
 * (A/V stay in sync) — this is the fix for the per-RAF link-drift bug,
 * which compounded because the legacy path re-derived link deltas every frame.
 * Geometry mirrors the slip-tool path in `TrackRow.tsx`.
 */
export function reduceClipSlip(state: ProjectState, action: ClipSlipAction): ActionResult {
  const { clipId, sourceDelta, linked } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  if (typeof sourceDelta !== 'number' || !Number.isFinite(sourceDelta)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'sourceDelta must be a finite number' } }
  }

  const timeline = ensureTimeline(state)
  const found = findClip(timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }

  // Linked slip: every clip in the same linkGroup slips by the same source
  // delta (A/V stay in sync). linkedClipIds returns the whole group incl. self.
  const targetIds = linked && found.clip.linkGroupId ? linkedClipIds(timeline, clipId) : [clipId]
  const targets: Clip[] = targetIds.map((id) => findClip(timeline, id)!.clip)

  const edits: ClipEditPatch[] = targets.map((c) => {
    const { trimStart, trimEnd } = slipTrims(c, sourceDelta)
    return { clipId: c.id, trimStart, trimEnd }
  })

  return applyClipEdits(state, edits, action)
}

/**
 * Split a clip at `time` (global-timeline seconds). The clip becomes:
 *   left:  [clip.startTime,            time)
 *   right: [time,            clip.startTime + duration)
 *
 * Keyframe redistribution:
 *   - Keyframes whose `.time` (clip-relative seconds) < (time - clip.startTime)
 *     → stay on left half.
 *   - Keyframes whose `.time` > (time - clip.startTime)
 *     → move to right half, with `.time` rebased to (time' = time - splitOffset).
 *   - Exact-match keyframes (`.time === splitOffset`) are duplicated to both
 *     halves: the left keeps it at the original time, the right gets a copy
 *     at time 0.
 *
 * Property-tested in src/lib/actions/__tests__/clip-reducer.test.ts:
 *   - total keyframe count after split = original count + (# exact matches).
 *   - every keyframe is on the half whose [time-range] contains its time.
 */
export function reduceClipSplit(state: ProjectState, action: ClipSplitAction): ActionResult {
  const { clipId, time, rightClipId } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  const ridErr = validateId(rightClipId, 'rightClipId')
  if (ridErr) return { success: false, error: ridErr }

  const timeline = ensureTimeline(state)
  const found = findClip(timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }
  if (found.track.clips.some((c) => c.id === rightClipId)) {
    return { success: false, error: { code: 'DUPLICATE_ID', message: `Clip ${rightClipId} already exists on track` } }
  }

  const clip = found.clip
  const splitOffset = time - clip.startTime
  if (splitOffset <= 0 || splitOffset >= clip.duration) {
    return {
      success: false,
      error: {
        code: 'INVALID_TIME_RANGE',
        message: `Split time ${time}s is outside clip range [${clip.startTime}, ${clip.startTime + clip.duration})`,
      },
    }
  }

  const leftKeyframes: Keyframe[] = []
  const rightKeyframes: Keyframe[] = []
  for (const kf of clip.keyframes) {
    if (kf.time < splitOffset) {
      leftKeyframes.push(kf)
    } else if (kf.time > splitOffset) {
      rightKeyframes.push({ ...kf, time: kf.time - splitOffset })
    } else {
      // Exact match: duplicate.
      leftKeyframes.push(kf)
      rightKeyframes.push({ ...kf, time: 0 })
    }
  }

  const leftClip: Clip = {
    ...clip,
    duration: splitOffset,
    keyframes: leftKeyframes,
    // Left half ends at the split point. `duration` is PLAYBACK seconds and
    // trim points are SOURCE seconds: playback = (trimEnd - trimStart)/speed,
    // so source-offset = playback-offset × speed (dividing would duplicate
    // media across the halves at speed≠1 and disagree with the agent tool).
    // Cap at the original trimEnd so a float overshoot can't extend the
    // left clip past the source's trimmed end.
    trimEnd: Math.min(clip.trimStart + splitOffset * clip.speed, clip.trimEnd ?? Number.POSITIVE_INFINITY),
  }
  const rightClip: Clip = {
    ...clip,
    id: rightClipId,
    startTime: clip.startTime + splitOffset,
    duration: clip.duration - splitOffset,
    keyframes: rightKeyframes,
    trimStart: clip.trimStart + splitOffset * clip.speed,
  }

  const newClips = [...found.track.clips]
  newClips.splice(found.index, 1, leftClip, rightClip)

  return {
    success: true,
    state: withTimeline(
      state,
      mapTrack(timeline, found.track.id, (t) => ({ ...t, clips: newClips })),
    ),
    inverseAction: {
      // Inverse: ripple-delete the right half, then trim the left back to the
      // original duration. Single-action inverses can't restore both at once
      // — this records a marker; a full restore goes through the
      // explicit prior snapshot path.
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/rippleDelete',
      params: { clipId: rightClipId, prior: { clip: rightClip, index: found.index + 1, shifts: [] } },
    },
    warnings:
      clip.keyframes.length > 0
        ? [`Split distributed ${leftKeyframes.length} keyframe(s) to left and ${rightKeyframes.length} to right.`]
        : undefined,
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceClipRippleDelete(state: ProjectState, action: ClipRippleDeleteAction): ActionResult {
  const { clipId } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }

  const timeline = ensureTimeline(state)
  const found = findClip(timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const removed = found.clip
  // Ripple: every later clip on the same track shifts left by `removed.duration`.
  const shifts: Array<{ id: string; prevStartTime: number }> = []
  const newClips = found.track.clips
    .filter((c) => c.id !== clipId)
    .map((c) => {
      if (c.startTime >= removed.startTime + removed.duration) {
        shifts.push({ id: c.id, prevStartTime: c.startTime })
        return { ...c, startTime: c.startTime - removed.duration }
      }
      return c
    })

  return {
    success: true,
    state: withTimeline(
      state,
      mapTrack(timeline, found.track.id, (t) => ({ ...t, clips: newClips })),
    ),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/add',
      params: { trackId: found.track.id, clipId, clip: removed, position: found.index },
      // Note: this single-action inverse re-adds the clip but does not
      // un-shift the trailing clips. A complete ripple-undo composes
      // clip/add + N clip/move actions.
    },
    warnings:
      shifts.length > 0 ? [`Rippled ${shifts.length} trailing clip(s) left by ${removed.duration}s.`] : undefined,
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/**
 * clip/remove — non-ripple gap-leaving delete.
 *
 * This is the action-log-coherent path for `removeClip`. All source mutations
 * (audioLayer clearing, aiLayer removal, scene deletion, sceneGraph cleanup)
 * happen inside the reducer so the inverse (`agent/applyRun` snapshot) can
 * restore the entire state atomically on Cmd+Z.
 *
 * Source-mutation rules (mirrors `removeClip` in timeline-actions.ts):
 *   1. Avatar clip  → strip the avatar layer from scene.aiLayers so sync
 *      doesn't re-spawn it on the next tick.
 *   2. Title clip   → remove the mirrored scene.textOverlays entry so sync
 *      doesn't re-emit the clip.
 *   3. Audio clip   → clear the owning scene.audioLayer field (aud/tts/mus/sfx)
 *      so sync doesn't rebuild the clip from the still-set source field.
 *   4. Scene clip   → remove the whole scene from scenes[], clean up all
 *      related audio clips and scene-graph edges.
 *   5. Linked group → all clips in the same linkGroupId are removed together.
 *
 * The inverse is an `agent/applyRun` snapshot of the complete prior state
 * (scenes + globalStyle + sceneGraph + timeline), so a single Cmd+Z atomically
 * restores everything that was removed.
 */
export function reduceClipRemove(state: ProjectState, action: ClipRemoveAction): ActionResult {
  const { clipId } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }

  const timeline = ensureTimeline(state)
  const found = findClip(timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  // Snapshot the full prior state for the inverse. Captured before any mutation.
  const priorScenes = state.scenes
  const priorGlobalStyle = state.globalStyle
  const priorSceneGraph = state.project.sceneGraph
  const priorTimeline = state.project.timeline ?? null

  const target = found.clip
  const groupId = target.linkGroupId
  // Avatar pair → strip the layer from scene.aiLayers; mirrored title clip →
  // remove the scene.textOverlays entry. Shared with removeClipRipple so
  // plain and ripple delete imply identical source-state cleanup.
  const sourceCascade = cascadeClipSourceMutations(state.scenes, target)
  const avatarLayerId = sourceCascade.removedAvatarLayerId

  // ── 1. Build the post-delete timeline ────────────────────────────────────
  // Linked groups: remove every clip in the group together.
  // Non-linked: only the targeted clip, leaving a gap.
  let nextTimeline: Timeline
  if (groupId) {
    nextTimeline = removeLinkedClips(timeline, groupId)
  } else {
    nextTimeline = {
      ...timeline,
      tracks: timeline.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => c.id !== clipId),
      })),
    }
  }

  // ── 2. Source mutations ────────────────────────────────────────────────────
  // 2a. Avatar clip → aiLayers stripped / title clip → textOverlays entry
  // removed, both via the shared cascade (computed above) so sync doesn't
  // re-spawn the clip on the next tick.
  let nextScenes = sourceCascade.scenes

  // 2b. Audio clip → clear owning scene.audioLayer field.
  const sid = target.sourceId
  if (target.sourceType === 'audio' && !avatarLayerId) {
    let audioSceneId: string | null = null
    let audioField: 'aud' | 'tts' | 'mus' | 'sfx' | null = null
    if (sid.startsWith('aud-')) {
      audioSceneId = sid.slice(4)
      audioField = 'aud'
    } else if (sid.startsWith('tts-')) {
      audioSceneId = sid.slice(4)
      audioField = 'tts'
    } else if (sid.startsWith('mus-')) {
      audioSceneId = sid.slice(4)
      audioField = 'mus'
    } else {
      for (const s of state.scenes) {
        if ((s.audioLayer?.sfx ?? []).some((x) => x.id === sid)) {
          audioSceneId = s.id
          audioField = 'sfx'
          break
        }
      }
    }
    if (audioSceneId && audioField) {
      const aField = audioField
      const aSceneId = audioSceneId
      nextScenes = nextScenes.map((s) => {
        if (s.id !== aSceneId || !s.audioLayer) return s
        const al = s.audioLayer
        if (aField === 'aud') return { ...s, audioLayer: { ...al, enabled: false, src: null } }
        if (aField === 'tts') return { ...s, audioLayer: { ...al, tts: null } }
        if (aField === 'mus') return { ...s, audioLayer: { ...al, music: null } }
        if (aField === 'sfx') return { ...s, audioLayer: { ...al, sfx: (al.sfx ?? []).filter((x) => x.id !== sid) } }
        return s
      })
    }
  }

  // 2c. Scene clip → remove the whole scene + all its audio clips from the timeline.
  let nextSceneGraph = state.project.sceneGraph
  let affectedAvatarSceneIds: string[] = []
  const isSceneClip = target.sourceType === 'scene'
  // Clip-centric: a split scene has N clips sharing one sourceId. Run the
  // whole-scene cascade ONLY when this was the scene's LAST clip — otherwise the
  // target clip is already removed (section 1) and the scene + siblings stay.
  const sceneClipCount = isSceneClip
    ? timeline.tracks.flatMap((t) => t.clips).filter((c) => c.sourceType === 'scene' && c.sourceId === target.sourceId)
        .length
    : 0
  if (isSceneClip && sceneClipCount <= 1) {
    const sceneClipSceneId = target.sourceId
    const removedScene = state.scenes.find((s) => s.id === sceneClipSceneId)

    // Collect avatar layer IDs inside the scene being removed so the caller
    // can fire HTML-regen side effects.
    affectedAvatarSceneIds = removedScene
      ? (removedScene.aiLayers ?? []).filter((l) => l.type === 'avatar').map((l) => l.id)
      : []

    nextScenes = nextScenes.filter((s) => s.id !== sceneClipSceneId)
    // Drop every clip that depends on the scene (scene clip + derived audio +
    // avatar clips). Shared filter keeps this identical to scene/delete.
    const isDependentClip = makeSceneClipCascadeFilter(sceneClipSceneId, removedScene)
    nextTimeline = {
      ...nextTimeline,
      tracks: nextTimeline.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => !isDependentClip(c)),
      })),
    }
    if (state.project.sceneGraph) {
      const g = state.project.sceneGraph
      nextSceneGraph = {
        ...g,
        nodes: (g.nodes ?? []).filter((n) => n.id !== sceneClipSceneId),
        edges: (g.edges ?? []).filter((e) => e.fromSceneId !== sceneClipSceneId && e.toSceneId !== sceneClipSceneId),
        // Re-home the start node if it was the deleted scene — parity with
        // scene/delete; otherwise startSceneId dangles at a removed scene.
        startSceneId: g.startSceneId === sceneClipSceneId ? (nextScenes[0]?.id ?? '') : g.startSceneId,
      }
    }
  }

  // ── 3. Build next state ────────────────────────────────────────────────────
  const nextProject = {
    ...state.project,
    timeline: nextTimeline,
    sceneGraph: nextSceneGraph,
    updatedAt: new Date().toISOString(),
  }
  const nextSelectedSceneId =
    isSceneClip && state.selectedSceneId === target.sourceId ? (nextScenes[0]?.id ?? null) : state.selectedSceneId

  const nextState: ProjectState = {
    ...state,
    scenes: nextScenes,
    project: nextProject,
    selectedSceneId: nextSelectedSceneId,
  }

  // ── 4. Inverse — full state-snapshot restore ───────────────────────────────
  // Captures the complete prior state (scenes + globalStyle + sceneGraph +
  // timeline) so Cmd+Z atomically restores everything the remove touched.
  const inverseAction: AgentApplyRunAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'agent/applyRun',
    params: {
      scenes: priorScenes,
      globalStyle: priorGlobalStyle,
      sceneGraph: priorSceneGraph,
      timeline: priorTimeline,
    },
  }

  // Emit effects. Avatar-scene re-render is signalled so the store's effect
  // runner fires saveSceneHTML after the mutation lands.
  const effects: ActionResult['effects'] = [{ kind: 'schedule-project-save' }]
  for (const sceneId of affectedAvatarSceneIds) {
    effects.push({ kind: 'regenerate-scene-html', sceneId })
  }
  // For plain avatar/title clips (non-scene), signal regen on the scenes whose
  // aiLayers / textOverlays the shared cascade just mutated — both are baked
  // into the scene HTML.
  if (!isSceneClip) {
    for (const sceneId of sourceCascade.affectedSceneIds) {
      effects.push({ kind: 'regenerate-scene-html', sceneId })
    }
  }

  return {
    success: true,
    state: nextState,
    inverseAction,
    effects,
  }
}
