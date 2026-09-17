// ── Project dimensions & aspect ratio utilities ─────────────────────────────

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:5'

export interface ProjectDimensions {
  width: number
  height: number
}

export type ExportResolution = '720p' | '1080p' | '4k'

const DIMENSION_TABLE: Record<AspectRatio, Record<ExportResolution, ProjectDimensions>> = {
  '16:9': {
    '720p':  { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '4k':    { width: 3840, height: 2160 },
  },
  '9:16': {
    '720p':  { width: 720,  height: 1280 },
    '1080p': { width: 1080, height: 1920 },
    '4k':    { width: 2160, height: 3840 },
  },
  '1:1': {
    '720p':  { width: 720,  height: 720 },
    '1080p': { width: 1080, height: 1080 },
    '4k':    { width: 2160, height: 2160 },
  },
  '4:5': {
    '720p':  { width: 720,  height: 900 },
    '1080p': { width: 1080, height: 1350 },
    '4k':    { width: 2160, height: 2700 },
  },
}

/**
 * Resolve concrete pixel dimensions from an aspect ratio + resolution pair.
 * Falls back to 1920×1080 (16:9 @ 1080p) for unknown inputs.
 */
export function resolveProjectDimensions(
  aspectRatio?: AspectRatio | null,
  resolution?: ExportResolution | null,
): ProjectDimensions {
  const ratio = aspectRatio ?? '16:9'
  const res = resolution ?? '1080p'
  return DIMENSION_TABLE[ratio]?.[res] ?? { width: 1920, height: 1080 }
}

/** All supported aspect ratios with display metadata. */
export const ASPECT_RATIO_OPTIONS: { value: AspectRatio; label: string; description: string }[] = [
  { value: '16:9', label: '16:9',  description: 'Landscape' },
  { value: '9:16', label: '9:16',  description: 'Vertical' },
  { value: '1:1',  label: '1:1',   description: 'Square' },
  { value: '4:5',  label: '4:5',   description: 'Portrait' },
]

/** Default dimensions (16:9 @ 1080p). */
export const DEFAULT_DIMENSIONS: ProjectDimensions = { width: 1920, height: 1080 }
