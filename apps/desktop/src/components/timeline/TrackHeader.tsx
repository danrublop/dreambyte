'use client'

import { useCallback, useEffect, useState, useRef } from 'react'
import { useVideoStore } from '@/lib/store'
import type { Track } from '@/lib/types'
import { TRACK_HEADER_WIDTH } from './constants'
import { Lock, Eye, EyeOff, Mic } from 'lucide-react'

interface Props {
  track: Track
  height: number
}

export default function TrackHeader({ track, height }: Props) {
  // Per-field selectors so TrackHeader doesn't re-render on every store tick.
  const updateTrack = useVideoStore((s) => s.updateTrack)
  const removeTrack = useVideoStore((s) => s.removeTrack)
  const addTrack = useVideoStore((s) => s.addTrack)
  const isAgentRunning = useVideoStore((s) => s.isAgentRunning)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(track.name)
  const [showMenu, setShowMenu] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close the context menu on outside-click. The previous implementation
  // closed only on `onMouseLeave`, so a user who right-clicked without ever
  // hovering the menu would be stuck with it open until next mouse-leave.
  useEffect(() => {
    if (!showMenu) return
    const onDocPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    window.addEventListener('mousedown', onDocPointerDown)
    // Focus the first menuitem so keyboard users can immediately operate
    // the menu after right-click without an extra Tab to reach it.
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
    return () => window.removeEventListener('mousedown', onDocPointerDown)
  }, [showMenu])

  const handleDoubleClick = useCallback(() => {
    setEditName(track.name)
    setIsEditing(true)
    // Focus + select-all happens in the useEffect below — React 18 batching
    // makes `setTimeout(0)` race against the actual DOM commit, so the old
    // setTimeout-from-here pattern occasionally selected before the input
    // was mounted. The effect runs strictly after the commit.
  }, [track.name])

  // Select-all the rename text once the input is in the DOM. Native
  // `autoFocus` handles the focus call; we just need `.select()`.
  useEffect(() => {
    if (!isEditing) return
    inputRef.current?.select()
  }, [isEditing])

  const commitName = useCallback(() => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== track.name) {
      updateTrack(track.id, { name: trimmed })
    }
    setIsEditing(false)
  }, [editName, track.id, track.name, updateTrack])

  const isAudio = track.type === 'audio'

  return (
    <div
      className="relative flex items-center select-none"
      style={{
        width: TRACK_HEADER_WIDTH,
        height,
        minHeight: height,
        background: 'var(--tl-header-bg)',
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!isAgentRunning) setShowMenu(!showMenu)
      }}
    >
      {/* Track label */}
      <span
        className="flex-shrink-0 font-bold ml-2"
        style={{
          fontSize: 12,
          color: 'var(--color-text-primary)',
        }}
        onDoubleClick={() => !isAgentRunning && handleDoubleClick()}
      >
        {track.name}
      </span>

      {/* Controls — each control is a real <button> with aria-pressed so
          keyboard users can Tab + Space to toggle and screen readers
          announce state. The wrapping div is just a layout container. */}
      <div
        className="flex items-center gap-0 ml-1.5 flex-shrink-0"
        style={{ opacity: isAgentRunning ? 0.4 : 1, pointerEvents: isAgentRunning ? 'none' : 'auto' }}
      >
        {/* Lock */}
        <button
          type="button"
          aria-pressed={track.locked}
          aria-label={track.locked ? 'Unlock track' : 'Lock track'}
          className="no-style cursor-pointer w-5 h-5 flex items-center justify-center rounded hover:bg-white/10"
          style={{
            color: track.locked ? 'var(--tl-ruler-bar)' : 'var(--tl-ctrl-dim)',
          }}
          onClick={() => updateTrack(track.id, { locked: !track.locked })}
          title={track.locked ? 'Unlock' : 'Lock'}
        >
          <Lock size={11} aria-hidden />
        </button>

        {/* Source patch indicator — decorative, not interactive. */}
        <span
          aria-hidden
          className="w-5 h-5 flex items-center justify-center"
          style={{ fontSize: 9, color: 'var(--tl-ctrl-dim)' }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <line x1="5" y1="8" x2="11" y2="8" />
          </svg>
        </span>

        {isAudio ? (
          <>
            {/* Mute */}
            <button
              type="button"
              aria-pressed={!!track.muted}
              aria-label={track.muted ? 'Unmute track' : 'Mute track'}
              className="no-style cursor-pointer w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 font-bold"
              style={{
                fontSize: 10,
                color: track.muted ? '#ef4444' : 'var(--tl-toolbar-text)',
              }}
              onClick={() => updateTrack(track.id, { muted: !track.muted })}
              title={track.muted ? 'Unmute' : 'Mute'}
            >
              M
            </button>
            {/* Solo */}
            <button
              type="button"
              aria-pressed={!!track.solo}
              aria-label={track.solo ? 'Unsolo track' : 'Solo track'}
              className="no-style cursor-pointer w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 font-bold"
              style={{
                fontSize: 10,
                color: track.solo ? '#f59e0b' : 'var(--tl-toolbar-text)',
              }}
              onClick={() => updateTrack(track.id, { solo: !track.solo })}
              title={track.solo ? 'Unsolo' : 'Solo'}
            >
              S
            </button>
            {/* Mic — decorative placeholder until input-monitoring lands. */}
            <span
              aria-hidden
              className="w-5 h-5 flex items-center justify-center"
              style={{ color: 'var(--tl-ctrl-dim)' }}
            >
              <Mic size={11} />
            </span>
          </>
        ) : (
          <>
            {/* Visibility — toggles render visibility (track.hidden), NOT mute.
                The mute control is the speaker/M button; this eye must drive
                `hidden` so hiding a track doesn't silently mute it instead. */}
            <button
              type="button"
              aria-pressed={!!track.hidden}
              aria-label={track.hidden ? 'Show track' : 'Hide track'}
              className="no-style cursor-pointer w-5 h-5 flex items-center justify-center rounded hover:bg-white/10"
              style={{
                color: track.hidden ? 'var(--accent)' : 'var(--tl-toolbar-text)',
              }}
              onClick={() => updateTrack(track.id, { hidden: !track.hidden })}
              title={track.hidden ? 'Show' : 'Hide'}
            >
              {track.hidden ? <EyeOff size={11} aria-hidden /> : <Eye size={11} aria-hidden />}
            </button>
          </>
        )}
      </div>

      {/* Editable name (double-click) */}
      {isEditing && (
        <input
          ref={inputRef}
          autoFocus
          className="absolute inset-0 outline-none px-2 z-10"
          style={{
            fontSize: 11,
            background: 'var(--tl-bg)',
            border: '1px solid var(--tl-playhead)',
            color: 'var(--color-text-primary)',
          }}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName()
            if (e.key === 'Escape') setIsEditing(false)
          }}
        />
      )}

      {/* Context menu */}
      {showMenu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Track actions"
          className="absolute left-full top-0 z-50 rounded shadow-lg py-1"
          style={{ minWidth: 140, background: 'var(--tl-header-bg)', border: '1px solid var(--tl-border)' }}
        >
          <button
            type="button"
            role="menuitem"
            className="no-style w-full text-left px-3 py-1 text-sm cursor-pointer hover:bg-white/10"
            style={{ color: 'var(--color-text-primary)' }}
            onClick={() => {
              // Pass only the type so the store auto-numbers (V1/V2/V3…
              // / A1/A2/A3…) — the previous code passed the literal 'A' or
              // 'V', which defeated auto-numbering and created tracks named
              // just "A" or "V" no matter how many already existed.
              addTrack(track.type)
              setShowMenu(false)
            }}
          >
            Add {track.type} track
          </button>
          <button
            type="button"
            role="menuitem"
            className="no-style w-full text-left px-3 py-1 text-sm cursor-pointer hover:bg-white/10 text-red-400"
            onClick={() => {
              removeTrack(track.id)
              setShowMenu(false)
            }}
          >
            Delete track
          </button>
        </div>
      )}
    </div>
  )
}
