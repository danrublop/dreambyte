'use client'

import { useState, type ReactNode } from 'react'
import { ChevronDown, Link as LinkIcon, Link2Off } from 'lucide-react'

// compact property-panel primitives used by both the master-detail
// layer-stack editor and individual layer forms (avatar, chart, etc).

export function Diamond({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden className="shrink-0">
      <path d="M5 1 L9 5 L5 9 L1 5 Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-[var(--color-border)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between border-0 bg-transparent px-5 py-3 text-left"
      >
        <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{title}</span>
        <ChevronDown
          size={13}
          className={`text-[var(--color-text-muted)] transition-transform ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open && <div className="space-y-3.5 px-5 pb-4">{children}</div>}
    </section>
  )
}

export function FieldLabel({ children, keyframable = false }: { children: ReactNode; keyframable?: boolean }) {
  return (
    <div className="mb-1 flex items-center gap-1.5">
      {keyframable && (
        <span className="text-[var(--color-text-muted)]">
          <Diamond />
        </span>
      )}
      <span className="text-[11px] text-[var(--color-text-muted)]">{children}</span>
    </div>
  )
}

/**
 * Horizontal label-on-left row used in typography/avatar property panels.
 * Layout: fixed 64px label column, control fills the rest.
 */
export function HRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_1fr] items-center gap-3">
      <span className="text-[11px] text-[var(--color-text-muted)]">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function NumberCell({
  prefix,
  prefixIcon,
  value,
  onChange,
  onCommit,
  step = 1,
  min,
  max,
  suffix,
}: {
  prefix?: string
  prefixIcon?: ReactNode
  value: number
  onChange: (v: number) => void
  onCommit?: () => void
  step?: number
  min?: number
  max?: number
  suffix?: string
}) {
  return (
    <div className="flex h-9 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-accent)]">
      {prefixIcon ? (
        <span className="pl-2.5 pr-1 text-[var(--color-text-muted)]">{prefixIcon}</span>
      ) : prefix ? (
        <span className="select-none pl-2.5 pr-1 text-[11px] font-medium text-[var(--color-text-muted)]">{prefix}</span>
      ) : null}
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        onBlur={onCommit}
        step={step}
        min={min}
        max={max}
        className="min-w-0 flex-1 bg-transparent px-1 py-0 text-[12px] tabular-nums text-[var(--color-text-primary)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {suffix && <span className="select-none pr-2.5 text-[11px] text-[var(--color-text-muted)]">{suffix}</span>}
    </div>
  )
}

export function TextCell({
  value,
  onChange,
  onCommit,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onCommit?: () => void
  placeholder?: string
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      placeholder={placeholder}
      className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
    />
  )
}

export function ColorCell({
  value,
  onChange,
  onCommit,
}: {
  value: string
  onChange: (v: string) => void
  onCommit?: () => void
}) {
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 focus-within:border-[var(--color-accent)]">
      <input
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ffffff'}
        onChange={(e) => {
          onChange(e.target.value)
          onCommit?.()
        }}
        className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0 [appearance:none] [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[var(--color-text-primary)] outline-none"
      />
    </div>
  )
}

export function SelectCell<T extends string>({
  value,
  options,
  onChange,
  prefixIcon,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  prefixIcon?: ReactNode
}) {
  return (
    <div className="flex h-9 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-accent)]">
      {prefixIcon && <span className="pl-2.5 pr-1 text-[var(--color-text-muted)]">{prefixIcon}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="min-w-0 flex-1 bg-transparent px-1.5 py-0 pr-6 text-[12px] text-[var(--color-text-primary)] outline-none appearance-none cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="pointer-events-none -ml-5 mr-2.5 text-[var(--color-text-muted)]" />
    </div>
  )
}

export function SliderCell({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  onCommit,
  format = (v) => `${Math.round(v * 100)}`,
  suffix = '%',
  prefixIcon,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  onCommit?: () => void
  format?: (v: number) => string
  suffix?: string
  prefixIcon?: ReactNode
}) {
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 focus-within:border-[var(--color-accent)]">
      {prefixIcon && <span className="text-[var(--color-text-muted)]">{prefixIcon}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onMouseUp={onCommit}
        onKeyUp={onCommit}
        className="min-w-0 flex-1 [accent-color:var(--color-accent)]"
      />
      <span className="w-9 text-right text-[11px] tabular-nums text-[var(--color-text-primary)]">{format(value)}</span>
      {suffix && <span className="text-[11px] text-[var(--color-text-muted)]">{suffix}</span>}
    </div>
  )
}

export function LinkedPair({
  left,
  right,
  linked,
  onToggleLink,
}: {
  left: ReactNode
  right: ReactNode
  linked: boolean
  onToggleLink: () => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">{left}</div>
      <button
        type="button"
        onClick={onToggleLink}
        className={`no-style flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
          linked
            ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
            : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
        }`}
        data-tooltip={linked ? 'Unlink' : 'Link'}
      >
        {linked ? <LinkIcon size={11} /> : <Link2Off size={11} />}
      </button>
      <div className="min-w-0 flex-1">{right}</div>
    </div>
  )
}
