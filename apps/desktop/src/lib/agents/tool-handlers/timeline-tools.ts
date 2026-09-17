/**
 * Timeline / clip editing tools (init_timeline, place_clip, trim/split, keyframes, filters, auto_cut_silence, add_captions, auto_reframe, …).
 *
 * Extracted from tool-executor.ts — the handler body is unchanged;
 * only the registration wiring moved. Relative dynamic imports were
 * rewritten to `@/` aliases since this file lives one directory deeper.
 */
import { v4 as uuidv4 } from 'uuid'
import { resolveProjectDimensions } from '@/lib/dimensions'
import { applyClipMoveWriteThrough } from '@/lib/actions/apply-clip-move-write-through'
import { cascadeClipSourceMutations } from '@/lib/actions/reducers/scene-clip-cascade'
import { emitAgentAction, emitterDepsForWorld } from './action-emitter'
import { TRACK_OVERLAP_RULES } from '@/lib/types'
import { pickTrackForClip, trackTypeForSource } from '@/lib/timeline/track-naming'
import { buildAudioUrlMap } from '@/lib/audio/audio-url-map'
import type { AgentLogger } from '../logger'
import type { ToolResult, WorldStateMutable } from './_shared'
import type { executeTool as ExecuteTool } from '../tool-executor'

export const TIMELINE_TOOL_NAMES = [
  'init_timeline',
  'read_timeline',
  'add_track',
  'remove_track',
  'set_track_props',
  'set_master_volume',
  'place_clip',
  // clip(op) / auto_cut(mode) are the MODEL-facing names. The switch below still
  // dispatches on the original internal op names (move_clip, trim_clip, …), which the
  // router at the top of the handler maps to — so every guard, write-through and
  // emitted action is byte-identical to the six/two tools they replaced.
  'clip',
  'keyframe',
  'auto_cut',
  'add_captions',
  'auto_reframe',
  'sync_audio',
  // apply_color absorbed apply_color_grade as its `look` argument; the named-look
  // handler case stays and the router below reaches it.
  'apply_color',
  // inspect_color was deleted from ALL_TOOLS: it could never measure anything
  // (no parameter existed to pass it the `__rgba` buffer it required). Handler
  // gone too — it had no schema and no internal caller.
  'marker',
] as const

interface TimelineToolDeps {
  // auto_cut_silence / add_captions / auto_reframe re-dispatch their planned
  // ActionInputs back through the full tool path so the world mutates AND
  // action_log gets an entry. Injected to avoid a circular runtime import.
  executeTool: typeof ExecuteTool
}

function mapActionInputToToolCall(
  world: WorldStateMutable,
  a: import('@/lib/actions').ActionInput,
): { toolName: string; args: Record<string, unknown> } | null {
  switch (a.type) {
    case 'clip/split': {
      const p = a.params as { clipId: string; time: number }
      // The agent's split_clip takes `atTime` relative to clip start, not
      // global timeline. Convert by subtracting the clip's startTime.
      let clip: import('@/lib/types').Clip | null = null
      for (const t of world.timeline?.tracks ?? []) {
        const c = t.clips.find((c) => c.id === p.clipId)
        if (c) {
          clip = c
          break
        }
      }
      if (!clip) return null
      // Thread the planner's pre-named right-half id through — silence-cut /
      // transcript-cut plans target it with follow-up actions.
      const rightClipId = (a.params as { rightClipId?: string }).rightClipId
      return { toolName: 'clip', args: { op: 'split', clipId: p.clipId, atTime: p.time - clip.startTime, rightClipId } }
    }
    case 'clip/rippleDelete': {
      const p = a.params as { clipId: string }
      return { toolName: 'clip', args: { op: 'remove', clipId: p.clipId } }
    }
    case 'track/add': {
      // P4-whisper: captions emit `track/add` for a new subtitles track.
      // The agent's add_track auto-generates ids; we accept that drift
      // and let the caller relink by reading the returned data.trackId.
      const p = a.params as { type: string; name?: string }
      return { toolName: 'add_track', args: { type: p.type, name: p.name } }
    }
    case 'clip/add': {
      // The captions planner produces sourceType=title clips per cue.
      // `place_clip` takes individual fields rather than a pre-built
      // Clip — unpack the planner's payload into the tool's args.
      const p = a.params as { trackId: string; clip: import('@/lib/types').Clip }
      return {
        toolName: 'place_clip',
        args: {
          trackId: p.trackId,
          sourceType: p.clip.sourceType,
          sourceId: p.clip.sourceId,
          label: p.clip.label,
          startTime: p.clip.startTime,
          duration: p.clip.duration,
          trimStart: p.clip.trimStart,
          trimEnd: p.clip.trimEnd ?? undefined,
          opacity: p.clip.opacity,
        },
      }
    }
    case 'keyframe/add': {
      // auto_reframe emits keyframe/add for x/y per downsampled time.
      // Route through `keyframe` (action:'set') so the world mutates AND
      // action_log gets an entry (the handler internally emits the same action).
      const p = a.params as { clipId: string; keyframe: import('@/lib/types').Keyframe }
      return {
        toolName: 'keyframe',
        args: {
          action: 'set',
          clipId: p.clipId,
          property: p.keyframe.property,
          time: p.keyframe.time,
          value: p.keyframe.value,
          easing: p.keyframe.easing,
        },
      }
    }
    default:
      return null
  }
}

/**
 * Resolve a clip's `sourceId` to a decodable audio URI for the decode/transcribe
 * engines (auto_cut_silence, cut_by_transcript, add_captions). Scene-mirror clips
 * carry SYNTHETIC ids (`aud-`/`tts-`/`mus-<sceneId>`) that ffmpeg / the transcriber
 * can't open — map them to the real `audioLayer` URL via `buildAudioUrlMap`.
 * Imported file / video clips already hold a real URI in `sourceId`, so fall back
 * to it. Mirrors the resolver `sync_audio` uses; an empty mapping (pending SFX)
 * also falls back, so the engine fails honestly rather than on a synthetic id.
 */
function resolveClipAudioUri(world: WorldStateMutable, sourceId: string): string {
  return buildAudioUrlMap(world.scenes).get(sourceId) || sourceId
}

export function createTimelineToolHandler(deps: TimelineToolDeps) {
  const { executeTool } = deps
  return async function handleTimelineTools(
    toolName: string,
    args: Record<string, unknown>,
    w: WorldStateMutable,
    _logger?: AgentLogger,
  ): Promise<ToolResult> {
    const world = w as WorldStateMutable
    type TL = import('@/lib/types').Timeline
    type TK = import('@/lib/types').Track
    type CL = import('@/lib/types').Clip
    const tl = (): TL | null => world.timeline ?? null
    const ok = (desc: string, data?: unknown): ToolResult => ({
      success: true,
      changes: [{ type: 'project_updated', description: desc }],
      data,
    })
    // Clip filters / keyframes / blend / fade render in the preview
    // compositor but are NOT consumed by the MP4 exporter (pixi-mp4 reads neither
    // clip.filters nor clip.keyframes) — that's the deferred NLE export-cliff. Per
    // The verb-honesty rule these verbs must not report unqualified success; tag
    // their result so the agent (and the user) know the change is preview-only.
    const PREVIEW_ONLY_CAVEAT = ' — note: applies in the editor preview but is not yet rendered in the MP4 export'
    const okPreviewOnly = (desc: string, data?: unknown): ToolResult => ok(desc + PREVIEW_ONLY_CAVEAT, data)
    const fail = (msg: string): ToolResult => ({ success: false, error: msg })
    // True iff a clip with this id exists on any track. The clip-targeting
    // mutators below `.map()` over every clip and patch the match; without this
    // guard an unknown clipId silently no-ops yet returns success, so the agent
    // believes a trim/keyframe/filter landed when nothing changed and never
    // self-corrects. Guarded handlers fail() on a miss instead.
    const clipExists = (clipId: string): boolean => !!tl()?.tracks.some((t) => t.clips.some((c) => c.id === clipId))

    // Reject non-finite numeric args before they poison downstream layout /
    // compositor / frame-count math. NaN slips past the old Math.max / comparison
    // guards (Math.max(0, NaN) === NaN; NaN <= 0 and NaN >= dur are BOTH false), so
    // every clip-mutating tool that takes a number routes its inputs through this
    // first. Returns a fail() ToolResult on bad input, or null when the value is OK.
    const finiteOrFail = (
      val: unknown,
      name: string,
      opts: { min?: number; allowUndefined?: boolean; allowNull?: boolean } = {},
    ): ToolResult | null => {
      if (val === undefined) return opts.allowUndefined ? null : fail(`${name} is required`)
      if (val === null) return opts.allowNull ? null : fail(`${name} must not be null`)
      if (typeof val !== 'number' || !Number.isFinite(val))
        return fail(`${name} must be a finite number (got ${JSON.stringify(val)})`)
      if (opts.min != null && val < opts.min) return fail(`${name} must be >= ${opts.min} (got ${val})`)
      return null
    }
    // Does [start, start+dur) overlap any existing clip on this track
    // (excluding excludeId)? Audio tracks spill to a free lane (place_clip handles
    // that); every other track type must REJECT an overlap — two stacked clips on
    // one video/scene/text track desync the gapless invariant syncTimelineFromScenes
    // depends on (preview ≠ export ≠ timeline). Returns the conflicting clip or null.
    const overlapOnTrack = (track: TK, start: number, dur: number, excludeId?: string): CL | null =>
      track.clips.find((c) => c.id !== excludeId && start < c.startTime + c.duration && c.startTime < start + dur) ??
      null

    // MERGE, don't replace: every pre-marker call site passed `{ tracks }`
    // only — which typechecks as a full Timeline (markers/inPoint/outPoint
    // are optional) and silently WIPED those fields from world.timeline on
    // any track/clip mutation. Partial-patch semantics heal all call sites
    // and let the marker tools patch `markers` without touching tracks.
    const setTimeline = (patch: Partial<import('@/lib/types').Timeline>) => {
      world.timeline = { ...(world.timeline ?? { tracks: [] }), ...patch }
    }

    // clip(op) / auto_cut(mode) / apply_color(look) → the internal op names this
    // switch already dispatches on. One map, no behaviour change: the six clip verbs
    // all keyed solely on clipId and all landed here anyway.
    const CLIP_OPS: Record<string, string> = {
      move: 'move_clip',
      trim: 'trim_clip',
      slip: 'slip_edit',
      split: 'split_clip',
      remove: 'remove_clip',
      props: 'set_clip_props',
    }
    if (toolName === 'clip') {
      const op = (args as { op?: string }).op
      const mapped = op ? CLIP_OPS[op] : undefined
      if (!mapped) {
        return fail(`clip: unknown op "${String(op)}" — expected move, trim, slip, split, remove or props.`)
      }
      toolName = mapped
    } else if (toolName === 'auto_cut') {
      const mode = (args as { mode?: string }).mode ?? 'silence'
      if (mode !== 'silence' && mode !== 'transcript') {
        return fail(`auto_cut: unknown mode "${String(mode)}" — expected silence or transcript.`)
      }
      toolName = mode === 'transcript' ? 'cut_by_transcript' : 'auto_cut_silence'
    } else if (toolName === 'apply_color' && (args as { look?: string }).look !== undefined) {
      // `look` is the named-look path apply_color_grade used to own. It takes ONE clip
      // and writes the clip's filters (not the grade object), so route the whole call
      // to the original handler with its original arg names.
      const a = args as { clipIds?: string[]; clipId?: string; look?: string; lookIntensity?: number }
      const clipId = a.clipId ?? a.clipIds?.[0]
      if (!clipId) return fail('apply_color(look) needs a clip — pass clipIds.')
      if (a.clipIds && a.clipIds.length > 1) {
        return fail(
          'apply_color(look) grades ONE clip at a time. Call it per clip, or use the colorist knobs which accept clipIds[].',
        )
      }
      toolName = 'apply_color_grade'
      args = { clipId, grade: a.look, intensity: a.lookIntensity }
    }

    switch (toolName) {
      case 'init_timeline': {
        if (tl()) return ok('Timeline already exists', { trackCount: tl()!.tracks.length })
        const tracks: import('@/lib/types').Track[] = [
          {
            id: uuidv4(),
            name: 'Main',
            type: 'video',
            clips: [],
            muted: false,
            locked: false,
            position: 0,
          },
        ]
        let acc = 0
        for (const scene of world.scenes) {
          tracks[0].clips.push({
            id: uuidv4(),
            trackId: tracks[0].id,
            sourceType: 'scene',
            sourceId: scene.id,
            label: scene.name || 'Untitled',
            startTime: acc,
            duration: scene.duration,
            trimStart: 0,
            trimEnd: null,
            speed: 1,
            opacity: 1,
            position: { x: 0, y: 0 },
            scale: { x: 1, y: 1 },
            rotation: 0,
            filters: [],
            keyframes: [],
            transition: null,
          })
          acc += scene.duration
        }
        setTimeline({ tracks })
        // Emit replayable actions for the initial track + clips. Timeline state
        // is reconstructed from the action_log / WAL (there's no projects.timeline
        // column), so without these the init is in-memory only: it's lost on
        // reload, and a later place_clip's `clip/add` replays against a track the
        // log never created (orphaned clip). `track/add` initializes the timeline
        // if missing; one `clip/add` per scene clip rebuilds the contents.
        //
        // Strictly-increasing timestamps are REQUIRED: the replay orders actions
        // by timestamp with no tiebreaker, so a same-millisecond burst could sort
        // a `clip/add` ahead of its `track/add` → TRACK_NOT_FOUND → the clip is
        // silently dropped on reload. Stamp the track first, then each clip after.
        const ts0 = Date.now()
        emitAgentAction(
          {
            type: 'track/add',
            params: { trackId: tracks[0].id, type: 'video', name: 'Main', position: 0 },
            timestamp: ts0,
          },
          emitterDepsForWorld(world),
        )
        tracks[0].clips.forEach((clip, i) => {
          emitAgentAction(
            { type: 'clip/add', params: { trackId: tracks[0].id, clipId: clip.id, clip }, timestamp: ts0 + 1 + i },
            emitterDepsForWorld(world),
          )
        })
        return ok(`Timeline initialized with ${tracks[0].clips.length} clips on 1 track`, {
          trackId: tracks[0].id,
          clipCount: tracks[0].clips.length,
        })
      }

      case 'read_timeline': {
        // Lets the agent SEE existing tracks (incl. the default V1/A1) + their
        // clips, so it places onto defaults instead of spawning a new track each
        // time. Returns ids the other timeline tools (place_clip/move_clip/…) take.
        const t = tl()
        if (!t) return ok('No timeline yet (init_timeline or create a scene first)', { tracks: [] })
        const tracks = [...t.tracks]
          .sort((a, b) => a.position - b.position)
          .map((tr) => ({
            id: tr.id,
            name: tr.name,
            type: tr.type,
            position: tr.position,
            muted: tr.muted ?? false,
            solo: tr.solo ?? false,
            hidden: tr.hidden ?? false,
            locked: tr.locked ?? false,
            clips: tr.clips
              .slice()
              .sort((a, b) => a.startTime - b.startTime)
              .map((c) => ({
                id: c.id,
                sourceType: c.sourceType,
                sourceId: c.sourceId,
                label: c.label,
                startTime: c.startTime,
                duration: c.duration,
              })),
          }))
        const v1 = tracks.find((tr) => tr.type === 'video')
        const a1 = tracks.find((tr) => tr.type === 'audio')
        return ok(
          `Timeline has ${tracks.length} track(s). Default video=${v1?.id ?? 'none'}, default audio=${a1?.id ?? 'none'}. ` +
            `Place clips on these existing tracks (do NOT add_track for the base V1/A1).`,
          { tracks, defaultVideoTrackId: v1?.id ?? null, defaultAudioTrackId: a1?.id ?? null },
        )
      }

      case 'add_track': {
        if (!tl()) return fail('Timeline not initialized. Call init_timeline first.')
        const { type } = args as {
          type: 'video' | 'audio' | 'image' | 'text' | 'graphics' | 'scene'
          name?: string
        }
        const id = uuidv4()
        const maxPos = tl()!.tracks.reduce((m: number, t: TK) => Math.max(m, t.position), -1)
        // Software owns track names (the `name` arg is ignored): V/A by type rank,
        // matching the store's normalizeTrackNames so the agent + UI agree.
        const rank = tl()!.tracks.filter((t) => t.type === type).length + 1
        const newTrack: import('@/lib/types').Track = {
          id,
          name: `${type === 'audio' ? 'A' : type === 'video' ? 'V' : type[0].toUpperCase()}${rank}`,
          type,
          clips: [],
          muted: false,
          locked: false,
          position: maxPos + 1,
        }
        setTimeline({ tracks: [...tl()!.tracks, newTrack] })
        emitAgentAction(
          { type: 'track/add', params: { trackId: id, type, name: newTrack.name, position: newTrack.position } },
          emitterDepsForWorld(world),
        )
        return ok(`Added ${type} track "${newTrack.name}"`, { trackId: id })
      }

      case 'place_clip': {
        if (!tl()) return fail('Timeline not initialized. Call init_timeline first.')
        const { trackId, sourceType, sourceId, label, startTime, duration, trimStart, trimEnd, opacity } = args as any
        if (sourceType === 'scene' && !world.scenes.find((s) => s.id === sourceId)) {
          return fail(`Scene ${sourceId} not found`)
        }
        // Finite-only (no min): negative start stays clamped by the Math.max(0,…)
        // below — preserving the established clamp contract; we only reject NaN/±Inf.
        const eStart = finiteOrFail(startTime, 'startTime')
        if (eStart) return eStart
        const eDur = finiteOrFail(duration, 'duration')
        if (eDur) return eDur
        const safeStart = Math.max(0, startTime)
        const safeDur = Math.max(0.1, duration)
        const wantType = trackTypeForSource(sourceType)
        const end = safeStart + safeDur
        const occupied = (t: TK) => t.clips.some((c) => safeStart < c.startTime + c.duration && c.startTime < end)
        // Mint a new lane of `type` (software-named V/A by rank), emit track/add so
        // the renderer rebuilds it before the clip, and return its id.
        const mintTrack = (type: import('@/lib/types').TrackType): string => {
          const nid = uuidv4()
          const maxPos = tl()!.tracks.reduce((m: number, t: TK) => Math.max(m, t.position), -1)
          const n = tl()!.tracks.filter((t) => t.type === type).length + 1
          const nm = `${type === 'audio' ? 'A' : type === 'video' ? 'V' : type[0].toUpperCase()}${n}`
          setTimeline({
            tracks: [
              ...tl()!.tracks,
              { id: nid, name: nm, type, clips: [], muted: false, locked: false, position: maxPos + 1 },
            ],
          })
          emitAgentAction(
            { type: 'track/add', params: { trackId: nid, type, name: nm, position: maxPos + 1 } },
            emitterDepsForWorld(world),
          )
          return nid
        }
        // SOFTWARE-OWNED track routing: with no trackId, place onto the LOWEST
        // free track of the clip's type (default V1/A1), spilling/minting only on a
        // genuine overlap. With an explicit trackId: audio never stacks (spill — the
        // per-scene mixer can't separate two clips at once); a reject-policy visual
        // track (video/image/graphics/scene per TRACK_OVERLAP_RULES) must
        // NOT silently stack, so an overlap there FAILS with a clear conflict instead of
        // breaking the gapless invariant; `text` tracks allow overlap and place as asked.
        let placeTrackId: string
        if (trackId) {
          const track = tl()!.tracks.find((t) => t.id === trackId)
          if (!track) return fail(`Track ${trackId} not found`)
          if (track.type === 'audio') {
            placeTrackId = occupied(track)
              ? (pickTrackForClip(tl()!.tracks, 'audio', safeStart, safeDur) ?? mintTrack('audio'))
              : track.id
          } else if (TRACK_OVERLAP_RULES[track.type] === 'reject') {
            const conflict = overlapOnTrack(track, safeStart, safeDur)
            if (conflict) {
              return fail(
                `Clip would overlap "${conflict.label || conflict.id}" ` +
                  `(${conflict.startTime.toFixed(2)}s–${(conflict.startTime + conflict.duration).toFixed(2)}s) ` +
                  `on track ${trackId}. Place it at a free time on this track or on another track.`,
              )
            }
            placeTrackId = track.id
          } else {
            placeTrackId = track.id
          }
        } else {
          placeTrackId = pickTrackForClip(tl()!.tracks, wantType, safeStart, safeDur) ?? mintTrack(wantType)
        }
        const id = uuidv4()
        const clip: import('@/lib/types').Clip = {
          id,
          trackId: placeTrackId,
          sourceType,
          sourceId,
          label: label ?? '',
          startTime: safeStart,
          duration: safeDur,
          trimStart: trimStart ?? 0,
          trimEnd: trimEnd ?? null,
          speed: 1,
          opacity: opacity ?? 1,
          position: { x: 0, y: 0 },
          scale: { x: 1, y: 1 },
          rotation: 0,
          filters: [],
          keyframes: [],
          transition: null,
        }
        setTimeline({
          tracks: tl()!.tracks.map((t) => (t.id === placeTrackId ? { ...t, clips: [...t.clips, clip] } : t)),
        })
        emitAgentAction(
          { type: 'clip/add', params: { trackId: placeTrackId, clipId: id, clip } },
          emitterDepsForWorld(world),
        )
        const placedName = tl()!.tracks.find((t) => t.id === placeTrackId)?.name ?? placeTrackId
        // Describe routing honestly: a redirect only happened if the caller
        // asked for a specific track and we moved off it (occupied audio lane).
        // With no trackId the software just routed to the default/lowest free
        // lane — that's normal, not a "spill".
        const note =
          trackId && placeTrackId !== trackId
            ? ` (requested track was occupied — routed to free lane ${placedName})`
            : ` on ${placedName}`
        return ok(`Placed ${sourceType} clip at ${safeStart}s (${safeDur}s)${note}`, {
          clipId: id,
          trackId: placeTrackId,
        })
      }

      case 'move_clip': {
        if (!tl()) return fail('No timeline')
        const { clipId, toTrackId, startTime } = args as { clipId: string; toTrackId: string; startTime: number }
        // Finite-only: the write-through clamps negative start via Math.max(0,…),
        // so keep that contract and reject only NaN/±Inf here.
        const eMoveStart = finiteOrFail(startTime, 'startTime')
        if (eMoveStart) return eMoveStart
        // Guard the target track BEFORE the shared write-through
        // (so the renderer's drag-snap path is untouched — only the agent's blind move
        // is guarded).
        //  - reject-policy target (video/image/graphics/scene per TRACK_OVERLAP_RULES):
        //    an overlap FAILS honestly (two stacked clips break the gapless invariant).
        //  - audio target: audio can't stack — the per-scene mixer plays one clip per
        //    track at a time, so an overlap SPILLS to a free audio lane (or mints one),
        //    mirroring place_clip. Without this, move_clip left two overlapping clips on
        //    one audio track (place_clip already spills; move_clip did not).
        //  - text ('allow'): overlap is fine; falls through as-is.
        // Callers that need a stricter no-overlap guarantee on audio (e.g. sync_audio)
        // still enforce it themselves before dispatching the move.
        let effectiveToTrackId = toTrackId
        let audioSpilledTo: string | null = null
        {
          const targetTrack = tl()!.tracks.find((t) => t.id === toTrackId)
          const moving = tl()!
            .tracks.flatMap((t) => t.clips)
            .find((c) => c.id === clipId)
          if (targetTrack && moving) {
            const safeMoveStart = Math.max(0, startTime)
            if (TRACK_OVERLAP_RULES[targetTrack.type] === 'reject') {
              const conflict = overlapOnTrack(targetTrack, safeMoveStart, moving.duration, clipId)
              if (conflict) {
                return fail(
                  `Move would overlap "${conflict.label || conflict.id}" ` +
                    `(${conflict.startTime.toFixed(2)}s–${(conflict.startTime + conflict.duration).toFixed(2)}s) ` +
                    `on track ${toTrackId}. Choose a free start time or another track.`,
                )
              }
            } else if (targetTrack.type === 'audio') {
              const conflict = overlapOnTrack(targetTrack, safeMoveStart, moving.duration, clipId)
              if (conflict) {
                // excludeId=clipId in overlapOnTrack means a same-lane nudge that only
                // overlaps ITSELF won't spill; we only spill on a genuine OTHER-clip
                // conflict. Route to the lowest free audio lane, or mint a new one.
                let free = pickTrackForClip(tl()!.tracks, 'audio', safeMoveStart, moving.duration)
                if (!free) {
                  const nid = uuidv4()
                  const maxPos = tl()!.tracks.reduce((m: number, t: TK) => Math.max(m, t.position), -1)
                  const n = tl()!.tracks.filter((t) => t.type === 'audio').length + 1
                  const nm = `A${n}`
                  setTimeline({
                    tracks: [
                      ...tl()!.tracks,
                      {
                        id: nid,
                        name: nm,
                        type: 'audio',
                        clips: [],
                        muted: false,
                        locked: false,
                        position: maxPos + 1,
                      },
                    ],
                  })
                  emitAgentAction(
                    { type: 'track/add', params: { trackId: nid, type: 'audio', name: nm, position: maxPos + 1 } },
                    emitterDepsForWorld(world),
                  )
                  free = nid
                }
                if (free !== toTrackId) {
                  effectiveToTrackId = free
                  audioSpilledTo = free
                }
              }
            }
          }
        }
        // B3 (v6 / OV#5): the SAME pure write-through the renderer's moveClip
        // runs — it mutates BOTH world.timeline AND world.scenes (audioLayer
        // startOffset / sfx triggerAt / avatar startAt / text delay + linked-
        // sibling shifts + scene order). Writing the scene source through means
        // the editor's syncTimelineFromScenes re-derives the SAME positions and
        // can no longer snap the agent's move back. `writeBackSource` defaults
        // true on this path (nothing else writes world.scenes).
        const r = applyClipMoveWriteThrough(world.timeline, world.scenes, clipId, {
          toTrackId: effectiveToTrackId,
          startTime,
        })
        if (!r.changed) {
          // A genuine no-op (same track + start) still succeeds quietly; a
          // rejection (missing clip/track, type mismatch, cross-track scene
          // move) fails honestly with the reason.
          if (r.rejectedReason && !/No timeline/.test(r.rejectedReason)) return fail(r.rejectedReason)
          if (r.rejectedReason) return fail(r.rejectedReason)
          return ok(`Clip ${clipId} already at the requested position (no change)`)
        }
        world.timeline = r.timeline
        world.scenes = r.scenes
        const safeStart = Math.max(0, startTime)
        emitAgentAction(
          { type: 'clip/move', params: { clipId, startTime: safeStart, newTrackId: effectiveToTrackId } },
          emitterDepsForWorld(world),
        )
        if (audioSpilledTo) {
          const spilledName = tl()!.tracks.find((t) => t.id === audioSpilledTo)?.name ?? audioSpilledTo
          return ok(
            `Moved clip to ${safeStart}s — requested audio track was occupied, spilled to free lane ${spilledName} ` +
              `(audio can't stack on one track).`,
          )
        }
        return ok(`Moved clip to track ${effectiveToTrackId} at ${safeStart}s`)
      }

      case 'trim_clip': {
        if (!tl()) return fail('No timeline')
        const { clipId, trimStart: ts, trimEnd: te, duration: dur } = args as any
        if (!clipExists(clipId)) return fail(`Clip ${clipId} not found`)
        // Finite-guard every numeric arg (trimEnd may be null to clear it).
        const eTs = finiteOrFail(ts, 'trimStart', { allowUndefined: true })
        if (eTs) return eTs
        const eTe = finiteOrFail(te, 'trimEnd', { allowUndefined: true, allowNull: true })
        if (eTe) return eTe
        const eDur = finiteOrFail(dur, 'duration', { min: 0, allowUndefined: true })
        if (eDur) return eDur
        const updates: Partial<import('@/lib/types').Clip> = {}
        if (ts != null) updates.trimStart = ts
        if (te !== undefined) updates.trimEnd = te
        if (dur != null) updates.duration = Math.max(0.1, dur)
        setTimeline({
          tracks: tl()!.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...updates } : c)),
          })),
        })
        emitAgentAction(
          { type: 'clip/trim', params: { clipId, trimStart: ts, trimEnd: te, duration: dur } },
          emitterDepsForWorld(world),
        )
        return ok(`Trimmed clip ${clipId}`)
      }

      case 'split_clip': {
        if (!tl()) return fail('No timeline')
        const { clipId, atTime, rightClipId } = args as { clipId: string; atTime: number; rightClipId?: string }
        let clip: import('@/lib/types').Clip | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            clip = c
            break
          }
        }
        if (!clip) return fail(`Clip ${clipId} not found`)
        // Scene clips can't split yet (guard-only — parity with the
        // editor's splitClip): playback resolves one clip per scene and the
        // editor's scenes sync re-emits exactly one clip per scene, silently
        // deleting the right half. Fail honestly instead of reporting a split
        // that the next sync destroys.
        if (clip.sourceType === 'scene') {
          return fail(
            `Cannot split scene clip ${clipId}: scene clips are 1:1 with their scene and the editor cannot represent two clips per scene yet — the right half would be deleted on the next scenes sync. Instead, trim the clip (trim_clip), shorten the scene (scene_props op:'duration'), or duplicate the scene (duplicate_scene) and trim each copy.`,
          )
        }
        // NaN passed the old range guard (NaN<=0 and NaN>=dur are
        // both false), minting two NaN-duration halves. Reject non-finite first.
        const eAtTime = finiteOrFail(atTime, 'atTime')
        if (eAtTime) return eAtTime
        if (atTime <= 0 || atTime >= clip.duration)
          return fail(`Split time ${atTime}s out of range (0–${clip.duration}s)`)
        // Id semantics MUST match the renderer reducer (clip-reducer split):
        // the LEFT half keeps the original clip id; the RIGHT half takes the
        // caller-provided rightClipId when given (planned multi-action edits
        // — silence-cut, transcript-cut — pre-name the halves so follow-up
        // actions can target them). The old fresh-uuid-for-both behavior
        // broke every planned interior/tail cut on the agent path ("applied
        // 1/3 before failure: kf-split-1 not found") AND diverged agent vs
        // renderer ids after every split.
        const leftId = clip.id
        const rightId = rightClipId ?? uuidv4()
        if (tl()!.tracks.some((t) => t.clips.some((c) => c.id === rightId)))
          return fail(`rightClipId ${rightId} already exists`)
        const left: import('@/lib/types').Clip = {
          ...clip,
          id: leftId,
          duration: atTime,
          trimEnd: clip.trimStart + atTime * clip.speed,
          keyframes: clip.keyframes.filter((k) => k.time < atTime),
        }
        const right: import('@/lib/types').Clip = {
          ...clip,
          id: rightId,
          startTime: clip.startTime + atTime,
          duration: clip.duration - atTime,
          trimStart: clip.trimStart + atTime * clip.speed,
          keyframes: clip.keyframes.filter((k) => k.time >= atTime).map((k) => ({ ...k, time: k.time - atTime })),
        }
        setTimeline({
          tracks: tl()!.tracks.map((t) => ({
            ...t,
            clips: t.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])),
          })),
        })
        emitAgentAction(
          { type: 'clip/split', params: { clipId, time: clip.startTime + atTime, rightClipId: rightId } },
          emitterDepsForWorld(world),
        )
        return ok(`Split clip into two at ${atTime}s`, { leftId, rightId })
      }

      case 'remove_clip': {
        if (!tl()) return fail('No timeline')
        const { clipId } = args as { clipId: string }

        let removedClip: import('@/lib/types').Clip | null = null
        let removedTrackId: string | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            removedClip = c
            removedTrackId = t.id
            break
          }
        }
        if (!removedClip || !removedTrackId) return fail(`Clip ${clipId} not found`)

        // B3 (v6): removing a SCENE clip refuses — parity with the renderer's
        // removeClipRipple, which runs a whole-scene cascade (drops the scene
        // from scenes[] + all its derived audio/avatar clips). The agent must
        // use delete_scene for that so the scene, its graph node, and its HTML
        // are removed coherently — a bare clip ripple here would leave an
        // orphaned scene the next sync re-mints (snap-back).
        if (removedClip.sourceType === 'scene') {
          return fail(
            `Cannot remove a scene clip with remove_clip — it would leave the scene orphaned and the next ` +
              `editor sync would re-mint the clip. Use delete_scene("${removedClip.sourceId}") to remove the ` +
              `scene, its clip, its derived audio, and its graph node together.`,
          )
        }

        // A mirror clip (avatar A/V pair, mirrored title) is a MIRROR of
        // scene SOURCE state — strip that source (aiLayers avatar / textOverlays
        // entry) via the shared cascade BEFORE the ripple, or the next
        // syncTimelineFromScenes resurrects it onto the shifted tracks. SAME fn
        // the renderer's removeClipRipple uses, so the two can't drift.
        const sourceCascade = cascadeClipSourceMutations(world.scenes, removedClip)
        if (sourceCascade.scenes !== world.scenes) world.scenes = sourceCascade.scenes

        // Linked siblings (an avatar's video+audio share a linkGroupId) go too —
        // parity with the reducer's removeLinkedClips, which a bare `id===clipId`
        // filter would miss.
        const removedGroupId = removedClip.linkGroupId
        const isRemoved = (c: import('@/lib/types').Clip): boolean =>
          c.id === clipId || (!!removedGroupId && c.linkGroupId === removedGroupId)

        const rippleOffset = removedClip.duration
        let shiftedCount = 0

        // Ripple EVERY track that lost a clip, not just removedTrackId. A
        // linked sibling (avatar A/V pair) lives on a DIFFERENT track; the old
        // single-track ripple deleted it (via isRemoved) but left its gap open, so
        // that track drifted out of sync. Each affected track re-flows by the span
        // of its OWN removed clip(s), anchored at the earliest removed end.
        setTimeline({
          tracks: tl()!.tracks.map((t) => {
            const removedOnTrack = t.clips.filter(isRemoved)
            if (removedOnTrack.length === 0) return t
            const removedDur = removedOnTrack.reduce((s, c) => s + c.duration, 0)
            const earliestEnd = Math.min(...removedOnTrack.map((c) => c.startTime + c.duration))
            return {
              ...t,
              clips: t.clips
                .filter((c) => !isRemoved(c))
                .map((c) => {
                  if (c.startTime >= earliestEnd) {
                    shiftedCount += 1
                    return { ...c, startTime: Math.max(0, c.startTime - removedDur) }
                  }
                  return c
                }),
            }
          }),
        })
        // NOTE: the persisted world.timeline above now ripples
        // every affected track, but the emitted clip/rippleDelete action replays
        // through reduceClipRippleDelete, which still ripples only the clip's own
        // track. The persisted BLOB snapshot is authoritative (correct), so live
        // state is right; an in-editor UNDO/action-replay would under-ripple the
        // linked sibling's track. Closing that needs reduceClipRippleDelete +
        // store removeClipRipple to match — tracked as a Wave-2 action-log-fidelity
        // item, out of this lane's scope.
        emitAgentAction({ type: 'clip/rippleDelete', params: { clipId } }, emitterDepsForWorld(world))
        return ok(
          `Ripple-deleted clip ${clipId}` +
            (shiftedCount > 0
              ? ` (shifted ${shiftedCount} subsequent clip${shiftedCount === 1 ? '' : 's'} left by ${rippleOffset.toFixed(2)}s)`
              : ''),
        )
      }

      case 'set_clip_props': {
        // Merged clip-property setter: speed / fade / blend / filter. Each
        // provided field runs the exact mutation + validation + emitAgentAction
        // the pre-merge tool did (set_clip_speed / set_clip_fade /
        // set_clip_blend_mode / set_clip_filter / remove_clip_filter).
        const { clipId, speed, fadeIn, fadeOut, blendMode, filter } = args as {
          clipId: string
          speed?: number
          fadeIn?: number
          fadeOut?: number
          blendMode?: string
          filter?: { filterType: string; value?: number | null } | null
        }
        // speed: REFUSE honestly (verbatim from set_clip_speed). This fired
        // regardless of timeline state pre-merge — keep it ahead of the tl()
        // guard so the honest refusal, not "No timeline", is what's returned.
        if (speed !== undefined) {
          return fail(
            `set_clip_speed is not available yet: clip speed is not applied at export, and stamping the implied ` +
              `duration change would silently cut or pad the clip's content while it still plays at 1x. To change ` +
              `how long ${clipId ? `clip ${clipId}` : 'a clip'} occupies the timeline, trim it (trim_clip) or adjust ` +
              `the scene duration (scene_props op:'duration') instead.`,
          )
        }
        if (!tl()) return fail('No timeline')
        // Locate the clip once (fade validation needs its duration).
        let found: CL | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            found = c
            break
          }
        }
        if (!found) return fail(`Clip ${clipId} not found`)
        const notes: string[] = []
        // fade (from set_clip_fade)
        if (fadeIn !== undefined || fadeOut !== undefined) {
          if (fadeIn !== undefined && (fadeIn < 0 || fadeIn > found.duration))
            return fail(`fadeIn ${fadeIn}s out of [0, ${found.duration}s]`)
          if (fadeOut !== undefined && (fadeOut < 0 || fadeOut > found.duration))
            return fail(`fadeOut ${fadeOut}s out of [0, ${found.duration}s]`)
          if (fadeIn !== undefined && fadeOut !== undefined && fadeIn + fadeOut > found.duration)
            return fail(`fadeIn + fadeOut (${fadeIn + fadeOut}s) exceeds clip duration (${found.duration}s)`)
          const patch: Partial<CL> = {}
          if (fadeIn !== undefined) patch.fadeIn = fadeIn
          if (fadeOut !== undefined) patch.fadeOut = fadeOut
          setTimeline({
            tracks: tl()!.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
            })),
          })
          emitAgentAction({ type: 'clip/fade', params: { clipId, fadeIn, fadeOut } }, emitterDepsForWorld(world))
          notes.push(`fade (in=${fadeIn ?? 'unchanged'}s, out=${fadeOut ?? 'unchanged'}s)`)
        }
        // blend (from set_clip_blend_mode)
        if (blendMode !== undefined) {
          setTimeline({
            tracks: tl()!.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => (c.id === clipId ? { ...c, blendMode } : c)),
            })),
          })
          emitAgentAction({ type: 'clip/setBlend', params: { clipId, blendMode } }, emitterDepsForWorld(world))
          notes.push(`blend mode "${blendMode}"`)
        }
        // filter: { filterType, value } sets/replaces (from set_clip_filter);
        // value null/absent removes that filter type (from remove_clip_filter).
        if (filter !== undefined && filter !== null) {
          const { filterType, value } = filter
          if (value === undefined || value === null) {
            setTimeline({
              tracks: tl()!.tracks.map((t) => ({
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId ? { ...c, filters: c.filters.filter((f) => f.type !== filterType) } : c,
                ),
              })),
            })
            emitAgentAction(
              {
                type: 'effect/remove',
                params: { clipId, filterType: filterType as import('@/lib/types').ClipFilter['type'] },
              },
              emitterDepsForWorld(world),
            )
            notes.push(`removed ${filterType} filter`)
          } else {
            setTimeline({
              tracks: tl()!.tracks.map((t) => ({
                ...t,
                clips: t.clips.map((c) => {
                  if (c.id !== clipId) return c
                  // Replace existing filter of same type, or add new
                  const filters = c.filters.filter((f) => f.type !== filterType)
                  filters.push({ type: filterType as any, value })
                  return { ...c, filters }
                }),
              })),
            })
            emitAgentAction(
              {
                type: 'effect/add',
                params: { clipId, filter: { type: filterType as import('@/lib/types').ClipFilter['type'], value } },
              },
              emitterDepsForWorld(world),
            )
            notes.push(`set ${filterType} filter to ${value}`)
          }
        }
        if (notes.length === 0)
          return fail('set_clip_props: provide at least one of speed / fadeIn / fadeOut / blendMode / filter')
        // fade / blend / filter render in the editor preview but not the MP4
        // export — keep the same preview-only honesty caveat the old tools used.
        return okPreviewOnly(`Clip ${clipId}: ${notes.join(', ')}`)
      }

      case 'keyframe': {
        if (!tl()) return fail('No timeline')
        const { action } = args as { action: 'set' | 'remove' }
        if (action === 'set') {
          // (from set_keyframe)
          const {
            clipId,
            property,
            time: kfTime,
            value,
            easing,
          } = args as {
            clipId: string
            property: string
            time: number
            value: number
            easing?: string
          }
          if (!clipExists(clipId)) return fail(`Clip ${clipId} not found`)
          // Finite-guard time and value (NaN keyframes break interpolation).
          const eKfTime = finiteOrFail(kfTime, 'time')
          if (eKfTime) return eKfTime
          const eKfVal = finiteOrFail(value, 'value')
          if (eKfVal) return eKfVal
          const kf: import('@/lib/types').Keyframe = {
            time: Math.max(0, kfTime),
            property,
            value,
            easing: easing ?? 'linear',
          }
          setTimeline({
            tracks: tl()!.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== clipId) return c
                // Remove existing keyframe at same property+time, then add new one
                const filtered = c.keyframes.filter(
                  (k) => !(k.property === property && Math.abs(k.time - kfTime) < 0.001),
                )
                return { ...c, keyframes: [...filtered, kf] }
              }),
            })),
          })
          // upsert semantics — emit `keyframe/add` for a fresh row,
          // `keyframe/update` when one already existed. The reducer doesn't
          // care which since both are persisted in action_log; the choice
          // keeps the log human-readable.
          emitAgentAction(
            {
              type: 'keyframe/add',
              params: { clipId, keyframe: kf as import('@/lib/types').Keyframe },
            },
            emitterDepsForWorld(world),
          )
          return okPreviewOnly(`Set keyframe: ${property}=${value} at ${kfTime}s (${easing ?? 'linear'})`)
        }
        if (action === 'remove') {
          // (from remove_keyframe)
          const { clipId, property, time: kfTime } = args as { clipId: string; property: string; time: number }
          if (!clipExists(clipId)) return fail(`Clip ${clipId} not found`)
          setTimeline({
            tracks: tl()!.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== clipId) return c
                return {
                  ...c,
                  keyframes: c.keyframes.filter((k) => !(k.property === property && Math.abs(k.time - kfTime) < 0.001)),
                }
              }),
            })),
          })
          emitAgentAction(
            {
              type: 'keyframe/remove',
              params: { clipId, property: property as import('@/lib/types').Keyframe['property'], time: kfTime },
            },
            emitterDepsForWorld(world),
          )
          return okPreviewOnly(`Removed keyframe: ${property} at ${kfTime}s`)
        }
        return fail(`keyframe requires action 'set' or 'remove' (got ${JSON.stringify(action)})`)
      }

      case 'slip_edit': {
        if (!tl()) return fail('No timeline')
        const { clipId, offsetSeconds } = args as { clipId: string; offsetSeconds: number }
        let found: CL | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            found = c
            break
          }
        }
        if (!found) return fail(`Clip ${clipId} not found`)
        // Finite-guard the offset (NaN would poison both trim fields).
        const eOffset = finiteOrFail(offsetSeconds, 'offsetSeconds')
        if (eOffset) return eOffset
        const newTrimStart = Math.max(0, found.trimStart + offsetSeconds)
        const newTrimEnd = found.trimEnd != null ? found.trimEnd + offsetSeconds : null
        // A slip clamped to the source boundary is a no-op — report it
        // honestly instead of claiming a shift that didn't happen.
        if (newTrimStart === found.trimStart && newTrimEnd === found.trimEnd) {
          return ok(`Slip edit: no change (offset ${offsetSeconds}s clamped at the source-window boundary)`)
        }
        setTimeline({
          tracks: tl()!.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => (c.id === clipId ? { ...c, trimStart: newTrimStart, trimEnd: newTrimEnd } : c)),
          })),
        })
        // Emit an action so the slip reaches the undo / checkpoint-replay path. A slip
        // is a trim of the source window — emit clip/trim with the new bounds.
        emitAgentAction(
          { type: 'clip/trim', params: { clipId, trimStart: newTrimStart, trimEnd: newTrimEnd } },
          emitterDepsForWorld(world),
        )
        return ok(
          `Slip edit: shifted source window by ${offsetSeconds > 0 ? '+' : ''}${offsetSeconds}s (trimStart=${newTrimStart.toFixed(1)}s)`,
        )
      }

      // ── New tool branches ────────────────────────────────────
      case 'remove_track': {
        if (!tl()) return fail('No timeline')
        const { trackId } = args as { trackId: string }
        if (!tl()!.tracks.find((t) => t.id === trackId)) return fail(`Track ${trackId} not found`)
        const removed = tl()!.tracks.find((t) => t.id === trackId)!
        setTimeline({
          tracks: tl()!
            .tracks.filter((t) => t.id !== trackId)
            .map((t, i) => ({ ...t, position: i })),
        })
        emitAgentAction({ type: 'track/remove', params: { trackId } }, emitterDepsForWorld(world))
        return ok(`Removed track "${removed.name}" (${removed.clips.length} clip(s) dropped)`, {
          trackId,
          removedClipCount: removed.clips.length,
        })
      }

      case 'set_track_props': {
        // Merged per-track setter: lock / mute / solo / hide / volume / pan.
        // Each provided field runs the exact mutation + validation +
        // emitAgentAction the pre-merge tool did (lock_track / mute_track /
        // solo_track / hide_track / set_track_volume / set_track_pan).
        if (!tl()) return fail('No timeline')
        const { trackId, locked, muted, solo, hidden, volume, pan } = args as {
          trackId: string
          locked?: boolean
          muted?: boolean
          solo?: boolean
          hidden?: boolean
          volume?: number
          pan?: number
        }
        if (!tl()!.tracks.find((t) => t.id === trackId)) return fail(`Track ${trackId} not found`)
        const changed: string[] = []
        if (locked !== undefined) {
          setTimeline({ tracks: tl()!.tracks.map((t) => (t.id === trackId ? { ...t, locked } : t)) })
          emitAgentAction({ type: 'track/lock', params: { trackId, locked } }, emitterDepsForWorld(world))
          changed.push(locked ? 'locked' : 'unlocked')
        }
        if (muted !== undefined) {
          setTimeline({ tracks: tl()!.tracks.map((t) => (t.id === trackId ? { ...t, muted } : t)) })
          emitAgentAction({ type: 'track/mute', params: { trackId, muted } }, emitterDepsForWorld(world))
          changed.push(muted ? 'muted' : 'unmuted')
        }
        if (solo !== undefined) {
          setTimeline({ tracks: tl()!.tracks.map((t) => (t.id === trackId ? { ...t, solo } : t)) })
          emitAgentAction({ type: 'track/solo', params: { trackId, solo } }, emitterDepsForWorld(world))
          changed.push(solo ? 'soloed' : 'unsoloed')
        }
        if (hidden !== undefined) {
          setTimeline({ tracks: tl()!.tracks.map((t) => (t.id === trackId ? { ...t, hidden } : t)) })
          emitAgentAction({ type: 'track/hide', params: { trackId, hidden } }, emitterDepsForWorld(world))
          changed.push(hidden ? 'hidden' : 'shown')
        }
        if (volume !== undefined) {
          // Mixer fader for a track. Linear gain 0..2 (+6 dB); 1 = unity.
          const track = tl()!.tracks.find((t) => t.id === trackId)!
          if (track.locked) return fail(`Track ${trackId} is locked`)
          if (typeof volume !== 'number' || !Number.isFinite(volume)) return fail('volume must be a number (0..2)')
          const v = Math.max(0, Math.min(2, volume))
          setTimeline({ tracks: tl()!.tracks.map((t) => (t.id === trackId ? { ...t, volume: v } : t)) })
          emitAgentAction({ type: 'track/setVolume', params: { trackId, volume: v } }, emitterDepsForWorld(world))
          changed.push(`volume ${v.toFixed(2)} (${(20 * Math.log10(v || 1e-6)).toFixed(1)} dB)`)
        }
        if (pan !== undefined) {
          // Stereo pan for a track: -1 hard left, 0 center, +1 hard right.
          const track = tl()!.tracks.find((t) => t.id === trackId)!
          if (track.locked) return fail(`Track ${trackId} is locked`)
          if (typeof pan !== 'number' || !Number.isFinite(pan)) return fail('pan must be a number (-1..1)')
          const p = Math.max(-1, Math.min(1, pan))
          setTimeline({ tracks: tl()!.tracks.map((t) => (t.id === trackId ? { ...t, pan: p } : t)) })
          emitAgentAction({ type: 'track/setPan', params: { trackId, pan: p } }, emitterDepsForWorld(world))
          changed.push(`pan ${p.toFixed(2)}`)
        }
        if (changed.length === 0)
          return fail('set_track_props: provide at least one of locked / muted / solo / hidden / volume / pan')
        return ok(`Track ${trackId}: ${changed.join(', ')}`, { trackId })
      }

      case 'apply_color_grade': {
        // G1 v1: named looks composed from the EXISTING filter primitives —
        // they ride the same Pixi preview + export path as manual filters.
        // Applying a grade REPLACES the grade-managed filter types (so
        // noir's grayscale can't bleed into a later warm); grade 'none'
        // clears them. Blur and blend modes are untouched.
        if (!tl()) return fail('No timeline')
        const { clipId, grade, intensity } = args as { clipId: string; grade: string; intensity?: number }
        let found: CL | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            found = c
            break
          }
        }
        if (!found) return fail(`Clip ${clipId} not found`)
        const { resolveGradeFilters, getColorGrade, GRADE_FILTER_TYPES, COLOR_GRADES } =
          await import('@/lib/edit-engines/color-grades')
        const isNone = grade === 'none'
        const resolved = isNone ? [] : resolveGradeFilters(grade, intensity)
        if (resolved === null) {
          return fail(`Unknown grade "${grade}". Available: none, ${COLOR_GRADES.map((g) => g.id).join(', ')}`)
        }
        const managed = new Set<string>(GRADE_FILTER_TYPES)
        const clearedTypes = found.filters.filter((f) => managed.has(f.type)).map((f) => f.type)
        const kept = found.filters.filter((f) => !managed.has(f.type))
        const nextFilters = [...kept, ...resolved]
        setTimeline({
          tracks: tl()!.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => (c.id === clipId ? { ...c, filters: nextFilters } : c)),
          })),
        })
        // Renderer parity via the effect actions the reducers already speak:
        // remove each previously-managed type, add each resolved filter.
        for (const ft of clearedTypes) {
          emitAgentAction({ type: 'effect/remove', params: { clipId, filterType: ft } }, emitterDepsForWorld(world))
        }
        for (const f of resolved) {
          emitAgentAction({ type: 'effect/add', params: { clipId, filter: f } }, emitterDepsForWorld(world))
        }
        const gradeName = isNone ? 'none (cleared)' : (getColorGrade(grade)?.name ?? grade)
        return ok(
          isNone
            ? `Cleared color grade on clip ${clipId}`
            : `Applied "${gradeName}" grade to clip ${clipId} (${resolved.length} filter(s)${typeof intensity === 'number' ? `, intensity ${intensity}` : ''})`,
          { grade, filters: resolved, clearedTypes },
        )
      }

      case 'apply_color': {
        // Colorist grade: named knobs + wheels + curves + hue curves
        // + LUT, merged onto the clip's current grade and stored on `clip.grade`.
        // Applied INSIDE composite-frame so preview == export. Undoable via the
        // clip/setColorGrade reducer.
        if (!tl()) return fail('No timeline')
        const a = args as Record<string, unknown>
        const clipIds = Array.isArray(a.clipIds) ? (a.clipIds as string[]) : []
        if (clipIds.length === 0) return fail('apply_color requires clipIds')

        const { mergeClipGrade, gradeRenderTier, hasLut } = await import('@/lib/edit-engines/clip-grade')
        type Grade = import('@/lib/edit-engines/clip-grade').ClipColorGrade
        type GradeRenderTier = import('@/lib/edit-engines/clip-grade').GradeRenderTier
        const num = (k: string): number | undefined =>
          typeof a[k] === 'number' && Number.isFinite(a[k] as number) ? (a[k] as number) : undefined
        const points = (k: string): { x: number; y: number }[] | undefined => {
          const v = a[k]
          if (!Array.isArray(v)) return undefined
          const pts = (v as unknown[])
            .filter((p) => Array.isArray(p) && p.length >= 2)
            .map((p) => ({ x: Number((p as number[])[0]), y: Number((p as number[])[1]) }))
            .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
          return pts.length >= 2 ? pts : undefined
        }

        // Build the patch from named knobs (only set keys that were passed).
        const patch: Grade = {}
        for (const k of [
          'exposure',
          'contrast',
          'saturation',
          'vibrance',
          'temperature',
          'tint',
          'highlights',
          'shadows',
          'blacks',
          'whites',
          'vignette',
        ] as const) {
          const v = num(k)
          if (v !== undefined) patch[k] = v
        }
        // Wheels: hue + amount + per-zone luma/gamma/gain.
        const wheels: NonNullable<Grade['wheels']> = {}
        if (num('shadowsHue') !== undefined || num('shadowsAmount') !== undefined || num('shadowsLum') !== undefined) {
          wheels.shadows = {
            ...(num('shadowsHue') !== undefined ? { hue: num('shadowsHue') } : {}),
            ...(num('shadowsAmount') !== undefined ? { amount: num('shadowsAmount') } : {}),
            ...(num('shadowsLum') !== undefined ? { lum: num('shadowsLum') } : {}),
          }
        }
        if (num('midsHue') !== undefined || num('midsAmount') !== undefined || num('midsGamma') !== undefined) {
          wheels.mids = {
            ...(num('midsHue') !== undefined ? { hue: num('midsHue') } : {}),
            ...(num('midsAmount') !== undefined ? { amount: num('midsAmount') } : {}),
            ...(num('midsGamma') !== undefined ? { gamma: num('midsGamma') } : {}),
          }
        }
        if (num('highsHue') !== undefined || num('highsAmount') !== undefined || num('highsGain') !== undefined) {
          wheels.highlights = {
            ...(num('highsHue') !== undefined ? { hue: num('highsHue') } : {}),
            ...(num('highsAmount') !== undefined ? { amount: num('highsAmount') } : {}),
            ...(num('highsGain') !== undefined ? { gain: num('highsGain') } : {}),
          }
        }
        if (Object.keys(wheels).length > 0) patch.wheels = wheels
        // Curves.
        const curves: NonNullable<Grade['curves']> = {}
        const mc = points('masterCurve')
        const rc = points('redCurve')
        const gc = points('greenCurve')
        const bc = points('blueCurve')
        if (mc) curves.master = mc
        if (rc) curves.red = rc
        if (gc) curves.green = gc
        if (bc) curves.blue = bc
        if (Object.keys(curves).length > 0) patch.curves = curves
        // Hue curves.
        const hc = a.hueCurves as { targets?: unknown[] } | undefined
        if (hc && Array.isArray(hc.targets)) {
          const targets = hc.targets
            .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
            .filter((t) => typeof t.targetHue === 'number')
            .map((t) => ({
              targetHue: t.targetHue as number,
              ...(typeof t.hueShift === 'number' ? { hueShift: t.hueShift } : {}),
              ...(typeof t.satScale === 'number' ? { satScale: t.satScale } : {}),
              ...(typeof t.lumShift === 'number' ? { lumShift: t.lumShift } : {}),
            }))
          if (targets.length > 0) patch.hueCurves = { targets }
        }
        // LUT: parse + store the .cube up front so we capture its dimension and
        // surface an honest error rather than silently grading neutral.
        const lutArg = a.lut as { path?: string; strength?: number } | undefined
        if (lutArg) {
          if (lutArg.path) {
            try {
              const fs = await import('node:fs/promises')
              const os = await import('node:os')
              const path = await import('node:path')
              const { parseCubeLut } = await import('@/lib/edit-engines/cube-lut')
              const src = lutArg.path.replace(/^~(?=$|\/)/, os.homedir())
              const text = await fs.readFile(src, 'utf8')
              const parsed = parseCubeLut(text)
              if (!parsed) return fail(`Not a valid .cube 3D LUT: ${path.basename(src)}`)
              // Copy into project LUT storage so it survives saves.
              const lutDir = path.join(os.homedir(), '.dreambyte', 'luts')
              await fs.mkdir(lutDir, { recursive: true })
              const dest = path.join(lutDir, path.basename(src))
              if (path.resolve(src) !== path.resolve(dest)) await fs.copyFile(src, dest)
              patch.lut = {
                path: dest,
                dimension: parsed.dimension,
                ...(typeof lutArg.strength === 'number' ? { strength: lutArg.strength } : {}),
              }
            } catch (e) {
              return fail(`Could not load LUT "${lutArg.path}": ${(e as Error).message}`)
            }
          } else if (typeof lutArg.strength === 'number') {
            // strength-only re-blend of the existing LUT.
            patch.lut = { path: '', dimension: 0, strength: lutArg.strength }
          }
        }

        const reset = a.reset === true
        const graded: string[] = []
        const skipped: string[] = []
        // Track whether any RESULTING grade needs the WebGL tier (LUT / hue curves).
        // The honesty caveat below keys off the resulting clip grade, not the patch:
        // a clip that already carries a LUT stays webgl even when this call only
        // nudges a CSS-expressible knob.
        // Media clips (video/image) render the full two-tier grade. SCENE clips
        // (a media-asset scene = a video/image dropped on the timeline) render as an
        // iframe, which a WebGL pass can't sample — so they take the CSS tier only and
        // the LUT / hue-curve part is dropped. Track both so the message is honest.
        let anyMediaWebgl = false
        let anySceneLutHue = false
        const tracks = tl()!.tracks
        for (const clipId of clipIds) {
          let found: CL | null = null
          for (const t of tracks) {
            const c = t.clips.find((c) => c.id === clipId)
            if (c) {
              found = c
              break
            }
          }
          if (!found) {
            skipped.push(clipId)
            continue
          }
          if (found.sourceType !== 'video' && found.sourceType !== 'image' && found.sourceType !== 'scene') {
            skipped.push(clipId)
            continue
          }
          const nextGrade = mergeClipGrade(found.grade, patch, { reset })
          const isScene = found.sourceType === 'scene'
          const needsWebgl = gradeRenderTier(nextGrade) === 'webgl'
          if (needsWebgl && !isScene) anyMediaWebgl = true
          if (needsWebgl && isScene) anySceneLutHue = true
          setTimeline({
            tracks: tl()!.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => (c.id === clipId ? { ...c, grade: nextGrade } : c)),
            })),
          })
          emitAgentAction(
            { type: 'clip/setColorGrade', params: { clipId, grade: nextGrade } },
            emitterDepsForWorld(world),
          )
          graded.push(clipId)
        }

        if (graded.length === 0) {
          return fail(`No gradable clips found (skipped: ${skipped.join(', ') || 'none found'})`)
        }
        const tier: GradeRenderTier =
          anyMediaWebgl || anySceneLutHue ? 'webgl' : gradeRenderTier(mergeClipGrade(undefined, patch, { reset: true }))
        // HONESTY: the CSS tier applies inside the single composite seam.
        // On MEDIA clips the WebGL tier (LUT / hue curves) runs the SAME GPU shader pass
        // in BOTH the preview pool and the export host → preview == export. On SCENE
        // clips the iframe can't be a GL texture, so only the CSS grade renders and the
        // LUT / hue-curve part is dropped — say so rather than imply it shows.
        let note = ''
        if (anyMediaWebgl) {
          note +=
            ' — the LUT / hue-curve part renders through a GPU (WebGL2) color pass, applied ' +
            'identically in the editor preview and the MP4 export'
        }
        if (anySceneLutHue) {
          note +=
            ' — note: on a SCENE clip only the CSS grade (exposure/contrast/saturation/temperature/' +
            'wheels/curves) renders; the LUT / hue-curve part is NOT shown on a scene — apply those to a ' +
            'video/image clip instead'
        }
        return ok(
          `Applied color grade to ${graded.length} clip(s)${skipped.length ? ` (skipped ${skipped.length})` : ''}` +
            (hasLut(patch) ? ` with LUT` : '') +
            ` [render tier: ${tier}]` +
            note,
          { graded, skipped, tier },
        )
      }

      case 'marker': {
        // G3: markers already render/snap in the timeline UI — this makes
        // them agent-addressable ("drop a marker at every section start").
        // Merged add_timeline_marker + remove_timeline_marker.
        if (!tl()) return fail('No timeline')
        const { action } = args as { action: 'add' | 'remove' }
        if (action === 'add') {
          const { time, label, color } = args as { time: number; label?: string; color?: string }
          if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
            return fail('marker (add) requires a non-negative numeric `time` (seconds)')
          }
          const markerId = uuidv4()
          const marker = { id: markerId, time, ...(label ? { label } : {}), ...(color ? { color } : {}) }
          setTimeline({ markers: [...(tl()!.markers ?? []), marker] })
          emitAgentAction({ type: 'marker/add', params: { markerId, time, label, color } }, emitterDepsForWorld(world))
          return ok(`Added marker${label ? ` "${label}"` : ''} at ${time.toFixed(2)}s (id ${markerId})`)
        }
        if (action === 'remove') {
          const { markerId } = args as { markerId: string }
          if (!tl()!.markers?.find((m) => m.id === markerId)) return fail(`Marker ${markerId} not found`)
          setTimeline({ markers: (tl()!.markers ?? []).filter((m) => m.id !== markerId) })
          emitAgentAction({ type: 'marker/remove', params: { markerId } }, emitterDepsForWorld(world))
          return ok(`Removed marker ${markerId}`)
        }
        return fail(`marker requires action 'add' or 'remove' (got ${JSON.stringify(action)})`)
      }

      case 'set_master_volume': {
        // Program master gain (the mixer's Master fader). Linear 0..2 (+6 dB).
        const { volume } = args as { volume: number }
        if (typeof volume !== 'number' || !Number.isFinite(volume)) return fail('volume must be a number (0..2)')
        const v = Math.max(0, Math.min(2, volume))
        emitAgentAction({ type: 'audio/setMasterVolume', params: { volume: v } }, emitterDepsForWorld(world))
        return ok(`Set program master volume to ${v.toFixed(2)} (${(20 * Math.log10(v || 1e-6)).toFixed(1)} dB)`, {
          volume: v,
        })
      }

      case 'auto_cut_silence': {
        if (!tl()) return fail('No timeline')
        const { clipId, threshold, minSilenceMs, preview } = args as {
          clipId: string
          threshold?: number
          minSilenceMs?: number
          preview?: boolean
        }
        let found: CL | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            found = c
            break
          }
        }
        if (!found) return fail(`Clip ${clipId} not found`)
        try {
          const { autoCutSilenceForClip } = await import('@/lib/edit-engines/auto-cut-silence')
          const result = await autoCutSilenceForClip({
            clip: found,
            sourceUri: resolveClipAudioUri(world, found.sourceId),
            threshold,
            minSilenceMs,
          })
          if (preview === true) {
            return ok(
              `Detected ${result.spans.length} silent span(s); ${result.plan.actions.length} action(s) ready (savedSeconds=${result.plan.savedSeconds.toFixed(2)}). Re-run with preview:false to apply.`,
              {
                spans: result.spans,
                planActionCount: result.plan.actions.length,
                savedSeconds: result.plan.savedSeconds,
              },
            )
          }
          // Apply: dispatch each action against the same `world` via the
          // existing timeline tool plumbing. We don't go through the
          // renderer's `dispatchAction` here — the agent's world is
          // separate. Map each ActionInput to its matching tool name.
          let applied = 0
          for (const a of result.plan.actions) {
            const mapped = mapActionInputToToolCall(world, a)
            if (!mapped) continue
            const r = await executeTool(mapped.toolName, mapped.args, world)
            if (!r.success) {
              return fail(
                `auto_cut_silence: applied ${applied}/${result.plan.actions.length} before failure on ${mapped.toolName}: ${r.error}`,
              )
            }
            applied++
          }
          return ok(
            `Cut ${result.spans.length} silence(s); applied ${applied} action(s); saved ${result.plan.savedSeconds.toFixed(2)}s.`,
            { spans: result.spans, applied, savedSeconds: result.plan.savedSeconds },
          )
        } catch (err) {
          return fail(`auto_cut_silence failed: ${(err as Error).message}`)
        }
      }

      case 'cut_by_transcript': {
        // G2 v1: "delete the part where I say X." Transcribes the clip (same
        // engine as add_captions), matches the text at cue precision, and
        // reuses the silence-cut split/ripple plan. preview:true reports the
        // matches without mutating.
        if (!tl()) return fail('No timeline')
        const { clipId, text, language, prompt, padSeconds, preview } = args as {
          clipId: string
          text: string
          language?: string
          prompt?: string
          padSeconds?: number
          preview?: boolean
        }
        if (!text || typeof text !== 'string' || !text.trim()) {
          return fail('cut_by_transcript requires non-empty `text` (the spoken words to remove)')
        }
        let found: CL | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            found = c
            break
          }
        }
        if (!found) return fail(`Clip ${clipId} not found`)
        try {
          const { cutByTranscriptForClip } = await import('@/lib/edit-engines/transcript-cut')
          const result = await cutByTranscriptForClip({
            clip: found,
            sourceUri: resolveClipAudioUri(world, found.sourceId),
            text,
            padSeconds,
            transcribeOptions: { language, prompt },
          })
          if (result.matches.length === 0) {
            return ok(
              `No transcript match for "${text.slice(0, 80)}" (${result.cueCount} cue(s) transcribed). Nothing cut.`,
              { matches: [], cueCount: result.cueCount },
            )
          }
          const matchSummary = result.matches.map((m) => ({
            text: m.cues.map((c) => c.text).join(' '),
            span: m.span,
          }))
          if (preview === true) {
            const precisionNote =
              result.precision === 'word'
                ? 'Word-level precision — spans cover exactly the matched words.'
                : 'NOTE: cue-level precision — each match removes its full caption cue span.'
            return ok(
              `Matched ${result.matches.length} occurrence(s); ${result.plan.actions.length} action(s) ready (savedSeconds=${result.plan.savedSeconds.toFixed(2)}). ${precisionNote} Re-run with preview:false to apply.`,
              {
                matches: matchSummary,
                planActionCount: result.plan.actions.length,
                savedSeconds: result.plan.savedSeconds,
                precision: result.precision,
              },
            )
          }
          let applied = 0
          for (const a of result.plan.actions) {
            const mapped = mapActionInputToToolCall(world, a)
            if (!mapped) continue
            const r = await executeTool(mapped.toolName, mapped.args, world)
            if (!r.success) {
              return fail(
                `cut_by_transcript: applied ${applied}/${result.plan.actions.length} before failure on ${mapped.toolName}: ${r.error}`,
              )
            }
            applied++
          }
          return ok(
            `Cut ${result.matches.length} transcript match(es); applied ${applied} action(s); saved ${result.plan.savedSeconds.toFixed(2)}s.`,
            { matches: matchSummary, applied, savedSeconds: result.plan.savedSeconds },
          )
        } catch (err) {
          return fail(`cut_by_transcript failed: ${(err as Error).message}`)
        }
      }

      case 'add_captions': {
        if (!tl()) return fail('No timeline')
        const { clipId, subtitlesTrackId, language, prompt, preview } = args as {
          clipId: string
          subtitlesTrackId?: string
          language?: string
          prompt?: string
          preview?: boolean
        }
        let found: CL | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            found = c
            break
          }
        }
        if (!found) return fail(`Clip ${clipId} not found`)
        try {
          const { addCaptionsForClip } = await import('@/lib/edit-engines/add-captions')
          const result = await addCaptionsForClip({
            clip: found,
            sourceUri: resolveClipAudioUri(world, found.sourceId),
            subtitlesTrackId,
            transcribeOptions: { language, prompt },
          })
          if (preview === true) {
            return ok(
              `Transcribed ${result.cues.length} cue(s); ${result.plan.actions.length} action(s) ready (totalSeconds=${result.plan.totalSeconds.toFixed(2)}). Re-run with preview:false to apply.`,
              {
                cues: result.cues,
                planActionCount: result.plan.actions.length,
                totalSeconds: result.plan.totalSeconds,
                trackId: result.plan.trackId,
                language: result.language,
              },
            )
          }
          // Apply each action. We track the real track id created by
          // add_track and rewrite trackId references in subsequent
          // place_clip calls — the planner used a temporary id that the
          // existing add_track tool ignores.
          let applied = 0
          let realTrackId: string | null = subtitlesTrackId ?? null
          const plannerTrackId = result.plan.trackId
          for (const a of result.plan.actions) {
            // Patch the trackId in clip/add payloads if we've discovered
            // the real one (because the planner emitted a fresh id we
            // had to remap).
            const patched: import('@/lib/actions').ActionInput =
              a.type === 'clip/add' && realTrackId && (a.params as { trackId: string }).trackId === plannerTrackId
                ? ({
                    type: 'clip/add',
                    params: {
                      ...(a.params as object),
                      trackId: realTrackId,
                      clip: {
                        ...(a.params as { clip: import('@/lib/types').Clip }).clip,
                        trackId: realTrackId,
                      },
                    },
                  } as import('@/lib/actions').ActionInput)
                : a
            const mapped = mapActionInputToToolCall(world, patched)
            if (!mapped) continue
            const r = await executeTool(mapped.toolName, mapped.args, world)
            if (!r.success) {
              return fail(
                `add_captions: applied ${applied}/${result.plan.actions.length} before failure on ${mapped.toolName}: ${r.error}`,
              )
            }
            if (a.type === 'track/add' && r.data && typeof (r.data as { trackId?: unknown }).trackId === 'string') {
              realTrackId = (r.data as { trackId: string }).trackId
            }
            applied++
          }
          return ok(
            `Added ${result.cues.length} caption(s) onto track ${realTrackId ?? plannerTrackId}; ${applied} action(s) applied; ${result.plan.totalSeconds.toFixed(2)}s of cue text.`,
            { cues: result.cues, applied, trackId: realTrackId, language: result.language },
          )
        } catch (err) {
          return fail(`add_captions failed: ${(err as Error).message}`)
        }
      }

      case 'auto_reframe': {
        if (!tl()) return fail('No timeline')
        const { clipId, maxKeyframes, smoothing, minConfidence, fps, preview } = args as {
          clipId: string
          maxKeyframes?: number
          smoothing?: number
          minConfidence?: number
          fps?: number
          preview?: boolean
        }
        let found: CL | null = null
        for (const t of tl()!.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            found = c
            break
          }
        }
        if (!found) return fail(`Clip ${clipId} not found`)
        const dims = resolveProjectDimensions(world.mp4Settings?.aspectRatio, world.mp4Settings?.resolution)
        try {
          const { autoReframeForClip } = await import('@/lib/edit-engines/auto-reframe')
          const result = await autoReframeForClip({
            clip: found,
            sourceUri: found.sourceId,
            targetWidth: dims.width,
            targetHeight: dims.height,
            maxKeyframes,
            smoothing,
            minConfidence,
            detectOptions: { fps },
          })
          if (preview === true) {
            return ok(
              `Tracked ${result.detectionCount} detection(s); ${result.actions.length} keyframe(s) planned across x/y. Re-run with preview:false to apply.`,
              {
                detectionCount: result.detectionCount,
                planActionCount: result.actions.length,
                keyframes: result.keyframes,
                sourceWidth: result.sourceWidth,
                sourceHeight: result.sourceHeight,
              },
            )
          }
          let applied = 0
          for (const a of result.actions) {
            const mapped = mapActionInputToToolCall(world, a)
            if (!mapped) continue
            const r = await executeTool(mapped.toolName, mapped.args, world)
            if (!r.success) {
              return fail(
                `auto_reframe: applied ${applied}/${result.actions.length} before failure on ${mapped.toolName}: ${r.error}`,
              )
            }
            applied++
          }
          return ok(
            `Reframed clip ${clipId} via ${result.detectionCount} detection(s); applied ${applied} keyframe(s).`,
            { detectionCount: result.detectionCount, applied },
          )
        } catch (err) {
          return fail(`auto_reframe failed: ${(err as Error).message}`)
        }
      }

      case 'sync_audio': {
        if (!tl()) return fail('No timeline')
        const { referenceClipId, targetClipId, targetClipIds, searchWindowSeconds, minConfidence, preview } = args as {
          referenceClipId: string
          targetClipId?: string
          targetClipIds?: string[]
          searchWindowSeconds?: number
          minConfidence?: number
          preview?: boolean
        }
        if (!referenceClipId || typeof referenceClipId !== 'string') {
          return fail('sync_audio requires referenceClipId')
        }
        // Collect requested targets (array + single), dedupe, drop the reference.
        const targetIds = Array.from(
          new Set([...(Array.isArray(targetClipIds) ? targetClipIds : []), ...(targetClipId ? [targetClipId] : [])]),
        ).filter((id) => id && id !== referenceClipId)
        if (targetIds.length === 0) return fail('sync_audio: provide targetClipId or targetClipIds.')

        const locate = (id: string): { clip: CL; track: TK } | null => {
          for (const t of tl()!.tracks) {
            const c = t.clips.find((c) => c.id === id)
            if (c) return { clip: c, track: t }
          }
          return null
        }
        const refLoc = locate(referenceClipId)
        if (!refLoc) return fail(`Reference clip ${referenceClipId} not found`)

        try {
          const { computeAudioSyncOffset } = await import('@/lib/edit-engines/audio-sync')
          const { buildAudioUrlMap } = await import('@/lib/audio/audio-url-map')
          // Scene-mirror clips (aud-/tts-/mus-/sfx/avatar-audio) carry synthetic
          // source ids the PCM decoder can't open; resolve them to the real URL
          // from the scene's audioLayer. Imported file/upload clips already hold a
          // decodable URI in sourceId — fall back to it.
          const urlMap = buildAudioUrlMap(world.scenes)
          const resolveSource = (c: CL): string | undefined => urlMap.get(c.sourceId) || c.sourceId
          const synced: { clipId: string; offsetSeconds: number; confidence: number }[] = []
          const failed: { clipId: string; reason: string }[] = []

          // Track occupied [start,end) intervals per track so a synced follower
          // can't be stacked on the reference OR on a sibling synced earlier in
          // this batch. Audio tracks are 'allow' overlap policy, so move_clip
          // won't stop it — we enforce no-overlap here. Seed with the reference
          // (it stays put). The reference never moves, so this stays accurate.
          const occupied = new Map<string, { start: number; end: number }[]>([
            [refLoc.track.id, [{ start: refLoc.clip.startTime, end: refLoc.clip.startTime + refLoc.clip.duration }]],
          ])
          const overlapsOccupied = (trackId: string, start: number, end: number): boolean =>
            (occupied.get(trackId) ?? []).some((iv) => start < iv.end && iv.start < end)
          const reserve = (trackId: string, start: number, end: number): void => {
            const ivs = occupied.get(trackId) ?? []
            ivs.push({ start, end })
            occupied.set(trackId, ivs)
          }

          for (const id of targetIds) {
            const tgtLoc = locate(id)
            if (!tgtLoc) {
              failed.push({ clipId: id, reason: 'clip not found' })
              continue
            }
            // Already-linked clips move together — refusing avoids a self-collision.
            if (tgtLoc.clip.linkGroupId && tgtLoc.clip.linkGroupId === refLoc.clip.linkGroupId) {
              failed.push({ clipId: id, reason: 'clip is linked to the reference — they already move together.' })
              continue
            }
            const result = await computeAudioSyncOffset(refLoc.clip, tgtLoc.clip, {
              searchWindowSeconds,
              minConfidence,
              resolveSource,
            })
            if (!result.matched) {
              failed.push({ clipId: id, reason: result.reason ?? 'no confident alignment' })
              continue
            }
            // Refuse a synced position that would overlap an existing clip on the
            // destination track — the reference, or a sibling synced earlier in
            // this batch. Audio tracks allow overlap, so move_clip would silently
            // stack them; the follower needs its own lane first. (The link-group
            // guard above only catches clips that already share a linkGroupId.)
            const newStart = result.newStartTime
            const newEnd = newStart + tgtLoc.clip.duration
            if (overlapsOccupied(tgtLoc.track.id, newStart, newEnd)) {
              failed.push({
                clipId: id,
                reason:
                  'synced position would overlap another clip (the reference or an already-synced ' +
                  'follower) on its track — move the follower to its own audio track first, then sync.',
              })
              continue
            }
            // Reserve the slot so a later follower in this batch can't stack on it.
            reserve(tgtLoc.track.id, newStart, newEnd)
            if (preview === true) {
              synced.push({ clipId: id, offsetSeconds: result.offsetSeconds, confidence: result.confidence })
              continue
            }
            // Apply via move_clip so the move rides the shared write-through
            // (link-group siblings, overlap rules, scene write-back, action log).
            const mv = await executeTool(
              'move_clip',
              { clipId: id, toTrackId: tgtLoc.track.id, startTime: result.newStartTime },
              world,
            )
            if (!mv.success) {
              failed.push({ clipId: id, reason: `move rejected: ${mv.error}` })
              continue
            }
            synced.push({ clipId: id, offsetSeconds: result.offsetSeconds, confidence: result.confidence })
          }

          if (synced.length === 0) {
            return fail(`sync_audio: ${failed[0]?.reason ?? 'no clips aligned'}`)
          }
          const verb = preview === true ? 'Would sync' : 'Synced'
          return ok(
            `${verb} ${synced.length} clip(s) to ${referenceClipId}${
              failed.length ? `; ${failed.length} refused` : ''
            }.`,
            { referenceClipId, synced, failed: failed.length ? failed : undefined, preview: preview === true },
          )
        } catch (err) {
          return fail(`sync_audio failed: ${(err as Error).message}`)
        }
      }

      default:
        return fail(`Unknown timeline tool: ${toolName}`)
    }
  }
}
