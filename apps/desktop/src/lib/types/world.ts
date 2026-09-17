import type { AvatarMood, NarrationScript } from './ai-layer'

// ── 3D World Types ──────────────────────────────────────────────────────────

/**
 * World environments, in ONE place: the ids that render a standalone world HTML
 * template (see `generateWorldHTML` in sceneTemplate.ts). Both the
 * world_scene schema and the handler's validator
 * derive from this list, so they cannot drift apart again.
 *
 * The seven STAGE ids that used to sit beside these are gone. They were never
 * `worldConfig.environment` values — `WorldEnvironment` has always been this list
 * only — they were a second copy of `DREAMBYTE_STUDIO_ENV_IDS`
 * (src/lib/three-environments/registry.ts), which is the runtime's real source of truth
 * and what `applyDreambyteThreeEnvironment` resolves against. The branch that read
 * the copy was the world_scene stage transcoder, deleted in the L3 cut.
 */
export const WORLD_TEMPLATE_ENV_IDS = ['meadow', 'studio_room', 'void_space'] as const

export type WorldEnvironment = (typeof WORLD_TEMPLATE_ENV_IDS)[number]

export interface WorldObjectConfig {
  assetId: string
  position: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
  animations?: string[]
  /** One tween on the scene master timeline (window.__tl), times in seconds. */
  timelineAnimation?: {
    property: string
    from: number
    to: number
    duration: number
    at?: string
  }
}

export interface WorldPanelConfig {
  html: string
  position?: [number, number, number]
  rotation?: [number, number, number]
  width?: number
  height?: number
  animateIn?: string
  animateAt?: number
}

export interface WorldAvatarConfig {
  glbUrl?: string
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
  mood?: AvatarMood
  script?: NarrationScript
}

export interface WorldCameraKeyframe {
  t: number
  pos: [number, number, number]
  lookAt: [number, number, number]
}

export interface WorldConfig {
  environment: WorldEnvironment
  timeOfDay?: 'morning' | 'afternoon' | 'sunset' | 'night'
  windStrength?: number
  grassDensity?: number
  roomStyle?: 'classroom' | 'office' | 'studio'
  spaceLayout?: 'grid' | 'arc' | 'spiral' | 'random'
  objects?: WorldObjectConfig[]
  panels?: WorldPanelConfig[]
  avatars?: WorldAvatarConfig[]
  cameraPath?: WorldCameraKeyframe[]
}
