import type { IpcMain, BrowserWindow as BrowserWindowType } from 'electron'
import { BrowserWindow, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { timelineToFCPXML, defaultResolveAsset, type ResolvedAsset } from '@/lib/export/fcpxml'
import type { Timeline, Clip } from '@/lib/types'
import { getUserUploadsDir, getUserAudioDir, getUserGeneratedDir, getUserScenesDir } from '../paths'
import { resolveExportFfmpegBin } from './audio-normalize'
import { createLogger } from '@/lib/logger'

const log = createLogger('export-fcpxml')
const execFileAsync = promisify(execFile)

/**
 * Category: export.fcpxml
 *
 * The desktop side of the FCPXML interchange export. The pure serializer lives
 * in `src/lib/export/fcpxml.ts` (electron-free, unit-tested); this module supplies
 * the two things only the main process can: (1) a REAL `resolveAsset` that turns
 * a clip's `sourceId` into an absolute `file://` path under the user-data media
 * mounts (so the host NLE can relink), with best-effort source durations +
 * dimensions probed via the bundled ffmpeg, and (2) a Save dialog + file write.
 * Reachable from the File
 * menu's "Export FCPXML…" action and the `dreambyte:export.fcpxml` IPC channel.
 */

// ── Resolve a clip sourceId → an absolute file on disk ───────────────────────

function mountDirFor(host: string): string | null {
  switch (host) {
    case 'uploads':
      return getUserUploadsDir()
    case 'audio':
      return getUserAudioDir()
    case 'generated':
      return getUserGeneratedDir()
    case 'scenes':
      return getUserScenesDir()
    default:
      return null
  }
}

/** decodeURIComponent that yields null on a malformed escape instead of throwing. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** Join `rel` under `base`, refusing any path that escapes the mount root. */
function safeJoin(base: string, rel: string): string | null {
  const decoded = safeDecode(rel)
  // A bare/invalid '%' in a filename (e.g. "100%bonus.mp4") must skip THAT clip,
  // not throw out of the whole export.
  if (decoded == null) return null
  const cleaned = decoded.replace(/^\/+/, '')
  if (cleaned.includes('..')) return null
  const resolvedBase = path.resolve(base)
  const p = path.resolve(resolvedBase, cleaned)
  if (p !== resolvedBase && !p.startsWith(resolvedBase + path.sep)) return null
  return p
}

/**
 * Map a clip `sourceId` to an absolute filesystem path under the right media
 * mount. Mirrors `resolveMediaUrl` in export-tier3.ts but yields a real on-disk
 * path. Returns null for remote (http) sources and anything that can't be
 * contained inside a known mount.
 */
function resolveToAbsoluteFile(sourceId: string): string | null {
  if (!sourceId) return null
  const s = sourceId.trim()
  // dreambyte://<host>/<rest>
  const dm = /^dreambyte:\/\/([a-z]+)\/(.+)$/i.exec(s)
  if (dm) {
    const base = mountDirFor(dm[1].toLowerCase())
    return base ? safeJoin(base, dm[2]) : null
  }
  // Remote media has no local file to point a host NLE at.
  if (/^https?:\/\//i.test(s)) return null
  // /uploads/… /audio/… /generated/… /scenes/…
  const rel = /^\/?(uploads|audio|generated|scenes)\/(.+)$/.exec(s)
  if (rel) {
    const base = mountDirFor(rel[1])
    return base ? safeJoin(base, rel[2]) : null
  }
  // Other schemes (file:, javascript:, …) — not a relinkable local media path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    const fm = /^file:\/\/(.+)$/i.exec(s)
    if (!fm) return null
    const decoded = safeDecode(fm[1])
    return decoded == null ? null : path.resolve(decoded)
  }
  // Absolute filesystem path passes through.
  if (s.startsWith('/')) return path.resolve(s)
  // Bare filename → uploads mount (matches the tier3 resolver's default).
  return safeJoin(getUserUploadsDir(), s)
}

// ── Media probe (best-effort true durations + dimensions) ────────────────────
// Probes with the SAME ffmpeg the export pipeline already resolves
// (resolveExportFfmpegBin → the user's installed FFmpeg). ffprobe may not sit
// next to it, so we parse `ffmpeg -i`'s stderr instead. Best-effort: any failure leaves the clip on its estimated
// duration/dimensions (the host NLE re-reads the real file on relink anyway).

interface ProbeResult {
  durationSeconds?: number
  width?: number
  height?: number
}

const PROBE_TIMEOUT_MS = 30_000

function parseFfmpegProbe(stderr: string): ProbeResult {
  const out: ProbeResult = {}
  const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (dm) {
    const total = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3])
    if (Number.isFinite(total) && total > 0) out.durationSeconds = total
  }
  // First video stream line carries the WxH (e.g. "Stream #0:0 ... Video: h264 ... 1920x1080 ...").
  const vLine = stderr.split('\n').find((l) => /Stream #.*Video:/.test(l))
  if (vLine) {
    const r = /\b(\d{2,5})x(\d{2,5})\b/.exec(vLine)
    if (r) {
      out.width = Number(r[1])
      out.height = Number(r[2])
    }
  }
  return out
}

async function probeFile(bin: string, file: string): Promise<ProbeResult | null> {
  try {
    // `ffmpeg -i <file>` with no output operation prints stream info to stderr and
    // exits non-zero — so the metadata arrives via the rejection's `stderr`.
    await execFileAsync(bin, ['-hide_banner', '-i', file], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: PROBE_TIMEOUT_MS,
    })
    return null // unexpected clean exit (no metadata captured)
  } catch (err) {
    const stderr = String((err as { stderr?: unknown } | undefined)?.stderr ?? '')
    if (!stderr) return null
    const r = parseFfmpegProbe(stderr)
    return r.durationSeconds || r.width ? r : null
  }
}

/** Probe every unique resolvable on-disk media file referenced by the timeline. */
async function probeTimelineMedia(timeline: Timeline): Promise<Map<string, ProbeResult>> {
  const out = new Map<string, ProbeResult>()
  // No FFmpeg installed → keep the estimated durations (probing is best-effort).
  const bin = await resolveExportFfmpegBin().catch(() => null)
  if (!bin) return out
  const files = new Set<string>()
  for (const track of timeline.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.sourceType === 'scene' || clip.sourceType === 'title') continue
      const abs = resolveToAbsoluteFile(clip.sourceId)
      if (abs && fsSync.existsSync(abs)) files.add(abs)
    }
  }
  await Promise.all(
    [...files].map(async (file) => {
      const r = await probeFile(bin, file)
      if (r) out.set(file, r)
    }),
  )
  return out
}

/**
 * A desktop resolver: keep the default's sourceType→flags mapping but override
 * the `src` with a real absolute `file://` path and (where probing found them)
 * the true source duration + dimensions, so assets relink in the host NLE.
 */
function makeDesktopResolver(probes: Map<string, ProbeResult>): (clip: Clip) => ResolvedAsset | null {
  return (clip) => {
    const base = defaultResolveAsset(clip)
    if (!base) return null // scene / title — skipped (honest; needs an MP4 render)
    const abs = resolveToAbsoluteFile(clip.sourceId)
    let src = base.src
    let probe: ProbeResult | undefined
    if (abs && fsSync.existsSync(abs)) {
      src = pathToFileURL(abs).href
      probe = probes.get(abs)
    }
    return {
      ...base,
      src,
      durationSeconds:
        probe?.durationSeconds && probe.durationSeconds > 0 ? probe.durationSeconds : base.durationSeconds,
      width: probe?.width ?? base.width,
      height: probe?.height ?? base.height,
    }
  }
}

// ── Public: serialize + Save dialog + write ──────────────────────────────────

export interface ExportFcpxmlArgs {
  timeline: Timeline
  fps?: number
  width?: number
  height?: number
  name?: string
  /** Suggested filename for the Save dialog. */
  defaultFileName?: string
}

export interface ExportFcpxmlResult {
  saved: boolean
  canceled?: boolean
  path?: string
  clipCount?: number
  skipped?: Array<{ clipId: string; sourceType: string; reason: string }>
  error?: string
}

/**
 * Resolve assets, serialize the timeline to FCPXML, prompt for a save location,
 * and write the file. Returns a structured result (never throws across IPC).
 */
export async function exportTimelineToFcpxmlFile(
  args: ExportFcpxmlArgs,
  win?: BrowserWindowType,
): Promise<ExportFcpxmlResult> {
  try {
    const timeline = args.timeline
    if (!timeline || !Array.isArray(timeline.tracks) || timeline.tracks.length === 0) {
      return { saved: false, error: 'No timeline to export. Add media clips to the timeline first.' }
    }

    const probes = await probeTimelineMedia(timeline)
    const result = timelineToFCPXML(timeline, {
      fps: args.fps ?? 30,
      width: args.width,
      height: args.height,
      name: args.name ?? 'Dreambyte Timeline',
      resolveAsset: makeDesktopResolver(probes),
    })

    const defaultName = (args.defaultFileName ?? 'dreambyte-timeline.fcpxml').replace(/[^a-zA-Z0-9._-]/g, '-')
    const dialogOpts = {
      title: 'Export FCPXML',
      defaultPath: defaultName.endsWith('.fcpxml') ? defaultName : `${defaultName}.fcpxml`,
      filters: [{ name: 'Final Cut Pro XML', extensions: ['fcpxml'] }],
    }
    const parent = win ?? BrowserWindow.getFocusedWindow()
    const saveResult = parent
      ? await dialog.showSaveDialog(parent, dialogOpts)
      : await dialog.showSaveDialog(dialogOpts)
    if (saveResult.canceled || !saveResult.filePath) {
      return { saved: false, canceled: true }
    }

    const filePath = saveResult.filePath.endsWith('.fcpxml')
      ? saveResult.filePath
      : `${saveResult.filePath}.fcpxml`
    await fs.writeFile(filePath, result.xml, 'utf-8')
    log.info('fcpxml export written', {
      extra: { path: filePath, clips: result.clipCount, skipped: result.skipped.length },
    })
    return { saved: true, path: filePath, clipCount: result.clipCount, skipped: result.skipped }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('fcpxml export failed', { extra: { error: message } })
    return { saved: false, error: message }
  }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:export.fcpxml', async (evt, args: ExportFcpxmlArgs) => {
    const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined
    return exportTimelineToFcpxmlFile(args, win)
  })
}
