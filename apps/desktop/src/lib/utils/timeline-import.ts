/**
 * Import a media file from the OS onto the project's timeline.
 *
 * Pipeline:
 *   1. Classify by MIME type (`video` / `audio` / `image`).
 *   2. Upload via `dreambyteApi.projects.uploadAsset` so the file lands in
 *      `~/.dreambyte/projects/{id}/assets/...` and we get a stable `publicUrl`.
 *      This avoids the blob-URL persistence bug — clips survive reload.
 *   3. Probe duration against the new stable URL.
 *   4. Find first eligible non-locked track of the right kind (or auto-create).
 *   5. addClip at the end of that track.
 *
 * Used by both the Timeline drop handler and the window-level Editor drop
 * fallback, so users can drop a file anywhere in the app and have it land
 * sensibly.
 */

import { useVideoStore } from '@/lib/store'
import { classifyMediaFile, probeMediaDuration } from '@/lib/utils/media-probe'
import type { ProjectAsset } from '@/lib/types'

export interface ImportResult {
  ok: boolean
  /** Human-readable message for the toast slot. */
  error?: string
  /** Clip id (when ok). */
  clipId?: string
}

/**
 * W2 — concurrency cap for parallel uploads. 3 keeps the ffmpeg/ffprobe pool
 * lively without spiking CPU above ~70% on a typical machine. Below 2 is
 * sequential (defeats the optimization); above 5 saturates I/O for the SQLite
 * row inserts and starts to thrash the disk.
 */
const UPLOAD_CONCURRENCY = 3

/**
 * Peak-memory ceiling. Each in-flight upload holds an ArrayBuffer up to
 * 100MB; allowing unlimited queue depth lets a drop of 200 large files pin
 * GBs in renderer memory until the queue drains. 20 is a balance between
 * "user can drop a folder of clips" and "renderer OOM is unlikely on a 4GB
 * machine."
 */
const MAX_FILES_PER_DROP = 20

/**
 * Import a batch of files. Uploads run with bounded concurrency, then clip
 * placement happens sequentially in input order so `endOfTrack` advances
 * correctly between clips on the same track. Reports progress via the
 * `showTransientStatus` slot so the user sees "Importing 2 of 5..." in the
 * bottom status bar instead of staring at a frozen UI.
 */
export async function importFilesToTimeline(files: File[], onError?: (msg: string) => void): Promise<ImportResult[]> {
  if (files.length === 0) return []
  // Refuse to enqueue more than MAX_FILES_PER_DROP. The trimmed files
  // are surfaced as a single error so the user knows what got dropped.
  if (files.length > MAX_FILES_PER_DROP) {
    onError?.(`Too many files: ${files.length}. Importing the first ${MAX_FILES_PER_DROP}.`)
    files = files.slice(0, MAX_FILES_PER_DROP)
  }
  const store = useVideoStore.getState()
  const total = files.length
  let completed = 0

  // Upload pass — parallel up to UPLOAD_CONCURRENCY.
  type UploadOutcome = { index: number; preflight: PreflightResult }
  const uploadResults = new Map<number, PreflightResult>()
  const queue: number[] = files.map((_, i) => i)

  const worker = async () => {
    while (queue.length > 0) {
      const i = queue.shift()
      if (i === undefined) return
      const outcome: UploadOutcome = { index: i, preflight: await preflightAndUpload(files[i]) }
      uploadResults.set(outcome.index, outcome.preflight)
      completed += 1
      if (total > 1) store.showTransientStatus?.(`Importing ${completed} of ${total}...`, 2000)
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, worker))

  // Placement pass — sequential, in original order.
  const results: ImportResult[] = []
  for (let i = 0; i < files.length; i++) {
    const pre = uploadResults.get(i)!
    if (!pre.ok) {
      if (pre.error) onError?.(pre.error)
      results.push({ ok: false, error: pre.error })
      continue
    }
    const placed = placeAssetOnTimeline(pre.asset, pre.kind)
    if (!placed.ok && placed.error) onError?.(placed.error)
    results.push(placed)
  }

  if (total > 1) {
    const ok = results.filter((r) => r.ok).length
    store.showTransientStatus?.(`Imported ${ok} of ${total}`, 1500)
  }
  return results
}

// Match the limits enforced by src/lib/services/upload-asset.ts so the renderer
// can reject oversized files before sending a 200MB ArrayBuffer over IPC.
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
// Path-based uploads stream from disk in main (src/electron/preload getPathForFile),
// so these caps mirror src/lib/services/upload-asset.ts rather than IPC limits.
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024
const MAX_AUDIO_BYTES = 300 * 1024 * 1024

type MediaKind = 'video' | 'audio' | 'image'

type PreflightOk = {
  ok: true
  kind: MediaKind
  asset: ProjectAsset
  filename: string
}
type PreflightFail = { ok: false; error: string }
type PreflightResult = PreflightOk | PreflightFail

/**
 * Image clips have no intrinsic duration. Pick a sensible default that
 * the user can stretch via the timeline trim handles. 5s matches the
 * fallback used for video clips when ffprobe didn't report a duration.
 */
const DEFAULT_IMAGE_DURATION = 5

/**
 * Stage 1 — validate + upload. Pure-ish: doesn't touch the timeline. Returns
 * either the uploaded asset (also surfaced in the gallery via
 * `addProjectAsset`) or a structured error message. Safe to call in parallel.
 */
async function preflightAndUpload(file: File): Promise<PreflightResult> {
  const kind = classifyMediaFile(file)
  if (!kind) {
    return {
      ok: false,
      error: `Unsupported file: ${file.name}. Drop mp4, mov, webm, wav, mp3, or images.`,
    }
  }

  // B14 — pre-check size in the renderer to avoid a wasted IPC round-trip.
  const sizeCap = kind === 'video' ? MAX_VIDEO_BYTES : kind === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES
  if (file.size > sizeCap) {
    const mb = Math.round(sizeCap / 1024 / 1024)
    return { ok: false, error: `File too large: ${file.name}. Max ${mb}MB.` }
  }

  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
  if (!ipc?.uploadAsset) {
    return { ok: false, error: 'File import requires the desktop runtime.' }
  }

  // B6 — snapshot projectId at the start.
  const projectIdAtStart = useVideoStore.getState().project.id
  if (!projectIdAtStart) return { ok: false, error: 'No project loaded.' }

  let asset: ProjectAsset
  try {
    // Prefer streaming from disk (no IPC payload — large footage works).
    const filePath = ipc.getPathForFile?.(file) || ''
    const result = await ipc.uploadAsset({
      projectId: projectIdAtStart,
      ...(filePath ? { filePath } : { data: await file.arrayBuffer() }),
      mimeType: file.type || 'application/octet-stream',
      originalName: file.name,
      // N2 — auto-tag.
      tags: ['timeline-import'],
    })
    asset = result.asset as unknown as ProjectAsset
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed.'
    return { ok: false, error: `Could not import ${file.name}: ${msg}` }
  }

  // B6 cont. — refuse to place clips on a different project than the user
  // started with. Asset stays uploaded in the original project's directory.
  const projectIdNow = useVideoStore.getState().project.id
  if (projectIdNow !== projectIdAtStart) {
    return { ok: false, error: `Import aborted: project changed during upload of ${file.name}.` }
  }

  // Surface the asset in the gallery.
  useVideoStore.getState().addProjectAsset(asset)
  return { ok: true, kind, asset, filename: file.name }
}

/**
 * Stage 2 — place the (already-uploaded) asset on the timeline as a clip.
 * Sequential by design: each call reads the current end-of-track to position
 * the new clip, so callers must invoke in their desired display order.
 *
 * Track routing: audio → audio track; video and image → video track. Image
 * clips ride on the video track because they're visually-compositable
 * (Pixi renders them via `renderImageClip`), while their clip.sourceType
 * stays 'image' so the compositor picks the right code path.
 */
function placeAssetOnTimeline(asset: ProjectAsset, kind: MediaKind): ImportResult {
  // Prefer ffprobe duration when present (video/audio), fall back
  // to 5s for video/audio without metadata, or the image default for images.
  let duration = kind === 'image' ? DEFAULT_IMAGE_DURATION : 5
  if (kind !== 'image') {
    const assetDuration = Number(asset.durationSeconds)
    if (Number.isFinite(assetDuration) && assetDuration > 0) {
      duration = assetDuration
    }
  }

  useVideoStore.getState().initTimeline()
  const wantsTrackType = kind === 'audio' ? 'audio' : 'video'
  const state = useVideoStore.getState()
  const candidates = (state.project.timeline?.tracks ?? [])
    .filter((t) => t.type === wantsTrackType && !t.locked)
    .sort((a, b) => a.position - b.position)
  let trackId = candidates[0]?.id
  if (!trackId) {
    trackId = useVideoStore.getState().addTrack(wantsTrackType)
  }

  const targetTrack = useVideoStore.getState().project.timeline?.tracks.find((t) => t.id === trackId)
  const endOfTrack = (targetTrack?.clips ?? []).reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0)

  const clipId = useVideoStore.getState().addClip(trackId, {
    // Clip sourceType matches the media kind so the Pixi compositor routes
    // to renderVideoClip / renderImageClip / (no-op for audio) correctly.
    sourceType: kind,
    sourceId: asset.publicUrl,
    label: asset.name || 'Untitled clip',
    startTime: endOfTrack,
    duration,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
  })
  return { ok: true, clipId }
}

/**
 * Single-file convenience wrapper. Used by callers that don't have a batch
 * (e.g., the media library's "Add to timeline" button on one asset).
 */
export async function importFileToTimeline(file: File): Promise<ImportResult> {
  const pre = await preflightAndUpload(file)
  if (!pre.ok) return pre
  return placeAssetOnTimeline(pre.asset, pre.kind)
}
