# EDITOR-DESIGN.md — dreambyte Editor UI

> Design system for the **editor application chrome**. Two states: **dark** (default)
> and **light**. Plain-text design system in the
> [Stitch DESIGN.md format](https://stitch.withgoogle.com/docs/design-md/format/), structured per
> [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md).
>
> **This is NOT the scene design system.** `docs/DESIGN.md` governs AI-generated _video scene_
> tokens and is unrelated to app UI. This file governs the _editor interface_ — panels, buttons,
> timeline, inputs. Keep them separate; never cross the tokens.
>
> **Visual review:** open `docs/editor-design-preview.html` in a browser and use the top-right
> Dark/Light toggle. That preview is the living catalog of every token and component below.

This system follows the Dreambyte brand's **monochrome editorial** language: a
single Inter typeface, a black/white action language that inverts per
theme, a neutral text ladder, and hairline dividers. The editor adds exactly **one** reserved
functional accent (Signal Blue) for timeline and selection states — nothing else gets color.

**Visual target: a professional dark NLE.** The editor reads as
a precise instrument — charcoal-neutral surfaces, **dense flat property inspectors** (label + value

- stepper + keyframe, grouped under headers — _not_ cards), clip-type colors in the timeline, an
  asset grid, a floating tool palette, track headers with mute/solo, and audio meters. Signal Blue
  appears only for machine state: the selected tool, the playhead, mute/solo, the active keyframe,
  focus, selection. The full editor-surface vocabulary is specified in §12.

---

## 1. Visual Theme & Atmosphere

**Monochrome editorial, with one signal.**

The interface is quiet. Color is not decoration — it is information. Every surface is a neutral
gray (dark) or a neutral white (light). The only chromatic element in the entire chrome is
**Signal Blue**, and it appears only where the user needs to track machine state: the timeline
playhead, the current selection, the active tab, the focus ring, the snap line. If something is
blue, it means "this is live / selected / focused." Nothing else is allowed to be blue.

Actions are black or white. On the light theme, the primary action is a black pill; on the dark
theme it inverts to a white pill. This is the website's `btn-primary` / `btn-primary-on-dark`
pattern, carried into the app verbatim.

Texture is structural, not ornamental: hairline dividers separate regions, surface elevation
(lighter panel on dark, soft shadow on light) communicates depth. No gradients in chrome, no
glows, no decorative blobs, no rounded-bubble everything.

**Mood words:** precise, calm, editorial, instrument-like. The editor should feel like a
well-made tool, not a consumer app. The user's content (the video) is the only thing on screen
allowed to be loud.

**Anti-mood:** SaaS-template, neon, glassmorphism, gradient-heavy, "fun." See AI slop list in §7.

---

## 2. Color Palette & Roles

Tokens are CSS custom properties. Names are semantic (role-based), not literal — `--bg`,
not `--gray-900`. Each role has a dark value and a light value. The editor keys themes with a
class on the root element: default (no class) = **dark**; `.light-theme` = **light**.

### 2.1 Surfaces

| Token            | Role                                        | Dark               | Light                 |
| ---------------- | ------------------------------------------- | ------------------ | --------------------- |
| `--bg`           | App canvas / editor viewport backdrop       | `#121212`          | `#ffffff`             |
| `--panel`        | Side panels, header, footer, timeline shell | `#1a1a1a`          | `#ffffff`             |
| `--panel-2`      | Nested panel / sunken region                | `#0f0f0f`          | `#fafaf8`             |
| `--card`         | Cards, list rows, menu surfaces             | `#232323`          | `#f5f5f5`             |
| `--card-hover`   | Card / row hover                            | `#2c2c2c`          | `#eeeeee`             |
| `--input-bg`     | Text inputs, selects, search                | `#0c0c0c`          | `#f4f4f6`             |
| `--surface-cool` | Media placeholder / empty fill              | `#1d1d1d`          | `#eef1f4`             |
| `--scrim`        | Modal/overlay backdrop                      | `rgba(0,0,0,0.62)` | `rgba(15,17,21,0.45)` |

Dark surfaces use **inverted elevation**: the app canvas (`--bg`) is the darkest layer and panels
sit _lighter_ on top. Light surfaces are the opposite — panels are white and depth comes from
shadow, not lift.

### 2.2 Hairlines & borders

| Token               | Role                                | Dark                     | Light     |
| ------------------- | ----------------------------------- | ------------------------ | --------- |
| `--hairline`        | 1px region dividers                 | `rgba(255,255,255,0.08)` | `#ededed` |
| `--hairline-strong` | Emphasized divider, control borders | `rgba(255,255,255,0.14)` | `#e4e4e2` |
| `--border-input`    | Input border (resting)              | `rgba(255,255,255,0.12)` | `#dcdce0` |

### 2.3 Text ladder

Mirrors the website's ink → ash ladder. On dark, the ladder inverts to **neutral greys** — no
blue cast, and **not** the legacy warm `#f0ece0`. (Token names like `--slate` are roles, not hues;
the dark values are true greys.)

| Token        | Role                          | Dark      | Light     |
| ------------ | ----------------------------- | --------- | --------- |
| `--ink`      | Primary text, headings        | `#f4f4f4` | `#111111` |
| `--ink-soft` | Strong body, labels           | `#d6d6d6` | `#2a2a2a` |
| `--graphite` | Secondary text                | `#b0b0b0` | `#4d4d4d` |
| `--slate`    | Tertiary, metadata            | `#8a8a8a` | `#5b6472` |
| `--mute`     | Muted, captions, placeholders | `#6e6e6e` | `#8a8a8a` |
| `--stone`    | Disabled text                 | `#585858` | `#9a9a9a` |
| `--ash`      | Faintest hint, "coming soon"  | `#404040` | `#b6b6b6` |

Body text never goes below `--mute`. Placeholder text uses `--mute`; it is never the only label
for a field (see §4.3).

### 2.4 Action language (monochrome, inverts per theme)

| Token         | Role                   | Dark      | Light     |
| ------------- | ---------------------- | --------- | --------- |
| `--action`    | Primary button fill    | `#f4f4f4` | `#111111` |
| `--on-action` | Text on primary button | `#121212` | `#ffffff` |

Ghost buttons use `--ink` for border + text and invert on hover. There is no colored button
anywhere in the system. Primary hover = opacity 0.90; active = opacity 0.82.

### 2.5 Signal Blue — the one functional accent

The **only** chromatic color in the chrome. Reserved for machine-state signals. Brighter on dark
for contrast (matches the editor's existing dark-accent value), standard on light.

| Token           | Role                                                           | Dark                    | Light                  |
| --------------- | -------------------------------------------------------------- | ----------------------- | ---------------------- |
| `--accent`      | Playhead, selection ring, active tab, focus ring, snap, "live" | `#4a9eff`               | `#2563eb`              |
| `--accent-soft` | Selection fill, focus halo (low alpha)                         | `rgba(74,158,255,0.22)` | `rgba(37,99,235,0.14)` |

**Allowed uses:** timeline playhead, clip selection ring, active-tab underline, input focus ring,
snap guide, in-progress/recording indicator, drag-ghost border.
**Forbidden uses:** button fills, links, icons-at-rest, headings, hover states of neutral
controls, decorative fills, charts (charts have their own palette, §2.7).

### 2.6 Status colors (semantic only, used sparingly)

For destructive confirms, errors, and success toasts. Never for chrome decoration.

| Token       | Role                        | Dark      | Light     |
| ----------- | --------------------------- | --------- | --------- |
| `--danger`  | Errors, destructive actions | `#f87171` | `#dc2626` |
| `--warn`    | Warnings                    | `#fbbf24` | `#d97706` |
| `--success` | Success, saved              | `#34d399` | `#059669` |

### 2.7 Chart palette (data viz only)

Recharts / D3 scenes only. Isolated from chrome so adding a chart never introduces color into the UI.

| Token       | Dark      | Light     |
| ----------- | --------- | --------- |
| `--chart-1` | `#4c9be8` | `#2563eb` |
| `--chart-2` | `#e86b4c` | `#e11d48` |
| `--chart-3` | `#4ce8a0` | `#16a34a` |
| `--chart-4` | `#e8c84c` | `#ca8a04` |
| `--chart-5` | `#9b4ce8` | `#7c3aed` |

### 2.8 Timeline tokens

The timeline is the densest surface and needs its own scoped set. Clip-type hues are
**data colors** (like charts) — saturated enough to read at a glance per the NLE reference, but
selection still wins because only the selected clip gets the Signal-Blue ring + the playhead is the
only pure blue. (Clip-type purple is a data color, exempt from the no-purple chrome rule.)

| Token                   | Role                        | Dark            | Light           |
| ----------------------- | --------------------------- | --------------- | --------------- |
| `--tl-bg`               | Timeline backdrop           | `#0d0d0d`       | `#ffffff`       |
| `--tl-track`            | Track lane                  | `#1a1a1a`       | `#ffffff`       |
| `--tl-track-alt`        | Alternating lane            | `#1f1f1f`       | `#f7f7f9`       |
| `--tl-header`           | Track header column         | `#202020`       | `#f5f5f7`       |
| `--tl-border`           | Lane / clip separators      | `#2b2b2b`       | `#e4e4ea`       |
| `--tl-ruler-tick`       | Ruler major tick            | `#6e6e6e`       | `#999999`       |
| `--tl-ruler-tick-minor` | Ruler minor tick            | `#3a3a3a`       | `#cccccc`       |
| `--tl-playhead`         | Playhead                    | `var(--accent)` | `var(--accent)` |
| `--tl-clip-video`       | Video clip                  | `#4a7fb5`       | `#6ab0d0`       |
| `--tl-clip-audio`       | Audio clip                  | `#3fa873`       | `#4ec48c`       |
| `--tl-clip-image`       | Image / logo clip           | `#c2853a`       | `#d8a35c`       |
| `--tl-clip-title`       | Caption / title / text clip | `#b04a8c`       | `#c46aa4`       |
| `--tl-clip-adjustment`  | Adjustment / effect layer   | `#6d5bc4`       | `#8a7ad8`       |
| `--tl-clip-selected`    | Selected clip ring          | `var(--accent)` | `var(--accent)` |
| `--tl-snap`             | Snap guide                  | `#22d3ee`       | `#0ea5e9`       |
| `--tl-waveform`         | Audio waveform              | `#4ec48c`       | `#2ecc71`       |

---

## 3. Typography Rules

**One typeface: Inter Variable**, loaded via `@fontsource-variable/inter`, with feature settings
that make the terminals read flatter, closer to the brand's grotesque:

```css
:root {
  --font-ui: 'Inter Variable', system-ui, -apple-system, sans-serif;
}
body {
  font-family: var(--font-ui);
  font-feature-settings:
    'cv05' 1,
    'ss01' 1;
  -webkit-font-smoothing: antialiased;
}
```

`system-ui` / `-apple-system` are fallbacks only, never the primary face (see §7).

### 3.1 Scale

The website scale is marketing-weight (display 49px). The editor is a dense app, so the scale has
two tiers: an **expressive tier** (welcome screen, empty states, modals) lifted from the website,
and a **UI tier** for dense chrome. The UI default is **13px** (matches the website nav).

| Token        | Size / line-height / tracking | Weight | Use                                         |
| ------------ | ----------------------------- | ------ | ------------------------------------------- |
| `display`    | 49 / 1.0 / -1.4px             | 600    | Welcome screen, hero empty states           |
| `heading-lg` | 37 / 1.0 / -1.0px             | 600    | Modal titles, section heroes                |
| `heading-md` | 24 / 1.05 / -0.3px            | 600    | Panel section titles                        |
| `heading-sm` | 18 / 1.1 / -0.2px             | 600    | Card titles, group headers                  |
| `subtitle`   | 16 / 1.3 / -0.16px            | 500    | Sub-headings, prominent labels              |
| `body`       | 14 / 1.5 / 0                  | 400    | Body copy, descriptions                     |
| `ui`         | 13 / 1.3 / 0                  | 450    | **Default UI text** — controls, menus, rows |
| `label`      | 12 / 1.3 / 0                  | 500    | Field labels, table headers                 |
| `meta`       | 12 / 1.3 / -0.12px            | 400    | Metadata, timestamps, hints                 |
| `eyebrow`    | 13 / 1.4 / 0.35px             | 500    | Uppercase eyebrows / section kickers        |
| `micro-caps` | 11 / 1.3 / 0.2px              | 450    | Uppercase micro-labels, badges              |

**Minimum UI text: 11px; minimum body: 12px.** (Scene/video text follows a separate rule — min
24px at 1080p — that rule is unchanged and lives in the scene generators, not here.)

### 3.2 Weights

Inter Variable: 400 (body), 450 (UI default), 500 (labels / medium), 600 (headings / semibold).
Avoid 700+ in chrome — it reads heavy against the editorial tone. Bold is for headings only.

### 3.3 Case & tracking

Uppercase is reserved for `eyebrow` and `micro-caps` with positive tracking. Body and UI text are
sentence case with neutral tracking. Large display text gets negative tracking (compress the
silhouette) per the table.

---

## 4. Component Stylings

All components use the tokens above. States: resting, hover, active/pressed, focus, disabled.

### 4.1 Buttons

Three ranks. The **default shape is a compact rounded-rectangle** (`--radius-md`, 32px tall, weight 500) — the Figma-style control used throughout the chrome. The **pill** (`.pill`, `--radius-pill`,
40px, weight 600) is opt-in and reserved for hero CTAs on the welcome / onboarding screens only. A
toolbar-dense size (`.dense`, 28px) is available for in-panel rows.

**Primary:**

- Fill `--action`, text `--on-action`. Default 32px tall, 14px padding, `--radius-md`.
- Hover: opacity 0.90. Active: opacity 0.82. Focus: 2px `--accent` outline, 2px offset.
- Disabled: `--stone` text on `--card`, no pointer.

**Ghost / secondary:**

- Transparent fill, 1px `--hairline-strong` border, text `--ink`.
- Hover (Figma-subtle): fill `--card-hover`, border `--graphite`, text stays `--ink`. (This replaces
  the website's full ink-invert hover with a quieter fill, which reads cleaner in dense UI.)

**Quiet / tertiary:**

- Text only, color `--graphite`. Hover: color `--ink`, optional `--card` fill. No border.

**Hero CTA (`.pill`):** primary or ghost at 40px, pill radius, weight 600 — welcome / onboarding only.

Never a colored button. Destructive actions use a ghost button with `--danger` text; on confirm
hover they fill `--danger`.

### 4.2 Icon controls (header / sidebar)

Flat, no keyboard-cap styling. Use the `electron-titlebar-icon` / flat header pattern — **never**
the `.kbd` raised style on nav or sidebar items. Small inline icons are `<span>` elements, not
`<button>`, to avoid inheriting global button styles. Size 28–32px square hit area, icon 16–18px,
color `--graphite` resting → `--ink` hover, `--card` hover fill, `--radius-sm`.

### 4.3 Inputs & fields

- **Label is always visible above the field.** Placeholder is a hint, never the only label.
- Fill `--input-bg`, 1px `--border-input`, text `--ink`, placeholder `--mute`, `--radius-md`.
- Height 32px (dense) / 40px (comfortable). Padding 12px horizontal.
- Focus: border `--accent`, 3px `--accent-soft` halo. Never remove the outline without a replacement.
- Error: border `--danger`, helper text `--danger` below.
- Disabled: `--panel-2` fill, `--stone` text.

Selects, search fields, and textareas share these tokens. Search field carries a leading
magnifying-glass icon in `--mute` (convention — don't reinvent it).

### 4.4 Cards & rows

- Surface `--card`, hover `--card-hover`, 1px `--hairline` border (dark) or soft shadow (light).
- Radius `--radius-md`. Padding 12–16px. Title `heading-sm`, meta `--slate`.
- Cards earn their existence — do not wrap plain lists in card chrome. A list of layers is rows
  with hairline dividers, not a grid of cards.
- No colored left-border accent on cards (AI slop, §7).

### 4.5 Panels (the editor shell)

- **Header bar:** `--panel`, hairline-bottom, height 48px. Holds logo, project name, global actions.
- **Side panels (Layers / Settings):** `--panel`, hairline divider against canvas. Section titles
  `heading-md` in `--ink`; group headers `eyebrow` in `--slate`. (Scene palette/style controls live
  in the Layers tab; the Settings panel is system-only — keep that separation.)
- **Footer / status bar:** `--panel`, hairline-top, height 28px. **This is where save state lives**
  — a status-bar message ("Saved", "Saving…"), not per-layer dots or per-field ticks.
- **Canvas / preview:** `--bg`, the content is the video; chrome stays out of the way.

### 4.6 Tabs

- Resting: label `--graphite`, no underline. Hover: `--ink`.
- Active: label `--ink`, 2px `--accent` underline (the active-state signal). Active tab is the
  only place a tab shows color.

### 4.7 Dropdown / context menus

- Surface `--card`, 1px `--hairline-strong`, `--radius-lg`, shadow `--shadow-md`.
- Item: `ui` text `--ink-soft`, padding 8px 14px, hover `--card-hover`.
- Trailing hint ("Coming soon", shortcuts) in `--ash`, italic for status hints.
- Separators are hairlines, full-bleed.

**Reference implementation (canonical):** the agent-chat **model picker**
(`apps/desktop/src/components/AgentChat.tsx`, the model menu) is the pattern exemplar for every new
selector/menu in the editor — a flat column of rows, each `name` in the `ui` token
(13px / 450) + an optional `desc` in `--mute`, sections split by full-bleed hairlines,
a trailing `Check` (13px) in `--mute` on the selected row, opens `--radius-lg` with
`--shadow-md`. Build new menus to match it.

### 4.8 Tooltips

- Surface inverts the theme (dark tooltip on light UI, light tooltip on dark UI) for contrast.
- `meta` text, `--radius-sm`, padding 6px 8px, `--shadow-sm`. Delay 400ms. No accent.

### 4.9 Badges & pills

- Neutral badge: `--card` fill, `micro-caps` text `--slate`, `--radius-pill`.
- Status badge: `--danger` / `--warn` / `--success` text on a low-alpha tint of the same color.
- "Live"/recording badge is the one place Signal Blue may fill a badge.

### 4.10 Switches & toggles

Figma-style switch. Track 30×20px, `border-radius: 72px`, 14px white knob with 3px inset, slide
distance 10px, transition `all 100ms ease-out` (snappier than the chrome's `--dur-base`).

- **Off:** track `--switch-off` (`#3a3a3a` dark / `#dfe1e4` light), white knob. Hover: `--switch-off-hover`.
- **On:** track `--accent` (Signal Blue — on/off is a machine state, so the switch is the one toggle
  allowed to show color), white knob slid right. Hover: `--accent-strong`.
- **Focus:** 2px `--accent` outline, 2px offset.
- The **theme toggle** uses this exact switch. Theme is a **global** preference — it persists across
  projects and does not change when the agent updates a scene's `globalStyle`.

---

## 5. Layout Principles

### 5.1 Spacing scale (4px base)

```
--space-1: 4px   --space-2: 8px    --space-3: 12px   --space-4: 16px
--space-5: 20px  --space-6: 24px   --space-8: 32px   --space-12: 48px
--space-16: 64px --space-24: 96px
```

Marketing-weight regions (welcome screen) use `--space-16` / `--space-24` section rhythm (the
website's `section` / `section-lg`). Dense chrome uses `--space-2` / `--space-3` / `--space-4`.

### 5.2 Grid & shell

- Editor is a three-region shell: left/right side panels + center canvas, with the timeline docked
  below. Panels are fixed-width and resizable; canvas is fluid.
- Marketing/empty/welcome content uses `max-width: 1280px` (`--max-shell`), centered, 24px gutters.

### 5.3 Whitespace

Generous within panels, tight within rows. Group related controls with proximity, separate groups
with a hairline or one full space step — not with boxes. When a region feels empty, the fix is
better content or honest emptiness, never decorative filler.

### 5.4 Radii

```
--radius-xs: 4px   --radius-sm: 6px   --radius-md: 8px   --radius-lg: 16px   --radius-pill: 9999px
```

Radius communicates rank: pills for hero actions, `md` for controls/cards, `sm` for icon buttons.
Do not apply one large radius uniformly to every element (AI slop, §7).

---

## 6. Depth & Elevation

Depth is theme-specific. **Dark uses surface lift** (lighter panel on darker canvas); shadows
barely read on dark, so they stay faint. **Light uses soft shadows**; surfaces stay white.

```
/* Light theme shadows (soft, editorial — from the website nav menu) */
--shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
--shadow-md: 0 12px 36px -14px rgba(0,0,0,0.22);
--shadow-lg: 0 24px 60px -20px rgba(0,0,0,0.28);

/* Dark theme — elevation by lift + hairline, minimal shadow */
--shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
--shadow-md: 0 16px 40px -16px rgba(0,0,0,0.6);
--shadow-lg: 0 28px 64px -22px rgba(0,0,0,0.7);
```

Elevation order (low → high): `--bg` → `--panel` → `--card` → menu/popover → modal. Each step is
one lift on dark, one shadow tier on light. Never stack more than two elevation cues on one element.

---

## 7. Do's and Don'ts

**Do**

- Use CSS variables for every color. No hardcoded hex in components.
- Keep Signal Blue strictly functional — selection, playhead, active, focus.
- Make actions black/white and let them invert with the theme.
- Use hairlines and spacing for separation; let surfaces stay flat.
- Keep one job per panel section; label groups with quiet eyebrows.
- Show save state in the footer status bar.
- Keep icon controls flat (no `.kbd` raised style) on nav/sidebar; small icons as `<span>`.

**Don't**

- Don't introduce a second accent color, ever.
- Don't put color on buttons, links-at-rest, or headings.
- Don't use the legacy warm off-white (`#f0ece0`) for dark text — use neutral `--ink`.
- Don't wrap plain lists in card grids.
- Don't use emojis anywhere — chrome, docs, status badges, plans, or code. Use text labels.
- Don't put scene palette/style controls in the Settings panel (Layers tab only).

**AI slop blacklist (instant fail)**

1. Purple/violet/indigo gradients or blue→purple schemes.
2. The 3-column icon-in-circle feature grid.
3. Icons in colored circles as decoration.
4. Centering everything.
5. One large border-radius on every element uniformly.
6. Decorative blobs / floating circles / wavy dividers.
7. Emoji as design elements.
8. Colored left-border on cards.
9. Generic hero copy ("Unlock the power of…").
10. `system-ui` / `-apple-system` as the **primary** font — Inter is the face; system fonts are fallback only.

---

## 8. Responsive Behavior

The editor is a desktop Electron app — the primary target is large viewports. "Responsive" here
means panel and density behavior, not a phone layout.

| Width       | Behavior                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| ≥ 1440px    | Comfortable: both side panels open, full timeline, comfortable control heights (40px).   |
| 1024–1440px | Default: panels open, dense control heights (28–32px), timeline track headers narrow.    |
| < 1024px    | Compact: one side panel collapses to an icon rail; the other overlays. Timeline scrolls. |

- **Touch targets:** 44px minimum where touch is possible (web/tablet); 28px minimum acceptable
  for mouse-only dense desktop controls.
- **Resizable panels:** persist width per user (global), with sensible min/max.

---

## 9. Accessibility

- **Contrast:** body/UI text meets WCAG AA (≥ 4.5:1) against its surface. `--ink`, `--ink-soft`,
  `--graphite`, `--slate`, `--mute` are all ≥ 4.5:1 on their theme surfaces; `--stone` and `--ash`
  are for disabled/hint only and are exempt. Verify any new pairing.
- **Focus visible:** every interactive element has a visible focus state — 2px `--accent` ring with
  offset, or 3px `--accent-soft` halo on inputs. Never remove the outline without a replacement.
- **Keyboard nav:** full tab order through panels, timeline, and dialogs. Arrow-key navigation
  within the timeline and layer lists. Escape closes menus/modals.
- **Labels:** every field has a visible `<label>`; icon-only controls have `aria-label`. Placeholder
  is never the sole label.
- **Motion:** honor `prefers-reduced-motion` — drop entrance/scroll motion, keep state changes.
- **Color is never the only signal:** selection also shows a ring + lift; errors also show text;
  active tab also shows an underline. A colorblind user never depends on Signal Blue alone.

---

## 10. Motion

One easing curve — **swift** — and a small set of durations. Motion clarifies state; it never
decorates.

```
--ease-swift: cubic-bezier(0.22, 1, 0.36, 1);
--dur-fast: 150ms;   /* hovers, color/opacity */
--dur-base: 200ms;   /* toggles, menu open, theme switch */
--dur-slow: 300ms;   /* panel slide, layout shifts */
--dur-enter: 700ms;  /* first-paint / welcome entrance only */
```

- Hover/active: `--dur-fast`, opacity or color only.
- Menus, dropdowns, theme toggle: `--dur-base` with `--ease-swift`.
- Panel resize/collapse: `--dur-slow`.
- Theme switch crossfades surfaces over `--dur-base`; it does not animate text.
- No spring physics or bounce in chrome. No looping/idle animation.

---

## 11. Agent Prompt Guide

When asking an agent to build or change editor UI, paste this:

> Use dreambyte's docs/EDITOR-DESIGN.md. Monochrome editorial: surfaces are neutral, the only accent
> is Signal Blue (`--accent`) reserved for playhead / selection / active tab / focus — never on
> buttons or decoration. Actions are black/white and invert per theme (`--action` / `--on-action`).
> Type is Inter Variable; UI default 13px, body 14px, headings 600 weight. Use the CSS variables
> for all colors (no hardcoded hex). Radii: pill for hero CTAs, `--radius-md` for controls. One
> easing: `--ease-swift`. Support both `.light-theme` and default dark. No emojis, no second
> accent, no colored buttons, no card grids for plain lists. (This is editor chrome — do not mix in
> the scene `docs/DESIGN.md` tokens.)

### Quick color reference

|                          | Dark                     | Light     |
| ------------------------ | ------------------------ | --------- |
| App bg                   | `#121212`                | `#ffffff` |
| Panel                    | `#1a1a1a`                | `#ffffff` |
| Card                     | `#232323`                | `#f5f5f5` |
| Primary text (`--ink`)   | `#f4f4f4`                | `#111111` |
| Action fill              | `#f4f4f4`                | `#111111` |
| Signal Blue (`--accent`) | `#4a9eff`                | `#2563eb` |
| Hairline                 | `rgba(255,255,255,0.08)` | `#ededed` |

---

## 12. Editor surfaces (NLE patterns)

These are the editor-specific surfaces beyond generic settings. The governing rule: **inspectors and timelines are dense flat rows grouped under
headers — never cards.** Cards are reserved for discrete content objects (asset tiles, scene tiles).

### 12.1 Editor shell

Four regions on `--bg`, divided by hairlines (no heavy borders):

```
┌──────────┬───────────────────────────┬───────────────┐
│ Assets   │        Canvas / preview   │  Inspector    │
│ (left    │        (scene info bar +  │  (right rail, │
│  panel)  │         floating toolbar) │   properties) │
├──────────┴───────────────────────────┴──────┬────────┤
│ Timeline (tracks + ruler + playhead)         │ Meters │
└──────────────────────────────────────────────┴────────┘
```

- Panels: `--panel`. Region dividers: 1px `--hairline`. No drop shadows between docked regions —
  depth is by surface value only.
- Scene-info bar (above canvas): `meta` text in `--graphite`; the version/scene label left, an
  `Active`-style status pill (neutral badge) and timecode right. Timecode in `--ink`, tabular.

### 12.2 Property inspector (the right rail)

The signature surface. A scrollable column of **groups**; each group is a header row + dense
property rows. No card chrome.

- **Group header:** `label` (12px, 500, `--ink-soft`) on the left; a `+` add-control icon
  (`--graphite`, hover `--ink`) on the right. A hairline under collapsible groups only. Typical
  groups: Time, Transform, Layout, Appearance, Fill, Border, Shadow, Effects, Animation,
  Transition, Mask.
- **Property row:** 28px tall. Left: property label `ui`(13px) in `--graphite`. Right: the control.
  Rows are flush (no per-row border); groups separate by one `--space-3` gap.
- **Keyframe diamond:** a 10px rotated-square toggle at the right edge of animatable rows.
  Resting `--mute`; **active (has keyframe) = `--accent`**. This is a primary Signal-Blue use.

### 12.3 Inputs in the inspector

- **Numeric field + stepper:** `--input-bg` fill, 1px `--border-input`, `--radius-sm`, height 24–26px,
  value in `--ink` (tabular). A `−` / `+` stepper pair flanks or trails the field; stepper glyphs
  `--graphite`, hover `--ink`, hover-fill `--card`. Focus: `--accent` border.
- **Paired XY fields** (Position X/Y, Size W/H): two equal fields in a row, axis letter prefix in `--mute`.
- **Dropdown/select** (Blending, alignment): `--input-bg`, chevron `--mute`, `--radius-sm`.
- **Percent/value fields** (Opacity, Speed): right-aligned numeric + unit in `--mute`.
- Min field height in the inspector may go to 24px (denser than the 32px settings default) — this is
  the one surface allowed below 28px because density is the point. Type stays ≥ 11px.

### 12.4 Floating tool palette

A centered pill that floats over the canvas bottom edge.

- Surface `--card`, `--radius-pill`, `--shadow-md`, 1px `--hairline`. Icon buttons 32px square,
  glyph 18px `--graphite`.
- **Selected tool:** `--accent` fill, white glyph, `--radius-md` inset chip (the one filled-blue
  control in the chrome — selection state, allowed). Hover (unselected): `--card-hover`.
- Tools: select (cursor), grid/guides, shape, text, AI/sparkle, add-layer.

### 12.5 Asset grid (left panel)

Discrete content objects → **these ARE cards.**

- Header: `Assets (73)` — title `--ink`, count `--slate`; filter + add icons right.
- Search field: `--input-bg`, leading magnifier `--mute`, `--radius-md`.
- Tile: thumbnail with `--radius-sm`, a duration badge (`micro-caps`, `--ink` on `rgba(0,0,0,0.6)`)
  pinned bottom-left; filename below in `meta` `--graphite`, truncated. Audio assets show a
  `--tl-waveform` waveform thumb; caption/text assets a `--tl-clip-title` block. Hover: `--card-hover`
  lift; selected: 2px `--accent` ring.

### 12.6 Track headers (timeline left column)

- Track name `ui` in `--ink-soft`; type implied by the clip color.
- **Mute (M) / Solo (S):** square toggles, `--radius-sm`. Off: `--graphite` glyph on transparent.
  **On: `--accent` fill, white glyph** (functional state). Lock/hide use the same
  on/off language.

### 12.7 Audio meters (far-right rail)

- Channel strips (Audio 1/2/Master): a dB readout chip (`meta`, `--ink`) + an `M` toggle on top.
- VU bar: a vertical gradient — **green `--success` → amber `--warn` → red `--danger`** bottom-to-top,
  on a `--panel-2` track. Peak ticks in `--ink`. Scale labels (`-6`,`-12`,`-24`…) in `--mute` `meta`.
- This green→amber→red gradient is the one place status colors form a scale rather than discrete states.

### 12.8 What stays monochrome

Everything not listed above. Buttons, links, headings, panel chrome, icons-at-rest, tabs (except
the active underline), and all settings remain neutral. The colored surfaces are exactly: timeline
clips (data colors), the selected tool / playhead / keyframe / M-S (Signal Blue), and the audio
meter gradient. If a new element wants color, it must map to one of these or stay neutral.

### 12.9 Audio mixer channel strip (faders)

The mixer (far-right rail, alongside §12.7 meters) is a row of **vertical channel strips** — one
per audio track plus a Master. This is the one place a physical drag control is allowed; level is a
continuous performance gesture, not a typed value.

- **Strip frame:** `--panel-2` sunken column, 1px `--hairline` divider between strips, no card
  chrome. Width ~56px. Track label at top in `ui` (13px) `--ink-soft`, truncated.
- **Fader track:** a 4px `--input-bg` rail centered in the strip with a 1px `--border-input` edge.
  The 0 dB mark is a `--hairline-strong` tick with a `meta` `--mute` "0" label.
- **Fader cap (thumb):** a 28×12px `--card` cap, `--radius-sm`, 1px `--hairline-strong`, grippy
  center line in `--graphite`. Resting neutral. **Dragging / focused: 2px `--accent` ring.** Hover:
  `--card-hover`. The cap is the only moving part; the rail stays put.
- **Fill below the cap:** the rail segment below the cap fills `--accent-soft` — a quiet level
  indication, not a loud bar. Above the cap stays `--input-bg`.
- **dB readout:** below the fader, a right-aligned `meta` numeric field in `--ink` (tabular), unit in
  `--mute`. Double-click resets to 0 dB. (This is the §12.3 numeric field paired with the fader, so
  keyboard + precision edits are covered without the drag control.)
- **Pan:** a small horizontal knob above the fader — `--input-bg` track, `--card` thumb, center
  detent `--hairline-strong`, L/R letters in `--mute`. Same `--accent` ring on drag.
- **M / S toggles:** square toggles per §12.6 — off `--graphite` glyph transparent, **on `--accent`
  fill, white glyph**. Not green (green = status badges only, §4.9).
- **Master strip:** same anatomy, label "Master", divided from track strips by `--hairline-strong`.
- Sits beside the §12.7 VU meter so each strip reads as level-control + level-meter.

Motion: cap follows the pointer 1:1 (no easing while dragging); release does not animate.

### 12.10 Surface bindings

Canonical in-codebase exemplars: the **agent-chat model picker** (§4.7, menus/selectors) and the
**Settings page** (`apps/desktop/src/components/SettingsPanel.tsx` + `apps/desktop/src/components/settings/*` — reference for panels,
inputs, rows, the text ladder).

| Surface                                             | Binds to                  | Notes                                                         |
| --------------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| Audio mixer (faders, pan, M/S, master)              | §12.9 + §12.6 + §12.7     | physical faders; M/S Signal-Blue; VU gradient                 |
| Export range selector (Full / In-Out / Selection)   | §4.7 dropdown             | trigger pill + flat menu, modeled on the model picker         |
| ClipInspector (Transform/Effects/Audio/Speed/Blend) | §12.2 + §12.3 + §4.6 tabs | dense flat rows; numeric+stepper; keyframe diamond `--accent` |

---

## Appendix A — Token reference (`apps/desktop/src/app/globals.css`)

Default block = dark; `.light-theme` overrides = light. The legacy `.blue-theme` is retired (its
midnight palette folds into the dark theme).

```css
/* ── DARK (default) ───────────────────────────────────────────── */
:root {
  --font-ui: 'Inter Variable', system-ui, -apple-system, sans-serif;

  --bg: #121212;
  --panel: #1a1a1a;
  --panel-2: #0f0f0f;
  --card: #232323;
  --card-hover: #2c2c2c;
  --input-bg: #0c0c0c;
  --surface-cool: #1d1d1d;
  --scrim: rgba(0, 0, 0, 0.62);

  --hairline: rgba(255, 255, 255, 0.08);
  --hairline-strong: rgba(255, 255, 255, 0.14);
  --border-input: rgba(255, 255, 255, 0.12);

  --ink: #f4f4f4;
  --ink-soft: #d6d6d6;
  --graphite: #b0b0b0;
  --slate: #8a8a8a;
  --mute: #6e6e6e;
  --stone: #585858;
  --ash: #404040;

  --action: #f4f4f4;
  --on-action: #121212;
  --accent: #4a9eff;
  --accent-soft: rgba(74, 158, 255, 0.22);
  --accent-strong: #2f86f0;
  --switch-off: #3a3a3a;
  --switch-off-hover: #4a4a4a;
  --danger: #f87171;
  --warn: #fbbf24;
  --success: #34d399;

  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 16px;
  --radius-pill: 9999px;

  --ease-swift: cubic-bezier(0.22, 1, 0.36, 1);
  --dur-fast: 150ms;
  --dur-base: 200ms;
  --dur-slow: 300ms;
  --dur-enter: 700ms;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-md: 0 16px 40px -16px rgba(0, 0, 0, 0.6);
  --shadow-lg: 0 28px 64px -22px rgba(0, 0, 0, 0.7);
}

/* ── LIGHT ────────────────────────────────────────────────────── */
:root.light-theme {
  --bg: #ffffff;
  --panel: #ffffff;
  --panel-2: #fafaf8;
  --card: #f5f5f5;
  --card-hover: #eeeeee;
  --input-bg: #f4f4f6;
  --surface-cool: #eef1f4;
  --scrim: rgba(15, 17, 21, 0.45);

  --hairline: #ededed;
  --hairline-strong: #e4e4e2;
  --border-input: #dcdce0;

  --ink: #111111;
  --ink-soft: #2a2a2a;
  --graphite: #4d4d4d;
  --slate: #5b6472;
  --mute: #8a8a8a;
  --stone: #9a9a9a;
  --ash: #b6b6b6;

  --action: #111111;
  --on-action: #ffffff;
  --accent: #2563eb;
  --accent-soft: rgba(37, 99, 235, 0.14);
  --accent-strong: #1d4ed8;
  --switch-off: #dfe1e4;
  --switch-off-hover: #c9cbcd;
  --danger: #dc2626;
  --warn: #d97706;
  --success: #059669;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
  --shadow-md: 0 12px 36px -14px rgba(0, 0, 0, 0.22);
  --shadow-lg: 0 24px 60px -20px rgba(0, 0, 0, 0.28);
}
```

### Appendix A.1 — Legacy alias map (authoritative)

The legacy `--color-*` tokens are **aliased to the ladder**, not given independent values:

```css
/* Legacy aliases — same in both theme blocks; values come from the ladder above. */
--color-bg: var(--bg);
--color-panel: var(--panel);
--color-card: var(--card);
--color-card-hover: var(--card-hover);
--color-border: var(--hairline);
--color-hairline: var(--hairline);
--color-input-bg: var(--input-bg);
--color-text-primary: var(--ink);
--color-text-muted: var(--mute);
--color-accent: var(--accent);
--color-timeline-bg: var(--tl-bg);
```

After aliasing, components may keep using `--color-*` (they now resolve correctly), but **all new
code uses the ladder names directly.** New names are the source of truth; legacy names are a
compatibility shim that can be codemod-removed later.

---

_Source of truth: the Dreambyte website's monochrome editorial brand + the editor's existing theme
tokens in `apps/desktop/src/app/globals.css`. Visual catalog: `docs/editor-design-preview.html`. Distinct from the scene
`docs/DESIGN.md`._
