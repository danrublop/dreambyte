// ── Image generation provider profiles ──────────────────────────────────────
//
// Each image generator identified by model. Task fit captures what each
// model is strongest at (photoreal vs illustration vs typography).

import { API_COST_SCALARS } from '../permissions'
import type { ProviderProfile, SelectionContext } from './selector'

const hasEnv = (ctx: SelectionContext, key: string): boolean => {
  const env = ctx.env ?? (typeof process !== 'undefined' ? process.env : {})
  return !!env?.[key]
}

export type ImageProviderId =
  | 'flux-1.1-pro'
  | 'flux-schnell'
  | 'ideogram-v3'
  | 'recraft-v3'
  | 'stable-diffusion-3'
  | 'dall-e-3'
  | 'google-imagen'

export const IMAGE_PROFILES: ProviderProfile<ImageProviderId>[] = [
  {
    id: 'flux-1.1-pro',
    category: 'image',
    name: 'Flux 1.1 Pro',
    quality: 92,
    reliability: 88,
    latency: 55,
    control: 75,
    available: (ctx) => hasEnv(ctx, 'FAL_KEY'),
    costUsd: () => 0.05,
    taskFit: (ctx) => (ctx.task === 'photoreal' || ctx.task === 'illustration' ? 90 : 75),
    reasonHint: 'Flux 1.1 Pro (best all-rounder)',
  },
  {
    id: 'flux-schnell',
    category: 'image',
    name: 'Flux Schnell',
    quality: 72,
    reliability: 90,
    latency: 90,
    control: 60,
    available: (ctx) => hasEnv(ctx, 'FAL_KEY'),
    costUsd: () => 0.003,
    taskFit: (ctx) => (ctx.task === 'draft' ? 95 : 60),
    reasonHint: 'Flux Schnell (fast, cheap drafts)',
  },
  {
    id: 'ideogram-v3',
    category: 'image',
    name: 'Ideogram v3',
    quality: 88,
    reliability: 85,
    latency: 60,
    control: 80,
    available: (ctx) => hasEnv(ctx, 'FAL_KEY'),
    costUsd: () => 0.08,
    taskFit: (ctx) => (ctx.task === 'typography' || ctx.task === 'poster' ? 95 : 70),
    reasonHint: 'Ideogram v3 (best typography + posters)',
  },
  {
    id: 'recraft-v3',
    category: 'image',
    name: 'Recraft v3',
    quality: 82,
    reliability: 85,
    latency: 65,
    control: 82,
    available: (ctx) => hasEnv(ctx, 'FAL_KEY'),
    costUsd: () => 0.04,
    taskFit: (ctx) => (ctx.task === 'illustration' || ctx.task === 'brand' ? 92 : 70),
    reasonHint: 'Recraft v3 (brand/illustration style control)',
  },
  {
    id: 'stable-diffusion-3',
    category: 'image',
    name: 'Stable Diffusion 3',
    quality: 75,
    reliability: 80,
    latency: 65,
    control: 65,
    available: (ctx) => hasEnv(ctx, 'FAL_KEY'),
    costUsd: () => 0.03,
    taskFit: () => 65,
    reasonHint: 'Stable Diffusion 3',
  },
  {
    // DALL-E 3 was retired from the OpenAI API; this `dall-e-3` id now routes to its
    // successor gpt-image-1 (OpenAI-direct) — the id stays stable to avoid churning every caller.
    id: 'dall-e-3',
    category: 'image',
    name: 'OpenAI gpt-image-1',
    quality: 88,
    reliability: 90,
    latency: 50,
    control: 78,
    available: (ctx) => hasEnv(ctx, 'OPENAI_API_KEY'),
    costUsd: () => 0.17, // gpt-image-1 quality 'high' ~$0.17 / 1024² (was DALL-E 3 ~$0.04)
    taskFit: (ctx) => (ctx.task === 'photoreal' || ctx.task === 'typography' ? 88 : 78),
    reasonHint: 'OpenAI gpt-image-1 (photoreal + text)',
  },
  {
    id: 'google-imagen',
    category: 'image',
    name: 'Google Imagen',
    quality: 85,
    reliability: 90,
    latency: 60,
    control: 70,
    available: (ctx) => hasEnv(ctx, 'GOOGLE_AI_KEY'),
    costUsd: () => API_COST_SCALARS.googleImageGen?.perCall ?? 0.03,
    taskFit: (ctx) => (ctx.task === 'photoreal' ? 85 : 75),
    reasonHint: 'Google Imagen',
  },
]
