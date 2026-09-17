'use client'

import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  Hexagon,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  CheckCircle2,
  XCircle,
  LoaderCircle,
} from 'lucide-react'
import type { AgentPlan, AgentTodo } from '@/lib/agents/types'
import { usePermissionKeyboardShortcuts, permissionModKey } from '@/components/GenerationConfirmCard'

export interface PlanCardProps {
  plan: AgentPlan
  todos: AgentTodo[]
  /** When true, show the Approve & build gate (Plan-first mode). */
  awaitingApproval: boolean
  /** When true, the build run is in flight — collapse the body, show "building N/M". */
  building: boolean
  onApprove?: () => void
  onReject?: () => void
  disabled?: boolean
}

/**
 * The agentic plan surface card. Built entirely from the existing chat
 * component vocabulary — no new design tokens or button styles:
 *  - card + `no-style` quiet buttons + keyboard shortcuts from `GenerationConfirmCard`
 *  - collapse (`aria-expanded`) from `ToolCallItem`
 *  - 12px text, `var(--color-text-*)` theme vars, Lucide icons (not emoji)
 *
 * Anatomy (design-reviewed):
 *   ⬡ Plan · "<title>"                 [Approve & build]   (collapse)
 *   ──────────────────────────────────────────────────────────────
 *   <free-form markdown plan body>      (expanded when presented; collapses after approve)
 *   Todos
 *     ◯ pending  ◐ in-progress  ✓ done  ✗ failed   (icon SHAPE + aria-label; non-color a11y)
 *   building N/M · <current step>       (while building)
 *
 * UI-1: reply-to-revise — the card is read-only; the user revises by replying in
 * chat and the agent re-issues write_plan, updating the card in place. No inline
 * edit affordances.
 */
export function PlanCard({ plan, todos, awaitingApproval, building, onApprove, onReject, disabled }: PlanCardProps) {
  // Body is expanded while presented/awaiting; collapses by default once the
  // build starts (durable record) — but the user's chevron click always wins,
  // so a pinned card can be expanded mid-build to watch todo progress.
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const collapsedByDefault = building && !awaitingApproval
  const showBody = userToggled === null ? !collapsedByDefault : userToggled
  const modKey = permissionModKey()

  // Same Enter/⌘↵ → approve, Esc/⌘. → reject shortcuts as GenerationConfirmCard, only
  // while the approval gate is live.
  usePermissionKeyboardShortcuts(
    () => onReject?.(),
    () => onApprove?.(),
    !!awaitingApproval && !disabled,
  )

  const doneCount = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')

  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent overflow-hidden text-[12px]">
      {/* Header */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Hexagon size={11} className="text-[var(--color-text-muted)] flex-shrink-0" strokeWidth={2.25} />
        <span className="text-[var(--color-text-primary)] flex-1 truncate">
          <span className="font-medium">Plan</span>
          {plan.title && plan.title !== 'Plan' && (
            <span className="text-[var(--color-text-muted)]"> · {plan.title}</span>
          )}
        </span>

        {awaitingApproval && !disabled && (
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onReject}
              title={`Dismiss (Esc or ${modKey}+.)`}
              className="no-style !min-h-0 !h-auto !py-1 !px-2 !rounded-md !text-[11px] !font-medium !text-[var(--color-text-muted)] hover:!text-[var(--color-text-primary)] hover:!bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] transition-colors"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={onApprove}
              title={`Approve & build (Enter or ${modKey}↵)`}
              className="no-style !min-h-0 !h-auto !py-1 !px-2 !rounded-md !text-[11px] !font-medium !border !border-[var(--color-border)] !bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] !text-[var(--color-text-primary)] hover:!bg-[color-mix(in_srgb,var(--color-text-primary)_14%,transparent)] transition-colors"
            >
              Approve &amp; build
            </button>
          </span>
        )}

        {/* Collapse/expand toggle — always live (works mid-build too, so the
            pinned card can be expanded to watch todo progress or minimized to
            its header + build-progress line). */}
        <button
          type="button"
          onClick={() => setUserToggled(!showBody)}
          aria-expanded={showBody}
          aria-label={showBody ? 'Collapse plan' : 'Expand plan'}
          className="no-style !min-h-0 !h-auto !p-0.5 !rounded text-[var(--color-text-muted)] hover:!text-[var(--color-text-primary)] transition-colors flex-shrink-0"
        >
          {showBody ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
      </div>

      {/* Plan body (markdown) */}
      {showBody && plan.body && (
        <div className="px-2.5 pb-2 border-t border-[var(--color-border)] pt-2">
          <div className="text-[12px] text-[var(--color-text-primary)] leading-relaxed prose prose-invert prose-sm max-w-none chat-markdown">
            <ReactMarkdown
              components={{
                p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc list-inside mb-1.5 space-y-0.5">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside mb-1.5 space-y-0.5">{children}</ol>,
                li: ({ children }) => <li className="text-[12px]">{children}</li>,
                strong: ({ children }) => (
                  <strong className="font-semibold text-[var(--color-text-primary)]">{children}</strong>
                ),
                h1: ({ children }) => <h1 className="text-[13px] font-bold mt-2 mb-1">{children}</h1>,
                h2: ({ children }) => <h2 className="text-[12px] font-bold mt-2 mb-1">{children}</h2>,
                h3: ({ children }) => <h3 className="text-[12px] font-semibold mt-1.5 mb-1">{children}</h3>,
                code: ({ children }) => (
                  <code className="bg-[var(--color-border)]/50 px-1 py-0.5 rounded text-[11px] font-mono">
                    {children}
                  </code>
                ),
              }}
            >
              {plan.body}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* Todo checklist — gated on showBody so the chevron truly minimizes the
          pinned card to its header + build-progress line (the compact status
          below stays visible either way). */}
      {showBody && todos.length > 0 && (
        <div className="px-2.5 pb-2 border-t border-[var(--color-border)] pt-2">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1">Todos</div>
          <ul className="space-y-1" aria-live="polite">
            {todos.map((todo) => (
              <TodoRow key={todo.id} todo={todo} />
            ))}
          </ul>
        </div>
      )}

      {/* Build progress — the compact "building N/M · <current step>" indicator. */}
      {building && !awaitingApproval && todos.length > 0 && (
        <div className="px-2.5 py-1.5 border-t border-[var(--color-border)] flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
          <LoaderCircle size={11} className="animate-spin flex-shrink-0" />
          <span className="truncate">
            building {doneCount}/{todos.length}
            {current ? ` · ${current.text}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

/** One checklist row. State is conveyed by icon SHAPE + aria-label (non-color a11y),
 *  with color as a secondary cue. */
function TodoRow({ todo }: { todo: AgentTodo }) {
  const { icon, className, label, textClass } = TODO_STATE[todo.status]
  return (
    <li className="flex items-start gap-2">
      <span className={`flex-shrink-0 mt-0.5 ${className}`} role="img" aria-label={label}>
        {icon}
      </span>
      <span className={`flex-1 leading-snug ${textClass}`}>{todo.text}</span>
    </li>
  )
}

const TODO_STATE: Record<
  AgentTodo['status'],
  { icon: ReactNode; className: string; label: string; textClass: string }
> = {
  pending: {
    icon: <Circle size={12} />,
    className: 'text-[var(--color-text-muted)]',
    label: 'pending',
    textClass: 'text-[var(--color-text-muted)]',
  },
  in_progress: {
    icon: <CircleDashed size={12} className="animate-spin" style={{ animationDuration: '3s' }} />,
    className: 'text-[var(--color-text-primary)]',
    label: 'in progress',
    textClass: 'text-[var(--color-text-primary)]',
  },
  completed: {
    icon: <CheckCircle2 size={12} />,
    className: 'text-emerald-400',
    label: 'done',
    textClass: 'text-[var(--color-text-muted)] line-through decoration-[var(--color-text-muted)]/40',
  },
  failed: {
    icon: <XCircle size={12} />,
    className: 'text-red-400',
    label: 'failed',
    textClass: 'text-[var(--color-text-primary)]',
  },
}
