import type { IpcMain } from 'electron'
import { getAgentUsageSummary } from '@/lib/db'
import { assertValidUuid } from './_helpers'

/**
 * Category: usage
 *
 * Returns per-agent + total token / cost / call counts. Project-scoped when
 * `projectId` is provided; global otherwise.
 */
// Only these day-windows are offered in the UI; clamp anything else to all-time
// so a malformed range can't smuggle an arbitrary WHERE bound into the query.
const ALLOWED_RANGE_DAYS = new Set([7, 30, 90])

async function getSummary(projectId?: string, range?: { days?: number }) {
  if (projectId) assertValidUuid(projectId, 'projectId')
  const days = range?.days
  const safeRange = typeof days === 'number' && ALLOWED_RANGE_DAYS.has(days) ? { days } : undefined
  return getAgentUsageSummary(projectId, safeRange)
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:usage.getSummary', (_e, projectId?: string, range?: { days?: number }) =>
    getSummary(projectId, range),
  )
}
