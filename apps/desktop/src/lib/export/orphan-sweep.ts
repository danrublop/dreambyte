/**
 * Orphan export-temp sweep selection, pure + testable.
 *
 * Tier 3 capture writes `__export-${id}-${uuid}.html` into the REAL user scenes
 * dir and per-scene MP4s into an os.tmpdir `dreambyte-tier3-*` dir, cleaned in a
 * `finally`. A SIGKILL / crash / app-quit mid-render skips the finally, leaving
 * orphans (the html pollutes the user's scene library).
 *
 * Multi-instance safety: a blunt "delete every __export-*.html" could nuke a
 * file a DIFFERENT live export (another app instance, or a >1h render) is using.
 * So each export writes a sidecar lock; the caller resolves owner liveness
 * (process.kill(pid, 0)) and feeds it in. We delete when the owner is provably
 * dead, or — for files with no lock at all — only past an age backstop.
 */

/** `__export-<id>-<uuid>.html` written into the scenes dir. */
export function isExportOrphanHtml(name: string): boolean {
  return /^__export-.*\.html$/.test(name)
}

/** Sidecar lock that pins a live export's html: `__export-...html.lock`. */
export function isExportLock(name: string): boolean {
  return /^__export-.*\.html\.lock$/.test(name)
}

/** Per-export tmp dir in os.tmpdir: `dreambyte-tier3-*`. */
export function isStaleTier3TmpDirName(name: string): boolean {
  return /^dreambyte-tier3-/.test(name)
}

export interface SweepEntry {
  name: string
  /** mtime in ms epoch. */
  mtimeMs: number
  /**
   * Owner liveness from the sidecar lock, resolved by the caller:
   *  - true  → a live process owns it (keep, even if old)
   *  - false → the owning PID is dead (crash orphan — safe to delete now)
   *  - undefined → no lock found (fall back to the age backstop)
   */
  ownerAlive?: boolean
}

/**
 * Decide which entries to delete.
 * @param entries candidate temp files/dirs (caller pre-globs the names)
 * @param nowMs   current time, ms epoch
 * @param maxAgeMs age backstop for lock-less entries (e.g. 6h)
 * @returns the names to unlink/rm
 */
export function selectOrphansToDelete(entries: ReadonlyArray<SweepEntry>, nowMs: number, maxAgeMs: number): string[] {
  return entries
    .filter((e) => {
      if (e.ownerAlive === true) return false // live export — never touch
      if (e.ownerAlive === false) return true // crashed owner — definite orphan
      // No lock info: only sweep once it's older than the backstop.
      return nowMs - e.mtimeMs > maxAgeMs
    })
    .map((e) => e.name)
}
