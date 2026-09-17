// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { generateSceneHTML, rebuildLegacySceneHtml } from '../sceneTemplate'
import type { Scene } from '../types'
import { LEGACY_GSAP_MESSAGE, sceneUsesLegacyGsap } from './legacy-gsap'

const scene = (over: Partial<Scene>) =>
  ({
    id: 'scene-1',
    name: 'S',
    prompt: 'make it pop with gsap.to',
    duration: 6,
    sceneType: 'motion',
    sceneCode: '',
    sceneHTML: '<h1 id="t">Hi</h1>',
    sceneStyles: '',
    svgContent: '',
    svgObjects: [],
    aiLayers: [],
    interactions: [],
    variables: [],
    textOverlays: [],
    styleOverride: {},
    ...over,
  }) as unknown as Scene

describe('legacy GSAP scene detection', () => {
  it.each([
    ["gsap.to('#t', { y: 0 })"],
    ['window.__tl.from(".a", { opacity: 0 }, 0)'],
    ['const tl = window.__tl; tl.fromTo(el, {x:0}, {x:1}, 0)'],
    ['var u = window.__tl ? window.__tl.time() : 0'],
    ['gsap.registerPlugin(SplitText)'],
  ])('flags pre-removal code: %s', (code) => {
    expect(sceneUsesLegacyGsap(scene({ sceneCode: code }))).toBe(true)
    expect(sceneUsesLegacyGsap(scene({ sceneType: 'react', reactCode: code }))).toBe(true)
  })

  it.each([
    ["window.__tl.add('#t', { y: [40, 0], duration: 0.6, ease: 'outExpo' }, 0.2)"],
    ['const parts = Array.from(document.querySelectorAll(".a")); html.to = 1'],
    ['window.__dreambyte.onTick(function (t) { draw(t) })'],
  ])('leaves anime.js code alone: %s', (code) => {
    // (the prompt field mentions gsap — only code fields are inspected)
    expect(sceneUsesLegacyGsap(scene({ sceneCode: code }))).toBe(false)
  })

  it('renders a visible regenerate card + a runtime error instead of the broken scene', () => {
    const html = generateSceneHTML(scene({ sceneType: 'three', sceneCode: 'gsap.to(cube.rotation, { y: 6 })' }))
    expect(html).toContain(LEGACY_GSAP_MESSAGE)
    expect(html).toContain(`throw new Error(${JSON.stringify(LEGACY_GSAP_MESSAGE)})`)
    expect(html).not.toContain('cube.rotation')
    // still a normal controller scene, so preview/export keep working
    expect(html).toContain('window.__clock')
  })

  it('does not touch clean scenes', () => {
    const html = generateSceneHTML(scene({ sceneCode: "window.__tl.add('#t', { opacity: [0, 1] }, 0)" }))
    expect(html).not.toContain(LEGACY_GSAP_MESSAGE)
    expect(html).toContain("window.__tl.add('#t'")
  })

  // HTML written before the removal is still on disk, with a GSAP head + CDN fallback.
  const OLD_HTML = `<!DOCTYPE html><html><head>
  <base href="dreambyte://app/">
  <script src="/vendor/gsap/gsap.min.js" onerror="this.onerror=null;this.src='https://cdn.jsdelivr.net/npm/gsap@3.14/dist/gsap.min.js'"></script>
  <script>gsap.registerPlugin(SplitText)</script>
</head><body><script>
    var SCENE_ID     = 'old-scene-7';
    var DURATION     = 12;
    var WIDTH        = 1080;
    var HEIGHT       = 1920;
</script></body></html>`

  it('rebuilds stored pre-removal HTML as the placeholder, keeping id, duration and size', () => {
    const html = rebuildLegacySceneHtml(OLD_HTML)
    expect(html).toContain(LEGACY_GSAP_MESSAGE)
    expect(html).not.toMatch(/\/gsap|cdn\.jsdelivr\.net\/npm\/gsap|registerPlugin/)
    expect(html).toContain("'old-scene-7'")
    expect(html).toMatch(/DURATION\s*=\s*12\b/)
    expect(html).toMatch(/WIDTH\s*=\s*1080\b/)
    expect(html).toContain('window.__clock')
  })

  it('returns current HTML unchanged', () => {
    const current = generateSceneHTML(scene({ sceneCode: "window.__tl.add('#t', { opacity: [0, 1] }, 0)" }))
    expect(rebuildLegacySceneHtml(current)).toBe(current)
  })

  it('every export / publish / verify path that reads stored scene HTML rebuilds it first', () => {
    const root = path.resolve(__dirname, '../../..')
    for (const [file, pattern] of [
      // pixi (legacy) export: HTML handed in by the caller
      ['src/lib/export2/pixi-mp4.ts', /rebuildLegacySceneHtml\(config\.sceneHTML\)/],
      // Tier-2 bundle + publish copy the file from disk
      ['src/lib/storage/tier2-export.ts', /rebuildLegacySceneHtml\(await fs\.readFile/],
      ['src/electron/ipc/publish.ts', /rebuildLegacySceneHtml\(await fs\.readFile/],
      // dreambyte://scenes serves preview, verifier, tier-3 export and compositor scene frames
      ['src/electron/main.ts', /rebuildLegacySceneHtml\(await fs\.readFile\(filePath/],
    ] as const) {
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file).toMatch(pattern)
    }
  })
})
