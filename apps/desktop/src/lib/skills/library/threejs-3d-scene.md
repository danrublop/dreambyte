---
id: threejs-3d-scene
type: skill
title: Three.js 3D Scene
timestamp: 2026-06-17
tier: on-demand
name: Three.js 3D Scene
category: 3d
tags: [three, threejs, 3d, webgl, scene, camera, mesh, material, environment]
sceneType: three
complexity: complex
requires: []
description: Three.js r183 3D scenes with PBR materials, environments, and camera animation. For immersive 3D content, data scatter plots, and WebGL effects.
parameters:
  - name: environment
    type: string
    default: track_rolling_topdown
    description: Stage environment ID
  - name: camera
    type: string
    default: perspective
    description: Camera type
    enum: [perspective, orthographic]
---

## Scene contract — READ FIRST

- A `three` scene is a **raw vanilla-JS script**, NOT a React component. Do NOT use React, JSX, `export default`, `useEffect`, `React.createElement`, or a `<div ref>` — `React` is not defined in this context and the scene will throw.
- **Frame clock only — NEVER drive your own loop.** Do not call `requestAnimationFrame`, `performance.now`, `Date.now`, or define a `loop()`. Drive all motion from the master anime.js timeline (seconds): define `window.__updateScene = (t) => renderAtTime(t)` (t = seconds) and/or sequence with `window.__tl`. The renderer seeks frames deterministically; wall-clock timing breaks frame-accurate export.
- Never hardcode 1920×1080 — read `WIDTH`/`HEIGHT` from `window`.

## Three.js Scenes

- Use **Three.js r183** via ES modules: `import * as THREE from 'three';` and read `WIDTH, HEIGHT, PALETTE, DURATION, MATERIALS, mulberry32, setupEnvironment, applyDreambyteThreeEnvironment, updateDreambyteThreeEnvironment` from `window`.
- Set `window.__threeCamera = camera` for editor camera moves.
- **Stage environment:** call `applyDreambyteThreeEnvironment(envId, scene, renderer, camera)` once for a full backdrop + lighting rig. Each frame call `updateDreambyteThreeEnvironment(window.__tl?.time?.() ?? t)` so animated envs scrub with the timeline. Ids: `studio_white` | `cinematic_fog` | `iso_playful` | `tech_grid` | `nature_sunset` | `data_lab` | `track_rolling_topdown`. Unknown ids fall back to `studio_white`.
- **3D scatter plots:** `createDreambyteDataScatterplot(scene, { points: [{x,y,z}, …], pointRadius, color })` returns instanced spheres + RGB axes, auto-centered and scaled to the stage; call `updateDreambyteDataScatterplot(t, { orbitSpeed })` each frame for the slow orbit. Pair it with `applyDreambyteThreeEnvironment('track_rolling_topdown', …)`. Both are window globals — no import.
- Add hero content (models, meshes, story motion) on top of the environment; do not delete group `__dreambyteEnvRoot`.
- Prefer `MeshStandardMaterial` / `MeshPhysicalMaterial`; use `setupEnvironment(scene, renderer)` for PBR reflections when the scene is studio-like and you are not using a conflicting full-sky env.

## When to Use Three.js

- 3D product showcases, architectural walkthroughs
- Data scatter plots in 3D space
- Particle systems with GPU acceleration
- Immersive environments and camera flyovers
- WebGL shader effects

## Gotchas

- NEVER use CapsuleGeometry (not available in r183)
- Always set `window.__threeCamera` for editor integration
- Don't delete `__dreambyteEnvRoot` group when using environments
