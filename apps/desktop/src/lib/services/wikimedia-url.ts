/**
 * Wikimedia `upload.wikimedia.org/wikipedia/<proj>/thumb/<a>/<ab>/<File>/<N>px-<File>`
 * thumbnail URLs 400 from some networks (Wikimedia's Varnish edge) even with a valid
 * User-Agent — verified: a full Wikimedia file 200s without any UA, but a /thumb/ URL
 * 400s with a browser UA. That (not a missing UA) was the real "couldn't get the trophy"
 * failure — both the agent and the repro had picked a /thumb/ URL.
 *
 * Wikimedia's canonical fetch is `Special:FilePath/<File>?width=N` (rename-proof; redirects
 * to a working file and returns 200, including sized variants). Rewrite /thumb/ URLs to it.
 * Everything else (full-res files, non-Wikimedia hosts) passes through unchanged.
 */
export function normalizeWikimediaThumbUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  if (u.hostname !== 'upload.wikimedia.org') return raw
  const parts = u.pathname.split('/').filter(Boolean)
  const ti = parts.indexOf('thumb')
  // After 'thumb' the layout is <hashA>/<hashAB>/<File>/<Npx-...> — need all four.
  if (ti === -1 || parts.length < ti + 5) return raw
  const file = parts[ti + 3]
  if (!file) return raw
  const sizeSeg = parts[parts.length - 1]
  const m = sizeSeg.match(/^(\d{2,4})px-/)
  const base = `https://commons.wikimedia.org/wiki/Special:FilePath/${file}`
  return m ? `${base}?width=${m[1]}` : base
}
