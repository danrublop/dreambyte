/**
 * Build the iframe `src` for rendering a scene preview.
 *
 * Security boundary: under the packaged `dreambyte://` scheme, scenes load from a
 * distinct `dreambyte://scene-frame` origin rather than `dreambyte://app`. The browser's
 * same-origin policy then isolates LLM-generated scene JS from the renderer —
 * a same-origin scene can reach `window.parent.dreambyteApi` and drive the full
 * IPC surface (tier2 file export/import, git, project/conversation reads),
 * which is a sandbox escape. Giving the scene its own origin closes that route.
 * See docs/plans/SECURITY-SCOPE.md, section 4.
 *
 * What still works across the new origin boundary:
 * - Playback control (play/pause/seek/scrub/…) flows over postMessage, which
 *   is cross-origin safe. See src/lib/scene-html/playback-controller.ts.
 * - Scene assets resolve via the baked `<base href>` (dreambyte://app) plus the
 *   `scene-frame` host's asset passthrough in src/electron/main.ts, so audio,
 *   uploads, and images keep loading.
 * - Thumbnail capture uses the pixi compositor / Electron capturePage IPC, not
 *   same-origin `contentDocument` reach.
 *
 * Dev (http://localhost) has no second origin readily available, so it stays
 * same-origin. The boundary that matters is the packaged app users run; the
 * dev renderer is the developer's own trusted environment.
 *
 * Export: the pixi (legacy) exporter renders inline scene HTML via `srcdoc`, sandboxed
 * `allow-scripts` only (opaque origin, never `allow-same-origin`) and drives it over a
 * postMessage bridge — see src/lib/export2/scene-frame-bridge.ts. Tier-3 export, the
 * compositor host and the verifier load scenes from `dreambyte://scenes` in offscreen
 * windows with no preload, so there is no privileged API to reach.
 */
export function sceneSrc(sceneId: string, version = 0): string {
  const qs = version > 0 ? `?v=${version}` : ''
  if (typeof window !== 'undefined' && window.location?.protocol === 'dreambyte:') {
    return `dreambyte://scene-frame/${sceneId}.html${qs}`
  }
  return `/scenes/${sceneId}.html${qs}`
}
