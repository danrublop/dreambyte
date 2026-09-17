export interface FetchedURLImage {
  url: string
  alt?: string
  width?: number
  height?: number
}

export interface FetchedURLVideo {
  /** Direct MP4/WebM URL or platform watch URL (YouTube, Vimeo, etc) */
  url: string
  /** 'direct' = inline video tag; 'youtube'/'vimeo'/'twitter'/'iframe' = embed */
  kind: 'direct' | 'youtube' | 'vimeo' | 'twitter' | 'iframe'
  /** For embeds, the canonical watch/share URL */
  watchUrl?: string
  /** Poster / thumbnail image if the page exposed one */
  posterUrl?: string
  /** <video> type attribute or inferred content-type */
  mimeType?: string
  width?: number
  height?: number
  title?: string
}

export interface FetchedURLContent {
  url: string
  title: string
  description?: string
  publishedAt?: string
  author?: string
  siteName?: string
  text: string
  wordCount: number
  images: FetchedURLImage[]
  videos: FetchedURLVideo[]
  faviconUrl?: string
}

export type RecencyFilter = 'day' | 'week' | 'month' | 'year' | 'any'

export interface FetchURLOptions {
  url: string
  extract?: 'article' | 'full' | 'metadata'
}

// ── General web search (Tavily-backed; model-agnostic) ──────────────────────
// Universal web search so ANY agent model (Kimi/DeepSeek/budget) can research,
// not just providers with native search. Same pattern Cursor/Cline/Windsurf
// use (a dedicated search API called as a tool), only the backend differs.

export interface WebSearchResult {
  title: string
  url: string
  /** Snippet / passage content the search API returned for this result. */
  content: string
  /** Relevance score (0-1) if the provider supplies one. */
  score?: number
}

export interface WebSearchOptions {
  query: string
  /** Max results to return (default 5). */
  count?: number
  /** Recency hint — providers that support it filter to recent results. */
  recency?: RecencyFilter
  /** Restrict to a single domain (e.g. "docs.python.org"). */
  site?: string
}

export interface WebSearchResponse {
  query: string
  /** Provider id that served the query (e.g. 'tavily'). */
  provider: string
  results: WebSearchResult[]
  /** Optional one-line synthesized answer (Tavily can return this). */
  answer?: string
}

export interface StockVideoFile {
  /** Direct MP4 URL — usable in <video src=...> or set_video_layer */
  url: string
  width: number
  height: number
  /** Quality hint from provider: hd/sd/large/medium/small/tiny */
  quality: string
  fileType?: string
}

export interface StockVideo {
  id: string
  source: 'pexels' | 'pixabay'
  sourceUrl: string
  thumbnailUrl: string
  previewUrl?: string
  width: number
  height: number
  durationSec: number
  /** Multiple resolutions available — agent picks the right one by dimensions. */
  files: StockVideoFile[]
  author?: string
  authorUrl?: string
  license: string
  tags?: string[]
}

export interface StockVideoSearchResponse {
  results: StockVideo[]
  query: string
  provider: string
  totalFound?: number
}

export interface StockVideoSearchOptions {
  query: string
  count?: number
  orientation?: 'landscape' | 'portrait' | 'square'
  minDurationSec?: number
  maxDurationSec?: number
  minWidth?: number
}

export interface StockImage {
  id: string
  source: 'unsplash' | 'pexels' | 'pixabay' | 'nasa' | 'wikimedia' | 'searxng' | 'openverse'
  sourceUrl: string
  /** Direct URL of the raw image (highest available) */
  url: string
  /** Smaller preview/thumbnail for UI */
  thumbnailUrl: string
  width: number
  height: number
  alt?: string
  author?: string
  authorUrl?: string
  license: string
  tags?: string[]
}

export interface StockImageSearchResponse {
  results: StockImage[]
  query: string
  provider: string
  totalFound?: number
}

export interface StockImageSearchOptions {
  query: string
  count?: number
  orientation?: 'landscape' | 'portrait' | 'square'
  minWidth?: number
}

/**
 * Archival media — Archive.org, NASA, Wikimedia Commons.
 * Unified shape covering both images and videos so the agent has one tool for "real-world reference material".
 */
export interface ArchivalItem {
  id: string
  source: 'archive-org' | 'nasa' | 'wikimedia'
  sourceUrl: string
  title: string
  description?: string
  mediaType: 'image' | 'video' | 'audio'
  /** Direct URL to highest-quality media file */
  mediaUrl: string
  thumbnailUrl?: string
  /** For images: dimensions. For video/audio: dimensions if known. */
  width?: number
  height?: number
  durationSec?: number
  /** ISO date or free-text date string from the provider */
  publishedAt?: string
  author?: string
  license: string
  tags?: string[]
}

export interface ArchivalSearchResponse {
  results: ArchivalItem[]
  query: string
  provider: string
  totalFound?: number
}

export interface ArchivalSearchOptions {
  query: string
  count?: number
  mediaType?: 'image' | 'video' | 'audio' | 'any'
  yearFrom?: number
  yearTo?: number
}
