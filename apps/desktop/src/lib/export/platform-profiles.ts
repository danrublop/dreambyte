// ── Platform export profiles ────────────────────────────────────────────────
//
// Destination-specific recipes for aspect ratio, resolution, fps, codec,
// bitrate, and duration. Lets the user pick "TikTok" or "YouTube Landscape"
// in the Export modal and get sensible defaults without hand-tuning every
// setting. These are advisory; none of them block export — the user can
// still override anything.

import type { AspectRatio, ExportResolution } from '../dimensions'
import type { ExportFPS, PlatformProfileId } from '../types/project'

export type { PlatformProfileId } from '../types/project'

export interface PlatformProfile {
  id: PlatformProfileId
  label: string
  description: string
  aspectRatio: AspectRatio | null
  resolution: ExportResolution
  fps: ExportFPS
  /** H.264 suggested video bitrate (kbps). Informational — the render pipeline
   *  may or may not read this today; keeping it here so the metadata is in one
   *  place when bitrate control is wired up. */
  videoBitrateKbps: number
  /** AAC audio bitrate (kbps). Informational for the same reason. */
  audioBitrateKbps: number
  /** Max total duration in seconds. null = unlimited / no platform cap. */
  maxDurationSeconds: number | null
  /** Short note shown under the profile name in the picker. */
  note?: string
}

/** Custom = user picks everything manually. Always first in the list. */
const CUSTOM: PlatformProfile = {
  id: 'custom',
  label: 'Custom',
  description: 'Pick resolution, fps, and aspect manually.',
  aspectRatio: null,
  resolution: '1080p',
  fps: 30,
  videoBitrateKbps: 10_000,
  audioBitrateKbps: 192,
  maxDurationSeconds: null,
}

export const PLATFORM_PROFILES: PlatformProfile[] = [
  CUSTOM,
  {
    id: 'youtube-landscape',
    label: 'YouTube (Landscape)',
    description: 'Standard landscape YouTube upload.',
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 30,
    videoBitrateKbps: 10_000,
    audioBitrateKbps: 192,
    maxDurationSeconds: null,
    note: '1920×1080 · 30 fps · H.264',
  },
  {
    id: 'youtube-shorts',
    label: 'YouTube Shorts',
    description: 'Vertical short-form for YouTube.',
    aspectRatio: '9:16',
    resolution: '1080p',
    fps: 30,
    videoBitrateKbps: 8_000,
    audioBitrateKbps: 192,
    maxDurationSeconds: 60,
    note: '1080×1920 · ≤60s',
  },
  {
    id: 'instagram-reel',
    label: 'Instagram Reel',
    description: 'Vertical reel for Instagram.',
    aspectRatio: '9:16',
    resolution: '1080p',
    fps: 30,
    videoBitrateKbps: 8_000,
    audioBitrateKbps: 192,
    maxDurationSeconds: 90,
    note: '1080×1920 · ≤90s',
  },
  {
    id: 'instagram-feed',
    label: 'Instagram Feed',
    description: 'Portrait post for the feed.',
    aspectRatio: '4:5',
    resolution: '1080p',
    fps: 30,
    videoBitrateKbps: 6_000,
    audioBitrateKbps: 192,
    maxDurationSeconds: 60,
    note: '1080×1350 · ≤60s',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    description: 'Vertical short-form for TikTok.',
    aspectRatio: '9:16',
    resolution: '1080p',
    fps: 30,
    videoBitrateKbps: 8_000,
    audioBitrateKbps: 192,
    maxDurationSeconds: 180,
    note: '1080×1920 · ≤3 min',
  },
  {
    id: 'linkedin-feed',
    label: 'LinkedIn Feed',
    description: 'Square feed video for LinkedIn.',
    aspectRatio: '1:1',
    resolution: '1080p',
    fps: 30,
    videoBitrateKbps: 5_000,
    audioBitrateKbps: 160,
    maxDurationSeconds: 600,
    note: '1080×1080 · ≤10 min',
  },
  {
    id: 'twitter-post',
    label: 'X / Twitter Post',
    description: 'Landscape post for X (Twitter).',
    aspectRatio: '16:9',
    resolution: '720p',
    fps: 30,
    videoBitrateKbps: 5_000,
    audioBitrateKbps: 160,
    maxDurationSeconds: 140,
    note: '1280×720 · ≤2m 20s',
  },
  {
    id: 'cinematic-21-9',
    label: 'Cinematic 24fps',
    description:
      'Cinematic-feel 16:9 landscape at 24 fps. Letterbox bars are not auto-added — set scene bg to match if you want them baked in.',
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 24,
    videoBitrateKbps: 12_000,
    audioBitrateKbps: 256,
    maxDurationSeconds: null,
    note: '1920×1080 · 24 fps',
  },
]

export function getPlatformProfile(id: PlatformProfileId | null | undefined): PlatformProfile {
  const match = PLATFORM_PROFILES.find((p) => p.id === id)
  return match ?? CUSTOM
}

export interface PlatformCompatibilityReport {
  aspectMatch: boolean
  expectedAspect: AspectRatio | null
  actualAspect: AspectRatio
  durationExceeds: boolean
  maxDurationSeconds: number | null
  totalDurationSeconds: number
}

/** Advisory check: compare the project's aspect/duration against the chosen
 *  platform profile. Returns the raw comparison — the UI decides whether to
 *  warn, block, or fix automatically. */
export function checkPlatformCompatibility(
  profile: PlatformProfile,
  projectAspect: AspectRatio,
  totalDurationSeconds: number,
): PlatformCompatibilityReport {
  const aspectMatch = profile.aspectRatio === null || profile.aspectRatio === projectAspect
  const durationExceeds = profile.maxDurationSeconds !== null && totalDurationSeconds > profile.maxDurationSeconds
  return {
    aspectMatch,
    expectedAspect: profile.aspectRatio,
    actualAspect: projectAspect,
    durationExceeds,
    maxDurationSeconds: profile.maxDurationSeconds,
    totalDurationSeconds,
  }
}
