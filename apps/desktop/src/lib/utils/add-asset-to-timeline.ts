'use client'

import { useVideoStore } from '@/lib/store'
import { resolveProjectDimensions } from '@/lib/dimensions'
import { probeMediaDuration } from '@/lib/utils/media-probe'
import type { ProjectAsset } from '@/lib/types'

export interface AddAssetResult {
  ok: boolean
  error?: string
}

/** Stills have no intrinsic duration — the standard NLE default. */
const IMAGE_SCENE_DURATION = 5

/**
 * First unlocked audio track with FREE space for [start, start+duration) —
 * linked video audio must land at its video's exact time, so when A1 is
 * occupied there it spills to A2 (and creates a new track when every audio
 * track is busy) instead of overlapping existing clips.
 */
export function findFreeAudioTrack(start: number, duration: number): string {
  const st = useVideoStore.getState()
  const tracks = (st.project.timeline?.tracks ?? [])
    .filter((t) => t.type === 'audio' && !t.locked)
    .sort((a, b) => a.position - b.position)
  const end = start + duration
  for (const t of tracks) {
    const overlaps = t.clips.some((c) => start < c.startTime + c.duration && c.startTime < end)
    if (!overlaps) return t.id
  }
  return st.addTrack('audio')
}

/**
 * Place a ProjectAsset onto the timeline.
 *
 * Dropping media NEVER requires an existing scene — each video/image asset
 * becomes its OWN scene (the same model as everything else in the editor),
 * so it shows up in the layer stack, the Layer/Components/Code panel, the
 * preview, and the timeline through the one scene pipeline that already
 * exists:
 *
 * - Video / avatar renders → a new scene with the asset as its `videoLayer`
 *   (the same field the Layers tab's video-upload flow sets), duration from
 *   the asset's stored duration or a probe.
 * - Image / SVG → a new scene with the asset as a ready `aiLayers` image
 *   entry, 5s default duration.
 * - Audio → a clip on the first unlocked audio track (audio has no visual
 *   scene; this mirrors the native file-drop import).
 *
 * Used by both the Gallery panel's add-to-timeline action and the timeline's
 * own drop handler when an asset card is dragged onto it.
 */
export async function addAssetToTimeline(
  asset: ProjectAsset,
  opts?: { startTime?: number; insert?: boolean },
): Promise<AddAssetResult> {
  if (asset.type === 'audio') return addAudioClip(asset, opts)
  // Reference documents (md/pdf/…) aren't visual media — they can't go on the
  // timeline. Guard here so any stray path (drag, gallery action) fails cleanly
  // instead of falling through to the image branch below.
  if (asset.type === 'doc') return { ok: false, error: `${asset.name} is a document, not timeline media.` }

  const isVideo = asset.type === 'video' || asset.type === 'avatar'

  let duration = IMAGE_SCENE_DURATION
  if (isVideo) {
    const assetDuration = Number(asset.durationSeconds)
    if (Number.isFinite(assetDuration) && assetDuration > 0) {
      duration = assetDuration
    } else {
      duration = await probeMediaDuration(asset.publicUrl, 'video')
        .then((r) => r.duration)
        .catch(() => 5)
    }
  }

  const store = useVideoStore.getState()
  const sceneId = store.addScene()
  const fresh = useVideoStore.getState()

  if (isVideo) {
    const scene = fresh.scenes.find((s) => s.id === sceneId)
    fresh.updateScene(sceneId, {
      name: asset.name,
      duration,
      // Black letterbox behind footage (the default scene white reads as a
      // blank frame around media; black is the standard NLE behavior).
      bgColor: '#000000',
      // The SVG template is the one that renders videoLayer (the react
      // default doesn't) — a video scene must use it or the footage is blank.
      sceneType: 'svg',
      videoLayer: {
        ...(scene?.videoLayer ?? { opacity: 1 }),
        enabled: true,
        src: asset.publicUrl,
        opacity: scene?.videoLayer?.opacity ?? 1,
        trimStart: 0,
        trimEnd: null,
      },
    })
  } else {
    const dims = resolveProjectDimensions(fresh.project.mp4Settings?.aspectRatio, fresh.project.mp4Settings?.resolution)
    const newLayer = {
      id: `asset-${asset.id}-${Date.now()}`,
      type: 'image' as const,
      prompt: asset.prompt ?? '',
      model: 'flux-schnell' as const,
      style: null,
      imageUrl: asset.publicUrl,
      x: Math.round(dims.width / 2),
      y: Math.round(dims.height / 2),
      width: asset.width ? Math.min(asset.width, dims.width) : Math.round(dims.width * 0.6),
      height: asset.height ? Math.min(asset.height, dims.height) : Math.round(dims.height * 0.6),
      rotation: 0,
      opacity: 1,
      zIndex: 10,
      status: 'ready' as const,
      label: asset.name,
    }
    fresh.updateScene(sceneId, { name: asset.name, duration, bgColor: '#000000', aiLayers: [newLayer] })
  }
  fresh.saveSceneHTML(sceneId)

  // NLE-style linked A/V pair: the in-scene <video> element is muted by
  // the template, so a video's soundtrack plays as its OWN audio clip on the
  // audio track (timeline audio engine: gain envelope, waveform, mute/solo),
  // linked to the scene clip so they move/select together. Skip only when the
  // upload probe proved there is no audio stream ('no-audio'); legacy assets
  // without either tag default to creating the pair.
  if (isVideo && !(asset.tags ?? []).includes('no-audio')) {
    const after = useVideoStore.getState()
    after.syncTimelineFromScenes()
    const synced = useVideoStore.getState()
    const v1 = synced.project.timeline?.tracks
      .slice()
      .sort((a, b) => a.position - b.position)
      .find((t) => t.type === 'video')
    const sceneClip = v1?.clips.find((c) => c.sourceType === 'scene' && c.sourceId === sceneId)
    if (sceneClip) {
      // Collision-aware: A1 if free at the video's range, else A2, else a
      // fresh audio track — never overlap existing audio clips.
      const audioTrackId = findFreeAudioTrack(sceneClip.startTime, duration)
      const linkGroupId = `avlink:${sceneId}`
      synced.addClip(audioTrackId, {
        sourceType: 'audio',
        sourceId: asset.publicUrl,
        label: asset.name,
        startTime: sceneClip.startTime,
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
        linkGroupId,
      } as Parameters<typeof synced.addClip>[1])
      synced.updateClip(sceneClip.id, { linkGroupId })
    }
  }
  return { ok: true }
}

/** Audio assets ride the audio track as clips (no visual scene). */
async function addAudioClip(
  asset: ProjectAsset,
  opts?: { startTime?: number; insert?: boolean },
): Promise<AddAssetResult> {
  let duration = Number(asset.durationSeconds)
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = await probeMediaDuration(asset.publicUrl, 'audio')
      .then((r) => r.duration)
      .catch(() => 5)
  }

  useVideoStore.getState().initTimeline()
  const freshState = useVideoStore.getState()
  const audioTracks = (freshState.project.timeline?.tracks ?? [])
    .filter((t) => t.type === 'audio' && !t.locked)
    .sort((a, b) => a.position - b.position)
  let trackId = audioTracks[0]?.id
  if (!trackId) trackId = useVideoStore.getState().addTrack('audio')

  const targetTrack = useVideoStore.getState().project.timeline?.tracks.find((t) => t.id === trackId)
  const endOfTrack = (targetTrack?.clips ?? []).reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0)
  const requestedStart = opts?.startTime
  const insert = opts?.insert === true
  const startTime = insert
    ? Math.max(0, requestedStart ?? endOfTrack)
    : typeof requestedStart === 'number'
      ? Math.max(endOfTrack, requestedStart)
      : endOfTrack

  if (insert && targetTrack) {
    const shifts = (targetTrack.clips ?? [])
      .filter((c) => c.startTime + 0.001 >= startTime)
      .map((c) => ({ id: c.id, updates: { startTime: c.startTime + duration } }))
    if (shifts.length > 0) useVideoStore.getState().batchUpdateClips(shifts)
  }

  useVideoStore.getState().addClip(trackId, {
    sourceType: 'audio',
    sourceId: asset.publicUrl,
    label: asset.name,
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
  return { ok: true }
}

/** MIME type used for dragging gallery asset cards onto the timeline. */
export const ASSET_DRAG_MIME = 'application/x-dreambyte-asset'
