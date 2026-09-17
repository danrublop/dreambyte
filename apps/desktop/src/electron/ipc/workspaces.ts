import type { IpcMain } from 'electron'
import {
  getUserWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from '@/lib/db/queries/workspaces'
import { assertValidUuid, loadWorkspaceOrThrow, IpcValidationError } from './_helpers'

/**
 * Category: workspaces
 *
 * Single-user desktop: workspaces are not partitioned per account.
 */

const MAX_NAME = 255

async function list() {
  return getUserWorkspaces(null)
}

async function get(workspaceId: string) {
  assertValidUuid(workspaceId, 'workspaceId')
  const row = await getWorkspace(workspaceId)
  if (!row) throw new IpcValidationError(`Workspace ${workspaceId} not found`)
  return row
}

type CreateArgs = {
  name: string
  description?: string | null
  color?: string | null
  icon?: string | null
  isDefault?: boolean
}

async function create(args: CreateArgs) {
  if (!args.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    throw new IpcValidationError('name is required')
  }
  return createWorkspace({
    userId: null,
    name: args.name.trim().slice(0, MAX_NAME),
    description: args.description ?? null,
    color: args.color ?? null,
    icon: args.icon ?? null,
    isDefault: args.isDefault ?? false,
  })
}

type UpdateArgs = {
  workspaceId: string
  updates: {
    name?: string
    description?: string | null
    color?: string | null
    icon?: string | null
    brandKit?: unknown
    globalStyle?: unknown
    settings?: unknown
    isDefault?: boolean
  }
}

async function update({ workspaceId, updates }: UpdateArgs) {
  await loadWorkspaceOrThrow(workspaceId)
  const patch: Record<string, unknown> = {}
  if (updates.name !== undefined) patch.name = String(updates.name).trim().slice(0, MAX_NAME)
  if (updates.description !== undefined) patch.description = updates.description
  if (updates.color !== undefined) patch.color = updates.color
  if (updates.icon !== undefined) patch.icon = updates.icon
  if (updates.brandKit !== undefined) patch.brandKit = updates.brandKit
  if (updates.globalStyle !== undefined) patch.globalStyle = updates.globalStyle
  if (updates.settings !== undefined) patch.settings = updates.settings
  if (updates.isDefault !== undefined) patch.isDefault = updates.isDefault
  return updateWorkspace(workspaceId, patch)
}

async function remove(workspaceId: string) {
  await loadWorkspaceOrThrow(workspaceId)
  await deleteWorkspace(workspaceId)
  return { success: true as const }
}


export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:workspaces.list', () => list())
  ipcMain.handle('dreambyte:workspaces.get', (_e, workspaceId: string) => get(workspaceId))
  ipcMain.handle('dreambyte:workspaces.create', (_e, args: CreateArgs) => create(args))
  ipcMain.handle('dreambyte:workspaces.update', (_e, args: UpdateArgs) => update(args))
  ipcMain.handle('dreambyte:workspaces.delete', (_e, workspaceId: string) => remove(workspaceId))
}
