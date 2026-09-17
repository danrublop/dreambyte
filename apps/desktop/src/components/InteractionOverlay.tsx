'use client'

import { useCallback, useRef, useState } from 'react'
import { useVideoStore } from '@/lib/store'
import type { Scene, InteractionElement } from '@/lib/types'
import { DEFAULT_INTERACTION_STYLE } from '@/lib/types'
import { cssBorderRadiusForTooltipTrigger } from '@/lib/interactions/tooltip-trigger-css'
import { snapToGrid } from '@/lib/grid'
import { resolveProjectDimensions } from '@/lib/dimensions'
import { InteractionRenderer, InteractionStyles } from '@/components/interactions/InteractionRenderer'
import type { InteractionCallbacks } from '@/components/interactions/InteractionRenderer'

interface InteractionOverlayProps {
  scene: Scene
  mode: 'edit' | 'preview'
  currentTime: number
  onElementClick?: (elementId: string) => void
  onElementMove?: (elementId: string, x: number, y: number) => void
  /** Preview mode callbacks */
  interactionCallbacks?: InteractionCallbacks
}

const TYPE_COLORS: Record<string, string> = {
  hotspot: '#f59e0b',
  choice: '#3b82f6',
  quiz: '#8b5cf6',
  gate: '#10b981',
  tooltip: '#06b6d4',
  form: '#ec4899',
  slider: '#f97316',
  toggle: '#14b8a6',
  reveal: '#a855f7',
  countdown: '#ef4444',
}

const TYPE_LABELS: Record<string, string> = {
  hotspot: 'Hotspot',
  choice: 'Choice',
  quiz: 'Quiz',
  gate: 'Gate',
  tooltip: 'Tooltip',
  form: 'Form',
  slider: 'Slider',
  toggle: 'Toggle',
  reveal: 'Reveal',
  countdown: 'Countdown',
}

interface DragState {
  elementId: string
  startX: number
  startY: number
  origX: number
  origY: number
  containerRect: DOMRect
}

export default function InteractionOverlay({
  scene,
  mode,
  currentTime,
  onElementClick,
  onElementMove,
  interactionCallbacks,
}: InteractionOverlayProps) {
  const { updateInteraction, gridConfig, project } = useVideoStore()
  const { width: sceneW, height: sceneH } = resolveProjectDimensions(
    project.mp4Settings?.aspectRatio,
    project.mp4Settings?.resolution,
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  // Track which interactions have appeared for entrance animations
  const appearedRef = useRef<Set<string>>(new Set())

  const hiddenIx = new Set(scene.layerHiddenIds ?? [])
  const interactions: InteractionElement[] = (scene.interactions ?? []).filter(
    (el) => !hiddenIx.has(`interaction:${el.id}`),
  )

  const isVisible = (el: InteractionElement) => {
    if (mode === 'edit') return true
    if (currentTime < el.appearsAt) return false
    if (el.hidesAt !== null && currentTime >= el.hidesAt) return false
    return true
  }

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, el: InteractionElement) => {
      if (mode !== 'edit') return
      e.stopPropagation()
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      dragRef.current = {
        elementId: el.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: el.x,
        origY: el.y,
        containerRect: rect,
      }
      setSelectedId(el.id)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [mode],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ((e.clientX - d.startX) / d.containerRect.width) * 100
      const dy = ((e.clientY - d.startY) / d.containerRect.height) * 100
      let newX = Math.max(0, Math.min(100, d.origX + dx))
      let newY = Math.max(0, Math.min(100, d.origY + dy))
      if (gridConfig.enabled && !e.shiftKey) {
        const pxX = (newX / 100) * sceneW
        const pxY = (newY / 100) * sceneH
        const snappedX = snapToGrid(pxX, gridConfig.size, gridConfig.snapThreshold)
        const snappedY = snapToGrid(pxY, gridConfig.size, gridConfig.snapThreshold)
        newX = (snappedX / sceneW) * 100
        newY = (snappedY / sceneH) * 100
      }
      updateInteraction(scene.id, d.elementId, { x: newX, y: newY } as any)
      onElementMove?.(d.elementId, newX, newY)
    },
    [scene.id, updateInteraction, onElementMove, gridConfig],
  )

  const handlePointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const visibleInteractions = interactions.filter(isVisible)

  // ── Preview mode: render real interactive UI ──
  if (mode === 'preview' && interactionCallbacks) {
    return (
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
        <InteractionStyles />
        {visibleInteractions.map((el) => {
          const firstAppearance = !appearedRef.current.has(el.id)
          if (firstAppearance) appearedRef.current.add(el.id)
          return (
            <InteractionRenderer
              key={el.id}
              element={el}
              callbacks={interactionCallbacks}
              firstAppearance={firstAppearance}
            />
          )
        })}
      </div>
    )
  }

  // ── Edit mode: render bounding boxes with drag handles ──
  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 20 }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {visibleInteractions.map((el) => {
        const color = TYPE_COLORS[el.type] ?? '#e84545'
        const isSelected = selectedId === el.id

        return (
          <div
            key={el.id}
            style={{
              position: 'absolute',
              left: `${el.x}%`,
              top: `${el.y}%`,
              width: `${el.width}%`,
              height: `${el.height}%`,
              border: `2px solid ${color}`,
              borderRadius:
                el.type === 'hotspot'
                  ? (el as any).shape === 'circle'
                    ? '50%'
                    : (el as any).shape === 'pill'
                      ? '999px'
                      : '6px'
                  : el.type === 'tooltip'
                    ? cssBorderRadiusForTooltipTrigger(
                        (el as InteractionElement & { type: 'tooltip' }).triggerShape,
                        (el as InteractionElement & { type: 'tooltip' }).visualStyle?.borderRadius ??
                          DEFAULT_INTERACTION_STYLE.borderRadius,
                      )
                    : '6px',
              background: `${color}22`,
              cursor: 'move',
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              boxShadow: isSelected ? `0 0 0 2px white, 0 0 0 4px ${color}` : undefined,
              animation:
                el.type === 'hotspot' && (el as any).style === 'pulse' ? 'dreambyte-pulse 2s infinite' : undefined,
            }}
            onPointerDown={(e) => handlePointerDown(e, el)}
            onClick={() => {
              onElementClick?.(el.id)
              setSelectedId(el.id)
            }}
          >
            {/* Type badge */}
            <div
              style={{
                position: 'absolute',
                top: -18,
                left: 0,
                background: color,
                color: 'white',
                fontSize: 9,
                fontWeight: 700,
                padding: '1px 5px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
              }}
            >
              {TYPE_LABELS[el.type] ?? el.type}
            </div>

            {/* Label for hotspot */}
            {el.type === 'hotspot' && (el as any).label && (
              <span style={{ color: 'white', fontSize: 11, fontWeight: 600 }}>{(el as any).label}</span>
            )}

            {/* Resize handles (selected) */}
            {isSelected && (
              <>
                {['nw', 'ne', 'sw', 'se'].map((corner) => (
                  <div
                    key={corner}
                    style={{
                      position: 'absolute',
                      width: 8,
                      height: 8,
                      background: 'white',
                      border: `2px solid ${color}`,
                      borderRadius: 2,
                      ...(corner.includes('n') ? { top: -4 } : { bottom: -4 }),
                      ...(corner.includes('w') ? { left: -4 } : { right: -4 }),
                      cursor: `${corner}-resize`,
                    }}
                  />
                ))}
              </>
            )}
          </div>
        )
      })}

      <style>{`
        @keyframes dreambyte-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.05); }
        }
      `}</style>
    </div>
  )
}
