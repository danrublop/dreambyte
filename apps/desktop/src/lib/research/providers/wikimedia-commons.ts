import type { ArchivalItem, ArchivalSearchOptions, ArchivalSearchResponse } from '../types'

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php'

interface CommonsImageInfo {
  url?: string
  thumburl?: string
  width?: number
  height?: number
  duration?: number
  mime?: string
  extmetadata?: {
    LicenseShortName?: { value: string }
    UsageTerms?: { value: string }
    Artist?: { value: string }
    ImageDescription?: { value: string }
    DateTimeOriginal?: { value: string }
    Categories?: { value: string }
  }
  descriptionurl?: string
  descriptionshorturl?: string
}

interface CommonsPage {
  pageid: number
  ns: number
  title: string
  imageinfo?: CommonsImageInfo[]
}

interface CommonsQueryResponse {
  query?: {
    pages?: Record<string, CommonsPage>
    search?: Array<{ title: string; snippet: string }>
  }
  continue?: { gsroffset: number }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function mediaTypeFromMime(mime: string | undefined): 'image' | 'video' | 'audio' | null {
  if (!mime) return null
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/') || mime === 'application/ogg' || mime === 'application/x-matroska') return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

function applyMediaTypeFilter(mt: ArchivalSearchOptions['mediaType'], apiFilter: string | null): string | null {
  // Commons uses 'filemime:' prefixes or 'filetype:' qualifiers via CirrusSearch syntax.
  if (!mt || mt === 'any') return apiFilter
  if (mt === 'image') return `filetype:bitmap|drawing ${apiFilter ?? ''}`.trim()
  if (mt === 'video') return `filetype:video ${apiFilter ?? ''}`.trim()
  if (mt === 'audio') return `filetype:audio ${apiFilter ?? ''}`.trim()
  return apiFilter
}

export async function wikimediaCommonsSearch(opts: ArchivalSearchOptions): Promise<ArchivalSearchResponse> {
  const count = Math.min(Math.max(opts.count ?? 10, 1), 30)
  const query = applyMediaTypeFilter(opts.mediaType, opts.query) ?? opts.query

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrnamespace: '6', // File: namespace
    gsrsearch: query,
    gsrlimit: String(count),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata|mediatype',
    iiurlwidth: '800',
    iiurlheight: '800',
  })

  const response = await fetch(`${COMMONS_API}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'DreambyteBot/1.0 (+https://github.com/danrublop/dreambyte)' },
  })
  if (!response.ok) throw new Error(`Wikimedia Commons search failed: ${response.status}`)
  const data = (await response.json()) as CommonsQueryResponse

  const pages = Object.values(data.query?.pages ?? {})

  const results: ArchivalItem[] = pages
    .map((p): ArchivalItem | null => {
      const info = p.imageinfo?.[0]
      if (!info?.url) return null
      const mt = mediaTypeFromMime(info.mime)
      if (!mt) return null
      if (opts.mediaType && opts.mediaType !== 'any' && opts.mediaType !== mt) return null

      const meta = info.extmetadata ?? {}
      const rawTitle = p.title.replace(/^File:/, '').replace(/\.\w+$/, '')
      return {
        id: String(p.pageid),
        source: 'wikimedia',
        sourceUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
        title: rawTitle,
        description: meta.ImageDescription ? stripTags(meta.ImageDescription.value) : undefined,
        mediaType: mt,
        mediaUrl: info.url,
        thumbnailUrl: info.thumburl,
        width: info.width,
        height: info.height,
        durationSec: info.duration,
        publishedAt: meta.DateTimeOriginal?.value,
        author: meta.Artist ? stripTags(meta.Artist.value).slice(0, 120) : undefined,
        license: meta.LicenseShortName?.value ?? meta.UsageTerms?.value ?? 'Wikimedia Commons — check file page',
        tags: meta.Categories
          ? meta.Categories.value
              .split('|')
              .map((c) => c.trim())
              .filter(Boolean)
          : undefined,
      }
    })
    .filter((r): r is ArchivalItem => r !== null)

  return {
    results,
    query: opts.query,
    provider: 'wikimedia',
    totalFound: results.length,
  }
}
