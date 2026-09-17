/**
 * Static FLOW scan for generated scene CODE (a STRUCTURAL FLOOR, not a quality judge).
 *
 * scanForSlop catches what must NOT be present (emoji/kicker/loop). This catches what
 * SHOULD be present per THE FLOW: big kinetic text, a time-driven camera move, and more
 * than one timed beat. It's the static proxy for "did the model follow the camera-travel
 * structure or fall back to a static slideshow". It does NOT and cannot judge whether the
 * scene is a GOOD video (pacing, composition, taste) — that's a human call
 * (evals/motion-design/RUBRIC.md).
 * High precision over recall — only warn when a FLOW essential is confidently ABSENT.
 *
 * Also usable post-generation as a SOFT signal ("this scene has no camera move — likely a
 * slideshow") without hard-gating the build.
 *
 * Calibration (avoids false positives on legitimate scenes):
 *  - fonts are measured against the real project dimensions (canvas-scaled fonts like
 *    `fontSize: H*0.05` on a 9:16 canvas) and ternary/expression font sizes are parsed;
 *  - gradients and dark/near-white or tinted grounds are accepted — only a flat MID-tone
 *    solid fill warns (graded grounds are correct per the grade craft pack);
 *  - the slideshow warning only fires when motion is genuinely sparse (no camera move AND
 *    few timed beats), so rich per-element motion without a global camera doesn't flag.
 */

export interface FlowReport {
  hasBigText: boolean // a headline >= 72px
  hasCameraMove: boolean // a time/frame-driven transform translate+scale, or 3D camera anim
  hasSequentialBeats: boolean // >= 2 independently-timed reveals (not one state)
  bgFlatMono: boolean // background is acceptable (flat mono, gradient, or dark/near-white) — NOT a muddy mid-tone fill
  maxFontSize: number
  warnings: string[]
}

export interface FlowScanOpts {
  /** Real project canvas dimensions, so canvas-scaled fonts (`fontSize: H*0.05`)
   *  estimate correctly for vertical/square/portrait — not just landscape 16:9. */
  width?: number
  height?: number
  /** The scene carries a structured camera track (`scene.cameraMotion`, set via
   *  `set_camera_motion` and injected as a `<script>` by sceneTemplate). That is a
   *  real, time-driven camera move that the code-only scan cannot see — it lives
   *  outside reactCode/sceneCode. When true, treat the scene as HAVING a camera move
   *  so a legitimately camera-driven-but-statically-coded scene is not mislabeled a
   *  slideshow. (③.4) */
  hasCameraMotionTrack?: boolean
}

// Root background = the FIRST background(Color) value in the code (the root AbsoluteFill).
const BG_RE = /background(?:Color)?:\s*['"]?([^'",}]+)/

/**
 * Is the root background a MUDDY mid-tone flat fill — the actual slop?
 *
 * Accepted (NOT muddy): gradients (depth is good), the black/white keywords,
 * transparent, dark grounds (tinted or neutral — e.g. #0b0f1f, a graded navy),
 * and near-white. Only a flat solid hex at MID luminance (no gradient, neither
 * dark nor near-white) reads as a murky fill and warns. Non-hex / named colors
 * return false (low confidence — never false-flag).
 */
function isMuddyBg(code: string): boolean {
  const m = code.match(BG_RE)
  if (!m) return false
  const v = m[1].trim().toLowerCase()
  if (v.includes('gradient')) return false // depth — good
  if (v === 'black' || v === 'white' || v === 'transparent' || v === 'none') return false
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (!hex) return false // unknown / named color — don't false-flag
  let h = hex[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const maxc = Math.max(r, g, b)
  const minc = Math.min(r, g, b)
  if (maxc <= 70) return false // dark ground (graded navy/charcoal or true-ish black) — fine
  if (minc >= 220) return false // near-white — fine
  return true // flat mid-tone solid filling the frame — muddy slop
}

// A time/frame-driven camera world: an interpolated translate AND an interpolated scale.
// Accepts the combined `translate(${x},${y})` form OR separate `translateX(${x})` /
// `translateY(${y})` — both are camera travel; the old regex only matched the combined
// form and false-flagged the (common) separate-axis form as a static slideshow.
const INTERP_TRANSLATE_RE = /translate[XY]?\([^)]*\$\{/
const INTERP_SCALE_RE = /scale\([^)]*\$\{/
// 3D camera animation: camera.position.* assigned from a frame/time-derived expression.
const CAMERA_3D_RE = /camera\.position\.[xyz]?\s*[.=]/

// Timed reveals — custom eased seg(), interpolate(frame|t,...), or spring(). 2+ distinct
// calls = more than one beat. Count seg(/interpolate(/spring( occurrences.
const BEAT_RE = /\b(?:seg|interpolate|spring)\s*\(/g

// fontSize value expression: everything up to the next , } ; or newline. Parsed for the
// largest plausible px so literals, quoted px, ternaries, clamps, and canvas-scaled forms
// all resolve (the old regex required a digit immediately after `fontSize:` and read
// `fontSize: x ? 132 : 100` as 0px).
const FONT_EXPR_RE = /fontSize:\s*([^,}\n;]+)/g
const SCALED_FONT_RE = /(WIDTH|HEIGHT|W|H)\s*([*/])\s*([\d.]+)/g
const INT_RE = /(?<![.\d])(\d{2,4})(?![.\d])/g

/** Largest plausible headline px, given the REAL canvas dimensions. */
export function extractMaxFontPx(code: string, width: number, height: number): number {
  let max = 0
  for (const m of code.matchAll(FONT_EXPR_RE)) {
    const expr = m[1]
    let scaledHit = false
    for (const sc of expr.matchAll(SCALED_FONT_RE)) {
      const base = sc[1].startsWith('W') ? width : height
      const n = parseFloat(sc[3])
      if (Number.isFinite(n) && n > 0) {
        const px = sc[2] === '/' ? base / n : base * n
        if (px > max) max = Math.round(px)
        scaledHit = true
      }
    }
    if (scaledHit) continue // a canvas-scaled font; integers in it are the fractions, skip
    for (const num of expr.matchAll(INT_RE)) {
      const px = parseInt(num[1], 10)
      if (px > max) max = px
    }
  }
  return max
}

// Any time-driven motion signal. Deliberately BROADER than scanForFlow's
// camera+beats heuristic (which is tuned for the Remotion `interpolate` idiom):
// it also recognizes CSS `@keyframes`/`animation:`, requestAnimationFrame, a 3D
// camera anim, and ANY style value driven by a template expression (a hook like
// useDreambyteTime feeding `transform: translate(${x})` / `opacity: ${o}`). Used
// by the BLOCKING FLOW gate so it fires ONLY on a genuinely motionless slide and
// does not over-block legitimate non-`interpolate` motion (a real churn risk).
const MOTION_SIGNAL_RE =
  /\b(?:interpolate|spring|seg)\s*\(|@keyframes|\banimation(?:-name|-duration)?\s*:|requestAnimationFrame|camera\.position|(?:transform|translate[XY]?|scale|rotate|opacity|top|left|right|bottom)\s*[:(][^;)}]*\$\{/i

/** True when the code contains ANY time-driven motion (see MOTION_SIGNAL_RE). */
export function hasTimeDrivenMotion(code: string): boolean {
  return !!code && MOTION_SIGNAL_RE.test(code)
}

export function scanForFlow(code: string, opts: FlowScanOpts = {}): FlowReport {
  const empty: FlowReport = {
    hasBigText: false,
    hasCameraMove: !!opts.hasCameraMotionTrack,
    hasSequentialBeats: false,
    bgFlatMono: true,
    maxFontSize: 0,
    warnings: [],
  }
  if (!code || !code.trim()) return empty

  // Default to landscape 1080p when dims aren't supplied (tests / legacy callers).
  const width = opts.width && opts.width > 0 ? opts.width : 1920
  const height = opts.height && opts.height > 0 ? opts.height : 1080

  const maxFontSize = extractMaxFontPx(code, width, height)
  const hasBigText = maxFontSize >= 72
  // A camera move is present if the code interpolates a translate+scale / animates a
  // 3D camera, OR the scene carries a structured cameraMotion track (injected outside
  // the code fields — the code-only scan can't see it). (③.4)
  const hasCameraMove =
    !!opts.hasCameraMotionTrack ||
    (INTERP_TRANSLATE_RE.test(code) && INTERP_SCALE_RE.test(code)) ||
    CAMERA_3D_RE.test(code)
  const beatCount = (code.match(BEAT_RE) || []).length
  const hasSequentialBeats = beatCount >= 2
  // Rich per-element motion: many independently-timed reveals. A scene with this much
  // animation is not a "static slideshow" even without a global camera transform.
  const richMotion = beatCount >= 4
  const muddyBg = isMuddyBg(code)

  const warnings: string[] = []
  if (muddyBg) {
    warnings.push(
      'FLOW: background is a flat mid-tone solid fill — reads as murky/slop. Use a flat #000/#fff, a tinted dark ground, or a gradient for depth.',
    )
  }
  // Only call it a slideshow when motion is GENUINELY sparse — no camera move AND
  // fewer than ~4 timed reveals. A richly-animated scene without a global camera
  // transform is fine (its motion comes from the per-element animation).
  if (!hasCameraMove && !richMotion) {
    warnings.push(
      'FLOW: little time-driven motion (no camera move and few timed reveals) — likely a static slideshow. Add a camera move (interpolated translate+scale) or more sequential beats (enter → hold → exit/handoff).',
    )
  }
  if (!hasBigText) {
    warnings.push(
      `FLOW: largest headline is ${maxFontSize || 0}px (< 72) — beats should be BIG kinetic text (80-170px), not small captions.`,
    )
  }

  return { hasBigText, hasCameraMove, hasSequentialBeats, bgFlatMono: !muddyBg, maxFontSize, warnings }
}
