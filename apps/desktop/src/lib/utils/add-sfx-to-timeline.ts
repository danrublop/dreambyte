'use client'

import { useVideoStore } from '@/lib/store'
import type { SFXResult } from '@/lib/audio/types'
import type { ZzfxSfxPreset } from '@/lib/audio/sfx-zzfx-presets'
import { buildZzfxWavObjectUrl, uploadAudioBlob } from '@/lib/audio/sfx-zzfx-client'

/** MIME used when a card from the SFX library is dragged onto the timeline. */
export const SFX_DRAG_MIME = 'application/x-dreambyte-sfx'

/** Payload variants serialized in the drag MIME. */
export type SfxDragPayload = { kind: 'ready'; result: SFXResult } | { kind: 'zzfx'; preset: ZzfxSfxPreset }

export interface AddSfxResult {
  ok: boolean
  error?: string
}

/**
 * Resolve the SFX into a playable URL + duration, attach it to whichever scene
 * contains `globalTime`, and let the timeline sync derive the audio clip.
 *
 * - `ready` payloads (native/remote search results) already have a URL.
 * - `zzfx` payloads are built into a WAV on the fly and uploaded via the
 *   existing helper so the URL is persistent across reloads.
 *
 * Returns `{ ok: false, error }` when the drop target sits in dead air
 * between scenes — we don't try to invent a scene to host the clip.
 */
export async function addSfxAtGlobalTime(payload: SfxDragPayload, globalTime: number): Promise<AddSfxResult> {
  const state = useVideoStore.getState()
  const scenes = state.scenes
  if (scenes.length === 0) return { ok: false, error: 'Add a scene first, then drop SFX onto the timeline.' }

  // Walk scenes to find which one contains globalTime
  let acc = 0
  let target: { id: string; start: number; end: number } | null = null
  for (const s of scenes) {
    const end = acc + s.duration
    if (globalTime >= acc && globalTime < end) {
      target = { id: s.id, start: acc, end }
      break
    }
    acc = end
  }
  // If we dropped past the end, attach to the last scene
  if (!target) {
    const last = scenes[scenes.length - 1]
    const start = scenes.slice(0, -1).reduce((a, s) => a + s.duration, 0)
    target = { id: last.id, start, end: start + last.duration }
  }

  const relativeTrigger = Math.max(0, Math.min(target.end - target.start, globalTime - target.start))

  let resolved: {
    id: string
    name: string
    provider: string
    src: string
    duration: number | null
    license: string | null
  }

  if (payload.kind === 'ready') {
    const r = payload.result
    const src = r.audioUrl ?? r.previewUrl ?? ''
    if (!src) return { ok: false, error: 'Sound has no playable URL.' }
    // Uniquify per-drop so dropping the same sound twice produces two distinct
    // SFX rows (and React keys / remove-by-id behave correctly).
    resolved = {
      id: `${r.id}-${Date.now()}`,
      name: r.name,
      provider: r.provider ?? 'freesound',
      src,
      duration: r.duration ?? null,
      license: r.license ?? null,
    }
  } else {
    const preset = payload.preset
    const { url, durationSec, revoke } = await buildZzfxWavObjectUrl(preset)
    try {
      const blob = await fetch(url).then((r) => r.blob())
      const uploaded = await uploadAudioBlob(blob, `zzfx-${preset.id}.wav`)
      resolved = {
        id: `zzfx-${preset.id}-${Date.now()}`,
        name: preset.name,
        provider: 'zzfx',
        src: uploaded,
        duration: durationSec,
        license: 'MIT (ZzFX)',
      }
    } finally {
      revoke()
    }
  }

  useVideoStore.getState().addSFXToScene(target.id, {
    id: resolved.id,
    name: resolved.name,
    provider: resolved.provider as never,
    src: resolved.src,
    triggerAt: relativeTrigger,
    volume: 1,
    duration: resolved.duration,
    license: resolved.license,
  })
  return { ok: true }
}
