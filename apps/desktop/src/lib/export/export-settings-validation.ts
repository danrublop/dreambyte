import { EXPORT_FPS, type ExportFPS, type ExportResolution } from '../types/project'

/**
 * Sanitize resolution + fps coming from an agent tool call before they reach
 * the renderer / WebCodecs encoder. Both the MCP path (src/electron/main.ts, where
 * the values get interpolated into an executeJavaScript string) and the in-app
 * path (src/components/AgentChat.tsx) run external-agent input through this, so a
 * crafted or out-of-range value can't reach the encoder or inject code.
 *
 * Always returns a clean resolution from the allowlist and a finite integer fps.
 */
export type ValidatedExportSettings = { resolution: ExportResolution; fps: number }

const ALLOWED_RESOLUTIONS: readonly ExportResolution[] = ['720p', '1080p', '4k']

export function validateExportSettings(input: { resolution?: unknown; fps?: unknown }): ValidatedExportSettings {
  const reqRes = typeof input.resolution === 'string' ? input.resolution : ''
  const resolution = (ALLOWED_RESOLUTIONS as readonly string[]).includes(reqRes)
    ? (reqRes as ExportResolution)
    : '1080p'

  // Round, then bound to [1, 60]. Floor at 1: a fractional fps like 0.1 passes
  // rawFps > 0 but rounds to 0, which would drive the encoder into a zero-frame
  // path. Cap at 60 (the ExportFPS type + tool-schema max): higher rates like
  // 4k@240 are a WebCodecs resource bomb and aren't a supported export rate.
  const rawFps = Number(input.fps ?? 30)
  const fps = Number.isFinite(rawFps) && rawFps > 0 ? Math.max(1, Math.min(60, Math.round(rawFps))) : 30

  return { resolution, fps }
}

const ALLOWED_FPS: readonly ExportFPS[] = EXPORT_FPS

/**
 * Like validateExportSettings, but additionally snaps fps to the nearest
 * supported ExportFPS step. For use inside exportVideo itself, where the
 * downstream encoder configs are typed against the ExportFPS union — the
 * agent entry paths validate before calling, but exportVideo shouldn't
 * trust its caller (a direct call with a hand-built settings object would
 * otherwise reach the WebCodecs encoder unchecked).
 */
export function normalizeExportSettings(input: {
  resolution?: unknown
  fps?: unknown
}): { resolution: ExportResolution; fps: ExportFPS } {
  const { resolution, fps } = validateExportSettings(input)
  const snapped = ALLOWED_FPS.reduce((best, v) => (Math.abs(v - fps) < Math.abs(best - fps) ? v : best))
  return { resolution, fps: snapped }
}
