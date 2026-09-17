export interface ResearchProviderDef {
  id: string
  name: string
  category: 'web-search' | 'url-fetch' | 'stock-video' | 'stock-image' | 'archival'
  requiresKey: string | null
  defaultEnabled: boolean
}

export const RESEARCH_PROVIDERS: ResearchProviderDef[] = [
  // General web search: Tavily-backed, model-agnostic — gives ANY agent model
  // (Kimi/DeepSeek/budget) web research, not just providers with native search.
  // Native provider-side search (Anthropic/OpenAI/Gemini/Qwen) is preferred when
  // available; Tavily is the universal fallback for everyone else.
  {
    id: 'tavily',
    name: 'Tavily Web Search',
    category: 'web-search',
    requiresKey: 'TAVILY_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'url-fetch',
    name: 'URL Reader',
    category: 'url-fetch',
    requiresKey: null,
    defaultEnabled: true,
  },
  {
    id: 'pexels-video',
    name: 'Pexels Video',
    category: 'stock-video',
    requiresKey: 'PEXELS_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'pixabay-video',
    name: 'Pixabay Video',
    category: 'stock-video',
    requiresKey: 'PIXABAY_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'unsplash',
    name: 'Unsplash',
    category: 'stock-image',
    requiresKey: 'UNSPLASH_ACCESS_KEY',
    defaultEnabled: true,
  },
  {
    id: 'archive-org',
    name: 'Internet Archive',
    category: 'archival',
    requiresKey: null,
    defaultEnabled: true,
  },
  {
    id: 'nasa',
    name: 'NASA Image & Video Library',
    category: 'archival',
    requiresKey: null,
    defaultEnabled: true,
  },
  {
    id: 'wikimedia',
    name: 'Wikimedia Commons',
    category: 'archival',
    requiresKey: null,
    defaultEnabled: true,
  },
]

/** Check if a research provider is configured (API key set or no key needed). */
export function isResearchProviderReady(p: ResearchProviderDef): boolean {
  if (p.requiresKey) return !!process.env[p.requiresKey]
  return true
}

export const DEFAULT_RESEARCH_PROVIDER_ENABLED: Record<string, boolean> = Object.fromEntries(
  RESEARCH_PROVIDERS.map((p) => [p.id, p.defaultEnabled && isResearchProviderReady(p)]),
)

/** Unique API keys needed for research providers */
export const RESEARCH_API_KEYS: { provider: string; label: string; envVar: string }[] = [
  { provider: 'pexels', label: 'Pexels (Video + Images)', envVar: 'PEXELS_API_KEY' },
  { provider: 'pixabay', label: 'Pixabay (Video + Images + SFX)', envVar: 'PIXABAY_API_KEY' },
  { provider: 'unsplash', label: 'Unsplash Images', envVar: 'UNSPLASH_ACCESS_KEY' },
]
