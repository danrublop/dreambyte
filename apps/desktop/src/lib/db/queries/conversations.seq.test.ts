// @vitest-environment node
//
// Real-DB (libsql file) test for the stale-seq guard on the streaming chat
// persist (T1 / D5). The headline guarantee: an older `seq` never overwrites
// newer streamed content, and the final persist (no seq) supersedes partials.
// Runs the real migration chain + real SQL so the WHERE-gated UPDATE/upsert is
// exercised, not mocked.

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-conv-seq-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects, conversations, messages } from '../schema'
import { eq } from 'drizzle-orm'
import { addMessage, updateMessage, upsertMessage, getConversationMessages } from './conversations'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seed(): Promise<{ projectId: string; conversationId: string; messageId: string }> {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: `P ${projectId.slice(0, 6)}` })
  const [conv] = await db.insert(conversations).values({ projectId, title: 'c' }).returning()
  const messageId = crypto.randomUUID()
  // Placeholder streaming insert (mirrors run-start).
  await addMessage({
    id: messageId,
    conversationId: conv.id,
    projectId,
    role: 'assistant',
    content: '',
    status: 'streaming',
    seq: 0,
  })
  return { projectId, conversationId: conv.id, messageId }
}

async function readMessage(id: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1)
  return row
}

describe('streaming persist — stale-seq guard (T1 / D5)', () => {
  it('rejects an out-of-order older seq, keeps newer content', async () => {
    const { messageId } = await seed()

    // seq 2 lands first (the newer write).
    const r2 = await updateMessage(messageId, { content: 'newer', status: 'streaming', seq: 2 })
    expect(r2?.applied).toBe(true)
    expect((await readMessage(messageId))?.content).toBe('newer')

    // seq 1 arrives late (out of order) — must be rejected, content unchanged.
    const r1 = await updateMessage(messageId, { content: 'older', status: 'streaming', seq: 1 })
    expect(r1?.applied).toBe(false)
    expect((await readMessage(messageId))?.content).toBe('newer')

    // A higher seq applies again.
    const r3 = await updateMessage(messageId, { content: 'newest', status: 'streaming', seq: 3 })
    expect(r3?.applied).toBe(true)
    expect((await readMessage(messageId))?.content).toBe('newest')
  })

  it('final persist (no seq) supersedes partials and completes the row', async () => {
    const { messageId } = await seed()
    await updateMessage(messageId, { content: 'partial', status: 'streaming', seq: 5 })

    // Final write carries no seq → unconditional, marks complete.
    const rf = await updateMessage(messageId, { content: 'FINAL', status: 'complete' })
    expect(rf?.applied).toBe(true)
    const row = await readMessage(messageId)
    expect(row?.content).toBe('FINAL')
    expect(row?.status).toBe('complete')
  })

  it('upsert rejects an older seq via the ON CONFLICT setWhere gate', async () => {
    const { messageId, conversationId, projectId } = await seed()
    // Newer first.
    await upsertMessage({
      id: messageId,
      conversationId,
      projectId,
      role: 'assistant',
      content: 'newer',
      status: 'streaming',
      seq: 4,
    })
    expect((await readMessage(messageId))?.content).toBe('newer')
    // Older partial via upsert — gate must reject.
    await upsertMessage({
      id: messageId,
      conversationId,
      projectId,
      role: 'assistant',
      content: 'older',
      status: 'streaming',
      seq: 2,
    })
    expect((await readMessage(messageId))?.content).toBe('newer')
  })

  it('listMessages round-trips persisted content', async () => {
    const { messageId, conversationId } = await seed()
    await updateMessage(messageId, { content: 'hello world', status: 'streaming', seq: 1 })
    const rows = await getConversationMessages(conversationId)
    const m = rows.find((r) => r.id === messageId)
    expect(m?.content).toBe('hello world')
  })

  it('conversation-scope: a mismatched conversationId never updates the row (COMMIT 4)', async () => {
    const { messageId, conversationId } = await seed()
    // Seed a second, unrelated conversation in a fresh project.
    const otherConvId = crypto.randomUUID()

    // Update under the WRONG conversationId — must be rejected, content unchanged.
    const wrong = await updateMessage(messageId, {
      conversationId: otherConvId,
      content: 'leaked into wrong conversation',
      status: 'streaming',
      seq: 1,
    })
    expect(wrong?.applied).toBe(false)
    expect((await readMessage(messageId))?.content).toBe('')

    // Update under the CORRECT conversationId — applies.
    const right = await updateMessage(messageId, {
      conversationId,
      content: 'correct',
      status: 'streaming',
      seq: 2,
    })
    expect(right?.applied).toBe(true)
    expect((await readMessage(messageId))?.content).toBe('correct')
  })
})

describe('runId persistence (S6 / migration 0025)', () => {
  it('persists runId on insert and threads it through streaming updates', async () => {
    const { conversationId, projectId } = await seed()
    const id = crypto.randomUUID()
    await addMessage({
      id,
      conversationId,
      projectId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      seq: 0,
      runId: 'run-abc',
    })
    expect((await readMessage(id))?.runId).toBe('run-abc')

    // A streaming partial carries the runId; the row keeps it.
    await updateMessage(id, { conversationId, content: 'partial', status: 'streaming', seq: 1, runId: 'run-abc' })
    const row = await readMessage(id)
    expect(row?.runId).toBe('run-abc')
    expect(row?.content).toBe('partial')
  })

  it('legacy rows keep NULL runId (no backfill, no accidental stamping)', async () => {
    const { messageId, conversationId } = await seed()
    // The seed insert passed no runId — stays NULL through a runId-less update.
    await updateMessage(messageId, { conversationId, content: 'x', status: 'streaming', seq: 1 })
    expect((await readMessage(messageId))?.runId).toBeNull()
  })
})
