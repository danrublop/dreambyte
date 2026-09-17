'use client'

import { useState, useRef, useEffect } from 'react'
import { RefreshCw, ThumbsUp, ThumbsDown, MoreHorizontal, X } from 'lucide-react'
import type { ChatMessage } from '@/lib/agents/types'
import { messageContentToText } from '@/lib/agents/types'
import { useVideoStore } from '@/lib/store'
import { copyText } from '@/lib/utils/copy-text'

export function MessageActions({
  msg,
  onRate,
  onDetails,
  onRetry,
  onRegenerate,
  conversationId,
}: {
  msg: ChatMessage
  onRate: (msgId: string, rating: number) => void
  onDetails: (msg: ChatMessage) => void
  onRetry?: (msgId: string) => void
  onRegenerate?: (msgId: string) => void
  conversationId?: string | null
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState<'msg' | 'id' | false>(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  const handleCopy = async () => {
    const ok = await copyText(messageContentToText(msg.content))
    if (!ok) return
    setCopied('msg')
    setTimeout(() => {
      setCopied(false)
      setMenuOpen(false)
    }, 1200)
  }

  const handleCopyConversationId = async () => {
    if (!conversationId) return
    const ok = await copyText(conversationId)
    if (!ok) return
    setCopied('id')
    setTimeout(() => {
      setCopied(false)
      setMenuOpen(false)
    }, 1200)
  }

  const handleDetails = () => {
    setMenuOpen(false)
    onDetails(msg)
  }

  const rating = msg.userRating

  const isDetails = msg.id.startsWith('details:')
  const { removeChatMessage } = useVideoStore()

  if (isDetails) {
    return (
      <div className="flex items-center justify-end px-1 mt-1.5 leading-none">
        <span
          onClick={() => removeChatMessage(msg.id)}
          className="cursor-pointer select-none opacity-50 hover:opacity-100 transition-opacity"
          data-tooltip="Close details"
          data-tooltip-size="sm"
        >
          <X size={12} className="text-[var(--color-text-muted)]" />
        </span>
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center justify-end gap-2.5 px-1 mt-1.5">
      {onRetry && (
        <span
          onClick={() => onRetry(msg.id)}
          className="cursor-pointer select-none"
          data-tooltip="Retry"
          data-tooltip-size="sm"
        >
          <RefreshCw
            size={12}
            strokeWidth={1.5}
            className="text-[var(--color-text-muted)] opacity-50 hover:opacity-100 transition-opacity"
          />
        </span>
      )}
      <span
        onClick={() => onRate(msg.id, rating === 5 ? 0 : 5)}
        className="cursor-pointer select-none"
        data-tooltip="Good response"
        data-tooltip-size="sm"
      >
        <ThumbsUp
          size={12}
          strokeWidth={1.5}
          stroke="currentColor"
          fill={rating === 5 ? 'currentColor' : 'none'}
          className={`text-[var(--color-text-muted)] transition-opacity ${
            rating === 5 ? 'opacity-100' : 'opacity-50 hover:opacity-100'
          }`}
        />
      </span>
      <span
        onClick={() => onRate(msg.id, rating === 1 ? 0 : 1)}
        className="cursor-pointer select-none"
        data-tooltip="Bad response"
        data-tooltip-size="sm"
      >
        <ThumbsDown
          size={12}
          strokeWidth={1.5}
          stroke="currentColor"
          fill={rating === 1 ? 'currentColor' : 'none'}
          className={`text-[var(--color-text-muted)] transition-opacity ${
            rating === 1 ? 'opacity-100' : 'opacity-50 hover:opacity-100'
          }`}
        />
      </span>
      <div className="relative" ref={menuRef}>
        <span
          onClick={() => setMenuOpen((o) => !o)}
          className="cursor-pointer select-none"
          data-tooltip="More"
          data-tooltip-size="sm"
        >
          <MoreHorizontal
            size={12}
            className="text-[var(--color-text-muted)] opacity-50 hover:opacity-100 transition-opacity"
          />
        </span>
        {menuOpen && (
          <div className="absolute top-full right-0 mt-1 px-2 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] shadow-lg z-50 space-y-0.5">
            <span
              onClick={handleCopy}
              className="block cursor-pointer text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors select-none whitespace-nowrap"
            >
              {copied === 'msg' ? 'Copied!' : 'Copy message'}
            </span>
            {conversationId && (
              <span
                onClick={handleCopyConversationId}
                className="block cursor-pointer text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors select-none whitespace-nowrap"
              >
                {copied === 'id' ? 'Copied!' : 'Copy conversation ID'}
              </span>
            )}
            {onRegenerate && (
              <span
                onClick={() => {
                  setMenuOpen(false)
                  onRegenerate(msg.id)
                }}
                className="block cursor-pointer text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors select-none whitespace-nowrap"
              >
                Regenerate
              </span>
            )}
            <span
              onClick={handleDetails}
              className="block cursor-pointer text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors select-none whitespace-nowrap"
            >
              Details
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
