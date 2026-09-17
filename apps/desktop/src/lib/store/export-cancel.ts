/**
 * Pure helpers for cancelling the in-app WebCodecs export.
 *
 * The real per-frame encode runs in the Electron main process behind a single
 * IPC call, so the renderer's cancellable seam is the per-scene loop + the
 * finalize/mux boundary. exportVideo checks `shouldCancel` at each boundary and,
 * when set, swaps the progress slot for `cancelledProgress(...)`. These are kept
 * pure so the cancel state-machine can be unit-tested without an Electron shell.
 *
 * Hard rule (failure mode in the plan): a cancelled export NEVER reports success
 * and never presents a partial MP4 as a result — `cancelledProgress` carries no
 * `filePath` and the caller sets lastExportStatus to 'cancelled', not 'success'.
 */

import type { ExportProgress } from '../types'

/** Whether a cancel was requested for the in-flight export. */
export function shouldCancel(cancelRequested: boolean, isExporting: boolean): boolean {
  return cancelRequested && isExporting
}

/**
 * Cancellable ONLY while 'rendering'. Once the finalize/mux phases start
 * ('stitching' is the renderer's "writing/concat" slot, 'mixing_audio' the
 * audio mux) a torn/partial MP4 could result, so those — and all terminal
 * phases — return false and the Cancel button is hidden or disabled.
 */
export function isCancellable(phase: ExportProgress['phase'] | undefined | null): boolean {
  if (!phase) return false
  return phase === 'rendering'
}

/**
 * Build the progress slot for a cancelled export. Preserves scene counters for
 * display but clears any filePath/downloadUrl so nothing partial is presented as
 * a result.
 */
export function cancelledProgress(prev: ExportProgress | null, totalScenes: number): ExportProgress {
  return {
    phase: 'cancelled',
    currentScene: prev?.currentScene ?? 0,
    totalScenes: prev?.totalScenes ?? totalScenes,
    sceneProgress: prev?.sceneProgress ?? 0,
    downloadUrl: null,
    filePath: null,
    error: null,
    diagnostics: prev?.diagnostics,
  }
}
