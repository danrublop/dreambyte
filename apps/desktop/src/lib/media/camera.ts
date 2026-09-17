/**
 * Camera/motion vocabulary + compiler.
 *
 * One agent- and UI-facing vocabulary for cinematic camera control. Models differ in how
 * they accept it (capability flag `camera` on the catalog row):
 *   - 'prompt' → compile the moves into prompt text (all our video models today).
 *   - 'native' → pass structured moves to the provider's camera API (future; none yet).
 *   - false   → no camera control.
 *
 * This module is the 'prompt' compiler: pure + deterministic so it's unit-testable and the
 * cache hash is stable. Higgsfield-style "stack up to 3 moves" is enforced here.
 */

import { modelsForProvider } from './model-catalog'

export type CameraMoveType =
  | 'static'
  | 'dolly-in'
  | 'dolly-out'
  | 'orbit-left'
  | 'orbit-right'
  | 'pan-left'
  | 'pan-right'
  | 'tilt-up'
  | 'tilt-down'
  | 'crane-up'
  | 'crane-down'
  | 'crash-zoom-in'
  | 'crash-zoom-out'
  | 'fpv-drone'

export interface CameraMove {
  type: CameraMoveType
  /** 0..1 — how aggressive the move is. Default 0.5. Out-of-range clamps. */
  intensity?: number
}

export interface CameraSpec {
  /** Up to 3 simultaneous moves (Higgsfield-style stacking). Extra moves are dropped. */
  moves: CameraMove[]
}

export const MAX_STACKED_MOVES = 3

// Base phrase per move. The intensity adverb is prepended at compile time.
const PHRASE: Record<CameraMoveType, string> = {
  static: 'locked-off static shot',
  'dolly-in': 'dolly in toward the subject',
  'dolly-out': 'dolly out away from the subject',
  'orbit-left': 'orbit the camera to the left around the subject',
  'orbit-right': 'orbit the camera to the right around the subject',
  'pan-left': 'pan left',
  'pan-right': 'pan right',
  'tilt-up': 'tilt up',
  'tilt-down': 'tilt down',
  'crane-up': 'crane the camera upward',
  'crane-down': 'crane the camera downward',
  'crash-zoom-in': 'crash zoom in',
  'crash-zoom-out': 'crash zoom out',
  'fpv-drone': 'fast FPV drone fly-through',
}

function clamp01(n: number | undefined): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

// Map intensity to a cinematic adverb. 'static' ignores intensity (it doesn't move).
function intensityAdverb(i: number): string {
  if (i < 0.2) return 'barely-perceptible'
  if (i < 0.4) return 'slow, gentle'
  if (i < 0.6) return 'smooth, steady'
  if (i < 0.8) return 'brisk'
  return 'fast, aggressive'
}

/**
 * Capability-aware camera clause for a video provider. Returns '' when the provider's catalog
 * row has `camera: false`, otherwise the compiled clause. Shared by startVideo + the agent
 * tool handler so both paths apply camera identically (no duplicated capability logic).
 * 'native' has no provider adapter today, so it's treated as prompt-compiled.
 */
export function cameraClauseForProvider(providerId: string, camera: CameraSpec | null | undefined): string {
  const cap = modelsForProvider(providerId).find((r) => r.modality === 'video')?.capabilities.camera ?? 'prompt'
  return cap === false ? '' : compileCameraToPrompt(camera)
}

/** True when this move's catalog capability should compile to prompt text. */
export function isCameraMove(value: unknown): value is CameraMove {
  return !!value && typeof value === 'object' && typeof (value as CameraMove).type === 'string'
}

/**
 * Compile a camera spec into a cinematic prompt clause. Returns '' for an empty/no-op spec
 * (so callers can skip appending). Caps the stack at MAX_STACKED_MOVES.
 */
export function compileCameraToPrompt(spec: CameraSpec | null | undefined): string {
  if (!spec || !Array.isArray(spec.moves) || spec.moves.length === 0) return ''
  const moves = spec.moves.filter(isCameraMove).slice(0, MAX_STACKED_MOVES)
  if (moves.length === 0) return ''

  const phrases = moves.map((m) => {
    const phrase = PHRASE[m.type] ?? null
    if (!phrase) return null
    if (m.type === 'static') return phrase // intensity-free
    return `${intensityAdverb(clamp01(m.intensity))} ${phrase}`
  })
  const real = phrases.filter((p): p is string => !!p)
  if (real.length === 0) return ''
  // One camera clause; multiple moves read as simultaneous ("while ...").
  return `Camera movement: ${real.join(', while ')}.`
}
