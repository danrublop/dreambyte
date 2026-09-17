/**
 * Shared scene→clip cascade predicate.
 *
 * When a scene is deleted, every timeline clip that depends on it must go too,
 * or the timeline is left with dangling references. Two delete entry points need
 * the EXACT same rule so they leave the timeline in an identical state:
 *   - `scene/delete` (scene-reducer.ts) — deleting the scene directly
 *   - `clip/remove` scene path (clip-reducer.ts §2c) — deleting the scene's clip
 *
 * Both go through `makeSceneClipCascadeFilter` so the definition of "dependent"
 * can never drift between them. A dependent clip is:
 *   - the scene clip itself (`sourceType:'scene'`, `sourceId === sceneId`)
 *   - an audio clip derived from the scene's audioLayer
 *     (`aud-`/`tts-`/`mus-{sceneId}` or an sfx id on the scene)
 *   - an avatar clip: each avatar aiLayer emits a video + audio clip sharing
 *     `linkGroupId = avatar:<layerId>` (see src/lib/store/timeline-actions.ts). Both
 *     are keyed by the avatar layer id, NOT by sceneId, so they need their own
 *     match.
 */

import type { Clip, Scene } from '@/lib/types'

/** Result of `cascadeClipSourceMutations` — see below. */
export interface ClipSourceCascade {
  /** Scenes with the implied source mutations applied (same reference when nothing matched). */
  scenes: Scene[]
  /** The avatar aiLayer id that was stripped, when the clip was half of an `avatar:<id>` A/V pair. */
  removedAvatarLayerId: string | null
  /** Owning scene ids whose HTML must regenerate (an avatar layer or text overlay was removed). */
  affectedSceneIds: string[]
}

/**
 * Source-state cleanup a clip deletion implies.
 *
 * Timeline clips for avatars and text overlays are MIRRORS of scene state:
 * `syncTimelineFromScenes` re-emits an avatar A/V pair for every
 * `scene.aiLayers` avatar entry and a title clip for every
 * `scene.textOverlays` entry on every sync. Deleting only the clip therefore
 * resurrects it on the next sync — the source entry must go with it:
 *   - avatar clip (video or audio half, `linkGroupId = avatar:<layerId>`)
 *     → strip the avatar layer from `scene.aiLayers`
 *   - mirrored title clip (`linkGroupId = text:<overlayId>`, see the sync's
 *     text mirroring) → remove the matching `scene.textOverlays` entry
 *
 * Shared by BOTH delete paths — the `clip/remove` reducer and the store's
 * `removeClipRipple` — so plain and ripple delete imply identical source
 * cleanup and can't drift. Pure: returns new scenes, never mutates.
 *
 * Out of scope here (still reducer-only): scene-clip cascade (whole-scene
 * delete) and audioLayer field clearing for `aud-`/`tts-`/`mus-`/sfx clips.
 */
export function cascadeClipSourceMutations(scenes: Scene[], clip: Clip): ClipSourceCascade {
  const groupId = clip.linkGroupId
  const avatarLayerId = groupId?.startsWith('avatar:') ? groupId.slice('avatar:'.length) : null
  if (avatarLayerId) {
    const affectedSceneIds: string[] = []
    const next = scenes.map((s) => {
      const layers = s.aiLayers ?? []
      if (!layers.some((l) => l.id === avatarLayerId)) return s
      affectedSceneIds.push(s.id)
      return { ...s, aiLayers: layers.filter((l) => l.id !== avatarLayerId) }
    })
    return {
      scenes: affectedSceneIds.length > 0 ? next : scenes,
      removedAvatarLayerId: avatarLayerId,
      affectedSceneIds,
    }
  }

  const overlayId = groupId?.startsWith('text:') ? groupId.slice('text:'.length) : null
  if (overlayId) {
    const affectedSceneIds: string[] = []
    const next = scenes.map((s) => {
      const overlays = s.textOverlays ?? []
      if (!overlays.some((o) => o.id === overlayId)) return s
      affectedSceneIds.push(s.id)
      return { ...s, textOverlays: overlays.filter((o) => o.id !== overlayId) }
    })
    return {
      scenes: affectedSceneIds.length > 0 ? next : scenes,
      removedAvatarLayerId: null,
      affectedSceneIds,
    }
  }

  return { scenes, removedAvatarLayerId: null, affectedSceneIds: [] }
}

/**
 * Build a predicate `(clip) => shouldRemove` for deleting `sceneId`. The
 * removed-scene's audioLayer + avatar aiLayers are read once up front, so the
 * returned predicate is O(1) per clip. `removedScene` may be undefined (the
 * scene already gone) — then only the scene/audio-id matches by name apply.
 */
export function makeSceneClipCascadeFilter(sceneId: string, removedScene: Scene | undefined): (clip: Clip) => boolean {
  const sfxIds = new Set((removedScene?.audioLayer?.sfx ?? []).map((x) => x.id))
  const avatarLayerIds = (removedScene?.aiLayers ?? []).filter((l) => l.type === 'avatar').map((l) => l.id)
  const avatarGroups = new Set(avatarLayerIds.map((id) => `avatar:${id}`))
  const avatarLayerSet = new Set(avatarLayerIds)

  return (clip: Clip): boolean => {
    if (clip.sourceType === 'scene' && clip.sourceId === sceneId) return true
    if (
      clip.sourceType === 'audio' &&
      (clip.sourceId === `aud-${sceneId}` ||
        clip.sourceId === `tts-${sceneId}` ||
        clip.sourceId === `mus-${sceneId}` ||
        sfxIds.has(clip.sourceId))
    )
      return true
    // Avatar video + audio clips of the deleted scene's avatar layers.
    if (clip.linkGroupId && avatarGroups.has(clip.linkGroupId)) return true
    if (clip.sourceType === 'avatar' && avatarLayerSet.has(clip.sourceId)) return true
    if (
      clip.sourceType === 'audio' &&
      clip.sourceId.startsWith('avatar-audio:') &&
      avatarLayerSet.has(clip.sourceId.slice('avatar-audio:'.length))
    )
      return true
    return false
  }
}
