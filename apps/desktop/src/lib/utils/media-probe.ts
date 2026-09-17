/**
 * Media metadata probing utilities.
 *
 * Used by the media library and timeline file-drop to learn a clip's duration
 * before it lands on a track. Implemented via hidden `<video>` /
 * `<audio>` elements so it works in the renderer without an Electron-specific
 * codec path; falls back to a default after a wall-clock timeout to avoid
 * hanging on a slow asset.
 */

const PROBE_TIMEOUT_MS = 3000

export interface ProbeResult {
  duration: number
  /** Pixel dimensions for video; undefined for audio. */
  width?: number
  height?: number
}

/**
 * Probe a media URL for its duration. Resolves with a positive duration or
 * rejects after PROBE_TIMEOUT_MS. The caller is expected to provide a
 * fallback duration on rejection.
 */
export function probeMediaDuration(url: string, kind: 'video' | 'audio'): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const el = kind === 'audio' ? document.createElement('audio') : document.createElement('video')
    el.preload = 'metadata'
    if (el instanceof HTMLVideoElement) {
      el.muted = true
      el.playsInline = true
    }
    let settled = false
    const cleanup = () => {
      // Clear handlers first so the synthetic events that `load()` queues
      // (jsdom + some browsers fire loadstart/error/abort after src clear)
      // can't re-enter probe logic and leak unhandled rejections.
      el.onloadedmetadata = null
      el.onerror = null
      el.removeAttribute('src')
      el.load()
    }
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('probe timeout'))
    }, PROBE_TIMEOUT_MS)
    el.onloadedmetadata = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      const d = isFinite(el.duration) && el.duration > 0 ? el.duration : 0
      const w = el instanceof HTMLVideoElement && el.videoWidth > 0 ? el.videoWidth : undefined
      const h = el instanceof HTMLVideoElement && el.videoHeight > 0 ? el.videoHeight : undefined
      cleanup()
      if (d > 0) resolve({ duration: d, width: w, height: h })
      else reject(new Error('no duration'))
    }
    el.onerror = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      cleanup()
      reject(new Error('load error'))
    }
    el.src = url
  })
}

/**
 * Classify a file's MIME type into a track kind. Returns null if the file
 * type isn't supported by the timeline today.
 */
export function classifyMediaFile(file: File): 'video' | 'audio' | 'image' | null {
  const t = file.type
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  if (t.startsWith('image/')) return 'image'
  return null
}
