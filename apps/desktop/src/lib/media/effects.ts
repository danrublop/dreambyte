/**
 * VFX / effects preset library (Tier 2 #8, Higgsfield "Effects Mix"-style).
 *
 * A curated pack of named visual effects the agent + composer can apply to a video generation.
 * Each preset is a prompt fragment (the VFX description) optionally bundled with a camera move, so
 * it LAYERS on the camera/motion compiler (src/lib/media/camera.ts) rather than adding a new provider
 * route. Pure + deterministic so the cache hash stays stable — `compileEffect` is the one place that
 * turns a preset id into prompt text, capability-aware via the same camera gate.
 */

import { type CameraSpec, compileCameraToPrompt } from './camera'
import { modelsForProvider } from './model-catalog'

export interface EffectPreset {
  id: string
  label: string
  /** The VFX description folded into the generation prompt. */
  prompt: string
  /** Optional camera move bundled with the effect — compiled via the camera compiler (so the effect
   *  composes with the model's camera capability instead of duplicating motion as bare text). */
  camera?: CameraSpec
}

const move = (type: CameraSpec['moves'][number]['type'], intensity: number): CameraSpec => ({
  moves: [{ type, intensity }],
})

export const EFFECT_PRESETS: EffectPreset[] = [
  {
    id: 'explosion',
    label: 'Explosion',
    prompt: 'Visual effect: a massive explosion erupts with fire, flying debris, and a shockwave.',
    camera: move('crash-zoom-out', 0.8),
  },
  {
    id: 'bullet-time',
    label: 'Bullet time',
    prompt: 'Visual effect: time freezes and the camera sweeps around the frozen subject (bullet-time).',
    camera: move('orbit-right', 0.7),
  },
  {
    id: 'dolly-zoom',
    label: 'Dolly zoom (vertigo)',
    prompt: 'Visual effect: a vertigo dolly-zoom — the background warps while the subject stays fixed.',
    camera: move('dolly-in', 0.6),
  },
  {
    id: 'glitch',
    label: 'Glitch',
    prompt: 'Visual effect: digital glitch distortion, RGB channel splitting, and datamosh artifacts.',
  },
  {
    id: 'vhs-retro',
    label: 'VHS retro',
    prompt: 'Visual effect: 1980s VHS look — scanlines, chromatic aberration, tape warble, and soft grain.',
  },
  {
    id: 'film-noir',
    label: 'Film noir',
    prompt: 'Visual effect: high-contrast black-and-white film noir with hard shadows and a smoky atmosphere.',
  },
  {
    id: 'dreamy',
    label: 'Dreamy',
    prompt: 'Visual effect: a soft ethereal dream — gentle bloom, hazy diffusion, and floating light particles.',
  },
  {
    id: 'neon-glow',
    label: 'Neon glow',
    prompt: 'Visual effect: vivid neon glow, electric rim light, and a cyberpunk color grade.',
  },
  {
    id: 'levitate',
    label: 'Levitate',
    prompt: 'Visual effect: the subject lifts and floats, gently defying gravity.',
    camera: move('crane-up', 0.5),
  },
  {
    id: 'disintegrate',
    label: 'Disintegrate',
    prompt: 'Visual effect: the subject disintegrates into drifting particles and ash.',
  },
  {
    id: 'slow-motion',
    label: 'Slow motion',
    prompt: 'Visual effect: dramatic slow motion with fluid, high-frame-rate movement.',
  },
  {
    id: 'hyperspeed',
    label: 'Hyperspeed',
    prompt: 'Visual effect: hyperspeed motion-blur streaks as the scene rushes forward.',
    camera: move('fpv-drone', 0.9),
  },
  {
    id: 'light-leak',
    label: 'Light leak',
    prompt: 'Visual effect: warm analog light leaks and lens flares sweep across the frame.',
  },
  {
    id: 'shatter',
    label: 'Shatter',
    prompt: 'Visual effect: the frame shatters like breaking glass, shards flying toward the camera.',
    camera: move('crash-zoom-in', 0.7),
  },
]

const BY_ID = new Map(EFFECT_PRESETS.map((e) => [e.id, e]))

export function getEffectPreset(id: string): EffectPreset | null {
  return BY_ID.get(id) ?? null
}

export function isEffectId(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value)
}

/**
 * Compile an effect preset into prompt text for a provider: the VFX fragment plus (when `withCamera`)
 * the bundled camera move (compiled via the camera compiler, and dropped when the model has
 * `camera:false`). Returns '' for an unknown preset id, so callers append nothing.
 *
 * `withCamera` defaults true; callers pass false when the user already supplied a camera move, so the
 * effect's bundled camera doesn't emit a SECOND, possibly-contradictory "Camera movement:" clause.
 */
export function compileEffect(
  providerId: string,
  presetId: string | null | undefined,
  opts: { withCamera?: boolean } = {},
): string {
  if (!presetId) return ''
  const preset = getEffectPreset(presetId)
  if (!preset) return ''
  const cameraCap = modelsForProvider(providerId).find((r) => r.modality === 'video')?.capabilities.camera ?? 'prompt'
  const cameraClause = opts.withCamera === false || cameraCap === false ? '' : compileCameraToPrompt(preset.camera)
  return [preset.prompt, cameraClause].filter(Boolean).join(' ')
}
