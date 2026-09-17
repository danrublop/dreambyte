// ── Avatar pip geometry — shared by placement & export clamp (MEDIA-GEO D3) ──
//
// The agent placed pip avatars at hardcoded x=1640/y=800 — correct only for a
// 1920×1080 (16:9) project. On 9:16/1:1 those coordinates land the pip
// offscreen at export (pixi positions the 0.5-anchored sprite by x/y with no
// clamp). This computes the pip CENTER from the project dimensions and a
// proportional margin, for every corner, so the pip sits inside any frame; the
// export clamp is a size-aware backstop.

import type { ProjectDimensions } from '../dimensions'

/** Preview default pip box size (px) and corner margin (px) — see sceneTemplate. */
export const PIP_DEFAULT_SIZE = 280
export const PIP_PREVIEW_MARGIN = 40

/**
 * Compute the CENTER (x,y) of a pip avatar for a placement, so the placed
 * sprite (anchor 0.5) sits in the corner with a margin at ANY aspect ratio.
 * Mirrors the preview CSS (40px margin, size 280) so preview == export.
 */
export function computeAvatarPipCenter(
  placement: string,
  project: ProjectDimensions,
  size: number = PIP_DEFAULT_SIZE,
  margin: number = PIP_PREVIEW_MARGIN,
): { x: number; y: number } {
  const W = project.width > 0 ? project.width : 1920
  const H = project.height > 0 ? project.height : 1080
  const half = size / 2
  // Keep the margin proportional on smaller frames so the pip never overlaps
  // the opposite edge on a narrow (e.g. 9:16 720p) canvas.
  const m = Math.min(margin, Math.max(8, Math.round(Math.min(W, H) * 0.04)))
  const isRight = placement.includes('right')
  const isTop = placement.includes('top')
  const x = isRight ? W - m - half : m + half
  const y = isTop ? m + half : H - m - half
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * Clamp a sprite CENTER so the (size-aware) sprite box stays inside the canvas.
 * Export-side backstop for layers placed before D3 (or by a future writer that
 * forgets). Pure.
 */
export function clampSpriteCenterIntoCanvas(
  center: { x: number; y: number },
  size: { width: number; height: number },
  canvas: { width: number; height: number },
): { x: number; y: number } {
  const halfW = size.width / 2
  const halfH = size.height / 2
  // If the sprite is larger than the canvas on an axis, center it on that axis.
  const x = size.width >= canvas.width ? canvas.width / 2 : Math.min(Math.max(center.x, halfW), canvas.width - halfW)
  const y =
    size.height >= canvas.height ? canvas.height / 2 : Math.min(Math.max(center.y, halfH), canvas.height - halfH)
  return { x, y }
}
