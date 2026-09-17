// @vitest-environment node

// P1-5 (v7 Lane F): export_mp4 over the MCP path must NOT lie when there is no
// editor window to render through. With no `_exportRunner` registered, the
// offscreen render can't run, so the tool must report success:false with an
// error naming the missing editor window — and must NOT stamp an exportJobId
// (the old code left success:true + no job, so the agent believed the export
// had started and a later get_export_status found nothing). No test in this
// suite registers a runner, so `_exportRunner` is null at module load — exactly
// the no-editor-window condition this lane fixes.

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-mcp-export-norunner-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db/index'
import { projects } from '@/lib/db/schema'
import { executeMcpTool } from './mcp-handler'

const migrationsFolder = path.resolve(__dirname, '../db/migrations')

async function seed(): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(projects).values({ id, name: `P ${id.slice(0, 6)}`, description: null })
  return id
}

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})
afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('export over MCP with no editor window (P1-5)', () => {
  it('honest-fails: success:false, error names the missing editor window, no exportJobId', async () => {
    const projectId = await seed()
    const r = await executeMcpTool({ projectId, toolName: 'export', args: {} })

    // The lie this lane kills: the old code left success true.
    expect(r.success).toBe(false)
    // The honest reason reaches the agent: on failure assembleMcpResultText
    // folds result.error into content (parity with the in-app runner's
    // honest-fail), naming the missing editor window so the agent knows the
    // export never ran.
    expect(r.content).toMatch(/editor window/i)
    expect(r.content).toMatch(/unavailable/i)
    // No phantom job: nothing for get_export_status to poll.
    expect((r.data as { exportJobId?: string } | undefined)?.exportJobId).toBeUndefined()
    // And no stale "Export started ..." text leaks from the success branch.
    expect(r.content).not.toMatch(/export started/i)
  })
})
