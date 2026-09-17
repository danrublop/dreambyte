import type { ToolCallRecord } from '@/lib/agents/types'

/**
 * Pure harvest of a research sub-agent's tool results. Reads the RAW, un-truncated
 * `result.toolCalls[].output.data` (no live loop hook — outside-voice #3) to pull
 * (a) the source URLs it read and (b) the media it found WITH each hit's DIRECT
 * asset URL. Staging keys off the direct URL of the hit the brief references, never
 * the model's cited string (a model often cites the human-facing page URL, which
 * ingestDirect rejects as non-media — outside-voice #4).
 */

export interface HarvestedSource {
  title: string
  url: string
}

export interface MediaHit {
  directUrl: string
  sourceUrl?: string
  previewUrl?: string
  thumbnailUrl?: string
  title: string
  type: 'image' | 'video'
}

function rec(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {}
}
function str(x: unknown): string | undefined {
  return x == null || x === '' ? undefined : String(x)
}

export function harvestFromToolCalls(toolCalls: ToolCallRecord[] | undefined): {
  sources: HarvestedSource[]
  media: MediaHit[]
} {
  const sources: HarvestedSource[] = []
  const media: MediaHit[] = []
  const seenSrc = new Set<string>()
  const seenMedia = new Set<string>()

  const addSource = (url?: string, title?: string) => {
    if (!url || seenSrc.has(url)) return
    seenSrc.add(url)
    sources.push({ title: title || url, url })
  }
  const addMedia = (h: MediaHit) => {
    if (!h.directUrl || seenMedia.has(h.directUrl)) return
    seenMedia.add(h.directUrl)
    media.push(h)
  }

  for (const tc of toolCalls ?? []) {
    const data = rec(tc.output?.data)
    const results = Array.isArray(data.results) ? data.results : []
    // find_media(kind) replaced find_stock_videos / find_stock_images /
    // find_archival_footage, but each kind still returns its OWN provider shape, so the
    // three bodies below stay distinct — discriminate on the call's `kind` input.
    const kind = tc.toolName === 'find_media' ? String(rec(tc.input).kind ?? '') : ''
    const op =
      tc.toolName !== 'find_media'
        ? tc.toolName
        : kind === 'video'
          ? 'find_stock_videos'
          : kind === 'archival'
            ? 'find_archival_footage'
            : 'find_stock_images'
    switch (op) {
      case 'web_search':
        for (const r of results) {
          const rr = rec(r)
          addSource(str(rr.url), str(rr.title))
        }
        break
      case 'fetch_url_content': {
        const pageUrl = str(rec(tc.input).url)
        addSource(pageUrl, str(data.title))
        // The page's OWN images (url-fetch pushes the og:image hero first, then
        // decent-sized <img>, tiny icons already filtered) are real, in-context
        // photos — harvest the hero as stageable media instead of discarding it.
        // This is the "images from the web like Perplexity" path for pages the
        // agent actually read (complements SearXNG image search).
        const imgs = Array.isArray(data.images) ? data.images : []
        const hero = str(rec(imgs[0]).url)
        if (hero) {
          addMedia({
            directUrl: hero,
            sourceUrl: pageUrl,
            title: String(data.title ?? 'page image'),
            type: 'image',
          })
        }
        break
      }
      case 'find_stock_images':
        for (const r of results) {
          const rr = rec(r)
          addMedia({
            directUrl: String(rr.url ?? ''),
            sourceUrl: str(rr.sourceUrl),
            thumbnailUrl: str(rr.thumbnailUrl),
            title: String(rr.title ?? 'image'),
            type: 'image',
          })
        }
        break
      case 'find_stock_videos':
        for (const r of results) {
          const rr = rec(r)
          const files = Array.isArray(rr.files) ? rr.files : []
          addMedia({
            directUrl: String(rec(files[0]).url ?? ''),
            sourceUrl: str(rr.sourceUrl),
            previewUrl: str(rr.previewUrl),
            thumbnailUrl: str(rr.thumbnailUrl),
            title: String(rr.title ?? 'video'),
            type: 'video',
          })
        }
        break
      case 'find_archival_footage':
        for (const r of results) {
          const rr = rec(r)
          // ArchivalItem's direct URL is `mediaUrl` (NOT `url` — reading `url` made
          // directUrl always '' so every archival hit was dropped → 0 staged), and its
          // kind is `mediaType`, so a clip isn't mis-tagged as an image.
          addMedia({
            directUrl: String(rr.mediaUrl ?? ''),
            sourceUrl: str(rr.sourceUrl),
            thumbnailUrl: str(rr.thumbnailUrl),
            title: String(rr.title ?? 'archival'),
            type: rr.mediaType === 'video' ? 'video' : 'image',
          })
        }
        break
    }
  }
  return { sources, media }
}

/**
 * The media the model actually recommended: a hit is "cited" when ANY of its URLs
 * (direct, page/source, preview, thumb) appears verbatim in the brief. We then stage
 * the hit's DIRECT url regardless of which one the model wrote. Capped.
 */
export function selectCitedMedia(media: MediaHit[], briefText: string, cap = 6): MediaHit[] {
  const text = briefText || ''
  return media
    .filter((m) => [m.directUrl, m.sourceUrl, m.previewUrl, m.thumbnailUrl].some((u) => u && text.includes(u)))
    .slice(0, cap)
}

export function dedupeSources(sources: HarvestedSource[]): HarvestedSource[] {
  const seen = new Set<string>()
  const out: HarvestedSource[] = []
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue
    seen.add(s.url)
    out.push(s)
  }
  return out
}
