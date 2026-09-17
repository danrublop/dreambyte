import type { ArchivalItem, ArchivalSearchOptions, ArchivalSearchResponse } from '../types'

const ARCHIVE_SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php'
const ARCHIVE_METADATA_ENDPOINT = 'https://archive.org/metadata'
const ARCHIVE_DOWNLOAD_PREFIX = 'https://archive.org/download'

interface ArchiveSearchDoc {
  identifier: string
  title?: string | string[]
  description?: string | string[]
  date?: string
  creator?: string | string[]
  mediatype: string
  licenseurl?: string
  subject?: string | string[]
  format?: string | string[]
  year?: string
}

interface ArchiveSearchResponse {
  response: {
    numFound: number
    docs: ArchiveSearchDoc[]
  }
}

interface ArchiveMetadataFile {
  name: string
  format: string
  size?: string
  length?: string
  width?: string
  height?: string
  source?: string
  original?: string
}

interface ArchiveMetadataResponse {
  files: ArchiveMetadataFile[]
  d1?: string
  server?: string
  metadata?: { title?: string; description?: string; creator?: string | string[] }
}

function first<T>(v: T | T[] | undefined): T | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v[0] : v
}

const VIDEO_FORMATS = ['MPEG4', 'h.264', 'h.264 IA', 'h.264 HD', 'Matroska', 'Ogg Video', '512Kb MPEG4', 'MPEG2']
const IMAGE_FORMATS = ['JPEG', 'PNG', 'TIFF', 'JPEG 2000']
const AUDIO_FORMATS = ['VBR MP3', 'MP3', 'Flac', 'Ogg Vorbis']

function pickBestFile(
  files: ArchiveMetadataFile[],
  wanted: 'video' | 'image' | 'audio',
): ArchiveMetadataFile | undefined {
  const preferred = wanted === 'video' ? VIDEO_FORMATS : wanted === 'image' ? IMAGE_FORMATS : AUDIO_FORMATS
  for (const fmt of preferred) {
    const m = files.find((f) => f.format === fmt)
    if (m) return m
  }
  return undefined
}

function mediaTypeFromArchive(mt: string): 'image' | 'video' | 'audio' | null {
  if (mt === 'movies' || mt === 'video') return 'video'
  if (mt === 'image') return 'image'
  if (mt === 'audio') return 'audio'
  return null
}

/**
 * Archive.org search. Two-phase: advancedsearch returns identifiers, then we
 * hit /metadata/{id} per hit to resolve the actual media file URL. Results
 * capped by opts.count because the metadata fanout is slow.
 */
export async function archiveOrgSearch(opts: ArchivalSearchOptions): Promise<ArchivalSearchResponse> {
  const count = Math.min(Math.max(opts.count ?? 10, 1), 25)

  // Build the Lucene query.
  const mt = opts.mediaType ?? 'video'
  const archiveMediatype = mt === 'video' ? 'movies' : mt === 'image' ? 'image' : mt === 'audio' ? 'audio' : null
  const clauses: string[] = [opts.query]
  if (archiveMediatype) clauses.push(`mediatype:${archiveMediatype}`)
  if (opts.yearFrom || opts.yearTo) {
    const from = opts.yearFrom ?? 1800
    const to = opts.yearTo ?? new Date().getFullYear()
    clauses.push(`year:[${from} TO ${to}]`)
  }
  // Exclude items without a license URL to bias toward permissively-licensed content.
  // (Not strict — archive.org's license field is inconsistent.)

  const params = new URLSearchParams({
    q: clauses.join(' AND '),
    'fl[]': 'identifier',
    rows: String(count),
    page: '1',
    output: 'json',
  })
  // Each fl[] must repeat; URLSearchParams collapses duplicates, so build manually:
  const fields = ['identifier', 'title', 'description', 'date', 'creator', 'mediatype', 'licenseurl', 'subject', 'year']
  const flString = fields.map((f) => `fl[]=${encodeURIComponent(f)}`).join('&')
  const searchUrl = `${ARCHIVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(clauses.join(' AND '))}&${flString}&rows=${count}&page=1&output=json`

  const searchRes = await fetch(searchUrl, { headers: { Accept: 'application/json' } })
  if (!searchRes.ok) throw new Error(`Archive.org search failed: ${searchRes.status}`)
  const searchData = (await searchRes.json()) as ArchiveSearchResponse
  const docs = searchData.response?.docs ?? []

  // Fan-out metadata calls in parallel, capped for politeness.
  const items = await Promise.all(
    docs.map(async (d): Promise<ArchivalItem | null> => {
      const wanted = mediaTypeFromArchive(d.mediatype)
      if (!wanted) return null
      if (opts.mediaType && opts.mediaType !== 'any' && wanted !== opts.mediaType) return null

      try {
        const metaRes = await fetch(`${ARCHIVE_METADATA_ENDPOINT}/${d.identifier}`, {
          headers: { Accept: 'application/json' },
        })
        if (!metaRes.ok) return null
        const meta = (await metaRes.json()) as ArchiveMetadataResponse
        const best = pickBestFile(meta.files ?? [], wanted)
        if (!best) return null

        const mediaUrl = `${ARCHIVE_DOWNLOAD_PREFIX}/${d.identifier}/${encodeURIComponent(best.name)}`
        const thumbUrl = `${ARCHIVE_DOWNLOAD_PREFIX}/${d.identifier}/__ia_thumb.jpg`

        return {
          id: d.identifier,
          source: 'archive-org',
          sourceUrl: `https://archive.org/details/${d.identifier}`,
          title: first(d.title) ?? d.identifier,
          description: first(d.description),
          mediaType: wanted,
          mediaUrl,
          thumbnailUrl: thumbUrl,
          width: best.width ? Number(best.width) : undefined,
          height: best.height ? Number(best.height) : undefined,
          durationSec: best.length ? parseArchiveLength(best.length) : undefined,
          publishedAt: d.date ?? d.year,
          author: first(d.creator),
          license: d.licenseurl ?? 'Archive.org — check item page for license',
          tags: Array.isArray(d.subject) ? d.subject : d.subject ? [d.subject] : undefined,
        }
      } catch {
        return null
      }
    }),
  )

  return {
    results: items.filter((i): i is ArchivalItem => i !== null),
    query: opts.query,
    provider: 'archive-org',
    totalFound: searchData.response?.numFound,
  }
}

/** Parse Archive.org's length string which can be "HH:MM:SS" or a bare seconds number. */
function parseArchiveLength(s: string): number | undefined {
  if (/^[\d.]+$/.test(s)) return Number(s)
  const parts = s.split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return undefined
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 1) return parts[0]
  return undefined
}
