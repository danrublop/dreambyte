'use client'

import { useVideoStore } from '@/lib/store'
import type { TransitionType } from '@/lib/transitions'
import type { CameraEffectId } from '@/lib/camera-effects'
import { defaultCameraMoveParams } from '@/lib/camera-effects'
import type { CameraMove } from '@/lib/types/scene'

/** MIME used when a transition preset card is dragged onto the timeline. */
export const TRANSITION_DRAG_MIME = 'application/x-dreambyte-transition'
/** MIME used when a camera-effect preset card is dragged onto the timeline. */
export const CAMERA_DRAG_MIME = 'application/x-dreambyte-camera'

export interface TransitionDragPayload {
  id: TransitionType
}

export interface CameraDragPayload {
  id: CameraEffectId
}

export interface ApplyResult {
  ok: boolean
  error?: string
}

/** Resolve a timeline clip → the scene it belongs to (only meaningful for scene clips). */
function sceneIdFromClipId(clipId: string): string | null {
  const tl = useVideoStore.getState().project.timeline
  if (!tl) return null
  const clip = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (!clip) return null
  if (clip.sourceType === 'scene') return clip.sourceId
  return null
}

export function applyTransitionToClip(clipId: string, transition: TransitionType): ApplyResult {
  const sceneId = sceneIdFromClipId(clipId)
  if (!sceneId) return { ok: false, error: 'Transitions can only be dropped on scene clips.' }
  useVideoStore.getState().updateScene(sceneId, { transition })
  useVideoStore.getState().saveSceneHTML(sceneId)
  return { ok: true }
}

export function applyCameraEffectToClip(clipId: string, effectId: CameraEffectId): ApplyResult {
  const sceneId = sceneIdFromClipId(clipId)
  if (!sceneId) return { ok: false, error: 'Camera effects can only be dropped on scene clips.' }
  const state = useVideoStore.getState()
  const scene = state.scenes.find((s) => s.id === sceneId)
  if (!scene) return { ok: false, error: 'Scene not found.' }

  if (effectId === 'none') {
    state.updateScene(sceneId, { cameraMotion: null })
  } else {
    const prev = scene.cameraMotion?.[0]
    const move: CameraMove = {
      type: effectId as CameraMove['type'],
      params: defaultCameraMoveParams(scene.duration, prev),
    }
    state.updateScene(sceneId, { cameraMotion: [move] })
  }
  state.saveSceneHTML(sceneId)
  return { ok: true }
}
