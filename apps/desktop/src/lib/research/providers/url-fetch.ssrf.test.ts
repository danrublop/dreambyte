/**
 * Manual-redirect SSRF hardening. fetchUrlContent follows redirects by hand, validating each
 * hop against the shared public-URL guard BEFORE issuing the next request, and caps the chain.
 * A redirect to a private/loopback/metadata host (incl. IPv6) must be refused mid-chain.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchUrlContent } from './url-fetch'

const redirect = (loc: string) => new Response(null, { status: 302, headers: { location: loc } })
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

afterEach(() => vi.unstubAllGlobals())

describe('fetchUrlContent — manual-redirect SSRF hardening', () => {
  it('rejects a 302 pointing at the cloud-metadata IP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirect('http://169.254.169.254/latest/meta-data')))
    await expect(fetchUrlContent({ url: 'https://safe.example.com' })).rejects.toThrow(/disallowed host|not allowed/i)
  })

  it('rejects a redirect to IPv6 loopback [::1] (the bug the local guard missed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirect('http://[::1]:8080/admin')))
    await expect(fetchUrlContent({ url: 'https://safe.example.com' })).rejects.toThrow(/disallowed host|not allowed/i)
  })

  it('rejects localhost mid-chain (after one safe hop)', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://still-safe.example.org/x'))
      .mockResolvedValueOnce(redirect('http://localhost:8080/admin'))
    vi.stubGlobal('fetch', f)
    await expect(fetchUrlContent({ url: 'https://safe.example.com' })).rejects.toThrow(/disallowed host|not allowed/i)
  })

  it('caps the chain at MAX_REDIRECTS (loop protection)', async () => {
    let i = 0
    vi.stubGlobal('fetch', vi.fn(async () => redirect(`https://safe.example.com/hop${i++}`)))
    await expect(fetchUrlContent({ url: 'https://safe.example.com' })).rejects.toThrow(/Too many redirects/)
  })

  it('resolves a relative Location against the current URL and follows when safe', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect('/article/123')) // relative
      .mockResolvedValueOnce(html('<html><body><p>some real content here for the body</p></body></html>'))
    vi.stubGlobal('fetch', f)
    const r = await fetchUrlContent({ url: 'https://safe.example.com/start' })
    expect(r.url).toBe('https://safe.example.com/article/123') // returns the FINAL url
    expect(f.mock.calls[1][0]).toBe('https://safe.example.com/article/123') // followed absolutized
  })
})
