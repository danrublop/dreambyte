/**
 * Marlin-2B VideoUnderstander (Phase 2.3, premium CUDA backend).
 *
 * Marlin produces dense scene + event captions with second-precise timestamps
 * (and NL→span "find", reserved for later). The actual model runs in a Python
 * sidecar that only the Electron layer manages, so the caption call is injected
 * — `src/lib/` stays free of `child_process`. Tests pass a mock caption fn.
 */

import type { VideoUnderstander, VideoUnderstanding } from './video-understander'

/** Result of Marlin caption mode: a scene paragraph + atomic timed events. */
export interface MarlinCaption {
  scene?: string
  events: { start: number; end: number; description: string }[]
}

export interface MarlinDeps {
  /** Caption a video via the Marlin sidecar. Should reject on sidecar failure. */
  caption: (source: string, opts?: { abortSignal?: AbortSignal }) => Promise<MarlinCaption>
}

export function createMarlinUnderstander(deps: MarlinDeps): VideoUnderstander {
  return {
    async understand(source: string, opts = {}): Promise<VideoUnderstanding> {
      const result = await deps.caption(source, { abortSignal: opts.abortSignal })
      return {
        scene: result.scene,
        events: result.events ?? [],
        backend: 'marlin',
      }
    },
  }
}
