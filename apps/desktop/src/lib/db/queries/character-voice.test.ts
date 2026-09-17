// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cench-character-voice-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects } from '../schema'
import { createCharacter, resolveCharacter, setCharacterVoice } from './characters'
import { createClonedVoice } from './cloned-voices'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seed() {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'Cast Test' })
  const voice = await createClonedVoice({
    projectId,
    name: 'Aria Voice',
    provider: 'elevenlabs',
    providerVoiceId: 'el_aria',
    consentAt: new Date(1781400000000),
    consentVersion: 'v1',
    consentDestination: 'ElevenLabs (US)',
  })
  return { projectId, voiceId: voice.id }
}

describe('characters.voiceId (migration 0024 applied) — the Cast face+voice link', () => {
  it('persists a bound voiceId on create and reads it back', async () => {
    const { projectId, voiceId } = await seed()
    const c = await createCharacter({ projectId, name: 'Aria', referenceAssetIds: ['face-1'], voiceId })
    expect(c.voiceId).toBe(voiceId)
    const got = await resolveCharacter(projectId, 'Aria')
    expect(got?.voiceId).toBe(voiceId)
  })

  it('defaults voiceId to null for a face-only character', async () => {
    const { projectId } = await seed()
    const c = await createCharacter({ projectId, name: 'FaceOnly', referenceAssetIds: ['face-2'] })
    expect(c.voiceId).toBeNull()
  })

  it('binds and clears a voice via setCharacterVoice', async () => {
    const { projectId, voiceId } = await seed()
    const c = await createCharacter({ projectId, name: 'Later', referenceAssetIds: ['face-3'] })
    await setCharacterVoice(projectId, c.id, voiceId)
    expect((await resolveCharacter(projectId, 'Later'))?.voiceId).toBe(voiceId)
    await setCharacterVoice(projectId, c.id, null)
    expect((await resolveCharacter(projectId, 'Later'))?.voiceId).toBeNull()
  })
})
