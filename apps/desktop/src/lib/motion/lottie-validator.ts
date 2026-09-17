/**
 * Lottie JSON validator with auto-fix for missing easing handles.
 *
 * The #1 crash cause in lottie-web is missing bezier easing on keyframes.
 * This validator catches structural issues and optionally injects safe
 * default easing handles so animations render instead of crashing.
 */

import { SAFE_DEFAULT, easingToLottieHandles, type CubicBezier } from './easing'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  /** The (possibly auto-fixed) JSON object. Only present when `fix: true`. */
  fixed?: Record<string, unknown>
  /** Number of keyframes that were auto-fixed. */
  fixCount: number
}

export interface ValidateOptions {
  /** When true, inject default easing handles into keyframes missing them. Default: true. */
  fix?: boolean
  /** The bezier curve to use for auto-fix. Default: SAFE_DEFAULT (corporate ease-in-out). */
  fixEasing?: CubicBezier
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

/**
 * Determine the dimensionality for a Lottie property name.
 * Position (p), scale (s), anchor point (a) are 3D; others are 1D.
 */
function dimensionsForProperty(propName: string): 1 | 3 {
  // In Lottie, transform properties: p=position, s=scale, a=anchorPoint are multi-dimensional
  if (propName === 'p' || propName === 's' || propName === 'a') return 3
  return 1
}

/**
 * Check whether a Lottie easing handle object looks valid.
 */
function hasValidHandles(kf: Record<string, unknown>): boolean {
  const i = kf.i
  const o = kf.o
  if (!isObject(i) || !isObject(o)) return false
  if (!isArray(i.x) || !isArray(i.y)) return false
  if (!isArray(o.x) || !isArray(o.y)) return false
  if ((i.x as number[]).length === 0 || (i.y as number[]).length === 0) return false
  if ((o.x as number[]).length === 0 || (o.y as number[]).length === 0) return false
  return true
}

/**
 * Walk an animated property's keyframe array and validate/fix easing handles.
 * Returns the number of fixes applied.
 */
function validateKeyframes(
  keyframes: unknown[],
  propName: string,
  path: string,
  result: ValidationResult,
  opts: Required<ValidateOptions>,
): number {
  let fixCount = 0
  const dims = dimensionsForProperty(propName)

  // All keyframes except the last must have easing handles
  for (let i = 0; i < keyframes.length - 1; i++) {
    const kf = keyframes[i]
    if (!isObject(kf)) continue

    if (!hasValidHandles(kf)) {
      const msg = `${path}[${i}]: missing or invalid easing handles`

      if (opts.fix) {
        const handles = easingToLottieHandles(opts.fixEasing, dims)
        kf.i = handles.i
        kf.o = handles.o
        result.warnings.push(`${msg} (auto-fixed)`)
        fixCount++
      } else {
        result.errors.push(msg)
      }
    }
  }

  // Check for linear spatial motion (position only) — warning, not error
  if (propName === 'p' && keyframes.length > 1) {
    let allLinear = true
    for (let i = 0; i < keyframes.length - 1; i++) {
      const kf = keyframes[i] as Record<string, unknown>
      if (!hasValidHandles(kf)) continue
      const oObj = kf.o as Record<string, unknown>
      const iObj = kf.i as Record<string, unknown>
      const ox = (oObj.x as number[])[0]
      const oy = (oObj.y as number[])[0]
      const ix = (iObj.x as number[])[0]
      const iy = (iObj.y as number[])[0]
      // Linear = control points at 0,0 and 1,1 (or very close)
      if (!(Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01 && Math.abs(ix - 1) < 0.01 && Math.abs(iy - 1) < 0.01)) {
        allLinear = false
        break
      }
    }
    if (allLinear) {
      result.warnings.push(`${path}: position uses linear easing — motion may look robotic`)
    }
  }

  return fixCount
}

/**
 * Recursively walk a Lottie object and validate all animated properties.
 */
function walkObject(
  obj: unknown,
  path: string,
  propName: string,
  result: ValidationResult,
  opts: Required<ValidateOptions>,
): void {
  if (!isObject(obj)) return

  // Check if this is an animated property (has "a" flag and "k" array)
  if ('a' in obj && 'k' in obj) {
    const animated = obj.a
    const k = obj.k
    if (animated === 1 && isArray(k) && k.length > 0 && isObject(k[0])) {
      // This is an animated property with keyframe array
      result.fixCount += validateKeyframes(k, propName, path, result, opts)
      return
    }
  }

  // Recurse into child objects
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (isObject(val)) {
      walkObject(val, `${path}.${key}`, key, result, opts)
    } else if (isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (isObject(val[i])) {
          walkObject(val[i], `${path}.${key}[${i}]`, key, result, opts)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a parsed Lottie JSON object.
 *
 * By default, auto-fixes missing easing handles using the corporate (safe)
 * bezier curve. Call with `{ fix: false }` for validation-only mode.
 *
 * @example
 * ```ts
 * const parsed = JSON.parse(rawLottieString)
 * const result = validateLottieJSON(parsed)
 * if (result.fixCount > 0) {
 *   console.log(`Auto-fixed ${result.fixCount} keyframes`)
 *   // Use result.fixed instead of the original
 * }
 * ```
 */
export function validateLottieJSON(json: unknown, options: ValidateOptions = {}): ValidationResult {
  const opts: Required<ValidateOptions> = {
    fix: options.fix ?? true,
    fixEasing: options.fixEasing ?? SAFE_DEFAULT,
  }

  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    fixCount: 0,
  }

  if (!isObject(json)) {
    result.valid = false
    result.errors.push('Root is not an object')
    return result
  }

  // --- Structure validation ---
  const requiredFields = ['v', 'fr', 'ip', 'op', 'w', 'h', 'layers'] as const
  for (const field of requiredFields) {
    if (!(field in json)) {
      result.errors.push(`Missing required field: ${field}`)
    }
  }

  if (!isArray(json.layers)) {
    result.valid = false
    result.errors.push('layers must be an array')
    return result
  }

  // --- Frame range validation ---
  const rootIp = typeof json.ip === 'number' ? json.ip : 0
  const rootOp = typeof json.op === 'number' ? json.op : Infinity

  for (let li = 0; li < json.layers.length; li++) {
    const layer = json.layers[li]
    if (!isObject(layer)) continue

    const layerIp = typeof layer.ip === 'number' ? layer.ip : undefined
    const layerOp = typeof layer.op === 'number' ? layer.op : undefined

    if (layerIp !== undefined && layerIp < rootIp) {
      result.warnings.push(`layers[${li}].ip (${layerIp}) is before root ip (${rootIp})`)
    }
    if (layerOp !== undefined && layerOp > rootOp) {
      result.warnings.push(`layers[${li}].op (${layerOp}) exceeds root op (${rootOp})`)
    }

    // Walk the layer to find all animated properties
    walkObject(layer, `layers[${li}]`, '', result, opts)
  }

  // Also walk assets (precomps can contain animations)
  if (isArray(json.assets)) {
    for (let ai = 0; ai < json.assets.length; ai++) {
      const asset = json.assets[ai]
      if (isObject(asset) && isArray(asset.layers)) {
        for (let li = 0; li < asset.layers.length; li++) {
          const layer = asset.layers[li]
          if (isObject(layer)) {
            walkObject(layer, `assets[${ai}].layers[${li}]`, '', result, opts)
          }
        }
      }
    }
  }

  // Determine overall validity
  if (result.errors.length > 0) {
    result.valid = false
  }

  // Attach fixed version when in fix mode
  if (opts.fix) {
    result.fixed = json as Record<string, unknown>
  }

  return result
}
