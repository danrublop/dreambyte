'use client'

/**
 * Keyframe diamond overlay: static render + right-click-remove, plus:
 *   - Pointer-drag: horizontal drag updates `keyframe.time` live via
 *     `keyframe/update`. Clamps to [0, clip.duration]; the reducer handles
 *     collisions with a `KEYFRAME_CONFLICT` error which we surface by
 *     reverting the drag locally (the reducer's state never advances, so
 *     the next render just shows the diamond back at its prior position).
 *   - Left-click without drag: opens an inline edit popover containing
 *     value + easing controls (via `EasingCurvePicker`). Clicking outside
 *     dismisses.
 *
 * "Add keyframe at playhead" lives on the clip-bar context menu in
 * `TrackRow.tsx` so it can read the global playhead time + dispatch
 * `keyframe/add`. Keep the overlay focused on editing existing kfs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, Keyframe } from '@/lib/types'
import { useVideoStore } from '@/lib/store'
import {
  buildKeyframeMarkers,
  colorForKeyframeProperty,
  deltaXToTimeDelta,
  snapKeyframeTime,
  type KeyframeMarkerData,
} from './keyframe-position'
import { EasingCurvePicker } from '@/components/inspector/EasingCurvePicker'

export interface KeyframeOverlayProps {
  clip: Clip
  /** Pixels per second for the timeline view. Comes from the parent's zoom. */
  pixelsPerSecond: number
  /** Height of the clip bar in px; diamond is centered vertically. */
  height: number
  /**
   * True when the clip is on a locked track — diamonds render but ignore
   * pointer events.
   */
  locked?: boolean
}

const DIAMOND_SIZE = 8
/** Px threshold below which a pointer-up is treated as a click, not a drag. */
const CLICK_VS_DRAG_THRESHOLD = 3

interface EditState {
  property: Keyframe['property']
  /** Time (clip-relative seconds) of the keyframe being edited. */
  time: number
  /** Pixel anchor for the popover. */
  anchorX: number
}

export function KeyframeOverlay({ clip, pixelsPerSecond, height, locked }: KeyframeOverlayProps) {
  // 'gain' keyframes render in the audio rubber-band overlay (value-positioned
  // line + diamonds) instead of as center-aligned diamonds here.
  const markers = useMemo(
    () => buildKeyframeMarkers(clip, pixelsPerSecond).filter((m) => m.property !== 'gain'),
    [clip, pixelsPerSecond],
  )
  const dispatchAction = useVideoStore((s) => s.dispatchAction)
  const [edit, setEdit] = useState<EditState | null>(null)
  // Local dragging state so multiple diamonds don't conflict on the same surface.
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startTime: number
    property: Keyframe['property']
  } | null>(null)

  // Close the popover when the user clicks elsewhere.
  useEffect(() => {
    if (!edit) return
    const dismiss = () => setEdit(null)
    window.addEventListener('pointerdown', dismiss, { capture: true })
    return () => window.removeEventListener('pointerdown', dismiss, { capture: true })
  }, [edit])

  const onContextMenu = useCallback(
    (m: KeyframeMarkerData) => (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (locked) return
      dispatchAction(
        {
          type: 'keyframe/remove',
          params: { clipId: clip.id, property: m.property, time: m.time },
        },
        { source: 'user' },
      )
    },
    [clip.id, dispatchAction, locked],
  )

  const onPointerDown = useCallback(
    (m: KeyframeMarkerData) => (e: React.PointerEvent) => {
      if (locked) return
      if (e.button !== 0) return // left-click only; right-click is handled by onContextMenu
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startTime: m.time, property: m.property }
      // We deliberately don't `setPointerCapture` here — diamonds are small and
      // the listener on `window` below tracks the global pointer reliably.

      let lastDispatchedTime = m.time
      let moved = false

      // RAF-coalesce: a 120Hz trackpad would otherwise dispatch a full
      // keyframe/update reducer + WAL write twice per frame. We keep the
      // most recent pointer and process it once per animation frame.
      let pendingEv: PointerEvent | null = null
      let rafId: number | null = null
      const applyMove = () => {
        rafId = null
        const ev = pendingEv
        pendingEv = null
        if (!ev || !dragRef.current) return
        const deltaPx = ev.clientX - dragRef.current.startX
        if (!moved && Math.abs(deltaPx) >= CLICK_VS_DRAG_THRESHOLD) moved = true
        if (!moved) return
        const proposed = snapKeyframeTime(
          dragRef.current.startTime + deltaXToTimeDelta(deltaPx, pixelsPerSecond),
          clip.duration,
        )
        if (proposed === lastDispatchedTime) return
        const r = dispatchAction(
          {
            type: 'keyframe/update',
            params: {
              clipId: clip.id,
              property: dragRef.current.property,
              time: lastDispatchedTime,
              patch: { time: proposed },
            },
          },
          { source: 'user' },
        )
        // Reducer rejects on KEYFRAME_CONFLICT — leave lastDispatchedTime alone
        // so the next drag sample retries against the same source kf.
        if (r.success) lastDispatchedTime = proposed
      }
      const handleMove = (ev: PointerEvent) => {
        if (!dragRef.current) return
        pendingEv = ev
        if (rafId !== null) return
        rafId = requestAnimationFrame(applyMove)
      }

      const handleUp = (ev: PointerEvent) => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        if (pendingEv) applyMove()
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        window.removeEventListener('pointercancel', handleUp)
        const deltaPx = Math.abs(ev.clientX - (dragRef.current?.startX ?? ev.clientX))
        const wasClick = deltaPx < CLICK_VS_DRAG_THRESHOLD
        dragRef.current = null
        if (wasClick) {
          setEdit({ property: m.property, time: lastDispatchedTime, anchorX: m.leftPx })
        }
      }

      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
      window.addEventListener('pointercancel', handleUp)
    },
    [clip.id, clip.duration, dispatchAction, locked, pixelsPerSecond],
  )

  if (markers.length === 0 && !edit) return null

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
      }}
      data-testid="keyframe-overlay"
    >
      {markers.map((m) => (
        <span
          key={m.key}
          title={`${m.property} @ ${m.time.toFixed(2)}s = ${m.value.toFixed(2)} (${m.easing})`}
          onPointerDown={onPointerDown(m)}
          onContextMenu={onContextMenu(m)}
          data-testid="keyframe-marker"
          data-property={m.property}
          data-time={m.time}
          style={{
            position: 'absolute',
            left: m.leftPx - DIAMOND_SIZE / 2,
            top: height / 2 - DIAMOND_SIZE / 2,
            width: DIAMOND_SIZE,
            height: DIAMOND_SIZE,
            background: colorForKeyframeProperty(m.property),
            transform: 'rotate(45deg)',
            pointerEvents: locked ? 'none' : 'auto',
            cursor: locked ? 'default' : 'grab',
            border: '1px solid rgba(0,0,0,0.4)',
            boxShadow: '0 0 0 0.5px rgba(255,255,255,0.4)',
            touchAction: 'none',
          }}
        />
      ))}
      {edit && <KeyframeEditPopover clip={clip} edit={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

// ── Edit popover ───────────────────────────────────────────────────────────

interface KeyframeEditPopoverProps {
  clip: Clip
  edit: EditState
  onClose: () => void
}

function KeyframeEditPopover({ clip, edit, onClose }: KeyframeEditPopoverProps) {
  const dispatchAction = useVideoStore((s) => s.dispatchAction)
  const kf = useMemo(
    () => clip.keyframes.find((k) => k.property === edit.property && Math.abs(k.time - edit.time) < 1e-6) ?? null,
    [clip.keyframes, edit.property, edit.time],
  )

  // If the kf got removed mid-edit (e.g. via undo), close.
  useEffect(() => {
    if (!kf) onClose()
  }, [kf, onClose])

  if (!kf) return null

  return (
    <div
      data-testid="keyframe-edit-popover"
      // Stop the global dismiss listener — clicks inside the popover should
      // not close it.
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: edit.anchorX + 8,
        top: -52,
        background: '#0b0b0f',
        border: '1px solid #2a2a35',
        borderRadius: 4,
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        zIndex: 50,
        pointerEvents: 'auto',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        fontSize: 11,
      }}
    >
      <div className="flex items-center gap-2">
        <span style={{ color: colorForKeyframeProperty(edit.property) }}>{edit.property}</span>
        <span className="text-neutral-500">@{edit.time.toFixed(2)}s</span>
      </div>
      <label className="flex items-center gap-2">
        <span className="text-neutral-400">Value</span>
        <input
          type="number"
          value={kf.value}
          step={0.05}
          data-testid="keyframe-edit-value"
          onChange={(e) =>
            dispatchAction(
              {
                type: 'keyframe/update',
                params: {
                  clipId: clip.id,
                  property: edit.property,
                  time: edit.time,
                  patch: { value: Number(e.target.value) },
                },
              },
              { source: 'user' },
            )
          }
          style={{
            width: 64,
            padding: '2px 4px',
            background: '#15151a',
            border: '1px solid #2a2a35',
            borderRadius: 3,
            color: '#e5e7eb',
          }}
        />
      </label>
      <EasingCurvePicker
        value={kf.easing}
        onChange={(next) =>
          dispatchAction(
            {
              type: 'keyframe/update',
              params: {
                clipId: clip.id,
                property: edit.property,
                time: edit.time,
                patch: { easing: next },
              },
            },
            { source: 'user' },
          )
        }
      />
      <button
        type="button"
        data-testid="keyframe-edit-close"
        onClick={onClose}
        className="text-[10px] text-neutral-500 hover:text-neutral-200 self-end"
      >
        close
      </button>
    </div>
  )
}
