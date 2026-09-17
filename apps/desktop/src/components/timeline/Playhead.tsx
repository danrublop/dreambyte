'use client'

import React from 'react'

interface Props {
  currentTime: number
  pps: number
  scrollX: number
  containerWidth: number
  isDragging: boolean
  dragTime: number
  onPointerDown: (e: React.PointerEvent) => void
}

function formatTimeFull(s: number) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.floor((s % 1) * 10)
  return `${m}:${sec.toString().padStart(2, '0')}.${ms}`
}

export default function Playhead({
  currentTime,
  pps,
  scrollX,
  containerWidth,
  isDragging,
  dragTime,
  onPointerDown,
}: Props) {
  const displayTime = isDragging ? dragTime : currentTime
  const x = displayTime * pps - scrollX

  // Only render if visible
  if (x < -10 || x > containerWidth + 10) return null

  return (
    <div className="absolute top-0 bottom-0 z-30 pointer-events-none" style={{ left: x, width: 0 }}>
      {/* Drag handle — NLE-style filled tab */}
      <div
        className="pointer-events-auto cursor-col-resize"
        style={{
          position: 'absolute',
          top: 0,
          left: -7,
          width: 14,
          height: 10,
          background: 'var(--tl-playhead)',
          borderRadius: '0 0 3px 3px',
        }}
        onPointerDown={onPointerDown}
      />
      {/* Time tooltip */}
      {isDragging && (
        <div
          className="absolute whitespace-nowrap"
          style={{
            top: -18,
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: 9,
            fontFamily: 'monospace',
            background: 'var(--tl-playhead)',
            color: '#fff',
            padding: '1px 4px',
            borderRadius: 3,
            lineHeight: '14px',
          }}
        >
          {formatTimeFull(dragTime)}
        </div>
      )}
      {/* Vertical line */}
      <div
        className="absolute"
        style={{
          top: 0,
          bottom: 0,
          left: -0.5,
          width: 1,
          background: 'var(--tl-playhead)',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
