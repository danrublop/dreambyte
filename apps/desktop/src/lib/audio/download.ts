import fs from 'fs/promises'
import path from 'path'
import { getAudioDir, audioUrlFor, isLocalAudioUrl } from './paths'

/** Allowed hostnames for audio downloads (known audio providers) */
const ALLOWED_HOSTS = new Set([
  'freesound.org',
  'www.freesound.org',
  'cdn.freesound.org',
  'pixabay.com',
  'cdn.pixabay.com',
  'api.elevenlabs.io',
  'storage.googleapis.com',
  // fal output CDN — where fal Stable Audio (music gen) serves the generated clip.
  // Exact hosts, NOT a wildcard, to keep the SSRF allowlist tight.
  'fal.media',
  'v3.fal.media',
])

/**
 * Client-only TTS sentinels (`web-speech://`, `puter-tts://`) only synthesize in
 * the browser preview — there is no downloadable audio file behind them, so they
 * are SILENT at MP4 export. Any export-path caller must detect this and surface a
 * loud warning rather than ship a narration-less video. Single source of truth so
 * the sentinel set never drifts between the download path and the export resolver.
 */
export function isClientOnlyTtsUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && (url.startsWith('web-speech://') || url.startsWith('puter-tts://'))
}

/**
 * Client-only TTS provider ids. These short-circuit to a client-render with NO
 * downloadable url (`tts.src` stays null), so detecting them by sentinel url is
 * useless — the export path must check the provider id instead.
 */
export function isClientOnlyTtsProvider(provider: string | null | undefined): boolean {
  return provider === 'web-speech' || provider === 'puter' || provider === 'puter-tts'
}

/** Max download size: 50MB */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

/** Cap the audio download so a hung provider CDN can't stall the agent turn (large binary → 120s). */
const DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * Validate that a URL is safe to fetch (not internal/SSRF).
 * Only allows HTTPS to known audio provider hosts.
 */
function validateDownloadUrl(remoteUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch {
    throw new Error('Invalid download URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS download URLs are allowed')
  }

  // Block private/internal IPs even if hostname resolves to them
  const hostname = parsed.hostname.toLowerCase()
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.startsWith('169.254.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new Error('Download from internal addresses is not allowed')
  }

  // Check against allowlist
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(`Download not allowed from host: ${hostname}`)
  }
}

/**
 * Download a remote audio URL to public/audio/ and return the local path.
 * If the URL is already local (/audio/...), returns it unchanged.
 * Used to ensure SFX/music from Freesound/Pixabay are available for
 * scene HTML (same-origin) and WVC export (headless, no cross-origin).
 */
export async function downloadToLocal(remoteUrl: string, prefix: string = 'dl'): Promise<string> {
  // Already local
  if (
    isLocalAudioUrl(remoteUrl) ||
    remoteUrl.startsWith('/uploads/') ||
    remoteUrl.startsWith('dreambyte://uploads/') ||
    remoteUrl.startsWith('/sfx-library/')
  ) {
    return remoteUrl
  }

  // Client-only sentinel URLs — can't download (preview-only, silent at export)
  if (isClientOnlyTtsUrl(remoteUrl)) {
    return remoteUrl
  }

  validateDownloadUrl(remoteUrl)

  const audioDir = getAudioDir()
  await fs.mkdir(audioDir, { recursive: true })

  // Determine file extension from URL or default to mp3
  let ext = '.mp3'
  try {
    const urlPath = new URL(remoteUrl).pathname
    ext = path.extname(urlPath) || '.mp3'
  } catch {
    // Malformed URL — use default extension
  }
  const filename = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  const filePath = path.join(audioDir, filename)

  const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`Failed to download audio: ${res.status} ${res.statusText}`)
  }

  // Check content-length before buffering
  const contentLength = res.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    throw new Error('Audio file too large to download')
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error('Audio file too large to download')
  }

  await fs.writeFile(filePath, buffer)

  return audioUrlFor(filename)
}
