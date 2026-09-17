/**
 * Unified text-slot model for scene source code.
 *
 * Dreambyte scenes render text through many different code shapes:
 *   - React JSX:   <h1>...</h1>, <p>...</p>, <button>, <li>, <div>, <span>
 *   - SVG markup:  <text>...</text> (inside React or raw svgContent)
 *   - Canvas 2D:   ctx.fillText('...', ...) / ctx.strokeText('...', ...)
 *   - Three.js:    new TextGeometry('...', ...)
 *
 * `src/lib/react-extract.ts` already locates these for the layer-stack listing,
 * but its edit path is plain-string find/replace on inner text only — which
 * is ambiguous when text repeats, and can't touch typography (size, weight,
 * color, line-height, letter-spacing).
 *
 * This module exposes a single shape that carries both the visible text AND
 * the parent element's inline style, plus atomic edits that rewrite the
 * source code in place. It anchors edits on the full element source (not
 * just the inner text), so repeated text doesn't collide.
 */

/**
 * Pick the source field that the scene renderer actually reads. Editing
 * the wrong one (e.g. `reactCode` on a `motion` scene) silently fails to
 * update the preview. The layer stack and the typography editor MUST agree
 * on this — they're routed by rx index and would otherwise disagree on
 * which field's text is being indexed.
 *
 * Lives here (not in src/lib/types.ts) to keep the typing module free of
 * scene-rendering knowledge.
 */
export function pickSceneCodeField(scene: {
  sceneType?: string
  reactCode?: string
  sceneCode?: string
  canvasCode?: string
  svgContent?: string
  sceneHTML?: string
}): 'reactCode' | 'sceneCode' | 'canvasCode' | 'svgContent' | 'sceneHTML' | null {
  const has = (v: string | undefined) => !!(v && v.trim())
  switch (scene.sceneType) {
    case 'react':
      if (has(scene.reactCode)) return 'reactCode'
      if (has(scene.sceneCode)) return 'sceneCode'
      return null
    case 'canvas2d':
      return has(scene.canvasCode) ? 'canvasCode' : null
    case 'svg':
    case 'lottie':
      return has(scene.svgContent) ? 'svgContent' : null
    case 'motion':
    case 'd3':
    case 'three':
    case 'zdog':
    case '3d_world':
    case 'avatar_scene':
      return has(scene.sceneCode) ? 'sceneCode' : null
    default:
      if (has(scene.reactCode)) return 'reactCode'
      if (has(scene.sceneCode)) return 'sceneCode'
      if (has(scene.canvasCode)) return 'canvasCode'
      if (has(scene.svgContent)) return 'svgContent'
      if (has(scene.sceneHTML)) return 'sceneHTML'
      return null
  }
}

export type CodeTextSlotKind =
  | 'jsx-heading'
  | 'jsx-paragraph'
  | 'jsx-button'
  | 'jsx-li'
  | 'jsx-div'
  | 'jsx-span'
  | 'svg-text'
  | 'canvas-text'
  | 'three-text'

export interface TextSlotStyle {
  fontFamily?: string
  fontSize?: number | string
  fontWeight?: number | string
  fontStyle?: string
  color?: string
  lineHeight?: number | string
  letterSpacing?: number | string
  textAlign?: string
}

/**
 * Single source of truth for typography props the editor handles.
 *
 * Descriptor pattern: one
 * row per property, every site that needs to parse/format/route the prop
 * iterates this list. Adding a new prop (e.g. textTransform) is a one-line
 * change here that propagates to JSX-style parsing/writing, SVG-attr
 * parsing/writing, and the live-apply CSS payload.
 *
 * - `key`        : matches TextSlotStyle field
 * - `svgAttr`    : SVG element attribute name; null = this prop has no SVG
 *                  attribute counterpart (e.g. lineHeight)
 * - `altSvgAttrs`: camelCase variants we should also recognize when reading
 * - `cssUnit`    : default unit appended when serializing a bare number to
 *                  CSS (e.g. fontSize: 168 → '168px')
 * - `isNumeric`  : value is typically a number; controls quoting in JSX
 *                  output and px-parsing in SVG-attr input
 */
export interface TypographyPropDescriptor {
  key: keyof TextSlotStyle
  svgAttr: string | null
  altSvgAttrs: readonly string[]
  cssUnit: '' | 'px'
  isNumeric: boolean
}

export const TYPOGRAPHY_PROPS: readonly TypographyPropDescriptor[] = [
  { key: 'fontFamily', svgAttr: 'font-family', altSvgAttrs: ['fontFamily'], cssUnit: '', isNumeric: false },
  { key: 'fontSize', svgAttr: 'font-size', altSvgAttrs: ['fontSize'], cssUnit: 'px', isNumeric: true },
  { key: 'fontWeight', svgAttr: 'font-weight', altSvgAttrs: ['fontWeight'], cssUnit: '', isNumeric: true },
  { key: 'fontStyle', svgAttr: 'font-style', altSvgAttrs: ['fontStyle'], cssUnit: '', isNumeric: false },
  { key: 'color', svgAttr: 'fill', altSvgAttrs: [], cssUnit: '', isNumeric: false },
  { key: 'lineHeight', svgAttr: null, altSvgAttrs: [], cssUnit: '', isNumeric: true },
  { key: 'letterSpacing', svgAttr: 'letter-spacing', altSvgAttrs: ['letterSpacing'], cssUnit: 'px', isNumeric: true },
  { key: 'textAlign', svgAttr: 'text-anchor', altSvgAttrs: ['textAnchor'], cssUnit: '', isNumeric: false },
] as const

const DESCRIPTOR_BY_KEY: Record<string, TypographyPropDescriptor> = (() => {
  const m: Record<string, TypographyPropDescriptor> = {}
  for (const d of TYPOGRAPHY_PROPS) m[d.key] = d
  return m
})()

export interface CodeTextSlot {
  kind: CodeTextSlotKind
  /** Ordinal among same-kind slots in source order (stable resolver). */
  index: number
  /** The text the user sees. */
  text: string
  /** Suitable for a layer-stack row. */
  label: string
  /** Inline style parsed from style={{...}} or SVG attributes. */
  style: TextSlotStyle
  /** Whole element source, used as the find anchor. */
  source: string
  /** Start offset of `source` in the original code. */
  start: number
}

const HEADING_RE = /<(h[1-6])\b([^>]*)>([^<]{1,80})<\/\1>/g
const PARAGRAPH_RE = /<p\b([^>]*)>([^<]{1,240})<\/p>/g
const BUTTON_RE = /<button\b([^>]*)>([^<]{1,200})<\/button>/g
const LI_RE = /<li\b([^>]*)>([^<]{1,200})<\/li>/g
const DIV_SPAN_RE = /<(div|span)\b([^>]*)>\s*([^<{}\n][^<{}]{0,239})\s*<\/\1>/g
const SVG_TEXT_RE = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi
const CANVAS_TEXT_RE = /\.(?:fill|stroke)Text\s*\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/g
const THREE_TEXT_RE = /new\s+(?:THREE\.)?TextGeometry\s*\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/g

export function extractCodeTextSlots(code: string | undefined | null): CodeTextSlot[] {
  if (!code?.trim()) return []
  const slots: CodeTextSlot[] = []
  const counters = new Map<CodeTextSlotKind, number>()
  const nextIndex = (k: CodeTextSlotKind) => {
    const i = counters.get(k) ?? 0
    counters.set(k, i + 1)
    return i
  }
  const pushIfNonEmpty = (slot: Omit<CodeTextSlot, 'index'> & { kind: CodeTextSlotKind }) => {
    if (!slot.text.trim()) return
    slots.push({ ...slot, index: nextIndex(slot.kind) })
  }

  for (const m of code.matchAll(HEADING_RE)) {
    const attrs = m[2] ?? ''
    const text = (m[3] ?? '').trim()
    pushIfNonEmpty({
      kind: 'jsx-heading',
      text,
      label: `${m[1].toUpperCase()}: ${text.slice(0, 40)}`,
      style: parseJsxStyle(attrs),
      source: m[0],
      start: m.index ?? 0,
    })
  }
  for (const m of code.matchAll(PARAGRAPH_RE)) {
    const attrs = m[1] ?? ''
    const text = (m[2] ?? '').trim()
    pushIfNonEmpty({
      kind: 'jsx-paragraph',
      text,
      label: text.slice(0, 40) + (text.length > 40 ? '…' : ''),
      style: parseJsxStyle(attrs),
      source: m[0],
      start: m.index ?? 0,
    })
  }
  for (const m of code.matchAll(BUTTON_RE)) {
    const attrs = m[1] ?? ''
    const text = (m[2] ?? '').trim()
    pushIfNonEmpty({
      kind: 'jsx-button',
      text,
      label: `Button: ${text.slice(0, 32)}`,
      style: parseJsxStyle(attrs),
      source: m[0],
      start: m.index ?? 0,
    })
  }
  for (const m of code.matchAll(LI_RE)) {
    const attrs = m[1] ?? ''
    const text = (m[2] ?? '').trim()
    pushIfNonEmpty({
      kind: 'jsx-li',
      text,
      label: `Item: ${text.slice(0, 36)}`,
      style: parseJsxStyle(attrs),
      source: m[0],
      start: m.index ?? 0,
    })
  }
  for (const m of code.matchAll(DIV_SPAN_RE)) {
    const tag = m[1] as 'div' | 'span'
    const attrs = m[2] ?? ''
    const text = (m[3] ?? '').trim()
    if (!/[A-Za-z0-9]/.test(text)) continue
    pushIfNonEmpty({
      kind: tag === 'div' ? 'jsx-div' : 'jsx-span',
      text,
      label: text.slice(0, 60) + (text.length > 60 ? '…' : ''),
      style: parseJsxStyle(attrs),
      source: m[0],
      start: m.index ?? 0,
    })
  }
  for (const m of code.matchAll(SVG_TEXT_RE)) {
    const attrs = m[1] ?? ''
    const inner = (m[2] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    pushIfNonEmpty({
      kind: 'svg-text',
      text: inner,
      label: inner.slice(0, 60) + (inner.length > 60 ? '…' : ''),
      style: parseSvgTextStyle(attrs),
      source: m[0],
      start: m.index ?? 0,
    })
  }
  for (const m of code.matchAll(CANVAS_TEXT_RE)) {
    const text = (m[2] ?? '').replace(/\\(.)/g, '$1').trim()
    if (!text) continue
    slots.push({
      kind: 'canvas-text',
      index: nextIndex('canvas-text'),
      text,
      label: text.slice(0, 60) + (text.length > 60 ? '…' : ''),
      style: {},
      source: m[0],
      start: m.index ?? 0,
    })
  }
  for (const m of code.matchAll(THREE_TEXT_RE)) {
    const text = (m[2] ?? '').replace(/\\(.)/g, '$1').trim()
    if (!text) continue
    slots.push({
      kind: 'three-text',
      index: nextIndex('three-text'),
      text,
      label: text.slice(0, 60) + (text.length > 60 ? '…' : ''),
      style: {},
      source: m[0],
      start: m.index ?? 0,
    })
  }

  slots.sort((a, b) => a.start - b.start)
  // After sort the per-kind `index` no longer reflects source order, so
  // recompute by walking the sorted list.
  const recount = new Map<CodeTextSlotKind, number>()
  for (const s of slots) {
    const i = recount.get(s.kind) ?? 0
    s.index = i
    recount.set(s.kind, i + 1)
  }
  return slots
}

// ── Style parsers ───────────────────────────────────────────────────────────

const STYLE_KEYS = new Set([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'color',
  'lineHeight',
  'letterSpacing',
  'textAlign',
])

function parseJsxStyle(attrs: string): TextSlotStyle {
  const out: TextSlotStyle = {}
  // Look for style={{ ... }} — non-greedy, single line.
  const m = attrs.match(/style\s*=\s*\{\{([\s\S]*?)\}\}/)
  if (!m) return out
  const body = m[1]
  // Walk key: value pairs (split on commas not inside strings).
  const pairs = splitTopLevel(body, ',')
  for (const p of pairs) {
    const colon = indexOfTopLevel(p, ':')
    if (colon < 0) continue
    const key = p.slice(0, colon).trim()
    const rawValue = p.slice(colon + 1).trim()
    if (!STYLE_KEYS.has(key)) continue
    const parsed = parseJsxStyleValue(rawValue)
    if (parsed === null) continue
    ;(out as Record<string, string | number>)[key] = parsed
  }
  return out
}

function parseJsxStyleValue(raw: string): string | number | null {
  if (!raw) return null
  // Strip trailing commas / whitespace
  const v = raw.replace(/,+\s*$/, '').trim()
  if (!v) return null
  // String literal "…" or '…'
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  // Numeric literal (possibly negative, decimal)
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return parseFloat(v)
  // Template literal `…` — keep as string if no interpolation
  if (v.startsWith('`') && v.endsWith('`') && !v.includes('${')) {
    return v.slice(1, -1)
  }
  // Anything else (expressions, variable refs) — skip
  return null
}

function parseSvgTextStyle(attrs: string): TextSlotStyle {
  const out: TextSlotStyle = {}
  const grab = (name: string): string | undefined => {
    const m = attrs.match(new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*["']([^"']*)["']`, 'i'))
    return m?.[1]
  }
  for (const d of TYPOGRAPHY_PROPS) {
    if (!d.svgAttr) continue
    let raw = grab(d.svgAttr)
    if (raw == null) {
      for (const alt of d.altSvgAttrs) {
        raw = grab(alt)
        if (raw != null) break
      }
    }
    if (raw == null || raw === '') continue
    if (d.isNumeric && /^-?\d+(?:\.\d+)?$/.test(raw)) {
      ;(out as Record<string, string | number>)[d.key] = parseFloat(raw)
    } else {
      ;(out as Record<string, string | number>)[d.key] = raw
    }
  }
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Mixed-content text-node edits ───────────────────────────────────────────

/**
 * Rewrite a single text run inside a mixed-content JSX element WITHOUT
 * touching sibling elements.
 *
 * Mixed-content elements (e.g. `<h1>Hi <em>there</em>!</h1>`) are
 * intentionally skipped by extractCodeTextSlots because the regex
 * extractors anchor on `[^<]` inner. The iframe, however, enumerates
 * each non-whitespace text-node child as its own sub-slot (`:tN`) so
 * the typography panel can target and live-apply each text run. Style
 * edits already inherit through the parent element. Text edits used to
 * mutate only the iframe DOM and never reach the source.
 *
 * This is the primitive future versions will call from the live_apply
 * pipeline when a text-node sub-slot edit commits: hand it the run the
 * iframe reported as the original textContent and the new value, and it
 * locates the unique source occurrence between JSX tag boundaries and
 * rewrites only that span.
 *
 * Conservative on purpose:
 *   - Requires the original run to appear exactly once in code wrapped
 *     by `>...<` or `>...{` boundaries (so JSX expressions don't get
 *     clobbered). Returns null if zero or multiple matches.
 *   - Skips runs that contain `{` or `}` (mixed text + expression).
 *   - Returns null if the original is empty or whitespace-only.
 *
 * The caller is responsible for not invoking this when the simple
 * pure-text path (updateSlotText) already handles the slot.
 */
export function updateMixedContentText(code: string, originalText: string, newText: string): string | null {
  const trimmed = originalText.trim()
  if (!trimmed) return null
  if (/[{}]/.test(trimmed)) return null

  // The run sits between an opening tag's `>` (with optional whitespace)
  // and the next tag boundary (`<`) or JSX expression start (`{`). Match
  // the exact trimmed text; allow surrounding whitespace in source so
  // pretty-printed JSX still works.
  const esc = escapeRegex(trimmed)
  const re = new RegExp(`(>\\s*)${esc}(\\s*[<{])`, 'g')

  const matches: Array<{ index: number; length: number; prefix: string; suffix: string }> = []
  for (const m of code.matchAll(re)) {
    if (m.index == null) continue
    matches.push({
      index: m.index,
      length: m[0].length,
      prefix: m[1],
      suffix: m[2],
    })
  }
  if (matches.length !== 1) return null

  const { index, length, prefix, suffix } = matches[0]
  const safe = escapeForJsxText(newText)
  const replacement = `${prefix}${safe}${suffix}`
  return code.slice(0, index) + replacement + code.slice(index + length)
}

// ── Edits ───────────────────────────────────────────────────────────────────

/**
 * Resolve a fresh slot from current code by kind+index. Returns null if the
 * slot is gone (e.g. user retyped removing the element).
 */
export function resolveSlot(code: string, kind: CodeTextSlotKind, index: number): CodeTextSlot | null {
  const slots = extractCodeTextSlots(code).filter((s) => s.kind === kind)
  return slots[index] ?? null
}

/** Rewrite the inner text of a slot. Anchors on the slot's full source. */
export function updateSlotText(code: string, slot: CodeTextSlot, newText: string): string | null {
  const rewritten = rewriteTextInSource(slot.kind, slot.source, newText)
  if (rewritten === null) return null
  return replaceFirstOccurrence(code, slot.source, rewritten, slot.start)
}

/**
 * Set or update a single typography property on the slot's parent element.
 * For JSX kinds: edits `style={{...}}` (inserts the prop if missing; injects
 * a `style={{}}` block on the opening tag if there is none).
 * For SVG `<text>`: edits attributes (font-family / font-size / fill).
 * Canvas and Three.js text slots return the original code unchanged because
 * their styles aren't local to the call site.
 */
export function updateSlotStyleProp(
  code: string,
  slot: CodeTextSlot,
  prop: keyof TextSlotStyle,
  value: string | number | null,
): string | null {
  if (slot.kind === 'canvas-text' || slot.kind === 'three-text') return null

  if (slot.kind === 'svg-text') {
    const next = setSvgTextAttr(slot.source, prop, value)
    if (next === null) return null
    return replaceFirstOccurrence(code, slot.source, next, slot.start)
  }
  // JSX kinds
  const next = setJsxStyleProp(slot.source, prop, value)
  if (next === null) return null
  return replaceFirstOccurrence(code, slot.source, next, slot.start)
}

function rewriteTextInSource(kind: CodeTextSlotKind, source: string, newText: string): string | null {
  const safe = escapeForJsxText(newText)
  if (kind === 'jsx-heading') {
    return source.replace(/^(<(h[1-6])\b[^>]*>)([^<]*)(<\/\2>)$/, `$1${safe}$4`)
  }
  if (kind === 'jsx-paragraph') {
    return source.replace(/^(<p\b[^>]*>)([^<]*)(<\/p>)$/, `$1${safe}$3`)
  }
  if (kind === 'jsx-button') {
    return source.replace(/^(<button\b[^>]*>)([^<]*)(<\/button>)$/, `$1${safe}$3`)
  }
  if (kind === 'jsx-li') {
    return source.replace(/^(<li\b[^>]*>)([^<]*)(<\/li>)$/, `$1${safe}$3`)
  }
  if (kind === 'jsx-div' || kind === 'jsx-span') {
    const tag = kind === 'jsx-div' ? 'div' : 'span'
    return source.replace(new RegExp(`^(<${tag}\\b[^>]*>)\\s*([^<{}]*?)\\s*(<\\/${tag}>)$`), `$1${safe}$3`)
  }
  if (kind === 'svg-text') {
    // Preserve attributes and any child structure (tspan/animate/etc.). When
    // the inner is pure plain text, replace it wholesale. When it contains
    // child tags or JSX expressions, replace ONLY the leading run of plain
    // text before the first child so the children survive the edit — the prior
    // version replaced the entire inner in both branches, silently destroying
    // tspans and animations. If there is no leading plain-text run, leave the
    // source unchanged rather than clobber the children.
    return source.replace(/^(<text\b[^>]*>)([\s\S]*?)(<\/text>)$/i, (_, open, inner, close) => {
      if (!/[<{]/.test(inner)) return `${open}${escapeForXmlText(newText)}${close}`
      const lead = inner.match(/^[^<{]*/)?.[0] ?? ''
      if (lead.trim() === '') return `${open}${inner}${close}`
      return `${open}${escapeForXmlText(newText)}${inner.slice(lead.length)}${close}`
    })
  }
  if (kind === 'canvas-text') {
    return source.replace(
      /^(\.(?:fill|stroke)Text\s*\(\s*)(["'`])(?:\\.|(?!\2).)*?\2/,
      `$1$2${escapeForJsString(newText)}$2`,
    )
  }
  if (kind === 'three-text') {
    return source.replace(
      /^(new\s+(?:THREE\.)?TextGeometry\s*\(\s*)(["'`])(?:\\.|(?!\2).)*?\2/,
      `$1$2${escapeForJsString(newText)}$2`,
    )
  }
  return null
}

function setJsxStyleProp(source: string, prop: keyof TextSlotStyle, value: string | number | null): string | null {
  const styleMatch = source.match(/style\s*=\s*\{\{([\s\S]*?)\}\}/)
  if (!styleMatch) {
    if (value === null || value === '' || value === undefined) return source
    // Inject style={{ prop: value }} right after the tag name.
    const inject = ` style={{ ${prop}: ${formatJsxStyleValue(prop, value)} }}`
    return source.replace(/^<(\w+)\b/, `<$1${inject}`)
  }
  const body = styleMatch[1]
  const pairs = splitTopLevel(body, ',')
    .map((p) => p.trim())
    .filter(Boolean)
  let found = false
  const nextPairs: string[] = []
  for (const p of pairs) {
    const colon = indexOfTopLevel(p, ':')
    if (colon < 0) {
      nextPairs.push(p)
      continue
    }
    const key = p.slice(0, colon).trim()
    if (key === prop) {
      found = true
      if (value === null || value === '') continue // remove this prop
      nextPairs.push(`${prop}: ${formatJsxStyleValue(prop, value)}`)
    } else {
      nextPairs.push(p)
    }
  }
  if (!found) {
    if (value === null || value === '') return source
    nextPairs.push(`${prop}: ${formatJsxStyleValue(prop, value)}`)
  }
  const newBody = nextPairs.length ? ` ${nextPairs.join(', ')} ` : ''
  return source.replace(/style\s*=\s*\{\{[\s\S]*?\}\}/, `style={{${newBody}}}`)
}

function setSvgTextAttr(source: string, prop: keyof TextSlotStyle, value: string | number | null): string | null {
  const descriptor = DESCRIPTOR_BY_KEY[prop]
  if (!descriptor || !descriptor.svgAttr) return source
  const attrName = descriptor.svgAttr
  const attrRe = new RegExp(`\\s${escapeRegex(attrName)}\\s*=\\s*["'][^"']*["']`, 'i')
  if (value === null || value === '') {
    return source.replace(attrRe, '')
  }
  const formatted = String(value)
  if (attrRe.test(source)) {
    return source.replace(attrRe, ` ${attrName}="${formatted}"`)
  }
  // Inject right before the closing > of the opening tag.
  return source.replace(/^(<text\b[^>]*?)(\s*>)/i, `$1 ${attrName}="${formatted}"$2`)
}

function formatJsxStyleValue(prop: keyof TextSlotStyle, value: string | number): string {
  if (typeof value === 'number') return String(value)
  const descriptor = DESCRIPTOR_BY_KEY[prop]
  if (descriptor?.isNumeric && /^-?\d+(?:\.\d+)?$/.test(value)) {
    return value
  }
  // Quote string values
  const escaped = value.replace(/'/g, "\\'")
  return `'${escaped}'`
}

// ── Low-level helpers ───────────────────────────────────────────────────────

function escapeForJsxText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
}

function escapeForXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeForJsString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function replaceFirstOccurrence(code: string, find: string, replaceWith: string, hintStart: number): string | null {
  if (find === replaceWith) return code
  // Prefer the position the slot was extracted from to disambiguate repeats.
  if (hintStart >= 0 && code.slice(hintStart, hintStart + find.length) === find) {
    return code.slice(0, hintStart) + replaceWith + code.slice(hintStart + find.length)
  }
  const i = code.indexOf(find)
  if (i < 0) return null
  return code.slice(0, i) + replaceWith + code.slice(i + find.length)
}

function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  let buf = ''
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (inStr) {
      buf += c
      if (c === '\\' && i + 1 < input.length) {
        buf += input[i + 1]
        i++
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      buf += c
      continue
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++
      buf += c
      continue
    }
    if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1)
      buf += c
      continue
    }
    if (c === sep && depth === 0) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  if (buf) out.push(buf)
  return out
}

function indexOfTopLevel(input: string, ch: string): number {
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (inStr) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      continue
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++
      continue
    }
    if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (c === ch && depth === 0) return i
  }
  return -1
}
