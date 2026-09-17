---
type: rule
title: Scene Output Contract & AI Generation Rules
description: How to emit a valid scene (React output schema, globals, bridge components, hard DON'Ts) and how to generate avatars, AI images, and AI video clips.
tags: ["lane:avatar"]
timestamp: 2026-06-19T00:00:00Z
---

# The React scene contract

Every scene is a React component. Compose HTML/CSS, Three.js, Canvas2D, D3, SVG, and Lottie in one component tree. Drive motion with `useCurrentFrame()` + `interpolate()`/`spring()`.

## Output

Output raw JSON only — no markdown fences, no prose:

```json
{
  "sceneCode": "function Scene() { ... }\nexport default Scene;",
  "styles": ".custom-class { ... }"
}
```

- `sceneCode` — full JSX component, transpiled in-browser via Babel. No imports; all APIs are globals.
- `styles` — optional CSS string, injected into a `<style>` block in `<head>`. No `<style>` tags. Use for `@keyframes` / complex selectors. Most scenes skip it — prefer inline `style={{}}`.

## APIs (globals — do NOT import)

### Hooks & components

| API | Purpose |
| --- | --- |
| `useCurrentFrame()` | Integer frame number (0, 1, 2, …) |
| `useVideoConfig()` | `{ fps, width, height, durationInFrames }` |
| `interpolate(value, inputRange, outputRange, opts?)` | Map values between ranges |
| `spring({ frame, fps, config?, from?, to? })` | Spring-based easing |
| `Easing.ease / .easeIn / .easeOut / .easeInOut / .bezier(x1,y1,x2,y2)` | Easing for `interpolate` |
| `<Sequence from={frame} durationInFrames={n}>` | Temporal composition — children see local frame from 0 |
| `<AbsoluteFill style={{...}}>` | Full-frame (WIDTH×HEIGHT) absolute layer, stacks via z-index |
| `useDreambyteSeek(cb)` | Fire `cb(timeSec)` on every seek/scrub — for motion outside the master timeline (`window.__tl`) |
| `useDreambyteTime()` | Current scene time in seconds, synced with playback + scrub |

### Bridge components

| Component | Props | Use for |
| --- | --- | --- |
| `<Canvas2DLayer draw={(ctx, frame, config) => {}} />` | `width?`, `height?`, `style?` | Hand-drawn strokes, particles, procedural art |
| `<ThreeJSLayer setup={(THREE, scene, camera, renderer) => {}} update={(scene, camera, frame, config) => {}} />` | `style?` | 3D geometry, PBR materials, shadows |
| `<D3Layer setup={(d3, el, config) => {}} update={(d3, el, frame, config) => {}} />` | `style?` | Data visualization, charts |
| `<SVGLayer setup={(svgEl, anime, tl) => {}} viewBox?>` | `children?`, `style?` | Vector draw-on animations |
| `<LottieLayer data={lottieJSON} />` | `style?` | Micro-animations, icons |

### Scene globals (on `window`)

`PALETTE`, `DURATION`, `FONT`, `BODY_FONT`, `STROKE_COLOR`, `WIDTH` (default 1920), `HEIGHT` (default 1080), `ROUGHNESS`, `SCENE_ID`. WIDTH/HEIGHT track the project aspect ratio (1080×1920 for 9:16, 1080×1080 for 1:1).

`FONT` = headings/display. `BODY_FONT` = body/labels (equals `FONT` when no pairing is active). Use both for contrast:

```jsx
<h1 style={{ fontFamily: FONT }}>Title</h1>
<p style={{ fontFamily: BODY_FONT }}>Body text here</p>
```

## Scene structure

```jsx
function Scene() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  React.useEffect(() => {
    DreambyteCamera.kenBurns({ duration: DURATION, endScale: 1.04 });
  }, []);

  return (
    <AbsoluteFill style={{ background: '#0a0c10' }}>
      <AbsoluteFill style={{ zIndex: 0 }}>
        <ThreeJSLayer setup={...} update={...} />
      </AbsoluteFill>

      <Sequence from={15}>
        <AbsoluteFill style={{ zIndex: 1, padding: '6% 7%' }}>
          <Title frame={frame} />
          <FeatureList frame={frame} />
        </AbsoluteFill>
      </Sequence>

      <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
        <Canvas2DLayer draw={(ctx, f, cfg) => { /* particles */ }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

export default Scene;
```

- Stack layers with `<AbsoluteFill>` + `zIndex`; time them with `<Sequence>`.
- End the file with `export default Scene;` (or `Main`, etc.). The bootstrapper reads `module.exports.default` (Babel `transform-modules-commonjs`). No export → blank iframe + console error, no crash, no fallback. Always write the export — do not rely on the auto-inject fallback.
- Do NOT mount yourself. No `ReactDOM.createRoot()` / `.render()`. The bootstrapper wraps your component in `<DreambyteComposition>` and mounts it.

## Interactive scenes

For **viewer-driven state** (clicks, sliders, toggles). Animation state stays frame-based via `useCurrentFrame()`.

`useVariable(name, defaultValue)` — reactive state synced with the parent player via postMessage, persists across the session:

```jsx
const [interestRate, setRate] = useVariable('interestRate', 5)
const monthlyPayment = (200000 * (interestRate / 100 / 12)) / (1 - Math.pow(1 + interestRate / 100 / 12, -360))
```

Declare with the `define_scene_variable` MCP tool, then `interaction` type `slider` to let the viewer drive it.

`useInteraction(elementId)` — returns `.handlers` props + `.isHovered`/click state for visual feedback:

```jsx
const card = useInteraction('card-pricing')
<div {...card.handlers} style={{ transform: `scale(${card.isHovered ? 1.05 : 1})`, transition: 'all 200ms ease' }}>Starter — $29/mo</div>
```

`useTrigger(name)` — one-shot events across the iframe boundary:

```jsx
const milestone = useTrigger('completed-intro')
// milestone.fire({ section: 'intro' })
```

In-scene hooks vs overlay:

| Scenario | Use |
| --- | --- |
| Hoverable cards, charts, 3D objects | `useInteraction` in scene |
| Slider that changes scene visuals | `useVariable` in scene + slider overlay |
| Standard quiz, choice, gate | Overlay via `interaction` |
| Toggle that shows/hides a layer | `useVariable` + toggle overlay |

Combine both: hoverable D3 bars (`useInteraction`) + overlay quiz (`interaction`).

## Performance & limits

- Max 1–2 ThreeJSLayers per scene — each opens a WebGL context (browsers allow 8–16 total). Compose multiple 3D objects into ONE setup.
- D3Layer: wrap in `React.memo` or give a stable `key` — D3 mutates the DOM directly; prevents unexpected unmount.
- Memoize components that don't use `useCurrentFrame()` — every frame re-renders the full tree.
- Canvas2DLayer: fine to ~500 objects/frame; 1000+ needs simplifying/batching.

## Canvas bounds — WIDTH×HEIGHT

Scene renders inside a WIDTH×HEIGHT container (1920×1080 for 16:9; 1080×1920 for 9:16, 1080×1080 for 1:1, 1080×1350 for 4:5) with `overflow: hidden`. Content outside is clipped.

- Use `<AbsoluteFill>`; do not exceed it.
- Absolute coords within 0–WIDTH (x), 0–HEIGHT (y).
- Keep important content within a 100px inset (100 to WIDTH−100, 100 to HEIGHT−100).
- Too-tall content (long lists): fewer items, smaller fonts, multi-column, or split scenes.
- Verify every element fits the box before finalizing.

## Do NOT

- No `requestAnimationFrame` — frames come from `useCurrentFrame()`.
- No `useState` for animation state — derive from `frame`.
- No `setTimeout` / `setInterval`.
- No `Math.random()` — use frame-based deterministic values.
- No importing React/ReactDOM — already global.
- No `<script>` tags in JSX — all code in the component.
- No manual mounting — `export default Scene;` only.
- No bounce/elastic easing — use `Easing.bezier(0.16, 1, 0.3, 1)` for entrances.
- No 2+ ThreeJSLayers in one scene — compose 3D into one layer.

---

# AI generation

Generate only when the subject is specific and not in stock, or must match the scene's
exact palette/composition. Pick the cheapest model that clears the bar.

## AI Images — `generate_image`

| The shot needs…                                    | Model                                              | Cost      |
| -------------------------------------------------- | -------------------------------------------------- | --------- |
| fast throwaway draft to check composition          | `flux-schnell`                                     | ~0.3¢     |
| photoreal / illustrated hero image (default)       | `flux-1.1-pro`                                     | ~5¢       |
| legible text in the image (logo, poster, UI, label)| `ideogram-v3` or `nano-banana-pro`                 | 8¢ / 15¢  |
| clean cut-out sticker / icon (transparent)         | `recraft-v3` (`generate_image({ mode:'sticker' })`)| ~4¢       |
| SAME character/subject across shots, or an edit    | `nano-banana` / `nano-banana-pro`                  | 4¢ / 15¢  |
| match an uploaded/prior look                       | `generate_image({ source:'reference' })`           | i2i rate  |

- `source:'reference'` — feed a reference (user asset, research screenshot, earlier frame) so output inherits its look. Primary lever for style consistency.
- `source:'regenerate'` — re-roll for on-palette alternates (angle, crop, mood) or replace in place; preserves the timeline slot + timing.
- Source at or above project resolution.
- Pass a `seed` for reproducibility or clean variations.
- `imagen-3` is listed but not runnable — never route to it.

## AI Video — image-first

👍 Generate a still, approve the look, then i2v / camera move over it (cheaper, on-palette, controllable).
👎 Text-to-video, unless continuous motion of a non-existent subject is the whole point.

| The clip needs…                                    | Model (via `generate_veo3_video({ provider })`) | Cost           |
| -------------------------------------------------- | ----------------------------------------------- | -------------- |
| cheapest 5-8s motion                               | `ltx`                                           | ~6¢/s          |
| top cinematic quality + native audio               | `veo3` / `veo31`                                | $1+/s          |
| realistic motion with start/end keyframe or extend | `kling`                                         | ~45¢ +9¢/s     |
| edit/restyle/relight EXISTING footage (v2v)        | `runway` (Aleph)                                | ~90¢ +18¢/s    |

- `auto` routing defaults to the priciest (`veo3`) — name a cheaper `provider` explicitly when veo-grade cinema isn't required.

## Consistency — characters & style refs

- Recurring person/creature/mascot: `character({ action:'create' })` ONCE (pins seed + reference image + style descriptor), then `character({ action:'render' })` per pose/scene. 👎 re-prompting the look from scratch (it drifts).
- One coherent visual world: feed every generation the same reference via `generate_image({ source:'reference' })`; `source:'regenerate'` for on-palette alternates.
- Stills take a camera move (Ken Burns push / perspective / parallax) rather than sitting dead on screen.

## Avatars

Default: no avatar. Add one only when the user asks. Ask if unsure.

### Providers

Provider is set per-project in Settings > Media Gen and auto-selected. Do NOT pass it in the tool call.

| Provider    | Type                    | Cost         | Notes                          |
| ----------- | ----------------------- | ------------ | ------------------------------ |
| musetalk    | Photorealistic (FAL.ai) | ~$0.04/scene | Requires source face image     |
| fabric      | Photorealistic (FAL.ai) | ~$0.08-0.15  | 480p/720p, requires face image |
| aurora      | Photorealistic (FAL.ai) | ~$0.05/scene | Requires source face image     |
| heygen      | Premium API             | ~$0.10-1.00  | HeyGen avatar library          |

### Which tool

| Scenario                                    | Tool                                           |
| ------------------------------------------- | ---------------------------------------------- |
| Data viz / chart with narrator in corner    | `generate_avatar_narration`                    |
| Animation with a presenter adding trust     | `generate_avatar_narration`                    |
| Step-by-step tutorial led by a presenter    | `generate_avatar_scene`                        |
| Corporate spokesperson delivering a message | `generate_avatar_scene`                        |
| Abstract concept scene, no person needed    | No avatar                                      |
| Data-heavy scene with complex visuals       | `generate_avatar_narration` (PIP) or no avatar |
| Scene under 5 seconds                       | No avatar                                      |

### `generate_avatar_narration` — PIP overlay

Talking avatar as picture-in-picture on an existing scene. Use when the avatar supplements other content (charts, animations, diagrams).

| Parameter      | Required | Description                                                                    |
| -------------- | -------- | ------------------------------------------------------------------------------ |
| sceneId        | yes      | Target scene ID                                                                |
| text           | yes      | What the avatar says (natural, conversational)                                 |
| placement      | no       | `pip_bottom_right` (default), `pip_bottom_left`, `pip_top_right`, `fullscreen` |
| avatarConfigId | no       | Specific config ID (omit for project default)                                  |
| sourceImageUrl | no       | Face image URL (FAL providers only)                                            |

PIP avatars are true overlays. Scene uses the full viewport as normal.

👍 Full-bleed scene, avatar as a small corner circle, partial overlap OK.
👎 Extra padding / `maxWidth` / reserved column to "make room" for the PIP.

### `generate_avatar_scene` — Full presenter scene

Avatar IS the main visual. Use for tutorials, walkthroughs, presenter, spokesperson.
Uses a split layout: the provider's presenter video in a dedicated column, content panels beside it (unlike PIP).

| Parameter        | Required | Description                                   |
| ---------------- | -------- | --------------------------------------------- |
| sceneId          | yes      | Target scene ID                               |
| narration_script | yes      | Object: `{ mood, view, lines[], position }` — the spoken text is `lines[].text` |
| content_panels   | no       | Array: `{ html, position, revealAt, exitAt }` |
| backdrop         | no       | CSS background for the scene                  |
| avatar_position  | no       | `left` (default), `right`, `center`           |
| avatar_size      | no       | % of viewport width (default 40)              |
| avatar_config_id | no       | Specific config (omit for project default)    |

```json
{
  "mood": "neutral",
  "view": "upper",
  "position": "fullscreen_left",
  "lines": [{ "text": "Welcome to this tutorial!" }, { "text": "Let me show you the data." }]
}
```

### Composition

Avatars composite as HTML overlays (`scene.aiLayers`), NOT React bridge components.

- A React scene can use `<ThreeJSLayer>`, `<Canvas2DLayer>`, `<D3Layer>`, etc. alongside a PIP avatar.
- Avatar renders on top as a separate HTML layer.
- Avatar timing is TTS-driven (audio duration), independent of `useCurrentFrame()`.
