// @vitest-environment node

import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { createClient } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

import { runMigrations } from '@/lib/db/migrate'

/**
 * Round-trip for the encrypted-credential storage layer. We swap
 * Electron's `safeStorage` for a deterministic XOR-with-0x55 fake so
 * the test exercises the DB path without needing a real keychain.
 */

const FAKE_KEY = 0x55

function fakeSafeStorage(opts: { available?: boolean } = {}) {
  return {
    isEncryptionAvailable: () => opts.available !== false,
    encryptString: (plaintext: string): Buffer => {
      const bytes = Buffer.from(plaintext, 'utf-8')
      const out = Buffer.alloc(bytes.length)
      for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ FAKE_KEY
      return out
    },
    decryptString: (encrypted: Buffer): string => {
      const out = Buffer.alloc(encrypted.length)
      for (let i = 0; i < encrypted.length; i++) out[i] = encrypted[i] ^ FAKE_KEY
      return out.toString('utf-8')
    },
  }
}

let dbDir: string
let dbPath: string

beforeAll(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-git-cred-'))
  dbPath = path.join(dbDir, 'dreambyte.db')
  process.env.DATABASE_URL = `file:${dbPath}`
  await runMigrations({
    url: `file:${dbPath}`,
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  })
})

let credentials: typeof import('./git-credentials')
beforeAll(async () => {
  credentials = await import('./git-credentials')
})

const projectId = '00000000-0000-4000-8000-000000000099'

beforeEach(async () => {
  const client = createClient({ url: `file:${dbPath}` })
  await client.execute({
    sql: `INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)`,
    args: [projectId, 'cred-test'],
  })
  // Clean credentials between tests.
  await client.execute({ sql: `DELETE FROM git_credentials WHERE project_id = ?`, args: [projectId] })
  await client.close()
  credentials.setSafeStorage(fakeSafeStorage())
})
afterEach(() => credentials.setSafeStorage(null))

describe('git-credentials', () => {
  it('throws when safeStorage is uninitialised', async () => {
    credentials.setSafeStorage(null)
    await expect(credentials.setToken({ projectId, remoteName: 'origin', token: 't' })).rejects.toThrow(
      /safeStorage not initialised/,
    )
  })

  it('throws when the OS keychain is unavailable', async () => {
    credentials.setSafeStorage(fakeSafeStorage({ available: false }))
    await expect(credentials.setToken({ projectId, remoteName: 'origin', token: 't' })).rejects.toThrow(
      /keychain encryption unavailable/i,
    )
  })

  it('store → hasToken → loadDecryptedToken round-trip', async () => {
    await credentials.setToken({ projectId, remoteName: 'origin', token: 'ghp_abc' })
    expect(await credentials.hasToken(projectId, 'origin')).toBe(true)
    const plaintext = await credentials.loadDecryptedToken(projectId, 'origin')
    expect(plaintext).toBe('ghp_abc')
  })

  it('upserts when the same (project, remote) is set twice', async () => {
    await credentials.setToken({ projectId, remoteName: 'origin', token: 'one' })
    await credentials.setToken({ projectId, remoteName: 'origin', token: 'two' })
    expect(await credentials.loadDecryptedToken(projectId, 'origin')).toBe('two')
  })

  it('clearToken removes the row', async () => {
    await credentials.setToken({ projectId, remoteName: 'origin', token: 't' })
    expect(await credentials.hasToken(projectId, 'origin')).toBe(true)
    await credentials.clearToken(projectId, 'origin')
    expect(await credentials.hasToken(projectId, 'origin')).toBe(false)
    expect(await credentials.loadDecryptedToken(projectId, 'origin')).toBeNull()
  })

  it('rejects empty / non-string tokens', async () => {
    await expect(credentials.setToken({ projectId, remoteName: 'origin', token: '' })).rejects.toThrow(
      /non-empty string/,
    )
  })

  it('separate (project, remote) tuples store independently', async () => {
    await credentials.setToken({ projectId, remoteName: 'origin', token: 'A' })
    await credentials.setToken({ projectId, remoteName: 'upstream', token: 'B' })
    expect(await credentials.loadDecryptedToken(projectId, 'origin')).toBe('A')
    expect(await credentials.loadDecryptedToken(projectId, 'upstream')).toBe('B')
  })
})
