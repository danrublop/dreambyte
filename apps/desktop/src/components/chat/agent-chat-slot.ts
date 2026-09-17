'use client'

import { useSyncExternalStore } from 'react'

/**
 * Registry connecting the single persistent AgentChat instance (AgentChatHost)
 * to the editor's Agent panel (PromptTab). PromptTab registers its panel DOM
 * node as the "slot"; the host reparents the live chat into it. A module-level
 * registry (not the Zustand store) because it carries raw DOM nodes/callbacks —
 * transient wiring, never persisted.
 */

let slotEl: HTMLElement | null = null
let openSceneCodeEditor: (() => void) | null = null
const listeners = new Set<() => void>()

/** PromptTab passes its panel element on mount, null on unmount (ref callback). */
export function registerAgentChatSlot(el: HTMLElement | null) {
  if (slotEl === el) return
  slotEl = el
  listeners.forEach((l) => l())
}

/** Element-keyed deregistration: only clears the slot if `el` is the one
 *  currently registered, so a stale unmount (StrictMode double-mount, view
 *  cross-fade) can't yank the live chat out from under a newer registration. */
export function releaseAgentChatSlot(el: HTMLElement) {
  if (slotEl !== el) return
  slotEl = null
  listeners.forEach((l) => l())
}

/** PromptTab registers how to open the Monaco scene-code modal (scene-dependent). */
export function registerOpenSceneCodeEditor(fn: (() => void) | null) {
  openSceneCodeEditor = fn
}

/** Function-keyed deregistration mirroring releaseAgentChatSlot: only clears if
 *  `fn` is the one currently registered, so a stale unmount (StrictMode
 *  double-mount, view cross-fade) can't null out a newer registration. */
export function releaseOpenSceneCodeEditor(fn: () => void) {
  if (openSceneCodeEditor !== fn) return
  openSceneCodeEditor = null
}

export function getOpenSceneCodeEditor(): (() => void) | null {
  return openSceneCodeEditor
}

export function useAgentChatSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => slotEl,
    () => null,
  )
}
