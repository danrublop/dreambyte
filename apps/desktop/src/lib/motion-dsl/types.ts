// Motion DSL — type definitions (W1).
//
// MotionRef is the discriminated union the agent fills when it calls
// `animate_layer`. The renderer-side compilers in `compiler/*.ts` consume
// these and emit interpolate() / anime.js timeline / CSS transform / Three
// Object3D mutations into the scene's generated code.
//
// Designed for LLM ergonomics: flat shapes, single discriminator,
// every field optional has a sensible default. The agent-prompt cookbook
// shows examples; the schema check in `validateMotionRef` rejects typos
// with close-match suggestions instead of hand-waving away errors.

export type PresetCategory = 'entrance' | 'exit' | 'emphasis' | 'ambient'

export type LockSource = 'in-app' | 'mcp-stdio' | 'mcp-http' | 'unknown'

/** Renderer kinds the DSL compiles to. Source of truth for compatibility checks. */
export type RendererKind = 'react' | 'motion' | 'lottie' | 'three' | 'canvas2d'

/** Named spring config — mapped to tension/friction by `springs.ts`. */
export type SpringName = 'gentle' | 'wobbly' | 'stiff' | 'slow' | 'molasses'

/**
 * Named easing — a stable DSL vocabulary (Penner power/expo/back/elastic/bounce
 * families in dotted form). Adapters evaluate it via `applyEasing`/`easedExpr`
 * (compiler/_sample.ts); it is NOT passed to anime.js as an ease string.
 */
export type EasingName =
  | 'linear'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'power1.in'
  | 'power1.out'
  | 'power1.inOut'
  | 'power2.in'
  | 'power2.out'
  | 'power2.inOut'
  | 'power3.in'
  | 'power3.out'
  | 'power3.inOut'
  | 'expo.in'
  | 'expo.out'
  | 'expo.inOut'
  | 'back.in'
  | 'back.out'
  | 'back.inOut'
  | 'elastic.in'
  | 'elastic.out'
  | 'elastic.inOut'
  | 'bounce.in'
  | 'bounce.out'
  | 'bounce.inOut'

/**
 * One control point in a preset's animation timeline. `at` is normalized
 * progress 0..1 through `defaultDurationFrames`. All transform fields are
 * optional — undefined = "no change at this keyframe, the renderer
 * interpolates between neighbors".
 *
 * Translation values are in pixels relative to the layer's natural
 * position. Scale is a multiplier (1 = identity). Rotation is degrees.
 */
export interface PresetKeyframe {
  at: number
  tx?: number
  ty?: number
  sx?: number
  sy?: number
  rot?: number
  opacity?: number
}

/** Compatibility flags that compilers + the renderer-routing prompt read. */
export interface PresetFlags {
  /** Reflows surrounding siblings — needs FLIP-style layout-aware shell. */
  layoutAware: boolean
  /** Animates per-character or per-word — incompatible with non-DOM renderers. */
  textDecomposition: boolean
}

export interface MotionPreset {
  id: string
  category: PresetCategory
  description: string
  defaultDurationFrames: number
  defaultEasing?: EasingName
  defaultSpring?: SpringName
  /** Renderers this preset works in directly. Layout-aware/text presets
   *  fall back to a CSS transform shell on non-React renderers, but the
   *  declared compatibility list says where the preset is *first-class*. */
  compatibleRenderers: ReadonlyArray<RendererKind>
  flags: PresetFlags
  keyframes: ReadonlyArray<PresetKeyframe>
}

// ── MotionRef — what `animate_layer` accepts ─────────────────────────────

/**
 * The discriminated reference the agent fills. `kind: 'preset'` is the
 * 95% path; `kind: 'spring'` lets the agent ask for "spring this property
 * from A to B" without picking a named preset; `kind: 'custom'` is the
 * escape hatch for inline keyframes when no preset fits.
 */
export type MotionRef =
  | {
      kind: 'preset'
      preset: string
      durationFrames?: number
      delayFrames?: number
      easing?: EasingName
      spring?: SpringName
    }
  | {
      kind: 'spring'
      from: Record<string, number>
      to: Record<string, number>
      spring: SpringName
      delayFrames?: number
    }
  | {
      kind: 'custom'
      keyframes: ReadonlyArray<PresetKeyframe>
      durationFrames: number
      delayFrames?: number
      easing?: EasingName
    }

// ── Choreography — multi-layer orchestration ─────────────────────────────

/**
 * A flat operator-tagged array. LLMs fill these cleanly: single
 * discriminator (`op`), no bracket-balancing, no nested trees. Compilers
 * walk the array and emit a sequenced timeline.
 */
export type ChoreographyStep =
  | {
      op: 'animate'
      layerId: string
      preset: string
      durationFrames?: number
      delayFrames?: number
      easing?: EasingName
      spring?: SpringName
    }
  | { op: 'wait'; frames: number }
  | { op: 'parallel'; items: ReadonlyArray<ChoreographyStep> }
  | { op: 'stagger'; layerIds: ReadonlyArray<string>; preset: string; offsetFrames: number; durationFrames?: number }

export type Choreography = ReadonlyArray<ChoreographyStep>

// ── Compiler context ─────────────────────────────────────────────────────

/** Shared between renderer adapters so they can produce identical timing. */
export interface CompileContext {
  fps: number
  /** Project-wide default if a preset doesn't specify its own. */
  defaultEasing: EasingName
  defaultSpring: SpringName
}

export const DEFAULT_COMPILE_CONTEXT: CompileContext = {
  fps: 30,
  defaultEasing: 'power2.out',
  defaultSpring: 'gentle',
}
