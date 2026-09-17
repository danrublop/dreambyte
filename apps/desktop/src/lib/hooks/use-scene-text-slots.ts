'use client'

/**
 * Subscribes to the live text-slot list reported by a scene iframe.
 *
 * Returns slots in iframe DOM order, each with computedStyle values — which
 * is the *rendered* truth (Tailwind classes, CSS files, inheritance), not
 * the regex-parsed inline `style={{}}` view from source. The typography
 * panel uses this to show what the user actually sees.
 *
 * Re-fetches when `sceneHtmlVersion` bumps (after a debounced save) and on
 * explicit `refresh()`. Returns null while the iframe hasn't responded yet
 * — callers should fall back to source-extracted style in that case.
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { useVideoStore } from '@/lib/store'
import { requestTextSlots, type RemoteTextSlot } from '@/lib/preview-bridge'

export function useSceneTextSlots(sceneId: string | null): {
  slots: RemoteTextSlot[] | null
  refresh: () => void
} {
  const sceneHtmlVersion = useVideoStore((s) => s.sceneHtmlVersion)
  const [slots, setSlots] = useState<RemoteTextSlot[] | null>(null)
  const lastFetchedFor = useRef<{ sceneId: string | null; version: number } | null>(null)
  const refreshSeq = useRef(0)

  const fetchOnce = useCallback(async () => {
    if (!sceneId) {
      setSlots(null)
      return
    }
    const seq = ++refreshSeq.current
    // Iframe needs a moment after load + render. Retry up to ~1.5s if the
    // first response is empty (scene still mounting) — but only while the
    // caller hasn't issued a newer refresh.
    let attempts = 0
    while (attempts < 5) {
      const result = await requestTextSlots(sceneId, 600)
      if (refreshSeq.current !== seq) return
      if (result && result.length > 0) {
        setSlots(result)
        return
      }
      if (result === null) {
        // iframe not mounted — bail
        setSlots(null)
        return
      }
      attempts++
      await new Promise((r) => setTimeout(r, 250))
    }
    // Final attempt: accept empty list rather than spin forever
    setSlots([])
  }, [sceneId])

  useEffect(() => {
    const prev = lastFetchedFor.current
    if (prev && prev.sceneId === sceneId && prev.version === sceneHtmlVersion) return
    lastFetchedFor.current = { sceneId, version: sceneHtmlVersion }
    fetchOnce()
  }, [sceneId, sceneHtmlVersion, fetchOnce])

  return { slots, refresh: fetchOnce }
}

/**
 * Pick the DOM slot that corresponds to a source-extracted CodeTextSlot.
 *
 * Source and DOM enumerate in the same document order, so we map by
 * (selector-matching tag, ordinal-among-same-tag). For SVG `<text>` we
 * accept any case; for canvas/three we have no DOM target.
 */
export function findRemoteSlotForCode(
  remote: RemoteTextSlot[],
  codeKind: string,
  codeOrdinal: number,
): RemoteTextSlot | null {
  const tagsForKind: Record<string, string[]> = {
    'jsx-heading': ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    'jsx-paragraph': ['p'],
    'jsx-button': ['button'],
    'jsx-li': ['li'],
    'jsx-div': ['div'],
    'jsx-span': ['span'],
    'svg-text': ['text'],
  }
  const tags = tagsForKind[codeKind]
  if (!tags) return null
  const matches = remote.filter((s) => tags.includes(s.tagName))
  return matches[codeOrdinal] ?? null
}
