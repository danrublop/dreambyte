'use client'

import { useState, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import type { ChatMessage } from '@/lib/agents/types'
import { messageContentToText } from '@/lib/agents/types'

/**
 * User chat bubble with an inline edit affordance. Display is passed
 * in as `children` so the existing rich rendering (text + image attachments)
 * stays in AgentChat; this wrapper only adds the hover pencil + edit textarea
 * and calls `onEdit(msgId, newText)` — which the parent gates behind the rewind
 * confirm dialog. Edit is disabled while the agent is generating.
 */
export function EditableUserMessage({
  msg,
  disabled,
  onEdit,
  children,
}: {
  msg: ChatMessage
  disabled?: boolean
  onEdit: (msgId: string, newText: string) => void
  children: ReactNode
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState('')
  const text = messageContentToText(msg.content)
  // Block-preserving edit: editing a multipart message keeps its image
  // blocks — editUserMessage swaps only the text (buildEditedContent) and the
  // rerun carries the images. The textarea edits the text portion; attachments
  // are shown by `children` and survive untouched.
  const hasAttachments = typeof msg.content !== 'string' && msg.content.some((b) => b.type === 'image')
  const canEdit = !disabled

  const commit = () => {
    const trimmed = value.trim()
    setIsEditing(false)
    if (trimmed && trimmed !== text) onEdit(msg.id, trimmed)
  }

  if (isEditing) {
    return (
      <div className="flex w-full justify-center">
        <div className="w-full overflow-hidden rounded-lg border border-[var(--color-accent)]/50 bg-[var(--agent-chat-user-surface)]">
          <textarea
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="min-h-[60px] w-full resize-none bg-transparent px-3.5 py-2.5 text-sm leading-relaxed text-[var(--color-text-primary)] focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                commit()
              }
              if (e.key === 'Escape') setIsEditing(false)
            }}
          />
          <div className="flex items-center gap-2 px-3 pb-2">
            {hasAttachments && <span className="text-[11px] text-[var(--color-text-muted)]">Attachments are kept</span>}
            <button
              onClick={commit}
              className="rounded bg-[var(--color-accent)] px-2.5 py-1 text-[12px] text-[var(--accent-contrast)] transition-opacity hover:opacity-90"
            >
              Send
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="rounded px-2.5 py-1 text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex w-full justify-center">
      <div
        className="relative w-full rounded-lg px-3.5 py-2.5 text-sm leading-relaxed text-[var(--color-text-primary)]"
        style={{ backgroundColor: 'var(--agent-chat-user-surface)' }}
      >
        {canEdit ? (
          <button
            onClick={() => {
              setValue(text)
              setIsEditing(true)
            }}
            aria-label="Edit message"
            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--color-border)]/30 group-hover:opacity-100"
          >
            <Pencil size={11} className="text-[var(--color-text-muted)]" />
          </button>
        ) : null}
        {children}
      </div>
    </div>
  )
}
