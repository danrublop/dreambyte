// Named spring configs — distilled from react-spring's curated presets.
// Tension + friction are the only two knobs the agent ever needs. mass
// stays at 1 for everything because varying it produces the same end
// states with a phase-shifted curve, which is more confusing than useful.
//
// Adapters consume `SPRINGS[name]` and pass tension/friction directly
// to their target lib (Motion's spring(), Three.js MathUtils.damp,
// react-spring's useSpring config, etc).

import type { SpringName } from './types'

export interface SpringConfig {
  tension: number
  friction: number
  /** Suggested duration in frames at 30fps — used when the caller doesn't
   *  pass an explicit durationFrames. Computed empirically from the time
   *  the spring takes to settle within 2% of target. */
  approxDurationFrames: number
}

export const SPRINGS: Record<SpringName, SpringConfig> = {
  gentle: { tension: 120, friction: 14, approxDurationFrames: 18 },
  wobbly: { tension: 180, friction: 12, approxDurationFrames: 24 },
  stiff: { tension: 210, friction: 20, approxDurationFrames: 12 },
  slow: { tension: 280, friction: 60, approxDurationFrames: 24 },
  molasses: { tension: 280, friction: 120, approxDurationFrames: 36 },
}

export function isSpringName(s: string): s is SpringName {
  return Object.prototype.hasOwnProperty.call(SPRINGS, s)
}
