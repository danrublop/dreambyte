export interface MediaProviderDef {
  id: string
  name: string
  category: 'video' | 'image' | 'avatar' | 'utility'
  requiresKey: string | null
  defaultEnabled: boolean
}

export const MEDIA_PROVIDERS: MediaProviderDef[] = [
  { id: 'veo3', name: 'Veo 3', category: 'video', requiresKey: 'GOOGLE_AI_KEY', defaultEnabled: true },
  { id: 'kling', name: 'Kling 2.1', category: 'video', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'runway', name: 'Runway Gen-4', category: 'video', requiresKey: 'RUNWAY_API_KEY', defaultEnabled: true },
  // fal-hosted video breadth (Phase 2) — all key on FAL_KEY. Slugs are best-guess + env-
  // overridable in src/lib/apis/video/fal-models.ts; verify against fal's catalog before relying.
  { id: 'ltx', name: 'LTX Video 2.3', category: 'video', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'wan', name: 'Wan Video', category: 'video', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'seedance', name: 'Seedance 1.0 Pro', category: 'video', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'hailuo', name: 'Hailuo 02', category: 'video', requiresKey: 'FAL_KEY', defaultEnabled: true },
  // Frontier video breadth — fal-hosted (FAL_KEY), slugs env-overridable + 404-loud (see
  // src/lib/apis/video/fal-models.ts). Veo 3.1 / Kling 2.5 Turbo are their own providers/cards so the
  // newest model shows as a distinct card alongside the prior Veo 3 / Kling 2.1.
  { id: 'veo31', name: 'Veo 3.1', category: 'video', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'kling25', name: 'Kling 2.5 Turbo', category: 'video', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'seedance2', name: 'Seedance 2.0 Pro', category: 'video', requiresKey: 'FAL_KEY', defaultEnabled: true },
  {
    id: 'googleImageGen',
    name: 'Google Imagen',
    category: 'image',
    requiresKey: 'GOOGLE_AI_KEY',
    defaultEnabled: true,
  },
  { id: 'imageGen', name: 'FAL Image Gen', category: 'image', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'dall-e', name: 'DALL·E 3', category: 'image', requiresKey: 'OPENAI_API_KEY', defaultEnabled: true },
  // Frontier image breadth — all fal-hosted (FAL_KEY) so they route through generateImage's FAL path
  // by model id (falEndpoints), gated under the shared 'imageGen' spend bucket like DALL-E. Distinct
  // cards per the "one card per model" choice. The card icon carries the brand, so names stay clean.
  // Slugs UNVERIFIED + 404-loud.
  { id: 'seedream', name: 'Seedream 4', category: 'image', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'gptImage', name: 'GPT Image', category: 'image', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'nanoBanana', name: 'Nano Banana', category: 'image', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'heygen', name: 'HeyGen Avatars', category: 'avatar', requiresKey: 'HEYGEN_API_KEY', defaultEnabled: true },
  { id: 'musetalk', name: 'MuseTalk', category: 'avatar', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'fabric', name: 'Fabric 1.0', category: 'avatar', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'aurora', name: 'Aurora', category: 'avatar', requiresKey: 'FAL_KEY', defaultEnabled: true },
  { id: 'backgroundRemoval', name: 'Background Removal', category: 'utility', requiresKey: null, defaultEnabled: true },
  { id: 'unsplash', name: 'Unsplash', category: 'utility', requiresKey: null, defaultEnabled: true },
]

/** Check if a media provider is configured (API key set) */
export function isMediaProviderReady(p: MediaProviderDef): boolean {
  if (p.requiresKey) return !!process.env[p.requiresKey]
  return true // no-key providers (bg-removal, unsplash) always available
}

// Only providers generateImage can actually RUN (FAL imageGen + OpenAI dall-e). Other
// 'image'-category entries (Imagen/seedream/…) have no generateImage path, so counting
// them would advertise image tools that only return "disabled" — mirrors the same guard
// in filterToolsForAgent (context-builder). Single source so the tool filter, the recipe,
// and the imagery floor all agree on "can we actually make an image".
const RUNNABLE_IMAGE_PROVIDER_IDS = new Set(['imageGen', 'dall-e'])

/** True if at least one image-generation provider is BOTH enabled (toggle) and configured (key). */
export function hasRunnableImageProvider(mediaGenEnabled?: Record<string, boolean>): boolean {
  const isEnabled = (id: string) => !mediaGenEnabled || (mediaGenEnabled[id] ?? true)
  return MEDIA_PROVIDERS.some(
    (p) =>
      p.category === 'image' && RUNNABLE_IMAGE_PROVIDER_IDS.has(p.id) && isEnabled(p.id) && isMediaProviderReady(p),
  )
}

export const DEFAULT_MEDIA_PROVIDER_ENABLED: Record<string, boolean> = Object.fromEntries(
  MEDIA_PROVIDERS.map((p) => [p.id, p.defaultEnabled && isMediaProviderReady(p)]),
)
