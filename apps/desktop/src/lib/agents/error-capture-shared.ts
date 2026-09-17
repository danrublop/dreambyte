/**
 * Shared scene error-capture contract.
 *
 * THREE catchers observe scene runtime errors and must agree on what counts
 * as an error and its shape:
 *   1. The offscreen verifier preload (src/electron/verifier-preload.ts) — runs
 *      at write-time verification. MUST stay self-contained (its window has
 *      no module system), so it does NOT import this module; the
 *      error-capture parity test pins that its behavior matches
 *      (test-enforced parity instead of an import the preload build can't
 *      guarantee to inline).
 *   2. The in-scene beacon (this module's buildErrorCaptureScript, inlined
 *      into every scene's <head> by sceneTemplate) — catches PLAYBACK-time
 *      errors the write-time verifier never sees (lazy asset 404s,
 *      mid-animation throws) and posts them to the preview host.
 *   3. The React error boundary's dreambyte-jsx-error postMessage
 *      (sceneTemplate) — pre-existing channel, normalized into the same
 *      pipe by the preview host (dedupe, not a fourth channel).
 *
 * Flow: beacon postMessage → PreviewPlayer message handler → IPC
 * `dreambyte:sceneErrors.report` → main-process ring buffer
 * (src/lib/agents/scene-error-buffer.ts) → read by verify_scene reports and the
 * runner's context refresh, so the agent finally SEES broken playback.
 */

/** One captured scene runtime error — the cross-catcher shape. */
export interface SceneRuntimeError {
  kind: 'syntax' | 'runtime' | 'rejection' | 'jsx'
  message: string
  line?: number
  source?: string
  /** Capture timestamp (ms). */
  at: number
}

/** postMessage type the beacon emits (the jsx boundary keeps its legacy type;
 *  the preview host normalizes both into the same IPC report). */
export const SCENE_ERROR_MESSAGE_TYPE = 'dreambyte-runtime-error'

/** Beacon rate limit: max errors posted per scene load (an error
 *  thrown inside requestAnimationFrame fires every frame; without the cap a
 *  broken scene floods postMessage/IPC at 60Hz). */
export const MAX_BEACON_ERRORS_PER_LOAD = 10

/** Syntax-vs-runtime classification — KEPT IDENTICAL to the verifier
 *  preload's regex (parity-tested). */
export const SYNTAX_ERROR_PATTERN = 'SyntaxError|Unexpected token|Unexpected identifier'

/**
 * The inline <script> body injected into every scene's <head>, BEFORE any
 * scene code runs. Self-contained ES5 (scene HTML targets a plain webview,
 * no bundler). Mirrors verifier-preload semantics: error event (capturing
 * phase) + unhandledrejection, same syntax classification, line/source
 * passthrough.
 */
export function buildErrorCaptureScript(sceneId: string): string {
  // sceneId is interpolated into a single-quoted JS string — escape it.
  const safeId = sceneId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `
(function () {
  var posted = 0;
  var MAX = ${MAX_BEACON_ERRORS_PER_LOAD};
  var SYNTAX = new RegExp('${SYNTAX_ERROR_PATTERN}');
  function post(kind, message, line, source) {
    if (posted >= MAX) return;
    posted++;
    try {
      window.parent.postMessage({
        source: 'dreambyte-scene',
        type: '${SCENE_ERROR_MESSAGE_TYPE}',
        sceneId: '${safeId}',
        error: {
          kind: kind,
          message: String(message || 'Unknown script error'),
          line: typeof line === 'number' ? line : undefined,
          source: typeof source === 'string' ? source : undefined,
          at: Date.now()
        }
      }, '*');
    } catch (e) { /* parent gone — nothing to report to */ }
  }
  window.addEventListener('error', function (event) {
    var msg = (event && event.message) || '';
    post(SYNTAX.test(msg) ? 'syntax' : 'runtime', msg, event && event.lineno, event && event.filename);
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = (event && event.reason) || {};
    post('rejection', reason.message || String((event && event.reason) || 'Unhandled rejection'));
  });
  // Hook for IN-SCENE reporters (the React template's JSX-transpile catch).
  // Routing through post() gives them the same rate limit AND the same strip
  // point: published embeds remove this beacon <script>, so the hook is
  // absent and in-scene reporters silently no-op instead of posting error
  // text to the third-party host page via '*' (R2 jsx-channel residual).
  window.__dreambyteReportSceneError = post;
})();`
}

/**
 * R1: bind an error report to the POSTING frame. The claimed sceneId in the
 * message payload is forgeable — any same-origin frame can post any id — so
 * the renderer accepts a report only when the claimed scene's iframe is the
 * window that actually posted the message (`MessageEvent.source`). Pure so
 * the contract is table-testable without rendering PreviewPlayer.
 */
export function isErrorReportBoundToFrame(
  claimedSceneId: unknown,
  source: unknown,
  getFrame: (sceneId: string) => { contentWindow: unknown } | null | undefined,
): boolean {
  if (typeof claimedSceneId !== 'string' || claimedSceneId.length === 0) return false
  const frame = getFrame(claimedSceneId)
  if (!frame?.contentWindow) return false
  return source === frame.contentWindow
}

/** Attribute marking the injected beacon <script> tag (set by writeSceneHTML's
 *  universal head injection) so non-editor consumers can strip it. */
export const ERROR_BEACON_SCRIPT_ATTR = 'data-dreambyte-error-beacon'

// Single-shot (NO global flag — security): writeSceneHTML
// injects the beacon immediately after <head>, so the FIRST match is always
// the real beacon. A global match would let agent-authored scene code that
// embeds the literal marker text trigger a second lazy match that swallows
// legitimate content up to the next </script> (self-corrupting the published
// scene). First-match-only caps the blast radius at exactly the injected tag.
const ERROR_BEACON_SCRIPT_RE = new RegExp(`\\s*<script ${ERROR_BEACON_SCRIPT_ATTR}>[\\s\\S]*?</script>`)

// Pre-marker migration: scene HTML written BEFORE the
// marker attribute existed carries the same beacon in a PLAIN <script> tag —
// the marker regex can't see it, so old files published (or already-published
// bundles) kept broadcasting. Match the legacy beacon STRUCTURALLY instead:
// the distinctive IIFE prefix, both listener registrations in template order,
// then the closing `})();` before </script>. The structure pins the match to
// the generated beacon across naming eras (the message-type literal is NOT
// pinned, so pre-rename 'cench-*' beacons match too). First-match-only and
// every anchor must appear in order — agent scene code would have to
// reproduce the beacon's exact skeleton inside one script tag to be touched.
const LEGACY_ERROR_BEACON_SCRIPT_RE = new RegExp(
  `\\s*<script>\\s*` +
    `\\(function \\(\\) \\{\\s*var posted = 0;` +
    `[\\s\\S]*?window\\.addEventListener\\('error',` +
    `[\\s\\S]*?window\\.addEventListener\\('unhandledrejection',` +
    `[\\s\\S]*?\\}\\)\\(\\);\\s*</script>`,
)

// Legacy direct jsx-error post (the template now routes it through the beacon
// hook): old scene HTML still carries
// the inline `window.parent.postMessage({... type: '(dreambyte|cench)-jsx-error'
// ...}, '*')` statement inside the JSX-transpile catch. Strip the single
// statement (not the whole script — it's inline in the bootstrap), covering
// both naming eras.
const LEGACY_JSX_ERROR_POST_RE =
  /window\.parent\.postMessage\(\{\s*source:\s*'(?:dreambyte|cench)-scene',\s*type:\s*'(?:dreambyte|cench)-jsx-error'[\s\S]*?\},\s*'\*'\);?/

/**
 * Remove the error beacon from scene HTML bound for a PUBLISHED embed (R2).
 * In the editor the parent window is ours; in an embed the parent is the
 * third-party host page, and the beacon's postMessage('*') would broadcast
 * scene error strings (messages, line numbers) to it unsolicited. The beacon
 * body never contains a literal "</script>", so the lazy match is safe.
 *
 * Covers three generations of leak (each first-match-only):
 *   1. the marked beacon (current writeSceneHTML output)
 *   2. the legacy UNMARKED beacon (pre-marker scene HTML / published bundles)
 *   3. the legacy direct jsx-error postMessage('*') statement
 */
export function stripErrorBeacon(html: string): string {
  return html
    .replace(ERROR_BEACON_SCRIPT_RE, '')
    .replace(LEGACY_ERROR_BEACON_SCRIPT_RE, '')
    .replace(LEGACY_JSX_ERROR_POST_RE, '')
}
