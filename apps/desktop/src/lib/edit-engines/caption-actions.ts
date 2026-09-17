/**
 * Captions → action-sequence coordinator.
 *
 * Given a parent clip + parsed SRT cues, build the ordered ActionInput list
 * that adds a subtitles track (if missing) and a text clip per cue on
 * that track. Each cue becomes one `clip/add` with sourceType `'title'`
 * and the cue's body text as both `sourceId` and `label`.
 *
 * Cue timing rules:
 *   - Cue `start` / `end` are seconds from the START of the source media.
 *     We rebase them to global-timeline seconds by adding the parent
 *     clip's `startTime`, then clip to the parent's [startTime, endTime]
 *     window so out-of-range cues don't produce ghost subtitles.
 *   - Cues clipped to zero length are skipped.
 *
 * Pure — returns ActionInput[] for the caller to dispatch in sequence.
 */

import type { ActionInput } from '@/lib/actions'
import type { Clip } from '@/lib/types'
import type { SrtCue } from './srt'

export interface CaptionsToActionsArgs {
  /** The clip the captions describe (audio or video). */
  parentClip: Clip
  /** Cues sourced from `parseSRT` or directly from a transcriber. */
  cues: SrtCue[]
  /**
   * Existing subtitles track id. If undefined, the coordinator emits a
   * `track/add` for a new text track and uses that id for every cue.
   */
  subtitlesTrackId?: string
  /**
   * Factory for fresh ids — overridable by callers (agent runs may want
   * uuid-based ids; tests want deterministic counters).
   */
  newId?: () => string
  /**
   * Snap-cue-to-edge tolerance in seconds. Default 0.01.
   */
  epsilon?: number
}

export interface CaptionsPlan {
  actions: ActionInput[]
  /** The track id captions land on — supplied or newly created. */
  trackId: string
  /** Number of cues that survived clipping and got a clip/add. */
  cueCount: number
  /** Total cue duration emitted (seconds) — useful for "added Xs of subtitles" UI. */
  totalSeconds: number
}

const DEFAULT_EPSILON = 0.01

function defaultIdCounter(prefix: string): () => string {
  let i = 0
  return () => `${prefix}-${++i}`
}

/** Build the action plan. Pure. */
export function captionsToActions(args: CaptionsToActionsArgs): CaptionsPlan {
  const epsilon = args.epsilon ?? DEFAULT_EPSILON
  const newId = args.newId ?? defaultIdCounter('cap')

  const actions: ActionInput[] = []
  let trackId = args.subtitlesTrackId

  if (!trackId) {
    trackId = newId()
    actions.push({
      type: 'track/add',
      params: { trackId, type: 'text', name: 'Subtitles' },
    })
  }

  const parentStart = args.parentClip.startTime
  const parentEnd = parentStart + args.parentClip.duration

  let cueCount = 0
  let totalSeconds = 0

  for (const cue of args.cues) {
    // Cue timestamps are relative to the source. Source-time 0 corresponds
    // to the clip's `trimStart` seconds into the source; we surface that
    // as parentStart on the global timeline. So source `cue.start` is at
    // global `parentStart + (cue.start - parentClip.trimStart) / speed`.
    // For the common case (trimStart=0, speed=1) this reduces to
    // `parentStart + cue.start`, which is what the test expects.
    const speed = args.parentClip.speed || 1
    const startGlobal = parentStart + (cue.start - args.parentClip.trimStart) / speed
    const endGlobal = parentStart + (cue.end - args.parentClip.trimStart) / speed

    // Clamp into parent range.
    const clippedStart = Math.max(parentStart, startGlobal)
    const clippedEnd = Math.min(parentEnd, endGlobal)
    if (clippedEnd - clippedStart <= epsilon) continue

    const clipId = newId()
    actions.push({
      type: 'clip/add',
      params: {
        trackId,
        clipId,
        clip: {
          id: clipId,
          trackId,
          sourceType: 'title',
          sourceId: cue.text,
          label: cue.text,
          startTime: clippedStart,
          duration: clippedEnd - clippedStart,
          trimStart: 0,
          trimEnd: null,
          speed: 1,
          opacity: 1,
          position: { x: 0, y: 0 },
          scale: { x: 1, y: 1 },
          rotation: 0,
          filters: [],
          keyframes: [],
        },
      },
    })

    cueCount++
    totalSeconds += clippedEnd - clippedStart
  }

  return { actions, trackId, cueCount, totalSeconds }
}
