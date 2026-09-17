import { describe, it, expect } from 'vitest'
import { SCENE_CSP, SCENE_CSP_META, stripSceneCsp } from './scene-csp'

describe('SCENE_CSP (security audit P1-4)', () => {
  it('denies-by-default and never allows wide-open connect-src', () => {
    expect(SCENE_CSP).toContain("default-src 'none'")
    const connect = SCENE_CSP.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('connect-src'))
    expect(connect).toBeTruthy()
    // The load-bearing restriction: connect-src must NOT contain a bare `https:`
    // (which would let a scene POST/fetch to any host and defeat the whole policy).
    expect(connect).not.toMatch(/\bhttps:(\s|$)/)
    expect(connect).toContain("'self'")
    expect(connect).toContain('dreambyte:')
  })

  it('blocks an arbitrary attacker exfiltration host but allows the asset CDNs', () => {
    const connect = SCENE_CSP.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('connect-src'))!
    // Attacker host is NOT in the allowlist.
    expect(connect).not.toContain('evil.example')
    // Legitimate asset CDNs scenes fetch GLB/lottie/modules from ARE allowed.
    expect(connect).toContain('https://cdn.jsdelivr.net')
    expect(connect).toContain('https://lottie.host')
  })

  it('allows scene scripts/styles/images/fonts so rendering is not broken', () => {
    expect(SCENE_CSP).toContain('script-src')
    expect(SCENE_CSP).toContain("'unsafe-inline'")
    expect(SCENE_CSP).toContain("'unsafe-eval'")
    expect(SCENE_CSP).toMatch(/img-src[^;]*data:/)
    expect(SCENE_CSP).toMatch(/img-src[^;]*blob:/)
    expect(SCENE_CSP).toMatch(/font-src[^;]*https:/)
  })

  it('round-trips the meta tag: SCENE_CSP_META embeds SCENE_CSP and stripSceneCsp removes it', () => {
    expect(SCENE_CSP_META).toContain(SCENE_CSP)
    // The publish path strips the MARKED meta (writeSceneHTML stamps data-dreambyte-csp).
    const marked = SCENE_CSP_META.replace('<meta ', '<meta data-dreambyte-csp ')
    const html = `<!doctype html><html><head>\n  ${marked}\n  <base href="x"></head><body></body></html>`
    const stripped = stripSceneCsp(html)
    expect(stripped).not.toContain('Content-Security-Policy')
    expect(stripped).toContain('<base href="x">')
  })
})
