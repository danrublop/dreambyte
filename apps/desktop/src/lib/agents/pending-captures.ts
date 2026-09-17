/**
 * Server-side request/response coordination for agent frame captures.
 *
 * The agent runs server-side but the rendered pixels only exist in the
 * browser. When the model calls `capture_frame`, the server emits a
 * `capture_request` SSE event, then awaits a POST from the client with
 * the rendered image. This module is the rendezvous point.
 *
 * Stored on globalThis so hot-reload and Next.js route bundling don't
 * produce multiple competing maps.
 */

import crypto from 'crypto'

export interface CaptureResponse {
  dataUri: string
  mimeType: string
}

interface PendingEntry {
  resolve: (value: CaptureResponse) => void
  reject: (reason: Error) => void
  timeoutHandle: NodeJS.Timeout
}

const GLOBAL_KEY = '__dreambytePendingCaptures__' as const
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

export interface PendingCapture {
  captureId: string
  promise: Promise<CaptureResponse>
}

/** Create a pending capture slot. Resolves when the client POSTs the image back. */
export function createPendingCapture(timeoutMs = 8000): PendingCapture {
  const captureId = crypto.randomUUID()
  const map = getMap()

  const promise = new Promise<CaptureResponse>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      map.delete(captureId)
      reject(new Error(`capture timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    map.set(captureId, { resolve, reject, timeoutHandle })
  })

  return { captureId, promise }
}

export function resolvePendingCapture(captureId: string, dataUri: string, mimeType = 'image/jpeg'): boolean {
  const map = getMap()
  const entry = map.get(captureId)
  if (!entry) return false
  clearTimeout(entry.timeoutHandle)
  map.delete(captureId)
  entry.resolve({ dataUri, mimeType })
  return true
}

export function rejectPendingCapture(captureId: string, reason: string): boolean {
  const map = getMap()
  const entry = map.get(captureId)
  if (!entry) return false
  clearTimeout(entry.timeoutHandle)
  map.delete(captureId)
  entry.reject(new Error(reason))
  return true
}

/** Minimal emit signature for asking the client to render a frame. The runner's
 *  full SSE emit (which accepts the whole event union) is assignable to this. */
export type CaptureRequestEmit = (event: {
  type: 'capture_request'
  captureId: string
  sceneId: string
  captureTime: number
}) => void

/**
 * Full capture round-trip: open a pending slot, ask the client (via `emit`) to
 * render `sceneId` at `time`, and await the posted image. Returns null on
 * timeout/failure (the slot is rejected). Does NOT run any post-capture quality
 * check — the `capture_frame` runner branch layers that on; keeping it out of this
 * helper lets a future bulk caller reuse the round-trip without N extra vision calls.
 */
export async function captureOneFrame(
  sceneId: string,
  time: number,
  emit: CaptureRequestEmit,
  timeoutMs = 8000,
  signal?: AbortSignal,
): Promise<CaptureResponse | null> {
  // Abort plumbing: a stopped run must not open a capture round-trip (the
  // renderer would render a frame nobody consumes), and an in-flight one
  // resolves immediately on abort instead of waiting out the timeout.
  if (signal?.aborted) return null
  const pending = createPendingCapture(timeoutMs)
  const onAbort = () => rejectPendingCapture(pending.captureId, 'run aborted')
  signal?.addEventListener('abort', onAbort, { once: true })
  emit({ type: 'capture_request', captureId: pending.captureId, sceneId, captureTime: time })
  try {
    return await pending.promise
  } catch {
    rejectPendingCapture(pending.captureId, 'superseded')
    return null
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
