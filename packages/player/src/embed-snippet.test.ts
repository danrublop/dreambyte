// @vitest-environment jsdom
/**
 * Smoke test for the publish script embed: builds the real player IIFE with
 * vite, then runs the snippet PublishPanel hands out against a published
 * bundle (manifest.json + scene HTML served from /published/<id>/) and checks
 * the first scene lands in the player iframe.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import { buildScriptEmbedSnippet } from '@/components/PublishPanel'

const PROJECT_ID = '0b7e3c9a-2f41-4d8e-9c1a-5e6f7a8b9c0d'
const SCENE_ID = '6a1f2e3d-4c5b-4a69-8877-665544332211'

let outDir: string
let playerJs: string

beforeAll(async () => {
  outDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-player-'))
  await build({
    configFile: path.resolve(__dirname, '..', 'vite.config.ts'),
    root: path.resolve(__dirname, '..'),
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
  })
  playerJs = readFileSync(path.join(outDir, 'dreambyte-player.iife.js'), 'utf8')
}, 60_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

describe('publish script embed', () => {
  it('loads a published project with player.js from the bundle', async () => {
    const base = `/published/${PROJECT_ID}`
    const manifest = {
      id: PROJECT_ID,
      version: 1,
      name: 'Embed smoke',
      playerOptions: {},
      sceneGraph: { nodes: [{ id: SCENE_ID, position: { x: 0, y: 0 } }], edges: [], startSceneId: SCENE_ID },
      scenes: [
        {
          id: SCENE_ID,
          type: 'motion',
          duration: 3,
          htmlUrl: `${base}/scenes/${SCENE_ID}.html`,
          htmlContent: null,
          interactions: [],
          variables: [],
          transition: 'none',
        },
      ],
    }
    const served: Record<string, string> = {
      [`${base}/manifest.json`]: JSON.stringify(manifest),
      [`${base}/scenes/${SCENE_ID}.html`]: '<html><body><h1 id="smoke">published scene</h1></body></html>',
    }
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url)
      const body = served[url]
      return new Response(body ?? 'not found', { status: body ? 200 : 404 })
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )

    // jsdom has no HTMLIFrameElement.sandbox token list.
    if (!('sandbox' in HTMLIFrameElement.prototype)) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
        configurable: true,
        get(this: HTMLIFrameElement) {
          return { add: (...tokens: string[]) => this.setAttribute('sandbox', tokens.join(' ')) }
        },
      })
    }

    const snippet = buildScriptEmbedSnippet(`/published/${PROJECT_ID}/`)
    const scripts = [...snippet.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts[0][1]).toContain(`src="${base}/player.js"`)
    document.body.innerHTML = snippet.replace(/<script[\s\S]*?<\/script>/g, '')

    // Execute the scripts in document order, as a browser would.
    window.eval(playerJs)
    window.eval(scripts[1][2])

    await vi.waitFor(() => {
      const iframe = document.querySelector('#dreambyte-player iframe') as HTMLIFrameElement | null
      expect(iframe?.srcdoc).toContain('published scene')
    })
    expect(fetched).toEqual([`${base}/manifest.json`, `${base}/scenes/${SCENE_ID}.html`])
    vi.unstubAllGlobals()
  })
})
