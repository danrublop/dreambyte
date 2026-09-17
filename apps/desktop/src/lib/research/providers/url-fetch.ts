import { assertPublicHttpUrl } from '@/lib/security/url-guard'
import type { FetchURLOptions, FetchedURLContent, FetchedURLImage, FetchedURLVideo } from '../types'

const USER_AGENT = 'Mozilla/5.0 (compatible; DreambyteBot/1.0; +https://github.com/danrublop/dreambyte)'
const MAX_BYTES = 2_000_000
const MAX_TEXT_CHARS = 12_000

/**
 * Reject URLs that would let the agent hit loopback, private network, or non-HTTP
 * schemes. Without this, an adversarial prompt could exfil data from internal
 * services (e.g. fetch http://localhost:3000/api/projects/... or AWS metadata).
 *
 * Delegates to the hardened shared guard. The previous local copy compared
 * bracket-less strings against `URL.hostname` (which is bracketed for IPv6), so
 * `[::1]`, `[fe80::1]`, and `[::ffff:169.254.169.254]` slipped through. The shared
 * `assertPublicHttpUrl` blocks loopback/link-local/ULA/IPv4-mapped IPv6 + numeric
 * IPv4 encodings in one place.
 */
function assertSafeUrl(raw: string): URL {
  return assertPublicHttpUrl(raw)
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
}

function extractBetween(html: string, openRe: RegExp, closeRe: RegExp): string | null {
  const open = openRe.exec(html)
  if (!open) return null
  const after = html.slice(open.index + open[0].length)
  const close = closeRe.exec(after)
  if (!close) return null
  return after.slice(0, close.index)
}

function extractMeta(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
  ]
  for (const re of patterns) {
    const m = re.exec(html)
    if (m?.[1]) return decodeEntities(m[1])
  }
  return null
}

function extractTitle(html: string): string {
  const og = extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title')
  if (og) return og
  const t = extractBetween(html, /<title[^>]*>/i, /<\/title>/i)
  return t ? decodeEntities(t).trim() : ''
}

function extractBodyText(html: string): string {
  const cleaned = html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const article = extractBetween(cleaned, /<article[^>]*>/i, /<\/article>/i)
  const main = article ?? extractBetween(cleaned, /<main[^>]*>/i, /<\/main>/i)
  const source = main ?? cleaned
  const text = decodeEntities(source.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, MAX_TEXT_CHARS)
}

function extractImages(html: string, baseUrl: string): FetchedURLImage[] {
  const images: FetchedURLImage[] = []
  const og = extractMeta(html, 'og:image')
  if (og) images.push({ url: resolveUrl(og, baseUrl) })
  const imgRe = /<img[^>]+>/gi
  let match: RegExpExecArray | null
  let i = 0
  while ((match = imgRe.exec(html)) && i < 8) {
    const tag = match[0]
    const src = /src=["']([^"']+)["']/i.exec(tag)?.[1] || /data-src=["']([^"']+)["']/i.exec(tag)?.[1]
    if (!src) continue
    const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1]
    const w = Number(/width=["']?(\d+)/i.exec(tag)?.[1] || 0)
    const h = Number(/height=["']?(\d+)/i.exec(tag)?.[1] || 0)
    if (w > 0 && w < 120) continue
    images.push({
      url: resolveUrl(src, baseUrl),
      alt: alt ? decodeEntities(alt) : undefined,
      width: w || undefined,
      height: h || undefined,
    })
    i++
  }
  return dedupByUrl(images)
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}

function dedupByUrl(list: FetchedURLImage[]): FetchedURLImage[] {
  const seen = new Set<string>()
  const out: FetchedURLImage[] = []
  for (const item of list) {
    if (seen.has(item.url)) continue
    seen.add(item.url)
    out.push(item)
  }
  return out
}

/**
 * Pull playable video references from HTML: inline <video>/<source>, YouTube/Vimeo/Twitter
 * iframes, and og:video/twitter:player metadata. Returns a deduped list of normalized entries.
 */
function extractVideos(html: string, baseUrl: string): FetchedURLVideo[] {
  const out: FetchedURLVideo[] = []
  const seen = new Set<string>()
  const add = (v: FetchedURLVideo) => {
    const key = v.url
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(v)
  }

  // og:video and twitter:player from meta tags
  const ogVideo =
    extractMeta(html, 'og:video') || extractMeta(html, 'og:video:url') || extractMeta(html, 'og:video:secure_url')
  const ogType = extractMeta(html, 'og:video:type') || undefined
  const ogWidth = Number(extractMeta(html, 'og:video:width') || 0) || undefined
  const ogHeight = Number(extractMeta(html, 'og:video:height') || 0) || undefined
  const ogPoster = extractMeta(html, 'og:image') || undefined
  if (ogVideo) {
    add({
      url: resolveUrl(ogVideo, baseUrl),
      kind: 'direct',
      mimeType: ogType,
      width: ogWidth,
      height: ogHeight,
      posterUrl: ogPoster ? resolveUrl(ogPoster, baseUrl) : undefined,
    })
  }

  // <video src=...> and <video>...<source src=...>
  const videoTagRe = /<video\b[^>]*>([\s\S]*?)<\/video>/gi
  let vMatch: RegExpExecArray | null
  let vCount = 0
  while ((vMatch = videoTagRe.exec(html)) && vCount < 8) {
    vCount++
    const tag = vMatch[0]
    const inner = vMatch[1]
    const poster = /poster=["']([^"']+)["']/i.exec(tag)?.[1]
    const openTag = tag.slice(0, tag.indexOf('>') + 1)
    const directSrc = /src=["']([^"']+)["']/i.exec(openTag)?.[1]
    const w = Number(/width=["']?(\d+)/i.exec(openTag)?.[1] || 0) || undefined
    const h = Number(/height=["']?(\d+)/i.exec(openTag)?.[1] || 0) || undefined
    if (directSrc) {
      add({
        url: resolveUrl(directSrc, baseUrl),
        kind: 'direct',
        posterUrl: poster ? resolveUrl(poster, baseUrl) : undefined,
        width: w,
        height: h,
      })
    }
    const srcRe = /<source\b[^>]+>/gi
    let sMatch: RegExpExecArray | null
    while ((sMatch = srcRe.exec(inner))) {
      const src = /src=["']([^"']+)["']/i.exec(sMatch[0])?.[1]
      const type = /type=["']([^"']+)["']/i.exec(sMatch[0])?.[1]
      if (src) {
        add({
          url: resolveUrl(src, baseUrl),
          kind: 'direct',
          mimeType: type,
          posterUrl: poster ? resolveUrl(poster, baseUrl) : undefined,
          width: w,
          height: h,
        })
      }
    }
  }

  // iframe embeds: YouTube, Vimeo, Twitter, generic
  const iframeRe = /<iframe\b[^>]+src=["']([^"']+)["'][^>]*>/gi
  let iMatch: RegExpExecArray | null
  let iCount = 0
  while ((iMatch = iframeRe.exec(html)) && iCount < 16) {
    iCount++
    const raw = iMatch[1]
    const abs = resolveUrl(raw, baseUrl)
    let kind: FetchedURLVideo['kind'] = 'iframe'
    let watchUrl: string | undefined = abs
    if (/youtube\.com\/embed\/|youtu\.be\//i.test(abs)) {
      kind = 'youtube'
      const id = /\/embed\/([A-Za-z0-9_-]{6,})/i.exec(abs)?.[1] || /youtu\.be\/([A-Za-z0-9_-]{6,})/i.exec(abs)?.[1]
      if (id) watchUrl = `https://www.youtube.com/watch?v=${id}`
    } else if (/player\.vimeo\.com\/video\//i.test(abs)) {
      kind = 'vimeo'
      const id = /video\/(\d+)/.exec(abs)?.[1]
      if (id) watchUrl = `https://vimeo.com/${id}`
    } else if (/(^|\/\/)(twitter|x)\.com\/.+\/status\//i.test(abs)) {
      kind = 'twitter'
    } else {
      // Non-video iframes are common (ads, comments, maps) — only keep if URL looks video-y.
      if (!/video|player|stream|media|embed|watch/i.test(abs)) continue
    }
    add({ url: abs, kind, watchUrl, posterUrl: ogPoster ? resolveUrl(ogPoster, baseUrl) : undefined })
  }

  return out
}

function domainFavicon(url: string): string | undefined {
  try {
    const host = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`
  } catch {
    return undefined
  }
}

export async function fetchUrlContent(opts: FetchURLOptions): Promise<FetchedURLContent> {
  const { url } = opts
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  // Follow redirects MANUALLY so each hop is validated BEFORE the request is sent — with
  // redirect:'follow' the runtime would already have hit an internal host before we could
  // inspect the final URL. Cap the chain to avoid loops.
  const MAX_REDIRECTS = 5
  let currentUrl = assertSafeUrl(url).toString()
  let response: Response
  try {
    let hops = 0
    for (;;) {
      response = await fetch(currentUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
        redirect: 'manual',
      })
      // Not a redirect (status outside 3xx, or no Location) — proceed with this response.
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
      if (!location) break
      if (++hops > MAX_REDIRECTS) throw new Error('Too many redirects')
      // Resolve relative redirects against the current URL, then re-validate the host.
      const next = new URL(location, currentUrl).toString()
      try {
        assertSafeUrl(next)
      } catch (e) {
        throw new Error(`Redirected to disallowed host: ${(e as Error).message}`, { cause: e })
      }
      currentUrl = next
    }
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('html') && !contentType.includes('xml') && contentType) {
    throw new Error(`Unsupported content-type: ${contentType}`)
  }

  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  if (reader) {
    while (total < MAX_BYTES) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      total += value.length
    }
  } else {
    const buf = new Uint8Array(await response.arrayBuffer())
    chunks.push(buf)
  }
  const html = new TextDecoder().decode(concat(chunks))

  const title = extractTitle(html)
  const description =
    extractMeta(html, 'og:description') ||
    extractMeta(html, 'twitter:description') ||
    extractMeta(html, 'description') ||
    undefined
  const publishedAt =
    extractMeta(html, 'article:published_time') || extractMeta(html, 'og:article:published_time') || undefined
  const author = extractMeta(html, 'author') || extractMeta(html, 'article:author') || undefined
  const siteName = extractMeta(html, 'og:site_name') || undefined

  const mode = opts.extract ?? 'article'
  const text = mode === 'metadata' ? '' : extractBodyText(html)
  // Resolve relative media against the FINAL url (after redirects), not the original —
  // a page reached via redirect emits paths relative to its own location.
  const images = mode === 'metadata' ? [] : extractImages(html, currentUrl)
  // Videos always extracted (cheap; metadata-mode callers often want them for link previews)
  const videos = extractVideos(html, currentUrl)

  return {
    url: currentUrl,
    title,
    description,
    publishedAt,
    author,
    siteName,
    text,
    wordCount: text ? text.split(/\s+/).length : 0,
    images,
    videos,
    faviconUrl: domainFavicon(url),
  }
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}
