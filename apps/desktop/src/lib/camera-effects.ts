import type { CameraMove } from '@/lib/types/scene'

export type CameraEffectId = CameraMove['type'] | 'none'

export interface CameraEffectCatalogEntry {
  id: CameraEffectId
  label: string
  category: string
}

/** Ordered catalog for the Effects tab grid (single camera move per scene). */
export const CAMERA_EFFECT_CATALOG: CameraEffectCatalogEntry[] = [
  { id: 'none', label: 'Static camera', category: 'Basics' },

  { id: 'presetReveal', label: 'Preset reveal', category: 'Presets' },
  { id: 'presetEmphasis', label: 'Preset emphasis', category: 'Presets' },
  { id: 'presetCinematicPush', label: 'Cinematic push', category: 'Presets' },
  { id: 'presetRackTransition', label: 'Rack focus transition', category: 'Presets' },

  { id: 'kenBurns', label: 'Ken Burns', category: '2D motion' },
  { id: 'dollyIn', label: 'Dolly in', category: '2D motion' },
  { id: 'dollyOut', label: 'Dolly out', category: '2D motion' },
  { id: 'pan', label: 'Pan', category: '2D motion' },
  { id: 'rackFocus', label: 'Rack focus', category: '2D motion' },
  { id: 'cut', label: 'Cut', category: '2D motion' },
  { id: 'shake', label: 'Shake', category: '2D motion' },
  { id: 'reset', label: 'Reset', category: '2D motion' },

  { id: 'orbit', label: 'Orbit', category: '3D' },
  { id: 'dolly3D', label: 'Dolly 3D', category: '3D' },
  { id: 'rackFocus3D', label: 'Rack focus 3D', category: '3D' },
]

export function cameraEffectIdFromScene(cameraMotion: CameraMove[] | null | undefined): CameraEffectId {
  const first = cameraMotion?.[0]
  if (!first) return 'none'
  return first.type
}

export function defaultCameraMoveParams(
  sceneDuration: number,
  previous?: CameraMove | null,
): Record<string, unknown> {
  const prevParams = previous?.params ?? {}
  const at = typeof prevParams.at === 'number' ? prevParams.at : 0
  const duration =
    typeof prevParams.duration === 'number'
      ? prevParams.duration
      : Math.max(1, sceneDuration - 0.5)
  return { ...prevParams, at, duration }
}
