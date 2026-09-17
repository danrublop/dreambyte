import path from 'node:path'

/**
 * Runtime-writable uploads directory resolver.
 *
 * Mirrors `src/lib/audio/paths.ts` for uploaded/ingested media
 * (yt-dlp downloads, direct-URL ingest, user file uploads).
 *
 * `DREAMBYTE_UPLOADS_DIR` overrides the filesystem path.
 * `DREAMBYTE_UPLOADS_URL_BASE` overrides the URL prefix.
 *
 * Dev defaults (Next serves `public/uploads/*` at `/uploads/*`):
 *   dir:  `<cwd>/public/uploads`
 *   base: `/uploads/`
 *
 * Packaged (set by src/electron/main.ts):
 *   dir:  `<userData>/uploads`
 *   base: `dreambyte://uploads/`
 */
export function getUploadsDir(): string {
  return process.env.DREAMBYTE_UPLOADS_DIR || path.join(process.cwd(), 'public', 'uploads')
}

export function uploadsUrlFor(relativePath: string): string {
  const raw = process.env.DREAMBYTE_UPLOADS_URL_BASE || '/uploads/'
  const base = raw.endsWith('/') ? raw : `${raw}/`
  // Strip any leading slash on `relativePath` so joining never yields `//`.
  const rel = relativePath.replace(/^\/+/, '')
  return `${base}${rel}`
}
