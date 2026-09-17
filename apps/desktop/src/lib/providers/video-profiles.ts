// ── Video generation provider profiles ──────────────────────────────────────

import type { ProviderProfile, SelectionContext } from './selector'

const hasEnv = (ctx: SelectionContext, key: string): boolean => {
  const env = ctx.env ?? (typeof process !== 'undefined' ? process.env : {})
  return !!env?.[key]
}

export type VideoProviderId = 'veo3' | 'kling' | 'runway'

export const VIDEO_PROFILES: ProviderProfile<VideoProviderId>[] = [
  {
    id: 'veo3',
    category: 'video',
    name: 'Google Veo 3',
    quality: 92,
    reliability: 70, // Often waitlisted or rate-limited
    latency: 55,
    control: 75,
    available: (ctx) => hasEnv(ctx, 'GOOGLE_AI_KEY'),
    costUsd: () => 1.0,
    taskFit: (ctx) => (ctx.task === 'cinematic' || ctx.task === 'photoreal' ? 90 : 75),
    reasonHint: 'Veo 3 (top-tier cinematic quality)',
  },
  {
    id: 'kling',
    category: 'video',
    name: 'Kling 2.1',
    quality: 85,
    reliability: 80,
    latency: 60,
    control: 70,
    available: (ctx) => hasEnv(ctx, 'FAL_KEY'),
    costUsd: () => 0.45,
    taskFit: (ctx) => (ctx.task === 'character' || ctx.task === 'product' ? 85 : 75),
    reasonHint: 'Kling 2.1 (balanced quality + price)',
  },
  {
    id: 'runway',
    category: 'video',
    name: 'Runway Gen-4',
    quality: 88,
    reliability: 82,
    latency: 55,
    control: 82,
    available: (ctx) => hasEnv(ctx, 'RUNWAY_API_KEY'),
    costUsd: () => 0.9,
    taskFit: (ctx) => (ctx.task === 'cinematic' || ctx.task === 'dynamic' ? 88 : 78),
    reasonHint: 'Runway Gen-4 (strong camera + motion control)',
  },
]
