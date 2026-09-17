'use client'

import {
  ChevronDown,
  Check,
  Infinity as InfinityIcon,
  ListOrdered,
  Box,
  MessageSquare,
  Settings2,
  Eye,
} from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { MODEL_OPTIONS } from './composer-shared'

interface ComposerModelAgentControlsProps {
  currentModel: { modelName: string }
  showAgentMenu: boolean
  setShowAgentMenu: (v: boolean) => void
  showModelMenu: boolean
  setShowModelMenu: (v: boolean) => void
  setShowSpeechLangMenu: (v: boolean) => void
}

/**
 * The composer's agent run-mode pill + model pill and their dropdown menus
 * (S2 slice 5a). Selection state (run mode, model tier/override, local mode,
 * model configs) is store-backed and read directly; the menu-open flags are
 * props because the voice control coordinates closing them. Extracted verbatim
 * from AgentChat — no visual or behavior change.
 */
export function ComposerModelAgentControls({
  currentModel,
  showAgentMenu,
  setShowAgentMenu,
  showModelMenu,
  setShowModelMenu,
  setShowSpeechLangMenu,
}: ComposerModelAgentControlsProps) {
  const agentRunMode = useVideoStore((s) => s.agentRunMode)
  const setAgentRunMode = useVideoStore((s) => s.setAgentRunMode)
  const setContentView = useVideoStore((s) => s.setContentView)
  const setSettingsSection = useVideoStore((s) => s.setSettingsSection)
  const localMode = useVideoStore((s) => s.localMode)
  const modelTier = useVideoStore((s) => s.modelTier)
  const setModelTier = useVideoStore((s) => s.setModelTier)
  const modelOverride = useVideoStore((s) => s.modelOverride)
  const setModelOverride = useVideoStore((s) => s.setModelOverride)
  const setLocalMode = useVideoStore((s) => s.setLocalMode)
  const modelConfigs = useVideoStore((s) => s.modelConfigs)
  const previewMode = useVideoStore((s) => s.previewMode)
  const setPreviewMode = useVideoStore((s) => s.setPreviewMode)
  return (
    <div className="flex items-center gap-2">
      {/* ── 1. Agent Mode Selection ── */}
      <div className="relative">
        <button
          onClick={() => {
            setShowAgentMenu(!showAgentMenu)
            setShowModelMenu(false)
            setShowSpeechLangMenu(false)
          }}
          className={`no-style !flex items-center gap-1 px-2.5 transition-all rounded-full whitespace-nowrap h-7 box-border ${
            showAgentMenu
              ? 'bg-[var(--color-bg)] border border-[var(--color-border)]/50'
              : 'bg-[var(--color-bg)]/80 border border-[var(--color-border)]/30 hover:border-[var(--color-border)]'
          }`}
          style={{ color: 'var(--color-text-muted)' }}
          title="Agent options"
        >
          {(() => {
            const RunModeIcon =
              agentRunMode === 'auto'
                ? InfinityIcon
                : agentRunMode === 'plan'
                  ? ListOrdered
                  : agentRunMode === 'sandbox'
                    ? Box
                    : MessageSquare
            return <RunModeIcon size={18} strokeWidth={2.5} />
          })()}
          {previewMode !== 'off' && (
            <Eye
              size={12}
              strokeWidth={2.5}
              style={{ color: 'var(--color-text-primary)' }}
              aria-label={`Preview edits: ${previewMode === 'always' ? 'always' : 'destructive only'}`}
            />
          )}
          <ChevronDown size={10} strokeWidth={2.5} className="opacity-70" />
        </button>

        {showAgentMenu && (
          <>
            <div className="fixed inset-0 z-[90]" onClick={() => setShowAgentMenu(false)} />
            <div
              className="absolute bottom-[calc(100%+8px)] left-0 z-[100] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-lg shadow-2xl flex flex-col w-max min-w-[180px] animate-in slide-in-from-bottom-1 duration-150"
              style={{ padding: 4 }}
            >
              {/* Run mode picker (Auto / Plan / Sandbox / Ask) */}
              {(
                [
                  ['auto', 'Auto', InfinityIcon],
                  ['plan', 'Plan', ListOrdered],
                  ['sandbox', 'Sandbox', Box],
                  ['ask', 'Ask', MessageSquare],
                ] as const
              ).map(([mode, label, Icon]) => {
                const active = agentRunMode === mode
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      setAgentRunMode(mode)
                      setShowAgentMenu(false)
                    }}
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
                    <Icon
                      size={14}
                      strokeWidth={2}
                      className="flex-shrink-0"
                      style={{ color: 'var(--color-text-muted)' }}
                    />
                    <span
                      className="flex-1 whitespace-nowrap"
                      style={{
                        fontSize: 12.5,
                        fontWeight: 450,
                        lineHeight: 1,
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {label}
                    </span>
                    {active && (
                      <Check
                        size={13}
                        strokeWidth={2.5}
                        className="flex-shrink-0"
                        style={{ color: 'var(--color-text-muted)' }}
                      />
                    )}
                  </button>
                )
              })}
              {/* Diff-before-apply control for the previewMode backend
                                  (world gate in tool-executor + the mutation_preview
                                  permission pause + __previewApproved resume).
                                  Same row vocabulary as the run-mode picker above. */}
              <div
                style={{
                  height: 1,
                  margin: '4px 4px',
                  background: 'var(--color-border)',
                }}
              />
              <div
                className="uppercase"
                style={{
                  padding: '4px 8px 2px',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  lineHeight: 1,
                  color: 'var(--color-text-muted)',
                }}
              >
                Preview edits
              </div>
              {(
                [
                  ['off', 'Off', 'apply immediately'],
                  ['destructive-only', 'Destructive', 'pause before destructive edits'],
                  ['always', 'Always', 'pause before every edit'],
                ] as const
              ).map(([mode, label, desc]) => {
                const active = previewMode === mode
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      setPreviewMode(mode)
                      setShowAgentMenu(false)
                    }}
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
                    <span
                      className="whitespace-nowrap"
                      style={{
                        fontSize: 12.5,
                        fontWeight: 450,
                        lineHeight: 1,
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {label}
                    </span>
                    <span
                      className="whitespace-nowrap"
                      style={{ fontSize: 12.5, lineHeight: 1, color: 'var(--color-text-muted)' }}
                    >
                      {desc}
                    </span>
                    <span style={{ flex: 1 }} />
                    {active && (
                      <Check
                        size={13}
                        strokeWidth={2.5}
                        className="flex-shrink-0"
                        style={{ color: 'var(--color-text-muted)' }}
                      />
                    )}
                  </button>
                )
              })}
              {/* Shortcut to the Agents section of Settings (thinking,
                                  local mode, skills & rules). */}
              <div
                style={{
                  height: 1,
                  margin: '4px 4px',
                  background: 'var(--color-border)',
                }}
              />
              <button
                onClick={() => {
                  setShowAgentMenu(false)
                  setContentView('settings')
                  setSettingsSection('agents')
                }}
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
                <Settings2
                  size={14}
                  strokeWidth={2}
                  className="flex-shrink-0"
                  style={{ color: 'var(--color-text-muted)' }}
                />
                <span
                  className="flex-1 whitespace-nowrap"
                  style={{
                    fontSize: 12.5,
                    fontWeight: 450,
                    lineHeight: 1,
                    color: 'var(--color-text-primary)',
                  }}
                >
                  Agent settings
                </span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── 2. Model Selection ── */}
      <div className="relative">
        <button
          onClick={() => {
            setShowModelMenu(!showModelMenu)
            setShowAgentMenu(false)
            setShowSpeechLangMenu(false)
          }}
          className="no-style !flex items-center gap-1 px-1.5 transition-all rounded-md whitespace-nowrap h-7 border border-transparent box-border"
          style={{ color: showModelMenu ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
        >
          {localMode && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: '1px 4px',
                borderRadius: 3,
                background: 'rgba(74,222,128,0.15)',
                color: '#4ade80',
                border: '1px solid rgba(74,222,128,0.3)',
                lineHeight: 1,
              }}
            >
              LOCAL
            </span>
          )}
          <span className="font-semibold text-sm leading-none">{currentModel.modelName}</span>
          <ChevronDown size={10} strokeWidth={2.5} className="opacity-70" />
        </button>

        {showModelMenu && (
          <>
            <div className="fixed inset-0 z-[90]" onClick={() => setShowModelMenu(false)} />
            <div
              className="absolute bottom-[calc(100%+8px)] left-0 z-[100] rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-bottom-1 duration-150"
              style={{
                minWidth: 230,
                background: 'var(--color-panel)',
                border: '1px solid var(--color-border)',
              }}
            >
              {/* Flat model picker (Auto / tiers / models / Add) */}
              {(() => {
                const renderRow = (r: {
                  key: string
                  name: string
                  desc?: string
                  selected?: boolean
                  muted?: boolean
                  onClick: () => void
                }) => (
                  <button
                    key={r.key}
                    onClick={r.onClick}
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
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 450,
                        lineHeight: 1,
                        color: r.muted ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
                      }}
                    >
                      {r.name}
                    </span>
                    {r.desc && (
                      <span style={{ fontSize: 12.5, lineHeight: 1, color: 'var(--color-text-muted)' }}>{r.desc}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {r.selected && (
                      <Check size={13} strokeWidth={2.5} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
                    )}
                  </button>
                )
                return (
                  <>
                    {/* Tier presets (Auto / Premium / Budget) */}
                    <div style={{ padding: 4 }}>
                      {MODEL_OPTIONS.map((opt) =>
                        renderRow({
                          key: opt.id,
                          name: opt.modelName,
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
                    {/* Models (incl. CLI runtimes as rows) */}
                    <div style={{ borderTop: '1px solid var(--color-border)', padding: 4 }}>
                      {modelConfigs
                        .filter((m) => m.enabled && m.provider !== 'local')
                        .map((m) =>
                          renderRow({
                            key: m.id,
                            name: m.displayName,
                            desc: m.tier,
                            selected: modelOverride === m.modelId,
                            onClick: () => {
                              setModelOverride(m.modelId as any)
                              setLocalMode(false)
                              setShowModelMenu(false)
                            },
                          }),
                        )}
                      {renderRow({
                        key: 'codex-cli',
                        name: 'Codex CLI',
                        desc: 'Local CLI',
                        selected: modelOverride === 'codex-cli',
                        onClick: () => {
                          setModelOverride('codex-cli' as any)
                          setLocalMode(false)
                          setShowModelMenu(false)
                        },
                      })}
                      {renderRow({
                        key: 'claude-code',
                        name: 'Claude Code',
                        desc: 'Local CLI',
                        selected: modelOverride === 'claude-code',
                        onClick: () => {
                          setModelOverride('claude-code' as any)
                          setLocalMode(false)
                          setShowModelMenu(false)
                        },
                      })}
                    </div>
                    {/* Add Models */}
                    <div style={{ borderTop: '1px solid var(--color-border)', padding: 4 }}>
                      {renderRow({
                        key: 'add-models',
                        name: 'Add Models',
                        muted: true,
                        onClick: () => {
                          setShowModelMenu(false)
                          setContentView('settings')
                          setSettingsSection('models')
                        },
                      })}
                    </div>
                  </>
                )
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
