/**
 * One-shot migration: strip legacy error beacons from ALREADY-PUBLISHED
 * embed bundles.
 *
 * Publishes made before the beacon marker existed copied editor HTML
 * verbatim, so `<userData>/published/<projectId>/scenes/*.html` files from
 * that era still carry the unmarked beacon (and the legacy inline jsx-error
 * post) — both broadcast scene error strings to the third-party host page
 * via postMessage('*') every time the embed loads.
 *
 * Sweep shape mirrors scene-html-gc: background after boot, DI'd fs for
 * tests, per-file errors swallowed (one unreadable file must not abort the
 * rest), and writes ONLY when the strip actually changed the content. A
 * marker file (`.beacon-migration-v1`) makes it one-shot — delete the marker
 * to force a re-run after restoring old bundles from backup.
 *
 * Scope honesty: this fixes the LOCAL bundle (and anything re-hosted from
 * it). Copies already pushed to an external host are out of reach here.
 */

import { stripErrorBeacon } from './agents/error-capture-shared'

export const MIGRATION_MARKER = '.beacon-migration-v1'

export interface PublishedMigrationFs {
  readdir(dir: string): Promise<string[]>
  readFile(p: string): Promise<string>
  writeFile(p: string, content: string): Promise<void>
  exists(p: string): Promise<boolean>
  isDirectory(p: string): Promise<boolean>
}

export interface PublishedMigrationResult {
  /** Files rewritten (strip changed the content). */
  migrated: number
  /** Scene HTML files inspected. */
  scanned: number
  /** True when the marker short-circuited the sweep. */
  skipped: boolean
  /** Per-file failures (path only — errors are swallowed by design). */
  failed: number
}

const SCENE_HTML_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html$/i

export async function migratePublishedBeacons(opts: {
  publishedDir: string
  fs: PublishedMigrationFs
  /** Path joiner injected so the module stays platform-pure in tests. */
  join: (...parts: string[]) => string
}): Promise<PublishedMigrationResult> {
  const { publishedDir, fs, join } = opts
  const result: PublishedMigrationResult = { migrated: 0, scanned: 0, skipped: false, failed: 0 }

  if (!(await fs.exists(publishedDir))) {
    // Nothing ever published — write nothing, not even the marker (the dir
    // may be created later by a first publish; the sweep re-checks next boot).
    return result
  }
  const marker = join(publishedDir, MIGRATION_MARKER)
  if (await fs.exists(marker)) {
    result.skipped = true
    return result
  }

  let projectDirs: string[]
  try {
    projectDirs = await fs.readdir(publishedDir)
  } catch {
    return result // unreadable base dir — try again next boot (no marker written)
  }

  for (const projectId of projectDirs) {
    const scenesDir = join(publishedDir, projectId, 'scenes')
    try {
      if (!(await fs.isDirectory(scenesDir))) continue
      const files = await fs.readdir(scenesDir)
      for (const file of files) {
        if (!SCENE_HTML_RE.test(file)) continue // scene-id-shaped files only
        const p = join(scenesDir, file)
        try {
          result.scanned++
          const html = await fs.readFile(p)
          const stripped = stripErrorBeacon(html)
          if (stripped !== html) {
            await fs.writeFile(p, stripped)
            result.migrated++
          }
        } catch {
          result.failed++ // one bad file must not abort the sweep
        }
      }
    } catch {
      result.failed++
    }
  }

  // Stamp completion ONLY after a full pass with zero failures — a partial
  // sweep (locked file, transient IO) retries on the next boot instead of
  // being silently stamped done.
  if (result.failed === 0) {
    try {
      await fs.writeFile(marker, new Date().toISOString())
    } catch {
      /* marker write failed — harmless, the sweep is idempotent */
    }
  }
  return result
}
