'use client'

import { useState, useRef, useEffect, type ReactNode } from 'react'
import {
  Hand,
  MousePointer2,
  Scissors,
  MoveHorizontal,
  ArrowLeftRight,
  ChevronsLeftRight,
  GitCommitHorizontal,
  Magnet,
  Target,
  Type,
} from 'lucide-react'
import { TOOLBAR_WIDTH } from './constants'
import { useVideoStore } from '@/lib/store'

export type TimelineTool = 'select' | 'razor' | 'slip' | 'slide' | 'ripple' | 'rolling' | 'hand'

// All tools use lucide icons for consistency (design-review decision 4B —
// unicode glyphs are font-stack-dependent and inconsistent in weight).
const ICON_SIZE = 15
const ICON_STROKE = 2

const TOOLS: { id: TimelineTool; label: string; icon: ReactNode; shortcut: string }[] = [
  {
    id: 'select',
    label: 'Selection',
    icon: <MousePointer2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />,
    shortcut: 'V',
  },
  {
    id: 'razor',
    label: 'Razor',
    icon: <Scissors size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />,
    shortcut: 'C',
  },
  {
    id: 'ripple',
    label: 'Ripple Edit',
    icon: <ArrowLeftRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />,
    shortcut: 'B',
  },
  {
    id: 'slip',
    label: 'Slip',
    icon: <MoveHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />,
    shortcut: 'Y',
  },
  {
    id: 'rolling',
    label: 'Rolling Edit',
    icon: <ChevronsLeftRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />,
    shortcut: 'N',
  },
  {
    id: 'slide',
    label: 'Slide',
    icon: <GitCommitHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />,
    shortcut: 'U',
  },
  {
    id: 'hand',
    label: 'Hand',
    icon: <Hand size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />,
    shortcut: 'H',
  },
]

interface Props {
  activeTool: TimelineTool
  onToolChange: (tool: TimelineTool) => void
  height: number
}

export default function TimelineToolbar({ activeTool, onToolChange, height }: Props) {
  // Per-field selectors so this toolbar doesn't re-render on every unrelated
  // store mutation. The previous `const { addTrack, project, isAgentRunning } =
  // useVideoStore()` destructure subscribed to the entire store — the toolbar
  // re-rendered on every chat keystroke / transport tick / scene-name edit.
  const addTrack = useVideoStore((s) => s.addTrack)
  const addTextOverlay = useVideoStore((s) => s.addTextOverlay)
  const openLayerStackProperties = useVideoStore((s) => s.openLayerStackProperties)
  const selectedSceneId = useVideoStore((s) => s.selectedSceneId)
  const isAgentRunning = useVideoStore((s) => s.isAgentRunning)
  const timelineMagnetic = useVideoStore((s) => s.timelineMagnetic)
  const setTimelineMagnetic = useVideoStore((s) => s.setTimelineMagnetic)
  const timelineSnapEnabled = useVideoStore((s) => s.timelineSnapEnabled)
  const setTimelineSnapEnabled = useVideoStore((s) => s.setTimelineSnapEnabled)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showAddMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    // Focus the first menuitem on open so keyboard users can immediately
    // Arrow / Enter to navigate. Without this, focus stayed on the "+"
    // toggle button and required a Tab to reach the menu.
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
    return () => window.removeEventListener('mousedown', handleClick)
  }, [showAddMenu])

  const handleAddTrack = (type: 'video' | 'audio') => {
    // `addTrack(type)` auto-numbers V1/V2/V3… and A1/A2/A3… in the store —
    // both this toolbar and TrackHeader's right-click "Add track" should
    // call it the same way so the two entry points stay consistent.
    addTrack(type)
    setShowAddMenu(false)
  }

  return (
    <div
      className="flex-shrink-0 flex flex-col items-center gap-0.5 overflow-visible py-1"
      style={{
        width: TOOLBAR_WIDTH,
        height,
        position: 'relative',
        background: 'var(--tl-track-bg)',
        borderRight: '1px solid var(--tl-border)',
      }}
    >
      {TOOLS.map((tool) => {
        const isActive = activeTool === tool.id
        const isEditTool = tool.id !== 'select' && tool.id !== 'hand'
        const isDisabled = isAgentRunning && isEditTool
        return (
          <button
            type="button"
            key={tool.id}
            aria-pressed={isActive}
            aria-label={`${tool.label} (${tool.shortcut})`}
            disabled={isDisabled}
            className={`no-style electron-titlebar-icon flex items-center justify-center rounded-md shrink-0 transition-colors select-none disabled:cursor-default disabled:opacity-30 ${
              isActive ? 'electron-titlebar-icon-active' : ''
            }`}
            style={{
              width: TOOLBAR_WIDTH - 6,
              height: TOOLBAR_WIDTH - 8,
              fontSize: 14,
            }}
            title={`${tool.label} (${tool.shortcut})`}
            onClick={() => onToolChange(tool.id)}
          >
            {tool.icon}
          </button>
        )
      })}

      {/* Add Text overlay — creates a text layer on the active scene. Position,
          font, animation, and timing are edited from the layer stack (Text
          overlay properties), same as every other layer. */}
      <button
        type="button"
        aria-label="Add text"
        disabled={isAgentRunning || !selectedSceneId}
        className="no-style electron-titlebar-icon flex items-center justify-center rounded-md shrink-0 transition-colors select-none disabled:cursor-default disabled:opacity-30"
        style={{ width: TOOLBAR_WIDTH - 6, height: TOOLBAR_WIDTH - 8 }}
        title="Add text"
        onClick={() => {
          if (!selectedSceneId) return
          const id = addTextOverlay(selectedSceneId)
          // Open the new text layer's property form in the layer stack so the
          // user can edit content/position/timing immediately.
          openLayerStackProperties(`text:${id}`)
        }}
      >
        <Type size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
      </button>

      <div aria-hidden className="w-[80%] h-[1px] my-1" style={{ background: 'var(--tl-border)' }} />

      {/* Snap toggle */}
      <button
        type="button"
        aria-pressed={timelineSnapEnabled}
        aria-label={`Snap (currently ${timelineSnapEnabled ? 'on' : 'off'})`}
        className={`no-style electron-titlebar-icon flex items-center justify-center rounded-md shrink-0 transition-colors select-none ${
          timelineSnapEnabled ? 'electron-titlebar-icon-active' : ''
        }`}
        style={{
          width: TOOLBAR_WIDTH - 6,
          height: TOOLBAR_WIDTH - 8,
        }}
        title={`Snap: ${timelineSnapEnabled ? 'on' : 'off'}`}
        onClick={() => setTimelineSnapEnabled(!timelineSnapEnabled)}
      >
        <Target size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
      </button>

      {/* Magnetic timeline toggle */}
      <button
        type="button"
        aria-pressed={timelineMagnetic}
        aria-label={`Magnetic timeline (currently ${timelineMagnetic ? 'on, Delete ripples' : 'off, Delete leaves a gap'})`}
        className={`no-style electron-titlebar-icon flex items-center justify-center rounded-md shrink-0 transition-colors select-none ${
          timelineMagnetic ? 'electron-titlebar-icon-active' : ''
        }`}
        style={{
          width: TOOLBAR_WIDTH - 6,
          height: TOOLBAR_WIDTH - 8,
        }}
        title={`Magnetic timeline: ${timelineMagnetic ? 'on (Delete ripples)' : 'off (Delete leaves a gap)'}`}
        onClick={() => setTimelineMagnetic(!timelineMagnetic)}
      >
        <Magnet size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
      </button>

      {/* Add Track Button */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={showAddMenu}
        aria-label="Add Track"
        disabled={isAgentRunning}
        className={`no-style electron-titlebar-icon flex items-center justify-center rounded-md shrink-0 transition-colors select-none disabled:cursor-default disabled:opacity-30 ${
          showAddMenu ? 'electron-titlebar-icon-active' : ''
        }`}
        style={{
          width: TOOLBAR_WIDTH - 6,
          height: TOOLBAR_WIDTH - 8,
          fontSize: 16,
        }}
        title="Add Track"
        onClick={() => setShowAddMenu(!showAddMenu)}
      >
        +
      </button>

      {showAddMenu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Add new track"
          className="absolute left-[calc(100%+4px)] top-0 z-[100] rounded shadow-2xl py-1 transform translate-y-10"
          style={{ minWidth: 140, background: 'var(--tl-header-bg)', border: '1px solid var(--tl-border)' }}
        >
          <div
            className="px-3 py-2 text-xs font-bold mb-1"
            style={{ color: 'var(--tl-toolbar-text)', borderBottom: '1px solid var(--tl-border)' }}
          >
            Add New Track
          </div>
          <button
            type="button"
            role="menuitem"
            className="no-style w-full px-3 py-1.5 text-sm cursor-pointer hover:bg-white/10 flex items-center justify-between"
            style={{ color: 'var(--color-text-primary)' }}
            onClick={() => handleAddTrack('video')}
          >
            <span>Video Track</span>
            <span className="text-[10px] opacity-50" style={{ color: 'var(--tl-toolbar-text)' }}>
              V
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="no-style w-full px-3 py-1.5 text-sm cursor-pointer hover:bg-white/10 flex items-center justify-between"
            style={{ color: 'var(--color-text-primary)' }}
            onClick={() => handleAddTrack('audio')}
          >
            <span>Audio Track</span>
            <span className="text-[10px] opacity-50" style={{ color: 'var(--tl-toolbar-text)' }}>
              A
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
