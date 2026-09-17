'use client'

import { Trash2, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useVideoStore } from '@/lib/store'
import type { APIName } from '@/lib/types'
import { SettingsSection } from './shared'
import {
  PERMISSION_DECISIONS,
  PERMISSION_SCOPES,
  type PermissionRule,
  type PermissionScope,
  type PermissionDecision,
} from '@/lib/types/permissions'

export default function PermissionsPanel({ forcedWorkspaceId }: { forcedWorkspaceId?: string } = {}) {
  // Permission RULES (allow/deny, scoped) are agent-execution governance and live here.
  // Per-model cost limits + permission mode moved to each model's card in the Models tab
  // (Settings → Models → gear → Permissions) so a model has a single home for its config.
  return <RulesSection forcedWorkspaceId={forcedWorkspaceId} />
}

// ── Layered permission rules UI ────────────────────────────────────────────

function RulesSection({ forcedWorkspaceId }: { forcedWorkspaceId?: string } = {}) {
  const {
    permissionRules,
    refreshPermissionRules,
    createPermissionRule,
    deletePermissionRule,
    project,
    activeConversationId,
  } = useVideoStore()

  useEffect(() => {
    void refreshPermissionRules()
  }, [refreshPermissionRules])

  // On the workspace page, show only this workspace's rules; the resolver applies
  // them to every project in the workspace (see WORKSPACES-PAGE.md, E1).
  const visibleRules = forcedWorkspaceId
    ? permissionRules.filter((r) => r.scope === 'workspace' && r.workspaceId === forcedWorkspaceId)
    : permissionRules

  const grouped: Record<PermissionScope, PermissionRule[]> = {
    user: [],
    workspace: [],
    project: [],
    session: [],
  }
  for (const rule of visibleRules) grouped[rule.scope].push(rule)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <SettingsSection>{forcedWorkspaceId ? 'Workspace Permissions' : 'Permission Rules'}</SettingsSection>
        <span className="text-[11px] text-[var(--mute)]">Deny wins across scopes</span>
      </div>

      <AddRuleRow
        onCreate={createPermissionRule}
        projectId={project?.id ?? null}
        conversationId={activeConversationId}
        forcedWorkspaceId={forcedWorkspaceId}
      />

      <div className="space-y-2 mt-3">
        {PERMISSION_SCOPES.map((scope) => {
          const rows = grouped[scope]
          if (rows.length === 0) return null
          return (
            <div key={scope}>
              <div className="text-[11px] uppercase tracking-wider text-[var(--mute)] mb-1">{scope}</div>
              <div className="space-y-1">
                {rows.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} onDelete={deletePermissionRule} />
                ))}
              </div>
            </div>
          )
        })}
        {permissionRules.length === 0 && (
          <p className="text-[11px] text-[var(--mute)] italic">No rules yet. Approve a call or add one above.</p>
        )}
      </div>
    </div>
  )
}

const RULE_APIS: Array<APIName | '*'> = [
  '*',
  'heygen',
  'veo3',
  'kling',
  'runway',
  'ltx',
  'wan',
  'seedance',
  'imageGen',
  'backgroundRemoval',
  'elevenLabs',
  'elevenLabsMusic',
  'googleLyria',
  'falMusic',
  'unsplash',
  'googleTts',
  'googleImageGen',
  'openaiTts',
  'geminiTts',
  'freesound',
  'pixabay',
  'falAvatar',
]

function AddRuleRow({
  onCreate,
  projectId,
  conversationId,
  forcedWorkspaceId,
}: {
  onCreate: (input: Omit<PermissionRule, 'id' | 'userId' | 'createdAt'>) => Promise<PermissionRule | null>
  projectId: string | null
  conversationId: string | null
  forcedWorkspaceId?: string
}) {
  const [decision, setDecision] = useState<PermissionDecision>('allow')
  const [api, setApi] = useState<APIName | '*'>('freesound')
  // Global panel excludes 'workspace' (it requires a workspace context, which only
  // the Workspaces page has — prevents creating inert workspaceId:null rules).
  const [scope, setScope] = useState<PermissionScope>(forcedWorkspaceId ? 'workspace' : 'user')
  const [busy, setBusy] = useState(false)

  const selectableScopes: PermissionScope[] = forcedWorkspaceId
    ? ['workspace']
    : PERMISSION_SCOPES.filter((s) => s !== 'workspace')

  async function submit() {
    if (busy) return
    setBusy(true)
    try {
      await onCreate({
        scope: forcedWorkspaceId ? 'workspace' : scope,
        workspaceId: forcedWorkspaceId ?? null,
        projectId: !forcedWorkspaceId && scope === 'project' ? projectId : null,
        conversationId: !forcedWorkspaceId && scope === 'session' ? conversationId : null,
        decision,
        api,
        specifier: null,
        costCapUsd: null,
        expiresAt: null,
        createdBy: 'user-settings',
        notes: null,
      })
    } finally {
      setBusy(false)
    }
  }

  const scopeDisabled =
    !forcedWorkspaceId && ((scope === 'project' && !projectId) || (scope === 'session' && !conversationId))

  return (
    <div className="flex gap-1.5 items-center py-2">
      <select
        value={decision}
        onChange={(e) => setDecision(e.target.value as PermissionDecision)}
        className="text-[11px] p-1 rounded border bg-[var(--color-input-bg)] border-[var(--color-border)]"
      >
        {PERMISSION_DECISIONS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <select
        value={api}
        onChange={(e) => setApi(e.target.value as APIName | '*')}
        className="flex-1 text-[11px] p-1 rounded border bg-[var(--color-input-bg)] border-[var(--color-border)]"
      >
        {RULE_APIS.map((a) => (
          <option key={a} value={a}>
            {a === '*' ? 'any api' : a}
          </option>
        ))}
      </select>
      {forcedWorkspaceId ? (
        <span className="rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] p-1 text-[11px] text-[var(--mute)]">
          workspace
        </span>
      ) : (
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as PermissionScope)}
          className="text-[11px] p-1 rounded border bg-[var(--color-input-bg)] border-[var(--color-border)]"
        >
          {selectableScopes.map((s) => (
            <option
              key={s}
              value={s}
              disabled={(s === 'project' && !projectId) || (s === 'session' && !conversationId)}
            >
              {s}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={submit}
        disabled={busy || scopeDisabled}
        className="p-1 rounded border border-[var(--color-border)] hover:bg-white/5 disabled:opacity-40"
        aria-label="Add rule"
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

function RuleRow({ rule, onDelete }: { rule: PermissionRule; onDelete: (id: string) => Promise<boolean> }) {
  const specifierText = rule.specifier ? formatSpecifierSummary(rule.specifier) : null
  return (
    <div className="flex items-center gap-2 px-1 py-1.5">
      <span
        className="text-[11px] font-mono uppercase px-1 py-0.5 rounded"
        style={{
          backgroundColor:
            rule.decision === 'allow'
              ? 'color-mix(in srgb, var(--success) 14%, transparent)'
              : rule.decision === 'deny'
                ? 'color-mix(in srgb, var(--danger) 14%, transparent)'
                : 'color-mix(in srgb, var(--warn) 14%, transparent)',
          color:
            rule.decision === 'allow' ? 'var(--success)' : rule.decision === 'deny' ? 'var(--danger)' : 'var(--warn)',
        }}
      >
        {rule.decision}
      </span>
      <span className="text-[11px] font-medium">{rule.api}</span>
      {specifierText && <span className="text-[11px] text-[var(--mute)]">({specifierText})</span>}
      {rule.costCapUsd !== null && (
        <span className="text-[11px] text-[var(--warn)]">cap ${rule.costCapUsd.toFixed(2)}</span>
      )}
      <span className="ml-auto text-[11px] text-[var(--mute)] uppercase">{rule.createdBy}</span>
      <button
        onClick={() => onDelete(rule.id)}
        className="p-1 rounded hover:bg-white/10 text-[var(--mute)] hover:text-[var(--danger)]"
        aria-label="Delete rule"
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}

function formatSpecifierSummary(s: import('@/lib/types/permissions').RuleSpecifier): string {
  const parts: string[] = []
  if (s.provider) parts.push(`provider:${s.provider}`)
  if (s.model) parts.push(`model:${s.model}`)
  if (s.durationMax !== undefined) parts.push(`≤${s.durationMax}s`)
  if (s.durationMin !== undefined) parts.push(`≥${s.durationMin}s`)
  if (s.costMax !== undefined) parts.push(`≤$${s.costMax}`)
  return parts.join(', ')
}
