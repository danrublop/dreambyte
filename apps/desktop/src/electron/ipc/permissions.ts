import type { IpcMain } from 'electron'
import { getSessionSpend, getMonthlySpend } from '@/lib/db'
import { listRulesForUser, createRule, deleteRule, type CreateRuleInput } from '@/lib/db/queries/permission-rules'
import { getDesktopUserId } from '@/lib/db/queries/desktop-user'
import { IpcValidationError } from './_helpers'

/**
 * Category: permissions
 *
 * Session + monthly spend per API, and layered permission rules.
 *
 * Layered permission rules (the persistent allow/deny/ask rules in Settings) hang off
 * `permissionRules.userId`, a FK to `users.id`. A desktop install has no auth session, so the rule
 * handlers below own them under the single local desktop user (seeded lazily by getDesktopUserId()).
 */

const TRACKED_APIS = ['heygen', 'veo3', 'imageGen', 'backgroundRemoval', 'elevenLabs', 'unsplash'] as const

async function getSpend(): Promise<Record<string, { sessionSpend: number; monthlySpend: number }>> {
  const result: Record<string, { sessionSpend: number; monthlySpend: number }> = {}
  for (const api of TRACKED_APIS) {
    result[api] = {
      sessionSpend: await getSessionSpend(api),
      monthlySpend: await getMonthlySpend(api),
    }
  }
  return result
}

// The renderer omits id/userId/createdAt and sends expiresAt as an ISO string (JSON has no Date).
type CreateRuleArgs = {
  scope: 'user' | 'workspace' | 'project' | 'session'
  workspaceId?: string | null
  projectId?: string | null
  conversationId?: string | null
  decision: 'allow' | 'deny' | 'ask'
  api: string
  specifier?: unknown | null
  costCapUsd?: number | null
  expiresAt?: string | null
  createdBy?: 'user-settings' | 'dialog' | 'migration' | 'admin'
  notes?: string | null
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:permissions.getSpend', () => getSpend())

  // Layered permission rules, owned by the local desktop user.
  ipcMain.handle('dreambyte:permissions.listRules', async () => {
    const userId = await getDesktopUserId()
    return { rules: await listRulesForUser(userId) }
  })

  ipcMain.handle('dreambyte:permissions.createRule', async (_e, input: CreateRuleArgs) => {
    if (!input?.scope || !input?.decision || !input?.api) {
      throw new IpcValidationError('scope, decision, and api are required')
    }
    const userId = await getDesktopUserId()
    const rule = await createRule({
      userId,
      scope: input.scope,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      conversationId: input.conversationId ?? null,
      decision: input.decision,
      api: input.api as CreateRuleInput['api'],
      specifier: (input.specifier ?? null) as CreateRuleInput['specifier'],
      costCapUsd: input.costCapUsd ?? null,
      // ISO string → Date (the query layer takes a Date | null).
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: input.createdBy ?? 'user-settings',
      notes: input.notes ?? null,
    })
    return { rule }
  })

  ipcMain.handle('dreambyte:permissions.deleteRule', async (_e, id: string) => {
    if (!id || typeof id !== 'string') throw new IpcValidationError('id is required')
    const userId = await getDesktopUserId()
    return { ok: await deleteRule(id, userId) }
  })
}
