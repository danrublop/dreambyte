/**
 * Shared clip-move write-through.
 *
 * Moving a clip touches BOTH the timeline (the clip's new track/startTime, plus
 * any linked siblings) AND the scene SOURCE state the timeline is derived from
 * (audioLayer.startOffset, sfx.triggerAt, avatar aiLayer.startAt, text
 * overlay.delay, and scene order). If only the timeline is mutated, the next
 * `syncTimelineFromScenes` re-derives the mirror clips from the STALE scene
 * state and snaps the move back. So the source write-back is not optional — it
 * is what makes a move durable.
 *
 * ONE pure `(timeline, scenes) → { timeline, scenes }` function lets the store
 * (`moveClip`) AND the agent's `move_clip` handler share a single
 * implementation — the agent world mutates `world.timeline` AND `world.scenes`
 * through the same transform, so the editor's scenes-sync can't resurrect /
 * snap-back an agent move.
 *
 * Pure: returns NEW timeline + scenes (or the same references when the move was
 * a rejected/no-op), never mutates the inputs.
 */

import type { Clip, Scene, Timeline } from '@/lib/types'

export interface ClipMoveTarget {
  toTrackId: string
  startTime: number
}

export interface ClipMoveWriteThroughResult {
  timeline: Timeline
  scenes: Scene[]
  /** False when the move was rejected (clip/track missing, type mismatch,
   *  cross-track scene move) or a true no-op — callers skip undo/save/emit. */
  changed: boolean
  /** Why a move was rejected (for an honest tool error / a console warn). */
  rejectedReason?: string
}

/**
 * Whether a clip type can sit on a track type. Verbatim mirror of
 * src/lib/timeline/snap-engine canTrackAcceptClip (agent-side copy — the agent runtime must not
 * import renderer-only modules; the store injects the real one, see below).
 */
function canTrackAcceptClip(trackType: string, clipSourceType: string): boolean {
  if (clipSourceType === 'audio') return trackType === 'audio'
  if (clipSourceType === 'scene') return trackType === 'scene' || trackType === 'video' || trackType === 'graphics'
  if (clipSourceType === 'video') return trackType === 'video' || trackType === 'graphics'
  if (clipSourceType === 'image') return trackType === 'image' || trackType === 'video' || trackType === 'graphics'
  if (clipSourceType === 'title') return trackType === 'text' || trackType === 'graphics'
  if (clipSourceType === 'avatar') return trackType === 'video' || trackType === 'graphics'
  return trackType === 'graphics'
}

/**
 * Apply a clip move to the timeline AND its scene source state.
 *
 * `canTrackAcceptClip` is injected so the store can pass the canonical
 * snap-engine implementation; the agent path uses the local default (identical
 * rules) to avoid importing renderer-only modules in the agent runtime.
 */
export function applyClipMoveWriteThrough(
  timeline: Timeline | null | undefined,
  scenes: Scene[],
  clipId: string,
  target: ClipMoveTarget,
  opts: {
    accepts?: (trackType: string, clipSourceType: string) => boolean
    /**
     * When false, the returned `scenes` carry the scene-ORDER change only (after
     * a scene-clip reorder) but NOT the source field write-backs
     * (audioLayer.startOffset / sfx.triggerAt / avatar.startAt / text.delay).
     * The renderer store sets `false` because it applies those write-backs
     * through its side-effecting setters (HTML regen + action log). The agent
     * sets `true` (the default) so a single transform mutates world.scenes
     * fully — nothing else writes them on that path.
     */
    writeBackSource?: boolean
  } = {},
): ClipMoveWriteThroughResult {
  const accepts = opts.accepts ?? canTrackAcceptClip
  const writeBackSource = opts.writeBackSource ?? true
  const tl = timeline ?? null
  const noChange = (reason?: string): ClipMoveWriteThroughResult => ({
    timeline: tl ?? { tracks: [] },
    scenes,
    changed: false,
    rejectedReason: reason,
  })
  if (!tl) return noChange('No timeline')

  const { toTrackId } = target
  let startTime = target.startTime

  const sourceBefore = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (!sourceBefore) return noChange(`Clip ${clipId} not found`)

  const targetTrack = tl.tracks.find((t) => t.id === toTrackId)
  if (!targetTrack) return noChange(`Target track ${toTrackId} not found`)
  if (!accepts(targetTrack.type, sourceBefore.sourceType)) {
    return noChange(`${sourceBefore.sourceType} clip cannot land on ${targetTrack.type} track`)
  }

  // TIMELINE-AUTHORITATIVE: scene clips may
  // live on ANY video track. Moving one up to V2 leaves a real gap on V1 (it
  // composites over the V1 hole); syncTimelineFromScenes tolerates a scene clip
  // off V1 (it spans all video tracks before materializing, so no phantom
  // duplicate). The old "scene clips stay on the primary video track" guard is
  // intentionally gone.

  startTime = Math.max(0, startTime)
  // No-op move — don't pollute undo / emit.
  if (sourceBefore.startTime === startTime && sourceBefore.trackId === toTrackId) {
    return noChange()
  }

  // ── 1. Timeline transform (remove from every track, re-add to target) ──
  let movedClip: Clip | null = null
  const tracksAfterRemove = tl.tracks.map((t) => ({
    ...t,
    clips: t.clips.filter((c) => {
      if (c.id === clipId) {
        movedClip = c
        return false
      }
      return true
    }),
  }))
  if (!movedClip) return noChange(`Clip ${clipId} not found`)
  const mc = movedClip as Clip
  const updatedClip: Clip = { ...mc, trackId: toTrackId, startTime }

  const delta = startTime - mc.startTime
  const isSceneClip = mc.sourceType === 'scene'
  const linkedIds = isSceneClip ? new Set([`aud-${mc.sourceId}`, `tts-${mc.sourceId}`, `mus-${mc.sourceId}`]) : null

  const tracksWithLinked = tracksAfterRemove.map((t) => ({
    ...t,
    clips: t.clips.map((c) => {
      // NLE-style link group: shift siblings by the same delta.
      if (mc.linkGroupId && c.linkGroupId === mc.linkGroupId && c.id !== mc.id) {
        return { ...c, startTime: Math.max(0, c.startTime + delta) }
      }
      // Plain group (Cmd+G): also shift siblings.
      if (mc.groupId && c.groupId === mc.groupId && c.id !== mc.id) {
        return { ...c, startTime: Math.max(0, c.startTime + delta) }
      }
      if (!isSceneClip || !linkedIds) return c
      if (linkedIds.has(c.sourceId)) return { ...c, startTime: Math.max(0, c.startTime + delta) }
      // SFX clips owned by the moved scene.
      if (
        c.sourceType === 'audio' &&
        !c.sourceId.startsWith('aud-') &&
        !c.sourceId.startsWith('tts-') &&
        !c.sourceId.startsWith('mus-')
      ) {
        const ownerScene = scenes.find(
          (s) => s.audioLayer?.sfx?.some((sfx) => sfx.id === c.sourceId) && s.id === mc.sourceId,
        )
        if (ownerScene) return { ...c, startTime: Math.max(0, c.startTime + delta) }
      }
      return c
    }),
  }))

  const finalTracks = tracksWithLinked.map((t) => (t.id === toTrackId ? { ...t, clips: [...t.clips, updatedClip] } : t))

  // Scene order follows clip order across ALL video tracks after a scene move
  // (composite model: a clip on V2 keeps its by-startTime sequence position, it
  // is not yanked to the end just because it left V1). Sorted by startTime, ties
  // broken by track position so a higher lane wins deterministically.
  let nextScenes = scenes
  if (isSceneClip) {
    const trackPos = new Map(finalTracks.map((t) => [t.id, t.position]))
    const orderedSceneClips = finalTracks
      .filter((t) => t.type === 'video')
      .flatMap((t) => t.clips)
      .filter((c) => c.sourceType === 'scene')
      .sort((a, b) => a.startTime - b.startTime || (trackPos.get(b.trackId) ?? 0) - (trackPos.get(a.trackId) ?? 0))
    const newOrder = orderedSceneClips.map((c) => c.sourceId)
    if (newOrder.length > 0) {
      const candidate = [...scenes].sort((a, b) => {
        const ia = newOrder.indexOf(a.id)
        const ib = newOrder.indexOf(b.id)
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib)
      })
      const orderChanged = candidate.some((s, i) => scenes[i]?.id !== s.id)
      if (orderChanged) nextScenes = candidate
    }
  }

  const nextTimeline: Timeline = { ...tl, tracks: finalTracks }

  // ── 2. Scene SOURCE write-back (the part that survives the next sync) ──
  // The moved clip's final position is read from nextTimeline; the scene's V1
  // start anchors the relative offset/delay/startAt written back.
  const movedFinal = nextTimeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (writeBackSource && movedFinal) {
    const sceneStartOf = (sceneId: string): number =>
      nextTimeline.tracks
        .slice()
        .sort((a, b) => a.position - b.position)
        .find((t) => t.type === 'video')
        ?.clips.find((c) => c.sourceType === 'scene' && c.sourceId === sceneId)?.startTime ?? 0

    const avLinkPrefix = 'avatar:'
    const textLinkPrefix = 'text:'

    if (movedFinal.linkGroupId?.startsWith(avLinkPrefix)) {
      // Avatar clip → write back aiLayer.startAt relative to its scene clip.
      const avatarId = movedFinal.linkGroupId.slice(avLinkPrefix.length)
      nextScenes = nextScenes.map((scene) => {
        const layer = scene.aiLayers?.find((l) => l.id === avatarId && l.type === 'avatar')
        if (!layer) return scene
        const newStartAt = Math.max(0, movedFinal.startTime - sceneStartOf(scene.id))
        if (Math.abs((layer.startAt ?? 0) - newStartAt) <= 0.0001) return scene
        return {
          ...scene,
          aiLayers: (scene.aiLayers ?? []).map((l) => (l.id === avatarId ? { ...l, startAt: newStartAt } : l)),
        }
      })
    } else if (movedFinal.linkGroupId?.startsWith(textLinkPrefix)) {
      // Text-overlay clip → write back overlay.delay relative to its scene clip.
      const overlayId = movedFinal.linkGroupId.slice(textLinkPrefix.length)
      nextScenes = nextScenes.map((scene) => {
        const overlay = scene.textOverlays?.find((o) => o.id === overlayId)
        if (!overlay) return scene
        const newDelay = Math.max(0, movedFinal.startTime - sceneStartOf(scene.id))
        if (Math.abs((overlay.delay ?? 0) - newDelay) <= 0.0001) return scene
        return {
          ...scene,
          textOverlays: (scene.textOverlays ?? []).map((o) => (o.id === overlayId ? { ...o, delay: newDelay } : o)),
        }
      })
    } else if (movedFinal.sourceType === 'audio') {
      const sid = movedFinal.sourceId
      if (sid.startsWith('aud-') || sid.startsWith('tts-') || sid.startsWith('mus-')) {
        // Narration/music clip → write back audioLayer.startOffset.
        const sceneId = sid.slice(4)
        nextScenes = nextScenes.map((scene) => {
          if (scene.id !== sceneId || !scene.audioLayer) return scene
          const newOffset = Math.max(0, movedFinal.startTime - sceneStartOf(sceneId))
          return { ...scene, audioLayer: { ...scene.audioLayer, startOffset: newOffset } }
        })
      } else {
        // SFX clip → write back the matching sfx.triggerAt.
        nextScenes = nextScenes.map((scene) => {
          const sfx = scene.audioLayer?.sfx?.find((s) => s.id === sid)
          if (!sfx || !scene.audioLayer) return scene
          const newTriggerAt = Math.max(0, movedFinal.startTime - sceneStartOf(scene.id))
          return {
            ...scene,
            audioLayer: {
              ...scene.audioLayer,
              sfx: (scene.audioLayer.sfx ?? []).map((s) => (s.id === sid ? { ...s, triggerAt: newTriggerAt } : s)),
            },
          }
        })
      }
    }
  }

  return { timeline: nextTimeline, scenes: nextScenes, changed: true }
}
