/**
 * Content-Security-Policy for scene documents.
 *
 * Scenes are served from the privileged `dreambyte://` scheme with
 * `Access-Control-Allow-Origin: *` and run model-authored (and, on import,
 * partly attacker-supplied) JavaScript. With no CSP, a scene's `fetch`/XHR/
 * WebSocket could POST timeline/project data to any host — silent, persistent
 * exfiltration that re-runs on every view and export.
 *
 * The load-bearing restriction is `connect-src`: it caps where a scene may open
 * network connections. We allowlist only:
 *   - `'self'` / `dreambyte:` — the scene's own user-data mounts (audio, uploads,
 *     generated AI media) which are served from the dreambyte:// scheme.
 *   - `data:` / `blob:` — inline/object-URL resources scenes build locally.
 *   - the asset CDNs the bundled SDK + templates legitimately fetch from at
 *     runtime (Three.js GLTFLoader pulls avatar `.glb`s from jsDelivr; lottie
 *     pulls JSON from lottie.host; D3/Plotly/etc. modules import from esm.sh /
 *     unpkg / cdnjs). Without these, avatars / lottie / 3D scenes break.
 * An attacker host (e.g. `https://evil.example/collect`) is NOT in the list, so
 * the exfiltration POST is blocked while every legitimate asset load keeps working.
 *
 * `script-src` stays permissive (`https:` + inline + eval): scene code is, by
 * product design, arbitrary author-supplied JS that loads libraries from many
 * CDNs and uses eval (Babel JSX transform, Three.js shader compile). Locking
 * script origins would break rendering and is NOT the exfiltration vector this
 * policy targets — `connect-src` is. `img-/media-/font-src` are widened to the
 * real asset origins (data/blob/dreambyte/https) so images, video, and webfonts
 * keep loading. `default-src 'none'` denies everything not explicitly granted
 * (notably no `frame-src`/`object-src`, so a scene can't embed an attacker page).
 *
 * NOT applied to published embeds: those are an explicitly web-only surface the
 * user chose to host on their own page, with a different (third-party-parent)
 * threat model — the publish path strips this meta, like the error beacon.
 */

/** CDN origins the bundled SDK + scene templates fetch assets from at runtime. */
const SCENE_ASSET_CDNS = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://esm.sh',
  'https://cdnjs.cloudflare.com',
  'https://cdn.plot.ly',
  'https://lottie.host',
  // Troika 3D-text fetches its font woff2 via fetch() (connect-src, not font-src);
  // the SDK + prompts steer scenes to fonts.gstatic.com URLs (review finding #7).
  'https://fonts.gstatic.com',
] as const

/**
 * The CSP applied to every scene document, as a single header/meta value.
 * Exported as a constant so the dreambyte:// response header (src/electron/main.ts)
 * and the in-HTML `<meta http-equiv>` mirror (src/lib/sceneTemplate.ts, which covers
 * the export `srcdoc` path that gets no response headers) stay identical.
 */
export const SCENE_CSP = [
  `default-src 'none'`,
  // Author-supplied scene scripts + CDN libraries; eval for Babel/Three.
  `script-src 'unsafe-inline' 'unsafe-eval' https: dreambyte: blob:`,
  `style-src 'unsafe-inline' https: dreambyte:`,
  `img-src 'self' data: blob: dreambyte: https:`,
  `media-src 'self' data: blob: dreambyte: https:`,
  `font-src 'self' data: dreambyte: https:`,
  // THE key restriction: scenes may only fetch/XHR/WS to their own mounts and
  // the known asset CDNs — never to an arbitrary attacker host.
  `connect-src 'self' dreambyte: data: blob: ${SCENE_ASSET_CDNS.join(' ')}`,
  // Worker/module blobs are used by some renderers.
  `worker-src 'self' blob: dreambyte:`,
  `child-src 'self' blob: dreambyte:`,
].join('; ')

/** The full `<meta http-equiv="Content-Security-Policy">` tag for scene HTML. */
export const SCENE_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SCENE_CSP}">`

/**
 * Matches the marked scene-CSP meta tag (writeSceneHTML stamps it with the
 * `data-dreambyte-csp` attribute). Used by the publish pipeline to strip the
 * desktop CSP from web-only published embeds, which have their own threat model.
 */
const SCENE_CSP_META_RE = /<meta\s+data-dreambyte-csp\b[^>]*>\s*/i

/** Remove the desktop scene-CSP meta from HTML (publish path only). */
export function stripSceneCsp(html: string): string {
  return html.replace(SCENE_CSP_META_RE, '')
}
