'use client'

import { useState, useEffect } from 'react'
import { Loader2, X, Eye, EyeOff, Search, Plus, ShieldCheck, Bolt, ListFilter } from 'lucide-react'
import { MenuSurface, MenuGroup, MenuRow } from '@/components/ui/MenuDropdown'
import ModelBrandIcon, { brandNeedsDarkChip } from './model-brand-icon'
import { useVideoStore } from '@/lib/store'
import { safeLocalEndpoint } from '@/lib/utils/validate-endpoint'
import { DEFAULT_MODELS } from '@/lib/agents/model-config'
import { MEDIA_PROVIDERS } from '@/lib/media/provider-registry'
import { AUDIO_PROVIDERS } from '@/lib/audio/provider-registry'
import { useConfiguredProviders } from '@/lib/hooks/useConfiguredProviders'
import { API_DISPLAY_NAMES } from '@/lib/permissions'
import type { APIName, PermissionMode, PermissionConfig } from '@/lib/types'
import { Switch, Segmented } from './shared'

// ── Model type + brand-icon mapping ──────────────────────────────────────────
// The model config has no explicit modality, so derive a coarse type from the
// provider for the filter chips, and map to a @lobehub/icons provider key.
type ModelType = 'text' | 'image' | 'video' | 'avatar' | 'audio'

const TYPE_FILTERS: { id: ModelType | 'all'; label: string }[] = [
  { id: 'all', label: 'All types' },
  { id: 'text', label: 'Text' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'avatar', label: 'Avatar' },
  { id: 'audio', label: 'Audio' },
]

/** LLM provider → text (all chat providers); media/audio types come from their registries. */
function llmType(_provider: string): ModelType {
  return 'text'
}

/** Resolve a brand-icon key for a media/audio provider id. */
function mediaBrand(id: string): string {
  if (id === 'veo3' || id === 'veo31' || id === 'googleImageGen') return 'google'
  if (id === 'nanoBanana') return 'nanobanana' // dedicated Nano Banana mark
  if (id === 'gptImage') return 'openai'
  if (id === 'dall-e') return 'dalle' // dedicated DALL·E mark
  if (id === 'runway') return 'runway'
  if (id === 'kling' || id === 'kling25') return 'kling'
  if (id === 'hailuo') return 'hailuo' // dedicated Hailuo / MiniMax mark
  if (id === 'seedream' || id === 'seedance' || id === 'seedance2') return 'bytedance' // ByteDance models
  if (id === 'imageGen' || id === 'musetalk' || id === 'fabric' || id === 'aurora') return 'fal'
  return id // heygen/unsplash/backgroundRemoval → generic fallback
}
function audioBrand(id: string): string {
  if (id === 'elevenlabs') return 'elevenlabs'
  if (id === 'openai-tts') return 'openai'
  if (id === 'gemini-tts' || id === 'google-tts') return 'google'
  return id // edge/pocket/voxcpm/music → generic fallback
}

type GridItem = {
  key: string
  name: string
  type: ModelType
  brand: string
  sub: string
  enabled: boolean
  onToggle: () => void
  isCustom: boolean
  isLocal: boolean
  onRemove?: () => void
  // Config-drawer context:
  kind: 'llm' | 'media' | 'audio'
  modelId?: string // llm only — looks up the full ModelConfig
  keyProvider: string | null // keyring slot for the API-key input
  apiName: APIName | null // permission gate (media/audio); null for llm/free
  category?: string
}

// ── Shared Subcomponents ─────────────────────────────────────────────────────

/** The round brand chip. Tints dark behind white-only marks (e.g. HeyGen). */
function BrandChip({ brand, size = 20 }: { brand: string; size?: number }) {
  return (
    <span
      className={`grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full text-[var(--ink)] ${
        brandNeedsDarkChip(brand) ? 'bg-[var(--heygen-chip)]' : 'bg-[var(--card)]'
      }`}
    >
      <ModelBrandIcon provider={brand} size={size} />
    </span>
  )
}

const ENV_VAR_NAMES: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_AI_KEY',
  openai: 'OPENAI_API_KEY',
  fal: 'FAL_KEY',
  heygen: 'HEYGEN_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  local: 'OLLAMA_ENDPOINT',
  deepseek: 'DEEPSEEK_API_KEY',
  // Qwen/Kimi store under the dashscope/moonshot keyring slots — the same key
  // serves the agent model and the media-understanding vision intake.
  dashscope: 'DASHSCOPE_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  runway: 'RUNWAY_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'google-tts': 'GOOGLE_TTS_API_KEY',
  freesound: 'FREESOUND_API_KEY',
  pixabay: 'PIXABAY_API_KEY',
}

// A provider's required env var → the keyring slot used by KeyInputRow, so the
// media/audio cards reuse the same stored key as the API Keys section below.
const ENV_TO_KEY_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  GOOGLE_AI_KEY: 'google',
  OPENAI_API_KEY: 'openai',
  FAL_KEY: 'fal',
  HEYGEN_API_KEY: 'heygen',
  RUNWAY_API_KEY: 'runway',
  ELEVENLABS_API_KEY: 'elevenlabs',
  GEMINI_API_KEY: 'gemini',
  GOOGLE_TTS_API_KEY: 'google-tts',
  FREESOUND_API_KEY: 'freesound',
  PIXABAY_API_KEY: 'pixabay',
}

const KEY_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google AI',
  openai: 'OpenAI',
  fal: 'FAL',
  heygen: 'HeyGen',
  runway: 'Runway',
  elevenlabs: 'ElevenLabs',
  gemini: 'Gemini',
  'google-tts': 'Google Cloud TTS',
  freesound: 'Freesound',
  pixabay: 'Pixabay',
  deepseek: 'DeepSeek',
  dashscope: 'Qwen (DashScope)',
  moonshot: 'Kimi (Moonshot)',
  local: 'Ollama Endpoint',
}

/** Keyring slot for a provider's required env var (null = no key needed). */
function keyProviderForEnv(requiresKey: string | null): string | null {
  if (!requiresKey) return null
  return ENV_TO_KEY_PROVIDER[requiresKey] ?? requiresKey.replace(/_API_KEY$|_KEY$/, '').toLowerCase()
}

// LLM model provider → keyring slot. Qwen/Kimi run on the DashScope/Moonshot
// keys (the same slot the vision intake uses), so the model card's API-key
// input must target those slots, not a phantom 'qwen'/'kimi' slot.
const MODEL_PROVIDER_KEY_SLOT: Record<string, string> = { qwen: 'dashscope', kimi: 'moonshot' }
function keyProviderForModel(provider: string): string {
  return MODEL_PROVIDER_KEY_SLOT[provider] ?? provider
}

/** Permission API name for a media provider id (null = ungated / free). */
function mediaApiName(id: string): APIName | null {
  const map: Record<string, APIName> = {
    veo3: 'veo3',
    kling: 'kling',
    runway: 'runway',
    // fal video breadth — each is its own permission gate; without these the provider
    // cards rendered with no policy control, so users couldn't manage their cost/allow rules.
    ltx: 'ltx',
    wan: 'wan',
    seedance: 'seedance',
    hailuo: 'hailuo',
    // Frontier video breadth — each its own gate (like the other fal video models).
    veo31: 'veo31',
    kling25: 'kling25',
    seedance2: 'seedance2',
    googleImageGen: 'googleImageGen',
    imageGen: 'imageGen',
    'dall-e': 'imageGen',
    // Frontier image breadth (fal-hosted) — gated under the shared 'imageGen' spend bucket, the same
    // way DALL-E maps here, since generateImage gates all FAL image models on 'imageGen'.
    seedream: 'imageGen',
    gptImage: 'imageGen',
    nanoBanana: 'imageGen',
    heygen: 'heygen',
    musetalk: 'falAvatar',
    fabric: 'falAvatar',
    aurora: 'falAvatar',
    backgroundRemoval: 'backgroundRemoval',
    unsplash: 'unsplash',
  }
  return map[id] ?? null
}

/** Permission API name for an audio provider id (null = local / ungated). */
function audioApiName(id: string): APIName | null {
  const map: Record<string, APIName> = {
    elevenlabs: 'elevenLabs',
    'elevenlabs-sfx': 'elevenLabs',
    'openai-tts': 'openaiTts',
    'gemini-tts': 'geminiTts',
    'google-tts': 'googleTts',
    freesound: 'freesound',
    'freesound-music': 'freesound',
    pixabay: 'pixabay',
    'pixabay-music': 'pixabay',
    // Paid generative music — own gate each, so their Models card carries the cost limit.
    'stable-audio': 'falMusic',
    'elevenlabs-music': 'elevenLabsMusic',
    lyria: 'googleLyria',
  }
  return map[id] ?? null
}

const MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'always_ask', label: 'Always ask' },
  { value: 'always_allow', label: 'Always allow' },
  { value: 'always_deny', label: 'Always deny' },
  { value: 'ask_once', label: 'Ask once per session' },
]

/**
 * In-process snapshot of what the main process has stored in the OS keychain.
 * Renderer never sees decrypted values — only `{ hasKey, maskedPreview }`.
 * Hydrated on panel mount and after every save.
 */
type ProviderKeyStatus = {
  provider: string
  envVar: string
  hasKey: boolean
  maskedPreview: string | null
}

function useProviderKeyStatuses(): {
  statuses: Record<string, ProviderKeyStatus>
  refresh: () => Promise<void>
  save: (provider: string, apiKey: string | null) => Promise<void>
  available: boolean
} {
  const [statuses, setStatuses] = useState<Record<string, ProviderKeyStatus>>({})
  const api = typeof window !== 'undefined' ? (window as any).dreambyteApi?.settings : undefined
  const available = !!api && typeof api.listProviderKeys === 'function' && typeof api.setProviderKey === 'function'

  const refresh = async () => {
    if (!available) return
    try {
      const res = await api.listProviderKeys()
      const byProvider: Record<string, ProviderKeyStatus> = {}
      for (const k of res?.keys ?? []) {
        byProvider[k.provider] = k
      }
      setStatuses(byProvider)
    } catch {
      // keyring hydration failed at boot; keep renderer responsive
    }
  }

  const save = async (provider: string, apiKey: string | null) => {
    if (!available) return
    await api.setProviderKey({ provider, apiKey: apiKey?.trim() ? apiKey.trim() : null })
    await refresh()
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available])

  return { statuses, refresh, save, available }
}

function KeyInputRow({
  provider,
  label,
  extraAction,
}: {
  provider: string
  label: string
  extraAction?: React.ReactNode
}) {
  const { providerConfigs, updateProviderConfig } = useVideoStore()
  const cfg = providerConfigs.find((p) => p.provider === provider) ?? { provider, apiKey: '', baseUrl: '' }
  const [showKey, setShowKey] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const isLocal = provider === 'local'
  const envVar = ENV_VAR_NAMES[provider] ?? `${provider.toUpperCase()}_API_KEY`
  const { statuses, save, available: keyringAvailable } = useProviderKeyStatuses()
  const status = statuses[provider]

  // Input shows: (a) current unsaved draft, (b) the masked preview from the
  // keychain when one exists, (c) the legacy zustand value as a fallback for
  // the web build. Never the decrypted value — that only lives in main.
  const displayValue = (() => {
    if (isLocal) return cfg.baseUrl ?? 'http://localhost:11434'
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
      if (keyringAvailable) {
        await save(provider, draft)
      }
      setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5 mb-2 px-1">
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-[var(--mute)] font-medium">{label}</label>
        <code className="text-[11px] text-[var(--ash)] font-mono">{envVar}</code>
        {!isLocal && keyringAvailable && status?.hasKey && draft === null && (
          <span className="text-[11px] text-[var(--success)] uppercase tracking-wide">saved</span>
        )}
      </div>
      <div className="flex gap-2 items-center">
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
          placeholder={isLocal ? 'http://localhost:11434' : `${envVar}`}
          disabled={saving}
          className="flex-1 text-sm px-3 py-1.5 rounded border focus:outline-none bg-[var(--color-input-bg)] border-[var(--color-border)] text-[var(--color-text-primary)] font-mono disabled:opacity-60"
        />
        <div className="flex items-center gap-1.5">
          {!isLocal && (
            <button
              onClick={() => setShowKey((s) => !s)}
              className="no-style p-1 text-[var(--mute)] hover:text-[var(--color-text-primary)] transition-colors"
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

function ModelConfigDropdown({ model }: { model: import('@/lib/agents/model-config').ModelConfig }) {
  const { modelConfigs, setModelConfigs } = useVideoStore()

  const update = (field: string, value: any) => {
    setModelConfigs(modelConfigs.map((m) => (m.id === model.id ? { ...m, [field]: value } : m)))
  }

  return (
    <div className="px-1 pb-3 pt-1 space-y-3 border-b border-[var(--color-border)]">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] text-[var(--mute)] font-medium block mb-1">Provider</label>
          <span className="text-[12px] text-[var(--color-text-muted)] capitalize">{model.provider}</span>
        </div>
        <div>
          <label className="text-[11px] text-[var(--mute)] font-medium block mb-1">Model ID</label>
          <span className="text-[12px] text-[var(--color-text-muted)] font-mono">{model.modelId}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] text-[var(--mute)] font-medium block mb-1">Tier</label>
          <select
            value={model.tier}
            onChange={(e) => update('tier', e.target.value)}
            className="w-full text-[12px] bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text-primary)] outline-none"
          >
            <option value="budget">Budget</option>
            <option value="balanced">Balanced</option>
            <option value="performance">Performance</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div>
          <label className="text-[11px] text-[var(--mute)] font-medium block mb-1">Max Tokens</label>
          <input
            type="number"
            value={model.maxTokens}
            onChange={(e) => update('maxTokens', parseInt(e.target.value) || 0)}
            className="w-full text-[12px] bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text-primary)] outline-none font-mono"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] text-[var(--mute)] font-medium block mb-1">Cost / 1M Input</label>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-[var(--color-text-muted)]">$</span>
            <input
              type="number"
              step="0.01"
              value={model.costPer1MInput}
              onChange={(e) => update('costPer1MInput', parseFloat(e.target.value) || 0)}
              className="w-full text-[12px] bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text-primary)] outline-none font-mono"
            />
          </div>
        </div>
        <div>
          <label className="text-[11px] text-[var(--mute)] font-medium block mb-1">Cost / 1M Output</label>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-[var(--color-text-muted)]">$</span>
            <input
              type="number"
              step="0.01"
              value={model.costPer1MOutput}
              onChange={(e) => update('costPer1MOutput', parseFloat(e.target.value) || 0)}
              className="w-full text-[12px] bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text-primary)] outline-none font-mono"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={model.supportsTools}
            onChange={(e) => update('supportsTools', e.target.checked)}
            className="rounded"
          />
          Tool use
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={model.supportsStreaming}
            onChange={(e) => update('supportsStreaming', e.target.checked)}
            className="rounded"
          />
          Streaming
        </label>
      </div>
    </div>
  )
}

/** Mode + spend-limit editor for a single gated API, used inside the drawer. */
function SinglePermissionEditor({ api }: { api: APIName }) {
  const { project, updateAPIPermissions } = useVideoStore()
  const permissions = (project.apiPermissions ?? {}) as Partial<Record<APIName, PermissionConfig>>
  const [spend, setSpend] = useState<{ sessionSpend: number; monthlySpend: number } | null>(null)

  useEffect(() => {
    const ipc = typeof window !== 'undefined' ? (window as any).dreambyteApi?.permissions : undefined
    if (!ipc?.getSpend) return
    ipc
      .getSpend()
      .then((data: Record<string, { sessionSpend: number; monthlySpend: number }>) => setSpend(data?.[api] ?? null))
      .catch(() => {})
  }, [api])

  const config: PermissionConfig = permissions[api] ?? {
    mode: 'always_ask',
    sessionLimit: null,
    monthlyLimit: null,
    sessionSpend: 0,
    monthlySpend: 0,
  }
  const update = (updates: Partial<PermissionConfig>) =>
    updateAPIPermissions({ [api]: { ...config, ...updates } } as any)

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-[11px] font-medium text-[var(--mute)]">Mode</label>
        <select
          value={config.mode}
          onChange={(e) => update({ mode: e.target.value as PermissionMode })}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 py-1.5 text-[12px] text-[var(--color-text-primary)] outline-none"
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--mute)]">Session limit</label>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-[var(--mute)]">$</span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder="∞"
              value={config.sessionLimit ?? ''}
              onChange={(e) => update({ sessionLimit: e.target.value ? parseFloat(e.target.value) : null })}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 py-1.5 text-[12px] font-mono text-[var(--color-text-primary)] outline-none"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--mute)]">Monthly limit</label>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-[var(--mute)]">$</span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder="∞"
              value={config.monthlyLimit ?? ''}
              onChange={(e) => update({ monthlyLimit: e.target.value ? parseFloat(e.target.value) : null })}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 py-1.5 text-[12px] font-mono text-[var(--color-text-primary)] outline-none"
            />
          </div>
        </div>
      </div>
      <div className="flex gap-4 text-[11px] text-[var(--mute)]">
        <span>This session: ${(spend?.sessionSpend ?? config.sessionSpend ?? 0).toFixed(2)}</span>
        <span>This month: ${(spend?.monthlySpend ?? config.monthlySpend ?? 0).toFixed(2)}</span>
      </div>
    </div>
  )
}

/** A labeled section inside the config drawer. */
function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-[var(--hairline)] pt-4 first:border-t-0 first:pt-0">
      <h4 className="mb-2 text-[12px] font-semibold text-[var(--ink)]">{title}</h4>
      {children}
    </div>
  )
}

/** Slide-in drawer to configure a single model/provider: prefs, key, permissions. */
function ModelConfigDrawer({ item, onClose }: { item: GridItem; onClose: () => void }) {
  const { modelConfigs } = useVideoStore()
  const model = item.kind === 'llm' && item.modelId ? modelConfigs.find((m) => m.id === item.modelId) : null

  return (
    // Wrapper only occupies the bottom strip and is click-through (pointer-events-none),
    // so the model list above stays fully visible and clickable — click another card
    // to switch which model this sheet configures, no backdrop dimming.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-end px-3 pb-3">
      <aside
        className="pointer-events-auto flex max-h-[68vh] w-full max-w-[560px] flex-col overflow-y-auto rounded-2xl border border-[var(--hairline-strong)] bg-[var(--panel)] shadow-2xl"
        role="dialog"
        aria-label={`${item.name} settings`}
      >
        {/* header */}
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--hairline)] bg-[var(--panel)] px-4 py-3">
          <BrandChip brand={item.brand} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-[var(--ink)]">{item.name}</div>
            <div className="truncate text-[11px] capitalize text-[var(--slate)]">{item.sub}</div>
          </div>
          <button
            onClick={onClose}
            className="no-style grid h-7 w-7 place-items-center rounded-[var(--radius-md)] text-[var(--graphite)] hover:bg-[var(--card)] hover:text-[var(--ink)]"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4">
          {/* Enabled */}
          <DrawerSection title="Enabled">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-[var(--slate)]">
                {item.enabled ? 'Available to the agent' : 'Hidden from the agent'}
              </span>
              <Switch checked={item.enabled} onChange={item.onToggle} ariaLabel={`${item.name} enabled`} />
            </div>
          </DrawerSection>

          {/* Preferences (LLM models only) */}
          {model && (
            <DrawerSection title="Preferences">
              <ModelConfigDropdown model={model} />
            </DrawerSection>
          )}

          {/* API key */}
          <DrawerSection title="API key">
            {item.keyProvider ? (
              <KeyInputRow
                provider={item.keyProvider}
                label={KEY_PROVIDER_LABELS[item.keyProvider] ?? item.keyProvider}
              />
            ) : (
              <p className="px-1 text-[12px] text-[var(--mute)]">No API key required — runs locally or free.</p>
            )}
          </DrawerSection>

          {/* Permissions (gated APIs only) */}
          {item.apiName && (
            <DrawerSection title="Permissions">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--slate)]">
                <ShieldCheck size={13} className="text-[var(--warn)]" />
                Spend &amp; approval for {API_DISPLAY_NAMES[item.apiName] ?? item.apiName}
              </div>
              <SinglePermissionEditor api={item.apiName} />
            </DrawerSection>
          )}
        </div>
      </aside>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function ModelsAndApiPanel({ keysOnly = false }: { keysOnly?: boolean } = {}) {
  const { modelConfigs, toggleModelEnabled, providerConfigs, removeCustomModel, addCustomModel } = useVideoStore()
  const { mediaGenEnabled, toggleMediaGen, audioProviderEnabled, toggleAudioProvider } = useVideoStore()
  const configuredProviders = useConfiguredProviders()
  // Sync default models on mount: ensures DEFAULT_MODELS are always current,
  // removes stale defaults, preserves user's enabled/disabled prefs and custom models.
  useEffect(() => {
    const defaultIds = new Set(DEFAULT_MODELS.map((m) => m.id))
    const enabledMap = new Map(modelConfigs.map((m) => [m.id, m.enabled]))
    // Custom models = user-added entries: not a current default (re-added from
    // DEFAULT_MODELS below) and not flagged isDefault. An id-prefix
    // heuristic ('gemini-'/'claude-'/'gpt-'/...) would silently DROP any
    // user custom model whose id starts with a default-provider prefix
    // (e.g. a tuned 'claude-opus-custom'), and the overwrite persists.
    // addCustomModel always stamps isDefault:false, so isDefault + id membership
    // are the reliable discriminators.
    const customModels = modelConfigs.filter((m) => !m.isDefault && !defaultIds.has(m.id))
    const merged = [
      ...DEFAULT_MODELS.map((m) => ({ ...m, enabled: enabledMap.has(m.id) ? enabledMap.get(m.id)! : m.enabled })),
      ...customModels,
    ]
    const currentIds = modelConfigs.map((m) => m.id).join(',')
    const mergedIds = merged.map((m) => m.id).join(',')
    if (currentIds !== mergedIds) {
      useVideoStore.setState({ modelConfigs: merged })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [detectingModels, setDetectingModels] = useState(false)
  const [detectedOllamaModels, setDetectedOllamaModels] = useState<string[]>([])
  const handleDetectOllama = async () => {
    if (detectingModels) return
    setDetectingModels(true)
    try {
      const endpoint = safeLocalEndpoint(providerConfigs.find((p) => p.provider === 'local')?.baseUrl)
      const res = await fetch(`${endpoint}/api/tags`).catch(() => null)
      if (!res || !res.ok) {
        setDetectedOllamaModels([])
        return
      }
      const data = await res.json()
      const models: any[] = data.models ?? []
      setDetectedOllamaModels(models.map((m) => m.name))
    } catch (e) {
      console.error(e)
    } finally {
      setDetectingModels(false)
    }
  }

  const handleAddLocalModel = (name: string) => {
    const id = `local-${name.replace(':', '-')}`
    const endpoint = providerConfigs.find((p) => p.provider === 'local')?.baseUrl ?? 'http://localhost:11434'
    if (!modelConfigs.find((cfg) => cfg.id === id || cfg.modelId === name)) {
      addCustomModel({
        id,
        provider: 'local',
        modelId: name,
        displayName: name.split(':')[0],
        tier: 'custom',
        enabled: true,
        isDefault: false,
        costPer1MInput: 0,
        costPer1MOutput: 0,
        maxTokens: 8192,
        supportsTools: true,
        supportsStreaming: true,
        endpoint,
        localModelName: name,
      })
    }
    setDetectedOllamaModels((prev) => prev.filter((m) => m !== name))
  }

  const [modelSearch, setModelSearch] = useState('')
  const [tab, setTab] = useState<'all' | 'yours' | 'local'>('all')
  const [typeFilter, setTypeFilter] = useState<ModelType | 'all'>('all')
  const [selected, setSelected] = useState<GridItem | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)

  // The manual refresh button is gone — detect local (Ollama) models whenever
  // the Local tab is opened so the discovered-on-system list still populates.
  useEffect(() => {
    if (tab === 'local') void handleDetectOllama()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Unified items: LLM models + media-gen providers + audio providers, so the
  // type filters (Text/Image/Video/Avatar/Audio) all have content in one grid.
  const llmItems: GridItem[] = modelConfigs.map((m) => ({
    key: `llm:${m.id}`,
    name: m.displayName,
    type: llmType(m.provider),
    brand: m.provider,
    sub: `${m.provider} · text`,
    enabled: m.enabled,
    onToggle: () => toggleModelEnabled(m.id),
    isCustom: !m.isDefault,
    isLocal: m.provider === 'local',
    onRemove: m.provider === 'local' && !m.isDefault ? () => removeCustomModel(m.id) : undefined,
    kind: 'llm' as const,
    modelId: m.id,
    keyProvider: keyProviderForModel(m.provider),
    apiName: null,
    category: 'text',
  }))
  const mediaItems: GridItem[] = MEDIA_PROVIDERS.map((p) => {
    const type: ModelType = p.category === 'utility' ? 'image' : p.category
    const configured = configuredProviders.media.has(p.id)
    return {
      key: `media:${p.id}`,
      name: p.name,
      type,
      brand: mediaBrand(p.id),
      sub: `media · ${p.category}`,
      enabled: configured && (mediaGenEnabled[p.id] ?? p.defaultEnabled),
      onToggle: () => toggleMediaGen(p.id),
      isCustom: false,
      isLocal: false,
      kind: 'media' as const,
      keyProvider: keyProviderForEnv(p.requiresKey),
      apiName: mediaApiName(p.id),
      category: p.category,
    }
  })
  const audioItems: GridItem[] = AUDIO_PROVIDERS.map((p) => {
    const configured = configuredProviders.audio.has(p.id)
    return {
      key: `audio:${p.id}`,
      name: p.name,
      type: 'audio' as ModelType,
      brand: audioBrand(p.id),
      sub: `audio · ${p.category}`,
      enabled: configured && (audioProviderEnabled[p.id] ?? p.defaultEnabled),
      onToggle: () => toggleAudioProvider(p.id),
      isCustom: false,
      isLocal: p.requiresKey === null,
      kind: 'audio' as const,
      keyProvider: keyProviderForEnv(p.requiresKey),
      apiName: audioApiName(p.id),
      category: p.category,
    }
  })
  const allItems = [...llmItems, ...mediaItems, ...audioItems]

  const filteredModels = allItems
    .filter((it) => (tab === 'all' ? true : tab === 'yours' ? it.isCustom : it.isLocal))
    .filter((it) => (typeFilter === 'all' ? true : it.type === typeFilter))
    .filter((it) => `${it.name} ${it.brand} ${it.sub}`.toLowerCase().includes(modelSearch.toLowerCase()))

  return (
    <div className="space-y-4">
      {!keysOnly && (
        <>
          {/* Models — main title (count + filter inline) + tabs + card grid */}
          <div>
            {/* Main title */}
            <div className="mb-5 flex items-center gap-2.5">
              <h1 className="text-[22px] font-semibold text-[var(--ink)]">Models</h1>
              <span className="text-[14px] text-[var(--slate)]">{filteredModels.length}</span>
              <span className="flex-1" />
              {/* Active filter pill — clears back to All */}
              {typeFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--hairline-strong)] bg-[var(--card)] py-1 pl-2.5 pr-1 text-[12px] text-[var(--ink)]">
                  {TYPE_FILTERS.find((f) => f.id === typeFilter)?.label}
                  <button
                    onClick={() => setTypeFilter('all')}
                    className="no-style grid h-4 w-4 place-items-center rounded-full text-[var(--graphite)] transition-colors hover:text-[var(--ink)]"
                    aria-label="Clear filter"
                  >
                    <X size={12} />
                  </button>
                </span>
              )}
              {/* Type filter — opens a menu of types */}
              <div className="relative">
                <button
                  onClick={() => setFilterOpen((o) => !o)}
                  className={`no-style grid h-8 w-8 place-items-center rounded-[var(--radius-md)] transition-colors hover:bg-[var(--card)] hover:text-[var(--ink)] ${
                    typeFilter !== 'all' || filterOpen ? 'text-[var(--ink)]' : 'text-[var(--graphite)]'
                  }`}
                  title="Filter by type"
                  aria-label="Filter by type"
                >
                  <ListFilter size={16} />
                </button>
                {filterOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} aria-hidden="true" />
                    <MenuSurface className="absolute right-0 top-full z-50 mt-1 min-w-[144px]">
                      <MenuGroup>
                        {TYPE_FILTERS.map((f) => (
                          <MenuRow
                            key={f.id}
                            name={f.label}
                            selected={typeFilter === f.id}
                            onClick={() => {
                              setTypeFilter(f.id)
                              setFilterOpen(false)
                            }}
                          />
                        ))}
                      </MenuGroup>
                    </MenuSurface>
                  </>
                )}
              </div>
            </div>

            {/* Source tabs — segmented control, matching Rules/Skills/Subagents */}
            <Segmented
              options={[
                { value: 'all', label: 'All' },
                { value: 'yours', label: 'Yours' },
                { value: 'local', label: 'Local' },
              ]}
              value={tab}
              onChange={setTab}
            />

            {/* Search */}
            <div className="mt-2.5 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-input)] bg-[var(--input-bg)] px-3">
              <Search size={14} className="text-[var(--mute)]" />
              <input
                type="text"
                placeholder="Search models"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                className="h-9 flex-1 bg-transparent text-[13px] text-[var(--ink)] placeholder:text-[var(--mute)] outline-none"
              />
            </div>

            {/* Card grid */}
            {filteredModels.length === 0 ? (
              <div className="mt-4 px-1 py-6 text-center text-[12px] text-[var(--mute)]">No models match.</div>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {filteredModels.map((item) => {
                  const isOpen = selected?.key === item.key
                  return (
                    <div
                      key={item.key}
                      className={`flex items-center gap-3 rounded-[var(--radius-md)] border bg-[var(--panel)] px-3 py-2.5 transition-colors ${
                        isOpen ? 'border-[var(--ink)]' : 'border-[var(--hairline)]'
                      }`}
                    >
                      <BrandChip brand={item.brand} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-[var(--ink)]">{item.name}</div>
                        <div className="truncate text-[11px] capitalize text-[var(--slate)]">{item.sub}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {item.onRemove && (
                          <button
                            onClick={item.onRemove}
                            className="no-style text-[var(--graphite)] transition-colors hover:text-[var(--danger)]"
                            title="Remove"
                          >
                            <X size={13} />
                          </button>
                        )}
                        <Switch checked={item.enabled} onChange={item.onToggle} ariaLabel={item.name} />
                        <button
                          onClick={() => setSelected(item)}
                          title="Configure"
                          aria-label={`Configure ${item.name}`}
                          className={`no-style grid h-7 w-7 place-items-center rounded-[var(--radius-md)] transition-colors hover:bg-[var(--card)] hover:text-[var(--ink)] ${
                            isOpen ? 'text-[var(--ink)]' : 'text-[var(--graphite)]'
                          }`}
                        >
                          <Bolt size={14} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Discovered Ollama models */}
          {detectedOllamaModels.length > 0 && (
            <div className="settings-list">
              <div className="px-1 py-2 text-[11px] uppercase tracking-widest text-[var(--color-text-muted)] font-semibold">
                Discovered on system
              </div>
              {detectedOllamaModels.map((name) => {
                const alreadySaved = modelConfigs.some((m) => m.modelId === name && m.provider === 'local')
                if (alreadySaved) return null
                return (
                  <div key={name} className="flex items-center justify-between px-1 py-2.5">
                    <span className="text-[12px] text-[var(--color-text-primary)] font-medium truncate">
                      {name.split(':')[0]}
                    </span>
                    <button
                      onClick={() => handleAddLocalModel(name)}
                      className="no-style text-[var(--color-accent)] hover:opacity-80 transition-all"
                    >
                      <Plus size={18} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Per-model config drawer */}
      {selected && <ModelConfigDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
