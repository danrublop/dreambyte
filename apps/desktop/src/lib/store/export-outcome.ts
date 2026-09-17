import type { ExportProgress } from '../types'

/**
 * exportVideo() fails loud: when the render fails it records
 * `phase: 'error'` on the shared exportProgress slot — so the UI export modal
 * can still render its error state from the store — AND it THROWS, so a
 * resolved promise unambiguously means success. Callers that fire-and-forget
 * (ExportPanel) must therefore `.catch(...)` the rejection; headless callers
 * (the runner in src/electron/main.ts, the export_request handler in
 * AgentChat.tsx) catch it and report a failure.
 *
 * This guard is the defense-in-depth counterpart: it throws unless the export
 * reached the terminal 'complete' phase, so an interrupted run left at
 * 'rendering' / 'stitching' (no throw, but no finished file either) is also
 * treated as a failure rather than a written output.
 */
export function assertExportSucceeded(progress: ExportProgress | null | undefined): void {
  if (!progress || progress.phase !== 'complete') {
    throw new Error(progress?.error || 'export failed')
  }
}
