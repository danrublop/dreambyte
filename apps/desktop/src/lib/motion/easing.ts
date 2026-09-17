/**
 * Shared easing constants for all scene types.
 *
 * Four motion personality profiles (playful, premium, corporate, energetic)
 * with standard curve catalogs and helpers for Lottie handle conversion.
 *
 * Inspired by LottieFiles/motion-design-skill framework.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MotionPersonality = 'playful' | 'premium' | 'corporate' | 'energetic'

export type MotionCategory = 'entrance' | 'exit' | 'emphasis' | 'ambient'

/** A cubic-bezier as [x1, y1, x2, y2]. */
export type CubicBezier = [number, number, number, number]

/** Lottie easing handle pair for a single keyframe. */
export interface LottieEasingHandles {
  i: { x: number[]; y: number[] }
  o: { x: number[]; y: number[] }
}

export interface PersonalityProfile {
  /** Display name */
  name: string
  /** Recommended duration range in seconds (for video — these are scene-scale, not UI-scale) */
  durationRange: [number, number]
  /** Default stagger between items in ms */
  staggerMs: number
  /** Max total stagger sequence in ms */
  maxStaggerMs: number
  /** Overshoot percentage (0 = none) */
  overshoot: number
  /** Easing curves per motion category */
  easing: Record<MotionCategory, CubicBezier>
  /** anime.js v4 ease string equivalents per motion category (exact names — unknown names fall back to linear) */
  anime: Record<MotionCategory, string>
}

// ---------------------------------------------------------------------------
// Standard Curves
// ---------------------------------------------------------------------------

/** Material Design 3 Standard */
export const MD3_STANDARD: CubicBezier = [0.2, 0, 0, 1]

/** Material Design 3 Emphasized (entrance) */
export const MD3_EMPHASIZED: CubicBezier = [0.05, 0.7, 0.1, 1]

/** Apple ease curve */
export const APPLE: CubicBezier = [0.28, 0, 0.1, 1]

/** Dreambyte default entrance (exponential out) */
export const DREAMBYTE_ENTRANCE: CubicBezier = [0.16, 1, 0.3, 1]

/** Dreambyte default exit (exponential in) */
export const DREAMBYTE_EXIT: CubicBezier = [0.7, 0, 0.84, 0]

/** Safe fallback for auto-fix (smooth ease-in-out) */
export const SAFE_DEFAULT: CubicBezier = [0.42, 0, 0.58, 1]

// ---------------------------------------------------------------------------
// Personality Profiles
// ---------------------------------------------------------------------------

export const PERSONALITIES: Record<MotionPersonality, PersonalityProfile> = {
  playful: {
    name: 'Playful',
    durationRange: [0.15, 0.3],
    staggerMs: 60,
    maxStaggerMs: 500,
    overshoot: 0.15,
    easing: {
      entrance: [0.34, 1.56, 0.64, 1], // back-out approximation
      exit: [0.36, 0, 0.66, -0.56], // back-in approximation
      emphasis: [0.22, 1.4, 0.36, 1], // elastic-ish settle
      ambient: [0.37, 0, 0.63, 1], // ease-in-out
    },
    anime: {
      entrance: 'outBack(1.4)',
      exit: 'inBack(1.4)',
      emphasis: 'outBack(1.7)',
      ambient: 'inOutSine',
    },
  },

  premium: {
    name: 'Premium',
    durationRange: [0.35, 0.6],
    staggerMs: 80,
    maxStaggerMs: 600,
    overshoot: 0,
    easing: {
      entrance: [0.4, 0, 0.2, 1], // smooth deceleration
      exit: [0.4, 0, 1, 1], // subtle acceleration
      emphasis: [0.16, 1, 0.3, 1], // exponential out
      ambient: [0.37, 0, 0.63, 1], // ease-in-out
    },
    anime: {
      entrance: 'outQuart',
      exit: 'inCubic',
      emphasis: 'outExpo',
      ambient: 'inOutSine',
    },
  },

  corporate: {
    name: 'Corporate',
    durationRange: [0.2, 0.4],
    staggerMs: 70,
    maxStaggerMs: 600,
    overshoot: 0.02,
    easing: {
      entrance: [0.42, 0, 0.58, 1], // ease-in-out (predictable)
      exit: [0.42, 0, 1, 1], // ease-in
      emphasis: [0.16, 1, 0.3, 1], // exponential out
      ambient: [0.37, 0, 0.63, 1], // ease-in-out
    },
    anime: {
      entrance: 'inOutCubic',
      exit: 'inCubic',
      emphasis: 'outExpo',
      ambient: 'inOutSine',
    },
  },

  energetic: {
    name: 'Energetic',
    durationRange: [0.1, 0.25],
    staggerMs: 40,
    maxStaggerMs: 400,
    overshoot: 0.25,
    easing: {
      entrance: [0.22, 1.8, 0.36, 1], // strong back-out
      exit: [0.55, 0, 1, 0.45], // quick acceleration
      emphasis: [0.18, 1.6, 0.32, 1], // aggressive overshoot
      ambient: [0.37, 0, 0.63, 1], // ease-in-out
    },
    anime: {
      entrance: 'outBack(2)',
      exit: 'inQuart',
      emphasis: 'outBack(2.5)',
      ambient: 'inOutSine',
    },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a cubic-bezier [x1,y1,x2,y2] to Lottie easing handle format.
 *
 * @param bezier - The cubic bezier control points
 * @param dimensions - 1 for scalar properties (opacity, rotation),
 *                     3 for spatial/multi-dimensional (position, scale, anchor)
 */
export function easingToLottieHandles(bezier: CubicBezier, dimensions: 1 | 3 = 1): LottieEasingHandles {
  const [x1, y1, x2, y2] = bezier
  if (dimensions === 1) {
    return {
      i: { x: [x2], y: [y2] },
      o: { x: [x1], y: [y1] },
    }
  }
  return {
    i: { x: [x2, x2, x2], y: [y2, y2, y2] },
    o: { x: [x1, x1, x1], y: [y1, y1, y1] },
  }
}

/**
 * Build a prompt-friendly summary of a personality's easing configuration.
 * Used by LOTTIE_OVERLAY_PROMPT and other generators.
 */
export function personalityPromptBlock(personality: MotionPersonality): string {
  const p = PERSONALITIES[personality]
  const fmt = (b: CubicBezier) => `cubic-bezier(${b.join(', ')})`
  const lottie1d = (b: CubicBezier) => {
    const h = easingToLottieHandles(b, 1)
    return `"i":{"x":[${h.i.x}],"y":[${h.i.y}]}, "o":{"x":[${h.o.x}],"y":[${h.o.y}]}`
  }
  const lottie3d = (b: CubicBezier) => {
    const h = easingToLottieHandles(b, 3)
    return `"i":{"x":[${h.i.x}],"y":[${h.i.y}]}, "o":{"x":[${h.o.x}],"y":[${h.o.y}]}`
  }

  return `MOTION PERSONALITY: ${p.name}
Duration range: ${p.durationRange[0]}-${p.durationRange[1]}s per element transition
Stagger: ${p.staggerMs}ms between items (cap at ${p.maxStaggerMs}ms total)
Overshoot: ${p.overshoot === 0 ? 'none' : `${Math.round(p.overshoot * 100)}%`}

Entrance easing: ${fmt(p.easing.entrance)}
  1D Lottie: ${lottie1d(p.easing.entrance)}
  3D Lottie: ${lottie3d(p.easing.entrance)}

Exit easing: ${fmt(p.easing.exit)}
  1D Lottie: ${lottie1d(p.easing.exit)}
  3D Lottie: ${lottie3d(p.easing.exit)}

Emphasis easing: ${fmt(p.easing.emphasis)}
  1D Lottie: ${lottie1d(p.easing.emphasis)}

Ambient easing: ${fmt(p.easing.ambient)}
  1D Lottie: ${lottie1d(p.easing.ambient)}`
}
