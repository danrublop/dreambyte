import type { IpcMain } from 'electron'
import { updateGenerationLog, getGenerationLogs } from '@/lib/db/queries/generation-logs'
import { computeQualityScore } from '@/lib/generation-logs/score'
import { assertValidUuid, IpcValidationError } from './_helpers'

/**
 * Category: generationLog
 *
 * Update quality signals on a generation log and list logs.
 */

const VALID_USER_ACTIONS = [
  'kept',
  'regenerated',
  'edited',
  'deleted',
  'rated-positive',
  'rated-negative',
  'exported',
  'published',
] as const

const MAX_QUERY_RESULTS = 500

type UpdateArgs = {
  logId: string
  userAction?: string
  timeToActionMs?: number
  editDistance?: number
  userRating?: number
  exportSucceeded?: boolean
  exportErrorMessage?: string
  generatedCodeLength?: number
}

async function update(args: UpdateArgs) {
  assertValidUuid(args.logId, 'logId')

  if (args.userAction && !(VALID_USER_ACTIONS as readonly string[]).includes(args.userAction)) {
    throw new IpcValidationError(`userAction must be one of: ${VALID_USER_ACTIONS.join(', ')}`)
  }
  if (
    args.timeToActionMs != null &&
    (typeof args.timeToActionMs !== 'number' || args.timeToActionMs < 0 || !Number.isFinite(args.timeToActionMs))
  ) {
    throw new IpcValidationError('timeToActionMs must be a non-negative number')
  }
  if (
    args.editDistance != null &&
    (typeof args.editDistance !== 'number' || args.editDistance < 0 || !Number.isInteger(args.editDistance))
  ) {
    throw new IpcValidationError('editDistance must be a non-negative integer')
  }
  if (args.userRating != null && (typeof args.userRating !== 'number' || args.userRating < 0 || args.userRating > 5)) {
    throw new IpcValidationError('userRating must be between 0 and 5')
  }

  const updates: Record<string, unknown> = {}
  if (args.userAction) updates.userAction = args.userAction
  if (args.timeToActionMs != null) updates.timeToActionMs = args.timeToActionMs
  if (args.editDistance != null) updates.editDistance = args.editDistance
  if (args.userRating != null) updates.userRating = args.userRating
  if (args.exportSucceeded != null) updates.exportSucceeded = args.exportSucceeded
  if (args.exportErrorMessage) updates.exportErrorMessage = args.exportErrorMessage

  if (args.userAction) {
    const score = computeQualityScore({
      userAction: args.userAction,
      timeToActionMs: args.timeToActionMs,
      editDistance: args.editDistance,
      generatedCodeLength: args.generatedCodeLength,
      userRating: args.userRating,
      exportSucceeded: args.exportSucceeded,
    })
    if (score >= 0) updates.qualityScore = score
  }

  await updateGenerationLog(args.logId, updates)
  return { success: true as const }
}

type ListArgs = {
  projectId?: string
  sceneId?: string
  limit?: number
  offset?: number
}

async function list(args: ListArgs) {
  if (args.projectId) assertValidUuid(args.projectId, 'projectId')
  if (args.sceneId) assertValidUuid(args.sceneId, 'sceneId')
  const limit = Math.min(Math.max(args.limit ?? 50, 1), MAX_QUERY_RESULTS)
  const offset = Math.max(args.offset ?? 0, 0)
  const logs = await getGenerationLogs({
    projectId: args.projectId,
    sceneId: args.sceneId,
    limit,
    offset,
  })
  return { logs }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:generationLog.update', (_e, args: UpdateArgs) => update(args))
  ipcMain.handle('dreambyte:generationLog.list', (_e, args: ListArgs) => list(args))
}
