# Dreambyte

AI-powered video editor — "Claude Code for videos." Users can build and edit ANY kind of video (not just explainers) by talking to one agent: code-driven motion scenes (Canvas2D, SVG, D3, Three.js, React/Anime.js), AI image/diffusion layers, AI video clips, avatars, narration/music/SFX. Everything stays editable. Scenes export as MP4 or publish as interactive hosted embeds.

## Working in this repo

- This app lives in apps/desktop of an npm workspaces monorepo; paths here are relative to it, and
  commands run from here. `npm ci` at the repository root installs everything, including the
  stitcher's modules (fluent-ffmpeg) for `@dreambyte/render-server` (`../../packages/render-server/`).
  FFmpeg itself is NOT bundled (GPL/nonfree static builds can't ship):
  `../../packages/render-server/ffmpeg-path.js` finds the user's install via
  `DREAMBYTE_FFMPEG_PATH`/`FFMPEG_PATH`, `PATH`, then Homebrew dirs. The FFmpeg integration tests
  skip when none is installed.
- Stage only the files you changed (no `git add -A`), and don't stash/reset over uncommitted
  work you didn't create.

## Stack

- Desktop: Electron 41 + Next.js renderer (built to `out/`, served via `dreambyte://` protocol)
- Database: SQLite via Drizzle ORM + libsql (`src/lib/db/`) — one file at `<userData>/dreambyte.db`
  (macOS: `~/Library/Application Support/dreambyte/dreambyte.db`). `src/electron/main.ts` sets
  `DATABASE_URL=file:<that>` at boot; `src/lib/db/index.ts` has NO default and throws without it.
  Web/dev sets its own (`file:./dev.db`). `~/.dreambyte/` holds no database — only run traces,
  the per-instance MCP registry (`instances/<id>/`), and the agent feedback log.
- Export: offscreen BrowserWindow frame capture + FFmpeg over IPC (default); Pixi + WebCodecs + mediabunny (legacy, `DREAMBYTE_EXPORT_ENGINE=legacy`, also used automatically for some video/avatar layers)
- Agent: provider-agnostic tool use (`src/lib/agents/`) — Anthropic, OpenAI, Google Gemini, DeepSeek, Kimi (Moonshot), Qwen, and local OpenAI-compatible endpoints (Ollama) all run the full agent loop, with reasoning replay where the provider supports it. Pick a tier (`auto` / `budget` / `premium`); web search works on every model via the Tavily backend (`TAVILY_API_KEY`).

## Key directories

**The App Router has no `api` directory.** Zero `route.ts` files exist in this repo —
confirm with `find . -name route.ts -not -path './node_modules/*'`. The App Router renders
ONE page (the editor shell); every backend capability is an Electron IPC handler.

```
src/
  app/                        — Next.js App Router: layout + one client page (the editor shell)
    page.tsx                  — mounts <AppShell>; static-exported to out/, served via dreambyte://
  electron/
    main.ts                   — boot: env + DATABASE_URL, migrations, protocol, windows
    ipc/                      — THE backend. One module per domain, all wired in ipc/index.ts
      agent.ts                — dreambyte:agent.start / .abort / .subscribed — the agent entry point
      generate.ts             — dreambyte:generate.{react,svg,canvas,three,motion,lottie,avatar,image,video,…}
      scene.ts                — dreambyte:scene.{get,writeHtml,readHtml,generateWorld}
      projects.ts             — dreambyte:projects.{list,get,create,update,delete,…}
      export-tier3.ts         — dreambyte:exportTier3 / exportTier3Scene (MP4)
      publish.ts              — dreambyte:publish.run (hosted embed)
    mcp-bridge.ts             — 127.0.0.1 HTTP bridge the MCP server calls back into
    mcp-server-manager.ts     — spawns + supervises the mcp-server daemon
    provider-keys.ts          — safeStorage keyring → process.env (why MCP can't gate on keys)
  lib/
    types.ts                  — Re-exports the domain types in src/lib/types/ (Scene, SceneType, etc.)
    sceneTemplate.ts          — generateSceneHTML(): HTML template assembly per scene type
    scene-html-paths.ts       — resolveScenesDir(): where scene HTML lands
    db/                       — Drizzle ORM setup, schema, queries
      migrations/             — SQLite migrations (drizzle-kit, config in db/drizzle.config.ts)
      queries/projects.ts     — persistScenesFromAgentRun(): the ONE agent scene-write path
    agents/                   — the agent: runner.ts, tools.ts, context-builder.ts, tool-executor.ts
      mcp-adapter.ts          — the MCP tool surface + bridge client
    services/agent-runner.ts  — transport-agnostic wrapper the IPC handler calls
    generation/               — LLM system prompts per scene type
    store/                    — Zustand editor state store (src/lib/store.ts re-exports it)
    agent-tools.ts            — Agent tool category chips
    hooks/                    — Shared React hooks (recording/device hooks live in src/hooks/)
      use-persisted-state.ts  — localStorage-backed useState (SSR-safe)
      use-view-scoped-state.ts — View-scoped UI state: persisted in editor, transient on welcome screen
    utils/
      format-date.ts          — Date formatting helpers
  components/                 — React UI components
  hooks/                      — Recording/device React hooks
  types/                      — Ambient .d.ts (window.dreambyte API)
  test/setup.ts               — Vitest setup
public/scenes/                — Scene HTML in dev (packaged: <userData>/scenes, see below)
scripts/
  mcp/mcp-server.ts           — MCP stdio/socket server (Claude Code, Cursor, Codex)
  mcp/mcp-connect.js          — .mcp.json entry: proxies Claude Code's stdio to the app's socket
  dev/inject-scene.ts         — CLI: wrap code in correct HTML template
  build/                      — esbuild (Electron), static renderer export
  release/                    — packaging, release, notices, Sentry symbols
../../packages/render-server/ — FFmpeg stitcher/audio mixer modules loaded by the export pipeline
sidecars/                     — optional Python sidecars (marlin video understanding, musicgen, voxcpm)
resources/                    — electron-builder buildResources (icons, entitlements) + MediaPipe model
```

## How the agent actually runs (there is no HTTP API)

There are no REST routes — not for the agent, not for generation, not for scenes.
Don't `fetch`/`curl` anything. From Claude Code, use the MCP tools.

**One entry point, three hops:**

```
renderer  ──ipcRenderer.invoke('dreambyte:agent.start', body)──►  src/electron/ipc/agent.ts
                                                                      │
                                       src/lib/services/agent-runner.ts ◄──┘  (runAgentRequest)
                                                                      │
                                                src/lib/agents/runner.ts ◄──┘  (runAgent — the loop)
```

`agent.ts` also owns `dreambyte:agent.abort`, `.subscribed`, `.activeRunIds`, and the
cross-project dispatch handlers. Progress streams back as SSE-shaped events pushed on
`dreambyte:agent.event` (`webContents.send`), not over HTTP.

Everything else is the same shape — an `ipcMain.handle` in `src/electron/ipc/`:
`dreambyte:generate.*` (per scene type), `dreambyte:scene.{get,writeHtml,readHtml}`,
`dreambyte:projects.*`, `dreambyte:exportTier3`, `dreambyte:publish.run`.
`src/electron/ipc/index.ts` is the full list.

**Claude Code / Cursor** reach the same tools over MCP: `.mcp.json` runs
`scripts/mcp/mcp-connect.js`, which proxies stdio to the app-managed `scripts/mcp/mcp-server.ts`
daemon, which calls back into the app through `src/electron/mcp-bridge.ts`
(a 127.0.0.1 HTTP server with a per-launch bearer token — an internal transport, not a
public API). App not running ⇒ every tool returns "Dreambyte is not running".

## How a scene gets written

Tool calls do NOT write the database. The agent mutates an **in-memory world**
(`src/lib/agents/tool-executor.ts`), and the run's scenes land in ONE version-checked
transaction at the end via `persistScenesFromAgentRun` (`src/lib/db/queries/projects.ts`).
Skip that call — abort, crash — and nothing persists.

- **The authoritative copy is the project row's `description` blob** (JSON: scenes,
  scene graph, zdog libraries, timeline). The same transaction mirrors the scenes into
  the `scenes` table via `writeProjectScenesToTablesTx` for branch-scoped reads, but the
  table LAGS the blob (sync is lazy) — read the blob when the two disagree.
- **The `layers` table is effectively dead**: nothing inserts into it. Layers are fields
  on the scene objects in the blob. Any doc calling a layer API "the correct way to edit scenes" is wrong.
- **Scene HTML** is rendered by `generateSceneHTML()` (`src/lib/sceneTemplate.ts`) and written
  by `regenerateHTML()` (`src/lib/agents/tool-executor.ts`) — the single disk-write choke
  point every mutating handler funnels through. It also stamps verify status and skips
  the write when the run aborted. Destination is `resolveScenesDir()`
  (`src/lib/scene-html-paths.ts`): `DREAMBYTE_SCENES_DIR` when set — the packaged app points
  it at `<userData>/scenes` — otherwise `public/scenes/`. Scene ids must match
  `/^[a-zA-Z0-9\-]+$/`.

Never hand-edit a scene HTML file: `regenerateHTML` overwrites it from the world on the
next tool call. Change the scene code (`write_scene_code` / `patch_layer_code`) instead.

## Globals available in every scene HTML

- `WIDTH`, `HEIGHT` = scene dimensions in pixels (default 1920x1080, varies by project aspect ratio)
- `PALETTE` = 4-color array from style preset
- `DURATION` = scene duration in seconds
- `ROUGHNESS` = roughness level from style preset (0-3)
- `FONT` = font family from style preset
- `TOOL` = default drawing tool from style preset
- `STROKE_COLOR` = primary stroke color from style preset
- `BG_COLOR` = background color (hex string, user-overridable via Layers panel)
- `DATA` = suggestedData object (D3 template only)
- `AXIS_COLOR`, `GRID_COLOR` = chart styling (D3 template only)

## Scene types

**React is the default renderer** (`sceneType: 'react'`). Every scene is a React
component that can compose multiple renderers via bridge components:

| Bridge Component  | Use for                                                 |
| ----------------- | ------------------------------------------------------- |
| Pure JSX          | Typography, layouts, cards, step lists (80% of content) |
| `<ThreeJSLayer>`  | 3D geometry, PBR materials, shadows                     |
| `<Canvas2DLayer>` | Hand-drawn strokes, particles, procedural art           |
| `<D3Layer>`       | Data visualization, charts                              |
| `<SVGLayer>`      | Vector draw-on animations                               |
| `<LottieLayer>`   | Micro-animations, icons                                 |

Legacy types (svg, canvas2d, motion, d3, three, lottie) still work for
existing scenes but new scenes should use React.

All scenes render at the project's aspect ratio dimensions (default **1920x1080**; also supports 9:16, 1:1, 4:5) and must complete within their specified duration. Always use `WIDTH`/`HEIGHT` globals instead of hardcoding dimensions. Use `resolveProjectDimensions(aspectRatio, resolution)` from `src/lib/dimensions.ts` to get pixel values.

## Style System

Style presets are **optional and off by default** (`presetId: null`).
When no preset is active, the generator has full creative control over
colors, fonts, backgrounds, and rendering approach. Users can opt into
a preset via the Style Picker in the Layers tab.

When a preset IS active, it configures:

- Renderer preference (`preferredRenderer`: canvas2d, svg, motion, or auto)
- Roughness level (0-3)
- Default drawing tool
- Stroke color defaults
- Background texture

When generating scenes, read the style guidance in the system prompt.
The globals ROUGHNESS, TOOL, STROKE_COLOR are injected automatically
by generateSceneHTML — do not hardcode these values in scene code.

Available presets (16, `STYLE_PRESETS` in `src/lib/styles/presets.ts`): whiteboard, chalkboard,
blueprint, clean, data-story, newspaper, neon, kraft, threeblueonebrown, feynman, cinematic,
pencil, risograph, retro_terminal, science_journal, pastel_edu

Texture overlays are applied automatically after render —
do not add generateTextureCanvas() calls in scene code.

## UI Panel Layout

The editor has two distinct panel areas with different purposes:

**Layers Tab** (right panel, scene-focused):

- Style preset picker and palette/background/font overrides
- Scene settings (name, duration, background color, transitions)
- Video layer, audio layer, SVG objects, text overlays
- AI generated layers
- All scene design controls live here

**Settings Panel** (gear icon sidebar, system-focused):

- Editor theme (dark/light) — global preference, not per-project
- Usage stats
- Agents configuration
- Models & API keys
- Permissions
- Dev tools

Scene palette and style controls must NOT be in the Settings panel.
The Settings panel is for system/app configuration only.
Editor theme (dark/light) is a global preference — it does not
change when switching projects or when the agent updates globalStyle.

## Agent vs Claude Code — scene generation

Both paths share `generateSceneHTML()` (src/lib/sceneTemplate.ts) and produce identical HTML output.
Both call the same tool handlers; neither calls a REST API. The in-app agent runs the loop in
`src/lib/agents/runner.ts` with no filesystem access (sandboxed by design); `ALL_TOOLS` in
`src/lib/agents/tools.ts` defines 83 tools, of which roughly 70 are offered per turn by default. Claude
Code drives the same handlers one call at a time over MCP (`scripts/mcp/mcp-server.ts`, no runner
loop), and has the real filesystem for everything else.

`mcp-adapter.getToolDefinitions()` runs the **same** `filterToolsForAgent` gate as an in-app
run, so the two surfaces stay in step. Two deliberate divergences:

- **Provider keys are not gated over MCP.** Readiness is `!!process.env[KEY]`, and the daemon
  holds a spawn-time copy of the app's env that `setProviderKey` never refreshes — so paid
  generation tools are offered and honest-fail app-side, where the key actually is.
- **Runner-loop-only tools are not offered over MCP** — `ask_user`, `dispatch_to_branches`,
  `dispatch_to_projects`, `dispatch_subagent`, `dispatch_scene_builder`, `start_recording`.
  Their consumer is the in-app runner or the renderer; over MCP they can only honest-fail.

For static `*.dreambyte` export-folder access (no app running), use `scripts/mcp/mcp-tier2-server.ts`
— a separate stdio MCP server scoped to one Tier 2 export. Pass the folder as the
first arg: `npx tsx scripts/mcp/mcp-tier2-server.ts /path/to/project.dreambyte`. Tools:
`tier2_read_project`, `tier2_list_scenes`, `tier2_read_scene`, `tier2_read_scene_html`,
`tier2_list_assets`. All path containment goes through `src/lib/agents/dreambyte-fs/path-guard.ts`.

The agent knowledge corpus is FOUR rule packs — `.claude/skills/dreambyte/rules/`:
`three.md` (Studio3D SDK API + determinism), `audio.md`, `research.md` (media sourcing),
`generation.md` (the React scene output contract + AI image/video/avatar generation).
`.agents/skills/dreambyte/rules/` is a generated byte-mirror (`npm run gen:okf-mirror`).
There are no pipelines and no design-doctrine packs — the model owns aesthetics; piling on
rules regresses output.

## Bundled SFX library (`public/sfx-library/`)

- **ZzFX** (MIT): procedural presets → WAV via `npm run sfx-library:zzfx`; manifest uses `librarySource: "zzfx"`.
- **CC0 recordings**: OpenGameArt foley (`cc0-*`, `librarySource: "cc0"`, committed) and Kenney packs (`librarySource: "kenney-cc0"`, fetched by `npm run sfx-library:packs`).
- **SoLoud** ([jarikomppa/soloud](https://github.com/jarikomppa/soloud), **zlib/libpng** — commercial use allowed): optional imported assets should use filenames `soloud-*`, `librarySource: "soloud"`, and license text such as `zlib/libpng (SoLoud)`. See `../../docs/THIRD_PARTY_AUDIO.md` for full notices.
- **react-sounds** ([e3ntity/react-sounds](https://github.com/e3ntity/react-sounds), **MIT**): optional; vendor audio under `public/sfx-library/` with `react-sounds-*` filenames, `librarySource: "react-sounds"`, and `license: "MIT (react-sounds)"` — do not rely on CDN URLs in exported scenes unless you intend to. Details in `../../docs/THIRD_PARTY_AUDIO.md`.
- **Music Megathread** ([MoonWalker440/Music-Megathread](https://github.com/MoonWalker440/Music-Megathread)): **link directory only** — not a licensed music bundle. Do not treat it as a cleared catalog for shipped video; use Pixabay/Freesound APIs or user uploads. See `../../docs/THIRD_PARTY_AUDIO.md`.

## When generating scenes with /dreambyte

Read `.claude/skills/dreambyte/SKILL.md` for domain rules, scene type selection, and HTML templates.
