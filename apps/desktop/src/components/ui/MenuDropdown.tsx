'use client'

import { Check } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * Shared dropdown-menu surface + rows.
 *
 * This is the "model picker" style used in the agent chat (see AgentChat model
 * and agent selectors): a soft panel with subtle 450-weight rows, an 8% hover
 * tint, muted descriptors, and `rounded-lg` corners. Reuse it for any compact
 * picker/filter menu so they stay visually consistent.
 */
export function MenuSurface({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={`rounded-lg shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-150 ${className}`}
      style={{
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** A padded section of rows. Pass `divider` to draw a separator above it, and
 *  `label` for an optional small uppercase section heading. */
export function MenuGroup({
  children,
  divider = false,
  label,
}: {
  children: ReactNode
  divider?: boolean
  label?: string
}) {
  return (
    <div style={{ padding: 4, borderTop: divider ? '1px solid var(--color-border)' : undefined }}>
      {label && (
        <div
          style={{
            padding: '4px 8px 4px',
            fontSize: 11,
            fontWeight: 450,
            lineHeight: 1,
            color: 'var(--color-text-muted)',
          }}
        >
          {label}
        </div>
      )}
      {children}
    </div>
  )
}

/** A single selectable row: bold-ish name, optional muted inline descriptor,
 *  and a check on the right when selected. */
export function MenuRow({
  name,
  desc,
  hint,
  icon,
  selected,
  muted,
  destructive,
  disabled,
  onClick,
}: {
  name: string
  desc?: string
  /** Right-aligned secondary text, e.g. a keyboard shortcut. */
  hint?: string
  /** Optional leading icon, rendered muted before the name. */
  icon?: ReactNode
  selected?: boolean
  muted?: boolean
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      onMouseEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
      className="w-full !flex !flex-row items-center no-style text-left disabled:cursor-not-allowed"
      style={{
        gap: 8,
        padding: '5px 8px',
        borderRadius: 6,
        transition: 'background 0.12s ease',
        background: 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon && <span style={{ display: 'flex', flexShrink: 0, color: 'var(--color-text-muted)' }}>{icon}</span>}
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 450,
          lineHeight: 1,
          color: destructive ? 'var(--danger)' : muted ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
        }}
      >
        {name}
      </span>
      {desc && <span style={{ fontSize: 12.5, lineHeight: 1, color: 'var(--color-text-muted)' }}>{desc}</span>}
      <span style={{ flex: 1 }} />
      {hint && <span style={{ fontSize: 11, lineHeight: 1, color: 'var(--color-text-muted)' }}>{hint}</span>}
      {selected && <Check size={13} strokeWidth={2.5} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />}
    </button>
  )
}
