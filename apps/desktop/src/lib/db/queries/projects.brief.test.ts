// @vitest-environment node

/**
 * OKF Layer 0 — ProjectBrief persistence round-trip. Also exercises migration
 * 0032 (the project_brief column must exist after runMigrations) and that
 * getProjectSettingsRow surfaces the brief to the agent loader.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-brief-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects } from '../schema'
import { getProjectBrief, setProjectBrief, getProjectSettingsRow } from './projects'
import type { ProjectBrief } from '@/lib/types'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedProject(): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(projects).values({ id, name: `Brief Test ${id.slice(0, 6)}` })
  return id
}

const SAMPLE: ProjectBrief = {
  aspectRatio: '16:9',
  lengthClass: 'longform',
  runtimeTargetSec: 600,
  videoType: 'film',
  logLine: 'A remote village gets power and a hospital.',
  intent: { problem: 'no power', intention: 'bring power', obstacle: 'harsh terrain', solution: 'solar + funding' },
  audience: 'YouTube documentary viewers',
  title: 'We Powered a Mountain',
  voiceDriver: 'narration-led',
  hasUploadedFootage: true,
  footageHasSpeech: true,
  isAvatarCentric: false,
  mediaStrategy: {
    research: true,
    stock: true,
    generate: false,
    userAssets: true,
    branding: false,
    overlays: { captions: true, stickers: false, svgs: false, lowerThirds: true },
  },
  source: 'agent-inferred',
  confidence: 0.8,
  version: 1,
}

describe('ProjectBrief persistence', () => {
  it('a fresh project has a null brief (column exists, default null)', async () => {
    const id = await seedProject()
    expect(await getProjectBrief(id)).toBeNull()
  })

  it('returns null for an unknown project', async () => {
    expect(await getProjectBrief('no-such-project')).toBeNull()
  })

  it('round-trips a brief through set/get', async () => {
    const id = await seedProject()
    await setProjectBrief(id, SAMPLE)
    const got = await getProjectBrief(id)
    expect(got).toEqual(SAMPLE)
  })

  it('replaces an existing brief on a second set', async () => {
    const id = await seedProject()
    await setProjectBrief(id, SAMPLE)
    const updated: ProjectBrief = { ...SAMPLE, videoType: 'shortform', lengthClass: 'shortform', version: 2 }
    await setProjectBrief(id, updated)
    const got = await getProjectBrief(id)
    expect(got?.videoType).toBe('shortform')
    expect(got?.version).toBe(2)
  })

  it('getProjectSettingsRow surfaces the brief to the agent loader', async () => {
    const id = await seedProject()
    await setProjectBrief(id, SAMPLE)
    const row = await getProjectSettingsRow(id)
    expect(row).not.toBeNull()
    expect((row as { projectBrief: ProjectBrief | null }).projectBrief?.logLine).toBe(SAMPLE.logLine)
  })
})
