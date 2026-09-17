'use client'

import type { GridConfig } from '@/lib/grid'

interface GridOverlayProps {
  grid: GridConfig
  canvasWidth?: number
  canvasHeight?: number
}

export default function GridOverlay({ grid, canvasWidth = 1920, canvasHeight = 1080 }: GridOverlayProps) {
  if (!grid.showGrid) return null

  const cols = Math.floor(canvasWidth / grid.size)
  const rows = Math.floor(canvasHeight / grid.size)

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: 0.15,
      }}
      viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
      preserveAspectRatio="none"
    >
      {/* Grid lines */}
      {Array.from({ length: cols + 1 }).map((_, i) => (
        <line
          key={`v${i}`}
          x1={i * grid.size}
          y1={0}
          x2={i * grid.size}
          y2={canvasHeight}
          stroke="#4a4a52"
          strokeWidth="0.5"
        />
      ))}
      {Array.from({ length: rows + 1 }).map((_, i) => (
        <line
          key={`h${i}`}
          x1={0}
          y1={i * grid.size}
          x2={canvasWidth}
          y2={i * grid.size}
          stroke="#4a4a52"
          strokeWidth="0.5"
        />
      ))}
      {/* Rule-of-thirds guides */}
      {[1 / 3, 2 / 3].map((r, i) => (
        <g key={`thirds-${i}`}>
          <line
            x1={canvasWidth * r}
            y1={0}
            x2={canvasWidth * r}
            y2={canvasHeight}
            stroke="#e84545"
            strokeWidth="0.5"
            strokeDasharray="4 4"
          />
          <line
            x1={0}
            y1={canvasHeight * r}
            x2={canvasWidth}
            y2={canvasHeight * r}
            stroke="#e84545"
            strokeWidth="0.5"
            strokeDasharray="4 4"
          />
        </g>
      ))}
    </svg>
  )
}
