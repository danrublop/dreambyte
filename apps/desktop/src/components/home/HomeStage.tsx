'use client'

import { useEffect, useRef, useState } from 'react'
import { useVideoStore } from '@/lib/store'
import { ChevronDown, Check, Mic, RectangleHorizontal, X } from 'lucide-react'
import { DreambyteMark } from '@/components/icons/DreambyteMark'
import { resizeImage, validateImage, MAX_IMAGE_DIMENSION } from '@/lib/image-utils'
import type { ImageAttachment } from '@/lib/agents/types'
import type { AspectRatio } from '@/lib/dimensions'
import {
  SendIcon,
  AttachMediaIcon,
  COMPOSER_CTRL_ICON,
  COMPOSER_CTRL_BG,
  MODEL_OPTIONS,
  RUN_MODE_OPTIONS,
  runModeIcon,
} from '@/components/chat/composer-shared'

const ASPECT_RATIOS: { value: AspectRatio; label: string }[] = [
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '1:1', label: '1:1' },
  { value: '4:5', label: '4:5' },
]

/** Chat-first home landing: greeting + composer. Submit creates a project and
 *  enters its Chat view, seeding the composer text + attachments into the new
 *  project's chat. The control row mirrors AgentChat's
 *  editor composer — run-mode and model pills are wired to the same global
 *  store state, so choices made here carry into the project chat. */
export default function HomeStage() {
  const createNewProject = useVideoStore((s) => s.createNewProject)
  const setPendingComposerAttachments = useVideoStore((s) => s.setPendingComposerAttachments)
  const setPendingComposerText = useVideoStore((s) => s.setPendingComposerText)
  const agentRunMode = useVideoStore((s) => s.agentRunMode)
  const setAgentRunMode = useVideoStore((s) => s.setAgentRunMode)
  const modelTier = useVideoStore((s) => s.modelTier)
  const setModelTier = useVideoStore((s) => s.setModelTier)
  const modelOverride = useVideoStore((s) => s.modelOverride)
  const setModelOverride = useVideoStore((s) => s.setModelOverride)
  const modelConfigs = useVideoStore((s) => s.modelConfigs)
  const localMode = useVideoStore((s) => s.localMode)
  const setLocalMode = useVideoStore((s) => s.setLocalMode)
  const localModelId = useVideoStore((s) => s.localModelId)

  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [aspectRatio, setAspectRatio] = useState<AspectRatio | null>(null)
  const [aspectOpen, setAspectOpen] = useState(false)
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const aspectMenuRef = useRef<HTMLDivElement>(null)
  const aspectToggleRef = useRef<HTMLButtonElement>(null)

  // Mirror of AgentChat's current-model derivation (override > CLI > tier).
  const localModel = localMode && localModelId ? modelConfigs.find((m) => m.id === localModelId) : null
  const overrideModel = !localMode && modelOverride ? modelConfigs.find((m) => m.modelId === modelOverride) : null
  const currentModelName = localMode
    ? (localModel?.displayName ?? 'Local')
    : modelOverride === 'codex-cli'
      ? 'Codex CLI'
      : modelOverride === 'claude-code'
        ? 'Claude Code'
        : (overrideModel?.displayName ?? (MODEL_OPTIONS.find((m) => m.id === modelTier) ?? MODEL_OPTIONS[0]).modelName)

  // Close the aspect popover on outside click or Escape (Escape also returns
  // focus to the trigger so keyboard users aren't stranded).
  useEffect(() => {
    if (!aspectOpen) return
    const onClick = (e: MouseEvent) => {
      if (aspectMenuRef.current && !aspectMenuRef.current.contains(e.target as Node)) setAspectOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAspectOpen(false)
        aspectToggleRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [aspectOpen])

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return
    const next: ImageAttachment[] = []
    for (const file of Array.from(files)) {
      if (!validateImage(file).valid) continue
      try {
        const resized = await resizeImage(file, MAX_IMAGE_DIMENSION)
        next.push({
          dataUri: resized.dataUri,
          mimeType: resized.mimeType as ImageAttachment['mimeType'],
          fileName: file.name,
          width: resized.width,
          height: resized.height,
        })
      } catch {
        // skip files that fail to process
      }
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next])
  }

  const submit = async () => {
    if ((!val.trim() && attachments.length === 0) || busy) return
    setBusy(true)
    try {
      // Stage the composer text + attachments so the new project's chat composer
      // picks them up on mount. Must be set BEFORE
      // createNewProject flips the view and mounts AgentChat. We do NOT auto-send
      // (no submit pipeline exists from home) — the text lands in the chat input
      // and the user presses Enter, so nothing is silently lost.
      if (attachments.length > 0) setPendingComposerAttachments(attachments)
      if (val.trim()) setPendingComposerText(val)
      // createNewProject sets activeProjectId + appView='project' and preserves
      // the current projectView, so submitting from the Chat hero lands in chat
      // and from the Editor hero lands in the editor of the brand-new project.
      // The chosen aspect ratio feeds the new project's dimensions.
      await createNewProject(undefined, aspectRatio ?? undefined)
    } finally {
      setBusy(false)
    }
  }

  const RunModeIcon = runModeIcon(agentRunMode)
  const canSend = !!val.trim() || attachments.length > 0

  const menuRow = (opts: {
    key: string
    label: string
    desc?: string
    Icon?: import('lucide-react').LucideIcon
    selected: boolean
    onClick: () => void
  }) => (
    <button
      key={opts.key}
      onClick={opts.onClick}
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
      {opts.Icon && <opts.Icon size={14} strokeWidth={2} className="flex-shrink-0" />}
      <span style={{ fontSize: 12.5, fontWeight: 450, lineHeight: 1, color: 'var(--color-text-primary)' }}>
        {opts.label}
      </span>
      {opts.desc && (
        <span style={{ fontSize: 12.5, lineHeight: 1, color: 'var(--color-text-muted)' }}>{opts.desc}</span>
      )}
      <span style={{ flex: 1 }} />
      {opts.selected && (
        <Check size={13} strokeWidth={2.5} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
      )}
    </button>
  )

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-[8vh]">
      <div className="mb-7 flex items-center gap-0">
        <DreambyteMark size={110} className="text-[var(--ink)]" />
        <h1 className="text-[34px] font-semibold tracking-[-0.6px] text-[var(--ink)]">dreambyte agent</h1>
      </div>

      <div
        className="w-full max-w-[680px] rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--card)] p-3.5 focus-within:border-[var(--accent)]"
        style={{ boxShadow: 'var(--shadow-md)' }}
      >
        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Describe your video, paste a script, or drop footage…"
          rows={2}
          className="min-h-[48px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--mute)]"
        />

        {/* Staged attachment thumbnails */}
        {attachments.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-2">
            {attachments.map((att, i) => (
              <div key={i} className="relative">
                <img
                  src={att.dataUri}
                  alt={att.fileName ?? 'Attachment'}
                  className="h-12 w-12 rounded-md border border-[var(--hairline)] object-cover"
                />
                <button
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  aria-label="Remove attachment"
                  className="no-style absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-[var(--ink)] text-[var(--on-action)]"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {/* ── Run mode pill (Auto / Plan / Sandbox / Ask) — same as editor composer ── */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowAgentMenu(!showAgentMenu)
                  setShowModelMenu(false)
                }}
                className={`no-style !flex items-center gap-1 px-2.5 transition-all rounded-full whitespace-nowrap h-7 box-border ${
                  showAgentMenu
                    ? 'bg-[var(--color-bg)] border border-[var(--color-border)]/50'
                    : 'bg-[var(--color-bg)]/80 border border-[var(--color-border)]/30 hover:border-[var(--color-border)]'
                }`}
                style={{ color: 'var(--color-text-muted)' }}
                title="Agent options"
              >
                <RunModeIcon size={18} strokeWidth={2.5} />
                <ChevronDown size={10} strokeWidth={2.5} className="opacity-70" />
              </button>
              {showAgentMenu && (
                <>
                  <div className="fixed inset-0 z-[90]" onClick={() => setShowAgentMenu(false)} />
                  <div
                    className="absolute bottom-[calc(100%+8px)] left-0 z-[100] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-lg shadow-2xl flex flex-col w-max min-w-[180px] animate-in slide-in-from-bottom-1 duration-150"
                    style={{ padding: 4 }}
                  >
                    {RUN_MODE_OPTIONS.map(([mode, label, Icon]) =>
                      menuRow({
                        key: mode,
                        label,
                        Icon,
                        selected: agentRunMode === mode,
                        onClick: () => {
                          setAgentRunMode(mode)
                          setShowAgentMenu(false)
                        },
                      }),
                    )}
                  </div>
                </>
              )}
            </div>

            {/* ── Model pill — same as editor composer ── */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowModelMenu(!showModelMenu)
                  setShowAgentMenu(false)
                }}
                className="no-style !flex items-center gap-1 px-1.5 transition-all rounded-md whitespace-nowrap h-7 border border-transparent box-border"
                style={{ color: showModelMenu ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
              >
                <span className="font-semibold text-sm leading-none">{currentModelName}</span>
                <ChevronDown size={10} strokeWidth={2.5} className="opacity-70" />
              </button>
              {showModelMenu && (
                <>
                  <div className="fixed inset-0 z-[90]" onClick={() => setShowModelMenu(false)} />
                  <div
                    className="absolute bottom-[calc(100%+8px)] left-0 z-[100] rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-bottom-1 duration-150"
                    style={{ minWidth: 230, background: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
                  >
                    {/* Tier presets (Auto / Premium / Budget) */}
                    <div style={{ padding: 4 }}>
                      {MODEL_OPTIONS.map((opt) =>
                        menuRow({
                          key: opt.id,
                          label: opt.modelName,
                          desc: opt.tierLabel,
                          selected: modelTier === opt.id && !modelOverride && !localMode,
                          onClick: () => {
                            setModelTier(opt.id)
                            setModelOverride(null)
                            setLocalMode(false)
                            setShowModelMenu(false)
                          },
                        }),
                      )}
                    </div>
                    {/* Models */}
                    <div style={{ borderTop: '1px solid var(--color-border)', padding: 4 }}>
                      {modelConfigs
                        .filter((m) => m.enabled && m.provider !== 'local')
                        .map((m) =>
                          menuRow({
                            key: m.id,
                            label: m.displayName,
                            desc: m.tier,
                            selected: modelOverride === m.modelId,
                            onClick: () => {
                              setModelOverride(m.modelId as any)
                              setLocalMode(false)
                              setShowModelMenu(false)
                            },
                          }),
                        )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── Attach / aspect / voice / send — same control row as the editor composer ── */}
          <div className="flex items-center flex-shrink-0 gap-1.5 text-[var(--color-text-muted)]">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                void onPickFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              className="no-style flex items-center justify-center cursor-pointer"
              style={{ width: 26, height: 26, color: COMPOSER_CTRL_ICON }}
              data-tooltip="Attach files"
              data-tooltip-pos="top"
            >
              <AttachMediaIcon size={17} />
            </button>

            <div className="relative" ref={aspectMenuRef}>
              <button
                ref={aspectToggleRef}
                type="button"
                onClick={() => setAspectOpen((o) => !o)}
                aria-label="Aspect ratio"
                aria-haspopup="menu"
                aria-expanded={aspectOpen}
                className="no-style flex items-center justify-center gap-1 cursor-pointer"
                style={{ minWidth: 26, height: 26, color: COMPOSER_CTRL_ICON }}
                data-tooltip={aspectRatio ? `Aspect ratio: ${aspectRatio}` : 'Aspect ratio'}
                data-tooltip-pos="top"
              >
                <RectangleHorizontal size={17} />
                {aspectRatio && <span className="text-[11px] font-medium">{aspectRatio}</span>}
              </button>
              {aspectOpen && (
                <div
                  role="menu"
                  className="absolute bottom-[calc(100%+8px)] right-0 z-[100] w-[120px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
                  style={{ padding: 4 }}
                >
                  {ASPECT_RATIOS.map((ar) =>
                    menuRow({
                      key: ar.value,
                      label: ar.label,
                      selected: aspectRatio === ar.value,
                      onClick: () => {
                        setAspectRatio(ar.value)
                        setAspectOpen(false)
                      },
                    }),
                  )}
                </div>
              )}
            </div>

            {canSend ? (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy}
                aria-label="Send"
                className="flex items-center justify-center transition-all cursor-pointer no-style rounded-full disabled:opacity-40"
                style={{
                  width: 26,
                  height: 26,
                  backgroundColor: COMPOSER_CTRL_BG,
                  padding: 0,
                  color: COMPOSER_CTRL_ICON,
                }}
                data-tooltip="Start"
                data-tooltip-pos="top"
              >
                <SendIcon size={20} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Voice input"
                className="flex items-center justify-center transition-all no-style rounded-full cursor-pointer"
                style={{
                  width: 26,
                  height: 26,
                  backgroundColor: COMPOSER_CTRL_BG,
                  padding: 0,
                  color: COMPOSER_CTRL_ICON,
                }}
                data-tooltip="Voice input"
                data-tooltip-pos="top"
              >
                <Mic size={16} strokeWidth={2} className="opacity-90" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
