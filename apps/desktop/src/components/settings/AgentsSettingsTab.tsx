'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Film,
  Scissors,
  Palette,
  Zap,
  PenLine,
  Paintbrush,
  Sparkles,
  Box,
  BarChart2,
  Terminal,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowUpRight,
  Copy,
  Check,
  Plug,
} from 'lucide-react'
import { DreambyteLogo as AgentIconLogo } from '../icons/DreambyteLogo'
import { useVideoStore } from '@/lib/store'
import { copyText } from '@/lib/utils/copy-text'
import { SectionLabel, ListContainer, Switch, Segmented, KeyInputRow } from './shared'
import type { ThinkingMode } from '@/lib/agents/types'
import type { LucideProps } from 'lucide-react'
import type { ForwardRefExoticComponent, RefAttributes } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

export type LucideIcon = ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>

export const ICON_MAP: Record<string, any> = {
  infinity: AgentIconLogo,
  film: Film,
  zap: Zap,
  scissors: Scissors,
  palette: Palette,
  'pen-line': PenLine,
  paintbrush: Paintbrush,
  sparkles: Sparkles,
  box: Box,
  'bar-chart-2': BarChart2,
}

// ── Shared Subcomponents ─────────────────────────────────────────────────────
// SectionLabel and ListContainer imported from ./shared

function AgentIcon({ icon, size = 14, className }: { icon: string; size?: number; className?: string }) {
  const Icon = (ICON_MAP[icon] ?? Zap) as LucideIcon
  return <Icon size={size} className={className} />
}

// ── External CLI Detection ────────────────────────────────────────────────────

type CliStatus = {
  installed: boolean
  version: string | null
  path: string | null
}

function CliRow({
  label,
  description,
  installUrl,
  modelId,
  status,
  loading,
  onRefresh,
}: {
  label: string
  description: string
  installUrl: string
  /** Matches `modelConfigs[x].modelId` — the string the runner uses to route via CLI. */
  modelId: 'claude-code' | 'codex-cli'
  status: CliStatus | null
  loading: boolean
  onRefresh: () => void
}) {
  const { modelConfigs, setModelConfigs } = useVideoStore()
  const installed = !!status?.installed
  const modelCfg = modelConfigs.find((m) => m.modelId === modelId)
  const connected = !!modelCfg?.enabled
  const [working, setWorking] = useState(false)

  const handleToggle = async () => {
    if (!installed && !connected) {
      // Can't connect what isn't installed. Shouldn't be reachable — button
      // is rendered as Install link in that state — but belt + suspenders.
      return
    }
    setWorking(true)
    try {
      const next = !connected
      setModelConfigs(modelConfigs.map((m) => (m.modelId === modelId ? { ...m, enabled: next } : m)))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
            connected
              ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
              : installed
                ? 'bg-emerald-400/10 text-[var(--success)]'
                : 'bg-[var(--color-bg)] text-[var(--color-text-muted)]'
          }`}
        >
          <Terminal size={15} />
        </div>
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[13px] font-medium text-[var(--color-text-primary)] truncate leading-none">
              {label}
            </span>
            {loading ? (
              <Loader2 size={10} className="animate-spin text-[var(--color-text-muted)]" />
            ) : connected ? (
              <span className="flex items-center gap-1 text-[11px] px-1 font-bold bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/30 rounded uppercase tracking-tighter">
                <CheckCircle2 size={9} />
                connected
              </span>
            ) : installed ? (
              <span className="flex items-center gap-1 text-[11px] px-1 font-bold bg-emerald-400/10 text-[var(--success)] border border-emerald-400/20 rounded uppercase tracking-tighter">
                <CheckCircle2 size={9} />
                detected
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] px-1 font-bold bg-[var(--card)] text-[var(--mute)] border border-[var(--hairline)] rounded uppercase tracking-tighter">
                <XCircle size={9} />
                not found
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] truncate">
            {connected
              ? `Available in the chat model picker. Runs go through your CLI subprocess.`
              : installed
                ? `${status?.version ?? 'unknown version'}${status?.path ? ` · ${status.path}` : ''}`
                : description}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        {!loading && !installed && (
          <>
            <a
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              className="no-style flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
            >
              Install
              <ArrowUpRight size={12} />
            </a>
            <button
              onClick={onRefresh}
              title="Re-check after installing"
              className="no-style flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg bg-[var(--color-panel)] text-[var(--color-text-primary)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] transition-colors"
            >
              Open
              <ArrowUpRight size={12} />
            </button>
          </>
        )}
        {!loading && installed && (
          <button
            onClick={handleToggle}
            disabled={working}
            className={`no-style flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-all disabled:opacity-60 ${
              connected
                ? 'bg-[var(--color-panel)] text-[var(--color-text-primary)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)]'
                : 'bg-[var(--color-accent)] text-white hover:opacity-90'
            }`}
          >
            {connected ? 'Disconnect' : 'Connect'}
            <ArrowUpRight size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

function ExternalCliSection() {
  const [status, setStatus] = useState<{ claudeCode: CliStatus | null; codex: CliStatus | null }>({
    claudeCode: null,
    codex: null,
  })
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const api = typeof window !== 'undefined' ? (window as any).dreambyteApi?.agents : undefined
    if (!api?.detectCli) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await api.detectCli()
      setStatus({ claudeCode: res.claudeCode, codex: res.codex })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await refresh()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // Hide section entirely in the web build — the IPC bridge is the only path
  // to detection and there's no value shipping a permanently-loading row.
  if (typeof window !== 'undefined' && !(window as any).dreambyteApi?.agents) {
    return null
  }

  return (
    <div>
      <SectionLabel>External CLIs</SectionLabel>
      <p className="text-[11px] text-[var(--color-text-muted)] mb-3 leading-snug" style={{ lineHeight: 1.4 }}>
        Route an agent run through your own installed CLI. Your CLI's subscription / API key pays the bill, Dreambyte
        doesn't. Connected CLIs appear in the chat model picker alongside API-hosted models.
      </p>
      <ListContainer>
        <CliRow
          label="Claude Code"
          description="Install, then Refresh so the Settings panel picks it up."
          installUrl="https://docs.anthropic.com/en/docs/claude-code/setup"
          modelId="claude-code"
          status={status.claudeCode}
          loading={loading}
          onRefresh={refresh}
        />
        <CliRow
          label="Codex CLI"
          description="OpenAI's Codex command-line agent. Install, then Refresh."
          installUrl="https://github.com/openai/codex"
          modelId="codex-cli"
          status={status.codex}
          loading={loading}
          onRefresh={refresh}
        />
      </ListContainer>
    </div>
  )
}

// ── One-click MCP install ─────────────────────────────────────────────────────

type McpInstallInfo = {
  serverName: string
  connectorPath: string
  claudeCodeCommand: string
  codexCommand: string
  jsonSnippet: string
}

/** Copy-to-clipboard button with a transient "copied" tick (CopyButton). */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    // copyText covers navigator.clipboard + the native Electron bridge; on
    // failure the selectable text below remains as a manual fallback.
    if (await copyText(value)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }
  return (
    <button
      onClick={copy}
      title={copied ? 'Copied' : label}
      className="no-style flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-muted)]"
    >
      {copied ? <Check size={12} className="text-[var(--success)]" /> : <Copy size={12} />}
      {copied ? 'Copied' : label}
    </button>
  )
}

/** A labelled card with a monospace snippet + copy button. */
function McpClientCard({ title, subtitle, snippet }: { title: string; subtitle: string; snippet: string }) {
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--color-text-primary)]">{title}</div>
          <p className="text-[11px] text-[var(--color-text-muted)]">{subtitle}</p>
        </div>
        <CopyButton value={snippet} label="Copy" />
      </div>
      <pre className="custom-scrollbar overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-text-primary)]">
        <code>{snippet}</code>
      </pre>
    </div>
  )
}

function McpInstallSection() {
  const [info, setInfo] = useState<McpInstallInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const api = typeof window !== 'undefined' ? (window as any).dreambyteApi?.agents : undefined
      if (!api?.mcpInstallInfo) {
        setLoading(false)
        return
      }
      try {
        const res = await api.mcpInstallInfo()
        if (!cancelled) setInfo(res)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Electron-only: the connector path comes from the main process.
  if (typeof window !== 'undefined' && !(window as any).dreambyteApi?.agents) return null
  if (loading || !info) return null

  return (
    <div>
      <SectionLabel>Connect AI clients (MCP)</SectionLabel>
      <p className="text-[11px] text-[var(--color-text-muted)] mb-3 leading-snug" style={{ lineHeight: 1.4 }}>
        Dreambyte exposes this project as an MCP server so an external agent can drive your timeline. Add it to any
        client below — the app must be running for the connection to work.
      </p>
      <ListContainer>
        <McpClientCard title="Claude Code" subtitle="Run once in your terminal" snippet={info.claudeCodeCommand} />
        <McpClientCard title="Codex" subtitle="Run once in your terminal" snippet={info.codexCommand} />
        <McpClientCard title="Cursor" subtitle="Merge into ~/.cursor/mcp.json" snippet={info.jsonSnippet} />
        <McpClientCard
          title="Claude Desktop"
          subtitle="Settings → Developer → Edit Config, merge into mcpServers"
          snippet={info.jsonSnippet}
        />
      </ListContainer>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
        <Plug size={11} />
        Server name: <span className="font-mono text-[var(--color-text-primary)]">{info.serverName}</span>
      </div>
    </div>
  )
}

// ── Main Tab Component ────────────────────────────────────────────────────────

const THINKING_OPTIONS: { value: ThinkingMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'deep', label: 'Deep' },
]

export default function AgentsSettingsTab() {
  const thinkingMode = useVideoStore((s) => s.thinkingMode)
  const setThinkingMode = useVideoStore((s) => s.setThinkingMode)
  const localMode = useVideoStore((s) => s.localMode)
  const setLocalMode = useVideoStore((s) => s.setLocalMode)
  const modelConfigs = useVideoStore((s) => s.modelConfigs)
  const researchModelId = useVideoStore((s) => s.researchModelId)
  const setResearchModelId = useVideoStore((s) => s.setResearchModelId)
  // Research-model candidates: any enabled model cheap enough to run the loop
  // for free/near-free — local (Ollama, $0) plus the cheap tool-capable cloud
  // providers. The frontier run model is the "Inherit" default, not listed here.
  const RESEARCH_PROVIDERS = new Set(['local', 'deepseek', 'kimi', 'qwen', 'moonshot', 'dashscope'])
  const researchModels = modelConfigs.filter((m) => m.enabled && RESEARCH_PROVIDERS.has(m.provider))
  const webSearchEnabled = useVideoStore((s) => s.webSearchEnabled)
  const setWebSearchEnabled = useVideoStore((s) => s.setWebSearchEnabled)
  const aiQualityReview = useVideoStore((s) => s.aiQualityReview)
  const setAiQualityReview = useVideoStore((s) => s.setAiQualityReview)
  const subAgents = useVideoStore((s) => s.subAgents)
  const setSubAgents = useVideoStore((s) => s.setSubAgents)
  const inlineDiffsEnabled = useVideoStore((s) => s.inlineDiffsEnabled)
  const setInlineDiffsEnabled = useVideoStore((s) => s.setInlineDiffsEnabled)
  const webFetchEnabled = useVideoStore((s) => s.webFetchEnabled)
  const setWebFetchEnabled = useVideoStore((s) => s.setWebFetchEnabled)
  const autoAcceptWebSearch = useVideoStore((s) => s.autoAcceptWebSearch)
  const setAutoAcceptWebSearch = useVideoStore((s) => s.setAutoAcceptWebSearch)

  return (
    <div className="space-y-6">
      {/* Single-agent identity */}
      <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--panel)] px-4 py-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
          <AgentIcon icon="infinity" size={18} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--ink)]">Master Builder</div>
          <p className="mt-0.5 text-[12px] leading-snug text-[var(--mute)]">
            You work with one agent — it researches, plans, builds, and edits. Tailor how it behaves with{' '}
            <strong className="font-medium text-[var(--ink)]">Skills &amp; Rules</strong>; there are no separate agent
            personas.
          </p>
        </div>
      </div>

      {/* Thinking */}
      <div>
        <SectionLabel>Thinking</SectionLabel>
        <p className="mb-2 text-[11px] leading-snug text-[var(--color-text-muted)]">
          How hard the agent reasons before acting. Deeper thinking is slower but stronger on complex builds.
        </p>
        <Segmented options={THINKING_OPTIONS} value={thinkingMode} onChange={setThinkingMode} />
      </div>

      {/* Local mode */}
      <div>
        <SectionLabel>Local mode</SectionLabel>
        <ListContainer>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">Run on a local model</div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Prefer your local (Ollama) model and free providers — no API cost. Disables extended thinking.
              </p>
            </div>
            <Switch checked={localMode} onChange={() => setLocalMode(!localMode)} ariaLabel="Local mode" />
          </div>
        </ListContainer>
      </div>

      {/* Deep research model — which model runs the multi-hop research loop.
          Inherit = the run's (frontier) model does research; pick a local model
          to run all research on Ollama for $0 tokens. Search is free too when
          SEARXNG_URL is set (else it falls back to Tavily). */}
      <div>
        <SectionLabel>Deep research</SectionLabel>
        <ListContainer>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">Research model</div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Which model runs the deep-research loop (plan → search → read → synthesize). <strong>Auto</strong> uses
                DeepSeek V4 Flash + SearXNG when both are configured (near-free, proven) and falls back to the run model
                otherwise. Or pin a specific model — a local Ollama model (e.g. Tongyi DeepResearch) or a cheap cloud
                model (DeepSeek/Kimi/Qwen) — or Inherit to always research on the run model.
              </p>
            </div>
            <select
              className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--panel)] px-2 py-1.5 text-[12px] text-[var(--color-text-primary)]"
              value={researchModelId ?? ''}
              onChange={(e) => setResearchModelId(e.target.value || null)}
              aria-label="Research model"
            >
              <option value="auto">Auto — DeepSeek + SearXNG when set (recommended)</option>
              <option value="">Inherit run model</option>
              {researchModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </div>
          {/* Search backend keys. SearXNG (free, self-hosted) is preferred over
              Tavily when both are set — matches runWebSearch (research/router.ts). */}
          <div className="border-t border-[var(--hairline)] px-4 py-3">
            <p className="mb-2 text-[11px] leading-snug text-[var(--color-text-muted)]">
              Search backend — a local research model has no built-in web search, so set one of these. SearXNG (free,
              self-hosted) is used first; Tavily is the paid fallback.
            </p>
            <KeyInputRow provider="searxng" label="SearXNG URL" envVar="SEARXNG_URL" />
            <KeyInputRow provider="tavily" label="Tavily API key" envVar="TAVILY_API_KEY" />
          </div>
        </ListContainer>
        {researchModelId && researchModelId !== 'auto' && researchModels.length === 0 && (
          <p className="mt-1 px-1 text-[11px] text-[var(--color-warning,#c2822b)]">
            No enabled research-capable model — add and enable a local (Ollama) or cheap cloud model under Models &amp;
            API keys, or research falls back to the run model.
          </p>
        )}
      </div>

      {/* Chat transcript — D4 inline diffs, off by default. */}
      <div>
        <SectionLabel>Chat transcript</SectionLabel>
        <ListContainer>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">Inline Code Diffs</div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Show before/after line diffs inside tool cards when the agent writes or patches scene code. Expands the
                tool card to inspect changes without leaving the chat.
              </p>
            </div>
            <Switch
              checked={inlineDiffsEnabled}
              onChange={() => setInlineDiffsEnabled(!inlineDiffsEnabled)}
              ariaLabel="Inline Code Diffs"
            />
          </div>
        </ListContainer>
      </div>

      {/* Quality — AI aesthetic review (Gap D), on by default. The deterministic
          blank/broken render gate is always on and not exposed here. */}
      <div>
        <SectionLabel>Quality</SectionLabel>
        <ListContainer>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">AI Quality Review</div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                After the agent builds a scene, review a frame against the design bar and surface anti-slop notes in
                chat. Uses one vision call per built scene. Broken/blank renders are always caught, separately.
              </p>
            </div>
            <Switch
              checked={aiQualityReview}
              onChange={() => setAiQualityReview(!aiQualityReview)}
              ariaLabel="AI Quality Review"
            />
          </div>
        </ListContainer>
      </div>

      {/* Build path. Single-agent by default: one agent builds the whole video in one
          loop. This is the standing opt-in to sub-agents; a user can also ask for them
          in a single message ("use sub-agents", "build the scenes in parallel"). */}
      <div>
        <SectionLabel>Build</SectionLabel>
        <ListContainer>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">Use sub-agents</div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                By default one agent builds your whole video itself, scene by scene, staying in the conversation the
                whole time. Turn this on to hand multi-scene builds to a “director” that dispatches sub-agents — often
                faster on long videos, but the agent stops taking turns until the build finishes. You can also just ask
                for it in a message.
              </p>
            </div>
            <Switch checked={subAgents} onChange={() => setSubAgents(!subAgents)} ariaLabel="Use sub-agents" />
          </div>
        </ListContainer>
      </div>

      {/* Web research — native, on by default. Search rides provider-hosted search
          on Claude/GPT/Gemini; on other models (DeepSeek/Kimi/Qwen/local) it routes
          through SearXNG/Tavily (set above). Fetch is our own code, works everywhere. */}
      <div>
        <SectionLabel>Web research</SectionLabel>
        <ListContainer>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">Web Search Tool</div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Allow Agent to search the web for relevant information. Built in on Claude, GPT, and Gemini; on other
                models (DeepSeek/Kimi/Qwen/local) it uses the SearXNG or Tavily backend set under Deep research.
              </p>
            </div>
            <Switch
              checked={webSearchEnabled}
              onChange={() => setWebSearchEnabled(!webSearchEnabled)}
              ariaLabel="Web Search Tool"
            />
          </div>

          <div className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">Auto-Accept Web Search</div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Agent searches without asking. Turn off to approve web search once per session.
              </p>
            </div>
            <Switch
              checked={autoAcceptWebSearch}
              disabled={!webSearchEnabled}
              onChange={() => setAutoAcceptWebSearch(!autoAcceptWebSearch)}
              ariaLabel="Auto-Accept Web Search"
            />
          </div>

          <div className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">Web Fetch Tool</div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Allow Agent to fetch content (text, images, video) from URLs. Works on every model.
              </p>
            </div>
            <Switch
              checked={webFetchEnabled}
              onChange={() => setWebFetchEnabled(!webFetchEnabled)}
              ariaLabel="Web Fetch Tool"
            />
          </div>
        </ListContainer>
      </div>

      <ExternalCliSection />

      <McpInstallSection />
    </div>
  )
}
