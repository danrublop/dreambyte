// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cench-cloned-voices-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects } from '../schema'
import {
  createClonedVoice,
  getClonedVoice,
  resolveClonedVoice,
  listClonedVoices,
  deleteClonedVoiceRow,
  getProjectVoiceConsent,
  recordProjectVoiceConsent,
} from './cloned-voices'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedProject(): Promise<string> {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'Voice Test' })
  return projectId
}

const consent = (over: Partial<Parameters<typeof createClonedVoice>[0]> = {}) => ({
  name: 'My Voice',
  provider: 'elevenlabs',
  providerVoiceId: 'el_abc123',
  sampleMime: 'audio/mpeg',
  sampleBytes: 12345,
  consentAt: new Date(1781300000000),
  consentVersion: 'v1',
  consentDestination: 'ElevenLabs (US)',
  ...over,
})

describe('cloned-voices queries (migration 0023 applied)', () => {
  it('creates a cloned voice and reads it back by id', async () => {
    const projectId = await seedProject()
    const created = await createClonedVoice({ projectId, ...consent() })
    expect(created.providerVoiceId).toBe('el_abc123')
    expect(created.consentDestination).toBe('ElevenLabs (US)')

    const got = await getClonedVoice(projectId, created.id)
    expect(got?.id).toBe(created.id)
    expect(got?.sampleBytes).toBe(12345)
  })

  it('resolves a voice by case-insensitive name', async () => {
    const projectId = await seedProject()
    await createClonedVoice({ projectId, ...consent({ name: 'Aria Narrator' }) })
    const byName = await resolveClonedVoice(projectId, 'aria narrator')
    expect(byName?.name).toBe('Aria Narrator')
    const missing = await resolveClonedVoice(projectId, 'nobody')
    expect(missing).toBeNull()
  })

  it('enforces one voice per name per project (case-insensitive)', async () => {
    const projectId = await seedProject()
    await createClonedVoice({ projectId, ...consent({ name: 'Dup' }) })
    await expect(createClonedVoice({ projectId, ...consent({ name: 'dup', providerVoiceId: 'el_x' }) })).rejects.toThrow()
  })

  it('scopes reads to the project (no cross-project leak)', async () => {
    const a = await seedProject()
    const b = await seedProject()
    const v = await createClonedVoice({ projectId: a, ...consent({ name: 'Scoped' }) })
    expect(await getClonedVoice(b, v.id)).toBeNull()
    expect(await listClonedVoices(b)).toHaveLength(0)
  })

  it('hard-deletes the row and returns it (for the remote provider delete)', async () => {
    const projectId = await seedProject()
    const v = await createClonedVoice({ projectId, ...consent({ name: 'ToDelete', providerVoiceId: 'el_del' }) })
    const deleted = await deleteClonedVoiceRow(projectId, v.id)
    expect(deleted?.providerVoiceId).toBe('el_del') // caller uses this to delete remotely
    expect(await getClonedVoice(projectId, v.id)).toBeNull()
    expect(await deleteClonedVoiceRow(projectId, v.id)).toBeNull() // already gone
  })
})

describe('voice-clone consent (per project + destination, remembered)', () => {
  it('returns null before any consent is recorded for that destination (fail-closed precondition)', async () => {
    const projectId = await seedProject()
    expect(await getProjectVoiceConsent(projectId, 'ElevenLabs (US)')).toBeNull()
  })

  it('records consent for a destination, then remembers it', async () => {
    const projectId = await seedProject()
    await recordProjectVoiceConsent({
      projectId,
      destination: 'ElevenLabs (US)',
      version: 'v1',
      consentAt: new Date(1781300000000),
    })
    const got = await getProjectVoiceConsent(projectId, 'ElevenLabs (US)')
    expect(got?.version).toBe('v1')
    expect(got?.destination).toBe('ElevenLabs (US)')
  })

  it('keeps each destination as its own row with its own audit (no overwrite)', async () => {
    const projectId = await seedProject()
    await recordProjectVoiceConsent({ projectId, destination: 'ElevenLabs (US)', version: 'v1', consentAt: new Date(1000) })
    await recordProjectVoiceConsent({ projectId, destination: 'VoxCPM (local)', version: 'v1', consentAt: new Date(2000) })
    // The first destination's contemporaneous consentAt is NOT mutated by consenting to the second.
    expect((await getProjectVoiceConsent(projectId, 'ElevenLabs (US)'))?.consentAt).toEqual(new Date(1000))
    expect((await getProjectVoiceConsent(projectId, 'VoxCPM (local)'))?.consentAt).toEqual(new Date(2000))
  })

  it('re-consenting to one destination updates only that row (upsert on composite PK)', async () => {
    const projectId = await seedProject()
    await recordProjectVoiceConsent({ projectId, destination: 'ElevenLabs (US)', version: 'v1', consentAt: new Date(1000) })
    await recordProjectVoiceConsent({ projectId, destination: 'ElevenLabs (US)', version: 'v2', consentAt: new Date(3000) })
    const got = await getProjectVoiceConsent(projectId, 'ElevenLabs (US)')
    expect(got?.version).toBe('v2')
    expect(got?.consentAt).toEqual(new Date(3000))
  })
})
