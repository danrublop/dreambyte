'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Sparkles, Pencil, Trash2, Search, ScrollText, Bot, Terminal } from 'lucide-react'
import { Switch, SettingsEmptyState } from './shared'
import { useVideoStore } from '@/lib/store'
import type { RuleApplyMode, RuleConfig, RuleScope } from '@/lib/types/rules'

type SkillSummary = { id: string; name: string; description: string; category: string; source: string }

const APPLY_MODE_LABELS: Record<RuleApplyMode, string> = {
  always: 'Always',
  // The in-app agent has no file paths — glob rules match
  // SCENE names/types instead ("Intro*", "d3"). The stored applyMode stays
  // 'glob' for schema compatibility; only the surface language changed.
  glob: 'By scene',
  manual: 'Manual',
}

function dreambyteApi() {
  return typeof window !== 'undefined' ? window.dreambyteApi : undefined
}

// ── Section scaffolding ──────────────────────────────────────────────────────

function SectionHeader({ title, description, onNew }: { title: string; description: string; onNew?: () => void }) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-[var(--ink)]">{title}</h3>
        {onNew && (
          <button
            onClick={onNew}
            className="no-style flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-[12px] font-medium text-[var(--graphite)] transition-colors hover:bg-[var(--card)] hover:text-[var(--ink)]"
          >
            <Plus size={13} /> New
          </button>
        )}
      </div>
      <p className="mt-0.5 text-[12px] leading-snug text-[var(--mute)]">{description}</p>
    </div>
  )
}

// ── Rules ────────────────────────────────────────────────────────────────────

const EMPTY_DRAFT = { name: '', body: '', applyMode: 'always' as RuleApplyMode, globPattern: '' }

function RuleEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: typeof EMPTY_DRAFT
  onSave: (d: typeof EMPTY_DRAFT) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const valid = draft.name.trim() && draft.body.trim() && (draft.applyMode !== 'glob' || draft.globPattern.trim())
  return (
    <div className="mb-2 rounded-[var(--radius-md)] border border-[var(--hairline-strong)] bg-[var(--panel)] p-3 space-y-2.5">
      <input
        autoFocus
        value={draft.name}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        placeholder="Rule name (e.g. Coding standards)"
        className="w-full rounded border border-[var(--border-input)] bg-[var(--input-bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--ink)] outline-none placeholder:text-[var(--mute)]"
      />
      <textarea
        value={draft.body}
        onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
        placeholder="Guidance for the agent. Markdown is fine."
        rows={4}
        className="w-full resize-y rounded border border-[var(--border-input)] bg-[var(--input-bg)] px-3 py-2 text-[13px] leading-snug text-[var(--ink)] outline-none placeholder:text-[var(--mute)]"
      />
      <div className="flex items-center gap-2">
        <select
          value={draft.applyMode}
          onChange={(e) => setDraft((d) => ({ ...d, applyMode: e.target.value as RuleApplyMode }))}
          className="rounded border border-[var(--border-input)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-[var(--ink)] outline-none"
        >
          <option value="always">Always</option>
          <option value="glob">By scene</option>
        </select>
        {draft.applyMode === 'glob' && (
          <input
            value={draft.globPattern}
            onChange={(e) => setDraft((d) => ({ ...d, globPattern: e.target.value }))}
            placeholder="Intro* or d3"
            className="flex-1 rounded border border-[var(--border-input)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] font-mono text-[var(--ink)] outline-none placeholder:text-[var(--mute)]"
          />
        )}
        <span className="flex-1" />
        <button
          onClick={onCancel}
          className="no-style rounded-[var(--radius-md)] px-2.5 py-1 text-[12px] text-[var(--graphite)] hover:text-[var(--ink)]"
        >
          Cancel
        </button>
        <button
          onClick={() => valid && onSave(draft)}
          disabled={!valid}
          className="no-style rounded-[var(--radius-md)] bg-[var(--action)] px-3 py-1 text-[12px] font-medium text-[var(--on-action)] disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {draft.applyMode === 'glob' && (
        <p className="text-[11px] text-[var(--mute)]">
          Applies when any scene’s name or type matches the pattern — e.g. “Intro*” or “d3”. “*” matches anything, “?”
          one character.
        </p>
      )}
    </div>
  )
}

function RulesSection({ scope, projectId }: { scope: RuleScope; projectId: string | null }) {
  const [list, setList] = useState<RuleConfig[]>([])
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const api = dreambyteApi()?.rules
    if (!api) {
      setLoading(false)
      return
    }
    try {
      const { rules } = await api.list({ scope, projectId })
      setList(rules)
    } catch {
      setList([])
    } finally {
      setLoading(false)
    }
  }, [scope, projectId])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  const save = async (d: typeof EMPTY_DRAFT, id: string | 'new') => {
    const api = dreambyteApi()?.rules
    if (!api) return
    const payload = {
      name: d.name.trim(),
      body: d.body.trim(),
      applyMode: d.applyMode,
      globPattern: d.applyMode === 'glob' ? d.globPattern.trim() : null,
    }
    if (id === 'new') {
      await api.create({ scope, projectId, ...payload })
    } else {
      await api.update({ id, patch: payload })
    }
    setEditing(null)
    await refresh()
  }

  const toggle = async (r: RuleConfig) => {
    await dreambyteApi()?.rules?.update({ id: r.id, patch: { enabled: !r.enabled } })
    await refresh()
  }
  const remove = async (r: RuleConfig) => {
    await dreambyteApi()?.rules?.delete(r.id)
    await refresh()
  }

  return (
    <div>
      <SectionHeader
        title="Rules"
        description="Guide agent behavior — enforce best practices or style standards. Apply always, by scene, or manually."
        onNew={() => setEditing('new')}
      />
      {editing === 'new' && (
        <RuleEditor initial={EMPTY_DRAFT} onSave={(d) => save(d, 'new')} onCancel={() => setEditing(null)} />
      )}
      <div className="space-y-2">
        {list.map((r) =>
          editing === r.id ? (
            <RuleEditor
              key={r.id}
              initial={{
                name: r.name,
                body: r.body,
                applyMode: r.applyMode,
                globPattern: r.globPattern ?? '',
              }}
              onSave={(d) => save(d, r.id)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div
              key={r.id}
              className="group flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--panel)] px-3.5 py-2.5"
            >
              <ScrollText size={15} className="mt-0.5 shrink-0 text-[var(--graphite)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-[var(--ink)]">{r.name}</span>
                  <span className="shrink-0 rounded border border-[var(--hairline-strong)] px-1.5 py-0.5 text-[10px] uppercase tracking-tight text-[var(--mute)]">
                    {APPLY_MODE_LABELS[r.applyMode]}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[var(--mute)]">{r.body}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => setEditing(r.id)}
                  className="no-style text-[var(--graphite)] opacity-0 transition-opacity hover:text-[var(--ink)] group-hover:opacity-100"
                  title="Edit"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => remove(r)}
                  className="no-style text-[var(--graphite)] opacity-0 transition-opacity hover:text-[var(--danger)] group-hover:opacity-100"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
                <Switch checked={r.enabled} onChange={() => toggle(r)} ariaLabel={`${r.name} enabled`} />
              </div>
            </div>
          ),
        )}
        {!loading && list.length === 0 && editing !== 'new' && (
          <p className="px-1 py-3 text-[12px] text-[var(--mute)]">
            No rules in this scope yet. Add one to guide the agent.
          </p>
        )}
      </div>
    </div>
  )
}

// ── Skills ─────────────────────────────────────────────────────────────────

function SkillsSection() {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [count, setCount] = useState(0)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    const api = dreambyteApi()?.skills
    if (!api?.list) return
    void api
      .list()
      .then((r) => {
        setSkills(r.skills)
        setCount(r.count)
      })
      .catch(() => {})
  }, [])

  const filtered = query.trim()
    ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase()))
    : skills
  const PREVIEW = 6
  const visible = showAll || query.trim() ? filtered : filtered.slice(0, PREVIEW)
  const hiddenCount = filtered.length - visible.length

  return (
    <div>
      <SectionHeader
        title="Skills"
        description="Specialized capabilities the agent invokes when relevant, or you trigger manually with / in chat."
      />
      <div className="mb-2 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-input)] bg-[var(--input-bg)] px-3">
        <Search size={14} className="text-[var(--mute)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${count || skills.length} skills`}
          className="h-8 flex-1 bg-transparent text-[13px] text-[var(--ink)] placeholder:text-[var(--mute)] outline-none"
        />
      </div>
      <div className="space-y-2">
        {visible.map((s) => (
          <div
            key={s.id}
            className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--panel)] px-3.5 py-2.5"
          >
            <Sparkles size={15} className="mt-0.5 shrink-0 text-[var(--graphite)]" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-[var(--ink)]">{s.name}</span>
                <span className="rounded bg-[var(--card)] px-1.5 py-0.5 text-[10px] text-[var(--mute)]">
                  {s.source}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] leading-snug text-[var(--mute)]">{s.description}</p>
            </div>
          </div>
        ))}
        {!query.trim() && hiddenCount > 0 && (
          <button
            onClick={() => setShowAll(true)}
            className="no-style w-full rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--panel)] px-3.5 py-2.5 text-left text-[12px] text-[var(--graphite)] hover:text-[var(--ink)]"
          >
            Show all ({hiddenCount} more)
          </button>
        )}
        {filtered.length === 0 && <p className="px-1 py-3 text-[12px] text-[var(--mute)]">No skills match.</p>}
      </div>
    </div>
  )
}

// ── Tab ──────────────────────────────────────────────────────────────────────

export default function RulesSkillsSubagentsTab() {
  const activeProjectId = useVideoStore((s) => s.activeProjectId)
  const projectList = useVideoStore((s) => s.projectList)
  const activeProject = projectList.find((p) => p.id === activeProjectId) ?? null
  const [scope, setScope] = useState<RuleScope>('user')

  // If the active project goes away, fall back to User scope.
  useEffect(() => {
    if (scope === 'project' && !activeProject) setScope('user')
  }, [scope, activeProject])

  const projectId = scope === 'project' ? activeProjectId : null

  const scopeTabs: { value: RuleScope; label: string }[] = [
    { value: 'user', label: 'User' },
    ...(activeProject ? [{ value: 'project' as RuleScope, label: activeProject.name }] : []),
  ]

  return (
    <div>
      <p className="-mt-3 mb-4 text-[13px] text-[var(--mute)]">
        Provide domain-specific knowledge and workflows for the agent.
      </p>

      {/* Scope tabs */}
      <div className="mb-5 flex items-center gap-1">
        {scopeTabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setScope(t.value)}
            className={`no-style max-w-[160px] truncate rounded-[var(--radius-md)] px-2.5 py-1 text-[13px] font-medium transition-colors ${
              scope === t.value
                ? 'bg-[var(--card)] text-[var(--ink)]'
                : 'text-[var(--graphite)] hover:text-[var(--ink)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-8">
        <RulesSection scope={scope} projectId={projectId} />

        <SkillsSection />

        <div>
          <SectionHeader
            title="Subagents"
            description="Specialized agents the main agent delegates focused work to, in parallel."
          />
          <SettingsEmptyState
            icon={<Bot size={24} strokeWidth={1.5} />}
            title="No subagents yet"
            description="Create specialized agents to handle focused tasks. Coming in a later update."
          />
        </div>

        <div>
          <SectionHeader
            title="Commands"
            description="Reusable workflows triggered with / in chat. Standardize processes and make common tasks more efficient."
          />
          <SettingsEmptyState
            icon={<Terminal size={24} strokeWidth={1.5} />}
            title="No commands yet"
            description="Create reusable / commands. Coming in a later update."
          />
        </div>
      </div>
    </div>
  )
}
