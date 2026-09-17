/**
 * Grid system for element snapping and alignment.
 * Provides snap-to-grid, snap-to-elements, and coordinate normalization.
 */

export interface GridConfig {
  enabled: boolean // default true
  size: 20 | 40 | 80 // px, default 40
  showGrid: boolean // visual grid overlay, default false
  snapThreshold: number // px distance to snap, default 12
  snapToElements: boolean // also snap to other elements' edges, default true
}

export const DEFAULT_GRID_CONFIG: GridConfig = {
  enabled: true,
  size: 40,
  showGrid: false,
  snapThreshold: 12,
  snapToElements: true,
}

export interface SnapResult {
  x: number
  y: number
  snappedX: boolean
  snappedY: boolean
}

export interface ElementRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Snap a single value to the nearest grid line if within threshold.
 */
export function snapToGrid(value: number, gridSize: number, threshold: number = 12): number {
  const snapped = Math.round(value / gridSize) * gridSize
  return Math.abs(value - snapped) <= threshold ? snapped : value
}

/**
 * Snap a point to the grid and optionally to other element edges.
 */
export function snapPoint(x: number, y: number, grid: GridConfig, otherElements?: ElementRect[]): SnapResult {
  let sx = x,
    sy = y
  let snappedX = false,
    snappedY = false

  if (grid.enabled) {
    const nx = snapToGrid(x, grid.size, grid.snapThreshold)
    const ny = snapToGrid(y, grid.size, grid.snapThreshold)
    if (nx !== x) {
      sx = nx
      snappedX = true
    }
    if (ny !== y) {
      sy = ny
      snappedY = true
    }
  }

  // Snap to other elements' edges
  if (grid.snapToElements && otherElements) {
    for (const el of otherElements) {
      const edges = [
        el.x,
        el.x + el.w,
        el.x + el.w / 2, // x edges: left, right, center
        el.y,
        el.y + el.h,
        el.y + el.h / 2, // y edges: top, bottom, center
      ]

      // Check x edges
      for (let i = 0; i < 3; i++) {
        if (Math.abs(sx - edges[i]) < grid.snapThreshold) {
          sx = edges[i]
          snappedX = true
          break
        }
      }
      // Check y edges
      for (let i = 3; i < 6; i++) {
        if (Math.abs(sy - edges[i]) < grid.snapThreshold) {
          sy = edges[i]
          snappedY = true
          break
        }
      }
    }
  }

  return { x: sx, y: sy, snappedX, snappedY }
}

/**
 * Normalize coordinates to grid for agent tool calls.
 * Always snaps (no threshold) — just rounds to nearest grid line.
 */
export function normalizeCoordinates(x: number, y: number, grid: GridConfig): { x: number; y: number } {
  if (!grid.enabled) return { x, y }
  return {
    x: Math.round(x / grid.size) * grid.size,
    y: Math.round(y / grid.size) * grid.size,
  }
}

/**
 * Grid zone descriptions for agent context injection.
 */
export function getGridContextForAgent(gridSize: number): string {
  return `GRID: ${gridSize}px grid. All coordinates should be multiples of ${gridSize}.
Canvas zones:
  Safe area: x 60-1860, y 60-1020
  Title zone: x 60-1860, y 60-160
  Main content: x 60-1860, y 180-900
  Footer/caption: x 60-1860, y 920-1020
  Left margin: x 60-200 (good for labels)
  Right margin: x 1720-1860 (good for legends)`
}
