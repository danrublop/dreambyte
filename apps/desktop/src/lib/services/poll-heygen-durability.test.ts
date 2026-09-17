// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-poll-heygen-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// pollHeygenStatus dynamically imports the HeyGen API + media cache; mock both.
const { getVideoStatus, downloadVideo, saveToCache } = vi.hoisted(() => ({
  getVideoStatus: vi.fn(),
  downloadVideo: vi.fn(),
  saveToCache: vi.fn(),
}))
vi.mock('@/lib/apis/heygen', () => ({ getVideoStatus, downloadVideo }))
vi.mock('@/lib/apis/media-cache', () => ({ saveToCache }))

import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db/index'
import { avatarVideos, projects } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { pollHeygenStatus } from './generation'

const migrationsFolder = path.resolve(__dirname, '../db/migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})
afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})
beforeEach(() => {
  getVideoStatus.mockReset()
  downloadVideo.mockReset()
  downloadVideo.mockResolvedValue(Buffer.from('clip'))
  saveToCache.mockReset()
  saveToCache.mockResolvedValue('/media/heygen/out.mp4')
})

async function seedRow(opts: { videoId: string; deadlineAt: Date | null; status?: string }) {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'P' })
  const [row] = await db
    .insert(avatarVideos)
    .values({
      projectId,
      provider: 'heygen',
      status: opts.status ?? 'generating',
      text: 'hi',
      heygenVideoId: opts.videoId,
      deadlineAt: opts.deadlineAt,
    })
    .returning()
  return row
}
async function getRow(id: string) {
  const [r] = await db.select().from(avatarVideos).where(eq(avatarVideos.id, id)).limit(1)
  return r
}

describe('pollHeygenStatus durability (v4 #8)', () => {
  it('times out a wedged render past its deadline and flips the row to error (without polling)', async () => {
    const row = await seedRow({ videoId: 'vid-late', deadlineAt: new Date(Date.now() - 1000) })
    const res = await pollHeygenStatus('vid-late')
    expect(res.status).toBe('failed')
    expect(res.error).toMatch(/timed out/i)
    expect(getVideoStatus).not.toHaveBeenCalled() // short-circuits before hitting HeyGen
    expect((await getRow(row.id))!.status).toBe('error')
  })

  it('marks the row ready + stores the clip on completion', async () => {
    const row = await seedRow({ videoId: 'vid-ok', deadlineAt: new Date(Date.now() + 600_000) })
    getVideoStatus.mockResolvedValue({
      status: 'completed',
      videoUrl: 'https://hg/out.mp4',
      durationSeconds: 7,
      thumbnailUrl: '/t.png',
    })
    const res = await pollHeygenStatus('vid-ok')
    expect(res.status).toBe('completed')
    expect(res.videoUrl).toBe('/media/heygen/out.mp4')
    expect(res.durationSeconds).toBe(7)
    const r = await getRow(row.id)
    expect(r!.status).toBe('ready')
    expect(r!.videoUrl).toBe('/media/heygen/out.mp4')
    expect(r!.durationSeconds).toBe(7)
  })

  it('passes through "processing" without touching the still-in-flight row', async () => {
    const row = await seedRow({ videoId: 'vid-proc', deadlineAt: new Date(Date.now() + 600_000) })
    getVideoStatus.mockResolvedValue({ status: 'processing' })
    const res = await pollHeygenStatus('vid-proc')
    expect(res.status).toBe('processing')
    expect((await getRow(row.id))!.status).toBe('generating')
  })

  it('flips the row to error when HeyGen reports failed', async () => {
    const row = await seedRow({ videoId: 'vid-fail', deadlineAt: new Date(Date.now() + 600_000) })
    getVideoStatus.mockResolvedValue({ status: 'failed', error: 'render boom' })
    const res = await pollHeygenStatus('vid-fail')
    expect(res.status).toBe('failed')
    expect((await getRow(row.id))!.status).toBe('error')
  })

  it('a render with no row (legacy) polls exactly as before — no crash', async () => {
    getVideoStatus.mockResolvedValue({ status: 'completed', videoUrl: 'https://hg/legacy.mp4', durationSeconds: 3 })
    const res = await pollHeygenStatus('no-such-row')
    expect(res.status).toBe('completed')
    expect(res.videoUrl).toBe('/media/heygen/out.mp4')
  })
})
