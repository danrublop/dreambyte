import type { IpcMain } from 'electron'
import { db } from '@/lib/db'
import { snapshots } from '@/lib/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { assertValidUuid, loadProjectOrThrow, IpcValidationError } from './_helpers'

/**
 * Category: undoStacks (S1 / deferred-qol)
 *
 * Durable home for the renderer's undo/redo history: ONE `snapshots` row per
 * (projectId, branchId) with operation='undo-stacks', diff = the serialized
 * UndoStacksPayload (src/lib/store/undo-persistence.ts). The agent's own
 * createSnapshot rows use other operation values — the operation filter keeps
 * the two uses of the table from ever touching each other.
 *
 * Upsert = delete-then-insert inside a transaction: the row is a whole-value
 * replacement (latest stacks win), not an append log.
 */

const MAX_PAYLOAD_BYTES = 2_000_000 // hard server-side cap; renderer caps at 1MB

function branchCondition(branchId: string | null) {
  return branchId === null ? isNull(snapshots.branchId) : eq(snapshots.branchId, branchId)
}

async function save(args: { projectId: string; branchId: string | null; payload: string }) {
  assertValidUuid(args.projectId, 'projectId')
  if (args.branchId !== null && args.branchId !== undefined) assertValidUuid(args.branchId, 'branchId')
  await loadProjectOrThrow(args.projectId)
  if (typeof args.payload !== 'string') throw new IpcValidationError('payload must be a string')
  if (args.payload.length > MAX_PAYLOAD_BYTES) {
    throw new IpcValidationError(`payload exceeds ${MAX_PAYLOAD_BYTES} byte limit`)
  }

  const branchId = args.branchId ?? null
  await db.transaction(async (tx) => {
    await tx
      .delete(snapshots)
      .where(
        and(
          eq(snapshots.projectId, args.projectId),
          eq(snapshots.operation, 'undo-stacks'),
          branchCondition(branchId),
        ),
      )
    await tx.insert(snapshots).values({
      projectId: args.projectId,
      branchId,
      operation: 'undo-stacks',
      // The payload is already JSON; store as a raw string inside the JSON
      // column (drizzle serializes the value we pass).
      diff: args.payload,
      stackIndex: 0,
    })
  })
  return { success: true as const }
}

async function load(args: { projectId: string; branchId: string | null }) {
  assertValidUuid(args.projectId, 'projectId')
  if (args.branchId !== null && args.branchId !== undefined) assertValidUuid(args.branchId, 'branchId')
  await loadProjectOrThrow(args.projectId)

  const branchId = args.branchId ?? null
  const [row] = await db
    .select({ diff: snapshots.diff })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.projectId, args.projectId),
        eq(snapshots.operation, 'undo-stacks'),
        branchCondition(branchId),
      ),
    )
    .limit(1)

  const payload = typeof row?.diff === 'string' ? row.diff : null
  return { payload }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:undoStacks.save', (_e, args) => save(args))
  ipcMain.handle('dreambyte:undoStacks.load', (_e, args) => load(args))
}
