'use client'

import { useEffect } from 'react'
import { ChevronRight, Pin, PinOff, Archive, ArchiveRestore, X, Trash2, Download } from 'lucide-react'
import { useViewportMenuPosition } from '@/components/ui/useViewportMenuPosition'

export interface ConversationContextMenuProps {
  x: number
  y: number
  isPinned?: boolean
  isArchived?: boolean
  onClose: () => void
  onRename: () => void
  onPin: () => void
  onArchive: () => void
  onExport: () => void
  onClear: () => void
  onDelete: () => void
}

export function ConversationContextMenu({
  x,
  y,
  isPinned,
  isArchived,
  onClose,
  onRename,
  onPin,
  onArchive,
  onExport,
  onClear,
  onDelete,
}: ConversationContextMenuProps) {
  const { ref: menuRef, style: menuPosStyle, maxHeight: menuMaxHeight } = useViewportMenuPosition(x, y)

  useEffect(() => {
    const handler = () => onClose()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('click', handler)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', handler)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const items = [
    { label: 'Rename', action: onRename, icon: <ChevronRight size={11} /> },
    {
      label: isPinned ? 'Unpin' : 'Pin',
      action: onPin,
      icon: isPinned ? <PinOff size={11} /> : <Pin size={11} />,
    },
    {
      label: isArchived ? 'Unarchive' : 'Archive',
      action: onArchive,
      icon: isArchived ? <ArchiveRestore size={11} /> : <Archive size={11} />,
    },
    { label: 'Export chat', action: onExport, icon: <Download size={11} /> },
    { label: 'Clear messages', action: onClear, icon: <X size={11} /> },
    { type: 'divider' as const },
    { label: 'Delete', action: onDelete, icon: <Trash2 size={11} />, danger: true },
  ]

  return (
    <div
      ref={menuRef}
      className="fixed z-[1000] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] py-1 min-w-[140px]"
      style={{ ...menuPosStyle, maxHeight: menuMaxHeight, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
    >
      {items.map((item, i) =>
        'type' in item && item.type === 'divider' ? (
          <div key={i} className="h-px bg-[var(--color-border)] my-1" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            onClick={item.action}
            className={`no-style flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] cursor-pointer transition-colors hover:bg-[var(--color-border)]/30 focus-visible:bg-[var(--color-border)]/30 ${
              'danger' in item && item.danger ? 'text-red-400' : 'text-[var(--color-text-muted)]'
            }`}
          >
            {'icon' in item && item.icon}
            {'label' in item && item.label}
          </button>
        ),
      )}
    </div>
  )
}
