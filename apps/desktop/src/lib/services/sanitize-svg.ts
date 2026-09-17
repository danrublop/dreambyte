/**
 * Strip XSS vectors from SVG markup before it lands on disk and is later
 * served same-origin (inside `<iframe srcdoc>` or referenced by `<img>`).
 *
 * Shared by the upload path (upload-asset.ts) and the direct-URL ingest path
 * (ingest.ts) so both stay in sync — the ingest route previously skipped this
 * and persisted active script content (stored XSS).
 *
 * Backed by DOMPurify. The previous hand-rolled regex only matched
 * literal `<script>`, `on*=`, and literal `javascript:` text, so it was
 * bypassable by SMIL (`<set attributeName="onload">`, `<animate>` driving a
 * `javascript:` href), entity/encoded URIs (`&#106;avascript:`), and
 * `<use>`/`<image href="data:…">`/`<style>` vectors. DOMPurify parses the
 * markup into a real DOM tree and drops anything outside its SVG allowlist,
 * closing all of those.
 *
 * This module runs in the Electron main process (no `window`), so DOMPurify
 * is bound to a jsdom-backed DOM. Both are runtime dependencies and ship
 * inside `app.asar`.
 */
import createDOMPurify, { type DOMPurify, type WindowLike } from 'dompurify'
import { JSDOM } from 'jsdom'

const XLINK_NS = 'http://www.w3.org/1999/xlink'

// One jsdom window + DOMPurify instance for the process. jsdom construction is
// non-trivial, so build it lazily on first use and reuse it for every call.
let purifier: DOMPurify | null = null

function getPurifier(): DOMPurify {
  if (!purifier) {
    const { window } = new JSDOM('')
    // jsdom's DOMWindow provides the DOM constructors DOMPurify needs at
    // runtime, but @types/jsdom's DOMWindow isn't structurally typed as the
    // WindowLike subset DOMPurify's factory declares, so cast across.
    const p = createDOMPurify(window as unknown as WindowLike)
    // <use> is an SSRF/XSS vector when its href points off-document
    // (external URL or data:), so DOMPurify's SVG profile drops <use>
    // wholesale by default. That also breaks legitimate sprite/symbol-reuse
    // SVGs (common Figma/Illustrator exports). Re-allow <use> (see ADD_TAGS
    // below) but drop any whose target isn't an internal `#id` fragment.
    p.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeName.toLowerCase() !== 'use') return
      // A <use> is allowed ONLY if it has at least one ref and EVERY present
      // href/xlink:href is an internal `#fragment`. This drops:
      //  - external/scheme refs (https:, //, etc.),
      //  - a safe href paired with an evil xlink:href (renderers disagree on
      //    precedence, so each attribute is checked independently),
      //  - a bare <use> whose disallowed-scheme href (data:/javascript:) was
      //    already stripped by DOMPurify's attribute filter — no legit ref left.
      const refs = [
        node.getAttribute('href'),
        node.getAttribute('xlink:href'),
        node.getAttributeNS(XLINK_NS, 'href'),
      ].filter((r): r is string => r != null)
      const allInternal = refs.length > 0 && refs.every((r) => r.startsWith('#'))
      if (!allInternal) node.remove()
    })
    purifier = p
  }
  return purifier
}

export function sanitizeSvg(svgText: string): string {
  return getPurifier().sanitize(svgText, {
    // SVG (+ filters) allowlist of tags/attributes. Everything else — scripts,
    // event handlers, HTML elements, unknown URI schemes — is removed by the
    // parser-level allowlist rather than by string matching.
    USE_PROFILES: { svg: true, svgFilters: true },
    // foreignObject can embed arbitrary HTML; keep it out even though the SVG
    // profile would otherwise permit it. The SMIL animation tags are forbidden
    // explicitly too: the SVG profile already drops them today, but an
    // <animate>/<set> can mutate a safe `<use href="#x">` into an external/data
    // target AFTER the afterSanitizeAttributes hook runs, so a future profile or
    // DOMPurify-default change must not silently re-enable them (Codex review,
    // defense-in-depth). Only the tags are forbidden — their attrs (values/from/
    // to) overlap with legitimate filter primitives like feColorMatrix.
    FORBID_TAGS: ['foreignObject', 'set', 'animate', 'animateMotion', 'animateTransform', 'mpath'],
    // Re-allow <use>; the afterSanitizeAttributes hook in getPurifier()
    // restricts it to internal `#id` fragment refs (no external/data targets).
    ADD_TAGS: ['use'],
  })
}
