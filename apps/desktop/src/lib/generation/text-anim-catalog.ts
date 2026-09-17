/**
 * Text-motion catalog — Dreambyte's own set of named text effects, written as
 * renderer-agnostic specs (React interpolate, anime.js window.__tl, or WAAPI) so the
 * generation agent applies concrete values instead of vague fades. Injected into
 * the generation prompts (the in-app agent can't read skill files at runtime).
 *
 * Each effect: unit (char / word / line / whole), enter + exit duration, per-unit
 * stagger, easing, and from→to properties. VARY the effect per beat.
 */

/** Condensed catalog injected into generation prompts (so the agent applies real specs, not vague fades). */
export const TEXT_ANIM_CATALOG_PROMPT = `TEXT-MOTION CATALOG — ALL text routes through this catalog: EVERY headline, label, word, line, and text swap MUST enter (and exit) via a NAMED effect below with its values — never an ad-hoc opacity fade or a hand-rolled reveal. Pick one effect per beat and VARY it across beats. Works in React interpolate, the anime.js window.__tl timeline, or WAAPI. At 30fps a frame ≈ 33ms (stagger_ms/33 = frames per unit). On window.__tl everything is SECONDS (520ms → duration: 0.52, 18ms stagger → delay: anime.stagger(0.018)); split units with anime.text.split(el, { chars: true, words: true }) (lines: { lines: { wrap: 'clip' } }); cubic-bezier(a,b,c,d) → ease: anime.cubicBezier(a,b,c,d) (a function, never a string); from-center → anime.stagger(0.014, { from: 'center' }). Format: name — unit · IN duration/stagger ease from→to · OUT.
- letter-lift — char · IN 520ms/18ms cubic-bezier(0.16,1,0.3,1) y:0.45em→0, opacity 0→1 · OUT 260ms/10ms cubic-bezier(0.7,0,0.84,0) y:0→-0.25em, opacity→0
- split-converge — char · IN 560ms/14ms from the CENTER char outward, cubic-bezier(0.33,1,0.68,1) odd chars y:-0.6em, even y:+0.6em →0, opacity 0→1 · OUT reverse (diverge) 300ms/8ms
- word-cascade — word · IN 600ms/70ms cubic-bezier(0.34,1.4,0.64,1) rotateX:70deg→0 (perspective 600px, origin bottom), y:0.3em→0, opacity 0→1 · OUT 280ms/40ms rotateX:0→-50deg, opacity→0
- scale-punch — word · IN 420ms/110ms cubic-bezier(0.34,1.56,0.64,1) scale:1.6→1, opacity 0→1 over the first 40% · OUT 220ms scale→0.9, opacity→0. For emphasis beats synced to VO stress.
- slot-roll — line (each line in an overflow:hidden wrapper) · IN 640ms/90ms cubic-bezier(0.22,1,0.36,1) translateY:105%→0 · OUT 360ms/60ms translateY:0→-105%
- soft-focus — word or whole · IN 800ms/50ms cubic-bezier(0.25,0.1,0.25,1) filter blur(14px)→0, scale 1.08→1, opacity 0→1 · OUT 380ms blur 0→8px, opacity→0
- tracking-collapse — whole line · IN 900ms cubic-bezier(0.19,1,0.22,1) letter-spacing:0.6em→normal, opacity 0→1 · OUT 400ms letter-spacing→0.3em, opacity→0
- wipe-reveal — whole · IN 700ms cubic-bezier(0.65,0,0.35,1) clip-path inset(0 100% 0 0)→inset(0 0 0 0) · OUT 450ms same ease →inset(0 0 0 100%)
- scramble-decode — char · IN 45ms/char: each char cycles 3 glyphs picked by mulberry32(seed + charIndex + frame) (1 frame each, deterministic under seek — never Math.random or scrambleText) then locks, total ≤900ms, tabular-nums or monospace · OUT 200ms opacity→0. For data, codes, tech.
- typewriter — char · IN 1 char per 2 frames (stepped — per-char opacity [0,1] with duration 0.01 and delay anime.stagger(0.067); no easing), blinking caret 530ms period · OUT delete 1 char/frame from the end
- underline-sweep — accent-word add-on · after the text lands, a 0.08em bar scaleX:0→1 (origin left) 450ms cubic-bezier(0.65,0,0.35,1) · OUT scaleX→0 (origin right) 250ms
- fade — whole · IN 400ms ease-out opacity 0→1 · OUT 300ms. ONLY for tiny secondary text, never a headline.`
