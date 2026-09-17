import { klingProvider } from './kling'
import { runwayProvider } from './runway'
import { veo3Provider } from './veo3'
import {
  ltxProvider,
  wanProvider,
  seedanceProvider,
  hailuoProvider,
  veo31Provider,
  kling25Provider,
  seedance2Provider,
} from './fal-models'
import type { VideoProviderClient } from './types'

export const VIDEO_PROVIDERS: Record<string, VideoProviderClient> = {
  veo3: veo3Provider,
  kling: klingProvider,
  runway: runwayProvider,
  ltx: ltxProvider,
  wan: wanProvider,
  seedance: seedanceProvider,
  hailuo: hailuoProvider,
  veo31: veo31Provider,
  kling25: kling25Provider,
  seedance2: seedance2Provider,
}

/** Default order used when no explicit provider is requested. FAL-first: the
 *  FAL_KEY models (kling/seedance/ltx/wan/hailuo/veo31) come before Veo 3
 *  (GOOGLE_AI_KEY) and Runway (RUNWAY_API_KEY), so `firstConfiguredVideoProvider`
 *  prefers FAL when its key is set — the current "media gen runs on FAL" default.
 *  The agent can still pass an explicit `provider` to override. */
export const VIDEO_PROVIDER_FALLBACK_ORDER = ['kling25', 'seedance2', 'kling', 'seedance', 'ltx', 'wan', 'hailuo', 'veo31', 'veo3', 'runway'] as const

export type VideoProviderId = keyof typeof VIDEO_PROVIDERS

export function getVideoProvider(id: string): VideoProviderClient | null {
  return VIDEO_PROVIDERS[id] ?? null
}

/** First provider whose env var is set. Returns null if none configured. */
export function firstConfiguredVideoProvider(): VideoProviderClient | null {
  for (const id of VIDEO_PROVIDER_FALLBACK_ORDER) {
    const p = VIDEO_PROVIDERS[id]
    if (p && process.env[p.envKey]) return p
  }
  return null
}
