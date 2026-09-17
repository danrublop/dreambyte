/**
 * Encrypted git credential storage.
 *
 * Personal Access Tokens for Tier 2 remotes are wrapped by Electron's
 * `safeStorage` (an OS-keychain-backed crypto layer) before they touch
 * SQLite. Plaintext only exists in-memory in the main process, for the
 * duration of one push/pull call.
 *
 * Design notes:
 *   - Renderer code never sees the plaintext token. The IPC layer only
 *     exposes `hasToken`/`clearToken`/`setToken(plaintext) → ok`; reading
 *     happens only through `loadDecryptedToken(...)` inside push/pull
 *     handlers that live next door in the main process.
 *   - When `safeStorage.isEncryptionAvailable()` is false (Linux without
 *     a desktop keychain, CI, headless), we refuse to store/read. The
 *     user gets a clear "configure OS keychain first" error instead of
 *     silently storing plaintext.
 *   - The `_safeStorageInjector` indirection exists so unit tests can
 *     pass a fake safeStorage that does deterministic XOR-with-zero
 *     "encryption" — that's enough to exercise the DB round-trip
 *     without needing an actual keychain.
 */

import { db } from '@/lib/db'
import { gitCredentials } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

let activeSafeStorage: SafeStorageLike | null = null

/**
 * Injected at boot from `src/electron/main.ts` with `app.safeStorage`. Tests
 * pass a synthetic implementation. When unset, every operation throws so
 * a misconfigured boot fails loudly instead of silently bypassing
 * encryption.
 */
export function setSafeStorage(impl: SafeStorageLike | null): void {
  activeSafeStorage = impl
}

function requireSafeStorage(): SafeStorageLike {
  if (!activeSafeStorage) {
    throw new Error(
      'safeStorage not initialised. Call setSafeStorage(app.safeStorage) during Electron boot.',
    )
  }
  if (!activeSafeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption unavailable on this system. Configure a keychain (macOS Keychain / GNOME Keyring / Windows DPAPI) before storing remote tokens.',
    )
  }
  return activeSafeStorage
}

export async function setToken(args: {
  projectId: string
  remoteName: string
  token: string
}): Promise<void> {
  if (typeof args.token !== 'string' || args.token.length === 0) {
    throw new Error('token must be a non-empty string')
  }
  const ss = requireSafeStorage()
  const encrypted = ss.encryptString(args.token)
  // Drizzle's blob() column takes a Buffer; libsql binds it as a raw
  // BLOB. Upsert in case the same (project, remote) gets re-set.
  await db
    .insert(gitCredentials)
    .values({
      projectId: args.projectId,
      remoteName: args.remoteName,
      encryptedToken: encrypted,
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [gitCredentials.projectId, gitCredentials.remoteName],
      set: { encryptedToken: encrypted, createdAt: Date.now() },
    })
}

export async function hasToken(projectId: string, remoteName: string): Promise<boolean> {
  const row = await db.query.gitCredentials.findFirst({
    where: and(eq(gitCredentials.projectId, projectId), eq(gitCredentials.remoteName, remoteName)),
  })
  return !!row
}

export async function clearToken(projectId: string, remoteName: string): Promise<void> {
  await db
    .delete(gitCredentials)
    .where(and(eq(gitCredentials.projectId, projectId), eq(gitCredentials.remoteName, remoteName)))
}

/**
 * Main-process-only: return the plaintext token. Intended to be called
 * from push/pull IPC handlers right before invoking `gitPush`/`gitPull`,
 * and discarded immediately after.
 */
export async function loadDecryptedToken(
  projectId: string,
  remoteName: string,
): Promise<string | null> {
  const row = await db.query.gitCredentials.findFirst({
    where: and(eq(gitCredentials.projectId, projectId), eq(gitCredentials.remoteName, remoteName)),
  })
  if (!row) return null
  const ss = requireSafeStorage()
  // libsql may hand us a Uint8Array — coerce to Buffer for safeStorage.
  const raw = row.encryptedToken
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
  return ss.decryptString(buf)
}
