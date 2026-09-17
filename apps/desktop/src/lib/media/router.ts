/**
 * Media provider router.
 *
 * Picks the best configured + enabled provider for a given media intent
 * (text-to-image, image-to-image, sticker, video, avatar). Mirrors the shape
 * of src/lib/audio/router.ts + resolve-best-tts-provider.ts so the agent framework
 * has a uniform mental model across modalities.
 *
 * Contract (feedback_provider_visibility.md):
 *  - Only surface providers whose API keys are present AND that are enabled in
 *    the user's store settings. No silent fallbacks to a disabled provider.
 *  - If no provider is available for an intent, return null + a reason so the
 *    caller can explain the gap to the user / agent instead of erroring vaguely.
 */

import type { MediaIntent } from '@/lib/types'
import { MEDIA_PROVIDERS, isMediaProviderReady } from './provider-registry'
import { catalogCostCents, catalogI2iCostCents } from './model-catalog'

export interface MediaRouterContext {
  /** Map of providerId → enabled (from useVideoStore().mediaGenEnabled). Server-side callers should pass null to trust only key presence. */
  enabledMap: Record<string, boolean> | null
  intent: MediaIntent
  /** Optional: prefer a specific catalog model id (any modality, not just image). */
  preferModel?: string | null
  /** Optional: i2i reference image URL — required for 'i2i' intent. */
  referenceImageUrl?: string | null
}

export interface RouteDecision {
  providerId: string
  /** Canonical model id passed to the underlying API (e.g. 'flux-schnell'). May equal providerId. */
  modelId: string
  /**
   * Estimated per-call cost in USD cents from the catalog row, or `null` when the model's
   * price is unknown. Callers must render unknown as "price unknown" / force always_ask —
   * never as 0/free (the silent-overspend class). 0 is a real free model, distinct from null.
   */
  estimatedCostCents: number | null
  /** Humane reason string, surfaced to the user / agent. */
  reason: string
}

export interface RouteFailure {
  providerId: null
  modelId: null
  estimatedCostCents: null
  reason: string
  /** Which provider IDs would work if the user enabled them or set the API key. */
  wouldWorkWith: string[]
}

export type RouteResult = RouteDecision | RouteFailure

// Preferred order per intent. First match that's both ready AND enabled wins.
// Cost is NOT stored here — it's read from the model catalog (single source of truth)
// via catalogCostCents() so price lives in exactly one place.
const PREFERENCE: Record<MediaIntent, { providerId: string; modelId: string }[]> = {
  // NOTE: image intents (t2i/i2i/sticker) must only list models that generateImage() can actually
  // execute — i.e. a FAL-hosted model (any providerId whose catalog row carries falEndpoints: the
  // 'imageGen' family + the frontier seedream/gptImage/nanoBanana cards) or 'dall-e' (OpenAI native).
  // generateImage routes by MODEL ID via falT2iEndpoint, so the providerId is free — but the row MUST
  // have a t2i endpoint or the call 404s. Google Imagen ('imagen-3' / googleImageGen) is NOT listed:
  // generateImage has no Google path + the catalog has no falEndpoints for imagen-3, so routing to it
  // crashed when FAL was off + Google on. Re-add imagen-3 only once a Google image path exists. The
  // RUNNABLE_IMAGE_PROVIDERS guard test below fails if a non-runnable model creeps back in.
  t2i: [
    { providerId: 'imageGen', modelId: 'flux-1.1-pro' },
    { providerId: 'dall-e', modelId: 'dall-e-3' },
    { providerId: 'imageGen', modelId: 'flux-schnell' }, // cheapest fallback
    // Frontier breadth — fal-hosted, runnable via generateImage's FAL path (falEndpoints). Appended so
    // the default pick (flux-1.1-pro) is unchanged; they surface in the Generate dropdown + are
    // selectable by id. RUNNABLE_IMAGE_PROVIDERS in the catalog test includes these providerIds.
    { providerId: 'seedream', modelId: 'seedream-4' },
    { providerId: 'gptImage', modelId: 'gpt-image-1' },
    { providerId: 'nanoBanana', modelId: 'nano-banana' },
    // Phase 2 frontier bumps — listed so preferModel:'seedream-4.5'/'nano-banana-pro' resolves to
    // the right (priced) row instead of silently falling through to the older/cheaper sibling.
    { providerId: 'seedream', modelId: 'seedream-4.5' },
    { providerId: 'nanoBanana', modelId: 'nano-banana-pro' },
  ],
  // Both have real catalog i2i endpoints (falI2iEndpoint) + capabilities.i2i:true. sd3 is listed so a
  // user who picked it isn't silently swapped to (pricier) flux-1.1-pro by preferModel. The frontier
  // fal models each carry a real i2i (edit) endpoint, so they're honest i2i candidates too.
  i2i: [
    { providerId: 'imageGen', modelId: 'flux-1.1-pro' },
    { providerId: 'imageGen', modelId: 'stable-diffusion-3' },
    { providerId: 'seedream', modelId: 'seedream-4' },
    { providerId: 'gptImage', modelId: 'gpt-image-1' },
    { providerId: 'nanoBanana', modelId: 'nano-banana' },
    { providerId: 'seedream', modelId: 'seedream-4.5' },
    { providerId: 'nanoBanana', modelId: 'nano-banana-pro' },
  ],
  sticker: [
    { providerId: 'imageGen', modelId: 'recraft-v3' },
    { providerId: 'imageGen', modelId: 'flux-schnell' },
  ],
  video: [{ providerId: 'veo3', modelId: 'veo-3' }],
  avatar: [
    { providerId: 'heygen', modelId: 'heygen-v2' },
    { providerId: 'musetalk', modelId: 'musetalk' },
  ],
}

/**
 * Every model id the router can route to, across all intents. Exported so a test can
 * assert each one resolves to a catalog row — if a PREFERENCE id drifts away from the
 * catalog, cost silently falls back to 0 (free) in the permission dialog, which is the
 * model_pricing_drift silent-overspend class. The guard test fails fast on that drift.
 */
export const ROUTER_MODEL_IDS: string[] = [
  ...new Set(Object.values(PREFERENCE).flatMap((cands) => cands.map((c) => c.modelId))),
]

export function routeMediaIntent(ctx: MediaRouterContext): RouteResult {
  const pref = PREFERENCE[ctx.intent]
  if (!pref) {
    return {
      providerId: null,
      modelId: null,
      estimatedCostCents: null,
      reason: `No providers registered for intent "${ctx.intent}"`,
      wouldWorkWith: [],
    }
  }

  if (ctx.intent === 'i2i' && !ctx.referenceImageUrl) {
    return {
      providerId: null,
      modelId: null,
      estimatedCostCents: null,
      reason: 'Image-to-image requires a reference image URL',
      wouldWorkWith: [],
    }
  }

  // If the caller forces a specific model, try it first (and only it).
  const ordered = ctx.preferModel
    ? [...pref.filter((p) => p.modelId === ctx.preferModel), ...pref.filter((p) => p.modelId !== ctx.preferModel)]
    : pref

  const wouldWorkWith: string[] = []
  for (const cand of ordered) {
    const def = MEDIA_PROVIDERS.find((p) => p.id === cand.providerId)
    if (!def) continue
    const ready = isMediaProviderReady(def)
    const enabled = ctx.enabledMap == null ? true : (ctx.enabledMap[cand.providerId] ?? def.defaultEnabled)

    if (!ready) {
      wouldWorkWith.push(`${def.name} (set ${def.requiresKey})`)
      continue
    }
    if (!enabled) {
      wouldWorkWith.push(`${def.name} (disabled in Settings)`)
      continue
    }

    return {
      providerId: cand.providerId,
      modelId: cand.modelId,
      // Cost from the catalog row — null when price is unknown (NOT coerced to 0/free).
      // The cost-cap layer forces always_ask on null. Callers render null as unknown.
      // For i2i, quote the i2i endpoint price so the estimate matches what generateImage bills
      // (flux-1.1-pro i2i is 3c, not the 5c t2i price).
      estimatedCostCents: ctx.intent === 'i2i' ? catalogI2iCostCents(cand.modelId) : catalogCostCents(cand.modelId),
      reason: `Routed ${ctx.intent} → ${def.name} / ${cand.modelId}`,
    }
  }

  return {
    providerId: null,
    modelId: null,
    estimatedCostCents: null,
    reason: `No enabled + configured provider for ${ctx.intent}`,
    wouldWorkWith,
  }
}

/** Helper: list every provider that *could* handle an intent, for the Generate UI dropdown. */
export function listCandidatesForIntent(
  intent: MediaIntent,
): { providerId: string; modelId: string; name: string; cents: number | null; ready: boolean }[] {
  const pref = PREFERENCE[intent] ?? []
  return pref.map((p) => {
    const def = MEDIA_PROVIDERS.find((d) => d.id === p.providerId)
    return {
      providerId: p.providerId,
      modelId: p.modelId,
      name: def?.name ?? p.providerId,
      // null = unknown price (render "price unknown"), never 0/free. i2i quotes the i2i
      // endpoint price so the UI estimate matches what generateImage bills.
      cents: intent === 'i2i' ? catalogI2iCostCents(p.modelId) : catalogCostCents(p.modelId),
      ready: def ? isMediaProviderReady(def) : false,
    }
  })
}
