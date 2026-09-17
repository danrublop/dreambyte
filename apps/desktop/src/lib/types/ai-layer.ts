import type { MediaLayerStatus, LayerProvenance } from './media'
import type { MotionRef } from '../motion-dsl/types'

// ── AI Layer Types ──────────────────────────────────────────────────────────

export type AvatarMood = 'neutral' | 'happy' | 'sad' | 'angry' | 'fear' | 'surprise'
export type AvatarView = 'full' | 'mid' | 'upper' | 'head'
export type AvatarGesture = 'wave' | 'handup' | 'index' | 'ok' | 'thumbup' | 'thumbdown' | 'side' | 'shrug'
export type AvatarPosition =
  | 'pip_bottom_right'
  | 'pip_bottom_left'
  | 'pip_top_right'
  | 'fullscreen'
  | 'fullscreen_left'
  | 'fullscreen_right'
export type PipShape = 'circle' | 'rounded' | 'square'

export interface NarrationLine {
  text: string
  mood?: AvatarMood
  gesture?: AvatarGesture
  gestureHand?: 'left' | 'right'
  lookAt?: { x: number; y: number }
  lookCamera?: boolean
  pauseBefore?: number
  animation?: string
}

export type AvatarCharacter = 'friendly' | 'professional' | 'energetic'

export interface NarrationScript {
  mood: AvatarMood
  view: AvatarView
  lipsyncHeadMovement: boolean
  eyeContact: number
  position: AvatarPosition
  pipSize?: number
  pipShape?: PipShape
  avatarScale?: number
  containerEnabled?: boolean
  background?: string
  character?: AvatarCharacter
  // Container glassmorphic styling
  containerBlur?: number
  containerBorderColor?: string
  containerBorderOpacity?: number
  containerBorderWidth?: number
  containerShadowOpacity?: number
  containerInnerGlow?: number
  containerBgOpacity?: number
  enterAt?: number
  exitAt?: number
  entranceAnimation?: 'fade' | 'scale-in' | 'slide-up'
  exitAnimation?: 'fade' | 'scale-out' | 'slide-down'
  lines: NarrationLine[]
}

export interface ContentPanel {
  id: string
  html: string
  position: 'left' | 'right' | 'top' | 'bottom' | 'center'
  revealAt: string // 'start' | 'marker_N' | seconds as string
  exitAt?: string
  style?: Record<string, string>
}

export interface AvatarSceneConfig {
  narrationScript: NarrationScript
  contentPanels: ContentPanel[]
  backdrop: string
  avatarPosition: 'left' | 'right' | 'center'
  avatarSize: number
}

/**
 * What export does when a generated clip's REAL length disagrees with
 * the authored scene duration (avatar speech runs long, Veo clip runs short):
 *  - 'extend-scene' (default): the exported scene grows to fit the clip
 *    (max of authored duration and clip end) so speech is never cut off.
 *  - 'trim': keep the authored duration; the clip is cut at scene end.
 *  - 'hold-last-frame': keep the authored duration; a clip that ends early
 *    freezes on its last frame (the renderer's natural behavior — kept as an
 *    explicit choice so "trim" can later diverge, e.g. fade-out).
 * Lives inline on the layer (sceneBlob) — no DB migration.
 */
export type MediaTimingPolicy = 'trim' | 'hold-last-frame' | 'extend-scene'

export interface AvatarLayer {
  id: string
  type: 'avatar'
  avatarId: string
  voiceId: string
  script: string
  removeBackground: boolean
  x: number
  y: number
  width: number
  height: number
  opacity: number
  zIndex: number
  videoUrl: string | null
  thumbnailUrl: string | null
  status: MediaLayerStatus
  heygenVideoId: string | null
  estimatedDuration: number
  /** Epoch ms when an async (HeyGen) render was kicked off. get_avatar_status
   *  uses it to enforce a wall-clock deadline so a wedged render can't be polled
   *  forever — past the deadline the layer flips to `error` instead of spinning. */
  renderStartedAt?: number
  startAt: number
  label: string
  // Extended avatar fields
  avatarPlacement?: AvatarPosition
  avatarProvider?: string
  narrationScript?: NarrationScript
  avatarSceneConfig?: AvatarSceneConfig
  /** Live link to the ProjectAsset this avatar was placed from. */
  assetId?: string | null
  /** Durable provenance snapshot of the generating call. */
  provenance?: LayerProvenance | null
  /** Export timing reconciliation (default 'extend-scene'). */
  timingPolicy?: MediaTimingPolicy
}

export interface Veo3Layer {
  id: string
  type: 'veo3'
  prompt: string
  negativePrompt: string | null
  aspectRatio: '16:9' | '9:16' | '1:1'
  // Clip length in seconds. Tier 2 (#5) lifted the old global 5/8 cap — fal models go to 10s, Veo
  // stays 5/8 (its API limit). startVideo clamps the request to the chosen model's maxDurationSeconds.
  duration: number
  loop: boolean
  playbackRate: number
  x: number
  y: number
  width: number
  height: number
  opacity: number
  zIndex: number
  videoUrl: string | null
  thumbnailUrl: string | null
  status: MediaLayerStatus
  operationName: string | null
  startAt: number
  label: string
  /**
   * Anchor schema version. When >= VEO3_ANCHOR_VERSION (2),
   * x/y store the sprite CENTER (canon, matching images + pixi export). Absent
   * (legacy) => top-left coords, translated to center at render time by
   * resolveVeo3CenterCoords (src/lib/media/veo3-geometry.ts). Set by every writer
   * that authors center coords (agent placement, poll completion, Cinema UI).
   */
  anchorVersion?: number
  /** Live link to the ProjectAsset this clip was placed from. */
  assetId?: string | null
  /** Durable provenance snapshot of the generating call. */
  provenance?: LayerProvenance | null
  /**
   * Export timing reconciliation (default 'extend-scene'). Ignored when
   * `loop` is set — a looping clip fills any scene length by definition.
   * NOTE: no Veo3 properties-form control exists yet, so this is
   * agent/programmatic-only for now; the default applies everywhere else.
   */
  timingPolicy?: MediaTimingPolicy
}

/**
 * Radial particle burst spec — set by `burst_layer`. Origin is
 * the layer's centroid; the renderer (R-side) draws a one-shot mojs-style
 * burst at the configured frame.
 */
export interface BurstSpec {
  /** Particle count radiating from the source. Default 12. */
  count?: number
  /** Maximum radius in px the particles reach. Default 80. */
  radius?: number
  /** Frames the burst takes from spawn to fade-out. Default 18. */
  durationFrames?: number
  /** Frame to fire at, relative to scene start. Default 0. */
  delayFrames?: number
  /** Particle fill color. Default uses preset palette. */
  color?: string
}

/**
 * Discriminated union of agent-mutable layer kinds, intersected with the
 * Motion DSL's optional `motion` field and an optional `burst`
 * spec. Every AI layer carries these as additive fields.
 */
export type AILayer = (AvatarLayer | Veo3Layer | ImageLayer | StickerLayer) & {
  motion?: MotionRef | null
  burst?: BurstSpec | null
  /**
   * The generation parameters that produced this layer. Inline so it travels with the
   * layer + persists via sceneBlob (no migration). The Cinema Studio panel edits + regenerates
   * from it; the agent populates it on generation. Optional — legacy layers have none.
   */
  mediaSpec?: MediaSpec | null
}

// Re-import and re-export to make AILayer union complete
import type { ImageLayer, StickerLayer } from './media'
import type { MediaSpec } from './media-spec'
