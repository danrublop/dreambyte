import type { TransitionType } from '../transitions'
export type { TransitionType } from '../transitions'

import type { AudioLayer } from './audio'
import type { D3ChartLayer } from './d3'
import type { AILayer } from './ai-layer'
import type { InteractionElement, SceneVariable, SceneUsage } from './interaction'
import type { WorldConfig } from './world'

export interface TextOverlay {
  id: string
  content: string
  font: string
  size: number
  color: string
  x: number // percentage of canvas width
  y: number // percentage of canvas height
  animation: 'fade-in' | 'slide-up' | 'typewriter'
  duration: number // seconds
  delay: number // seconds into scene
  /** CSS font-weight numeric value (100–900). Defaults to 400 (normal). */
  weight?: number
  /** CSS line-height as a unitless multiplier (e.g. 1, 1.2, 1.5). Defaults to 1.2. */
  lineHeight?: number
  /** Tracking in em (e.g. 0, 0.02, -0.04). Defaults to 0. */
  letterSpacing?: number
}

export interface VideoLayer {
  enabled: boolean
  src: string | null // URL or /uploads/filename
  opacity: number // 0–1
  trimStart: number // seconds
  trimEnd: number | null
  /** CSS filter string applied to the video element (Look presets — e.g. "contrast(1.12) sepia(0.06)"). */
  filter?: string
  /** Mute the in-scene video element. Set when the video's audio plays as a
   *  LINKED timeline audio clip instead (NLE-style A/V pair) so it
   *  doesn't double-play. */
  muted?: boolean
  /** Advanced correction stack (exposure/contrast/temp/tint/curves) — see src/lib/edit-engines/layer-grade.ts. */
  colorGrade?: import('../edit-engines/layer-grade').LayerColorGrade
}

export type SceneType =
  | 'svg'
  | 'canvas2d'
  | 'motion'
  | 'd3'
  | 'three'
  | 'lottie'
  | 'zdog'
  | 'avatar_scene'
  | '3d_world'
  | 'react'

// ── Scene ────────────────────────────────────────────────────────────────────

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  status?: 'pending' | 'done' | 'error'
  generationLogId?: string
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; apiCalls: number; totalDurationMs: number }
  userRating?: number
  agentType?: string
  modelId?: string
}

export interface Scene {
  id: string
  name: string
  /** Position in the project's scenes array; surfaced for filename generation. */
  order?: number
  prompt: string
  summary: string
  svgContent: string
  usage: SceneUsage | null
  duration: number // seconds
  bgColor: string
  thumbnail: string | null // data URL
  filmstrip?: (string | null)[] | null // data URLs sampled across the scene for the timeline clip (sparse: slots fill in as the scene plays)
  videoLayer: VideoLayer
  audioLayer: AudioLayer
  textOverlays: TextOverlay[]
  svgObjects: SvgObject[]
  primaryObjectId: string | null
  svgBranches: SvgBranch[]
  activeBranchId: string | null
  transition: TransitionType
  sceneType: SceneType
  canvasCode: string
  /** Canvas2D loop behind Motion / D3 / SVG (full-frame #c, z-index 0); empty when unused */
  canvasBackgroundCode: string
  sceneCode: string
  /** React scene: JSX component code transpiled in-browser via Sucrase */
  reactCode: string
  /** Three.js: chosen Dreambyte stage env id (kept in sync with applyDreambyteThreeEnvironment in sceneCode when possible) */
  threeEnvironmentPresetId?: string | null
  sceneHTML: string
  sceneStyles: string
  lottieSource: string
  d3Data: any
  chartLayers?: D3ChartLayer[]
  interactions: InteractionElement[]
  variables: SceneVariable[]
  aiLayers: AILayer[]
  messages: Message[]
  styleOverride: SceneStyleOverride
  cameraMotion: CameraMove[] | null
  /** Non-destructive visual overrides applied by the inspector on top of generated code */
  elementOverrides?: Record<string, Record<string, string | number>>
  worldConfig: WorldConfig | null
  /** Layer stack panel: synthetic keys hidden in UI (eye toggle); export may ignore until wired */
  layerHiddenIds?: string[]
  /** Layer stack panel: top-to-bottom = front-to-back; controls z-index / array order where applicable */
  layerPanelOrder?: string[]
  /** Node map: free-form node positions keyed by NodeMapKey. Persisted via sceneBlob (no DB migration). */
  nodeMapPositions?: Record<string, { x: number; y: number }>
  /** Timestamp of last mutation (ms since epoch) — used for checkpoint merge conflict resolution */
  updatedAt?: number
  /**
   * Cursor-style mutual exclusion lock. When set, this scene is
   * owned by exactly one editor — agent OR user — and the other side
   * sees a read-only badge. Auto-releases after 3s idle; can be force-
   * taken-over after 30s of no activity. See `src/lib/store/scene-lock.ts`.
   */
  lock?: SceneLock | null
  /**
   * FLIP-style layout transition for sibling reposition when other layers
   * enter/leave. Set by `apply_layout_transition`. When present,
   * the React adapter wraps the layer container in `<AnimatePresence>` and
   * tags each child with the configured durationFrames + easing.
   */
  layoutTransition?: LayoutTransitionSpec | null
  /**
   * Verify-scene gate. Stamped by `verifyAndStampScene`
   * after every scene HTML write. The preview player uses this to gate the
   * iframe; the agent runner treats `errored` as a recoverable retry signal.
   */
  verifyStatus?: 'unknown' | 'pending' | 'verifying' | 'verified' | 'errored'
  verifyError?: SceneVerifyErrorPayload | null
  verifiedAt?: number | null
  /**
   * Transient UI-only flags set by the agent runner while a scene is being
   * generated incrementally. Stripped before persistence in
   * `src/lib/store/helpers.ts` (the leading underscore is the marker). Typed
   * here so consumers can read them without `as any` casts.
   */
  _building?: boolean
  /**
   * Closed literal union — adding `| string` here would erase the
   * narrowing benefit (TS would widen to plain string and a typo like
   * `'renderd'` would compile). Mirrors `deriveBuildPhase`'s return in
   * src/lib/agents/runner.ts. If a new phase ever ships, add it to both
   * places explicitly.
   *
   * Note: `'deleted'` is returned by `deriveBuildPhase` to drive an
   * early-return in the runner — it never reaches Scene._buildPhase,
   * so it's deliberately omitted here.
   */
  _buildPhase?: 'created' | 'generating' | 'rendered' | 'verified' | 'done'
}

export interface SceneVerifyErrorPayload {
  kind: 'syntax' | 'runtime' | 'timeout' | 'asset' | 'unknown'
  message: string
  line?: number
  source?: string
}

export type LayoutTransitionKind = 'flip' | 'crossfade' | 'reflow'

export interface LayoutTransitionSpec {
  kind: LayoutTransitionKind
  durationFrames?: number
  easing?: string
}

export interface SceneLock {
  owner: 'agent' | 'user'
  acquiredAt: number
  lastActivityAt: number
  source: 'in-app' | 'mcp-stdio' | 'mcp-http' | 'unknown'
}

export interface CameraMove {
  type:
    | 'kenBurns'
    | 'dollyIn'
    | 'dollyOut'
    | 'pan'
    | 'rackFocus'
    | 'cut'
    | 'shake'
    | 'reset'
    | 'orbit'
    | 'dolly3D'
    | 'rackFocus3D'
    | 'presetReveal'
    | 'presetEmphasis'
    | 'presetCinematicPush'
    | 'presetRackTransition'
  params?: Record<string, unknown>
}

export interface SvgBranch {
  id: string
  parentId: string | null // null = root (initial generate)
  label: string // "Original" or truncated edit instruction
  svgContent: string
  usage: SceneUsage | null
}

export interface SvgObject {
  id: string
  prompt: string
  svgContent: string
  x: number // left offset % of canvas (0–100)
  y: number // top offset % of canvas (0–100)
  width: number // % of canvas width
  opacity: number // 0–1
  zIndex: number // layering (default 4, above text overlays)
}

// ── Database / Schema Types ──────────────────────────────────────────────────

export interface SceneStyleOverride {
  palette?: [string, string, string, string] | null
  font?: string | null
  bodyFont?: string | null
  roughnessLevel?: number | null
  strokeWidth?: number | null
  bgColor?: string | null
  textureStyle?: string | null
  defaultTool?: string | null
  strokeColorOverride?: string | null
  textureIntensity?: number | null
  textureBlendMode?: 'multiply' | 'screen' | 'overlay' | null
  bgStyle?: 'plain' | 'paper' | 'grid' | 'dots' | 'chalkboard' | 'kraft' | null
  axisColor?: string | null
  gridColor?: string | null
  styleNote?: string | null
}

export type SceneStylePresetName =
  | 'before'
  | 'after'
  | 'warning'
  | 'highlight'
  | 'chalkboard'
  | 'blueprint'
  | 'newspaper'
  | 'neon'

export interface TransitionConfig {
  type: TransitionType
  duration: number
}

export interface SceneElement {
  id: string
  type: string
  props: Record<string, unknown>
}

export interface AssetPlacement {
  assetId: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  zIndex: number
}

export interface SceneLayer {
  id: string
  type: string
  label: string | null
  parentLayerId: string | null
  zIndex: number
  visible: boolean
  opacity: number
  blendMode: string
  startAt: number
  duration: number | null
  generatedCode: string | null
  elements: SceneElement[]
  assetPlacements: AssetPlacement[]
  prompt: string | null
  layerConfig: Record<string, unknown> | null
}
