'use client'

/**
 * Cached audio-URL lookup map for timeline clips.
 *
 * Resolving a clip's source URL by walking every scene + nested `aiLayers` /
 * `sfx[]` in each ClipBlock on every store mutation (including transport
 * ticks) is quadratic work per frame (N visible clips × M scenes).
 *
 * The map is built once at the Timeline level — `Timeline.tsx` provides
 * it via this context, keyed by `clip.sourceId`. Per-clip lookups are
 * O(1). The map is memoized on the `scenes` array reference, so it only
 * rebuilds when scenes actually change.
 *
 * Default value is an empty Map so consumers don't have to null-check.
 */

import { createContext, useContext } from 'react'

// The map builder lives in src/lib/audio so the (non-React) timeline audio engine
// can share the EXACT same source-id → URL conventions. Re-exported here so the
// existing `import { buildAudioUrlMap } from './AudioUrlMapContext'` sites keep
// working unchanged.
export { buildAudioUrlMap } from '@/lib/audio/audio-url-map'

export const AudioUrlMapContext = createContext<Map<string, string>>(new Map())

export function useAudioUrlMap(): Map<string, string> {
  return useContext(AudioUrlMapContext)
}
