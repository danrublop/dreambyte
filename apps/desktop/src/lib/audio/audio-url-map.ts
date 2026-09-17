/**
 * Pure scene → audio-URL resolver, shared by the React timeline and the
 * (non-React) timeline audio engine.
 *
 * Originally this lived in `src/components/timeline/AudioUrlMapContext.ts`, but
 * that file is a `'use client'` React module (it owns the context + hook).
 * The unified audio engine (`src/lib/audio/timeline-audio-engine.ts`) needs the
 * SAME source-id → URL conventions to locate the audio for scene-mirror
 * clips (tts-/mus-/aud-/sfx/avatar-audio), and it must not import a React
 * component file. So the map builder is extracted here, in src/lib/, where both
 * sides can depend on it. The context file re-exports `buildAudioUrlMap` for
 * backwards compatibility, so existing imports keep working.
 *
 * The conventions mirror `syncTimelineFromScenes` exactly — change them in
 * one place and both the visual timeline and the engine stay in lockstep:
 *
 *   - `aud-<sceneId>`           → audioLayer.src
 *   - `tts-<sceneId>`           → audioLayer.tts.src
 *   - `mus-<sceneId>`           → audioLayer.music.src
 *   - `avatar-audio:<layerId>`  → videoUrl
 *   - raw sfx.id                → sfx.src
 */

import type { AvatarLayer, Scene } from '@/lib/types'

export function buildAudioUrlMap(scenes: Scene[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const s of scenes) {
    const al = s.audioLayer
    if (al?.src) map.set(`aud-${s.id}`, al.src)
    if (al?.tts?.src) map.set(`tts-${s.id}`, al.tts.src)
    if (al?.music?.src) map.set(`mus-${s.id}`, al.music.src)
    for (const sfx of al?.sfx ?? []) {
      // Keep the id in the map even while src is empty/pending: the KEY SET is
      // the scene-mirror membership test (isStandaloneAudioClip), and a
      // still-generating SFX must not be misread as a standalone file. An empty
      // URL is falsy, so playback/export resolve it to "skip", which is right.
      map.set(sfx.id, sfx.src ?? '')
    }
    for (const layer of s.aiLayers ?? []) {
      if (layer.type !== 'avatar') continue
      const av = layer as AvatarLayer
      const url = av.videoUrl ?? null
      if (url) map.set(`avatar-audio:${av.id}`, url)
    }
  }
  return map
}
