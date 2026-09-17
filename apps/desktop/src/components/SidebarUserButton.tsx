'use client'

import { Settings } from 'lucide-react'
import { useVideoStore } from '@/lib/store'

/**
 * Account row pinned at the bottom of every sidebar (home, chat, editor, and
 * the settings sidebar). One shared component so opening Settings never changes
 * how it looks. `onClick` is what the gear does in context — open Settings from
 * the normal sidebar, close it from the settings sidebar.
 */
export default function SidebarUserButton({ onClick }: { onClick?: () => void }) {
  const currentUser = useVideoStore((s) => s.currentUser)
  const displayName = currentUser?.name ?? currentUser?.email ?? 'Guest'
  const initial = (currentUser?.name ?? currentUser?.email ?? 'G').charAt(0).toUpperCase()

  return (
    <button
      onClick={onClick}
      className="no-style mt-1.5 flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] !px-3 py-2 text-left hover:bg-[var(--card)]"
    >
      <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-full bg-[var(--card)] text-[12px] font-semibold text-[var(--ink)]">
        {initial}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ink)]">{displayName}</span>
      <Settings size={15} className="flex-none text-[var(--graphite)]" />
    </button>
  )
}
