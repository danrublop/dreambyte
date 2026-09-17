// ── Veo3 (AI video) layer geometry — shared by placement, poll, preview & export ──
//
// Single source of truth for two pieces of geometry that used to be duplicated
// (or wrong) across the agent toolside, the renderer poll, the preview HTML
// template, and the pixi export:
//
//   1. computeVeo3FullFrameDims — contain-fit the clip's own aspect ratio into
//      the project frame so a placed clip is NEVER 0×0 (the original placement
//      bug) and renders at a real, frame-filling size.
//
//   2. resolveVeo3CenterCoords — the anchor convention. CENTER is canon (it
//      matches image layers and the pixi export, which both treat x/y as the
//      sprite center). New writers author CENTER coords and stamp
//      `anchorVersion: VEO3_ANCHOR_VERSION`; LEGACY layers (no flag) were
//      authored under the old top-left preview semantics and are translated to
//      center at READ/RENDER time.
//
// Replay-safety : the legacy translation is applied
// at render time and NEVER written back to the stored layer. This is what makes
// it idempotent across checkpoint-resume and undo-replay (both of which carry
// pre-migration, un-flagged coordinates):
//
//   • A pure render-time translate keyed on the MISSING flag is idempotent by
//     construction — it reads stored coords, returns center coords, and stores
//     nothing, so "apply twice" == "apply once" trivially.
//   • A normalize-on-load-write-back design is NOT replay-safe: if it stamped
//     the flag + rewrote coords, a later checkpoint-resume / undo-replay that
//     restores the OLD (un-flagged, top-left) layer object would re-enter the
//     legacy branch and translate again — double-shifting the clip. By never
//     mutating stored data we sidestep that class of bug entirely.
//
// The flag's ONLY job is to say "these x/y are already center, do NOT translate
// them." Everything a new writer produces carries it; everything legacy does not.

import type { ProjectDimensions } from '../dimensions'

/**
 * Anchor schema version for veo3 layers. A layer at this version (or higher)
 * stores x/y as the sprite CENTER. Absent/lower => legacy top-left coords that
 * the render-time resolver translates to center.
 */
export const VEO3_ANCHOR_VERSION = 2

/** Minimal shape the geometry helpers read off a veo3 layer. */
export interface Veo3GeometryInput {
  x: number
  y: number
  width: number
  height: number
  anchorVersion?: number
}

/**
 * Contain-fit the clip's aspect ratio into the project frame, producing a
 * full-frame-class box that's never zero. Used at placement, at poll
 * completion (when dims are still falsy), and as the template fallback.
 *
 * Contain (not cover) so the whole clip is visible, centered in the frame; the
 * <video>/sprite then object-fit:cover within that box. Returns integer px.
 */
export function computeVeo3FullFrameDims(
  videoAspectRatio: string | null | undefined,
  project: ProjectDimensions,
): { width: number; height: number } {
  const pw = project.width > 0 ? project.width : 1920
  const ph = project.height > 0 ? project.height : 1080
  const [rwRaw, rhRaw] = String(videoAspectRatio ?? '16:9')
    .split(':')
    .map((n) => Number(n))
  const rw = Number.isFinite(rwRaw) && rwRaw > 0 ? rwRaw : 16
  const rh = Number.isFinite(rhRaw) && rhRaw > 0 ? rhRaw : 9
  const clipRatio = rw / rh
  const frameRatio = pw / ph
  let width: number
  let height: number
  if (clipRatio >= frameRatio) {
    // Clip is wider than (or equal to) the frame → fit to frame width.
    width = pw
    height = Math.round(pw / clipRatio)
  } else {
    // Clip is taller than the frame → fit to frame height.
    height = ph
    width = Math.round(ph * clipRatio)
  }
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

/** True when the layer needs full-frame dims derived (placeholder/zero). */
export function veo3DimsAreFalsy(layer: { width?: number | null; height?: number | null }): boolean {
  return !layer.width || !layer.height
}

/**
 * Resolve a veo3 layer's CENTER coordinates (canon), translating legacy
 * top-left coords at render time. Pure: reads coords, returns center, mutates
 * nothing — see the replay-safety note at the top of the file.
 *
 *   • anchorVersion >= VEO3_ANCHOR_VERSION → x/y are already center; return as-is.
 *   • otherwise (legacy)                   → x/y were top-left; center is
 *                                            (x + w/2, y + h/2).
 */
export function resolveVeo3CenterCoords(layer: Veo3GeometryInput): { cx: number; cy: number } {
  const x = Number(layer.x || 0)
  const y = Number(layer.y || 0)
  const w = Number(layer.width || 0)
  const h = Number(layer.height || 0)
  if ((layer.anchorVersion ?? 0) >= VEO3_ANCHOR_VERSION) {
    return { cx: x, cy: y }
  }
  return { cx: x + w / 2, cy: y + h / 2 }
}
