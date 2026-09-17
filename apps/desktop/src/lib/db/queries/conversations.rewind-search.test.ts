// @vitest-environment node
//
// Real-DB (libsql file) tests for the rewind tail-delete (T6 / D4) and the
// command-palette conversation search (T8 / D11). Runs the real migration
// chain + real SQL so the transaction + LIKE/archived filters are exercised.

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-conv-rewind-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects, conversations } from '../schema'
import { addMessage, getConversationMessages, deleteMessagesAfter, searchConversations } from './conversations'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedConversation(opts?: { title?: string; isArchived?: boolean }) {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: `P ${projectId.slice(0, 6)}` })
  const [conv] = await db
    .insert(conversations)
    .values({ projectId, title: opts?.title ?? 'chat', isArchived: opts?.isArchived ?? false })
    .returning()
  return { projectId, conversationId: conv.id }
}

async function seedMessages(projectId: string, conversationId: string, texts: [string, string][]) {
  const ids: string[] = []
  for (const [role, content] of texts) {
    const id = crypto.randomUUID()
    await addMessage({ id, conversationId, projectId, role: role as 'user' | 'assistant', content })
    ids.push(id)
  }
  return ids
}

describe('deleteMessagesAfter (T6 / D4)', () => {
  it('tail-deletes everything after the anchor, keeps the anchor', async () => {
    const { projectId, conversationId } = await seedConversation()
    const [u1, a1, u2, a2] = await seedMessages(projectId, conversationId, [
      ['user', 'q1'],
      ['assistant', 'r1'],
      ['user', 'q2'],
      ['assistant', 'r2'],
    ])
    const res = await deleteMessagesAfter({ conversationId, messageId: u2 })
    expect(res.found).toBe(true)
    expect(res.remaining.map((m) => m.id)).toEqual([u1, a1, u2])
    const live = await getConversationMessages(conversationId)
    expect(live.map((m) => m.id)).toEqual([u1, a1, u2])
    expect(a2).toBeTruthy() // a2 was deleted
  })

  it('swaps the anchor content when newContent is given (edit case)', async () => {
    const { projectId, conversationId } = await seedConversation()
    const [u1] = await seedMessages(projectId, conversationId, [
      ['user', 'original'],
      ['assistant', 'reply'],
    ])
    const res = await deleteMessagesAfter({ conversationId, messageId: u1, newContent: 'edited' })
    expect(res.found).toBe(true)
    expect(res.remaining.map((m) => m.content)).toEqual(['edited'])
  })

  it('unknown messageId ⇒ found:false with ZERO mutation', async () => {
    const { projectId, conversationId } = await seedConversation()
    await seedMessages(projectId, conversationId, [
      ['user', 'q'],
      ['assistant', 'r'],
    ])
    const before = await getConversationMessages(conversationId)
    const res = await deleteMessagesAfter({ conversationId, messageId: crypto.randomUUID() })
    expect(res.found).toBe(false)
    const after = await getConversationMessages(conversationId)
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id))
  })
})

describe('searchConversations (T8 / D11)', () => {
  it('matches conversation titles (case-insensitive)', async () => {
    const { conversationId } = await seedConversation({ title: 'Neon City Promo' })
    const results = await searchConversations('neon')
    expect(results.some((r) => r.conversationId === conversationId && r.matchedOn === 'title')).toBe(true)
  })

  it('matches message content and returns a snippet', async () => {
    const { projectId, conversationId } = await seedConversation({ title: 'Untitled' })
    await seedMessages(projectId, conversationId, [['user', 'please add a flamingo dancing scene']])
    const results = await searchConversations('flamingo')
    const hit = results.find((r) => r.conversationId === conversationId)
    expect(hit?.matchedOn).toBe('message')
    expect(hit?.snippet).toContain('flamingo')
  })

  it('EXCLUDES archived conversations by default, includes them when asked', async () => {
    const { conversationId } = await seedConversation({ title: 'Archived Zebra Reel', isArchived: true })
    const excluded = await searchConversations('zebra')
    expect(excluded.some((r) => r.conversationId === conversationId)).toBe(false)
    const included = await searchConversations('zebra', { includeArchived: true })
    expect(included.some((r) => r.conversationId === conversationId)).toBe(true)
  })

  it('empty query returns nothing', async () => {
    expect(await searchConversations('   ')).toEqual([])
  })
})
