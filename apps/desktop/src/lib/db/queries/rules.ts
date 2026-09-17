import { db } from '../index'
import { rules } from '../schema'
import { and, asc, eq, or } from 'drizzle-orm'
import type { CreateRuleInput, RuleConfig, UpdateRuleInput } from '../../types/rules'

// ── Row mapping ────────────────────────────────────────────────────────────
type Row = typeof rules.$inferSelect

function rowToRule(row: Row): RuleConfig {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    name: row.name,
    body: row.body,
    applyMode: row.applyMode,
    globPattern: row.globPattern,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    createdAt: (row.createdAt instanceof Date
      ? row.createdAt
      : new Date(row.createdAt as unknown as number)
    ).toISOString(),
    updatedAt: (row.updatedAt instanceof Date
      ? row.updatedAt
      : new Date(row.updatedAt as unknown as number)
    ).toISOString(),
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** Rules for a scope. `user` → global rules; `project` → that project's rules. */
export async function listRules(args: { scope: 'user' | 'project'; projectId?: string | null }): Promise<RuleConfig[]> {
  const where =
    args.scope === 'project' && args.projectId
      ? and(eq(rules.scope, 'project'), eq(rules.projectId, args.projectId))
      : eq(rules.scope, 'user')
  const rows = await db.select().from(rules).where(where).orderBy(asc(rules.sortOrder), asc(rules.createdAt))
  return rows.map(rowToRule)
}

/** Enabled rules that apply to an agent run: global user rules + the active
 *  project's rules. Used by the prompt builder. */
export async function listActiveRules(projectId?: string | null): Promise<RuleConfig[]> {
  const scopeFilter = projectId
    ? or(eq(rules.scope, 'user'), and(eq(rules.scope, 'project'), eq(rules.projectId, projectId)))
    : eq(rules.scope, 'user')
  const rows = await db
    .select()
    .from(rules)
    .where(and(eq(rules.enabled, true), scopeFilter))
    .orderBy(asc(rules.scope), asc(rules.sortOrder), asc(rules.createdAt))
  // user rules first (scope 'project' > 'user' alphabetically, so flip):
  return rows.map(rowToRule).sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'user' ? -1 : 1))
}

// ── Writes ─────────────────────────────────────────────────────────────────

export async function createRule(input: CreateRuleInput): Promise<RuleConfig> {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('project-scope rules need a projectId')
  }
  const [row] = await db
    .insert(rules)
    .values({
      scope: input.scope,
      projectId: input.scope === 'project' ? (input.projectId ?? null) : null,
      name: input.name,
      body: input.body,
      applyMode: input.applyMode ?? 'always',
      globPattern: input.globPattern ?? null,
      enabled: input.enabled ?? true,
    })
    .returning()
  return rowToRule(row)
}

export async function updateRule(id: string, patch: UpdateRuleInput): Promise<RuleConfig | null> {
  const [row] = await db
    .update(rules)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(rules.id, id))
    .returning()
  return row ? rowToRule(row) : null
}

export async function deleteRule(id: string): Promise<boolean> {
  const result = await db.delete(rules).where(eq(rules.id, id)).returning({ id: rules.id })
  return result.length > 0
}

export { rules }
