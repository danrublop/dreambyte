---
type: rule
title: Research & Media Sourcing Rules
description: Which tool sources each asset a scene needs — facts, footage, images, overlays, 3D textures — driven by brief.mediaStrategy.
tags: ["lane:media"]
timestamp: 2026-06-19T00:00:00Z
---

# Research & Media Sourcing Rules

Code-drawn motion is the default. Source real media only when a scene needs the real
thing (a real product, place, face, event) that the agent can't draw from code.

Read `brief.mediaStrategy` before sourcing anything.

## Pick one route per asset

Choose the cheapest route that clears the bar.

| Route        | Use when                                                    | Tools                                                                     |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| **RESEARCH** | Facts, figures, names, dates, or a reference to design from | `web_search`, `fetch_url_content`                                         |
| **STOCK**    | Generic real-world footage/photos, no specific subject      | `find_media({ kind:'video'\|'image'\|'archival' })`                        |
| **GENERATE** | Exact subject not in stock, or must match a style precisely | `generate_image`, AI video — see the AI Generation rules                   |
| **USER**     | The user already gave you the asset                         | `media_library({ action:'query' })`, uploaded media in the project library |

### RESEARCH — `web_search`, `fetch_url_content`

- Any claim/stat/quote/date in the script → `web_search`, cite the source in planning notes. Never invent numbers.
- Search to _see_ a real subject, then design or generate to match. The result image is a moodboard, not the final asset (licensing).
- `fetch_url_content` — full text of one source when snippets aren't enough (specs, primary doc, article to quote).

### STOCK — `find_media({ kind })`

- Cheapest authentic route. Use for real-world texture with no fixed identity: city b-roll, nature, hands typing, crowds, abstract motion backgrounds.
- `kind:'archival'` — historical/documentary beats (period events, film grain, real news). Generation can't fake real history.
- Make ONE broad search (12+ results) per subject and pick from it — near-identical repeat queries return the same material.
- Prefer stock over generate when "a coffee shop" will do — 👍 stock coffee shop / 👎 generate one, it doesn't have to be _this_ coffee shop.
- Check the returned license is clear before placing.

### USER assets

- User-supplied asset (logo, product photo, screen recording, headshot) wins over every generated/stock equivalent. Pull from project library / brand kit.
- Highest-authenticity, zero-cost. Always check for one before sourcing or generating a substitute.

## Decision shortcuts

- Must be true (stat, date, real event) → RESEARCH, then cite.
- Real but generic (b-roll, texture, mood) → STOCK.
- Real and historical → `find_media({ kind:'archival' })`.
- Specific and doesn't exist → GENERATE from a reference.
- User already has it → USER asset.
- Between stock and generate → stock first (cheaper, real, licensed).

## Overlays

### Captions — `add_captions`

- Default-ON for any narrated/spoken scene (most viewers watch muted on mobile). Applies to talking, explainer, social content.
- Legible weight, high contrast, safe-area placement (bottom third, inside the 80px inset). Match the project font. 👎 generic system font.

### Lower-thirds

- Names/titles/locations over footage. Keep in the scene's type system and palette.

### Stickers, SVGs, icons

- Use sparingly to label, point, or emphasize (arrows, circles, callout pills).
- Adopt the scene's stroke color and motion personality. 👎 default-blue arrow on a graded photo.

## Fit sourced media to the project

- Color grade: `set_layer_props` grades one layer; `apply_color` grades the whole project. Use to reconcile mixed sources.
- Framing: crop to project aspect ratio; `auto_reframe` converts a clip between aspect ratios.
- Resolution: source at or above project resolution.
- Stills: add a camera move (Ken Burns push / perspective / parallax) rather than holding a dead frame.

## 3D textures & assets — use the shipped SDK helpers

Three.js scenes run `WebGLRenderer` on r183. Everything below already ships in
`public/sdk/dreambyte-studio3d.js` — call the helper, do NOT npm-install a texture library,
and do NOT ship texture image files (storage + license risk).

| Need                                                        | Helper                                    |
| ----------------------------------------------------------- | ----------------------------------------- |
| Video playing on a mesh (TV, phone, billboard, cinema)      | `buildVideoTexture`                       |
| Animated GIF on a mesh                                      | `buildGifTexture`                         |
| PBR surface — wood, brick, concrete, planet, dots, grid     | `buildProceduralMaterial`                 |
| Logo/screenshot projected onto a 3D surface from an angle   | `buildProjectedMaterial`                  |
| Brand reveal — texture shatters into instanced cubes        | `buildShatterReveal`                      |
| Crisp 2D text labels / annotations / step numbers in 3D     | `buildLabel3D`, `buildSpriteAtlas`        |
| Many small textures → one atlas (cuts draw calls)           | `mergeTextures` / `mergeTexturesAsync`    |
| Sound localized to a mesh's world position                  | `buildPositionalAudio` (3D), `buildPannedAudio` (2D L/R) |

`buildProceduralMaterial` kinds: `wood`, `bricks`, `concrete`, `polkaDots`, `grid`,
`halftone`, `planet`, `gasGiant`. Zero bandwidth, all params are uniforms — animate
them for reveals. If a scene needs a kind not in that list, pick the nearest one or
draw the surface another way.

### 3D gotchas

- `buildProjectedMaterial` bakes camera + mesh world matrices at project time. Projector camera moves after that ⇒ the projection drifts; re-project each frame (it's a uniform update, cheap).
- `buildLabel3D` sprites face the camera (correct for billboard text). For a label stuck flat on a surface, use a plane mesh with the same texture.
- Atlas output is power-of-two and padded — budget ~1.5× the sum of inputs, and there's no dispose; don't atlas per-frame.
- `buildGifTexture` is not timeline-scrubbable. If the GIF must scrub, transcode to MP4/WebM and use `buildVideoTexture`.
- Prefer WebM + `buildVideoTexture` over GIF generally — smaller and hardware-decoded.
- `tsl-textures` and other WebGPU/TSL libraries are NOT available — they need `three/webgpu`, which these scenes don't use. `buildProceduralMaterial` is the answer.

## Rules

- Read `brief.mediaStrategy` before sourcing; don't default to GENERATE.
- Never state a fact you didn't verify with `web_search` / `fetch_url_content`.
- Search results are moodboard — re-source or generate the final, licensed asset.
- USER > STOCK > GENERATE on cost and authenticity.
- `find_media({ kind:'archival' })` for real history — never fake it with generation.
- `add_captions` ON for any narrated/spoken scene.
- Every sourced asset: grade, crop to safe area, match the palette.
- AI video only when motion of a non-existent subject is required; else still + camera move.
