---
version: alpha
name: Dreambyte Video Design Language
description: >
  Design tokens and rationale for AI-generated video scenes.
  Every scene the agent builds must be grounded in these values.
  Machine-readable tokens give exact values; prose explains why.

# Default palette — warm neutral. Used when no project palette is set.
# "scene-" prefix distinguishes these from app-UI CSS variables.
colors:
  # Backgrounds — pick ONE per video and COMMIT it. Light is the default (~9/10 of videos).
  scene-bg-light: '#fafaf8' # DEFAULT — explainer / finance / friendly / product
  scene-bg-warm: '#f5f1ea'
  scene-bg-paper: '#f0ece0'
  scene-bg-dark: '#0c0c0e' # opt-in — code / terminal / security / cinematic / night
  scene-bg-slate: '#16181e' # opt-in — data / analytical
  # Text — never pure black or pure white
  text-on-dark: '#f0ece0'
  text-on-light: '#1a1917'
  text-secondary-dark: '#9a9690'
  text-secondary-light: '#5a5650'
  # Color roles — for explainer/diagram/data, color BY MEANING (each role its own hue,
  # 3-6 meaningful colors on a calm canvas). For editorial/typographic scenes, use ONE accent.
  role-entity: '#1e6fd6' # people / nodes / actors
  role-amount: '#b8741a' # numbers / amounts / quantities
  role-success: '#2d8a52' # valid / success
  role-emphasis: '#d6452f' # the one thing to notice; also the hand-drawn marker color
  accent-red: '#c03622'
  accent-blue: '#1e4a8f'
  accent-amber: '#b8741a'
  accent-forest: '#2d5a3d'
  # Forbidden — instant AI-slop tells
  forbidden-cyan: '#00e5ff'
  forbidden-neon-purple: '#a855f7'
  forbidden-gradient-start: '#6366f1'
  forbidden-gradient-end: '#8b5cf6'

typography:
  # Video type scale at 1920x1080. Scale proportionally for other resolutions.
  # Ratio between adjacent levels: minimum 1.5x.
  display:
    fontSize: 140px
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: -0.03em
  heading:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -0.02em
  body:
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: -0.005em
  label:
    fontSize: 26px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0em

# Border-radius at 1920x1080 — scale proportionally.
rounded:
  none: 0px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  full: 9999px

# Spacing at 1920x1080 — scale proportionally.
spacing:
  safe-area: 80px
  section-gap: 120px
  group-gap: 48px
  inner-gap: 16px
  title-to-content-min: 64px
  title-to-content-max: 96px
  card-padding-min: 32px
  card-padding-max: 48px
  element-gap-min: 24px

# Named layout patterns — use these instead of improvising.
# Each pattern has a best-for description and constraints.
components:
  hero-split:
    width: 60/40
    textColor: '{colors.text-on-dark}'
    typography: '{typography.display}'
    rounded: '{rounded.none}'
  stack-breathe:
    gap: '{spacing.group-gap}'
    textColor: '{colors.text-on-dark}'
    typography: '{typography.heading}'
    rounded: '{rounded.none}'
  offset-grid:
    width: 55/45
    rounded: '{rounded.none}'
  focal-point:
    size: 60vw
    annotationCount: 3
    rounded: '{rounded.none}'
  timeline-flow:
    nodeCount: 4
    rounded: '{rounded.md}'
  stat-anchor:
    typography: '{typography.display}'
    alignment: left
    rounded: '{rounded.none}'
  editorial-column:
    maxWidth: 600px
    alignment: left
    rounded: '{rounded.none}'
  scatter-organic:
    rounded: '{rounded.none}'
---

## Overview

Video design for AI is a discipline where the model's default instincts produce
slop: gradient text heroes, cyan-on-dark, bounce easing, particle backgrounds,
centered-everything, Inter. These defaults are the residue of training on
generic web content. This document overrides them with deliberate choices.

The test: if someone looks at the output and immediately says "AI made this,"
the design failed. Good output makes people ask "how was this made?"

**These tokens apply to every scene the agent generates.** Design systems
(Editorial, Bold, Data, etc.) are additive layers on top — they constrain
the application, they never replace the floor this document sets.

## Colors

**Never use pure black (`#000000`) or pure white (`#ffffff`).** Both read as default/lazy.

**Choose ONE background world for the whole video and COMMIT it.** Light
near-white (`{colors.scene-bg-light}`) is the DEFAULT — roughly 9 of 10 videos
(explainer, finance, friendly, product). Use dark (`{colors.scene-bg-dark}`)
only when the subject demands it (code, terminal, security, cinematic, night),
and use it for the WHOLE piece, not scene-by-scene. Don't reach for dark just
because it looks "techy" — that's the AI-slop default.

**Color by meaning (explainer / diagram / data scenes).** Give each semantic
role its own hue: entities (`{colors.role-entity}`), amounts/numbers
(`{colors.role-amount}`), success (`{colors.role-success}`), emphasis/danger
(`{colors.role-emphasis}`). 3–6 meaningful colors on a calm canvas is how real
motion-design reads — the color carries the meaning and creates the contrast.
This REPLACES "one accent" for explainer content. For editorial/typographic
scenes only, keep the one-accent + 60-30-10 restraint (an accent works because
it is rare).

**Never gray text on a colored background.** Use a darker shade of the
background hue instead — gray reads as disconnected from the palette.

**Forbidden palette** — these are instant AI tells, reject on sight:

- `{colors.forbidden-cyan}` or any neon cyan on dark backgrounds
- Purple-to-blue gradients (`{colors.forbidden-gradient-start}` → `{colors.forbidden-gradient-end}`)
- Neon purple (`{colors.forbidden-neon-purple}`)
- Gradient text — solid fills only for all text

Tinting neutrals: add 0.005–0.015 chroma in OKLCH toward the accent hue.
The tint is invisible consciously but creates subconscious palette cohesion.

## Typography

**Video is not a webpage.** Viewers watch on phones, tablets, TVs, and
embedded players at varying distances. Text that looks fine in a browser
at 14px is invisible in video. The 4-step scale in the YAML frontmatter
is the floor — never go smaller than `{typography.label.fontSize}`.

**Font selection protocol:**

1. Write 3 concrete words for the visual tone. Not "modern" or "elegant" —
   those are dead categories. Try: "warm and mechanical and opinionated" or
   "calm and clinical and careful" or "fast and dense and unimpressed."
2. Imagine the font as a physical object: a typewriter ribbon, a hand-lettered
   shop sign, a 1970s mainframe manual, a fabric label, a museum caption.
3. Browse with that object in mind. Reject the first result that "looks designy."

**Banned fonts (instant AI tells):**
Inter, Syne, Space Grotesk, DM Sans, DM Serif Display, Playfair Display,
Outfit, Plus Jakarta Sans, Instrument Sans, Instrument Serif, Fraunces,
Newsreader, Lora, Crimson Pro, Cormorant, IBM Plex Mono, Montserrat,
Open Sans, Roboto, Lato.

**Hierarchy math:** Ratio between adjacent levels must be ≥ 1.5×.
`140 / 64 / 36 / 26` is right. `64 / 48 / 40 / 32` is muddy — too close.

**Dark backgrounds:** Light text reads heavier. Reduce weight by one step
(800 → 700) and increase line-height by 0.05 compared to light equivalents.

**Headlines and display type are ROMAN — never italic.** An upright heading
with one word flipped to italic (`begins as pure, random *noise*`), or an
all-italic display face, is among the most reliable AI tells — it reads as
"trying to look editorial." Carry emphasis on the ONE key word with **weight**
(one step heavier), an **accent color** (a meaning hue), or a **hand-drawn
marker underline** beneath it — not italic. Italic survives only as body-copy
emphasis inside a running paragraph, never on a headline.

## Layout

Do not improvise layouts. Pick one named pattern from the components section
per scene. The patterns exist because they have been tested to create
visual hierarchy from a seated distance.

**Asymmetry is the default.** Left-aligned, offset, broken grid. Center-aligned
layouts are for hero moments and closers only — they read as ceremonial.
Centering a body-copy scene signals a lack of design thinking.

**Whitespace target:** At least 40% of the viewport should be empty.
If a layout feels dense, the answer is always to remove elements — never
to shrink them. Smaller text does not solve density. Fewer elements does.

**Content density hard limits:**

- DEFAULT to ONE idea on screen at a time — a single headline, or a single
  visual with a short label. The best frames hold 1–2 text blocks, not five.
- Maximum 3 text blocks per scene (treat 2 as the norm)
- Maximum 3 bullet items simultaneously — reveal one beat at a time, or split scenes
- Maximum 2 cards or containers — prefer ZERO; whitespace groups without boxes
- Maximum 4 distinct visual elements before combining or cutting
- One "hero element" per scene that owns the frame
- Body text: maximum 2 lines per block (~25 words) — the narration carries the detail

**Spacing:** Use the values in the YAML. Safe area is `{spacing.safe-area}`.
Gap between the title block and first content block is
`{spacing.title-to-content-min}`–`{spacing.title-to-content-max}`. That gap
is what separates competent from designed.

## Elevation & Depth

Motion-design depth is REAL: objects sit in a 3-plane space (background,
content, accents) and the camera moves through it. Build depth from:

- **Soft drop shadows on OBJECTS** (icons, cards, device frames, coins, file
  glyphs) — a diffuse `box-shadow` that reads as a real object floating above
  the canvas. This is how the reference explainers read. (Shadows on TYPE are
  still banned — `text-shadow` on headlines is an instant tell.)
- **Depth-of-field**: blur background layers slightly so the focal layer pops.
- **Parallax**: during a camera move, background layers translate/scale at a
  SMALLER multiplier than the foreground — this sells the 3D space.
- **Motion blur** on fast camera pushes.
- **Size + scale contrast**: foreground at 1.05–1.1× background.

Flat-everything (no shadow, no DOF) is what reads as PowerPoint. Reserve the
no-shadow rule for TYPE, not for objects.

## Shapes & Corners

**Sharp, square edges are the DEFAULT.** `{rounded.none}` for almost
everything — text blocks, columns, hero areas, image/video frames, panels,
the noise/static fields, diagram objects. Rounded-everything is a web tic, not
video design; it makes a scene read as a generic UI screenshot (instant AI
tell). The reference motion-design look is architectural and crisp, not pill-soft.

**NEVER round images, video, or photographic content.** A photo, a thumbnail,
a rendered frame, a clip — these get **square corners** (radius 0) and at most a
hairline edge. Rounded image corners are one of the most reliable AI-slop tells.
If a frame needs definition, use a 1px rule or a thin inset border, not a radius.

**Rounding is a deliberate, rare exception** — reserved ONLY for elements that
genuinely read as interactive controls (a real pill button, a search input).
Even then use the smallest radius that reads (`{rounded.sm}`). If you can't name
why an element is rounded, it isn't.

**No glassmorphism / translucent "frosted" containers as decoration.** A
semi-transparent blurred navy/dark card floating behind text is slop — it's the
2022 generated-UI default. Group with whitespace, alignment, and shared color;
not with a glassy box. A container earns its place only when it must visually
contain something for a semantic reason — prefer ZERO containers (see Layout).

## Components

### Hero-Split

Large text left (60% width), visual/illustration right (40%). Text
left-aligned, type at `{typography.display}`. Visual can bleed to edge.
Best for: introductions, key statements, definitions, chapter titles.

### Stack-Breathe

Full-width text blocks stacked vertically with `{spacing.group-gap}`+
gaps. No containers or cards. Whitespace does the grouping.
Best for: single concepts, quotes, manifestos, definitions.

### Offset-Grid

2-column asymmetric grid at 55/45 or 65/35 split. Columns intentionally
do NOT align horizontally — the offset creates visual tension and interest.
Best for: comparisons, before/after, two related concepts.

### Focal-Point

One large central element (60%+ of viewport) with 2–3 small annotations
around it connected by subtle leader lines or arrows.
Best for: diagrams, anatomy shots, feature callouts, product highlights.

### Timeline-Flow

Horizontal or vertical connected nodes, max 4 per scene.
Best for: processes, chronology, step sequences, cause-and-effect chains.

### Stat-Anchor

One massive metric at `{typography.display}` anchored left or top-third.
Supporting text in `{typography.body}`. NOT centered — the anchor is a
deliberate asymmetric choice. Best for: key statistics, impact numbers,
proof points.

### Editorial-Column

Single narrow text column (max 600px at 1080p) offset to the left third.
Full-bleed background, image, or illustration fills the rest.
Best for: narrative text, storytelling, essay adaptations, book summaries.

### Scatter-Organic

Elements at intentional non-grid positions, varying in size. Connected by
subtle lines, shared color, or proximity — not borders or containers.
Best for: mind maps, ecosystem overviews, relationship diagrams.

## Motion & Camera

A scene is a short sequence of distinct BEATS, like a Premiere Pro / kinetic-
typography cut — not "build everything, then freeze," and never one decorative
animation looping the whole scene (no perpetual `frame % N` drift / pulse / spin
/ particles as the primary motion).

- **Beat = Build → Breathe → Resolve.** Build: elements enter, staggered. Breathe:
  ONE varied ambient move (vary it — pan, scale, color-shift, not always zoom).
  Resolve: the beat exits or transforms into the next. Exits run faster than entrances.
- **Easing = emotion.** Entrances `cubic-bezier(0.16,1,0.3,1)` / anime.js `'outExpo'`
  (fast in, decelerate). Exits `cubic-bezier(0.7,0,0.84,0)` / `'inQuart'`. Never
  bounce/elastic; never linear on position.
- **Speed = weight.** 0.15–0.3s energy/urgency · 0.3–0.5s most content · 0.5–0.8s
  gravity/premium.
- **Camera moves, always.** push-in · pull-back · pan · hold. The camera is never
  fully locked — a slow continuous drift keeps the frame alive.
- **Transitions are camera moves, not slide swaps.** Between beats: match-cut (a
  carried element persists across the cut), zoom-into (push into an element), pull-
  back-from, directional-push (exit and enter share a motion vector), or dissolve.
  A hard cut is allowed and first-class — a transition on EVERY seam is its own tell.
- **ALL text routes through the text-motion catalog.** Every headline, label,
  word, line, and text swap enters (and exits) via a NAMED effect from the
  text-motion catalog (`apps/desktop/src/lib/generation/text-anim-catalog.ts`: letter-lift,
  word-cascade, slot-roll, soft-focus, wipe-reveal, typewriter, …) applied with its
  EXACT timing/stagger/easing — never an ad-hoc opacity fade or a hand-rolled
  reveal. VARY the effect per beat; never reuse the same reveal twice in a row.
  Each text beat animates OUT (its catalog exit) as the camera leaves it.

## Seam Continuity (match-frame handoffs)

A multi-scene video must read as ONE continuous camera navigating a canvas — not a
slideshow of separate clips. The ONLY thing that makes a scene→scene seam seamless is
a **match-frame handoff**: the LAST frame of a scene is (near) pixel-identical to the
FIRST frame of the next, so the cut/crossfade is invisible.

- **Shared handoff element.** Pick one element both scenes hold at the boundary — the
  SAME object/image, or a full-screen texture. Render it with IDENTICAL code, position,
  size, and a **camera at rest** on both sides. A crossfade only hides a seam when the
  WHOLE frame matches; if the two elements differ even slightly (a missing detail, a
  drifted camera, a different size) the dissolve exposes it and it reads as a cut.
- **Clean boundary.** Everything scene-specific — headlines, labels, secondary objects,
  annotations, camera drift — animates IN _after_ the start and OUT _before_ the end, so
  the boundary frame is JUST the shared handoff element. Camera drift lives in the scene
  interior and RETURNS to the handoff pose before the end.
- **No shared element? Hand off through a texture.** Black or noise/static are
  _forgiving_ handoffs — uniform/stochastic, so they need no pixel-alignment. The
  outgoing content animates out to that texture; the incoming animates in from it. (A
  distinct object — a photo, a shape — is UNforgiving and must match exactly.)
- **Then the transition is trivial.** With matched boundary frames, a hard cut or a
  short crossfade is invisible. The transition is not what creates continuity — the
  matched frames are.
- **Author each scene "continuing from the end of the prior one":** its first frame
  reproduces the previous scene's last frame, then it moves. That is the Premiere/AE
  continuous-motion feel.

## Real Objects

Illustrate concrete things with recognizable, skeuomorphic OBJECTS — a file glyph,
a device frame, a code-editor window, a server rack, an avatar bubble, a coin —
rendered as inline SVG or styled CSS, each with a soft object drop-shadow, sitting
in the 3-plane space. Real objects read instantly and carry the multi-color contrast.
Do NOT use emoji as a hero element (emoji are banned in scene text entirely — see
Don'ts). Abstract boxes-and-dots are the fallback, not the default.

## Hand-Drawn Emphasis

At the single emphasis beat of a scene, draw a rough hand-drawn marker annotation ON
TOP — a circle, arrow, or underline — using an irregular (slightly wobbly) stroke
path in emphasis red (`{colors.role-emphasis}`), revealed with a quick draw-on. Like
a teacher annotating. Use it sparingly: at most one per beat, and not every scene.

## No Chrome

The frame is the content, not a slideshow. NEVER add scene-number or section
kickers ("01 —", "02 / TITLE", "STEP 3"), a progress / duration bar or any playback
indicator, or persistent corner labels / headers / footers / page numbers /
watermarks. Don't title the scene on-screen — show the idea; the narration names it.

**No re-drawn UI chrome.** Do NOT hand-build fake interface chrome: a browser
bar (URL pill + traffic-light dots), a fake search/prompt input bar with a colored
status dot, a fake phone frame (rounded rect + notch), a fake code-window (title
bar + close/minimise dots around a `<pre>`), or fake IDE/terminal chrome. The
audience reads re-drawn chrome as "the AI invented a UI that already exists" in a
glance — and the navy glassy bar is the worst offender. To show a typed prompt,
set the text bare on the canvas (large, with the inline caret that signals "you'd
type next") — the typing IS the affordance; it needs no box. To show an image,
place it square-edged with at most a hairline rule — never in a rounded frame.

## Do's and Don'ts

**Do:**

- Pick one layout pattern per scene from the named list above
- Color BY MEANING for explainer/diagram/data (each semantic role its own hue);
  reserve the one-accent rule for editorial/typographic scenes only
- Commit ONE background world for the whole video; light near-white is the default
- Illustrate concrete things as real skeuomorphic objects (SVG/CSS) with soft shadows
- Choose fonts using the physical-object protocol; reject the reflex pick
- Scale type from the 4-step video scale; `{typography.label.fontSize}` is the floor
- Leave 40%+ viewport as empty space; remove elements before shrinking text
- Vary camera motion across scenes — three identical motions in a row is worse
  than a slightly wrong motion
- Use exponential easing: `cubic-bezier(0.16, 1, 0.3, 1)` for entrances,
  `cubic-bezier(0.7, 0, 0.84, 0)` for exits

**Don't:**

- Never bounce or elastic easing — dated since 2015
- Never linear easing on spatial movement — it looks robotic
- Never gradient text — solid fills only
- Never the forbidden palette (cyan, purple-to-blue, neon on dark)
- Never side-stripe borders on cards (`border-left: 4px solid ...`)
- Never identical card grids (same-size icon + heading + text repeated)
- Never the hero-metric layout (big number + gradient accent) as a default
- Never center-align body scenes — reserve centering for hero/closer moments
- Never use a banned font — if you're tempted, consult the physical-object protocol
- Never `Math.random()` in scene code — use deterministic seed functions
- Never add drop shadows to TEXT in video (object drop-shadows are fine — see Elevation)
- Never emit emojis in scene text or annotations (use SVG/CSS objects instead)
- Never add scene-number/section kickers, a progress/duration bar, or persistent
  corner labels/headers/footers/watermarks — the frame is the content, not a slide
- Never loop one decorative animation for the whole scene as the primary motion
- Never round images, video, or photographic frames — square corners + hairline rule
- Never default-round containers/panels — sharp edges are the default; rounding is rare + deliberate
- Never re-draw UI chrome (browser bar, prompt/search input box with a status dot,
  phone/code/IDE/terminal frame) — set the content bare on the canvas
- Never a glassy / frosted translucent container as decoration — group with whitespace
- Never italicize a headline or display word for emphasis — use weight, accent color, or a drawn underline
- Never reveal text with an ad-hoc fade — every text beat uses a NAMED text-motion catalog effect (enter + exit)
