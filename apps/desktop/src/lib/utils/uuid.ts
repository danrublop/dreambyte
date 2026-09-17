/**
 * Canonical UUID validator (renderer- and node-safe).
 *
 * Mirrors the `UUID_RE` inlined in the IPC layer (`src/electron/ipc/_helpers.ts`)
 * and several services. The renderer should gate any call to a UUID-validated
 * IPC (e.g. `projects.getVersion`, `projects.update`) on this so it never sends
 * an empty/legacy id that the main process will reject + log as an error.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id)
}
