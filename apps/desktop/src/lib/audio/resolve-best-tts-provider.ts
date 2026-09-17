import type { AudioSettings, TTSProvider } from '../types'
import { DEFAULT_WEIGHTS, LOCAL_MODE_WEIGHTS, selectBestProvider } from '../providers/selector'
import { TTS_PROFILES } from '../providers/tts-profiles'

/**
 * Pure resolution of which TTS provider to use — safe for client and server bundles.
 * (Do not import `audio/router.ts` from client code: it references Node-only providers.)
 *
 * Historically this was a hardcoded cascade. It now delegates to the generic
 * multi-dimension provider selector so we can tell the user *why* a provider
 * was chosen via `resolveTTSProviderWithReason` below. Pure function — safe
 * anywhere.
 */
export function getBestTTSProvider(settings?: AudioSettings | null, localMode?: boolean): TTSProvider {
  if (settings?.defaultTTSProvider && settings.defaultTTSProvider !== 'auto') {
    return settings.defaultTTSProvider
  }
  const env: Record<string, string | undefined> = { ...process.env }
  if (settings?.pocketTTSUrl) env.POCKET_TTS_URL = settings.pocketTTSUrl
  if (settings?.voxcpmUrl) env.VOXCPM_URL = settings.voxcpmUrl
  if (settings?.edgeTTSUrl) env.EDGE_TTS_URL = settings.edgeTTSUrl

  const weights = localMode ? LOCAL_MODE_WEIGHTS : DEFAULT_WEIGHTS
  const out = selectBestProvider(
    TTS_PROFILES,
    { localMode: !!localMode, env, platform: process.platform, task: 'narration' },
    weights,
  )
  return (out.chosen?.id as TTSProvider) ?? 'web-speech'
}

/** Like `getBestTTSProvider` but returns the winning provider plus the
 *  full ranking and the "why we picked this" reason string. Useful for
 *  surfacing choice justification in the UI and agent disclosure. */
export function resolveTTSProviderWithReason(
  settings?: AudioSettings | null,
  localMode?: boolean,
): { provider: TTSProvider; reason: string; ranking: Array<{ id: string; score: number; costUsd: number }> } {
  if (settings?.defaultTTSProvider && settings.defaultTTSProvider !== 'auto') {
    return {
      provider: settings.defaultTTSProvider,
      reason: `User-set default (${settings.defaultTTSProvider})`,
      ranking: [],
    }
  }
  const env: Record<string, string | undefined> = { ...process.env }
  if (settings?.pocketTTSUrl) env.POCKET_TTS_URL = settings.pocketTTSUrl
  if (settings?.voxcpmUrl) env.VOXCPM_URL = settings.voxcpmUrl
  if (settings?.edgeTTSUrl) env.EDGE_TTS_URL = settings.edgeTTSUrl

  const weights = localMode ? LOCAL_MODE_WEIGHTS : DEFAULT_WEIGHTS
  const out = selectBestProvider(
    TTS_PROFILES,
    { localMode: !!localMode, env, platform: process.platform, task: 'narration' },
    weights,
  )
  return {
    provider: (out.chosen?.id as TTSProvider) ?? 'web-speech',
    reason: out.chosen?.reason ?? 'web-speech (no configured provider)',
    ranking: out.ranking.map((r) => ({ id: r.id, score: r.score, costUsd: r.costUsd })),
  }
}

/** Full-world resolver for `add_narration`-style call sites. Takes every
 *  bit of context the cascade needs — per-project enabled
 *  map, localMode, text length, platform, explicit user-picked default —
 *  and returns the single best provider plus the ranked alternatives. */
export function resolveTTSForNarration(opts: {
  settings?: AudioSettings | null
  localMode?: boolean
  audioProviderEnabled?: Record<string, boolean>
  textLength?: number
  /** When true (MP4 export path), drop client-only providers. Default false
   *  — `add_narration` previews in the browser are fine with web-speech. */
  requiresServerOutput?: boolean
  lastProviderId?: string
}): {
  provider: TTSProvider | null
  reason: string
  ranking: Array<{ id: string; score: number; costUsd: number; reason: string }>
} {
  const { settings, localMode, audioProviderEnabled, textLength, requiresServerOutput, lastProviderId } = opts

  // Explicit user default short-circuits the scorer — respect user intent.
  if (settings?.defaultTTSProvider && settings.defaultTTSProvider !== 'auto') {
    const explicit = settings.defaultTTSProvider
    const disabled = audioProviderEnabled && audioProviderEnabled[explicit] === false
    if (!disabled) {
      return { provider: explicit, reason: `User-set default (${explicit})`, ranking: [] }
    }
  }

  const env: Record<string, string | undefined> = { ...process.env }
  if (settings?.pocketTTSUrl) env.POCKET_TTS_URL = settings.pocketTTSUrl
  if (settings?.voxcpmUrl) env.VOXCPM_URL = settings.voxcpmUrl
  if (settings?.edgeTTSUrl) env.EDGE_TTS_URL = settings.edgeTTSUrl

  const weights = localMode ? LOCAL_MODE_WEIGHTS : DEFAULT_WEIGHTS
  const out = selectBestProvider(
    TTS_PROFILES,
    {
      localMode: !!localMode,
      env,
      platform: process.platform,
      task: 'narration',
      textLength,
      enabled: audioProviderEnabled,
      requiresServerOutput,
      lastProviderId,
    },
    weights,
  )

  return {
    provider: (out.chosen?.id as TTSProvider) ?? null,
    reason: out.chosen?.reason ?? 'no provider available',
    ranking: out.ranking.map((r) => ({
      id: r.id,
      score: r.score,
      costUsd: r.costUsd,
      reason: r.reason,
    })),
  }
}
