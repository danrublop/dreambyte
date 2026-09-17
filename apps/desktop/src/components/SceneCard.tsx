'use client'

import { useRef, useState, useCallback } from 'react'
import { MoreVertical, Copy, Trash2, ArrowUp, ArrowDown, Pencil } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import type { Scene } from '@/lib/types'

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  svg: { label: 'SVG', color: '#e84545' },
  canvas2d: { label: 'Canvas', color: '#f97316' },
  motion: { label: 'Motion', color: '#3b82f6' },
  d3: { label: 'D3', color: '#22c55e' },
  three: { label: '3D', color: '#a855f7' },
  lottie: { label: 'Lottie', color: '#f59e0b' },
  zdog: { label: 'Zdog', color: '#14b8a6' },
  html: { label: 'HTML', color: '#6366f1' },
}

interface Props {
  scene: Scene
  index: number
  isSelected: boolean
  isDragging?: boolean
}

export default function SceneCard({ scene, index, isSelected, isDragging }: Props) {
  const { selectScene, deleteScene, duplicateScene, moveScene, scenes, updateScene } = useVideoStore()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [isEditingName, setIsEditingName] = useState(false)
  const [tempName, setTempName] = useState(scene.name)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const closeMenu = useCallback(() => {
    setContextMenu(null)
    setShowDeleteConfirm(false)
  }, [])

  // Enter/Escape blur the input, so the rename commits (or cancels) exactly once, in onBlur.
  const cancelRename = useRef(false)
  const handleRename = () => {
    const name = tempName.trim()
    if (!cancelRename.current && name && name !== scene.name) updateScene(scene.id, { name })
    cancelRename.current = false
    setIsEditingName(false)
  }

  return (
    <>
      <div
        ref={cardRef}
        onClick={() => selectScene(scene.id)}
        onContextMenu={handleContextMenu}
        className={`relative mx-2 mb-3 rounded-xl overflow-hidden cursor-pointer scene-card-container ${isSelected ? 'selected' : ''} ${isDragging ? 'opacity-40' : ''}`}
        style={{ backgroundColor: 'var(--color-bg)' }}
      >
        {/* Thumbnail Area */}
        <div
          className="relative w-full aspect-video overflow-hidden group"
          style={{ backgroundColor: 'var(--color-bg)' }}
        >
          {scene.svgContent && scene.thumbnail ? (
            <img src={scene.thumbnail} alt={`Scene ${index + 1}`} className="w-full h-full object-cover" />
          ) : scene.svgContent ? (
            <div className="w-full h-full" style={{ pointerEvents: 'none', overflow: 'hidden' }}>
              <div
                dangerouslySetInnerHTML={{ __html: scene.svgContent }}
                style={{ transform: 'scale(0.13)', transformOrigin: 'top left', width: '770%', height: '770%' }}
              />
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-white/10 text-[11px] uppercase font-bold tracking-widest">Empty Scene</span>
            </div>
          )}

          {isEditingName && (
            <input
              autoFocus
              aria-label="Scene name"
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelRename.current = true
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              className="absolute top-1.5 left-1.5 right-9 z-20 h-6 rounded-md px-2 text-[11px] font-semibold bg-black/70 text-white border border-white/20 outline-none"
            />
          )}

          {/* More actions button (Left click menu trigger) */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              setContextMenu({ x: e.clientX, y: e.clientY })
            }}
            data-tooltip="More Actions"
            className="absolute top-1.5 right-1.5 w-6 h-6 rounded-md bg-black/40 backdrop-blur-sm border border-white/5 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-all opacity-0 group-hover:opacity-100 no-style"
          >
            <MoreVertical size={11} />
          </button>

          {/* Style override palette indicator */}
          {scene.styleOverride && Object.keys(scene.styleOverride).length > 0 && (
            <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
              {scene.styleOverride.palette &&
                scene.styleOverride.palette.map((c: string, i: number) => (
                  <div key={i} className="w-2.5 h-2.5 rounded-full border border-white/20" style={{ background: c }} />
                ))}
              {scene.styleOverride.styleNote && (
                <div
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[8px]"
                  style={{ background: 'rgba(0,0,0,0.6)', color: '#e0e0e0' }}
                  title={scene.styleOverride.styleNote}
                >
                  🎨
                </div>
              )}
            </div>
          )}

          {/* Floating badges in bottom right */}
          <div className="absolute bottom-2 right-2 flex items-center gap-1.5 z-10">
            {scene.sceneType !== 'svg' && TYPE_BADGE[scene.sceneType ?? 'svg'] != null && (
              <div
                className="rounded-md h-5 px-1.5 flex items-center justify-center"
                style={{ backgroundColor: (TYPE_BADGE[scene.sceneType ?? 'svg'] ?? { color: '#6b7280' }).color }}
              >
                <span className="text-[10px] font-bold text-white leading-none">
                  {(TYPE_BADGE[scene.sceneType ?? 'svg'] ?? { label: scene.sceneType }).label}
                </span>
              </div>
            )}
            <div className="rounded-md h-6 px-2.5 flex items-center justify-center bg-black/50 backdrop-blur-md border border-white/5">
              <span className="text-[10.5px] font-extrabold text-white/80 tracking-tight leading-none">
                Scene {index + 1}
              </span>
            </div>
            <div className="rounded-md h-6 px-2.5 flex items-center justify-center bg-black/50 backdrop-blur-md border border-white/5">
              <span className="text-[10.5px] font-extrabold text-white/80 tracking-tight leading-none">
                {scene.duration}s
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={closeMenu} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            {showDeleteConfirm ? (
              <div className="p-1">
                <div className="px-3 py-2 text-[11px] uppercase font-bold text-[#e84545] text-center border-b border-white/5 mb-1 tracking-widest">
                  Are you sure?
                </div>
                <button
                  className="context-menu-item danger font-bold"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteScene(scene.id)
                    closeMenu()
                  }}
                >
                  Confirm Delete
                </button>
                <button
                  className="context-menu-item text-[#6b6b7a]"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowDeleteConfirm(false)
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    setTempName(scene.name)
                    setIsEditingName(true)
                    closeMenu()
                  }}
                >
                  <Pencil size={13} className="opacity-70" /> Rename
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    duplicateScene(scene.id)
                    closeMenu()
                  }}
                >
                  <Copy size={13} /> Duplicate
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    moveScene(scene.id, 'up')
                    closeMenu()
                  }}
                  disabled={index === 0}
                >
                  <ArrowUp size={13} /> Move Up
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    moveScene(scene.id, 'down')
                    closeMenu()
                  }}
                  disabled={index === scenes.length - 1}
                >
                  <ArrowDown size={13} /> Move Down
                </button>
                <div className="border-t border-black/10 dark:border-white/5 my-1" />
                <button
                  className="context-menu-item danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowDeleteConfirm(true)
                  }}
                >
                  <Trash2 size={13} /> Delete
                </button>
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}
