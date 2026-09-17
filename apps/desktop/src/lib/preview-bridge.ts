/**
 * Live preview bridge: parent → scene iframe postMessage helpers.
 *
 * Source-code edits in panels normally take effect only after the debounced
 * saveSceneHTML() round-trips through disk and the iframe reloads (~150ms +
 * IPC + render). That's fine for committed state but feels laggy while
 * typing. This module lets the typography panel push a *live* DOM
 * mutation into the iframe so the user sees their edit instantly. The
 * source-code save still happens in parallel for persistence.
 *
 * Pattern: DOM edit overlay → iframe CSS-custom-property
 * pattern: the source is the snapshot, the live DOM is the canvas.
 */

import type { CodeTextSlotKind, TextSlotStyle } from './code-text-slots'
import { TYPOGRAPHY_PROPS } from './code-text-slots'

/** Maps a text-slot kind to a CSS selector for the iframe DOM walker. */
const KIND_SELECTORS: Record<CodeTextSlotKind, string | null> = {
  'jsx-heading': 'h1,h2,h3,h4,h5,h6',
  'jsx-paragraph': 'p',
  'jsx-button': 'button',
  'jsx-li': 'li',
  'jsx-div': 'div',
  'jsx-span': 'span',
  'svg-text': 'text',
  // Canvas / Three text isn't in the live DOM — fall back to source-only.
  'canvas-text': null,
  'three-text': null,
}

export interface LiveApplyMessage {
  target: 'dreambyte-scene'
  sceneId: string
  type: 'live_apply'
  /** Preferred: stable data-dreambyte-slot ID (Layer 2). */
  slotId?: string
  /** Fallback when slot isn't tagged: walk by selector + textContent. */
  selector?: string
  matchText?: string
  occurrence?: number
  /** New text content, if changed. */
  newText?: string
  /** Style props to set inline (in CSS units, e.g. fontSize as 'px'). */
  style?: Record<string, string>
}

/** Live metadata reported by the iframe for one text-bearing element. */
export interface RemoteTextSlot {
  id: string
  tagName: string
  textContent: string
  style: {
    fontFamily: string
    fontSize: string
    fontWeight: string
    fontStyle: string
    color: string
    lineHeight: string
    letterSpacing: string
    textAlign: string
  }
  rect: { x: number; y: number; w: number; h: number }
}

/** True if the slot's renderer puts the text in the live DOM (vs. canvas/three). */
export function isLivePreviewable(kind: CodeTextSlotKind): boolean {
  return KIND_SELECTORS[kind] !== null
}

export function selectorForKind(kind: CodeTextSlotKind): string | null {
  return KIND_SELECTORS[kind]
}

function findSceneIframe(sceneId: string): HTMLIFrameElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLIFrameElement>(`iframe[data-scene-id="${cssEscape(sceneId)}"]`)
}

/**
 * Post a live-apply message to the scene iframe. Returns true if an iframe
 * was found; false if the scene isn't mounted (no-op).
 *
 * Prefer `slotId` (Layer 2). Falls back to selector+matchText+occurrence
 * for elements the iframe hasn't tagged yet (e.g. on a fresh page load
 * before the slot tagger has run).
 */
export function postLiveApply(args: {
  sceneId: string
  kind: CodeTextSlotKind
  slotId?: string
  matchText?: string
  occurrence?: number
  newText?: string
  style?: TextSlotStyle
}): boolean {
  const iframe = findSceneIframe(args.sceneId)
  if (!iframe?.contentWindow) return false
  const selector = selectorForKind(args.kind)
  if (!args.slotId && !selector) return false
  const msg: LiveApplyMessage = {
    target: 'dreambyte-scene',
    sceneId: args.sceneId,
    type: 'live_apply',
    slotId: args.slotId,
    selector: selector ?? undefined,
    matchText: args.matchText,
    occurrence: args.occurrence,
    newText: args.newText,
    style: args.style ? styleToCss(args.style) : undefined,
  }
  iframe.contentWindow.postMessage(msg, '*')
  return true
}

/**
 * Ask the iframe for its current list of tagged text slots. Returns a
 * Promise that resolves with the slot array (or null if the iframe doesn't
 * respond within the timeout). Used by the typography panel to read live
 * computedStyle values instead of regex-parsing inline `style={{}}`.
 */
export function requestTextSlots(sceneId: string, timeoutMs = 800): Promise<RemoteTextSlot[] | null> {
  return new Promise((resolve) => {
    const iframe = findSceneIframe(sceneId)
    if (!iframe?.contentWindow) {
      resolve(null)
      return
    }
    const requestId = `ts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    let done = false
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data
      if (!d || d.source !== 'dreambyte-scene') return
      if (d.type !== 'text_slots' || d.requestId !== requestId) return
      done = true
      window.removeEventListener('message', onMessage)
      resolve(Array.isArray(d.slots) ? d.slots : [])
    }
    window.addEventListener('message', onMessage)
    iframe.contentWindow.postMessage(
      { target: 'dreambyte-scene', sceneId, type: 'enumerate_text_slots', requestId },
      '*',
    )
    setTimeout(() => {
      if (done) return
      window.removeEventListener('message', onMessage)
      resolve(null)
    }, timeoutMs)
  })
}

/** Convert our typed style payload to CSS strings the iframe can assign. */
function styleToCss(style: TextSlotStyle): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of TYPOGRAPHY_PROPS) {
    const v = (style as Record<string, string | number | undefined>)[d.key]
    if (v == null) continue
    out[d.key] = typeof v === 'number' && d.cssUnit ? `${v}${d.cssUnit}` : String(v)
  }
  return out
}

// ── Select mode (Layer 3) ──────────────────────────────────────────────────

export function postEnableSelectMode(sceneId: string): boolean {
  const iframe = findSceneIframe(sceneId)
  if (!iframe?.contentWindow) return false
  iframe.contentWindow.postMessage({ target: 'dreambyte-scene', sceneId, type: 'enable_select_mode' }, '*')
  return true
}

export function postDisableSelectMode(sceneId: string): boolean {
  const iframe = findSceneIframe(sceneId)
  if (!iframe?.contentWindow) return false
  iframe.contentWindow.postMessage({ target: 'dreambyte-scene', sceneId, type: 'disable_select_mode' }, '*')
  return true
}

export function postSelectSlot(sceneId: string, slotId: string | null): boolean {
  const iframe = findSceneIframe(sceneId)
  if (!iframe?.contentWindow) return false
  iframe.contentWindow.postMessage(
    { target: 'dreambyte-scene', sceneId, type: slotId ? 'select_slot' : 'clear_selection', slotId },
    '*',
  )
  return true
}

export interface SlotClickedEvent {
  sceneId: string
  slotId: string
  tagName: string
  textContent: string
}

/** Listen for slot_clicked events from any scene iframe. Returns a cleanup fn. */
export function subscribeSlotClicked(cb: (ev: SlotClickedEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onMessage = (ev: MessageEvent) => {
    const d = ev.data
    if (!d || d.source !== 'dreambyte-scene' || d.type !== 'slot_clicked') return
    cb({
      sceneId: String(d.sceneId ?? ''),
      slotId: String(d.slotId ?? ''),
      tagName: String(d.tagName ?? '').toLowerCase(),
      textContent: String(d.textContent ?? ''),
    })
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

export interface SlotTextEvent {
  sceneId: string
  slotId: string
  text: string
}

/** Stream of input events while the user types in a contentEditable slot. */
export function subscribeSlotTextInput(cb: (ev: SlotTextEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onMessage = (ev: MessageEvent) => {
    const d = ev.data
    if (!d || d.source !== 'dreambyte-scene' || d.type !== 'slot_text_input') return
    cb({
      sceneId: String(d.sceneId ?? ''),
      slotId: String(d.slotId ?? ''),
      text: String(d.text ?? ''),
    })
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

/** Fires once when the user commits (blur / Enter) or cancels (Esc). */
export function subscribeSlotTextCommitted(cb: (ev: SlotTextEvent & { committed: boolean }) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onMessage = (ev: MessageEvent) => {
    const d = ev.data
    if (!d || d.source !== 'dreambyte-scene' || d.type !== 'slot_text_committed') return
    cb({
      sceneId: String(d.sceneId ?? ''),
      slotId: String(d.slotId ?? ''),
      text: String(d.text ?? ''),
      committed: !!d.committed,
    })
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

/** Tiny CSS.escape polyfill — `data-scene-id` values are alnum + dashes,
 * but we still guard against future ID changes that include selector chars. */
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}
