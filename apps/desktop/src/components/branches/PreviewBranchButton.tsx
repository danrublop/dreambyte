'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SquarePlay, GitBranch, Check } from 'lucide-react'
import type { BranchRecord } from '@/types/dreambyte-api'

interface Props {
  branches: BranchRecord[]
  openTabIds: string[]
  activeTabId: string | null
  onSelectBranch: (branchId: string) => void
  onOpenDefault: () => void
  isElectron?: boolean
  /** Override the trigger button's classes (e.g. to match the shell header
   *  icon buttons). When unset, falls back to the legacy titlebar styling. */
  className?: string
}

export default function PreviewBranchButton({
  branches,
  openTabIds,
  activeTabId,
  onSelectBranch,
  onOpenDefault,
  isElectron,
  className,
}: Props) {
  const [open, setOpen] = useState(false)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setDropdownPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
  }, [open])

  function handleDocumentMouseDown(e: MouseEvent) {
    if (btnRef.current && !btnRef.current.closest('[data-preview-branch-root]')?.contains(e.target as Node)) {
      setOpen(false)
    }
  }

  function handleClick() {
    if (branches.length <= 1) {
      onOpenDefault()
      return
    }
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    document.addEventListener('mousedown', handleDocumentMouseDown, { once: true })
  }

  function selectBranch(branchId: string) {
    onSelectBranch(branchId)
    setOpen(false)
  }

  const dropdown =
    open && branches.length > 1 ? (
      <div
        style={{
          position: 'fixed',
          top: dropdownPos.top,
          right: dropdownPos.right,
          zIndex: 9999,
          minWidth: 200,
          background: 'var(--color-panel)',
          border: '1px solid var(--color-border)',
        }}
        className="rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-top-1 duration-150"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ padding: 4 }}>
          {branches.map((b) => {
            const tabId = b.isDefault ? 'preview' : `preview:${b.id}`
            const isOpen = openTabIds.includes(tabId)
            const isActive = activeTabId === tabId
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => selectBranch(b.id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
                className="w-full !flex !flex-row items-center no-style cursor-pointer text-left"
                style={{
                  gap: 8,
                  padding: '5px 8px',
                  borderRadius: 6,
                  transition: 'background 0.12s ease',
                  background: 'transparent',
                }}
              >
                <GitBranch size={13} strokeWidth={2} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12.5,
                    fontWeight: 450,
                    lineHeight: 1,
                    color: 'var(--color-text-primary)',
                  }}
                >
                  {b.name}
                </span>
                {b.isDefault && (
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 12.5,
                      lineHeight: 1,
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    default
                  </span>
                )}
                {isActive && (
                  <Check size={13} strokeWidth={2.5} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
                )}
                {isOpen && !isActive && (
                  <span
                    style={{
                      flexShrink: 0,
                      height: 6,
                      width: 6,
                      borderRadius: 9999,
                      background: 'var(--color-text-muted)',
                    }}
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>
    ) : null

  return (
    <div data-preview-branch-root>
      <button
        ref={btnRef}
        type="button"
        onClick={handleClick}
        className={
          className ??
          `${isElectron ? 'no-style electron-titlebar-icon' : 'kbd'} w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors`
        }
        data-tooltip={branches.length > 1 ? 'Preview branch' : 'Preview'}
        data-tooltip-pos="bottom"
        style={isElectron ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
      >
        <SquarePlay size={18} strokeWidth={1.5} />
      </button>
      {typeof document !== 'undefined' && dropdown ? createPortal(dropdown, document.body) : null}
    </div>
  )
}
