import path from 'node:path'
import { getUploadsDir } from './uploads/paths'
import { getAudioDir } from './audio/paths'

/**
 * Runtime-writable generated-media directory + local-URL → disk resolution.
 *
 * In the packaged app `public/` ships read-only inside `app.asar`, so
 * `process.cwd()/public/...` is unwritable and resolves local mounts
 * (`/uploads/`, `/generated/`, `/audio/`) to the wrong place. Like the
 * env-stamped resolvers in `src/lib/uploads/paths.ts` and `src/lib/audio/paths.ts`,
 * this module resolves `generated`, and provides the shared URL→path
 * dispatcher every "read a local public URL from disk" site should use
 * instead of joining `cwd()/public`.
 *
 * Dev (Next serves `public/*`):  dir `<cwd>/public/generated`, URLs stay
 * `/generated/...`. Packaged (src/electron/main.ts stamps the env):  dir
 * `<userData>/generated`, same `/generated/...` URLs — scene HTML resolves
 * them via its injected `<base>` against `dreambyte://app/`, and the protocol
 * handler rewrites `app/generated/...` onto the writable mount, exactly like
 * uploads.
 */
export function getGeneratedDir(): string {
  return process.env.DREAMBYTE_GENERATED_DIR || path.join(process.cwd(), 'public', 'generated')
}

const HOST_DIRS: Record<string, () => string> = {
  uploads: getUploadsDir,
  generated: getGeneratedDir,
  audio: getAudioDir,
}

/**
 * Resolve a LOCAL public-media URL to its absolute on-disk path, honoring the
 * per-mount env overrides. Accepts the forms call sites actually persist:
 *   `/uploads/x.png`, `/generated/images/y.png`, `/audio/z.wav`,
 *   `dreambyte://uploads/x.png` (plus the legacy `cench://`
 *   scheme, still accepted so URLs persisted by older builds keep resolving).
 * Returns null for anything else (remote URLs, unknown mounts) — callers
 * treat null as "not a local file". Traversal is rejected by containment
 * against the mount root, so a DB row poisoned with `/uploads/../../etc/x`
 * resolves to null instead of escaping.
 */
export function resolvePublicMediaPath(url: string): string | null {
  if (!url) return null
  let rest: string | null = null
  let host: string | null = null

  const scheme = /^(?:dreambyte|cench):\/\/([^/]+)\/(.*)$/.exec(url)
  if (scheme) {
    host = scheme[1]
    rest = scheme[2]
  } else if (url.startsWith('/')) {
    const m = /^\/([^/]+)\/(.+)$/.exec(url)
    if (!m) return null
    host = m[1]
    rest = m[2]
  }
  if (!host || !rest) return null

  const dirFor = HOST_DIRS[host]
  if (!dirFor) return null

  // decodeURIComponent THROWS on malformed %-sequences ('%', '%E0%'). Honor
  // the null contract instead: a poisoned
  // legacy DB row must degrade to "not a local file" (cache miss / skip), not
  // throw URIError up through checkCache / FAL inlining / deleteAsset.
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }

  const baseDir = path.resolve(dirFor())
  const abs = path.resolve(baseDir, decoded)
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null
  return abs
}
