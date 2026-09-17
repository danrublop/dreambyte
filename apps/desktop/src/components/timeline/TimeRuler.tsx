'use client'

import { useCallback } from 'react'
import { RULER_HEIGHT } from './constants'
import type { TimelineMarker } from '@/lib/types'

interface Props {
  pps: number
  totalWidth: number
  scrollX: number
  containerWidth: number
  onSeek: (time: number) => void
  fps?: number
  markers?: TimelineMarker[]
  onMarkerRemove?: (markerId: string) => void
  onMarkerRename?: (markerId: string, label: string) => void
  /** Sequence in / out marks rendered as bracket glyphs + a shaded range. */
  inPoint?: number
  outPoint?: number
}

export function formatTimecode(s: number, fps: number, showFrames: boolean) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const base =
    h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
      : `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  if (!showFrames) return base
  const frame = Math.floor((s % 1) * fps)
  return `${base}:${frame.toString().padStart(2, '0')}`
}

// Minimum pixel spacing between adjacent major labels. Sized for the widest
// label we render (`H:MM:SS:FF` ~ 70px at 10px monospace + padding).
const MIN_MAJOR_PX = 80
// Minimum pixel spacing between adjacent minor ticks. Below this they
// visually merge into a solid line, which looks like noise.
const MIN_MINOR_PX = 8

/**
 * NLE-style "nice" interval picker. We want the *pixel* spacing between
 * major ticks to stay roughly constant across zooms — only the time interval
 * each tick represents changes. We pick the smallest interval in a fixed
 * "nice number" series that yields at least MIN_MAJOR_PX between labels.
 *
 * The series is hand-tuned so adjacent intervals are 2×/2.5×/3× apart (no
 * ugly jumps like 1→10), and includes frame-aligned values for high zoom.
 */
export function getTickInterval(pps: number, fps: number): { major: number; minor: number } {
  const frame = 1 / fps
  // Frame-level → second-level → minute-level → hour-level.
  const candidates: number[] = [
    frame, // 1 frame
    2 * frame,
    5 * frame,
    10 * frame,
    0.5,
    1,
    2,
    5,
    10,
    15,
    30,
    60, // 1 min
    120,
    300,
    600,
    1800,
    3600, // 1 h
    7200,
  ]
  let major = candidates[candidates.length - 1]
  for (const c of candidates) {
    if (c * pps >= MIN_MAJOR_PX) {
      major = c
      break
    }
  }
  // Minor: divide major into the largest number of sub-ticks that still keeps
  // each minor ≥ MIN_MINOR_PX. We prefer 10ths, fall back to 5ths/4ths/2nds.
  // For frame-aligned majors at very high zoom, the natural minor is 1 frame.
  const divisors = major <= frame * 10 ? [major / frame, 5, 2, 1] : [10, 5, 4, 2, 1]
  let minor = major
  for (const d of divisors) {
    if (d <= 1) continue
    const m = major / d
    if (m * pps >= MIN_MINOR_PX) {
      minor = m
      break
    }
  }
  return { major, minor }
}

export default function TimeRuler({
  pps,
  totalWidth,
  scrollX,
  containerWidth,
  onSeek,
  fps = 30,
  markers,
  onMarkerRemove,
  onMarkerRename,
  inPoint,
  outPoint,
}: Props) {
  const showFrames = pps >= fps
  const { major, minor } = getTickInterval(pps, fps)
  const totalDuration = totalWidth / pps

  // Snap the iteration to the minor-tick grid by index so non-integer minors
  // (e.g. 1/30 s for frame-level ticks) don't accumulate floating-point drift.
  const startIdx = Math.max(0, Math.floor(scrollX / pps / minor))
  const endIdx = Math.ceil(Math.min(totalDuration, (scrollX + containerWidth) / pps) / minor)
  // Every Nth minor tick is a major tick (where N = major/minor, rounded).
  // Computing on the index avoids floating-point modulo errors that made
  // major ticks blink missing at non-integer intervals.
  const ratio = Math.max(1, Math.round(major / minor))

  const ticks: { time: number; isMajor: boolean }[] = []
  for (let i = startIdx; i <= endIdx; i++) {
    ticks.push({ time: i * minor, isMajor: i % ratio === 0 })
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const time = (scrollX + (e.clientX - rect.left)) / pps
      onSeek(Math.max(0, Math.min(totalDuration, time)))
    },
    [scrollX, pps, totalDuration, onSeek],
  )

  return (
    <div
      className="relative flex-shrink-0 cursor-pointer select-none overflow-hidden"
      style={{
        height: RULER_HEIGHT,
        background: 'var(--tl-track-bg)',
      }}
      onClick={handleClick}
    >
      <div className="relative" style={{ width: totalWidth, transform: `translateX(${-scrollX}px)`, height: '100%' }}>
        {ticks.map((tick, i) => {
          const x = tick.time * pps
          return (
            <div key={i} className="absolute" style={{ left: x, bottom: 0 }}>
              <div
                style={{
                  width: 1,
                  height: tick.isMajor ? 10 : 3,
                  background: tick.isMajor ? 'var(--tl-ruler-tick)' : 'var(--tl-ruler-tick-minor)',
                  opacity: tick.isMajor ? 1 : 0.6,
                }}
              />
              {tick.isMajor && (
                <span
                  className="absolute whitespace-nowrap"
                  style={{
                    bottom: 12,
                    left: 3,
                    fontSize: 10,
                    fontWeight: 400,
                    fontFamily: 'monospace',
                    color: 'var(--tl-ruler-label)',
                    lineHeight: '1',
                    letterSpacing: '0.02em',
                  }}
                >
                  {formatTimecode(tick.time, fps, showFrames)}
                </span>
              )}
            </div>
          )
        })}
        {/* Sequence in/out range: shaded band between marks + bracket glyphs. */}
        {(inPoint != null || outPoint != null) && (
          <>
            {inPoint != null && outPoint != null && outPoint > inPoint && (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: inPoint * pps,
                  width: (outPoint - inPoint) * pps,
                  top: 0,
                  bottom: 0,
                  background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                }}
              />
            )}
            {inPoint != null && (
              <div
                className="absolute pointer-events-none"
                title={`In @ ${inPoint.toFixed(2)}s`}
                style={{
                  left: inPoint * pps,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--color-accent)',
                  boxShadow: '2px 0 0 var(--color-accent)',
                }}
              />
            )}
            {outPoint != null && (
              <div
                className="absolute pointer-events-none"
                title={`Out @ ${outPoint.toFixed(2)}s`}
                style={{
                  left: outPoint * pps - 2,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--color-accent)',
                  boxShadow: '-2px 0 0 var(--color-accent)',
                }}
              />
            )}
          </>
        )}
        {markers?.map((m) => {
          const x = m.time * pps
          return (
            <div key={m.id} className="absolute" style={{ left: x - 5, top: 1, height: '100%' }}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onSeek(m.time)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (!onMarkerRename) return
                  const next = window.prompt('Marker label:', m.label ?? '')
                  if (next === null) return
                  onMarkerRename(m.id, next)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onMarkerRemove) onMarkerRemove(m.id)
                }}
                title={m.label || `Marker @ ${m.time.toFixed(2)}s — dbl-click to rename, right-click to remove`}
                className="no-style"
                style={{
                  display: 'block',
                  width: 10,
                  height: 10,
                  background: m.color ?? 'var(--color-accent)',
                  clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
                  cursor: 'pointer',
                }}
              />
              {m.label && (
                <span
                  className="absolute whitespace-nowrap pointer-events-none"
                  style={{
                    left: 12,
                    top: 1,
                    fontSize: 9,
                    fontWeight: 500,
                    color: m.color ?? 'var(--color-accent)',
                    textShadow: '0 1px 2px var(--tl-bg)',
                  }}
                >
                  {m.label}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
