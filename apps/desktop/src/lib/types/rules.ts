// Behavior-guidance Rules (CLAUDE.md/Cursor-style). Shared across the renderer,
// the IPC layer, and the agent prompt builder. Local-only — no user identity.

export type RuleScope = 'user' | 'project'
export type RuleApplyMode = 'always' | 'glob' | 'manual'

export interface RuleConfig {
  id: string
  scope: RuleScope
  /** Set when scope === 'project'; null for global user rules. */
  projectId: string | null
  name: string
  /** The guidance text injected into the agent system prompt. */
  body: string
  applyMode: RuleApplyMode
  /** Glob to match working files against when applyMode === 'glob'. */
  globPattern: string | null
  enabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface CreateRuleInput {
  scope: RuleScope
  projectId?: string | null
  name: string
  body: string
  applyMode?: RuleApplyMode
  globPattern?: string | null
  enabled?: boolean
}

export interface UpdateRuleInput {
  name?: string
  body?: string
  applyMode?: RuleApplyMode
  globPattern?: string | null
  enabled?: boolean
  sortOrder?: number
}
