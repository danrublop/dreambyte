/**
 * Server-side request/response coordination for agent-driven MP4 exports.
 *
 * The agent runs server-side but the Pixi/WebCodecs render only runs in the
 * renderer. When the model calls `export_mp4`, the runner emits an
 * `export_request` SSE event, then awaits a POST from the client with the
 * written file path. This module is the rendezvous point — the export
 * sibling of pending-captures.ts.
 *
 * Stored on globalThis so hot-reload and Next.js route bundling don't
 * produce multiple competing maps.
 */

import crypto from 'crypto'

export interface ExportResponse {
  outputPath: string
}

interface PendingEntry {
  resolve: (value: ExportResponse) => void
  reject: (reason: Error) => void
  timeoutHandle: NodeJS.Timeout
}

const GLOBAL_KEY = '__dreambytePendingExports__' as const
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

export interface PendingExport {
  exportId: string
  promise: Promise<ExportResponse>
}

/**
 * Create a pending export slot. Resolves when the client POSTs the written
 * file path back. Default timeout is generous (10 min) because a multi-scene
 * 1080p render can take minutes — much longer than a frame capture.
 */
export function createPendingExport(timeoutMs = 600000): PendingExport {
  const exportId = crypto.randomUUID()
  const map = getMap()

  const promise = new Promise<ExportResponse>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      map.delete(exportId)
      reject(new Error(`export timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    map.set(exportId, { resolve, reject, timeoutHandle })
  })

  return { exportId, promise }
}

export function resolvePendingExport(exportId: string, outputPath: string): boolean {
  const map = getMap()
  const entry = map.get(exportId)
  if (!entry) return false
  clearTimeout(entry.timeoutHandle)
  map.delete(exportId)
  entry.resolve({ outputPath })
  return true
}

export function rejectPendingExport(
  exportId: string,
  reason: string,
  // 11b — failing-scene context (1-based) attached to the rejection Error so
  // the runner's job catch can persist errorSceneIndex/errorSceneId. Same
  // field names the MCP runner (src/electron/main.ts) re-attaches; errorJobPatch
  // reads them on both paths.
  sceneContext?: { sceneIndex?: number; sceneId?: string },
): boolean {
  const map = getMap()
  const entry = map.get(exportId)
  if (!entry) return false
  clearTimeout(entry.timeoutHandle)
  map.delete(exportId)
  const err = new Error(reason) as Error & { sceneIndex?: number; sceneId?: string }
  if (sceneContext?.sceneIndex != null) err.sceneIndex = sceneContext.sceneIndex
  if (sceneContext?.sceneId) err.sceneId = sceneContext.sceneId
  entry.reject(err)
  return true
}
