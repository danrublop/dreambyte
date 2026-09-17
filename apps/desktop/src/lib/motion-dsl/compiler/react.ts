// React adapter for the Motion DSL.
//
// Two entry points:
//
//   compileMotionRefToStyleAt(ref, ctx, frame)
//     Pure function — given a MotionRef, a compile context (fps + defaults)
//     and a frame number, returns a React-compatible style object. Used by
//     unit tests and by any in-app preview that wants to render a single
//     frame outside the scene runtime.
//
//   emitReactMotionHelper(ref, ctx, opts)
//     Emits a string of JS that defines an inline `motionStyle(frame)`
//     function the scene template wraps around the layer's mounted root.
//     This is the integration point for sceneTemplate.ts.
//
// Both share the keyframe sampler in `_sample.ts` — that's the contract
// that keeps all five renderer adapters frame-identical.

import type { CompileContext, MotionRef } from '../types'
import { DEFAULT_COMPILE_CONTEXT } from '../types'
import { resolveRef, sampleAtFrame, assertJsIdentifier, easedExpr, type SampledFrame } from './_sample'

export interface ReactMotionStyle {
  opacity?: number
  transform?: string
}

/**
 * Walk the keyframes for a MotionRef and return a CSS-ready style object
 * at the given frame. Returns an empty object when the motion is not yet
 * active or has fully resolved to identity (no opacity / transform diff).
 */
export function compileMotionRefToStyleAt(
  ref: MotionRef,
  ctx: CompileContext = DEFAULT_COMPILE_CONTEXT,
  frame: number,
): ReactMotionStyle {
  const resolved = resolveRef(ref, ctx)
  if (!resolved) return {}
  return sampleToReactStyle(sampleAtFrame(resolved, frame))
}

function sampleToReactStyle(sample: SampledFrame): ReactMotionStyle {
  const style: ReactMotionStyle = {}
  if (sample.opacity !== undefined) style.opacity = sample.opacity
  const tx = sample.tx ?? 0
  const ty = sample.ty ?? 0
  const sx = sample.sx ?? 1
  const sy = sample.sy ?? 1
  const rot = sample.rot ?? 0
  const hasTransform =
    sample.tx !== undefined ||
    sample.ty !== undefined ||
    sample.sx !== undefined ||
    sample.sy !== undefined ||
    sample.rot !== undefined
  if (hasTransform) {
    style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy}) rotate(${rot}deg)`
  }
  return style
}

// ── Emit-as-string side: produces JS code the scene template inlines ─────

export interface EmitOptions {
  /** Variable name for the helper (default: 'motionStyle'). */
  helperName?: string
}

/**
 * Returns a string of JS that defines `function motionStyle(frame) {...}`
 * suitable for inlining into a generated React scene. The function is
 * pure and takes only `frame` as input — call sites do
 * `<div style={{ ...motionStyle(frame) }}>...</div>`.
 *
 * The body inlines the resolved keyframes as a const so the scene runtime
 * doesn't need a Dreambyte-DSL package — a key requirement for the SDK
 * extraction (W2) staying small.
 */
export function emitReactMotionHelper(
  ref: MotionRef,
  ctx: CompileContext = DEFAULT_COMPILE_CONTEXT,
  opts: EmitOptions = {},
): string {
  const resolved = resolveRef(ref, ctx)
  const helperName = opts.helperName ?? 'motionStyle'
  assertJsIdentifier(helperName, 'helperName')
  if (!resolved) {
    return `function ${helperName}() { return {} }`
  }
  return [
    `function ${helperName}(frame) {`,
    `  const KF = ${JSON.stringify(resolved.keyframes)}`,
    `  const START = ${resolved.startFrame}`,
    `  const END = ${resolved.endFrame}`,
    `  const SPAN = Math.max(1, END - START)`,
    `  const t = Math.max(0, Math.min(1, (frame - START) / SPAN))`,
    `  // Easing mirrors the pure sampler (applyEasing) so preview === export.`,
    `  const eased = ${easedExpr(resolved.easing, 't')}`,
    `  if (eased <= KF[0].at) return _toCss(KF[0])`,
    `  if (eased >= KF[KF.length - 1].at) return _toCss(KF[KF.length - 1])`,
    `  let lo = 0`,
    `  for (let i = 1; i < KF.length; i++) { if (KF[i].at >= eased) { lo = i - 1; break } }`,
    `  const a = KF[lo], b = KF[lo + 1]`,
    `  const local = (eased - a.at) / Math.max(0.0001, b.at - a.at)`,
    `  const sample = {}`,
    `  for (const k of ['tx','ty','sx','sy','rot','opacity']) {`,
    `    const av = a[k], bv = b[k]`,
    `    if (av !== undefined && bv !== undefined) sample[k] = av + (bv - av) * local`,
    `    else if (av !== undefined) sample[k] = av`,
    `    else if (bv !== undefined) sample[k] = bv`,
    `  }`,
    `  return _toCss(sample)`,
    `}`,
    `function _toCss(s) {`,
    `  const out = {}`,
    `  if (s.opacity !== undefined) out.opacity = s.opacity`,
    `  const has = s.tx!==undefined||s.ty!==undefined||s.sx!==undefined||s.sy!==undefined||s.rot!==undefined`,
    `  if (has) out.transform = 'translate(' + (s.tx||0) + 'px, ' + (s.ty||0) + 'px) scale(' + (s.sx??1) + ', ' + (s.sy??1) + ') rotate(' + (s.rot||0) + 'deg)'`,
    `  return out`,
    `}`,
  ].join('\n')
}
