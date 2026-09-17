---
name: dreambyte
type: guide
title: Dreambyte Domain Skill
description: Generate animated video scenes for Dreambyte
tags: ['guide']
timestamp: 2026-06-19T00:00:00Z
triggers:
  - /dreambyte
---

# Dreambyte Scene Generator

You generate animated scene HTML files for the Dreambyte video editor.

Scenes are self-contained HTML files served by the desktop app at `dreambyte://scenes/{id}.html`. The renderer + the MCP server both run inside the Dreambyte desktop app — there is no HTTP server, no `localhost:3000`, no Next.js API. All mutations go through MCP tools (registered in this session) which keep DB + HTML on disk in sync.

---

## If the app is not running

If any tool call returns an error containing "Dreambyte is not running",
stop immediately. Do NOT retry. Tell the user:

> The Dreambyte desktop app is not running.
> Open it and let it fully load, then try again.

The in-app MCP tools (mutations, generation, narration, etc.) require the
running app. For browsing or git-ing a saved project from outside the app,
use the **Tier 2 MCP server** instead — see the next section.

---

## Two MCP servers — pick the one that matches the task

Dreambyte ships two MCP servers. Both speak the same protocol; their scope
differs.

### In-app server (default)

Runs inside the desktop app. Exposes the agent's tools that mutate state — create
projects and scenes, edit layers, generate narration, regenerate code,
write HTML. This is what every section below assumes.

### Tier 2 read-only server (no app needed)

Standalone stdio MCP server scoped to a single `.dreambyte/` folder. Reads the
file mirror the app writes on save. Useful for: project audits, git-based
review, building scene tooling outside the editor. Five tools:

| Tool                    | Returns                                       |
| ----------------------- | --------------------------------------------- |
| `tier2_read_project`    | parsed `project.json`                         |
| `tier2_list_scenes`     | one summary per scene (id/name/duration/type) |
| `tier2_read_scene`      | parsed `dreambyte.json` for one scene         |
| `tier2_read_scene_html` | rendered scene HTML if it exists; null else   |
| `tier2_list_assets`     | files under `assets/` with subpath + size     |

Register once per project folder:

```bash
claude mcp add dreambyte-tier2 -- npx tsx scripts/mcp/mcp-tier2-server.ts /path/to/project.dreambyte
```

The path-containment guard rejects symlinks, `..` traversal, absolute
paths, and null-byte tricks; you cannot escape the `.dreambyte/` root by
construction. Read-only by design — write-back goes through the in-app
server when the user reopens the project.

---

## Runtime model

- **You are inside the desktop app.** The active project is already loaded — `select_project` switches between projects. Use `create_project` to create a new empty project (it auto-switches to it). For any showcase, test, or "new video" request, create a fresh project first rather than adding scenes to an existing one.
- **All state-changing operations are MCP tools.** There are no REST endpoints; the table below maps the HTTP calls you might reach for to the matching tool.
- **Scenes render on the timeline automatically** as soon as a tool call returns. Don't tell the user to "open the app" or paste a URL — they're already looking at the timeline.

| Conceptual REST call         | Use this tool instead                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `POST /api/projects`         | `create_project` — creates and auto-switches to a new project                         |
| `POST /api/scene`            | `write_scene_code` (create scene) / `add_layer` (add to existing)                     |
| `PATCH /api/scene`           | `patch_layer_code`, `regenerate_layer`, `scene_props`                                 |
| `GET /api/scene?projectId=…` | World state in your context already lists scenes; `inspect (kind:'scene')` to refresh |
| `POST /api/tts`              | `add_narration`                                                                       |
| `POST /api/sfx`              | `add_sfx` / `add_music`                                                               |
| `POST /api/charts`           | `chart`                                                                               |

If a tool you need isn't in the registered list for this run, surface that to the user instead of falling back to HTTP — there is no HTTP fallback.

### Goal → Tool decision table

| Goal                                     | Tool                                      |
| ---------------------------------------- | ----------------------------------------- |
| Create a new scene from scratch          | `write_scene_code`                        |
| Add a layer to an existing scene         | `add_layer`                               |
| Edit an existing layer                   | `patch_layer_code`                        |
| Regenerate a layer with a new prompt     | `regenerate_layer`                        |
| Add narration (TTS)                      | `add_narration`                           |
| Add avatar narration (HeyGen)            | `generate_avatar_narration`               |
| Generate an avatar scene                 | `generate_avatar_scene`                   |
| Generate a data chart                    | `chart`                                   |
| Add a sound effect                       | `add_sfx`                                 |
| Add background music                     | `add_music`                               |
| Generate an image from a reference       | `generate_image({ source:'reference' })`  |
| Create a variation of an existing asset  | `generate_image (source:'regenerate')`    |
| Regenerate a broken asset                | `generate_image({ source:'regenerate' })` |
| Check a scene is rendering correctly     | `verify_scene`                            |
| List scenes in the project               | `inspect (kind:'scene')`                  |
| Read full scene data (with code)         | `inspect (kind:'code')`                   |
| Get full project state + scene summaries | `get_world_state`                         |
| Create a brand-new project               | `create_project`                          |
| Switch active project                    | `select_project`                          |
| Refresh project state after UI changes   | `refresh_state`                           |
| Reorder scenes on the timeline           | `reorder_scenes`                          |
| Delete a scene                           | `delete_scene`                            |
| Plan a full multi-scene video            | `plan_scenes`                             |

---

## Planning (output before generating scenes)

Before generating any scenes, output a `<planning>` block:

```
<planning>
Topic: [what this explains]
Audience: [who this is for, if inferable]
Scene count: [N] — [why this many, not more or fewer]
Renderer choices:
  - Scene 1 "[name]": [type] — [one sentence why this type]
  - Scene 2 "[name]": [type] — [one sentence why]
  ...
Narrative arc: [how scenes build on each other]
Duration rationale: [why these durations]
What I'm NOT doing: [notable alternatives considered and rejected]
</planning>
```

Then generate scenes.
The planning block is shown to the user so they can understand
and redirect your choices before you do the work.

---

## Parse the user prompt

Determine:

- **How many scenes** (default: 1; "video about X" implies 3–5 scenes)
- **Scene type** for each — see selection guide below
- **Narrative arc** if multi-scene: opening → development → conclusion
- **Duration** per scene (default: 8s)
- **Background color** per scene (default: `#181818`)

---

## Aspect Ratio

Projects support multiple aspect ratios: 16:9 (landscape), 9:16 (vertical), 1:1 (square), 4:5 (portrait).
The scene template injects `WIDTH` and `HEIGHT` JS globals matching the project's dimensions.
Always use these globals instead of hardcoding 1920/1080.

Use `resolveProjectDimensions(aspectRatio, resolution)` from `src/lib/dimensions.ts` to get pixel dimensions.

---

## Scene type: always `react`

Every scene uses `"type": "react"`. The React component composes whatever renderers
the content needs via bridge components:

| Content type                          | How to build it                                                          |
| ------------------------------------- | ------------------------------------------------------------------------ |
| **Typography, layouts, cards, steps** | Pure JSX + `interpolate()` + `spring()` — no bridge needed               |
| **3D geometry, product viz, text**    | `<ThreeJSLayer>` bridge — meshes, CSG booleans, 3D text, post-processing |
| **Hand-drawn, particles, procedural** | `<Canvas2DLayer>` bridge                                                 |
| **Charts, data viz**                  | `<D3Layer>` bridge, or `chart` MCP tool for standard charts              |
| **Vector draw-on**                    | `<SVGLayer>` bridge                                                      |
| **Micro-animations, icons**           | `<LottieLayer>` bridge                                                   |
| **Combined**                          | Stack multiple bridges in one scene with `<AbsoluteFill>` + `<Sequence>` |

The power of React: one scene can have a Three.js background, HTML text overlay,
Canvas2D particles, and a D3 chart — all composed in JSX.

### Three.js capabilities (via `<ThreeJSLayer>` — ALWAYS use React scenes for 3D)

**Default approach:** `type: 'react'` with `<ThreeJSLayer>` for 3D background + JSX for text overlays.
Call `buildInfiniteStudio(THREE, scene, camera, renderer, opts)` inside the ThreeJSLayer setup callback
to get a full studio environment (sky sphere, infinite grid, floor, lighting, env map).
Pass `{ color: 'white' }` (default), `{ color: 'dark' }`, `{ color: 'midnight' }`, or any hex string `{ color: '#rrggbb' }` to choose the environment.
Use `makeStudioSet(THREE, scene, [x, y, z])` to build named sub-environments at world positions.
Text/info goes in `<AbsoluteFill>` JSX overlays with `interpolate()` for entrance animations.

**Scenes longer than 5 seconds must use at least 2 studio sets with a camera journey between them.**
Use `buildSceneSequencer(namedSets)` to orchestrate cuts and moves; call `sequencer.update(t, camera)` each frame.

Three.js r183. Full toolkit available:

- **3D text**: `troika-three-text` — SDF text with any Google Font, outlines, curved text, PBR materials
- **CSG booleans**: `three-bvh-csg` — subtract/union/intersect meshes (holes, cutouts, complex shapes)
- **Materials**: 12 presets: `plastic, metal, glass, matte, glow, clearcoat, iridescent, velvet` (PBR) + `hologram, xray, pulse, fresnel` (shader) + full MeshPhysicalMaterial. Call `updateShaderMaterials(scene, t)` each frame when using shader presets.
- **Post-processing**: EffectComposer with bloom, depth of field (BokehPass), SSAO, anti-aliasing (SMAAPass)
- **Lighting**: studio 3-point, cinematic RectAreaLight, sunset, dramatic, neon — plus environment maps
- **Camera**: `StudioCamera.follow(t, keyframes, cam?)` for path animation; `StudioCamera.fitTo(mesh, opts, controls)` for geometry-aware auto-framing; `StudioCamera.autoFrame(mesh, camera, opts)` for instant fit; `buildCameraControls(camera, renderer, opts)` wraps camera-controls for interactive preview (set `interactive: false` for video export).
- **Camera presets**: `CAMERA_PRESETS.productReveal(t, opts, cam)`, `cinematicSweep`, `heroDescend`, `pushIn`, `rackFocusReveal` — pass `t` for scrub-safe output.
- **Particles**: `buildParticleField(THREE, scene, opts)` — ambient drift; `buildParticles(THREE, scene, opts)` — shaped emitters (sphere/ring/cone/box); `buildDataParticles(THREE, scene, points, opts)` — data-driven convergence. All expose `.update(t)` for scrub-safe animation.
- **Animated connections**: `buildConnectionLine(THREE, scene, pointA, pointB, opts)` — tube with `.drawOn(t, dur)` for partial draw animation.
- **Scene sequencer**: `buildSceneSequencer(namedSets)` — `.cut(t, setName)`, `.move(startT, endT, fromSet, toSet)`, `.update(t, camera)`. Mirrors After Effects multi-comp workflow.
- **Models**: GLTFLoader + DRACOLoader for compressed .glb, AnimationMixer for animated .glb clips
- **Effects**: Sparkles, Grid, Stars from `@pmndrs/vanilla`
- **Model library**: CC0 GLB models (search via `find_media (kind:'3d')` tool)

Read `.claude/skills/dreambyte/rules/three.md` for full patterns, AE-quality templates, and code examples.

Physics parameter hygiene (to prevent framing/position glitches):

- Prefer angles in degrees in prompts/tool args (e.g. 35, 45, 60). Runtime normalizes units.
- Start with stable parameter ranges before edge-case extremes.
- Harmonic oscillator `x0`/`v0`: use either sim units (`0.5-4`) or pixel-like (`60-240`) — both are normalized.

---

## Planning scenes

Before writing any code, plan the full set of scenes:

- List each scene with: name, type, duration, background color, visual concept
- Describe the narrative arc
- Confirm the plan reads as a coherent video

**Duration calculation:**
For each scene, count all visible text elements (titles, labels, steps, annotations, captions).
Calculate: `duration = max(6, (totalWords / 2.5) + 3)`

Examples:

- Title + subtitle + 1 sentence = ~15 words → max(6, 15/2.5 + 3) = 9s
- 4 step-by-step lines + title = ~40 words → max(6, 40/2.5 + 3) = 19s → cap at 18s
- Diagram with 8 labels + title = ~25 words → max(6, 25/2.5 + 3) = 13s

Scenes should never feel rushed. The viewer needs time to read everything AND understand the visual.

---

## Technical craft — pull on demand (`get_routed_craft`)

For the how-to references THIS video needs, call **`get_routed_craft({ pack })`** — the
`pack` enum lists every pack that exists: `audio` (mix), `generation` (scene output contract +
AI image/video/avatar generation), `research` (media sourcing), and `three` (Studio3D SDK). Omit
`pack` to get everything routed by the project's stored brief at once.

These are technical references (API, audio mix, media sourcing) — pull the one whose
trigger applies. Aesthetic decisions (composition, color, motion, structure) are yours;
there is no taste rulebook. The packs also live as markdown under
`.claude/skills/dreambyte/rules/` (listed in the bundle-root `index.md`) if you want to read them directly.

**Set the aspect ratio first if it isn't landscape.** If the video is vertical (TikTok / Reel /
Short → `9:16`), square (`1:1`), or portrait (`4:5`), call **`set_aspect_ratio`** with that ratio
**before building any scenes** — otherwise the project stays 16:9 and your "vertical" scenes render
letterboxed. The brief tells you the format; make it real with this call.

## Generating code

**React is the default renderer.** Read these files before generating any scene code:

0. `docs/DESIGN.md` — **TOKENS FIRST**: read the YAML frontmatter for exact color hex values, type sizes, spacing values, and named layout patterns. These are the values to use — not approximations, not inventions.

The scene contract (structure, bridge components, animation API, duration/safe-area
rules) is in this file, below — there is no separate renderer rule pack to read.

`docs/DESIGN.md` tokens override any defaults you'd otherwise reach for. If docs/DESIGN.md says `scene-bg-dark: "#0c0c0e"`, use `#0c0c0e`, not `#181818` or `#0a0a0a`. If docs/DESIGN.md says the layout pattern is `stat-anchor`, implement it exactly as described in the Components section.

Every scene is a React component. Use bridge components (`ThreeJSLayer`, `Canvas2DLayer`,
`D3Layer`, `SVGLayer`, `LottieLayer`) to compose multiple renderers in one scene.

**D3 charts: use `chart` MCP tool** for standard chart types (bar, line, pie, etc.).
Zero LLM tokens, consistent animation. Only write custom D3 via `<D3Layer>` bridge for exotic visualizations.

`rules/three.md` is the only renderer pack — it carries the Studio3D SDK API for
`<ThreeJSLayer>`. The other renderers' APIs are in this file and in `src/lib/skills/library/`.

Apply every rule in the relevant files. The rules are not suggestions.

---

## Scene IDs

Do NOT set a custom id when creating scenes. Omit `sceneId` in `write_scene_code` and
the tool generates one.
The `name` field is the human-readable label shown in the app timeline.
Use descriptive names like "Title Card", "Visual Proof", "Practice Problem 1".

---

## After generating code

Persist each scene with `write_scene_code` so it appears in the timeline and database:

```
write_scene_code({
  name: "Scene Name",
  sceneType: "react",
  sceneCode: "<JSX code>",
  styles: "<optional CSS>",
  duration: 8,
  bgColor: "#0a0c10"
})
```

`generatedCode` for React scenes carries `sceneCode` (JSX) and optional `styles` (CSS). The tool writes the scene to the project database, regenerates the HTML on disk, and the timeline picks it up — no manual file write, no API call.

For **structured D3 charts** use `chart` instead of writing D3 by hand.

---

## Adding narration (TTS)

Use `add_narration` — one tool call generates the audio, attaches it to the scene's `audioLayer.tts`, and (when needed) extends the scene's duration so the narration fits:

```
add_narration({
  sceneId: "<sceneId>",
  text: "Narration text here",
  // Optional: provider / voiceId / instructions if the user picks them
})
```

The tool selects an enabled TTS provider, writes the audio file to `dreambyte://audio/tts-*.mp3`, and updates the scene atomically. Don't call sub-steps yourself.

Sizing rule: scene duration should be `ceil(narrationDuration + 1)` so the visual has a beat after the voice ends. `add_narration` handles this; if you change duration manually afterwards, use `scene_props`.

**Sequential mutations:** scene-level tool calls on the same project must be sequential (not parallel) — they share the project JSON blob.

---

## Editing existing scenes

1. The world state in your context lists scenes with their layers — start there. Call `inspect (kind:'scene')` only if you need a refresh.
2. Pick the layer to change (each has id, type, label, prompt).
3. Apply the edit:
   - Whole-layer code rewrite → `regenerate_layer` (or `write_scene_code` with the `sceneId`)
   - Targeted patch (string substitution / surgical edit) → `patch_layer_code`
   - Scene-level fields (duration, background, transition) → `scene_props`
4. Call `verify_scene` afterward to catch render issues before declaring success.

The tools update the project database and regenerate the HTML on disk atomically. NEVER edit `public/scenes/*.html` or any `dreambyte://scenes/*.html` file directly — those are generated outputs.

For D3 scenes with DreambyteCharts:

- Prefer `chart` for standard chart types.
- Multiple charts in one scene are supported and should remain as structured chart layers (`scene.chartLayers`).
- Keep chart defaults readable (title/labels/grid/legend/legible font) unless user explicitly requests a different visual style.

---

## MCP Tools (optional, powerful)

If the Dreambyte MCP server is connected (`dreambyte` in settings), you have access
to the agent tools directly — the same tools the in-app agent uses. Key tools:

| Tool                        | What it does                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `verify_scene`              | Static analysis: checks content, text overlap, palette, audio, duration                |
| `plan_scenes`               | Generate a storyboard before building scenes                                           |
| `add_narration`             | Add TTS narration (auto-selects provider)                                              |
| `add_sfx`                   | Search and attach sound effects                                                        |
| `add_music`                 | Search and attach background music                                                     |
| `chart`                     | Create animated D3 chart (zero LLM cost)                                               |
| `scene_props`               | Set a scene's duration, background colour, or transition                               |
| `set_style`                 | Set palette, font, preset across all scenes                                            |
| `interaction`               | Add overlay interactivity (hotspot, choice, quiz, gate, tooltip, form, slider, toggle) |
| `define_scene_variable`     | Define a typed variable on a scene (for slider/toggle/useVariable binding)             |
| `connect_scenes`            | Create scene graph edges with variable conditions for branching                        |
| `select_project`            | Switch between projects                                                                |
| `inspect (kind:'scene')`    | List all scenes in current project                                                     |
| `generate_avatar_narration` | Add talking avatar PIP overlay to a scene (auto-selects provider)                      |
| `generate_avatar_scene`     | Create full presenter scene with avatar, panels, gestures                              |

Avatar tools require an avatar provider configured in project settings (Settings > Media Gen).
See `.claude/skills/dreambyte/rules/generation.md` for detailed usage, moods, gestures, and placement rules.

**Tool selection at a glance:**

- Scene code: `write_scene_code`, `add_layer`, `regenerate_layer`, `patch_layer_code`
- Verification (always after a code mutation): `verify_scene`
- Audio: `add_narration`, `add_sfx`, `add_music`
- Data viz: `chart` (preferred for standard charts)
- Interactivity: `interaction`, `define_scene_variable`, `connect_scenes`
- Style/transitions: `set_style`, `scene_props`

---

## Interactive video workflow

For interactive projects (`outputMode: 'interactive'`), scenes can respond to viewer input. The active project's `outputMode` is set when the user creates the project — if it's not interactive and they want it to be, ask them to change it in the editor or via a host-provided tool. Don't try to mutate `outputMode` mid-flow.

### Step 1: Project must be in interactive mode

(set at project creation; not something this skill flips)

### Step 2: Create scenes with useVariable/useInteraction hooks in code

Use the hooks in `generatedCode` (see `rules/generation.md` -> "Interactive scenes"):

- `useVariable('rate', 5)` — reactive state synced with overlays
- `useInteraction('card')` — hover/click handlers
- `useTrigger('done')` — fire events to parent

### Step 3: Add variables + interactions

Define each variable first with `define_scene_variable`, then add every overlay for the scene
in one `interaction` call — one entry per element in `items`, with type-specific fields in
`config`:

```
define_scene_variable({ sceneId: "...", name: "interestRate", type: "number", defaultValue: 5 })
define_scene_variable({ sceneId: "...", name: "showComparison", type: "boolean", defaultValue: false })

interaction({
  sceneId: "...",
  items: [
    {
      type: "slider",
      x: 5, y: 80, width: 40, height: 8,
      appearsAt: 1,
      config: { label: "Interest Rate", min: 1, max: 15, step: 0.5, defaultValue: 5,
                setsVariable: "interestRate", showValue: true, unit: "%" }
    },
    {
      type: "toggle",
      x: 5, y: 90, width: 40, height: 6,
      appearsAt: 2,
      config: { label: "Show Comparison", defaultValue: false, setsVariable: "showComparison",
                onLabel: "On", offLabel: "Off" }
    }
  ]
})
```

### Step 4: Add quiz/choice/hotspot overlays

All 8 interaction types use the same `interaction` tool — `type` selects the variant:

| Type      | Key `config` fields                               | Use case                      |
| --------- | ------------------------------------------------- | ----------------------------- |
| `hotspot` | label, shape, color, jumpsToSceneId               | Clickable regions on diagrams |
| `choice`  | question, options[{label, jumpsToSceneId}]        | Branching decisions           |
| `quiz`    | question, options[], correctOptionId, explanation | Knowledge checks              |
| `gate`    | buttonLabel, minimumWatchTime                     | Progression blocker           |
| `tooltip` | triggerLabel, tooltipTitle, tooltipBody           | Info overlays                 |
| `form`    | fields[], setsVariables[], submitLabel            | Data collection               |
| `slider`  | min, max, step, setsVariable, label               | Numeric control               |
| `toggle`  | setsVariable, label, onLabel, offLabel            | Boolean switch                |

### Step 5: Connect scenes with conditions

Use `connect_scenes` once per edge:

```
connect_scenes({ fromSceneId: "<s1>", toSceneId: "<s2>", conditionType: "auto" })

connect_scenes({
  fromSceneId: "<s2>",
  toSceneId: "<s3>",
  conditionType: "variable",
  variableCondition: { variableName: "score", operator: "gte", value: 80 }
})
```

For hotspot/choice/quiz/gate edges, pass the triggering element's `interactionId`.

Condition operators: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`, `truthy`, `falsy`.

### Full workflow summary

1. Project must already be `outputMode: 'interactive'` (set at creation, not flipped here).
2. `write_scene_code` per scene (hooks in the scene code).
3. `define_scene_variable` / `interaction` / `connect_scenes` to flesh out the interactivity layer.
4. `verify_scene` after each mutation pass.
5. Scenes render on the editor timeline automatically — slider/toggle/quiz overlays stack on top.

See `rules/generation.md` -> "Interactive scenes" for hook documentation and patterns.

---

## After creating scenes

All scenes are parts of ONE video in the timeline. They play sequentially: scene 1 → 2 → 3 → ... → final.

Keep the closing message short. The user is already in the desktop app — the scenes appear on their timeline the moment the tool calls complete. Don't tell them to "open the app", paste any URL, or reference `localhost` / `[app]`. None of those are real in this runtime.

Good closer:

```
✅ {N} scenes created (~{total}s total)

Scenes in order:
1. {name} ({type}, {n}s)
2. {name} ({type}, {n}s)
...
```

Do NOT paste individual scene URLs as the primary output.
The timeline panel is the primary interface.
Individual URLs are only useful for debugging.
