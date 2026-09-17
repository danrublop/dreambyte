/**
 * Server-side request/response coordination for agent-driven scene CLIP exports.
 *
 * The motion-review pass needs a rendered MP4 of ONE scene — video AND
 * its muxed audio track — but the Pixi/WebCodecs render only runs in the
 * renderer. When the runner reviews a scene's motion, it emits a `clip_request`
 * SSE event, then awaits a POST from the client carrying the encoded MP4 bytes.
 * This module is the rendezvous point — the per-scene-clip sibling of
 * pending-captures.ts (frames) and pending-exports.ts (whole-project path).
 *
 * Unlike pending-exports (which returns a written FILE PATH), this returns the
 * clip BYTES inline: the clip is small (low-res export, kept under Gemini's 18MB
 * inline cap) and motion-review sends it straight to the video model — no temp
 * file needed.
 *
 * Stored on globalThis so hot-reload and Next.js route bundling don't produce
 * multiple competing maps.
 */

import crypto from 'crypto'

export interface ClipResponse {
  bytes: Uint8Array
  mimeType: string
}

interface PendingEntry {
  resolve: (value: ClipResponse) => void
  reject: (reason: Error) => void
  timeoutHandle: NodeJS.Timeout
}

const GLOBAL_KEY = '__dreambytePendingClips__' as const
type PendingMap = Map<string, PendingEntry>

function getMap(): PendingMap {
  const g = globalThis as unknown as Record<string, unknown>
  let map = g[GLOBAL_KEY] as PendingMap | undefined
  if (!map) {
    map = new Map()
    g[GLOBAL_KEY] = map
  }
  return map
}

export interface PendingClip {
  clipId: string
  promise: Promise<ClipResponse>
}

/**
 * Create a pending clip slot. Resolves when the client POSTs the encoded MP4
 * back. Default timeout is generous (a single low-res scene render is a few
 * seconds, but a heavy scene or a busy renderer can take longer) yet far below
 * the whole-project export timeout.
 */
export function createPendingClip(timeoutMs = 60000): PendingClip {
  const clipId = crypto.randomUUID()
  const map = getMap()

  const promise = new Promise<ClipResponse>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      map.delete(clipId)
      reject(new Error(`clip timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    map.set(clipId, { resolve, reject, timeoutHandle })
  })

  return { clipId, promise }
}

export function resolvePendingClip(clipId: string, bytes: Uint8Array, mimeType = 'video/mp4'): boolean {
  const map = getMap()
  const entry = map.get(clipId)
  if (!entry) return false
  clearTimeout(entry.timeoutHandle)
  map.delete(clipId)
  entry.resolve({ bytes, mimeType })
  return true
}

export function rejectPendingClip(clipId: string, reason: string): boolean {
  const map = getMap()
  const entry = map.get(clipId)
  if (!entry) return false
  clearTimeout(entry.timeoutHandle)
  map.delete(clipId)
  entry.reject(new Error(reason))
  return true
}

/** Minimal emit signature for asking the client to render a scene clip. The
 *  runner's full SSE emit (which accepts the whole event union) is assignable. */
export type ClipRequestEmit = (event: {
  type: 'clip_request'
  clipId: string
  sceneId: string
  maxRes: number
  fps: number
}) => void

export interface CaptureSceneClipOpts {
  timeoutMs?: number
  /** Longest output dimension for the low-res review clip (default 720). */
  maxRes?: number
  /** Frame rate for the review clip (default 24 — Gemini downsamples anyway). */
  fps?: number
}

/**
 * Full clip round-trip: open a pending slot, ask the client (via `emit`) to
 * export `sceneId` to a low-res MP4, and await the posted bytes. Returns null on
 * timeout/failure (the slot is rejected). The caller (motion-review via the
 * runner) decides how to degrade — a null clip means the native path can't run,
 * so it falls back to sampled frames or reports `reviewable:false`.
 */
export async function captureSceneClip(
  sceneId: string,
  emit: ClipRequestEmit,
  opts: CaptureSceneClipOpts = {},
): Promise<ClipResponse | null> {
  const pending = createPendingClip(opts.timeoutMs)
  emit({
    type: 'clip_request',
    clipId: pending.clipId,
    sceneId,
    maxRes: opts.maxRes ?? 720,
    fps: opts.fps ?? 24,
  })
  try {
    return await pending.promise
  } catch {
    rejectPendingClip(pending.clipId, 'superseded')
    return null
  }
}
