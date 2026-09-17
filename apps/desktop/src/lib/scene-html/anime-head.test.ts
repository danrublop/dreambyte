import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ANIME_HEAD, ANIME_HEAD_EMBED, ANIME_VERSION, rewriteAnimeForEmbed } from './anime-head'

/**
 * C4 — offline-proof animation runtime with an editor / embed split.
 * Editor HTML loads the LOCAL vendored anime.js first (CDN onerror fallback);
 * published embeds + Tier-2 exports are CDN-first (second-CDN fallback).
 */
const LOCAL_SRC = 'src="/vendor/animejs/anime.umd.min.js"'
const CDN = `https://cdn.jsdelivr.net/npm/animejs@${ANIME_VERSION}/dist/bundles/anime.umd.min.js`
const CDN2 = `https://unpkg.com/animejs@${ANIME_VERSION}/dist/bundles/anime.umd.min.js`

describe('ANIME_HEAD editor form (local-vendor-first)', () => {
  it('loads the vendored bundle first with a CDN onerror fallback', () => {
    expect(ANIME_HEAD).toContain(`${LOCAL_SRC} onerror="this.onerror=null;this.src='${CDN}'"`)
  })

  it('the vendored bundle + license exist and match the pinned version', async () => {
    const dir = path.join(__dirname, '../../../public/vendor/animejs')
    expect(existsSync(path.join(dir, 'LICENSE.md'))).toBe(true)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(path.join(dir, 'anime.umd.min.js'), 'utf8').slice(0, 200)).toContain(`v${ANIME_VERSION}`)
  })

  it('switches the engine to seconds before any SDK or scene code', () => {
    const unit = ANIME_HEAD.indexOf("anime.engine.timeUnit = 's'")
    expect(unit).toBeGreaterThan(ANIME_HEAD.indexOf(LOCAL_SRC))
    expect(unit).toBeLessThan(ANIME_HEAD.indexOf('/sdk/dreambyte-motion.js'))
  })

  it('keeps the SDK + lottie tags', () => {
    expect(ANIME_HEAD).toContain('/sdk/dreambyte-motion.js')
    expect(ANIME_HEAD).toContain('lottie.min.js')
  })
})

describe('ANIME_HEAD_EMBED form (CDN-first)', () => {
  it('loads from the CDN first with a second-CDN fallback, never /vendor', () => {
    expect(ANIME_HEAD_EMBED).toContain(`src="${CDN}" onerror="this.onerror=null;this.src='${CDN2}'"`)
    expect(ANIME_HEAD_EMBED).not.toContain('/vendor/')
  })
})

describe('rewriteAnimeForEmbed', () => {
  it('converts the editor head to exactly the embed head', () => {
    expect(rewriteAnimeForEmbed(ANIME_HEAD)).toBe(ANIME_HEAD_EMBED)
  })

  it('is idempotent and leaves other src paths alone', () => {
    const embed = `<head><script src="/sdk/dreambyte-motion.js"></script>${ANIME_HEAD_EMBED}</head>`
    expect(rewriteAnimeForEmbed(embed)).toBe(embed)
  })
})
