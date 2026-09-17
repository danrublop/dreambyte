// Shared keyframe sampler + ref resolver for all renderer adapters.
//
// Every adapter (react/motion/lottie/three/canvas2d) needs to answer the
// same question: "given a MotionRef and a frame, what are the {tx,ty,sx,
// sy,rot,opacity} values right now?" Co-locating this here is what makes
// all five adapters produce frame-identical timing.

import type { CompileContext, EasingName, MotionRef, PresetKeyframe } from '../types'
import { getMotionPreset } from '../presets.generated'
import { SPRINGS } from '../springs'

export interface SampledFrame {
  tx?: number
  ty?: number
  sx?: number
  sy?: number
  rot?: number
  opacity?: number
}

export interface ResolvedMotion {
  keyframes: ReadonlyArray<PresetKeyframe>
  startFrame: number
  endFrame: number
  easing: EasingName
}

export function resolveRef(ref: MotionRef, ctx: CompileContext): ResolvedMotion | null {
  if (ref.kind === 'preset') {
    const preset = getMotionPreset(ref.preset)
    if (!preset) return null
    const duration = ref.durationFrames ?? preset.defaultDurationFrames
    const delay = ref.delayFrames ?? 0
    const easing = ref.easing ?? preset.defaultEasing ?? ctx.defaultEasing
    return {
      keyframes: preset.keyframes,
      startFrame: delay,
      endFrame: delay + duration,
      easing,
    }
  }
  if (ref.kind === 'custom') {
    return {
      keyframes: ref.keyframes,
      startFrame: ref.delayFrames ?? 0,
      endFrame: (ref.delayFrames ?? 0) + ref.durationFrames,
      easing: ref.easing ?? ctx.defaultEasing,
    }
  }
  // Spring refs synthesize a 2-keyframe animation from `from` → `to`
  // using the spring's approxDurationFrames as a duration hint.
  const cfg = SPRINGS[ref.spring]
  const fromX = ref.from.x ?? 0
  const fromY = ref.from.y ?? 0
  const toX = ref.to.x ?? 0
  const toY = ref.to.y ?? 0
  const fromOp = ref.from.opacity
  const toOp = ref.to.opacity
  const fromS = ref.from.scale
  const toS = ref.to.scale
  const synthetic: PresetKeyframe[] = [
    { at: 0, tx: fromX, ty: fromY, opacity: fromOp, sx: fromS, sy: fromS },
    { at: 1, tx: toX, ty: toY, opacity: toOp, sx: toS, sy: toS },
  ]
  return {
    keyframes: synthetic,
    startFrame: ref.delayFrames ?? 0,
    endFrame: (ref.delayFrames ?? 0) + cfg.approxDurationFrames,
    easing: 'ease-out',
  }
}

export function sampleAtFrame(resolved: ResolvedMotion, frame: number): SampledFrame {
  const span = Math.max(1, resolved.endFrame - resolved.startFrame)
  const rawProgress = clamp01((frame - resolved.startFrame) / span)
  const eased = applyEasing(rawProgress, resolved.easing)
  return sampleKeyframes(resolved.keyframes, eased)
}

export function sampleKeyframes(keyframes: ReadonlyArray<PresetKeyframe>, t: number): SampledFrame {
  if (keyframes.length === 0) return {}
  if (t <= keyframes[0].at) return { ...keyframes[0] }
  if (t >= keyframes[keyframes.length - 1].at) return { ...keyframes[keyframes.length - 1] }

  let lo = 0
  for (let i = 1; i < keyframes.length; i++) {
    if (keyframes[i].at >= t) {
      lo = i - 1
      break
    }
  }
  const a = keyframes[lo]
  const b = keyframes[lo + 1]
  const span = Math.max(0.0001, b.at - a.at)
  const local = (t - a.at) / span

  const result: SampledFrame = {}
  for (const key of ['tx', 'ty', 'sx', 'sy', 'rot', 'opacity'] as const) {
    const av = a[key]
    const bv = b[key]
    if (av !== undefined && bv !== undefined) {
      result[key] = av + (bv - av) * local
    } else if (av !== undefined) {
      result[key] = av
    } else if (bv !== undefined) {
      result[key] = bv
    }
  }
  return result
}

export function clamp01(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * Map an EasingName to a unit-interval function. Evaluates the DSL's
 * power/expo names with standard polynomial/exponential formulas so adapters
 * don't need a runtime animation-library dependency. Imperfect for elastic/back/bounce — those families
 * are encoded in the keyframe waveform itself, with a leading-edge ease-out.
 */
export function applyEasing(t: number, name: EasingName): number {
  switch (name) {
    case 'linear':
      return t
    case 'ease-in':
    case 'power1.in':
      return t * t
    case 'ease-out':
    case 'power1.out':
      return 1 - (1 - t) * (1 - t)
    case 'ease-in-out':
    case 'power1.inOut':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    case 'power2.in':
      return t * t * t
    case 'power2.out':
      return 1 - Math.pow(1 - t, 3)
    case 'power2.inOut':
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    case 'power3.in':
      return t * t * t * t
    case 'power3.out':
      return 1 - Math.pow(1 - t, 4)
    case 'power3.inOut':
      return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2
    case 'expo.in':
      return t === 0 ? 0 : Math.pow(2, 10 * t - 10)
    case 'expo.out':
      return t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
    case 'expo.inOut':
      return t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2
    case 'back.in':
    case 'back.out':
    case 'back.inOut':
    case 'elastic.in':
    case 'elastic.out':
    case 'elastic.inOut':
    case 'bounce.in':
    case 'bounce.out':
    case 'bounce.inOut':
      return 1 - Math.pow(1 - t, 2)
    default:
      return t
  }
}

/**
 * Emit-side twin of {@link applyEasing}: returns a JS *expression string*
 * that eases the variable `tVar` for the given easing. The pure sampler
 * (sampleAtFrame) applies `applyEasing(t, resolved.easing)`, but the
 * emit-as-string adapters used to hardcode a single ease-out, so previewed
 * scenes honored the preset easing while exported scenes silently animated
 * ease-out. The adapters now inline
 * `easedExpr(resolved.easing, 't')` so emitted output matches the sampler.
 *
 * KEEP IN SYNC with applyEasing above — every branch here is the expression
 * form of the corresponding applyEasing case. A unit test asserts they agree
 * across all EasingNames and a range of t values.
 */
export function easedExpr(name: EasingName, tVar: string): string {
  const t = `(${tVar})`
  switch (name) {
    case 'linear':
      return t
    case 'ease-in':
    case 'power1.in':
      return `${t} * ${t}`
    case 'ease-out':
    case 'power1.out':
      return `1 - (1 - ${t}) * (1 - ${t})`
    case 'ease-in-out':
    case 'power1.inOut':
      return `(${t} < 0.5 ? 2 * ${t} * ${t} : 1 - Math.pow(-2 * ${t} + 2, 2) / 2)`
    case 'power2.in':
      return `${t} * ${t} * ${t}`
    case 'power2.out':
      return `1 - Math.pow(1 - ${t}, 3)`
    case 'power2.inOut':
      return `(${t} < 0.5 ? 4 * ${t} * ${t} * ${t} : 1 - Math.pow(-2 * ${t} + 2, 3) / 2)`
    case 'power3.in':
      return `${t} * ${t} * ${t} * ${t}`
    case 'power3.out':
      return `1 - Math.pow(1 - ${t}, 4)`
    case 'power3.inOut':
      return `(${t} < 0.5 ? 8 * ${t} * ${t} * ${t} * ${t} : 1 - Math.pow(-2 * ${t} + 2, 4) / 2)`
    case 'expo.in':
      return `(${t} === 0 ? 0 : Math.pow(2, 10 * ${t} - 10))`
    case 'expo.out':
      return `(${t} === 1 ? 1 : 1 - Math.pow(2, -10 * ${t}))`
    case 'expo.inOut':
      return `(${t} === 0 ? 0 : ${t} === 1 ? 1 : ${t} < 0.5 ? Math.pow(2, 20 * ${t} - 10) / 2 : (2 - Math.pow(2, -20 * ${t} + 10)) / 2)`
    case 'back.in':
    case 'back.out':
    case 'back.inOut':
    case 'elastic.in':
    case 'elastic.out':
    case 'elastic.inOut':
    case 'bounce.in':
    case 'bounce.out':
    case 'bounce.inOut':
      // These families are encoded in the keyframe waveform itself with a
      // leading-edge ease-out — same fallthrough as applyEasing.
      return `1 - Math.pow(1 - ${t}, 2)`
    default:
      return t
  }
}

// Adapters interpolate `helperName` / `targetVar` / `timelineVar` directly
// into emitted JS. If a caller ever sources these from untrusted input,
// arbitrary code in the rendered scene HTML follows. Validate at every
// emit boundary as defense-in-depth — JS identifier syntax only.
const JS_IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
export function assertJsIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || !JS_IDENT_RE.test(value)) {
    throw new Error(`Motion DSL: ${label} must be a JS identifier (got ${JSON.stringify(value)})`)
  }
}
