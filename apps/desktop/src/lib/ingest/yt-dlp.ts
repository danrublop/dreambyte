/**
 * yt-dlp wrapper — shells out to the `yt-dlp` binary for metadata probe + download.
 *
 * Two-step pattern (per reclip):
 *   1. probe(url) → returns title, duration, thumbnail, available formats
 *   2. download(url, formatId, destPath) → streams the chosen format
 *
 * The binary MUST be on PATH. Install with `brew install yt-dlp` or `pip install yt-dlp`.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface YtDlpFormat {
  formatId: string
  ext: string
  resolution?: string
  width?: number
  height?: number
  fps?: number
  filesize?: number
  vcodec?: string
  acodec?: string
  formatNote?: string
}

export interface YtDlpProbeResult {
  title: string
  durationSec: number
  thumbnail?: string
  uploader?: string
  webpageUrl: string
  extractor: string
  formats: YtDlpFormat[]
  /** A short recommended format id that yt-dlp would pick by default for decent mp4. */
  recommendedFormatId: string
}

export class YtDlpNotInstalledError extends Error {
  constructor() {
    super('yt-dlp binary not found on PATH. Install with: brew install yt-dlp  (or  pip install yt-dlp)')
    this.name = 'YtDlpNotInstalledError'
  }
}

async function runYtDlp(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('yt-dlp', args, {
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 50 * 1024 * 1024,
    })
  } catch (e: any) {
    if (e?.code === 'ENOENT' || /command not found|ENOENT/i.test(e?.message ?? '')) {
      throw new YtDlpNotInstalledError()
    }
    throw e
  }
}

/** Run `yt-dlp -J <url>` to get video info JSON without downloading. */
export async function probe(url: string, opts: { timeoutMs?: number } = {}): Promise<YtDlpProbeResult> {
  const { stdout } = await runYtDlp(['-J', '--no-warnings', '--no-playlist', url], {
    timeoutMs: opts.timeoutMs ?? 45_000,
  })
  const info = JSON.parse(stdout) as {
    title: string
    duration: number
    thumbnail?: string
    uploader?: string
    webpage_url: string
    extractor: string
    formats?: Array<{
      format_id: string
      ext: string
      resolution?: string
      width?: number
      height?: number
      fps?: number
      filesize?: number
      filesize_approx?: number
      vcodec?: string
      acodec?: string
      format_note?: string
    }>
    format_id?: string
  }

  const formats: YtDlpFormat[] = (info.formats ?? [])
    // Drop audio-only and video-only formats where possible; keep mp4+m4a complete formats.
    .filter((f) => f.vcodec && f.vcodec !== 'none')
    .map((f) => ({
      formatId: f.format_id,
      ext: f.ext,
      resolution: f.resolution,
      width: f.width,
      height: f.height,
      fps: f.fps,
      filesize: f.filesize ?? f.filesize_approx,
      vcodec: f.vcodec,
      acodec: f.acodec,
      formatNote: f.format_note,
    }))
    // Rank: prefer combined (has audio) mp4 in descending resolution.
    .sort((a, b) => {
      const aScore = (a.acodec && a.acodec !== 'none' ? 1000 : 0) + (a.ext === 'mp4' ? 500 : 0) + (a.height ?? 0)
      const bScore = (b.acodec && b.acodec !== 'none' ? 1000 : 0) + (b.ext === 'mp4' ? 500 : 0) + (b.height ?? 0)
      return bScore - aScore
    })

  // Recommended format: yt-dlp's own default, clamped to <=1080p for sanity.
  const reco = formats.find((f) => (f.height ?? 0) <= 1080 && f.acodec && f.acodec !== 'none') ?? formats[0]

  return {
    title: info.title,
    durationSec: info.duration,
    thumbnail: info.thumbnail,
    uploader: info.uploader,
    webpageUrl: info.webpage_url,
    extractor: info.extractor,
    formats,
    recommendedFormatId: reco?.formatId ?? info.format_id ?? 'best[height<=1080]',
  }
}

export interface YtDlpDownloadOptions {
  url: string
  destPath: string
  formatId?: string
  /** Max clip length in seconds — enforced BEFORE download starts. yt-dlp won't truncate. */
  maxDurationSec?: number
  timeoutMs?: number
}

export interface YtDlpDownloadResult {
  destPath: string
  title: string
  durationSec: number
  width?: number
  height?: number
  formatId: string
  sourceUrl: string
}

/**
 * Download a URL's video to `destPath`. Probes first to enforce duration caps
 * and to resolve a default format when `formatId` isn't specified.
 */
export async function download(opts: YtDlpDownloadOptions): Promise<YtDlpDownloadResult> {
  const { url, destPath, maxDurationSec, formatId, timeoutMs = 300_000 } = opts
  const info = await probe(url, { timeoutMs: Math.min(timeoutMs, 45_000) })
  if (maxDurationSec && info.durationSec > maxDurationSec) {
    throw new Error(
      `Video is ${Math.round(info.durationSec)}s, exceeds cap of ${maxDurationSec}s. Try a shorter clip or a different URL.`,
    )
  }

  const effectiveFormat = formatId ?? info.recommendedFormatId
  // --merge-output-format ensures we get a single .mp4 even when yt-dlp assembles video+audio tracks.
  const args = [
    '-f',
    effectiveFormat,
    '--merge-output-format',
    'mp4',
    '--no-warnings',
    '--no-playlist',
    '-o',
    destPath,
    url,
  ]
  await runYtDlp(args, { timeoutMs })

  // Probe resolution from the chosen format entry if available
  const chosen = info.formats.find((f) => f.formatId === effectiveFormat) ?? info.formats[0]
  return {
    destPath,
    title: info.title,
    durationSec: info.durationSec,
    width: chosen?.width,
    height: chosen?.height,
    formatId: effectiveFormat,
    sourceUrl: info.webpageUrl,
  }
}
