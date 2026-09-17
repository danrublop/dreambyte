'use client'

import { v4 as uuidv4 } from 'uuid'
import type { Track, TrackType, Clip, Timeline, Scene } from '../types'
import {
  findClip,
  linkedClipIds,
  removeLinkedClips,
  shiftLinkedClips,
  trimLinkedClips,
  unlinkGroupInTimeline,
  linkClipsInTimeline,
} from './link-groups'
import type { Set, Get } from './types'
import { canTrackAcceptClip, clampToAvoidOverlap, getTrackClipBounds } from '@/lib/timeline/snap-engine'
import { rangesOverlap } from '@/lib/timeline/overlap'
import { normalizeTrackNames, pickTrackForClip, trackTypeForSource } from '@/lib/timeline/track-naming'
import { materializeSceneAudio, sfxLaneIndex } from '@/lib/audio/scene-audio-materializer'
import type { SceneAudioLane } from '@/lib/audio/scene-audio-materializer'
import { cascadeClipSourceMutations, makeSceneClipCascadeFilter } from '@/lib/actions/reducers/scene-clip-cascade'
import { applyClipMoveWriteThrough } from '@/lib/actions/apply-clip-move-write-through'
import { resolvePasteDelta, type Span } from './timeline-clipboard'

/**
 * B4 (v6 TIMELINE): build a new Timeline with `tracks` swapped in while
 * PRESERVING every other field — markers, inPoint, outPoint, and any future
 * optional Timeline field — via spread. The pre-B4 sites wrote
 * `timeline: { tracks }`, which typechecks as a full Timeline (the other fields
 * are optional) and SILENTLY WIPED markers/inPoint/outPoint on every track/clip
 * mutation. Routing all track-replacing writes through this helper makes the
 * preservation structural and impossible to forget.
 */
export function withTracks(tl: Timeline | null | undefined, tracks: Track[]): Timeline {
  return { ...(tl ?? { tracks: [] }), tracks }
}

/**
 * v6 review (LOW): markers / inPoint / outPoint are LOCAL UI metadata (work-area
 * + bookmarks). When a refresh replaces the store timeline with the server blob —
 * e.g. the post-agent-run refresh, where the persisted timeline is the run-start
 * seed plus the agent's track edits — a marker the user dropped DURING the run is
 * on the server blob's run-start marker set, so the refresh would drop it.
 *
 * Union local-only markers (by id) into the server timeline so a mid-run/local
 * bookmark survives the refresh, while the server's markers (incl. any the agent
 * added, persisted into the blob) still win on shared ids. inPoint/outPoint fall
 * back to the local value when the server omits them. Same spirit as the
 * theme/uiTypography local-preserve already in refreshProjectFromServer. Pure.
 *
 * Returns `server` unchanged when there's nothing local to preserve (so a normal
 * refresh with no local timeline is byte-identical to before).
 */
export function preserveLocalTimelineMeta(
  server: Timeline | null,
  current: Timeline | null | undefined,
): Timeline | null {
  if (!server || !current) return server
  const serverMarkers = (server.markers ?? []) as Array<{ id?: string }>
  const localMarkers = (current.markers ?? []) as Array<{ id?: string }>
  const serverIds = new Set(serverMarkers.map((m) => m?.id).filter((id): id is string => typeof id === 'string'))
  // Local markers whose id the server doesn't have = local-only (e.g. added mid-run).
  const localOnly = localMarkers.filter((m) => typeof m?.id === 'string' && !serverIds.has(m.id as string))
  const mergedMarkers = localOnly.length > 0 ? [...serverMarkers, ...localOnly] : server.markers
  return {
    ...server,
    ...(mergedMarkers !== undefined ? { markers: mergedMarkers } : {}),
    inPoint: server.inPoint ?? current.inPoint,
    outPoint: server.outPoint ?? current.outPoint,
  } as Timeline
}

export function createTimelineActions(set: Set, get: Get) {
  return {
    getTimeline: () => get().project.timeline ?? null,

    /**
     * B2 (v6 TIMELINE): apply the timeline an agent run produced. MERGES rather
     * than replaces — the incoming agent timeline is spread OVER the current one
     * so any renderer-only field the agent didn't carry (markers/inPoint/
     * outPoint) survives, while the agent's authoritative tracks/clips win.
     * Schedules a project save so the applied timeline persists across reload.
     * No-op when `timeline` is null (a scene-only run sends nothing here).
     */
    applyAgentTimeline: (timeline: Timeline | null | undefined) => {
      if (!timeline) return
      set((state) => {
        const current = state.project.timeline ?? null
        // Spread current first (keeps inPoint/outPoint/markers the agent may
        // have dropped), then the agent's timeline (its tracks + any markers it
        // edited win). Tracks come last via withTracks so they're never lost to
        // an undefined on the incoming object.
        const merged = withTracks({ ...(current ?? {}), ...timeline }, timeline.tracks ?? current?.tracks ?? [])
        return {
          _isDirty: true,
          project: { ...state.project, timeline: merged, updatedAt: new Date().toISOString() },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    initTimeline: (force?: boolean) => {
      const state = get()
      if (state.project.timeline && !force) return
      const scenes = state.scenes

      const v1Id = uuidv4()
      const v2Id = uuidv4()
      const a1Id = uuidv4()
      const a2Id = uuidv4()
      const a3Id = uuidv4()

      // Three audio lanes by role so they don't pile onto one track: A1 voice
      // (narration/file audio), A2 music, A3 sound effects.
      const tracks: Track[] = [
        { id: v1Id, name: 'V1', type: 'video', clips: [], muted: false, locked: false, position: 0 },
        { id: v2Id, name: 'V2', type: 'video', clips: [], muted: false, locked: false, position: 1 },
        { id: a1Id, name: 'A1', type: 'audio', clips: [], muted: false, locked: false, position: 2 },
        { id: a2Id, name: 'A2', type: 'audio', clips: [], muted: false, locked: false, position: 3 },
        { id: a3Id, name: 'A3', type: 'audio', clips: [], muted: false, locked: false, position: 4 },
      ]

      const makeClip = (
        trackId: string,
        sourceType: 'scene' | 'audio' | 'video' | 'title',
        sourceId: string,
        label: string,
        startTime: number,
        duration: number,
      ): Clip => ({
        id: uuidv4(),
        trackId,
        sourceType,
        sourceId,
        label,
        startTime,
        duration,
        trimStart: 0,
        trimEnd: null,
        speed: 1,
        opacity: 1,
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        filters: [],
        keyframes: [],
      })

      // Audio lane → track. A1 voice / A2 music are fixed; SFX cascade across
      // A3, A4, A5… (lane rules live in materializeSceneAudio, shared with
      // syncTimelineFromScenes so the two can't drift). Extra SFX tracks are
      // minted lazily when overlapping SFX demand them; empties are pruned below.
      const sfxLaneTracks: Track[] = [tracks[4]] // A3 is SFX sub-lane 0
      const trackForLane = (lane: SceneAudioLane): Track => {
        if (lane === 'a1') return tracks[2]
        if (lane === 'a2') return tracks[3]
        const idx = sfxLaneIndex(lane)
        while (sfxLaneTracks.length <= idx) {
          const t: Track = {
            id: uuidv4(),
            name: `A${3 + sfxLaneTracks.length}`,
            type: 'audio',
            clips: [],
            muted: false,
            locked: false,
            position: tracks.length,
          }
          sfxLaneTracks.push(t)
          tracks.push(t)
        }
        return sfxLaneTracks[idx]
      }

      let acc = 0
      for (const scene of scenes) {
        // V1: scene clips
        const sceneClip = makeClip(v1Id, 'scene', scene.id, scene.name || 'Untitled', acc, scene.duration)
        if (scene.transition && scene.transition !== 'none') {
          sceneClip.transition = { type: scene.transition, duration: 0.5 }
        }
        tracks[0].clips.push(sceneClip)

        for (const spec of materializeSceneAudio(scene)) {
          const track = trackForLane(spec.lane)
          const clip = makeClip(track.id, 'audio', spec.sourceId, spec.label, acc + spec.offset, spec.duration)
          if (spec.linkGroupId) clip.linkGroupId = spec.linkGroupId
          track.clips.push(clip)
        }

        acc += scene.duration
      }

      // Remove empty audio tracks (but keep all default tracks when no scenes exist)
      const finalTracks = scenes.length === 0 ? tracks : tracks.filter((t) => t.type === 'video' || t.clips.length > 0)
      // Ensure at least one audio track exists
      if (!finalTracks.some((t) => t.type === 'audio')) {
        finalTracks.push({ id: a1Id, name: 'A1', type: 'audio', clips: [], muted: false, locked: false, position: 1 })
      }
      // Re-number positions
      finalTracks.forEach((t, i) => {
        t.position = i
      })

      set((state) => ({
        project: {
          ...state.project,
          timeline: withTracks(state.project.timeline, finalTracks),
          updatedAt: new Date().toISOString(),
        },
      }))
      get().scheduleSaveProjectToDb()
    },

    syncTimelineFromScenes: () => {
      // Re-derive timeline clips from current scenes, preserving user edits
      const state = get()
      const tl = state.project.timeline
      if (!tl) {
        get().initTimeline()
        return
      }

      // Find V1 track (lowest position video track) and update scene clips
      const v1 = tl.tracks
        .slice()
        .sort((a, b) => a.position - b.position)
        .find((t) => t.type === 'video')
      if (!v1) return

      // Find or create audio tracks — A1 voice, A2 music, A3 SFX (kept on
      // separate lanes so SFX never pile onto the music track).
      //
      // ROLE-FIRST binding: each lane binds to the track that already holds its
      // clips, so a user-reordered timeline, a legacy pre-A3 layout, or an
      // appended avatar-audio track can't re-map narration/music/SFX onto the
      // wrong physical track. Only unbound roles fall back to position order,
      // and the fallback skips avatar-owned tracks (avatar mirroring manages
      // those itself).
      const audioTracksByPos = tl.tracks.filter((t) => t.type === 'audio').sort((a, b) => a.position - b.position)
      const sceneSfxIds = new Set(state.scenes.flatMap((s) => (s.audioLayer?.sfx ?? []).map((fx) => fx.id)))
      const isAvatarOwned = (t: Track) =>
        t.clips.some((c) => typeof c.linkGroupId === 'string' && c.linkGroupId.startsWith('avatar:'))
      let a1 = audioTracksByPos.find((t) => t.clips.some((c) => /^(aud-|tts-)/.test(c.sourceId)))
      let a2 = audioTracksByPos.find((t) => t !== a1 && t.clips.some((c) => /^mus-/.test(c.sourceId)))
      // SFX lanes: every audio track holding ONLY scene-SFX clips (A3, A4, A5…),
      // in position order. Overlapping SFX cascade across them (assigned by
      // materializeSceneAudio). A clip counts as scene-SFX if it's a current SFX
      // OR carries the `scene-sfx:` ownership marker — so a lane still holding a
      // just-deleted SFX is recognized (and its orphan cleaned + lane pruned)
      // instead of being mistaken for a user track. A legacy single-SFX-track
      // layout binds just A3.
      const isSceneSfxClip = (c: Clip) =>
        sceneSfxIds.has(c.sourceId) || (typeof c.linkGroupId === 'string' && c.linkGroupId.startsWith('scene-sfx:'))
      let sfxTracks = audioTracksByPos.filter(
        (t) => t !== a1 && t !== a2 && t.clips.length > 0 && t.clips.every(isSceneSfxClip),
      )
      const unbound = audioTracksByPos.filter(
        (t) => t !== a1 && t !== a2 && !sfxTracks.includes(t) && !isAvatarOwned(t),
      )
      a1 = a1 ?? unbound.shift()
      a2 = a2 ?? unbound.shift()
      // Keep the standard layout: A3 exists even before any SFX (mirrors the old
      // a3 unbound fallback). Extra cascade lanes are minted on demand below.
      if (sfxTracks.length === 0) {
        const fallback = unbound.shift()
        if (fallback) sfxTracks = [fallback]
      }
      const a1Id = a1?.id ?? uuidv4()
      const a2Id = a2?.id ?? uuidv4()
      // Ordered SFX track ids — index = SFX sub-lane (sfxTrackIds[0] = A3). Grows
      // as overlapping SFX demand new lanes; minted ids materialize as tracks below.
      const sfxTrackIds: string[] = sfxTracks.map((t) => t.id)
      if (sfxTrackIds.length === 0) sfxTrackIds.push(uuidv4()) // reserve A3
      const a3Id = sfxTrackIds[0]
      const sfxTrackIdFor = (laneIdx: number): string => {
        while (sfxTrackIds.length <= laneIdx) sfxTrackIds.push(uuidv4())
        return sfxTrackIds[laneIdx]
      }
      const sfxExistingIds = new Set(sfxTracks.map((t) => t.id))

      const makeClip = (
        trackId: string,
        sourceType: 'scene' | 'audio' | 'video' | 'title' | 'avatar',
        sourceId: string,
        label: string,
        startTime: number,
        duration: number,
      ): Clip => ({
        id: uuidv4(),
        trackId,
        sourceType,
        sourceId,
        label,
        startTime,
        duration,
        trimStart: 0,
        trimEnd: null,
        speed: 1,
        opacity: 1,
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        filters: [],
        keyframes: [],
      })

      // TIMELINE-AUTHORITATIVE (Phase 0 — see docs/TIMELINE_AUTHORITATIVE.md):
      // The V1 sequence owns clip positions. We no longer re-pack scene clips
      // gapless on every sync — an existing scene clip KEEPS its startTime, so a
      // user move / gap / reorder persists, and dragging a clip off V1 leaves a
      // real hole instead of the neighbours sliding in to fill it. Only a
      // brand-new scene (no clip yet) is materialized, appended gaplessly after
      // the current last V1 clip so the agent's "create scene" stays sequential.
      // Playback order is DERIVED from V1 clip startTime (getSequenceOrder), not
      // from state.scenes. Linked scene audio (a1/a2/a3), avatars, and text
      // overlays hang off each scene clip's (preserved or appended) start, so
      // they travel with their scene for free.
      const existingSceneClips = v1.clips.filter((c) => c.sourceType === 'scene')
      let appendCursor = existingSceneClips.reduce(
        (max, c) => Math.max(max, c.startTime + (Number.isFinite(c.duration) ? c.duration : 0)),
        0,
      )
      // Scene clips that the user dragged OFF V1 onto a second video lane (V2+).
      // They composite over the V1 gap they left behind. We must recognise them
      // so the loop below does NOT re-materialize a phantom V1 duplicate for a
      // scene whose clip already lives on V2 — they're preserved in place by
      // `trimmedExistingTracks`. Keyed by sourceId (one clip per scene today).
      const offV1SceneClips = new Map<string, Clip>()
      for (const t of tl.tracks) {
        if (t.type !== 'video' || t.id === v1.id) continue
        for (const c of t.clips) {
          if (c.sourceType === 'scene') offV1SceneClips.set(c.sourceId, c)
        }
      }
      // Start of the nearest existing scene clip that begins strictly after
      // `start` — the wall a grown duration can't cross (NLE edge-trim: you
      // butt-join the next clip, you don't overlap it). Infinity if none.
      const nextSceneStartAfter = (start: number): number => {
        let next = Infinity
        for (const c of existingSceneClips) {
          if (c.startTime > start && c.startTime < next) next = c.startTime
        }
        return next
      }

      const newSceneClips: Clip[] = []
      const newA1Clips: Clip[] = []
      const newA2Clips: Clip[] = []
      const newSfxByLane: Clip[][] = [] // [subLaneIdx] → fresh/reused clips for that SFX track

      // Per-lane sourceId→clip maps, built ONCE — the old per-spec Array.find
      // inside the scene loop was O(scenes²) on the editor hot path. SFX also
      // search legacy A2 (clips placed before SFX got their own track).
      const byId = (t: Track | undefined) => new Map((t?.clips ?? []).map((c) => [c.sourceId, c]))
      const a1ById = byId(a1)
      const a2ById = byId(a2)
      // One combined SFX map across all lanes — a SFX sourceId is unique, so its
      // clip identity (id, trims) is reused no matter which lane it now packs onto.
      const sfxById = new Map<string, Clip>()
      for (const t of sfxTracks) for (const c of t.clips) sfxById.set(c.sourceId, c)

      for (const scene of state.scenes) {
        // All of this scene's V1 clips, earliest first. After a split there are
        // N (left, right, …) sharing one sourceId. The PRIMARY (earliest) is
        // reconciled below; the rest are carried through unchanged so a sync
        // after a split never drops the right half. Audio anchors to the primary.
        const sceneV1Clips = v1.clips
          .filter((c) => c.sourceId === scene.id && c.sourceType === 'scene')
          .sort((a, b) => a.startTime - b.startTime)
        const existing = sceneV1Clips[0]
        // The scene's clip wherever it lives: on V1 (`existing`) or dragged up
        // to V2 (`offV1`). `anchorClip` is whichever — audio/avatar/text anchor
        // to its start. A scene with neither is brand-new → materialize on V1.
        const offV1 = existing ? undefined : offV1SceneClips.get(scene.id)
        const anchorClip = existing ?? offV1

        // Duration follows the scene, except a user-trimmed clip keeps its
        // trimmed length. Sanitize it: a NaN/0/negative duration (e.g. an
        // unguarded set_scene_duration writing NaN, which survives
        // Math.max(3, Math.min(30, NaN))) must be contained to THIS scene.
        const clipTransition =
          scene.transition && scene.transition !== 'none' ? { type: scene.transition, duration: 0.5 } : null
        const rawDuration =
          anchorClip && !(anchorClip.trimStart === 0 && anchorClip.trimEnd === null)
            ? anchorClip.duration
            : scene.duration
        let sceneDuration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0

        // Position: an existing clip keeps its place (timeline-authoritative);
        // a new scene appends at the end of the V1 sequence. Audio/avatar/text
        // below anchor to this sceneStart. A scene on V2 anchors to its V2 clip
        // and does NOT advance the V1 append cursor.
        const sceneStart = anchorClip ? anchorClip.startTime : appendCursor
        if (!anchorClip) appendCursor += sceneDuration

        // Edge-trim clamp: a V1 clip whose duration now reaches into the next V1
        // clip is butt-joined to it rather than overlapping (NLE trim). A shorter
        // duration just leaves a gap; neighbours never auto-shift. (Off-V1 clips
        // aren't part of the V1 wall logic.)
        if (existing) {
          const wall = nextSceneStartAfter(sceneStart)
          const maxDuration = wall - sceneStart
          if (Number.isFinite(maxDuration) && maxDuration > 0 && sceneDuration > maxDuration) {
            sceneDuration = maxDuration
          }
        }

        if (existing) {
          newSceneClips.push({
            ...existing,
            startTime: sceneStart,
            duration: sceneDuration,
            label: scene.name || existing.label,
            transition: clipTransition ?? existing.transition,
          })
        } else if (offV1) {
          // Scene lives on a non-V1 video lane (V2): its clip is preserved in
          // place by trimmedExistingTracks. Do NOT re-materialize a phantom on
          // V1 — that was the exact duplicate the old reject-guard feared. The
          // audio block below still runs, anchored to the V2 clip's start.
        } else {
          const newClip = makeClip(v1.id, 'scene', scene.id, scene.name || 'Untitled', sceneStart, sceneDuration)
          if (clipTransition) newClip.transition = clipTransition
          newSceneClips.push(newClip)
        }

        // Carry through split siblings (the non-primary V1 clips of this scene)
        // unchanged — they keep their own trims/positions. Without this, a sync
        // after splitClip would drop every half but the first.
        for (const sibling of sceneV1Clips.slice(1)) {
          newSceneClips.push({ ...sibling, label: scene.name || sibling.label })
        }

        // Audio lanes — lane rules live in materializeSceneAudio (shared with
        // initTimeline). Sync's job is placement + clip-identity reuse: find
        // an existing clip by sourceId on the lane's bound track and override
        // per the spec's reuse mode ('position' keeps a TTS clip's duration —
        // a user trim survives syncs; 'position+duration' tracks the scene).
        // SFX also searches legacy A2 so clips placed before SFX got their own
        // track migrate cleanly; reuse retro-stamps their ownership marker.
        const laneTrackId = (lane: SceneAudioLane): string =>
          lane === 'a1' ? a1Id : lane === 'a2' ? a2Id : sfxTrackIdFor(sfxLaneIndex(lane))
        const laneExisting = (lane: SceneAudioLane, sourceId: string): Clip | null => {
          if (lane === 'a1') return a1ById.get(sourceId) ?? null
          if (lane === 'a2') return a2ById.get(sourceId) ?? null
          // SFX: combined map + legacy clips that lived on A2 (pre-SFX-lane migrate).
          return sfxById.get(sourceId) ?? a2ById.get(sourceId) ?? null
        }
        const laneOutPush = (lane: SceneAudioLane, clip: Clip): void => {
          if (lane === 'a1') newA1Clips.push(clip)
          else if (lane === 'a2') newA2Clips.push(clip)
          else {
            const idx = sfxLaneIndex(lane)
            while (newSfxByLane.length <= idx) newSfxByLane.push([])
            newSfxByLane[idx].push(clip)
          }
        }
        for (const spec of materializeSceneAudio(scene)) {
          const existing = laneExisting(spec.lane, spec.sourceId)
          const startTime = sceneStart + spec.offset
          if (existing) {
            const reused: Clip = { ...existing, trackId: laneTrackId(spec.lane), startTime }
            if (spec.reuse === 'position+duration') {
              reused.duration = spec.duration
            } else {
              // reuse:'position' (TTS): a clip the USER manually trimmed keeps
              // its chosen length (still clamped so it can't overrun the scene).
              // But a clip that was only ever auto-sized (trimStart
              // 0, trimEnd null) tracks the narration's scene-bounded natural
              // length: growing a scene AFTER narration was generated must
              // re-expand the clip up to the audio length instead of staying
              // pinned to the old, shorter scene duration (the "audio outlives
              // its clip" bug). spec.duration is already min(tts.duration,
              // scene), so an untrimmed clip never exceeds the audio, and a
              // shortened scene still shrinks it.
              const userTrimmed = (reused.trimStart ?? 0) > 0 || reused.trimEnd != null
              reused.duration = userTrimmed ? Math.min(reused.duration, spec.duration) : spec.duration
            }
            if (spec.linkGroupId) reused.linkGroupId = spec.linkGroupId
            laneOutPush(spec.lane, reused)
          } else {
            const clip = makeClip(laneTrackId(spec.lane), 'audio', spec.sourceId, spec.label, startTime, spec.duration)
            if (spec.linkGroupId) clip.linkGroupId = spec.linkGroupId
            laneOutPush(spec.lane, clip)
          }
        }
      }

      // Preserve user-chosen tracks AND clip identity across syncs. Time is
      // sourced from av.startAt (moveClip writes the moved position back to
      // the layer); the snapshot below also retains the existing clip ids so
      // React keys / selection / inspector pointers stay stable when the
      // avatar clip pair is re-emitted below.
      const isAvatarLinked = (c: Clip) => typeof c.linkGroupId === 'string' && c.linkGroupId.startsWith('avatar:')
      // Text overlays are mirrored as single V-track clips (linkGroupId text:<id>).
      const isTextLinked = (c: Clip) => typeof c.linkGroupId === 'string' && c.linkGroupId.startsWith('text:')
      const isMirroredLinked = (c: Clip) => isAvatarLinked(c) || isTextLinked(c)
      const priorAvatarTracks = new Map<string, { videoTrackId: string; audioTrackId: string }>()
      const priorAvatarClips = new Map<string, { video?: Clip; audio?: Clip }>()
      // Preserve the user-chosen track + clip identity for text overlays too.
      const priorTextTracks = new Map<string, string>()
      const priorTextClips = new Map<string, Clip>()
      for (const t of tl.tracks) {
        for (const c of t.clips) {
          if (isTextLinked(c) && c.linkGroupId) {
            priorTextTracks.set(c.linkGroupId, c.trackId)
            priorTextClips.set(c.linkGroupId, c)
            continue
          }
          if (!isAvatarLinked(c) || !c.linkGroupId) continue
          const slotT = priorAvatarTracks.get(c.linkGroupId) ?? { videoTrackId: '', audioTrackId: '' }
          if (c.sourceType === 'avatar') slotT.videoTrackId = c.trackId
          else if (c.sourceType === 'audio') slotT.audioTrackId = c.trackId
          priorAvatarTracks.set(c.linkGroupId, slotT)

          const slotC = priorAvatarClips.get(c.linkGroupId) ?? {}
          if (c.sourceType === 'avatar') slotC.video = c
          else if (c.sourceType === 'audio') slotC.audio = c
          priorAvatarClips.set(c.linkGroupId, slotC)
        }
      }
      const sfxTrackIdSet = new Set(sfxTrackIds)
      const trimmedExistingTracks = tl.tracks.map((t) => {
        if (t.id === v1.id || t.id === a1Id || t.id === a2Id || sfxTrackIdSet.has(t.id)) return t
        return { ...t, clips: t.clips.filter((c) => !isMirroredLinked(c)) }
      })

      // Keep non-scene clips on V1 (user-added video/image clips)
      const nonSceneClips = v1.clips.filter((c) => c.sourceType !== 'scene' && !isMirroredLinked(c))

      // Keep user-placed audio on A1/A2 (imported/standalone clips). Scene
      // narration/tts/music/sfx are regenerated above into newA1Clips /
      // newA2Clips, so a clip is scene-owned iff it was just regenerated OR it
      // carries a scene-audio prefix (`aud-`/`tts-`/`mus-`) — the prefix arm
      // drops orphans from deleted scenes instead of resurrecting them. Every
      // other audio clip is the user's: imported audio lands on A1 (first audio
      // track) via placeAssetOnTimeline, so without this it is silently deleted
      // on the next sync — including the one that fires on project open. See
      // the timeline /land-and-deploy review (data-loss-on-open).
      const SCENE_AUDIO_PREFIXES = ['aud-', 'tts-', 'mus-']
      const regenA1Ids = new Set(newA1Clips.map((c) => c.sourceId))
      const regenA2Ids = new Set(newA2Clips.map((c) => c.sourceId))
      const regenSfxIds = new Set(newSfxByLane.flat().map((c) => c.sourceId))
      const userPlacedAudio = (clips: Clip[], regen: typeof regenA1Ids): Clip[] =>
        clips.filter((c) => {
          if (isAvatarLinked(c)) return false
          // scene-sfx marker → scene-owned. SFX ids have no prefix, so a
          // deleted SFX would otherwise pass every check below and orphan.
          if (typeof c.linkGroupId === 'string' && c.linkGroupId.startsWith('scene-sfx:')) return false
          const sid = c.sourceId
          if (sid == null) return true // no sourceId → can't be scene-owned, keep it
          // Scene-owned (drop, it's regenerated): prefixed audio, a clip just
          // regenerated onto this lane, or any current scene-SFX id (so SFX that
          // used to live on A2 don't linger there after moving to A3).
          return !regen.has(sid) && !sceneSfxIds.has(sid) && !SCENE_AUDIO_PREFIXES.some((p) => sid.startsWith(p))
        })
      const preservedA1 = a1 ? userPlacedAudio(a1.clips, regenA1Ids) : []
      const preservedA2 = a2 ? userPlacedAudio(a2.clips, regenA2Ids) : []
      const preservedSfxByTrack = new Map<string, Clip[]>()
      for (const t of sfxTracks) preservedSfxByTrack.set(t.id, userPlacedAudio(t.clips, regenSfxIds))

      // Build updated tracks
      let updatedTracks = trimmedExistingTracks.map((t) => {
        if (t.id === v1.id) return { ...t, clips: [...newSceneClips, ...nonSceneClips] }
        if (t.id === a1Id) return { ...t, clips: [...newA1Clips, ...preservedA1] }
        if (t.id === a2Id) return { ...t, clips: [...newA2Clips, ...preservedA2] }
        const sfxIdx = sfxTrackIds.indexOf(t.id)
        if (sfxIdx !== -1) {
          const fresh = newSfxByLane[sfxIdx] ?? []
          return { ...t, clips: [...fresh, ...(preservedSfxByTrack.get(t.id) ?? [])] }
        }
        return t
      })

      // If A1 didn't exist, add it
      // Standard NLE default layout: A1/A2 always exist (like initTimeline's
      // V1/V2/A1/A2), so drops and linked video audio have somewhere to land
      // without inventing tracks ad hoc.
      if (!a1) {
        updatedTracks.push({
          id: a1Id,
          name: 'A1',
          type: 'audio' as const,
          clips: newA1Clips,
          muted: false,
          locked: false,
          position: updatedTracks.length,
        })
      }
      if (!a2) {
        updatedTracks.push({
          id: a2Id,
          name: 'A2',
          type: 'audio' as const,
          clips: newA2Clips,
          muted: false,
          locked: false,
          position: updatedTracks.length,
        })
      }
      // SFX lanes (A3, A4, A5…). Add any that don't physically exist yet but now
      // hold clips. A3 is materialized only when there's SFX to hold (so a
      // SFX-less project never grows an empty track); A4+ appear only when
      // overlapping SFX cascaded onto them.
      for (let idx = 0; idx < sfxTrackIds.length; idx++) {
        const id = sfxTrackIds[idx]
        if (sfxExistingIds.has(id)) continue // existing track — updated in place above
        const fresh = newSfxByLane[idx] ?? []
        if (fresh.length === 0) continue // never grow an empty lane
        updatedTracks.push({
          id,
          name: `A${3 + idx}`,
          type: 'audio' as const,
          clips: fresh,
          muted: false,
          locked: false,
          position: updatedTracks.length,
        })
      }
      // Prune emptied cascade lanes (A4+): they exist only to hold overlapping
      // SFX, so when the overlap clears they fold away (A3 stays for layout).
      // Per-scene packing fills lowest-first, so used lanes are a contiguous
      // prefix and empties are always a trailing tail — pruning leaves no A-name
      // gaps. A user's own empty audio track is never in sfxTrackIds, so it's
      // untouched.
      const extraSfxIdSet = new Set(sfxTrackIds.slice(1))
      updatedTracks = updatedTracks.filter((t) => !(extraSfxIdSet.has(t.id) && t.clips.length === 0))
      // ── Avatar mirroring (NLE-style: V-track video + linked A-track audio) ──
      // Each avatar layer emits two clips sharing `linkGroupId = avatar:<layerId>`.
      // Placement walks existing V/A tracks (excluding V1/A1/A2 which the sync
      // owns) and picks the lowest one with free space at the avatar's time
      // range. If none fits, a new Vn/An is appended.
      const trackHasOverlapAt = (clips: Clip[], start: number, end: number) =>
        clips.some((c) => rangesOverlap(start, end, c.startTime, c.startTime + c.duration))

      const ensureFreeTrack = (
        type: 'video' | 'audio',
        start: number,
        end: number,
        excludeIds: ReadonlySet<string>,
      ): Track => {
        const candidates = updatedTracks
          .filter((t) => t.type === type && !excludeIds.has(t.id) && !t.locked)
          .sort((a, b) => a.position - b.position)
        for (const t of candidates) {
          if (!trackHasOverlapAt(t.clips, start, end)) return t
        }
        const prefix = type === 'video' ? 'V' : 'A'
        const count = updatedTracks.filter((t) => t.type === type).length
        const newTrack: Track = {
          id: uuidv4(),
          name: `${prefix}${count + 1}`,
          type,
          clips: [],
          muted: false,
          locked: false,
          position: updatedTracks.length,
        }
        updatedTracks.push(newTrack)
        return newTrack
      }

      const sceneTrackIds = new Set([v1.id])
      const managedAudioTrackIds = new Set([a1Id, a2Id, ...sfxTrackIds])
      for (const scene of state.scenes) {
        const avatarLayers = (scene.aiLayers ?? []).filter((l) => l.type === 'avatar')
        if (avatarLayers.length === 0) continue
        const sceneClip = newSceneClips.find((c) => c.sourceId === scene.id && c.sourceType === 'scene')
        if (!sceneClip) continue
        const sStart = sceneClip.startTime
        for (const av of avatarLayers) {
          const off = Math.max(0, Math.min(scene.duration, av.startAt ?? 0))
          const d = Math.max(0.1, Math.min(Number(av.estimatedDuration) || scene.duration, scene.duration - off))
          const start = sStart + off
          const end = start + d
          const linkGroupId = `avatar:${av.id}`
          const label = av.label?.trim() || 'Avatar'
          const priorTracks = priorAvatarTracks.get(linkGroupId)

          // Reuse the user-chosen tracks when they still have room; fall back
          // to first-fit otherwise. Time always comes from av.startAt, so
          // panel edits and timeline drags stay coherent.
          const priorVideoTrack = priorTracks?.videoTrackId
            ? updatedTracks.find((t) => t.id === priorTracks.videoTrackId && t.type === 'video' && !t.locked)
            : null
          const videoTrack =
            priorVideoTrack && !trackHasOverlapAt(priorVideoTrack.clips, start, end)
              ? priorVideoTrack
              : ensureFreeTrack('video', start, end, sceneTrackIds)

          const priorAudioTrack = priorTracks?.audioTrackId
            ? updatedTracks.find((t) => t.id === priorTracks.audioTrackId && t.type === 'audio' && !t.locked)
            : null
          const audioTrack =
            priorAudioTrack && !trackHasOverlapAt(priorAudioTrack.clips, start, end)
              ? priorAudioTrack
              : ensureFreeTrack('audio', start, end, managedAudioTrackIds)

          // Reuse the prior clip's id (and user edits — keyframes, filters,
          // opacity, etc.) when the same avatar layer survives across syncs.
          // Without this, every scene mutation minted fresh UUIDs for the
          // avatar pair and broke selection/React keys. See review #2.
          const prior = priorAvatarClips.get(linkGroupId)
          const videoClip: Clip = prior?.video
            ? {
                ...prior.video,
                trackId: videoTrack.id,
                startTime: start,
                duration: d,
                label,
                linkGroupId,
                sourceId: av.id,
                sourceType: 'avatar',
              }
            : { ...makeClip(videoTrack.id, 'avatar', av.id, label, start, d), linkGroupId }
          const audioClip: Clip = prior?.audio
            ? {
                ...prior.audio,
                trackId: audioTrack.id,
                startTime: start,
                duration: d,
                label: `${label} audio`,
                linkGroupId,
                sourceId: `avatar-audio:${av.id}`,
                sourceType: 'audio',
              }
            : { ...makeClip(audioTrack.id, 'audio', `avatar-audio:${av.id}`, `${label} audio`, start, d), linkGroupId }
          videoTrack.clips.push(videoClip)
          audioTrack.clips.push(audioClip)
        }
      }

      // ── Text-overlay mirroring (one V-track clip per overlay) ──
      // So text added from the timeline Add-text tool shows up as a clip you
      // can move/select. Time comes from overlay.delay (moveClip writes drags
      // back to it); the clip id is reused across syncs so selection/keys stay
      // stable. Removed overlays drop automatically (their clips were trimmed
      // above and aren't re-emitted here).
      for (const scene of state.scenes) {
        const overlays = scene.textOverlays ?? []
        if (overlays.length === 0) continue
        const sceneClip = newSceneClips.find((c) => c.sourceId === scene.id && c.sourceType === 'scene')
        if (!sceneClip) continue
        const sStart = sceneClip.startTime
        for (const ov of overlays) {
          const off = Math.max(0, Math.min(scene.duration, ov.delay ?? 0))
          const d = Math.max(0.1, Math.min(Number(ov.duration) || scene.duration, scene.duration - off))
          const start = sStart + off
          const end = start + d
          const linkGroupId = `text:${ov.id}`
          const label = (ov.content || 'Text').trim().slice(0, 40) || 'Text'
          const priorTrackId = priorTextTracks.get(linkGroupId)
          const priorTrack = priorTrackId
            ? updatedTracks.find((t) => t.id === priorTrackId && t.type === 'video' && !t.locked)
            : null
          const videoTrack =
            priorTrack && !trackHasOverlapAt(priorTrack.clips, start, end)
              ? priorTrack
              : ensureFreeTrack('video', start, end, sceneTrackIds)
          const prior = priorTextClips.get(linkGroupId)
          const clip: Clip = prior
            ? {
                ...prior,
                trackId: videoTrack.id,
                startTime: start,
                duration: d,
                label,
                linkGroupId,
                sourceId: ov.id,
                sourceType: 'title',
              }
            : { ...makeClip(videoTrack.id, 'title', ov.id, label, start, d), linkGroupId }
          videoTrack.clips.push(clip)
        }
      }

      set((s) => ({
        project: {
          ...s.project,
          timeline: withTracks(s.project.timeline, updatedTracks),
          updatedAt: new Date().toISOString(),
        },
      }))
      get().scheduleSaveProjectToDb()
    },

    addTrack: (type: TrackType, _name?: string) => {
      const id = uuidv4()
      set((state) => {
        const tl = state.project.timeline ?? { tracks: [] }
        const maxPos = tl.tracks.reduce((m, t) => Math.max(m, t.position), -1)
        // Software owns track names: the `_name` arg is IGNORED. After appending
        // the new lane, renumber EVERY track to V1/V2…/A1/A2… by position+type so
        // names are always sequential, gap-free, and never duplicated (a removal +
        // add used to collide on a counted name; custom names like "V1-lower" are
        // normalized away).
        const newTrack: Track = {
          id,
          name: '',
          type,
          clips: [],
          muted: false,
          locked: false,
          position: maxPos + 1,
        }
        return {
          project: {
            ...state.project,
            timeline: withTracks(tl, normalizeTrackNames([...tl.tracks, newTrack])),
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
      return id
    },

    removeTrack: (trackId: string) => {
      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        // Renumber the survivors so names stay sequential (V1,V2 — not V2,V3 after
        // removing V1) and never collide with a later add_track.
        return {
          project: {
            ...state.project,
            timeline: withTracks(tl, normalizeTrackNames(tl.tracks.filter((t) => t.id !== trackId))),
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    updateTrack: (
      trackId: string,
      updates: Partial<Pick<Track, 'name' | 'muted' | 'locked' | 'position' | 'solo' | 'hidden'>>,
    ) => {
      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        return {
          project: {
            ...state.project,
            timeline: withTracks(
              tl,
              tl.tracks.map((t) => (t.id === trackId ? { ...t, ...updates } : t)),
            ),
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    addClip: (trackId: string, clipData: Omit<Clip, 'id' | 'trackId'>) => {
      // Collision guard — audio never stacks on audio. The UI drag handler
      // pre-clamps, so this catches PROGRAMMATIC adds (agent tools, MCP,
      // scripts) at the store level instead of relying on every caller to
      // check. Audio keeps its requested TIME (timing is the musical intent)
      // and spills to the first audio lane with free space, creating a new
      // lane when every one is occupied — same semantics as the linked-video
      // placement in add-asset-to-timeline.
      {
        const tl0 = get().project.timeline
        const target0 = tl0?.tracks.find((t) => t.id === trackId)
        if (tl0 && target0?.type === 'audio') {
          const start = clipData.startTime
          const end = start + clipData.duration
          const occupied = (t: Track) =>
            t.clips.some((c) => rangesOverlap(start, end, c.startTime, c.startTime + c.duration))
          if (occupied(target0)) {
            const free = tl0.tracks
              .filter((t) => t.type === 'audio' && !t.locked)
              .sort((a, b) => a.position - b.position)
              .find((t) => !occupied(t))
            trackId = free ? free.id : get().addTrack('audio')
          }
        }
      }
      const id = uuidv4()
      const clip: Clip = { ...clipData, id, trackId } as Clip
      // Strangler-fig: push a legacy snapshot BEFORE the mutation so Cmd+Z
      // (which prefers actionUndo and falls back to legacy when the action
      // stack is empty) can revert this op. recordUserAction below records
      // the user intent in action_log + WAL but doesn't generate an inverse.
      get()._pushUndo?.()
      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        return {
          project: {
            ...state.project,
            timeline: withTracks(
              tl,
              tl.tracks.map((t) => (t.id === trackId ? { ...t, clips: [...t.clips, clip] } : t)),
            ),
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
      // Emit-only: record user intent in action_log + WAL. Strangler-fig with
      // the legacy mutation above; full reducer dispatch lands in a follow-up
      // phase that also updates the test harness.
      get().recordUserAction({
        type: 'clip/add',
        params: { trackId, clipId: id, clip },
      })
      // Visual flash so the user can see the new clip land.
      get().flashClip?.(id)
      return id
    },

    removeClip: (clipId: string) => {
      // FF: fully wired into the action layer. `clip/remove` handles all
      // source mutations (audioLayer, aiLayers, scene deletion, sceneGraph
      // cleanup) inside the reducer, so undo/WAL/replay stay coherent.
      // No `_pushUndo()` needed — the inverse is pushed by dispatchAction.
      const tlBefore = get().project.timeline
      if (!tlBefore || !findClip(tlBefore, clipId)) return

      // Snapshot the IDs that will be removed (for selectedClipIds cleanup).
      // We read this BEFORE dispatch since dispatchAction mutates the store.
      const idsToRemovePreSnapshot = new Set(linkedClipIds(tlBefore, clipId))
      const clip = findClip(tlBefore, clipId)?.clip
      if (clip?.linkGroupId) {
        for (const t of tlBefore.tracks) {
          for (const c of t.clips) {
            if (c.linkGroupId === clip.linkGroupId) idsToRemovePreSnapshot.add(c.id)
          }
        }
      }

      const result = get().dispatchAction({ type: 'clip/remove', params: { clipId } }, { source: 'user' })
      if (!result.success) return

      // selectedClipIds lives outside ProjectState — clean it up here.
      const newTl = get().project.timeline
      const survivingIds = new Set((newTl?.tracks ?? []).flatMap((t) => t.clips.map((c) => c.id)))
      const currentSelection = get().selectedClipIds
      const nextSelection = currentSelection.filter((id) => !idsToRemovePreSnapshot.has(id) && survivingIds.has(id))
      if (nextSelection.length !== currentSelection.length) {
        set({ selectedClipIds: nextSelection })
      }
    },

    removeClipRipple: (clipId: string) => {
      // Capture the target before mutating, so the emit can include the prior
      // clip in the action params (matches the reducer's inverse contract).
      const tlBefore = get().project.timeline
      const targetBefore = tlBefore?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
      if (!targetBefore) return
      // Locked-track parity with the reducer's TRACK_LOCKED rejection:
      // a clip on a locked track refuses to ripple-delete. Checked BEFORE the
      // undo snapshot so a rejected delete doesn't consume an undo slot.
      const trackBefore = tlBefore?.tracks.find((t) => t.clips.some((c) => c.id === clipId))
      if (trackBefore?.locked) {
        console.warn(`[timeline] removeClipRipple rejected: track ${trackBefore.id} is locked`)
        get().showTransientStatus?.('Track is locked — unlock it to delete clips.', 2600)
        return
      }
      // A deleted avatar/text clip is a MIRROR of scene state —
      // strip the source entry (aiLayers avatar / textOverlays entry) via the
      // shared cascade so the next syncTimelineFromScenes doesn't resurrect it
      // onto the shifted tracks. Scene clips run their own whole-scene cascade
      // inside set() below.
      const sourceCascade =
        targetBefore.sourceType !== 'scene' ? cascadeClipSourceMutations(get().scenes, targetBefore) : null
      // Strangler-fig: push a legacy snapshot pre-mutation so Cmd+Z reverts.
      get()._pushUndo?.()

      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        const target = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
        if (!target) return state

        const removedDuration = target.duration
        const removedEnd = target.startTime + removedDuration

        // For a scene clip, drop EVERY clip the scene owns (derived audio + avatar
        // video/audio) via the shared cascade predicate — the same one scene/delete
        // and the clip/remove reducer use, so a ripple-delete leaves the timeline in
        // an identical state (the old local rule missed avatar clips). For a non-scene
        // clip the target AND its linked siblings go (an avatar's video+audio pair
        // shares a linkGroupId) — parity with the clip/remove reducer's
        // removeLinkedClips, which the old `c.id === clipId` rule missed.
        const isScene = target.sourceType === 'scene'
        const ownerScene = isScene ? state.scenes.find((s) => s.id === target.sourceId) : null
        // Clip-centric delete: a split scene has N clips sharing one sourceId.
        // Deleting ONE half removes only that clip (the scene + siblings stay).
        // The whole-scene cascade (scene + derived audio/avatar) runs ONLY when
        // this is the scene's LAST clip.
        const sceneClipCount = isScene
          ? tl.tracks.flatMap((t) => t.clips).filter((c) => c.sourceType === 'scene' && c.sourceId === target.sourceId)
              .length
          : 0
        const isLastSceneClip = sceneClipCount <= 1
        const cascade =
          isScene && isLastSceneClip ? makeSceneClipCascadeFilter(target.sourceId, ownerScene ?? undefined) : null

        const isLinked = (c: Clip): boolean => {
          if (c.id === clipId) return true
          if (cascade) return cascade(c)
          return !!target.linkGroupId && c.linkGroupId === target.linkGroupId
        }

        // Ripple ONLY the tracks that actually lost a clip — the target's track,
        // plus the linked-audio tracks on a scene delete (so the soundtrack stays
        // synced with the visual). Rippling EVERY track shifted unrelated lanes:
        // deleting one V2 overlay (or a standalone audio clip) nudged the V1 scene
        // clips and other audio left by the overlay's duration, desyncing audio
        // from video. A track only ripples if the deletion removed a clip from it
        // — AND is not locked: a linked sibling on a locked track is still removed
        // (reducer parity), but the locked track's OTHER clips must not shift.
        const rippledTrackIds = new Set(
          tl.tracks.filter((t) => !t.locked && t.clips.some((c) => isLinked(c))).map((t) => t.id),
        )
        const updatedTracks = tl.tracks.map((t) => ({
          ...t,
          clips: t.clips
            .filter((c) => !isLinked(c))
            .map((c) =>
              rippledTrackIds.has(t.id) && c.startTime >= removedEnd
                ? { ...c, startTime: Math.max(0, c.startTime - removedDuration) }
                : c,
            ),
        }))

        // Drop deleted ids from selection so the inspector doesn't show a
        // ghost clip after ripple-delete.
        const survivingIds = new Set(updatedTracks.flatMap((t) => t.clips.map((c) => c.id)))
        const nextSelection = state.selectedClipIds.filter((id) => survivingIds.has(id))

        // A scene clip's ripple-delete must also REMOVE the scene from scenes[] —
        // matching scene/delete and the clip/remove reducer. Without this the scene
        // lingers with no V1 clip and the next syncTimelineFromScenes mints a fresh
        // clip (snap-back) or leaves an orphan the preview still plays. Non-scene
        // clips take the shared source cascade (aiLayers / textOverlays cleanup)
        // computed before the undo snapshot.
        const scenesAfterDelete =
          isScene && isLastSceneClip
            ? state.scenes.filter((s) => s.id !== target.sourceId)
            : isScene
              ? state.scenes // a split half deleted — scene stays (other halves remain)
              : (sourceCascade?.scenes ?? state.scenes)

        // Write back audioLayer.startOffset / sfx.triggerAt for any scene
        // whose audio clip moved but whose V1 clip did NOT (e.g., user had
        // dragged the audio outside its scene's range). Otherwise the next
        // syncTimelineFromScenes would rebuild the audio from the stale
        // offset and snap it back to its pre-ripple position.
        let nextScenes = scenesAfterDelete
        const v1Track = updatedTracks
          .slice()
          .sort((a, b) => a.position - b.position)
          .find((t) => t.type === 'video')
        if (v1Track) {
          const sceneStartById = new Map<string, number>()
          for (const c of v1Track.clips) {
            if (c.sourceType === 'scene') sceneStartById.set(c.sourceId, c.startTime)
          }
          const audioClips = updatedTracks
            .filter((t) => t.type === 'audio')
            .flatMap((t) => t.clips)
            .filter((c) => c.sourceType === 'audio')
          // For each scene, collect new offsets from its surviving audio clips.
          const startOffsetUpdates = new Map<string, number>()
          const sfxUpdates = new Map<string, Map<string, number>>() // sceneId -> sfxId -> newTriggerAt
          for (const ac of audioClips) {
            const sid = ac.sourceId
            let sceneId: string | null = null
            let isSfx = false
            if (sid.startsWith('aud-') || sid.startsWith('tts-') || sid.startsWith('mus-')) {
              sceneId = sid.slice(4)
            } else {
              for (const s of scenesAfterDelete) {
                if ((s.audioLayer?.sfx ?? []).some((x) => x.id === sid)) {
                  sceneId = s.id
                  isSfx = true
                  break
                }
              }
            }
            if (!sceneId) continue
            const sceneStart = sceneStartById.get(sceneId)
            if (sceneStart == null) continue
            const newOffset = Math.max(0, ac.startTime - sceneStart)
            if (isSfx) {
              const map = sfxUpdates.get(sceneId) ?? new Map<string, number>()
              map.set(sid, newOffset)
              sfxUpdates.set(sceneId, map)
            } else if (!startOffsetUpdates.has(sceneId)) {
              startOffsetUpdates.set(sceneId, newOffset)
            }
          }
          if (startOffsetUpdates.size || sfxUpdates.size) {
            nextScenes = scenesAfterDelete.map((s) => {
              if (!s.audioLayer) return s
              const newOff = startOffsetUpdates.get(s.id)
              const sfxMap = sfxUpdates.get(s.id)
              if (newOff == null && !sfxMap) return s
              let audioLayer = s.audioLayer
              if (newOff != null && Math.abs((audioLayer.startOffset ?? 0) - newOff) > 0.0001) {
                audioLayer = { ...audioLayer, startOffset: newOff }
              }
              if (sfxMap && audioLayer.sfx?.length) {
                audioLayer = {
                  ...audioLayer,
                  sfx: audioLayer.sfx.map((x) =>
                    sfxMap.has(x.id) && Math.abs(x.triggerAt - sfxMap.get(x.id)!) > 0.0001
                      ? { ...x, triggerAt: sfxMap.get(x.id)! }
                      : x,
                  ),
                }
              }
              return audioLayer === s.audioLayer ? s : { ...s, audioLayer }
            })
          }
        }

        // sceneGraph + selection parity with scene/delete: drop the scene's node and
        // any edges touching it, re-home a start node that pointed at it, and move the
        // active scene selection off the deleted scene — otherwise these dangle.
        let nextSceneGraph = state.project.sceneGraph
        if (isScene && state.project.sceneGraph) {
          const g = state.project.sceneGraph
          nextSceneGraph = {
            ...g,
            nodes: (g.nodes ?? []).filter((n) => n.id !== target.sourceId),
            edges: (g.edges ?? []).filter((e) => e.fromSceneId !== target.sourceId && e.toSceneId !== target.sourceId),
            startSceneId: g.startSceneId === target.sourceId ? (nextScenes[0]?.id ?? '') : g.startSceneId,
          }
        }
        const nextSelectedSceneId =
          isScene && state.selectedSceneId === target.sourceId ? (nextScenes[0]?.id ?? null) : state.selectedSceneId

        return {
          selectedClipIds: nextSelection,
          scenes: nextScenes,
          selectedSceneId: nextSelectedSceneId,
          project: {
            ...state.project,
            timeline: { ...tl, tracks: updatedTracks },
            sceneGraph: nextSceneGraph,
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
      // Avatar layers and text overlays are baked into the scene HTML — regen
      // the scenes the shared cascade mutated (parity with the clip/remove
      // reducer's regenerate-scene-html effects).
      for (const sceneId of sourceCascade?.affectedSceneIds ?? []) {
        get().saveSceneHTML?.(sceneId, true)
      }
      // Emit-only: the renderer's ripple has scene-linked-audio side effects the
      // reducer doesn't model yet, so we record the user intent in action_log
      // without going through the executor. Cmd+Z still uses legacy snapshot
      // undo for this op until the reducer learns about linked audio.
      if (targetBefore) {
        get().recordUserAction({
          type: 'clip/rippleDelete',
          params: { clipId },
        })
      }
    },

    updateClip: (clipId: string, updates: Partial<Clip>) => {
      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        const ref = findClip(tl, clipId)
        if (!ref) return state
        const before = ref.clip
        const after: Clip = { ...before, ...updates }
        // Build the basic tracks update first.
        let nextTimeline = {
          tracks: tl.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => (c.id === clipId ? after : c)),
          })),
        }
        // Propagate to linked siblings when startTime / duration change.
        // - startTime delta: shift sibling startTime by the same delta
        // - duration delta on right edge: extend sibling duration by the same delta
        // - duration delta on left edge: caller would also pass a startTime delta
        //   (trim-from-head moves both start and duration). We detect that by
        //   checking both keys.
        const groupId = before.linkGroupId
        if (groupId) {
          const dtStart = after.startTime - before.startTime
          const dtDuration = after.duration - before.duration
          if (dtStart !== 0 && dtDuration === -dtStart) {
            // Left-edge trim: start moved forward, duration shrank by the same
            // amount so the right edge stays. Mirror the same on siblings.
            nextTimeline = trimLinkedClips(nextTimeline, groupId, 'left', dtStart, clipId)
          } else {
            if (dtStart !== 0) {
              nextTimeline = shiftLinkedClips(nextTimeline, groupId, dtStart, clipId)
            }
            if (dtDuration !== 0) {
              nextTimeline = trimLinkedClips(nextTimeline, groupId, 'right', dtDuration, clipId)
            }
          }
        }
        return {
          project: {
            ...state.project,
            timeline: nextTimeline,
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    splitClip: (clipId: string, atTime: number, opts?: { skipUndo?: boolean }) => {
      const tl = get().project.timeline
      if (!tl) return null
      let found: { track: Track; clip: Clip } | null = null
      for (const t of tl.tracks) {
        const c = t.clips.find((c) => c.id === clipId)
        if (c) {
          found = { track: t, clip: c }
          break
        }
      }
      if (!found) return null
      const { clip } = found
      // Scene clips CAN now split (NLE-foundation): syncTimelineFromScenes carries
      // every split half through (sceneV1Clips.slice(1) above), and playback
      // resolves the live clip by id (currentClipIdRef), so each half plays its
      // own trim range. Linked footage audio is an independent full-length clip
      // that keeps playing under both halves. The old refuse-guard is gone.
      // atTime is relative to clip start
      if (atTime <= 0 || atTime >= clip.duration) return null
      // Strangler-fig: push a legacy snapshot pre-mutation so Cmd+Z reverts.
      // `skipUndo` lets batch callers (addEditAtTime) push one snapshot at
      // the top and avoid N separate undo entries for a single user action.
      if (!opts?.skipUndo) get()._pushUndo?.()
      const leftId = uuidv4()
      const rightId = uuidv4()
      // Clamp the inferred trim values against the clip's existing trim range
      // so splitting an already-trimmed clip can't reach back past the
      // original trimEnd. Without this, splitting a clip that the user trimmed
      // to a sub-range plays content they explicitly cut out.
      const splitSourceOffset = clip.trimStart + atTime * clip.speed
      const leftTrimEnd = clip.trimEnd != null ? Math.min(clip.trimEnd, splitSourceOffset) : splitSourceOffset
      const rightTrimStart = clip.trimEnd != null ? Math.min(clip.trimEnd, splitSourceOffset) : splitSourceOffset
      const leftClip: Clip = {
        ...clip,
        id: leftId,
        duration: atTime,
        trimEnd: leftTrimEnd,
        keyframes: clip.keyframes.filter((k) => k.time < atTime),
      }
      const rightClip: Clip = {
        ...clip,
        id: rightId,
        startTime: clip.startTime + atTime,
        duration: clip.duration - atTime,
        trimStart: rightTrimStart,
        // trimEnd inherits via the ...clip spread (the original cap survives).
        keyframes: clip.keyframes.filter((k) => k.time >= atTime).map((k) => ({ ...k, time: k.time - atTime })),
      }
      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        return {
          project: {
            ...state.project,
            timeline: withTracks(
              tl,
              tl.tracks.map((t) => ({
                ...t,
                clips: t.clips.flatMap((c) => (c.id === clipId ? [leftClip, rightClip] : [c])),
              })),
            ),
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
      // Emit-only: the reducer's clip/split keeps the original clip's id as
      // the left half, but the legacy body (matched by the test suite) mints
      // fresh IDs for both halves. Until the test harness gets a reducer
      // stub, emit clip/split using the new rightId; the legacy mutation is
      // the source of truth for visible state. Cmd+Z falls back to legacy.
      get().recordUserAction({
        type: 'clip/split',
        params: { clipId, time: clip.startTime + atTime, rightClipId: rightId },
      })
      return { leftId, rightId }
    },

    moveClip: (clipId: string, toTrackId: string, startTime: number) => {
      // Snapshot the prior position before the legacy set() runs, so the emit
      // can record the full intent (from -> to). The reducer's clip/move
      // params expect this for inverse generation.
      const tlBefore = get().project.timeline
      const sourceBefore = tlBefore?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
      if (!sourceBefore) return
      // Collision guard — audio never stacks on audio (mirrors addClip). UI
      // drags pre-clamp; this protects programmatic moves. Pushed to the
      // nearest free gap on the target track rather than rejected, the same
      // resolution the drag handler applies.
      const moveTarget = tlBefore?.tracks.find((t) => t.id === toTrackId)
      if (moveTarget?.type === 'audio' && sourceBefore.sourceType === 'audio') {
        startTime = clampToAvoidOverlap(startTime, sourceBefore.duration, getTrackClipBounds(moveTarget, clipId))
      }
      // No-op moves should not pollute the undo stack.
      if (sourceBefore.startTime === startTime && sourceBefore.trackId === toTrackId) {
        return
      }
      // TIMELINE-AUTHORITATIVE (docs/NLE_RECONCILIATION.md): a scene clip may be
      // dragged up to a SECOND video lane (V2). It leaves a real gap on V1 and
      // composites over it. The old cross-track rejection is gone — instead
      // syncTimelineFromScenes spans all video tracks when checking whether a
      // scene already has a clip, so it never re-materializes a phantom V1
      // duplicate for a scene that now lives on V2.
      // Strangler-fig: push a legacy snapshot pre-mutation so Cmd+Z reverts.
      get()._pushUndo?.()

      // OV#5 (v6 B3): the timeline transform (remove + re-add + linked-sibling
      // shifts + scene-order) is the SHARED pure fn `applyClipMoveWriteThrough`
      // — the SAME one the agent's move_clip handler runs, so the editor's
      // scenes-sync can no longer snap an agent move back. The store passes the
      // canonical SnapEngine `canTrackAcceptClip` and `writeBackSource:false`:
      // the scene SOURCE write-backs (audioLayer.startOffset / sfx.triggerAt /
      // avatar.startAt / text.delay) stay below, routed through the
      // side-effecting setters so HTML regen + the action log still fire.
      set((state) => {
        const r = applyClipMoveWriteThrough(
          state.project.timeline,
          state.scenes,
          clipId,
          { toTrackId, startTime },
          {
            accepts: (tt, st) => canTrackAcceptClip(tt as TrackType, st as Clip['sourceType']),
            writeBackSource: false,
          },
        )
        if (!r.changed) {
          if (r.rejectedReason) console.warn(`[timeline] moveClip rejected: ${r.rejectedReason}`)
          return state
        }
        return {
          ...(r.scenes !== state.scenes ? { scenes: r.scenes } : {}),
          project: {
            ...state.project,
            timeline: r.timeline,
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()

      // Sync audio clip position back to audioLayer.startOffset so playback reflects the move.
      // Only applies to audio-type clips derived from scene audioLayer.
      const tl = get().project.timeline
      if (!tl) return
      const movedClipFinal = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
      if (!movedClipFinal) return

      // Avatar clip (video or linked audio) moved → write back av.startAt
      // relative to the parent scene clip's startTime, so panel + timeline
      // agree on where the avatar plays.
      const avLinkPrefix = 'avatar:'
      if (movedClipFinal.linkGroupId?.startsWith(avLinkPrefix)) {
        const avatarId = movedClipFinal.linkGroupId.slice(avLinkPrefix.length)
        for (const scene of get().scenes) {
          const layer = scene.aiLayers?.find((l) => l.id === avatarId && l.type === 'avatar')
          if (!layer) continue
          const sceneClip = tl.tracks
            .flatMap((t) => t.clips)
            .find((c) => c.sourceType === 'scene' && c.sourceId === scene.id)
          const sceneStart = sceneClip?.startTime ?? 0
          const newStartAt = Math.max(0, movedClipFinal.startTime - sceneStart)
          if (Math.abs((layer.startAt ?? 0) - newStartAt) > 0.0001) {
            get().updateAILayer(scene.id, layer.id, { startAt: newStartAt })
          }
          break
        }
        return
      }

      // Text-overlay clip moved → write back overlay.delay relative to the
      // parent scene clip, so the timeline drag and the layer-stack form agree.
      const textLinkPrefix = 'text:'
      if (movedClipFinal.linkGroupId?.startsWith(textLinkPrefix)) {
        const overlayId = movedClipFinal.linkGroupId.slice(textLinkPrefix.length)
        for (const scene of get().scenes) {
          const overlay = scene.textOverlays?.find((o) => o.id === overlayId)
          if (!overlay) continue
          const sceneClip = tl.tracks
            .flatMap((t) => t.clips)
            .find((c) => c.sourceType === 'scene' && c.sourceId === scene.id)
          const sceneStart = sceneClip?.startTime ?? 0
          const newDelay = Math.max(0, movedClipFinal.startTime - sceneStart)
          if (Math.abs((overlay.delay ?? 0) - newDelay) > 0.0001) {
            get().updateTextOverlay(scene.id, overlayId, { delay: newDelay })
          }
          break
        }
        return
      }

      if (movedClipFinal.sourceType !== 'audio') return

      const sid = movedClipFinal.sourceId
      let sceneId: string | null = null
      if (sid.startsWith('aud-') || sid.startsWith('tts-') || sid.startsWith('mus-')) {
        sceneId = sid.slice(4)
      } else {
        // SFX: find scene owning this sfx id and update triggerAt
        for (const scene of get().scenes) {
          const sfx = scene.audioLayer?.sfx?.find((s) => s.id === sid)
          if (sfx) {
            const v1Clip = tl.tracks
              .find((t) => t.type === 'video')
              ?.clips.find((c) => c.sourceId === scene.id && c.sourceType === 'scene')
            const sceneStart = v1Clip?.startTime ?? 0
            const newTriggerAt = Math.max(0, startTime - sceneStart)
            get().updateScene(scene.id, {
              audioLayer: {
                ...scene.audioLayer!,
                sfx: (scene.audioLayer!.sfx ?? []).map((s) => (s.id === sid ? { ...s, triggerAt: newTriggerAt } : s)),
              },
            })
            return
          }
        }
        return
      }

      if (!sceneId) {
        // Emit-only after audio-side mutations complete. Scene-clip + audio
        // moves both flow through here.
        if (sourceBefore) {
          get().recordUserAction({
            type: 'clip/move',
            params: {
              clipId,
              startTime,
              newTrackId: toTrackId !== sourceBefore.trackId ? toTrackId : undefined,
              prior: { startTime: sourceBefore.startTime, trackId: sourceBefore.trackId },
            },
          })
        }
        return
      }
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene?.audioLayer) {
        if (sourceBefore) {
          get().recordUserAction({
            type: 'clip/move',
            params: {
              clipId,
              startTime,
              newTrackId: toTrackId !== sourceBefore.trackId ? toTrackId : undefined,
              prior: { startTime: sourceBefore.startTime, trackId: sourceBefore.trackId },
            },
          })
        }
        return
      }
      const v1Clip = tl.tracks
        .find((t) => t.type === 'video')
        ?.clips.find((c) => c.sourceId === sceneId && c.sourceType === 'scene')
      const sceneStart = v1Clip?.startTime ?? 0
      const newOffset = Math.max(0, startTime - sceneStart)
      get().updateScene(sceneId, {
        audioLayer: { ...scene.audioLayer, startOffset: newOffset },
      })

      if (sourceBefore) {
        get().recordUserAction({
          type: 'clip/move',
          params: {
            clipId,
            startTime,
            newTrackId: toTrackId !== sourceBefore.trackId ? toTrackId : undefined,
            prior: { startTime: sourceBefore.startTime, trackId: sourceBefore.trackId },
          },
        })
      }
    },

    copyClips: (clipIds: string[]) => {
      if (clipIds.length === 0) return
      const tl = get().project.timeline
      if (!tl) return
      const clips: Clip[] = []
      let anchorTime = Infinity
      for (const t of tl.tracks) {
        for (const c of t.clips) {
          if (!clipIds.includes(c.id)) continue
          clips.push({ ...c, keyframes: c.keyframes.map((k) => ({ ...k })), filters: [...c.filters] })
          if (c.startTime < anchorTime) anchorTime = c.startTime
        }
      }
      if (clips.length === 0) return
      set(() => ({ clipClipboard: { clips, anchorTime } }))
    },

    cutClips: (clipIds: string[]) => {
      if (clipIds.length === 0) return
      get().copyClips(clipIds)
      for (const id of clipIds) get().removeClip(id)
    },

    pasteClips: (atTime?: number, opts?: { insert?: boolean }) => {
      const cb = get().clipClipboard
      if (!cb || cb.clips.length === 0) return []
      const tl = get().project.timeline
      if (!tl) return []
      const target = atTime ?? get().timelineTransport.globalTime
      const insert = opts?.insert === true
      get()._pushUndo?.()
      const newIds: string[] = []
      const newScenes: Scene[] = []
      set((state) => {
        const t = state.project.timeline
        if (!t) return state
        const linkRemap = new Map<string, string>()
        const groupRemap = new Map<string, string>()
        // First clip's startTime relative to anchor stays 0; everything else
        // keeps its original relative offset from `anchorTime`.
        const toInsert: Array<{ trackId: string; clip: Clip }> = []
        for (const src of cb.clips) {
          const rel = src.startTime - cb.anchorTime
          const id = uuidv4()
          newIds.push(id)
          let linkGroupId = src.linkGroupId
          if (linkGroupId) {
            const remapped = linkRemap.get(linkGroupId) ?? `link:${uuidv4()}`
            linkRemap.set(linkGroupId, remapped)
            linkGroupId = remapped
          }
          let groupId = src.groupId
          if (groupId) {
            const remapped = groupRemap.get(groupId) ?? `group:${uuidv4()}`
            groupRemap.set(groupId, remapped)
            groupId = remapped
          }
          // A pasted SCENE clip must reference its OWN scene — two clips can't
          // share one interactive iframe/<video> (the original played, then the
          // copy flickered black and jumped because the single video had to seek
          // between them). Clone the source scene (fresh ids, like duplicateScene)
          // so each instance is independent and plays smoothly.
          let pastedSourceId = src.sourceId
          if (src.sourceType === 'scene') {
            const srcScene = state.scenes.find((s) => s.id === src.sourceId)
            if (srcScene) {
              const clone: Scene = {
                ...srcScene,
                id: uuidv4(),
                name: srcScene.name ? `${srcScene.name} (copy)` : '',
                thumbnail: null,
                interactions: (srcScene.interactions ?? []).map((el) => ({ ...el, id: uuidv4() })),
                audioLayer: srcScene.audioLayer
                  ? {
                      ...srcScene.audioLayer,
                      sfx: (srcScene.audioLayer.sfx ?? []).map((s) => ({ ...s, id: uuidv4() })),
                    }
                  : srcScene.audioLayer,
                aiLayers: (srcScene.aiLayers ?? []).map((l) => ({ ...l, id: uuidv4() })),
              }
              newScenes.push(clone)
              pastedSourceId = clone.id
            }
          }
          const next: Clip = {
            ...src,
            id,
            sourceId: pastedSourceId,
            startTime: Math.max(0, target + rel),
            linkGroupId,
            groupId,
          }
          toInsert.push({ trackId: src.trackId, clip: next })
        }

        // Non-insert (overlay) paste must NEVER overlap existing clips.
        // Compute ONE shared delta that clears every pasted clip on its track,
        // preserving the group's relative offsets, and shift the group to the
        // nearest free gap. Insert mode skips this — it makes room by pushing
        // existing clips right instead (handled below).
        if (!insert) {
          const spansByTrack = new Map<string, Span[]>()
          for (const tr of t.tracks) {
            spansByTrack.set(
              tr.id,
              tr.clips.map((c) => ({ start: c.startTime, end: c.startTime + c.duration })),
            )
          }
          const placeable = toInsert.map(({ trackId, clip }) => ({
            trackId,
            startTime: clip.startTime,
            duration: clip.duration,
          }))
          const delta = resolvePasteDelta(placeable, spansByTrack)
          if (delta !== 0) {
            for (const item of toInsert) {
              item.clip = { ...item.clip, startTime: Math.max(0, item.clip.startTime + delta) }
            }
          }
        }

        // Insert mode: per affected track, compute the pasted range's
        // (rightmost end − target) and shift every existing clip with
        // startTime >= target by that delta.
        const shiftDeltaByTrack = new Map<string, number>()
        if (insert) {
          for (const { trackId, clip } of toInsert) {
            const end = clip.startTime + clip.duration
            const prev = shiftDeltaByTrack.get(trackId) ?? target
            if (end > prev) shiftDeltaByTrack.set(trackId, end)
          }
          // Convert "rightmost end" → delta from target.
          for (const [trackId, end] of shiftDeltaByTrack) {
            shiftDeltaByTrack.set(trackId, end - target)
          }
        }

        const updatedTracks = t.tracks.map((tr) => {
          const adds = toInsert.filter((x) => x.trackId === tr.id).map((x) => x.clip)
          const shift = shiftDeltaByTrack.get(tr.id)
          let nextClips = tr.clips
          if (insert && shift && shift > 0) {
            nextClips = nextClips.map((c) =>
              c.startTime + 0.0001 >= target ? { ...c, startTime: c.startTime + shift } : c,
            )
          }
          if (adds.length === 0) return shift ? { ...tr, clips: nextClips } : tr
          const stamped = adds.map((c) => ({ ...c, trackId: tr.id }))
          return { ...tr, clips: [...nextClips, ...stamped] }
        })

        // Clips that pointed at a track which no longer exists land on the
        // first matching-type track (audio→A1, video→V1) so paste never
        // silently drops them.
        const placedIds = new Set(
          updatedTracks
            .flatMap((tr) => tr.clips)
            .filter((c) => newIds.includes(c.id))
            .map((c) => c.id),
        )
        const orphans = toInsert.filter((x) => !placedIds.has(x.clip.id))
        if (orphans.length > 0) {
          for (const o of orphans) {
            const wantedType = o.clip.sourceType === 'audio' ? 'audio' : 'video'
            const fallback = updatedTracks.find((tr) => tr.type === wantedType && !tr.locked)
            if (!fallback) continue
            fallback.clips = [...fallback.clips, { ...o.clip, trackId: fallback.id }]
          }
        }

        const sg = state.project.sceneGraph
        return {
          ...(newScenes.length ? { scenes: [...state.scenes, ...newScenes] } : {}),
          project: {
            ...state.project,
            timeline: { ...t, tracks: updatedTracks },
            sceneGraph:
              newScenes.length && sg
                ? {
                    ...sg,
                    nodes: [
                      ...(sg.nodes ?? []),
                      ...newScenes.map((s, i) => ({ id: s.id, position: { x: 0, y: (i + 1) * 120 } })),
                    ],
                  }
                : sg,
            updatedAt: new Date().toISOString(),
          },
          selectedClipIds: newIds,
        }
      })
      // Write the cloned scenes' HTML so their iframes can load.
      for (const s of newScenes) get().saveSceneHTML?.(s.id)
      get().scheduleSaveProjectToDb()
      return newIds
    },

    setSequenceInPoint: (time: number | null) => {
      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        // Clamp so in <= out when both are set.
        const next: Partial<Timeline> = { inPoint: time === null ? undefined : Math.max(0, time) }
        if (time !== null && tl.outPoint != null && tl.outPoint < time) next.outPoint = undefined
        return {
          project: {
            ...state.project,
            timeline: { ...tl, ...next },
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    setSequenceOutPoint: (time: number | null) => {
      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        const next: Partial<Timeline> = { outPoint: time === null ? undefined : Math.max(0, time) }
        if (time !== null && tl.inPoint != null && tl.inPoint > time) next.inPoint = undefined
        return {
          project: {
            ...state.project,
            timeline: { ...tl, ...next },
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    addEditAtTime: (time: number, trackIds?: string[]) => {
      const tl = get().project.timeline
      if (!tl) return []
      const allow = trackIds ? new Set(trackIds) : null
      // Collect targets first so we know whether to push undo at all (the op
      // is a single user action — Cmd+Z should undo the whole add-edit, not
      // one split at a time as it used to).
      const targets: { clipId: string; rel: number }[] = []
      for (const t of tl.tracks) {
        if (t.locked) continue
        if (allow && !allow.has(t.id)) continue
        for (const c of t.clips) {
          if (c.startTime + 0.001 >= time || c.startTime + c.duration - 0.001 <= time) continue
          // Scene clips split too now (NLE-foundation) — see the splitClip guard removal.
          targets.push({ clipId: c.id, rel: time - c.startTime })
        }
      }
      if (targets.length === 0) return []
      get()._pushUndo?.()
      const newIds: string[] = []
      for (const { clipId, rel } of targets) {
        const res = get().splitClip(clipId, rel, { skipUndo: true })
        if (res?.rightId) newIds.push(res.rightId)
      }
      return newIds
    },

    addMarker: (time: number, label?: string) => {
      const id = uuidv4()
      set((state) => {
        const tl = state.project.timeline ?? { tracks: [], markers: [] }
        const markers = [...(tl.markers ?? []), { id, time: Math.max(0, time), label }]
        return {
          project: {
            ...state.project,
            timeline: { ...tl, markers },
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
      return id
    },

    removeMarker: (markerId: string) => {
      set((state) => {
        const tl = state.project.timeline
        if (!tl?.markers?.length) return state
        return {
          project: {
            ...state.project,
            timeline: { ...tl, markers: tl.markers.filter((m) => m.id !== markerId) },
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    updateMarker: (markerId: string, updates: Partial<{ time: number; label: string; color: string }>) => {
      set((state) => {
        const tl = state.project.timeline
        if (!tl?.markers?.length) return state
        return {
          project: {
            ...state.project,
            timeline: {
              ...tl,
              markers: tl.markers.map((m) => (m.id === markerId ? { ...m, ...updates } : m)),
            },
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    unlinkGroup: (clipId: string) => {
      const tl = get().project.timeline
      if (!tl) return
      const ref = findClip(tl, clipId)
      const groupId = ref?.clip.linkGroupId
      if (!groupId) return
      // Avatar groups are managed by syncTimelineFromScenes — it re-spawns
      // both clips with the same `avatar:<layerId>` linkGroupId every sync,
      // so a manual unlink is silently undone. Refuse the op rather than
      // pretend it worked.
      if (groupId.startsWith('avatar:')) {
        console.warn('[timeline] cannot unlink avatar group; delete the avatar layer instead')
        get().showTransientStatus?.('Avatar A/V pair cannot be unlinked. Delete the avatar layer instead.', 3000)
        return
      }
      get()._pushUndo?.()
      set((state) => {
        if (!state.project.timeline) return state
        return {
          project: {
            ...state.project,
            timeline: unlinkGroupInTimeline(state.project.timeline, groupId),
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    linkClips: (clipIds: string[]) => {
      if (clipIds.length < 2) return
      const tl = get().project.timeline
      if (!tl) return
      // If any input clip already belongs to a link group, all input clips
      // (and their existing siblings) must be unified — silently moving a
      // subset of an existing group into a new id would orphan the rest.
      const allClipsArr = tl.tracks.flatMap((t) => t.clips)
      const input = clipIds.map((id) => allClipsArr.find((c) => c.id === id)).filter((c): c is Clip => !!c)
      if (input.length < 2) return
      const priorGroups = new Set<string>()
      for (const c of input) {
        if (c.linkGroupId) priorGroups.add(c.linkGroupId)
      }
      // Refuse to merge avatar groups — they're sync-managed and would just
      // be reformed on the next tick.
      for (const g of priorGroups) {
        if (g.startsWith('avatar:')) {
          console.warn('[timeline] cannot relink clips that belong to an avatar group')
          get().showTransientStatus?.('Avatar A/V pairs cannot be relinked to other clips.', 3000)
          return
        }
      }
      get()._pushUndo?.()
      const groupId = `link:${uuidv4()}`
      // Union: every clip already in any of the prior groups joins the new
      // group, plus the input clips themselves. This prevents the orphan
      // case where linking a subset of group X with a clip from group Y
      // leaves the rest of X/Y dangling.
      const idsToLink = new Set<string>(clipIds)
      if (priorGroups.size > 0) {
        for (const c of allClipsArr) {
          if (c.linkGroupId && priorGroups.has(c.linkGroupId)) idsToLink.add(c.id)
        }
      }
      set((state) => {
        if (!state.project.timeline) return state
        return {
          project: {
            ...state.project,
            timeline: linkClipsInTimeline(state.project.timeline, Array.from(idsToLink), groupId),
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    groupClips: (clipIds: string[]) => {
      if (clipIds.length < 2) return
      const tl = get().project.timeline
      if (!tl) return
      get()._pushUndo?.()
      const groupId = `group:${uuidv4()}`
      const ids = new Set(clipIds)
      set((state) => {
        const t = state.project.timeline
        if (!t) return state
        return {
          project: {
            ...state.project,
            timeline: {
              ...t,
              tracks: t.tracks.map((tr) => ({
                ...tr,
                clips: tr.clips.map((c) => (ids.has(c.id) ? { ...c, groupId } : c)),
              })),
            },
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    ungroupClip: (clipId: string) => {
      const tl = get().project.timeline
      if (!tl) return
      const target = tl.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId)
      const gid = target?.groupId
      if (!gid) return
      get()._pushUndo?.()
      set((state) => {
        const t = state.project.timeline
        if (!t) return state
        return {
          project: {
            ...state.project,
            timeline: {
              ...t,
              tracks: t.tracks.map((tr) => ({
                ...tr,
                clips: tr.clips.map((c) => (c.groupId === gid ? { ...c, groupId: undefined } : c)),
              })),
            },
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()
    },

    batchUpdateClips: (batch: Array<{ id: string; updates: Partial<Clip> }>) => {
      if (batch.length === 0) return
      // Snapshot prior values for the emit-only clip/move actions (multi-clip
      // drag is the main caller and only mutates startTime).
      const tlBefore = get().project.timeline
      const priorById = new Map<string, { startTime: number; trackId: string }>()
      for (const { id } of batch) {
        const found = tlBefore?.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
        if (found) priorById.set(id, { startTime: found.startTime, trackId: found.trackId })
      }
      // Skip the undo push when no clip moved (no-op multi-drag).
      const anyChange = batch.some(({ id, updates }) => {
        const prior = priorById.get(id)
        if (!prior) return false
        if (typeof updates.startTime !== 'number') return Object.keys(updates).length > 0
        return updates.startTime !== prior.startTime
      })
      // Strangler-fig: push a legacy snapshot pre-mutation so Cmd+Z reverts.
      if (anyChange) get()._pushUndo?.()

      set((state) => {
        const tl = state.project.timeline
        if (!tl) return state
        const updateMap = new Map(batch.map(({ id, updates }) => [id, updates]))
        // Reject moves to incompatible track types (audio→video, etc.). The
        // moveClip path already guards this; batchUpdateClips is the other
        // arm and was previously letting agent paths slip through silently.
        const trackById = new Map(tl.tracks.map((t) => [t.id, t] as const))
        return {
          project: {
            ...state.project,
            timeline: withTracks(
              tl,
              tl.tracks.map((t) => ({
                ...t,
                clips: t.clips.map((c) => {
                  const u = updateMap.get(c.id)
                  if (!u) return c
                  if (typeof u.trackId === 'string' && u.trackId !== c.trackId) {
                    const target = trackById.get(u.trackId)
                    if (!target || !canTrackAcceptClip(target.type, c.sourceType)) {
                      console.warn(
                        `[timeline] batchUpdateClips dropped trackId change for ${c.id}: ${c.sourceType} cannot land on ${target?.type ?? 'missing'} track`,
                      )
                      const { trackId: _drop, ...rest } = u
                      return { ...c, ...rest }
                    }
                  }
                  return { ...c, ...u }
                }),
              })),
            ),
            updatedAt: new Date().toISOString(),
          },
        }
      })
      get().scheduleSaveProjectToDb()

      // Emit one clip/move per entry whose update changes startTime. Other
      // batch updates (opacity, fade, etc.) don't map cleanly to a single
      // action type and are not recorded here — they belong on the inspector
      // path which dispatches typed actions directly.
      for (const { id, updates } of batch) {
        const prior = priorById.get(id)
        if (!prior) continue
        if (typeof updates.startTime !== 'number') continue
        if (updates.startTime === prior.startTime) continue
        get().recordUserAction({
          type: 'clip/move',
          params: {
            clipId: id,
            startTime: updates.startTime,
            prior,
          },
        })
      }
    },
  }
}
