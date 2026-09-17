import path from 'node:path'

/**
 * Runtime-writable audio directory resolver.
 *
 * Runs in three contexts:
 *   - Next dev server process  — default: `<cwd>/public/audio`
 *   - Electron main (dev)      — inherits default via main-set env vars
 *   - Electron main (packaged) — `<userData>/audio` via env vars set in main.ts
 *
 * `DREAMBYTE_AUDIO_DIR` overrides the filesystem path.
 * `DREAMBYTE_AUDIO_URL_BASE` overrides the URL prefix stored on scene HTML
 * (`/audio/` in dev so Next serves it, `dreambyte://audio/` in packaged so
 * the protocol handler serves it).
 *
 * Both env vars are set by `src/electron/main.ts` before `app.whenReady()`,
 * so audio providers read them uniformly.
 */
export function getAudioDir(): string {
  return process.env.DREAMBYTE_AUDIO_DIR || path.join(process.cwd(), 'public', 'audio')
}

export function audioUrlFor(filename: string): string {
  const raw = process.env.DREAMBYTE_AUDIO_URL_BASE || '/audio/'
  // Defensive: tolerate configs without a trailing slash
  // (`dreambyte://audio` vs `dreambyte://audio/`). Without this, a future
  // caller could produce a URL like `dreambyte://audioxxx.mp3`.
  const base = raw.endsWith('/') ? raw : `${raw}/`
  return `${base}${filename}`
}

/**
 * Reverse of `audioUrlFor` — detects whether a URL is already a local
 * audio asset under our control (either `/audio/` or `dreambyte://audio/`).
 * Used by `downloadToLocal` to short-circuit already-local URLs.
 */
export function isLocalAudioUrl(url: string): boolean {
  return url.startsWith('/audio/') || url.startsWith('dreambyte://audio/')
}
