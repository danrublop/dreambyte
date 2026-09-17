import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  EXPORT_FRAME_LOADER_URL,
  EXPORT_FRAME_SANDBOX,
  openSceneFrameBridge,
  withCaptureAgent,
} from './scene-frame-bridge'

const ROOT = path.resolve(__dirname, '../../..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('export scene frame isolation', () => {
  it("sandbox grants scripts + the frame's own origin only (no top navigation, popups, forms)", () => {
    expect(EXPORT_FRAME_SANDBOX.split(/\s+/).sort()).toEqual(['allow-same-origin', 'allow-scripts'])
    // allow-same-origin is only safe because the frame is a data: URL (opaque origin).
    expect(EXPORT_FRAME_LOADER_URL.startsWith('data:text/html')).toBe(true)
  })

  it('creates the iframe with that sandbox (and fails closed when the scene never readies)', async () => {
    let sandbox: string | null = null
    let frame: HTMLIFrameElement | null = null
    const append = document.body.appendChild.bind(document.body)
    document.body.appendChild = ((node: Node) => {
      if (node instanceof HTMLIFrameElement) {
        frame = node
        sandbox = node.getAttribute('sandbox')
      }
      return append(node)
    }) as typeof document.body.appendChild
    try {
      await expect(
        openSceneFrameBridge({
          html: '<html><head></head><body></body></html>',
          width: 8,
          height: 8,
          sceneType: 'motion',
          captureScale: 1,
          readyTimeoutMs: 20,
        }),
      ).rejects.toThrow(/ready timeout/)
    } finally {
      document.body.appendChild = append
    }
    expect(sandbox).toBe(EXPORT_FRAME_SANDBOX)
    expect(frame!.getAttribute('src')).toBe(EXPORT_FRAME_LOADER_URL)
    expect(frame!.hasAttribute('srcdoc')).toBe(false)
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('injects the capture agent before any scene script', () => {
    const html = withCaptureAgent(
      '<html><head><script>scene()</script></head><body></body></html>',
      10,
      10,
      'motion',
      1,
    )
    expect(html.indexOf('data-dreambyte-export-agent')).toBeLessThan(html.indexOf('scene()'))
  })

  it('no renderer/export source combines srcdoc / about:blank / blob: (inherit the app origin) with allow-same-origin', () => {
    const offenders = ['src/lib', 'src/components', 'src/app', 'src/electron', 'src/hooks']
      .map((d) => path.join(ROOT, d))
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => sourceFiles(d))
      .filter((f) => {
        // Code only: comments that explain the rule may name both.
        const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1')
        return /\bsrcdoc\b|about:blank/.test(src) && /allow-same-origin/.test(src)
      })
      .map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
    // The bridge's frame only ever loads the data: loader.
    const bridge = fs.readFileSync(path.join(ROOT, 'src/lib/export2/scene-frame-bridge.ts'), 'utf8')
    expect(bridge.match(/iframe\.(?:src|srcdoc)\s*=.*/g)).toEqual(['iframe.src = EXPORT_FRAME_LOADER_URL'])
    // The pixi exporter never reaches into the scene frame directly.
    const pixi = fs.readFileSync(path.join(ROOT, 'src/lib/export2/pixi-mp4.ts'), 'utf8')
    expect(pixi).not.toMatch(
      /['"`][^'"`\n]*allow-same-origin|\.contentDocument|\.contentWindow|createElement\(\s*'iframe'/,
    )
  })
})
