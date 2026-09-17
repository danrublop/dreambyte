/**
 * Static anti-slop scan for generated scene CODE (the measurable gate).
 *
 * Catches the highest-confidence Motion Design Contract violations from the code
 * text (not pixels), so a regression is flagged automatically post-generation:
 *   - emoji used as on-screen content (the contract wants SVG/CSS objects)
 *   - scene-number / section "kicker" labels ("02 — TITLE", "STEP 3") — no chrome
 *   - a `frame % N` whole-scene loop driving the primary motion (not sequential beats)
 *
 * Pure function, returns human-readable warning strings (same shape as the other
 * post-generation validators). High precision over recall — a warning here should
 * almost always be a real violation, not noise.
 */

// Common emoji blocks (Misc Symbols & Pictographs, Emoticons, Transport,
// Supplemental, Dingbats, Misc Symbols, Symbols & Arrows-B). Deliberately EXCLUDES
// plain arrows (U+2190–21FF) and the Bitcoin sign ₿ (U+20BF), which are legitimate
// text glyphs, so this does not fire on "→" or "₿".
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u

// A scene-number / section kicker: "01 — THE PROBLEM", "02 / DOUBLE SPENDING",
// "STEP 3", "CHAPTER 2" — whether in a string literal or JSX text. The number form
// requires a dash/slash AND 2+ trailing capitals, so it does not fire on prose like
// "24/7", "Q3 Results", or "3 ideas".
const KICKER_RE = /\b0?\d\s*[—/-]\s*[A-Z]{2,}|\b(?:STEP|CHAPTER|PART|SECTION)\s+\d/

// `frame % N` (or `frame%N`) — a perpetual cycle. Only SLOP when it's the PRIMARY
// motion; layered over many sequential beats it's a fine ambient accent.
const LOOP_RE = /\bframe\s*%\s*\w/
// Timed reveals (seg/interpolate/spring) — a proxy for "this scene has real
// sequential beats", so a small frame%N accent isn't the whole show.
const BEAT_RE = /\b(?:seg|interpolate|spring)\s*\(/g

// Eyebrow / section "kicker" labels — small UPPERCASE eyebrows over each beat ("THE
// RESULT", "AVALANCHE EFFECT", "CRYPTOGRAPHIC PRIMITIVE"). The tell is textTransform:
// 'uppercase'; a motion-design scene rarely needs even one, never 2+. 2+ ⇒ slide chrome.
const UPPERCASE_RE = /textTransform:\s*['"]uppercase['"]/g

// Flag emojis (regional indicators) are legitimate CONTENT — a country/team flag, not
// decorative slop. Exempt them from the emoji ban; only NON-flag emoji are flagged.
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]/gu

// Strip code comments before scanning: a kicker/emoji only matters in RENDERED content
// (JSX text + string literals), never in a `// STATION 1 — TEXT` comment. Stripping kills
// the recurring false positive where a "STATION 1 — TEXT" comment reads as a "1 — TEXT"
// scene-number kicker. The `[^:]` guard leaves URL `://` (e.g. dreambyte://) intact.
function stripForScan(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

export function scanForSlop(code: string): string[] {
  const out: string[] = []
  if (!code || !code.trim()) return out
  const src = stripForScan(code)
  if (EMOJI_RE.test(src.replace(FLAG_RE, ''))) {
    out.push(
      'SLOP: emoji used as on-screen content — use SVG/CSS objects (file glyphs, device frames, coins), never emoji as a hero element. (Flag emojis for countries/teams are allowed.)',
    )
  }
  if (KICKER_RE.test(src)) {
    out.push(
      'SLOP: a scene-number / section kicker label (e.g. "02 — TITLE", "STEP 3") — no slide-deck chrome; show the idea, do not title it.',
    )
  }
  // 3+ uppercase eyebrows ⇒ slide chrome. (Was 2, which false-fired on legitimate
  // data labels like "REVENUE" + "QoQ GROWTH" on a finance scene — stress-test.)
  if ((src.match(UPPERCASE_RE) || []).length >= 3) {
    out.push(
      'SLOP: 3+ UPPERCASE eyebrow/section labels over the beats (e.g. "THE RESULT", "AVALANCHE EFFECT") — that is slide-deck chrome. Show the idea, do not title each beat.',
    )
  }
  // Only flag a frame%N loop as slop when timed reveals are SPARSE (it's likely the
  // primary motion). Over 4+ sequential beats it's a fine ambient accent (a light
  // sweep, a scanning underline) — stress-test false-positive.
  const beatCount = (src.match(BEAT_RE) || []).length
  if (LOOP_RE.test(src) && beatCount < 4) {
    out.push(
      'SLOP: `frame % N` drives a whole-scene loop — motion should be sequential beats (enter → hold → exit/handoff), not one animation looping the full duration.',
    )
  }
  return out
}
