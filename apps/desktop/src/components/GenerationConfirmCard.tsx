'use client'

import { useEffect, useRef, useState } from 'react'
import { ShieldAlert, ChevronDown, CircleAlert, Check } from 'lucide-react'
import { API_DISPLAY_NAMES } from '@/lib/permissions'
import type { PendingPermission } from '@/lib/agents/types'
import type { PermissionMode } from '@/lib/types'
import { ProviderIcon, pickProviderIconName } from './chat/ProviderIcons'

const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'always_ask', label: 'Always ask' },
  { value: 'always_allow', label: 'Always allow' },
  { value: 'always_deny', label: 'Always deny' },
]

/**
 * Short model labels for the pill in the card header. The values in
 * `API_DISPLAY_NAMES` ("Veo 3 Video", "Kling 2.1 Video", "HeyGen
 * Avatars") are too verbose to fit in a 11px pill alongside the
 * "Video Generation" header label, so we use these stripped-down
 * names. The pill falls back to `API_DISPLAY_NAMES` and then to a
 * formatted version of the api id when an entry is missing here.
 */
const SHORT_MODEL_NAMES: Record<string, string> = {
  veo3: 'Veo 3',
  heygen: 'HeyGen',
  kling: 'Kling',
  runway: 'Runway',
  falAvatar: 'Fal Avatar',
  openaiTts: 'OpenAI TTS',
  googleTts: 'Google TTS',
  geminiTts: 'Gemini TTS',
  googleImageGen: 'Imagen',
  imageGen: 'Image Gen',
  backgroundRemoval: 'Bg Remove',
  elevenLabs: 'ElevenLabs',
  unsplash: 'Unsplash',
  freesound: 'Freesound',
  pixabay: 'Pixabay',
}

function shortApiLabel(api: string): string {
  return SHORT_MODEL_NAMES[api] ?? (API_DISPLAY_NAMES as Record<string, string>)[api] ?? api
}

/** 'delete_scene' → 'delete scene' — tool ids are snake_case; chat copy isn't. */
function humanizeToolName(toolName?: string): string | undefined {
  return toolName?.replace(/_/g, ' ')
}

/**
 * Generation-type pill options. Single nouns keep the pill compact; the map
 * also seeds the
 * dropdown so the user can flip kind on the fly.
 */
const GEN_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Image' },
  { value: 'tts', label: 'Voice' },
  { value: 'music', label: 'Music' },
  { value: 'sfx', label: 'Sound' },
  { value: 'avatar', label: 'Avatar' },
]

function genTypeLabel(t?: string | null): string {
  if (!t) return 'Generation'
  return GEN_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t
}

/**
 * Per-generation-type defaults for the model pill, cost, icon, and
 * provider dropdown. Used when the user flips the type pill to
 * something other than what the original permission ask was for —
 * `perm` only carries data for one generation type, so we synthesize
 * the rest from this table.
 *
 * Costs are midpoint estimates from `src/lib/permissions.ts:API_COST_ESTIMATES`
 * adjusted for what's typical to actually pick. If a provider is free
 * (Freesound, Pixabay), `isFree: true` lights up the green chip in the
 * dropdown and the cost popover.
 */
type TypeDefaults = {
  api: string
  provider: string
  providers: { id: string; name: string; cost: string; isFree?: boolean }[]
  cost: string
}

const TYPE_DEFAULTS: Record<string, TypeDefaults> = {
  video: {
    api: 'veo3',
    provider: 'veo3',
    providers: [
      { id: 'veo3', name: 'Veo 3', cost: '$0.05' },
      { id: 'kling', name: 'Kling 2.1', cost: '$0.04' },
      { id: 'runway', name: 'Runway Gen-4', cost: '$0.07' },
    ],
    cost: '$0.05',
  },
  image: {
    api: 'imageGen',
    provider: 'fal',
    providers: [
      { id: 'fal', name: 'Fal Flux', cost: '$0.04' },
      { id: 'openai', name: 'DALL·E 3', cost: '$0.04' },
      { id: 'google', name: 'Imagen', cost: '$0.03' },
      { id: 'midjourney', name: 'Midjourney', cost: '$0.05' },
      { id: 'bytedance', name: 'Seedream', cost: '$0.02' },
    ],
    cost: '$0.04',
  },
  tts: {
    api: 'openaiTts',
    provider: 'openai',
    providers: [
      { id: 'openai', name: 'OpenAI TTS', cost: '$0.015' },
      { id: 'google', name: 'Gemini TTS', cost: '$0.01' },
      { id: 'elevenlabs', name: 'ElevenLabs', cost: '$0.06' },
    ],
    cost: '$0.015',
  },
  music: {
    api: 'imageGen',
    provider: 'pixabay',
    providers: [{ id: 'pixabay', name: 'Pixabay Music', cost: 'Free', isFree: true }],
    cost: 'Free',
  },
  sfx: {
    api: 'imageGen',
    provider: 'freesound',
    providers: [{ id: 'freesound', name: 'Freesound', cost: 'Free', isFree: true }],
    cost: 'Free',
  },
  avatar: {
    api: 'heygen',
    provider: 'heygen',
    providers: [
      { id: 'heygen', name: 'HeyGen', cost: '$0.50' },
      { id: 'fal', name: 'Fal Avatar', cost: '$0.10' },
    ],
    cost: '$0.50',
  },
}

/**
 * The canonical Cancel + Generate pair (the video-generation card's footer
 * buttons). EVERY permission/confirm surface uses these — quiet Cancel with
 * an Esc hint, slate-glow primary with the ⌘↵ hint. All cards share the
 * plan-card idiom; only the primary action keeps the slate glow.
 */
const permCancelBtnClass =
  'no-style !min-h-0 !h-auto !py-1 !px-2 !rounded-md !text-[11px] !font-medium !border !border-[var(--color-border)] !bg-transparent !text-[var(--color-text-muted)] hover:!text-[var(--color-text-primary)] hover:!bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] inline-flex items-center gap-1 transition-colors'

export const permGenerateBtnClass =
  'create-btn-glow no-style !min-h-0 !h-auto !py-1 !px-2.5 !rounded-md !text-[11px] !font-semibold !border !border-[#b8c9d9] !bg-[#94a3b8] !text-[#141820] hover:!border-[#c9d8e6] hover:!bg-[#8699af] inline-flex items-center gap-1.5 transition-colors'

export function permissionModKey(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ? '⌘' : 'Ctrl'
}

// Stack of active permission/confirm cards. Several can mount at once (e.g.
// multiple pending permission asks in the chat stream); if each handled global
// keydown, a single Enter would resolve ALL of them. Only the most-recently-
// mounted active card — the top of this stack — handles a keystroke; the rest
// stay pending until clicked.
const permissionKeyStack: symbol[] = []

/** Esc / ⌘+. → cancel; Enter / ⌘↵ → generate (same rules as the Create/Cancel pair). */
export function usePermissionKeyboardShortcuts(onCancel: () => void, onGenerate: () => void, active: boolean) {
  const cancelRef = useRef(onCancel)
  const genRef = useRef(onGenerate)
  cancelRef.current = onCancel
  genRef.current = onGenerate

  useEffect(() => {
    if (!active) return

    const token = Symbol('permission-card')
    permissionKeyStack.push(token)

    const onKey = (e: KeyboardEvent) => {
      // Only the topmost active card responds — prevents one Enter from
      // resolving every mounted card at once.
      if (permissionKeyStack[permissionKeyStack.length - 1] !== token) return
      const t = e.target as HTMLElement
      const tag = t.tagName
      const inTextarea = tag === 'TEXTAREA'
      const inSelect = tag === 'SELECT'
      const inputEl = tag === 'INPUT' ? (t as HTMLInputElement) : null
      const skipPlainEnter =
        inTextarea || inSelect || t.isContentEditable || (inputEl != null && ['number', 'range'].includes(inputEl.type))

      if ((e.metaKey || e.ctrlKey) && (e.key === '.' || e.code === 'Period')) {
        e.preventDefault()
        cancelRef.current()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelRef.current()
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        genRef.current()
        return
      }
      if (e.key === 'Enter' && !skipPlainEnter) {
        e.preventDefault()
        genRef.current()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
      const i = permissionKeyStack.indexOf(token)
      if (i !== -1) permissionKeyStack.splice(i, 1)
      window.removeEventListener('keydown', onKey)
    }
  }, [active])
}

function PermissionActionFooter({
  onCancel,
  onGenerate,
  active,
  className = '',
  label = 'Approve',
}: {
  onCancel: () => void
  onGenerate: () => void
  active: boolean
  className?: string
  /** Primary action label — "Approve" for permission asks; generation cards
   *  pass "Generate". */
  label?: string
}) {
  const modKey = permissionModKey()
  usePermissionKeyboardShortcuts(onCancel, onGenerate, active)

  return (
    <div className={`flex items-center justify-end gap-1.5 pt-1 ${className}`}>
      <button type="button" onClick={onCancel} title={`Cancel (Esc or ${modKey}+.)`} className={permCancelBtnClass}>
        Cancel
        <span className="opacity-70 text-[10px]">Esc</span>
      </button>
      <button
        type="button"
        onClick={onGenerate}
        title={`${label} (Enter or ${modKey}↵)`}
        className={permGenerateBtnClass}
      >
        {label}
        <span
          className="inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums text-[#141820]/80"
          aria-hidden
        >
          <span>{modKey}</span>
          <span>↵</span>
        </span>
      </button>
    </div>
  )
}

interface Props {
  perm: PendingPermission
  onAllow: (overrides?: { provider?: string; prompt?: string; config?: Record<string, any> }) => void
  onDeny: () => void
  onAutoChoose?: (genType: string, defaults: { provider: string; config: Record<string, any> }) => void
  /** Current always-ask / always-allow / always-deny setting for this API. */
  currentMode?: PermissionMode
  /** Persist a new mode for this API (project-level apiPermissions). */
  onModeChange?: (mode: PermissionMode) => void
}

export default function GenerationConfirmCard({
  perm,
  onAllow,
  onDeny,
  onAutoChoose,
  currentMode,
  onModeChange,
}: Props) {
  const displayName =
    perm.kind === 'web_search'
      ? 'Web Search'
      : perm.kind === 'mutation_preview'
        ? // Diff-before-apply pause: title with the intercepted tool so the
          // user sees WHAT is about to mutate, not a raw 'mutation_preview' id.
          // Humanized: 'delete_scene' reads as 'delete scene'.
          `Apply edit: ${humanizeToolName(perm.toolName) ?? 'tool'}`
        : ((API_DISPLAY_NAMES as Record<string, string>)[perm.api] ?? perm.api)

  // If no rich context, render the simple card
  if (!perm.generationType) {
    return <SimplePermissionCard perm={perm} displayName={displayName} onAllow={() => onAllow()} onDeny={onDeny} />
  }

  return (
    <RichConfirmCard
      perm={perm}
      displayName={displayName}
      onAllow={onAllow}
      onDeny={onDeny}
      onAutoChoose={onAutoChoose}
      currentMode={currentMode}
      onModeChange={onModeChange}
    />
  )
}

/** The ONE resolved-state row: identical layout for Allowed and Denied —
 *  compact single-row card, status right-aligned (color is the only delta). */
function ResolvedPermissionRow({
  icon,
  title,
  meta,
  resolved,
  allowLabel = 'Allowed',
  denyLabel = 'Denied',
}: {
  icon: React.ReactNode
  title: string
  meta?: string
  resolved: 'allow' | 'deny'
  allowLabel?: string
  denyLabel?: string
}) {
  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent overflow-hidden text-[12px]">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {icon}
        <span className="text-[var(--color-text-primary)] flex-1 truncate">
          <span className="font-medium">{title}</span>
          {meta && <span className="text-[var(--color-text-muted)]"> · {meta}</span>}
        </span>
        <span className={`text-[11px] font-medium ${resolved === 'allow' ? 'text-emerald-400' : 'text-red-400'}`}>
          {resolved === 'allow' ? allowLabel : denyLabel}
        </span>
      </div>
    </div>
  )
}

// ── Simple card (backward compat) ──────────────────────────────────────────

function SimplePermissionCard({
  perm,
  displayName,
  onAllow,
  onDeny,
}: {
  perm: PendingPermission
  displayName: string
  onAllow: () => void
  onDeny: () => void
}) {
  // Plan-card idiom: light outline, transparent fill, 12px text, compact
  // header row — the heavy slate header is gone everywhere (styling pass).
  if (perm.resolved) {
    return (
      <ResolvedPermissionRow
        icon={<ShieldAlert size={11} className="text-[var(--color-text-muted)] flex-shrink-0" strokeWidth={2.25} />}
        title={displayName}
        // '$0' is noise on a diff-preview pause — cost only for paid APIs
        meta={perm.kind !== 'mutation_preview' ? perm.estimatedCost : undefined}
        resolved={perm.resolved}
      />
    )
  }

  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent overflow-hidden text-[12px]">
      {/* Single row — actions inline with the title, like the plan card header. */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <ShieldAlert size={11} className="text-[var(--color-text-muted)] flex-shrink-0" strokeWidth={2.25} />
        <span className="text-[var(--color-text-primary)] flex-1 truncate">
          <span className="font-medium">Permission required</span>
          <span className="text-[var(--color-text-muted)]"> · {displayName}</span>
          {perm.kind !== 'mutation_preview' && (
            <span className="text-[var(--color-text-muted)]"> · {perm.estimatedCost}</span>
          )}
        </span>
        <PermissionActionFooter onCancel={onDeny} onGenerate={onAllow} active className="!pt-0 flex-shrink-0" />
      </div>
    </div>
  )
}

// ── Rich generation confirmation card ──────────────────────────────────────

function RichConfirmCard({
  perm,
  displayName,
  onAllow,
  onDeny,
  onAutoChoose,
  currentMode,
  onModeChange,
}: {
  perm: PendingPermission
  displayName: string
  onAllow: (overrides?: { provider?: string; prompt?: string; config?: Record<string, any> }) => void
  onDeny: () => void
  onAutoChoose?: (genType: string, defaults: { provider: string; config: Record<string, any> }) => void
  currentMode?: PermissionMode
  onModeChange?: (mode: PermissionMode) => void
}) {
  const [selectedProvider, setSelectedProvider] = useState(perm.provider ?? '')
  const [editedPrompt, setEditedPrompt] = useState(perm.prompt ?? '')
  const [selectedConfig, setSelectedConfig] = useState<Record<string, any>>(perm.config ?? {})
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  // Local override of the displayed generation type. The actual permission
  // request still targets `perm.generationType`; flipping this only changes
  // what the pill reads. Wiring a real type swap would mean cancelling and
  // reissuing the agent call against a different API, which we don't have
  // a transport for from the renderer yet.
  const [displayedGenType, setDisplayedGenType] = useState<string>(perm.generationType ?? 'video')
  const [showGenTypeMenu, setShowGenTypeMenu] = useState(false)

  // Effective ask, resolved by the displayed gen type. When the user
  // flips the type pill, fall back to TYPE_DEFAULTS for the api,
  // provider list, default provider, and cost. The original `perm`
  // is still used for the unchanged-type case so we don't lose the
  // agent's actual provider data.
  // These must be computed before any early return so the useEffect below
  // always runs in the same hook order regardless of perm.resolved state.
  const typeChanged = displayedGenType !== (perm.generationType ?? 'video')
  const typeDefaults = TYPE_DEFAULTS[displayedGenType]
  const effectiveApi = typeChanged && typeDefaults ? typeDefaults.api : perm.api
  const availableProviders = typeChanged && typeDefaults ? typeDefaults.providers : (perm.availableProviders ?? [])

  // When the gen type pill flips (which changes `effectiveApi`), reset
  // the selected provider so the model pill, icon, and cost reflect the
  // new type's default. Keyed on `effectiveApi` (a stable string) rather
  // than the recomputed `availableProviders` array, which would loop the
  // effect on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const isValid = availableProviders.some((p) => p.id === selectedProvider)
    if (isValid) return
    const fallback = typeDefaults?.provider ?? availableProviders[0]?.id ?? perm.provider ?? ''
    if (fallback) setSelectedProvider(fallback)
  }, [effectiveApi])

  if (perm.resolved) {
    const resolvedIconName = pickProviderIconName(perm.api, selectedProvider || perm.provider)
    return (
      <ResolvedPermissionRow
        icon={
          resolvedIconName ? (
            <ProviderIcon name={resolvedIconName} size={12} className="flex-shrink-0 text-[var(--color-text-muted)]" />
          ) : (
            <ShieldAlert size={11} className="text-[var(--color-text-muted)] flex-shrink-0" strokeWidth={2.25} />
          )
        }
        title={genTypeLabel(perm.generationType)}
        resolved={perm.resolved}
      />
    )
  }

  const currentProviderInfo = availableProviders.find((p) => p.id === selectedProvider)
  const costDisplay = currentProviderInfo?.cost ?? typeDefaults?.cost ?? perm.estimatedCost ?? ''
  const isFreeProvider = currentProviderInfo?.isFree ?? typeDefaults?.providers[0]?.isFree ?? false

  // `onAutoChoose` is preserved on the Props for backwards compatibility but
  // the inline checkbox UI was replaced by the mode dropdown in the footer.
  // Callers can still hook `onAutoChoose` if they want a "remember provider
  // defaults" flow alongside the always-allow flag.
  void onAutoChoose

  const handleAllow = () => {
    const overrides: { provider?: string; prompt?: string; config?: Record<string, any> } = {}
    if (selectedProvider !== perm.provider) overrides.provider = selectedProvider
    if (editedPrompt !== perm.prompt) overrides.prompt = editedPrompt
    if (JSON.stringify(selectedConfig) !== JSON.stringify(perm.config)) overrides.config = selectedConfig

    onAllow(Object.keys(overrides).length > 0 ? overrides : undefined)
  }

  // If user switched to a free provider, auto-allow
  const handleProviderSwitch = (pid: string) => {
    setSelectedProvider(pid)
    setShowProviderMenu(false)
    setSelectedConfig({})
    const provInfo = availableProviders.find((p) => p.id === pid)
    if (provInfo?.isFree) {
      // Auto-allow for free providers
      onAllow({ provider: pid })
    }
  }

  return (
    // No `overflow-hidden` on the card: the mode dropdown anchors inside
    // the footer and would otherwise get clipped by the rounded card edge.
    // The header still gets crisp corners because nothing inside it bleeds
    // past the border.
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent text-[12px]">
      {/* Compact header — light outline, transparent fill, matches the
       * tool-call card aesthetic instead of the heavy slate-blue confirm
       * header used by the modal-style consumers of PERM_HEADER_CLASS.
       * The leading icon is the provider's mark (Ollama / OpenAI /
       * DeepMind / HeyGen / Kling / Runway / Gemini / Fal / ByteDance /
       * Midjourney) rendered as a uniformly-colored mask so the chat
       * doesn't get a stripe of mismatched brand colors. Falls back to
       * the lucide shield when no mark is mapped. */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--color-border)] rounded-t-lg text-[var(--color-text-primary)]">
        {(() => {
          // Icon keyed off the EFFECTIVE api + currently-selected provider
          // so flipping the gen type pill (Video → Image, etc.) immediately
          // swaps the leading silhouette to match the new type's default.
          const iconName = pickProviderIconName(effectiveApi, selectedProvider || perm.provider)
          return iconName ? (
            <ProviderIcon name={iconName} size={12} className="flex-shrink-0 text-[var(--color-text-muted)]" />
          ) : (
            <ShieldAlert size={11} className="text-[var(--color-text-muted)] flex-shrink-0" strokeWidth={2.25} />
          )
        })()}
        <GenTypePill
          current={displayedGenType}
          onChange={setDisplayedGenType}
          show={showGenTypeMenu}
          setShow={setShowGenTypeMenu}
        />
        <div className="flex-1" />
        {/* Provider pill — click to switch model. Reads from
         *  `availableProviders`, which is the type-defaults list when the
         *  user has flipped the gen type pill, or the original
         *  `perm.availableProviders` otherwise. The fallback label uses
         *  the effective api so the pill shows e.g. "Veo 3" → "Fal Flux"
         *  when the type changes, not the original perm's api name. */}
        <ProviderPill
          providers={availableProviders}
          selected={selectedProvider}
          onSwitch={handleProviderSwitch}
          fallbackLabel={shortApiLabel(effectiveApi)}
          fallbackCost={costDisplay}
          show={showProviderMenu}
          setShow={setShowProviderMenu}
        />
        <CostHoverButton cost={costDisplay} isFree={isFreeProvider} />
      </div>

      <div className="p-2.5 space-y-2 bg-transparent">
        {/* Provider selector lived here — moved into the card header as a
         *  pill chevron next to the model name. Keep this block empty rather
         *  than splicing the provider config blocks (avatar character, image
         *  config) up by one indent — the body still has those checks. */}

        {/* Inline editable prompt — no label, no Edit button, no outline.
         *  Reads as part of the card body; bottom fade hints at scroll for
         *  longer prompts. The textarea inherits the card's transparent bg
         *  so it doesn't paint a second box-within-a-box. */}
        {perm.prompt && (
          <div className="relative">
            <textarea
              value={editedPrompt}
              onChange={(e) => setEditedPrompt(e.target.value)}
              rows={3}
              spellCheck={false}
              className="w-full block text-[12px] leading-relaxed px-0 py-0 max-h-24 overflow-y-auto bg-transparent text-[var(--color-text-primary)] resize-none border-0 outline-none focus:outline-none focus:ring-0 placeholder:text-[var(--color-text-muted)]"
            />
            {/* Bottom fade — hints at scrollable overflow without adding a
             *  hard rule. `pointer-events-none` so it never steals clicks
             *  from the textarea below it. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[var(--color-panel)] to-transparent" />
          </div>
        )}

        {/* Provider-specific config */}
        {perm.generationType === 'avatar' && ['musetalk', 'fabric', 'aurora'].includes(selectedProvider) && (
          <div>
            <label className="text-[10px] text-[var(--color-text-muted)] uppercase font-bold tracking-tight">
              Source Image
            </label>
            <input
              type="text"
              value={selectedConfig.sourceImageUrl ?? ''}
              onChange={(e) => setSelectedConfig((prev) => ({ ...prev, sourceImageUrl: e.target.value }))}
              placeholder="Image URL"
              className="mt-0.5 w-full text-[12px] px-2.5 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none"
            />
          </div>
        )}

        {perm.generationType === 'image' && (
          <div className="flex gap-2">
            {perm.config?.style && (
              <div className="flex-1">
                <label className="text-[10px] text-[var(--color-text-muted)] uppercase font-bold tracking-tight">
                  Style
                </label>
                <p className="text-[12px] text-[var(--color-text-primary)] mt-0.5">{perm.config.style}</p>
              </div>
            )}
            {perm.config?.aspectRatio && (
              <div>
                <label className="text-[10px] text-[var(--color-text-muted)] uppercase font-bold tracking-tight">
                  Aspect
                </label>
                <p className="text-[12px] text-[var(--color-text-primary)] mt-0.5">{perm.config.aspectRatio}</p>
              </div>
            )}
          </div>
        )}

        {/* Footer: mode dropdown on the LEFT, Cancel + Generate on the RIGHT.
         *  The dropdown sets the project-level always-ask / always-allow /
         *  always-deny mode for this API so the user can stop being prompted
         *  in one click. Generate carries the slate-blue glow that signals
         *  "primary action" — same treatment as the original Create button
         *  and the original PermissionActionFooter, just compact-sized. */}
        <CompactPermissionFooter
          onCancel={onDeny}
          onGenerate={handleAllow}
          active
          currentMode={currentMode ?? 'always_ask'}
          onModeChange={onModeChange}
        />
      </div>
    </div>
  )
}

/**
 * Inline-card-sized version of `PermissionActionFooter`. Same keyboard
 * shortcuts, same semantics, half the visual weight, plus a left-side
 * mode dropdown so the user can flip this API to always-allow / always-
 * deny without leaving the chat. Lives in the same file as the rich card
 * because no other surface needs it.
 *
 * Layout:
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │  [ Always ask ▾ ]            Cancel  [Generate] │
 *   └─────────────────────────────────────────────────┘
 *
 * Generate keeps the slate-blue inner-glow treatment from the original
 * `permGenerateBtnClass`, just sized down to match the compact card.
 */
function CompactPermissionFooter({
  onCancel,
  onGenerate,
  active,
  currentMode,
  onModeChange,
}: {
  onCancel: () => void
  onGenerate: () => void
  active: boolean
  currentMode: PermissionMode
  onModeChange?: (mode: PermissionMode) => void
}) {
  const modKey = permissionModKey()
  usePermissionKeyboardShortcuts(onCancel, onGenerate, active)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const modeRef = useRef<HTMLDivElement>(null)

  // Close the mode menu on outside click. Single global listener; cleanup
  // restores the previous baseline so opening the provider menu above
  // doesn't fight with this one for the document click.
  useEffect(() => {
    if (!modeMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!modeRef.current?.contains(e.target as Node)) setModeMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [modeMenuOpen])

  const currentLabel = PERMISSION_MODE_OPTIONS.find((o) => o.value === currentMode)?.label ?? 'Always ask'

  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      {/* Left: mode dropdown. When `onModeChange` isn't wired we still
       *  show the current mode (read-only) so the user knows what the
       *  fallback behavior is, but the dropdown won't open. */}
      <div className="relative" ref={modeRef}>
        <button
          type="button"
          onClick={() => onModeChange && setModeMenuOpen((o) => !o)}
          className={`${menuTriggerClass} !text-[11px] ${onModeChange ? '' : 'cursor-default'}`}
          style={{ color: modeMenuOpen ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
        >
          {currentLabel}
          {onModeChange && <ChevronDown size={10} strokeWidth={2.5} className="opacity-70" />}
        </button>
        {modeMenuOpen && onModeChange && (
          <MenuPanel minWidth={130} onClose={() => setModeMenuOpen(false)}>
            {PERMISSION_MODE_OPTIONS.map((opt) => (
              <MenuRow
                key={opt.value}
                name={opt.label}
                selected={opt.value === currentMode}
                onClick={() => {
                  onModeChange(opt.value)
                  setModeMenuOpen(false)
                }}
              />
            ))}
          </MenuPanel>
        )}
      </div>

      {/* Right: Cancel + Generate. Generate carries the slate-blue glow. */}
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onCancel} title={`Cancel (Esc or ${modKey}+.)`} className={permCancelBtnClass}>
          Cancel
          <span className="opacity-70 text-[10px]">Esc</span>
        </button>
        <button
          type="button"
          onClick={onGenerate}
          title={`Generate (Enter or ${modKey}↵)`}
          className={permGenerateBtnClass}
        >
          Generate
          <span
            className="inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums text-[#141820]/80"
            aria-hidden
          >
            <span>{modKey}</span>
            <span>↵</span>
          </span>
        </button>
      </div>
    </div>
  )
}

// ── Menu primitives (agent-chat model-selector idiom) ───────────────────────
//
// Same visual contract as the composer's model picker
// (ComposerModelAgentControls): full-viewport click-away backdrop, panel on
// var(--color-panel) with a var(--color-border) outline + shadow-2xl, rows at
// 12.5px/450 with a 6px radius, color-mix hover, and a trailing Check on the
// selected row. Cards open DOWNWARD (the composer opens up).

function MenuPanel({
  align = 'left',
  minWidth = 160,
  onClose,
  children,
}: {
  align?: 'left' | 'right'
  minWidth?: number
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <div className="fixed inset-0 z-[90]" onClick={onClose} />
      <div
        className={`absolute top-full ${align === 'right' ? 'right-0' : 'left-0'} mt-1 z-[100] rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-top-1 duration-150`}
        style={{ minWidth, background: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
      >
        <div style={{ padding: 4 }}>{children}</div>
      </div>
    </>
  )
}

function MenuRow({
  name,
  desc,
  selected,
  onClick,
  trailing,
}: {
  name: string
  desc?: string
  selected?: boolean
  onClick: () => void
  trailing?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
      className="w-full !flex !flex-row items-center no-style cursor-pointer text-left"
      style={{
        gap: 8,
        padding: '5px 8px',
        borderRadius: 6,
        transition: 'background 0.12s ease',
        background: 'transparent',
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 450, lineHeight: 1, color: 'var(--color-text-primary)' }}>{name}</span>
      {desc && <span style={{ fontSize: 12.5, lineHeight: 1, color: 'var(--color-text-muted)' }}>{desc}</span>}
      <span style={{ flex: 1 }} />
      {trailing}
      {selected && <Check size={13} strokeWidth={2.5} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />}
    </button>
  )
}

/** Borderless pill trigger — the composer model-pill look (muted → primary on open/hover). */
const menuTriggerClass =
  'no-style !min-h-0 !h-auto !py-0.5 !px-1.5 !rounded-md !bg-transparent inline-flex items-center gap-1 !font-medium transition-colors'

// ── Header controls ──────────────────────────────────────────────────────────

/**
 * Generation-type pill on the left of the card header. Replaces the old
 * static "Video Generation" / "Image Generation" label with a chevron
 * dropdown so the user can flip the kind in place. Calls `onChange`
 * with the new value when a different option is picked. The actual
 * agent-side type swap (re-issuing the request against a different
 * API) is the parent's job — this component just owns the pill UI.
 */
function GenTypePill({
  current,
  onChange,
  show,
  setShow,
}: {
  current: string
  onChange: (next: string) => void
  show: boolean
  setShow: (s: boolean | ((p: boolean) => boolean)) => void
}) {
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setShow((o) => !o)}
        className={`${menuTriggerClass} !text-[12px]`}
        style={{ color: show ? 'var(--color-text-primary)' : 'var(--color-text-primary)' }}
      >
        {genTypeLabel(current)}
        <ChevronDown size={10} strokeWidth={2.5} className="opacity-70" />
      </button>
      {show && (
        <MenuPanel minWidth={130} onClose={() => setShow(false)}>
          {GEN_TYPE_OPTIONS.map((opt) => (
            <MenuRow
              key={opt.value}
              name={opt.label}
              selected={opt.value === current}
              onClick={() => {
                onChange(opt.value)
                setShow(false)
              }}
            />
          ))}
        </MenuPanel>
      )}
    </div>
  )
}

/**
 * Pill button + dropdown for switching the model/provider. Lives in the
 * card header next to the model-type label. Renders nothing when there
 * are no `availableProviders` since there's nothing to switch to.
 *
 * Closes on outside click and on selection. Uses the same chat-text
 * color as the surrounding header for visual continuity, with a light
 * white outline matching the rest of the card's pill controls.
 */
function ProviderPill({
  providers,
  selected,
  onSwitch,
  fallbackLabel,
  fallbackCost,
  show,
  setShow,
}: {
  providers: { id: string; name: string; cost: string; isFree?: boolean }[]
  selected: string
  onSwitch: (id: string) => void
  fallbackLabel: string
  fallbackCost: string
  show: boolean
  setShow: (s: boolean | ((p: boolean) => boolean)) => void
}) {
  // When the runner didn't enumerate alternatives, synthesize a single
  // entry from `fallbackLabel` so the dropdown always has at least the
  // current model in it. Keeps the pill clickable instead of dead.
  const displayProviders =
    providers.length > 0
      ? providers
      : [{ id: selected || 'current', name: fallbackLabel, cost: fallbackCost, isFree: false }]

  const currentName = providers.find((p) => p.id === selected)?.name ?? fallbackLabel

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setShow((o) => !o)}
        className={`${menuTriggerClass} !text-[11px] !font-semibold`}
        style={{ color: show ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
      >
        {currentName}
        <ChevronDown size={10} strokeWidth={2.5} className="opacity-70" />
      </button>
      {show && (
        <MenuPanel align="right" minWidth={180} onClose={() => setShow(false)}>
          {displayProviders.map((p) => (
            <MenuRow
              key={p.id}
              name={p.name}
              desc={p.cost || undefined}
              selected={p.id === selected}
              onClick={() => {
                if (providers.length > 0) onSwitch(p.id)
                setShow(false)
              }}
              trailing={
                p.isFree ? (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold uppercase">
                    Free
                  </span>
                ) : undefined
              }
            />
          ))}
          {providers.length === 0 && (
            <div className="px-2 py-1 text-[10px] text-[var(--color-text-muted)] italic">No alternatives available</div>
          )}
        </MenuPanel>
      )}
    </div>
  )
}

/**
 * CircleAlert icon that surfaces the cost on hover OR click (works on
 * touch devices too). The cost moved off the header text because the
 * primary header element is now the model-name pill — the cost is
 * secondary information, surfaced on demand.
 */
function CostHoverButton({ cost, isFree }: { cost: string; isFree?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div className="relative shrink-0" ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="no-style !min-h-0 !h-auto !p-1 !rounded-md !bg-transparent !text-[var(--color-text-muted)] hover:!text-[var(--color-text-primary)] inline-flex items-center transition-colors"
        aria-label="Show estimated cost"
      >
        <CircleAlert size={13} />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-[100] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl px-2 py-1 whitespace-nowrap">
          <span className="text-[11px] text-[var(--color-text-primary)] tabular-nums">{cost}</span>
          {isFree && (
            <span className="ml-1.5 text-[8px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold uppercase">
              Free
            </span>
          )}
        </div>
      )}
    </div>
  )
}
