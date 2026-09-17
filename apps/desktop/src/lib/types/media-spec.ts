/**
 * MediaSpec — the persistent, editable set of parameters that produced (or will
 * regenerate) an AI media layer. It lives INLINE on the layer (`AILayer.mediaSpec`) so the
 * spec travels with the layer it made, survives scene mutations, and needs no DB migration
 * (persisted with the scene via sceneBlob). The Cinema Studio panel reads/edits it and
 * regenerates from it; the agent populates it when it generates media.
 *
 * It deliberately reuses the vocabulary already established by the catalog + the characters
 * bundle (model / seed / strength / referenceAssetIds) so one mental model spans the whole
 * media stack.
 */

import type { CameraSpec } from '@/lib/media/camera'

export type MediaSpecModality = 'image' | 'video' | 'avatar'

export interface MediaSpec {
  /** What this spec generates — selects the transport + which fields are meaningful. */
  modality: MediaSpecModality
  /** Catalog model id (e.g. 'flux-1.1-pro', 'veo-3'). */
  model: string
  prompt: string
  negativePrompt?: string | null
  /** '16:9' | '9:16' | '1:1' | '4:3' | '3:4' — validated downstream, kept as a free string here. */
  aspectRatio?: string | null
  /** Video clip length in seconds. */
  duration?: number | null
  /** i2i conditioning strength 0..1 (how much the prompt overrides the reference). */
  strength?: number | null
  /** Pinned RNG seed for reproducibility. */
  seed?: number | null
  /** Camera/motion direction (compiled into the prompt for camera:'prompt' models). */
  camera?: CameraSpec | null
  /** Character bundle this render belongs to. */
  characterId?: string | null
  /** i2i reference asset ids (mirrors projectAssets.referenceAssetIds). */
  referenceAssetIds?: string[] | null
  /** Owning provider id (informational; the model id is authoritative). */
  provider?: string | null
  /** UI style preset (photorealistic | illustration | …). */
  stylePreset?: string | null
}

/** The minimum a caller must supply; everything else normalizes to null. */
export type MediaSpecInput = Partial<MediaSpec> & {
  modality: MediaSpecModality
  model: string
  prompt: string
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Pure: fill defaults and sanitize a MediaSpec so persisted specs are well-formed. Strength is
 * clamped to [0,1], seed coerced to a non-negative integer, duration to a positive number;
 * absent optionals become null (never undefined) so equality + serialization are stable.
 */
export function normalizeMediaSpec(input: MediaSpecInput): MediaSpec {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  // Coerce defensively — MediaSpecInput is populated from untyped agent/model output, so a
  // non-string negativePrompt (or junk in referenceAssetIds) must not throw `.trim()` / persist.
  const str = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s.length ? s : null
  }
  const strength = num(input.strength)
  const seed = num(input.seed)
  const duration = num(input.duration)
  const refs = Array.isArray(input.referenceAssetIds)
    ? input.referenceAssetIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : null
  return {
    modality: input.modality,
    model: input.model,
    prompt: String(input.prompt ?? '').trim(),
    negativePrompt: str(input.negativePrompt),
    aspectRatio: input.aspectRatio ?? null,
    duration: duration != null && duration > 0 ? duration : null,
    strength: strength != null ? clamp01(strength) : null,
    seed: seed != null ? Math.max(0, Math.floor(seed)) : null,
    camera: input.camera ?? null,
    characterId: input.characterId ?? null,
    referenceAssetIds: refs && refs.length ? refs : null,
    provider: input.provider ?? null,
    stylePreset: input.stylePreset ?? null,
  }
}

/**
 * Pure: a short human label for the spec, for the Cinema Studio layer chip / inspector — e.g.
 * "Flux 1.1 Pro · 16:9 · seed 42 · i2i". Uses the catalog label when the model is known.
 */
export function mediaSpecSummary(spec: MediaSpec, modelLabel?: (id: string) => string | null): string {
  const parts: string[] = []
  parts.push(modelLabel?.(spec.model) || spec.model)
  if (spec.aspectRatio) parts.push(spec.aspectRatio)
  if (spec.duration) parts.push(`${spec.duration}s`)
  if (spec.seed != null) parts.push(`seed ${spec.seed}`)
  if (spec.characterId) parts.push('character')
  if (spec.referenceAssetIds && spec.referenceAssetIds.length) parts.push('i2i')
  if (spec.camera && spec.camera.moves && spec.camera.moves.length) parts.push('camera')
  return parts.join(' · ')
}
