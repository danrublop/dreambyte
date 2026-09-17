// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { keylessWebSearch, isKeylessReady } from './keyless'

// Mojeek: result blocks between <!--rs--> / <!--re-->; title <a class="title" href>,
// snippet <p class="s">.
const MOJEEK_FIXTURE = `<html><body><ul>
<!--rs--><li class="r1"><a class="ob" href="https://motion.dev/" title="https://motion.dev/"></a>
  <h2><a class="title" href="https://motion.dev/" title="x">Motion &mdash; Animate</a></h2>
  <p class="s">A modern <strong>animation library</strong> for React.</p></li><!--re-->
<!--rs--><li class="r2"><h2><a class="title" href="https://www.react-spring.dev/">React Spring</a></h2>
  <p class="s">Spring-based animations.</p></li><!--re-->
</ul></body></html>`

// DDG Lite: result anchor class="result-link", href is a //duckduckgo.com/l/?uddg= redirect.
const DDG_FIXTURE = `<table>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmotion.dev%2F&rut=x">Motion &mdash; Animate</a></td></tr>
<tr><td class="result-snippet">A modern <b>animation library</b> for React.</td></tr>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact-spring.dev%2F">React Spring</a></td></tr>
<tr><td class="result-snippet">Spring-based animations.</td></tr>
</table>`

// Brave: primary result anchor has a hashed class ending in " l1".
const BRAVE_FIXTURE = `<body>
<a href="https://motion.dev/" target="_self" class="svelte-14r20fy l1"><span>Motion.dev</span></a>
<a href="https://www.react-spring.dev/" class="svelte-14r20fy l1">React Spring</a>
<a href="https://search.brave.com/settings" class="x l1">settings (ignored)</a>
</body>`

const BOT_CHECK = '<div class="anomaly-modal">nope</div>'

/** Route a mock response by which engine URL is being fetched. */
function routeFetch(map: { mojeek?: string; ddg?: string; brave?: string }) {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('mojeek.com')) return new Response(map.mojeek ?? BOT_CHECK, { status: 200 })
    if (u.includes('duckduckgo.com')) return new Response(map.ddg ?? BOT_CHECK, { status: 200 })
    if (u.includes('brave.com')) return new Response(map.brave ?? BOT_CHECK, { status: 200 })
    return new Response('', { status: 404 })
  })
}

afterEach(() => vi.restoreAllMocks())

describe('keylessWebSearch', () => {
  it('is always ready (no config needed)', () => {
    expect(isKeylessReady()).toBe(true)
  })

  it('parses Mojeek (the reliable primary) and decodes entities', async () => {
    vi.stubGlobal('fetch', routeFetch({ mojeek: MOJEEK_FIXTURE }))
    const r = await keylessWebSearch({ query: 'react animation library', count: 5 })
    expect(r.provider).toBe('keyless:mojeek')
    expect(r.results).toHaveLength(2)
    expect(r.results[0]).toMatchObject({ title: 'Motion — Animate', url: 'https://motion.dev/' })
    expect(r.results[0].content).toContain('animation library')
    expect(r.results[1].url).toBe('https://www.react-spring.dev/')
  })

  it('falls through Mojeek → DuckDuckGo (unwrapping the uddg redirect)', async () => {
    vi.stubGlobal('fetch', routeFetch({ ddg: DDG_FIXTURE })) // mojeek bot-checks
    const r = await keylessWebSearch({ query: 'react animation library', count: 5 })
    expect(r.provider).toBe('keyless:duckduckgo')
    expect(r.results[0]).toMatchObject({ title: 'Motion — Animate', url: 'https://motion.dev/' })
    expect(r.results[1].url).toBe('https://react-spring.dev/')
  })

  it('falls all the way through to Brave, skipping brave.com self-links', async () => {
    vi.stubGlobal('fetch', routeFetch({ brave: BRAVE_FIXTURE })) // mojeek + ddg bot-check
    const r = await keylessWebSearch({ query: 'react animation library', count: 5 })
    expect(r.provider).toBe('keyless:brave')
    expect(r.results.map((x) => x.url)).toEqual(['https://motion.dev/', 'https://www.react-spring.dev/'])
  })

  it('throws a clear "add a key" error when every engine is blocked', async () => {
    vi.stubGlobal('fetch', routeFetch({})) // all bot-check
    await expect(keylessWebSearch({ query: 'x' })).rejects.toThrow(/TAVILY_API_KEY|native search/)
  })

  it('rejects an empty query', async () => {
    await expect(keylessWebSearch({ query: '   ' })).rejects.toThrow(/query is required/)
  })
})
