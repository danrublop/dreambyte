/**
 * Backward compatibility for scenes authored before GSAP was removed.
 *
 * GSAP cannot ship (its license forbids use in visual animation tools), and
 * there is deliberately no GSAP-compatible shim. Saved projects still contain
 * agent-generated scene code calling `gsap.*` or GSAP's timeline methods on
 * `window.__tl` (`tl.to(...)`, `__tl.time()` ...), which would throw against
 * the anime.js runtime and render a blank or half-built frame. Such scenes are
 * swapped for a visible placeholder card that also throws a runtime error, so
 * the preview, export, verifier and agent all see a clear "regenerate" state.
 *
 * This file is the ONE place in the runtime allowed to mention GSAP.
 */
import type { Scene } from '../types'

export const LEGACY_GSAP_MESSAGE = 'This scene used GSAP, which was removed — regenerate it'

// gsap.<anything> · GSAP plugin globals · GSAP-only timeline methods on __tl / tl.
// Regex heuristic over the stored code fields; a scene that merely
// mentions these names in a string literal is also flagged (acceptable: it's a
// regenerate prompt, never data loss).
const LEGACY_GSAP_API =
  /\bgsap\s*\.\s*[A-Za-z_$]|\b(?:DrawSVGPlugin|MorphSVGPlugin|MotionPathPlugin|SplitText|CustomEase|TextPlugin|ScrollTrigger)\b|\b(?:__tl|tl)\s*\.\s*(?:to|from|fromTo|time|progress|totalProgress|eventCallback|getChildren|totalDuration|timeScale|addLabel|addPause|isActive|invalidate)\s*\(/

/** The scene fields that hold agent/user-authored code or markup. */
function sceneCodeText(scene: Partial<Scene>): string {
  return [
    scene.sceneCode,
    scene.sceneHTML,
    scene.reactCode,
    scene.canvasCode,
    scene.canvasBackgroundCode,
    scene.svgContent,
    scene.svgObjects?.length ? JSON.stringify(scene.svgObjects) : '',
    scene.aiLayers?.length ? JSON.stringify(scene.aiLayers) : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function sceneUsesLegacyGsap(scene: Partial<Scene>): boolean {
  const text = sceneCodeText(scene)
  return LEGACY_GSAP_API.test(text) || LEGACY_GSAP_HEAD.test(text)
}

// A GSAP <script> (vendored /vendor/gsap/… or a gsap@x CDN URL) or the plugin
// registration every pre-removal scene head carried.
const LEGACY_GSAP_HEAD = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/gsap(?:@[^/"']*)?\/|\bgsap\s*\.\s*registerPlugin\s*\(/i

/** The scene itself, or its placeholder when it was written for GSAP. */
export function withLegacyPlaceholder(scene: Scene): Scene {
  return sceneUsesLegacyGsap(scene) ? legacyGsapPlaceholderScene(scene) : scene
}

/**
 * Scene HTML generated before GSAP was removed is still on disk: its head loads
 * GSAP from /vendor (now 404) and then from a CDN fallback, and its controller
 * expects GSAP, so it must never be rendered as-is. Returns the placeholder
 * scene for such a file (keeping the scene id, duration and frame size read from
 * its globals), or null for current HTML.
 */
export function legacyPlaceholderFromHtml(html: string): { scene: Scene; width?: number; height?: number } | null {
  if (!LEGACY_GSAP_HEAD.test(html)) return null
  const num = (name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(html)
    return m ? Number(m[1]) : undefined
  }
  const id = /\bSCENE_ID\s*=\s*['"]([\w-]+)['"]/.exec(html)?.[1] ?? 'legacy-scene'
  const base = {
    id,
    name: '',
    prompt: '',
    duration: num('DURATION') || 8,
    videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: { enabled: false, src: null, volume: 1, fadeIn: false, fadeOut: false, startOffset: 0 },
    textOverlays: [],
    variables: [],
    styleOverride: {},
  } as unknown as Scene
  return { scene: legacyGsapPlaceholderScene(base), width: num('WIDTH'), height: num('HEIGHT') }
}

/**
 * A plain motion scene showing the message card. Audio is kept so the scene
 * still occupies its slot in the mix; everything code-bearing is dropped. The
 * inline throw reaches the scene error beacon / verifier as a runtime error.
 */
export function legacyGsapPlaceholderScene(scene: Scene): Scene {
  return {
    ...scene,
    sceneType: 'motion',
    bgColor: '#111318',
    sceneStyles: '',
    sceneHTML: `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#111318;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:70%;padding:48px 56px;border:2px dashed #f5a524;border-radius:24px;text-align:center;color:#f4f4f5;">
    <div style="font-size:64px;font-weight:700;line-height:1.15;">${LEGACY_GSAP_MESSAGE}</div>
    <div style="margin-top:24px;font-size:32px;color:#a1a1aa;">Ask the agent to rebuild this scene.</div>
  </div>
</div>`,
    sceneCode: `throw new Error(${JSON.stringify(LEGACY_GSAP_MESSAGE)});`,
    reactCode: '',
    canvasCode: '',
    canvasBackgroundCode: '',
    svgContent: '',
    svgObjects: [],
    aiLayers: [],
    chartLayers: [],
    cameraMotion: null,
    interactions: [],
    worldConfig: null,
  }
}
