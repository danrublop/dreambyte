'use client'

import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { permGenerateBtnClass } from '@/components/GenerationConfirmCard'

export interface ClarificationCardProps {
  clarification: { id: string; question: string; options?: string[] }
  /** True once the user answered and the run resumed — render a quiet resolved state. */
  answered?: boolean
  onAnswer: (answer: string) => void
}

/**
 * Inline ask_user clarify card shown in the chat stream when the run pauses on a
 * clarification. Mirrors the permission card's compact outline/12px style. The user
 * picks an option OR types free-text; submitting resumes the run with the answer.
 * A blank free-text submit is disabled (the handler also re-pauses on blank).
 */
export function ClarificationCard({ clarification, answered, onAnswer }: ClarificationCardProps) {
  const [text, setText] = useState('')
  const options = (clarification.options ?? []).filter((o) => o.trim().length > 0)
  const canSubmit = text.trim().length > 0

  if (answered) {
    return (
      <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent overflow-hidden text-[12px]">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <HelpCircle size={11} className="text-sky-400 flex-shrink-0" strokeWidth={2.25} />
          <span className="text-[var(--color-text-muted)] flex-1 truncate">{clarification.question}</span>
          <span className="text-[11px] font-medium text-emerald-400">Answered</span>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent overflow-hidden text-[12px]">
      <div className="px-2.5 py-2">
        <div className="flex items-center gap-2">
          <HelpCircle size={12} className="text-sky-400 flex-shrink-0" strokeWidth={2.25} />
          <span className="text-[var(--color-text-primary)] flex-1">
            <span className="font-medium">Quick question</span>
            <span className="text-[var(--color-text-muted)]"> · answer to continue</span>
          </span>
        </div>
        <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-text-primary)]">{clarification.question}</p>

        {options.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => onAnswer(opt)}
                className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-colors"
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) onAnswer(text.trim())
          }}
        >
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={options.length > 0 ? 'or type an answer…' : 'type your answer…'}
            className="flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-[11px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-sky-400/60"
          />
          <button
            type="submit"
            disabled={!canSubmit}
            className={permGenerateBtnClass}
            style={canSubmit ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
