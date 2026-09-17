import { db } from '../index'
import { permissionRules } from '../schema'
import { and, eq, inArray, isNull, isNotNull, or, gt, lte } from 'drizzle-orm'
import type {
  APIName,
  PermissionRule,
  PermissionScope,
  RuleSpecifier,
  PermissionDecision,
} from '../../types/permissions'

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreateRuleInput {
  userId: string
  scope: PermissionScope
  workspaceId?: string | null
  projectId?: string | null
  conversationId?: string | null
  decision: PermissionDecision
  api: APIName | '*'
  specifier?: RuleSpecifier | null
  costCapUsd?: number | null
  expiresAt?: Date | null
  createdBy?: PermissionRule['createdBy']
  notes?: string | null
}

export interface MatchingRulesCtx {
  userId: string
  workspaceId: string | null
  projectId: string | null
  conversationId: string | null
}

// ── Row mapping ──────────────────────────────────────────────────────────────

type Row = typeof permissionRules.$inferSelect

function rowToRule(row: Row): PermissionRule {
  return {
    id: row.id,
    scope: row.scope,
    userId: row.userId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    conversationId: row.conversationId,
    decision: row.decision,
    api: row.api as PermissionRule['api'],
    specifier: (row.specifier ?? null) as RuleSpecifier | null,
    costCapUsd: row.costCapUsd,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    notes: row.notes,
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createRule(input: CreateRuleInput): Promise<PermissionRule> {
  assertScopeConsistency(input)
  const [row] = await db
    .insert(permissionRules)
    .values({
      userId: input.userId,
      scope: input.scope,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      conversationId: input.conversationId ?? null,
      decision: input.decision,
      api: input.api,
      specifier: input.specifier ?? null,
      costCapUsd: input.costCapUsd ?? null,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy ?? 'user-settings',
      notes: input.notes ?? null,
    })
    .returning()
  return rowToRule(row)
}

export async function deleteRule(id: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(permissionRules)
    .where(and(eq(permissionRules.id, id), eq(permissionRules.userId, userId)))
    .returning({ id: permissionRules.id })
  return result.length > 0
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** All rules owned by the user, regardless of scope. For settings UI listing. */
export async function listRulesForUser(userId: string): Promise<PermissionRule[]> {
  const rows = await db.select().from(permissionRules).where(eq(permissionRules.userId, userId))
  return rows.map(rowToRule)
}

/** Rules that could apply to a call in the given context. Narrows by scope
 *  keys and excludes expired session rules. Final api/specifier matching is
 *  done by the pure evaluator so it stays testable. */
export async function findMatchingRules(ctx: MatchingRulesCtx): Promise<PermissionRule[]> {
  const scopeFilters = [
    // User defaults — no workspace/project/conversation binding.
    and(eq(permissionRules.scope, 'user'), eq(permissionRules.userId, ctx.userId)),
  ]

  if (ctx.workspaceId) {
    scopeFilters.push(
      and(
        eq(permissionRules.scope, 'workspace'),
        eq(permissionRules.userId, ctx.userId),
        eq(permissionRules.workspaceId, ctx.workspaceId),
      ),
    )
  }
  if (ctx.projectId) {
    scopeFilters.push(
      and(
        eq(permissionRules.scope, 'project'),
        eq(permissionRules.userId, ctx.userId),
        eq(permissionRules.projectId, ctx.projectId),
      ),
    )
  }
  if (ctx.conversationId) {
    scopeFilters.push(
      and(
        eq(permissionRules.scope, 'session'),
        eq(permissionRules.userId, ctx.userId),
        eq(permissionRules.conversationId, ctx.conversationId),
      ),
    )
  }

  const whereClause = and(
    or(...scopeFilters),
    or(isNull(permissionRules.expiresAt), gt(permissionRules.expiresAt, new Date())),
  )

  const rows = await db.select().from(permissionRules).where(whereClause)
  return rows.map(rowToRule)
}

/** Clean up expired session rules. Safe to run periodically or on session end. */
export async function purgeExpiredRules(): Promise<number> {
  // Use Drizzle comparators rather than raw NOW(), which SQLite/libsql doesn't
  // have ("no such function: NOW"). Mirrors the getRules expiry check.
  const result = await db
    .delete(permissionRules)
    .where(
      and(
        eq(permissionRules.scope, 'session'),
        isNotNull(permissionRules.expiresAt),
        lte(permissionRules.expiresAt, new Date()),
      ),
    )
    .returning({ id: permissionRules.id })
  return result.length
}

// ── Guards ───────────────────────────────────────────────────────────────────

function assertScopeConsistency(input: CreateRuleInput): void {
  switch (input.scope) {
    case 'user':
      if (input.workspaceId || input.projectId || input.conversationId) {
        throw new Error('user-scope rules must not carry workspace/project/conversation ids')
      }
      break
    case 'workspace':
      if (!input.workspaceId) throw new Error('workspace-scope rules need workspaceId')
      if (input.projectId || input.conversationId) {
        throw new Error('workspace-scope rules must not carry project/conversation ids')
      }
      break
    case 'project':
      if (!input.projectId) throw new Error('project-scope rules need projectId')
      if (input.conversationId) {
        throw new Error('project-scope rules must not carry conversationId')
      }
      break
    case 'session':
      if (!input.conversationId) throw new Error('session-scope rules need conversationId')
      break
  }
}

// ── Re-exports for migration scripts ─────────────────────────────────────────

export { permissionRules }
