/**
 * Per-scene save-conflict reconciliation.
 *
 * When saveProjectToDb's version-CAS rejects (the MCP bridge / another writer
 * advanced the project since our last read), the retry used to substitute the
 * DB's scene array WHOLESALE into the payload (agent-wins): the local edit
 * that triggered the save was displaced from that write while the status
 * claimed 'saved'. This module replaces that with an id-keyed THREE-WAY merge
 * using content hashes of the scenes we last successfully wrote (the
 * "baseline") as the common ancestor:
 *
 *   present in local + remote:
 *     local dirty (hash ≠ baseline, or no baseline entry) → LOCAL wins
 *     local clean                                         → REMOTE wins
 *   local only (remote deleted it):
 *     local dirty → KEEP local (preserve the user's unsaved work over a
 *                   concurrent remote delete — content loss is worse than a
 *                   resurrected scene)
 *     local clean → DROP (honor the remote delete; we have nothing newer)
 *   remote only (local doesn't have it):
 *     no baseline entry                → KEEP (remote added it)
 *     baseline entry, hash == baseline → DROP (the USER deleted it locally
 *                                        and remote never touched it after
 *                                        our last save — honor the delete)
 *     baseline entry, hash ≠ baseline  → KEEP (remote edited what the user
 *                                        deleted — preserve the newer content
 *                                        over the stale delete)
 *
 * Order: remote array order is the base (it reflects the newest persisted
 * ordering); local-only survivors are inserted at their local index, clamped.
 *
 * The baseline lives in module state in project-actions.ts and is refreshed
 * at every point local state and the DB are known to agree (successful save,
 * project load, server refresh, branch load). NO baseline (first save after
 * a path that didn't set one) degrades to the OLD agent-wins behavior — a
 * regression-free fallback, never a guess.
 */

/**
 * djb2 over the scene's JSON, with the serialized LENGTH folded in — cheap,
 * stable, and we only ever compare hashes produced by this same function in
 * this same process. The length component means any length-changing edit
 * (virtually every code edit) can NEVER collide; same-length collisions keep
 * the 32-bit djb2 odds (~2^-32 per comparison). The asymmetric cost of a
 * collision here is a silently displaced user edit (review #156), so the
 * extra few bits are worth the one string concat.
 */
export function hashScene(scene: unknown): string {
  const s = JSON.stringify(scene)
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return `${h}:${s.length}`
}

export type SceneBaseline = Map<string, string>

export function buildSceneBaseline(scenes: ReadonlyArray<{ id: string }>): SceneBaseline {
  const m: SceneBaseline = new Map()
  for (const s of scenes) m.set(s.id, hashScene(s))
  return m
}

export interface ReconcileResult<S> {
  merged: S[]
  /** Local scenes that won their slot (dirty overlays + dirty local-only keeps). */
  keptLocalIds: string[]
  /** Remote-only scenes dropped because the user deleted them and remote never
   *  re-touched them. (Clean local-only scenes dropped to honor a REMOTE
   *  delete are silently omitted, not reported here.) */
  droppedIds: string[]
}

export function reconcileScenesForRetry<S extends { id: string }>(
  localScenes: ReadonlyArray<S>,
  remoteScenes: ReadonlyArray<S>,
  baseline: SceneBaseline,
): ReconcileResult<S> {
  const localById = new Map(localScenes.map((s) => [s.id, s]))
  const localIndex = new Map(localScenes.map((s, i) => [s.id, i]))
  const remoteIds = new Set(remoteScenes.map((s) => s.id))
  const isLocalDirty = (s: S): boolean => {
    const base = baseline.get(s.id)
    return base === undefined || base !== hashScene(s)
  }

  const keptLocalIds: string[] = []
  const droppedIds: string[] = []
  const merged: S[] = []

  // Remote order is the base; overlay dirty local content in place.
  for (const remote of remoteScenes) {
    const local = localById.get(remote.id)
    if (local && isLocalDirty(local)) {
      merged.push(local)
      keptLocalIds.push(local.id)
      continue
    }
    if (!local) {
      const base = baseline.get(remote.id)
      if (base !== undefined && base === hashScene(remote)) {
        // User deleted it locally; remote content is byte-identical to what we
        // last saved — nothing newer to preserve. Honor the delete.
        droppedIds.push(remote.id)
        continue
      }
      // Remote added it, or remote edited it after the user's delete — keep.
    }
    merged.push(remote)
  }

  // Local-only scenes (remote deleted or never saw them): keep only dirty ones.
  for (const local of localScenes) {
    if (remoteIds.has(local.id)) continue
    if (!isLocalDirty(local)) continue // clean + remote-deleted → honor the delete
    keptLocalIds.push(local.id)
    const at = Math.min(localIndex.get(local.id) ?? merged.length, merged.length)
    merged.splice(at, 0, local)
  }

  return { merged, keptLocalIds, droppedIds }
}
