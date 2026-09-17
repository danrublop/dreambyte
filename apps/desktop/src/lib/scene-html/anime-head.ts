/**
 * Animation-runtime script tags injected into every scene HTML <head>.
 *
 * Scenes animate with anime.js v4 (MIT, vendored at public/vendor/animejs).
 * The head also sets `anime.engine.timeUnit = 's'`, so every duration, delay,
 * stagger and timeline position in scene code / SDKs is in SECONDS.
 *
 * ── Offline-proof editor preview ────────────────────────────────────────
 * The editor preview runs over the `dreambyte://` protocol with no internet
 * guarantee. A CDN-only <head> means `anime` is `undefined` when the playback
 * controller's IIFE runs offline, so NOTHING plays. The editor therefore loads
 * the LOCAL vendored copy first (served from public/vendor via the protocol)
 * and falls back to the CDN on a load error.
 *
 * Published embeds + Tier-2 exports are consumed OUTSIDE the app server, where
 * a `/vendor/*` path (resolved against the scene's <base>) 404s — so those
 * contexts keep CDN-first (with a second-CDN onerror fallback).
 * `rewriteAnimeForEmbed` converts the editor (local-first) form to the embed
 * (CDN-first) form; it runs alongside `stripErrorBeacon` in the publish +
 * Tier-2 pipelines.
 */

/** Pinned anime.js version (matches public/vendor/animejs/anime.umd.min.js). */
export const ANIME_VERSION = '4.5.0'

const FILE = 'anime.umd.min.js'
/** Local vendored path (served via the app protocol). */
const LOCAL = `/vendor/animejs/${FILE}`
/** Primary CDN. */
const CDN = `https://cdn.jsdelivr.net/npm/animejs@${ANIME_VERSION}/dist/bundles/${FILE}`
/** Secondary CDN (embed onerror fallback). */
const CDN2 = `https://unpkg.com/animejs@${ANIME_VERSION}/dist/bundles/${FILE}`

/**
 * The anime.js <script> tag. `localFirst` controls the order:
 *  - editor: src=local, onerror → CDN  (offline-proof in-app)
 *  - embed:  src=CDN,   onerror → CDN2 (no /vendor/ off the app server)
 * The onerror clears itself first so a second failure can't loop.
 */
function animeScript(localFirst: boolean): string {
  const primary = localFirst ? LOCAL : CDN
  const fallback = localFirst ? CDN : CDN2
  return `<script src="${primary}" onerror="this.onerror=null;this.src='${fallback}'"></script>`
}

function buildAnimeHead(localFirst: boolean): string {
  return `
  <!-- anime.js ${ANIME_VERSION} (MIT) -->
  ${animeScript(localFirst)}
  <script>if (window.anime && anime.engine) { anime.engine.timeUnit = 's'; }</script>
  <!-- Lottie-web for LottieFiles animations -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js"></script>
  <!-- DreambyteMotion component library -->
  <script src="/sdk/dreambyte-motion.js"></script>
  <!-- DreambyteCamera cinematic camera motion -->
  <script src="/sdk/dreambyte-camera.js"></script>
  <!-- DreambyteInteract interaction components -->
  <script src="/sdk/interaction-components.js"></script>
`
}

/**
 * Editor form (DEFAULT): local-vendor-first with a CDN onerror fallback.
 * Written to disk by generateSceneHTML; works offline in the editor preview and
 * in Tier-3 export (both load over `dreambyte://`, where /vendor/* resolves).
 */
export const ANIME_HEAD = buildAnimeHead(true)

/** Embed form: CDN-first with a second-CDN onerror fallback (no /vendor/ here). */
export const ANIME_HEAD_EMBED = buildAnimeHead(false)

/**
 * Rewrite already-generated editor HTML to the embed (CDN-first) anime.js tag.
 * Run by the publish + Tier-2 pipelines (next to stripErrorBeacon) because a
 * `/vendor/animejs/*` path 404s off the app server. Idempotent.
 */
export function rewriteAnimeForEmbed(html: string): string {
  return html.split(animeScript(true)).join(animeScript(false))
}
