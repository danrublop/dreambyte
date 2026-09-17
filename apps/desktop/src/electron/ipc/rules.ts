import type { IpcMain } from 'electron'
import { listRules, createRule, updateRule, deleteRule } from '@/lib/db/queries/rules'
import type { CreateRuleInput, UpdateRuleInput } from '@/lib/types/rules'
import { IpcValidationError } from './_helpers'

/**
 * Category: rules
 *
 * Behavior-guidance rules (CLAUDE.md/Cursor-style) shown in Settings →
 * Rules, Skills, Subagents. Local-only, no user identity — scope is `user`
 * (global) or `project` (bound to a projectId). Read by the agent prompt
 * builder via src/lib/db/queries/rules.listActiveRules().
 */

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:rules.list', async (_e, args: { scope: 'user' | 'project'; projectId?: string | null }) => {
    if (args?.scope !== 'user' && args?.scope !== 'project') {
      throw new IpcValidationError("scope must be 'user' or 'project'")
    }
    return { rules: await listRules(args) }
  })

  ipcMain.handle('dreambyte:rules.create', async (_e, input: CreateRuleInput) => {
    if (!input?.name?.trim()) throw new IpcValidationError('name is required')
    if (!input?.body?.trim()) throw new IpcValidationError('body is required')
    return { rule: await createRule(input) }
  })

  ipcMain.handle('dreambyte:rules.update', async (_e, args: { id: string; patch: UpdateRuleInput }) => {
    if (!args?.id) throw new IpcValidationError('id is required')
    return { rule: await updateRule(args.id, args.patch ?? {}) }
  })

  ipcMain.handle('dreambyte:rules.delete', async (_e, id: string) => {
    if (!id) throw new IpcValidationError('id is required')
    return { ok: await deleteRule(id) }
  })
}
