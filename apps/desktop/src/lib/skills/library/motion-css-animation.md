---
id: motion-css-animation
type: skill
title: Motion / anime.js Animation
timestamp: 2026-06-17
tier: on-demand
name: Motion / anime.js Animation
category: animation
tags: [motion, anime, css, animation, text-split, svg-draw, svg-morph, dreambytemotion, timeline]
sceneType: motion
complexity: medium
requires: []
description: Motion scenes on the anime.js v4 master timeline (seconds), DreambyteMotion component library, text splitting, SVG line draw, morph and motion paths. Best for layout-heavy explainers with text reveals and element animations.
parameters:
  - name: timelineMode
    type: string
    default: anime
    description: Animation engine
    enum: [anime, css-only]
---

## Motion Scenes

- All animation timing MUST go through `window.__tl` — the master anime.js Timeline. The global `anime` (v4.5) is preloaded and `anime.engine.timeUnit = 's'`: every duration, delay, stagger and position is in **seconds**.
- Prefer declarative `tl.add(target, params, position)` tweens per beat; a proxy tweened 0→1 with `onUpdate` is the fallback for effects a tween can't express.
- NEVER call `play()`/`pause()`/`seek()` on `window.__tl` (the player owns playback). NEVER use standalone `anime.animate()` / `anime.createTimeline()` for scene motion, `setTimeout`, `setInterval`, or `requestAnimationFrame`.
- Use flexbox/grid for layout — NEVER position:absolute with pixel values (causes overflow)
- Use clamp(), vw/vh, percentages for responsive sizing
- CSS @keyframes for entrance animations so content shows before play is pressed
- Do NOT redeclare template globals (DURATION, WIDTH, HEIGHT, PALETTE, etc.)

## Timeline authoring (anime.js v4)

```js
const tl = window.__tl
tl.label('beat2', 3.2) // named position
tl.add('.headline', { y: [60, 0], opacity: [0, 1], duration: 0.7, ease: 'outExpo' }, 0.2) // ENTER — first child needs a number
  .add('.subhead', { x: ['-6%', '0%'], opacity: [0, 1], duration: 0.5, ease: 'outQuart' }, '<<+=0.15') // 0.15s after previous START
  .add('.card', { y: [40, 0], opacity: [0, 1], duration: 0.5, ease: 'outCubic', delay: anime.stagger(0.08) }, '<+=0.2')
  .add(['.headline', '.subhead'], { y: -40, opacity: 0, duration: 0.4, ease: 'inQuart' }, 'beat2') // EXIT
  .set('#panel-2', { opacity: 1 }, 'beat2') // instant state at a time
```

- **Position (3rd arg):** number = absolute seconds (preferred) · `'beat2'` label · `'<'` previous child's end · `'<<'` previous child's start · `'<+=0.4'` / `'<<+=0.15'` offsets. Omitted = end of timeline. The first child has no previous child — give it a number.
- **Values:** `opacity: 1` (to) · `opacity: [0, 1]` (from→to) · `opacity: { from: 0 }` (from→current) · `scale: { to: 1.2, ease: 'outBack(1.7)', duration: 0.3 }` (per-property). Transforms `x y z rotate rotateX rotateY scale scaleX scaleY skew`, percent strings OK (`x: '-50%'`). No `xPercent` / `rotation` / `autoAlpha`. transform-origin goes in CSS.
- **Stagger:** `delay: anime.stagger(0.08)` · `anime.stagger(0.05, { from: 'center' })` · `anime.stagger([0, 0.6])` · `{ grid: [cols, rows], from: 'center' }` · as a position: `tl.add('.dot', {...}, anime.stagger(0.1, { start: 1 }))`.
- **Easing (exact names):** `'linear'`, `'out(3)'`/`'in(3)'`/`'inOut(3)'`, in/out/inOut + Quad Cubic Quart Quint Sine Expo Circ Bounce (`'outExpo'`, `'inOutSine'`), `'outBack(1.7)'`, `'outElastic(1, .4)'`. Functions, not strings: `anime.cubicBezier(.16, 1, .3, 1)`, `anime.steps(6)`, `anime.linear(0, .5, 1)`, `anime.spring({ bounce: .35, duration: 0.6 })`. **Unknown ease names silently become linear**; the strings `'steps(6)'` / `'cubicBezier(..)'` are invalid.
- **Counter:** `tl.add('#revenue', { innerHTML: [0, 1250], modifier: anime.utils.round(0), duration: 1.5 }, 1)`
- **SVG draw:** `const [line] = anime.svg.createDrawable('#line'); tl.add(line, { draw: ['0 0', '0 1'], duration: 1.2, ease: 'inOutQuad' }, 0.5)` — `createDrawable` returns an **array**.
- **Morph:** `tl.add('#shapeA', { d: anime.svg.morphTo('#shapeB'), duration: 0.8 }, 2)` (polygons animate `points`).
- **Motion path:** `tl.add('#dot', { ...anime.svg.createMotionPath('#track'), duration: 3, ease: 'linear' }, 0)`
- **Text split:** `const { chars, words } = anime.text.split('#title', { chars: true, words: true }); tl.add(chars, { y: ['100%', '0%'], opacity: [0, 1], duration: 0.5, delay: anime.stagger(0.03) }, 0.2)`. Masked reveal: `{ words: { wrap: 'clip' } }`. Typewriter: chars with `opacity: [0, 1], duration: 0.01, delay: anime.stagger(0.05)`. Never `scrambleText` (random → not seekable).
- **Proxy (canvas / three / d3):** `const s = { p: 0 }; tl.add(s, { p: [0, 1], duration: 0.8, onUpdate: draw }, 1); draw()` — or `window.__dreambyte.onTick((t) => render(t))`; current time `window.__dreambyte.time()`.

## DreambyteMotion Component Library (available in all scene types)

All scenes load DreambyteMotion — pre-built components that add tweens to the master timeline. Use these instead of hand-writing tweens for common patterns (pass `tl`; times in seconds; `ease` options take anime names like `'outExpo'`).

### TEXT ANIMATIONS — prefer DreambyteMotion.textReveal (text splitting handled for you):

```js
DreambyteMotion.textReveal('.title', { style: 'chars', tl }) // character stagger
DreambyteMotion.textReveal('.subtitle', { style: 'words', tl }) // word stagger
DreambyteMotion.textReveal('.headline', { style: 'mask', tl }) // cinematic mask reveal
DreambyteMotion.textReveal('.code', { style: 'typewriter', tl }) // typing effect
DreambyteMotion.textReveal('.intro', { style: 'scatter', tl }) // chars fly in from random positions
```

### ELEMENT REVEALS:

```js
DreambyteMotion.fadeUp('.element', { tl, delay: 0.3 })
DreambyteMotion.staggerIn('.cards .card', { tl, stagger: 0.1, from: 'start', direction: 'up' })
DreambyteMotion.scaleIn('.icon', { tl, ease: 'outBack(1.7)' })
DreambyteMotion.slideIn('.panel', { from: 'right', tl })
DreambyteMotion.floatIn('.card', { direction: 'up', tl })
DreambyteMotion.flipReveal('.card', { axis: 'Y', tl })
```

### NUMBERS & PROGRESS:

```js
DreambyteMotion.countUp('#revenue', { to: 2400000, format: ',.0f', prefix: '$', tl })
DreambyteMotion.countUp('#growth', { to: 47, suffix: '%', tl })
DreambyteMotion.countUp('#users', { to: 1200000, format: '.2s', tl }) // → 1.2M
DreambyteMotion.progressBar('.bar', { to: 73, tl })
```

### SVG (line draw, morph, motion path):

```js
DreambyteMotion.drawPath('.chart-line path', { tl })
DreambyteMotion.morphShape('#icon', { to: '#icon-target', tl })
DreambyteMotion.pathFollow('.arrow', { path: '#flow-path', tl })
```

### HIGHLIGHT:

```js
DreambyteMotion.highlightReveal('.keyword', { color: '#FFE066', style: 'background', tl })
```

### PRE-MADE LOTTIE ILLUSTRATIONS:

```js
// First: find_media({ kind: 'lottie', query: 'checkmark success' }) → get URL
// Then: DreambyteMotion.lottieSync('#lottie-wrap', { src: url, tl, delay: 0.3 })
```

For custom animations not covered by DreambyteMotion, write anime.js tweens on `window.__tl` directly (see Timeline authoring above).
