'use client'

import { useEffect, useState } from 'react'
import { Eye, EyeOff, Loader2, Minus, Plus } from 'lucide-react'
import { useVideoStore } from '@/lib/store'

/* ──────────────────────────────────────────────────────────────────────────
 * Settings primitives — single source of truth.
 * Aligned to docs/EDITOR-DESIGN.md: Inter, neutral-grey surfaces, hairline rows,
 * Signal Blue (--accent) reserved for active/selected/focus state only.
 * ────────────────────────────────────────────────────────────────────────── */

/** Sentence-case eyebrow that introduces a group of settings rows. */
export function SettingsSection({ children }: { children: React.ReactNode }) {
  return <h4 className="text-[12px] font-medium text-[var(--slate)] mt-6 mb-1.5 first:mt-0 px-1">{children}</h4>
}

/** Back-compat alias — older tabs import `SectionLabel`. */
export const SectionLabel = SettingsSection

/** Dashed empty-state card for tabs that are scaffolded but not yet built. */
export function SettingsEmptyState({
  icon,
  title,
  description,
}: {
  icon?: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--hairline-strong)] px-6 py-16 text-center">
      {icon && <div className="mb-3 text-[var(--mute)]">{icon}</div>}
      <p className="text-[14px] font-medium text-[var(--ink)] m-0">{title}</p>
      <p className="mt-1 max-w-sm text-[13px] text-[var(--mute)] leading-snug">{description}</p>
    </div>
  )
}

/** One config row: label (+ optional description) on the left, control on the right. */
export function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-[var(--ink)] m-0">{label}</p>
        {description && <p className="text-[12px] text-[var(--mute)] mt-0.5 leading-snug">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Borderless list — rows separated by one faint hairline, no boxed outline. */
export function ListContainer({ children }: { children: React.ReactNode }) {
  return <div className="settings-list mb-4">{children}</div>
}

/** Grouped card — an elevated rounded surface whose rows are separated by inset
 *  hairlines (the macOS/Cursor settings idiom). Use for self-contained groups
 *  like Account / Notifications; the borderless ListContainer is for dense lists. */
export function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--card)] px-4 [&>*+*]:border-t [&>*+*]:border-[var(--hairline)]">
      {children}
    </div>
  )
}

/** Compact compact button. Default = ghost rounded-rect; `active` = Signal-Blue selected. */
export function SettingsButton({
  onClick,
  children,
  variant = 'default',
  active = false,
  disabled,
}: {
  onClick?: () => void
  children: React.ReactNode
  variant?: 'default' | 'danger' | 'active'
  active?: boolean
  disabled?: boolean
}) {
  // `variant="active"` kept as a legacy alias for the `active` boolean.
  const isActive = active || variant === 'active'
  const tone: React.CSSProperties =
    variant === 'danger'
      ? { background: 'transparent', color: 'var(--danger)', borderColor: 'var(--hairline-strong)' }
      : isActive
        ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'transparent' }
        : { background: 'transparent', color: 'var(--ink)', borderColor: 'var(--hairline-strong)' }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 28,
        padding: '0 12px',
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1,
        borderRadius: 'var(--radius-md)',
        border: '1px solid transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
        userSelect: 'none',
        transition: 'background var(--dur-fast) var(--ease-swift), color var(--dur-fast), border-color var(--dur-fast)',
        ...tone,
      }}
    >
      {children}
    </button>
  )
}

/** Segmented selector built from SettingsButtons — one option carries the active state. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div
      className="inline-flex gap-0.5 p-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)]"
      style={{ background: 'var(--color-input-bg)' }}
    >
      {options.map((o) => {
        const sel = value === o.value
        return (
          <button
            key={String(o.value)}
            onClick={() => onChange(o.value)}
            style={{
              height: 26,
              padding: '0 12px',
              fontSize: 12,
              fontWeight: 500,
              border: 'none',
              borderRadius: 'calc(var(--radius-md) - 2px)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: sel ? 'var(--panel)' : 'transparent',
              color: sel ? 'var(--ink)' : 'var(--graphite)',
              boxShadow: sel ? '0 1px 2px rgba(0,0,0,0.18)' : 'none',
              transition: 'background var(--dur-fast) var(--ease-swift), color var(--dur-fast)',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** compact switch — 30×20 track, 14px knob, Signal Blue when on. */
export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
  disabled?: boolean
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        position: 'relative',
        width: 30,
        height: 20,
        flexShrink: 0,
        padding: 0,
        border: 'none',
        borderRadius: 72,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        background: checked ? 'var(--accent)' : 'var(--switch-off)',
        transition: 'background 100ms ease-out',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 13 : 3,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 100ms ease-out',
        }}
      />
    </button>
  )
}

/** macOS-style numeric stepper — [−  value  +]. `format` maps the raw value to
 *  its display label; the buttons clamp to [min, max]. */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  ariaLabel,
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  ariaLabel?: string
}) {
  const btn =
    'no-style flex h-8 w-8 items-center justify-center text-[var(--graphite)] transition-colors hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35'
  return (
    <div
      className="inline-flex h-8 items-center overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-input)]"
      style={{ background: 'var(--color-input-bg)' }}
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className={btn}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - step))}
        aria-label="Decrease"
      >
        <Minus size={13} />
      </button>
      <span className="flex h-full min-w-[48px] items-center justify-center border-x border-[var(--border-input)] px-2 text-[13px] font-medium tabular-nums text-[var(--ink)]">
        {format ? format(value) : value}
      </span>
      <button
        type="button"
        className={btn}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + step))}
        aria-label="Increase"
      >
        <Plus size={13} />
      </button>
    </div>
  )
}

/** Providers whose API keys the keyring knows how to persist to
 *  `<userData>/dreambyte-keys.json`. Must match `src/electron/provider-keys.ts`.
 *  Providers not in this set (e.g. `openai-edge-tts`, `voxcpm`) are local-
 *  service base-URL inputs — those stay in the zustand-only path. */
const KEYRING_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'google',
  'gemini',
  'fal',
  'heygen',
  'elevenlabs',
  'runway',
  'freesound',
  'pixabay',
  'google-tts',
  // Phase 2.5 cheap vision providers (must match src/electron/provider-keys.ts).
  'dashscope',
  'moonshot',
  'deepseek',
  // Deep-research search backends (must match src/electron/provider-keys.ts).
  'searxng',
  'tavily',
])

type ProviderKeyStatus = {
  provider: string
  envVar: string
  hasKey: boolean
  maskedPreview: string | null
}

/** Read the main-process key status for this provider. Lets the input show
 *  a masked preview + "saved" state without the renderer ever holding the
 *  decrypted value. Returns null when dreambyteApi is unavailable (web build). */
function useKeyringStatus(provider: string): {
  status: ProviderKeyStatus | null
  available: boolean
  save: (value: string | null) => Promise<void>
} {
  const [status, setStatus] = useState<ProviderKeyStatus | null>(null)
  const api = typeof window !== 'undefined' ? (window as any).dreambyteApi?.settings : undefined
  const available =
    !!api &&
    KEYRING_PROVIDERS.has(provider) &&
    typeof api.listProviderKeys === 'function' &&
    typeof api.setProviderKey === 'function'

  useEffect(() => {
    if (!available) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.listProviderKeys()
        if (cancelled) return
        setStatus(res?.keys?.find((k: ProviderKeyStatus) => k.provider === provider) ?? null)
      } catch {
        /* keyring unavailable — stay on zustand fallback */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, available, provider])

  const save = async (value: string | null) => {
    if (!available) return
    await api.setProviderKey({ provider, apiKey: value?.trim() ? value.trim() : null })
    try {
      const res = await api.listProviderKeys()
      setStatus(res?.keys?.find((k: ProviderKeyStatus) => k.provider === provider) ?? null)
    } catch {}
  }

  return { status, available, save }
}

export function KeyInputRow({
  provider,
  label,
  envVar: envVarOverride,
  extraAction,
}: {
  provider: string
  label: string
  envVar?: string
  extraAction?: React.ReactNode
}) {
  const { providerConfigs, updateProviderConfig } = useVideoStore()
  const cfg = providerConfigs.find((p) => p.provider === provider) ?? { provider, apiKey: '', baseUrl: '' }
  const [showKey, setShowKey] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const isLocal = provider === 'local' || provider === 'openai-edge-tts'
  const envVar = envVarOverride ?? `${provider.toUpperCase()}_API_KEY`
  const { status, available: keyringAvailable, save } = useKeyringStatus(provider)

  // Input shows: (a) current unsaved draft, (b) the masked preview from the
  // keychain when one exists, (c) the legacy zustand value as a fallback for
  // the web build. Never the decrypted value — that only lives in main.
  const displayValue = (() => {
    if (isLocal) return cfg.baseUrl ?? ''
    if (draft !== null) return draft
    if (keyringAvailable) return status?.maskedPreview ?? ''
    return cfg.apiKey
  })()

  const commit = async () => {
    if (isLocal || draft === null) return
    setSaving(true)
    try {
      // Keep zustand in sync for the web build. In desktop this is a no-op
      // as far as the agent runner is concerned (runner reads process.env,
      // which the IPC call updated below).
      updateProviderConfig(provider, { apiKey: draft })
      if (keyringAvailable) await save(draft)
      setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-2 flex flex-col gap-1.5 px-1">
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-medium uppercase tracking-[0.2px] text-[var(--slate)]">{label}</label>
        <code className="font-mono text-[11px] text-[var(--mute)]">{envVar}</code>
        {!isLocal && keyringAvailable && status?.hasKey && draft === null && (
          <span className="text-[11px] uppercase tracking-[0.2px] text-[var(--success)]">saved</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type={isLocal || showKey ? 'text' : 'password'}
          value={displayValue}
          onChange={(e) => {
            if (isLocal) {
              updateProviderConfig(provider, { baseUrl: e.target.value })
              return
            }
            setDraft(e.target.value)
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isLocal) {
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          placeholder={isLocal ? 'http://localhost:5050' : envVar}
          disabled={saving}
          className="flex-1 rounded-[var(--radius-md)] border border-[var(--border-input)] bg-[var(--color-input-bg)] px-3 py-1.5 font-mono text-[13px] text-[var(--ink)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-60"
        />
        <div className="flex items-center gap-1.5">
          {!isLocal && (
            <button
              onClick={() => setShowKey((s) => !s)}
              className="no-style p-1 text-[var(--mute)] transition-colors hover:text-[var(--ink)]"
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          )}
          {saving && <Loader2 size={14} className="animate-spin text-[var(--mute)]" />}
          {extraAction}
        </div>
      </div>
    </div>
  )
}
