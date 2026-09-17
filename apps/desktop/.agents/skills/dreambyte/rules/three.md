---
type: rule
title: Three.js Scene Rules (r183 + Studio3D SDK)
description: One pack for 3D — studio/lighting, camera, materials/shaders, particles/terrain, post-FX, 3D text, and avatars, plus the ThreeJSLayer bridge contract and export determinism.
tags: ["renderer"]
timestamp: 2026-06-19T00:00:00Z
---

# Three.js Scene Rules (r183 + Studio3D SDK)

Standard three.js knowledge applies — only the Dreambyte-specific rules below matter. Every `build*` / `MATERIALS` / `StudioCamera` / `CAMERA_PRESETS` / `TEXT_EFFECTS` name is injected on `window` by the Studio3D SDK (`/sdk/dreambyte-studio3d.js`). **Never import them.**

## Hard rules

- **Build inside the bridge:** `<ThreeJSLayer setup={(THREE, scene, camera, renderer) => {}} update={(scene, camera, frame, config) => {}} />`. It owns the render loop and drives it frame-by-frame (scrub-safe). Never write your own canvas or WebGL loop.
- **Never dynamically import three.js addons** — `FontLoader`, `TextGeometry`, `SVGLoader`, `GLTFLoader`. They load a SECOND THREE beside the UMD `window.THREE` and the scene renders **blank**. Use the SDK text/SVG/avatar helpers, which call vendored classic-script versions sharing the UMD global.
- **Determinism (export correctness):** no `Math.random()`, no `Date.now()`, no `requestAnimationFrame`. Use the template-injected `mulberry32(seed)` — same seed, identical frames every pass. Every SDK helper here is deterministic at time `t`; the sole exception is `buildCameraControls(camera, renderer, { interactive: true })` (`window.CameraControls`), which is preview-only.
- `setup`/`update` are separate closures — stash refs on `window.__*` or `scene.userData`. `updateShaderMaterials(scene, t)` must run every frame or `MATERIALS.hologram/xray/pulse/fresnel` freeze.
- Default to `buildInfiniteStudio(...)`. Over 5s, use ≥2 `makeStudioSet`s plus a camera journey — one rotating shape is the weakest 3D pattern.
- No `MeshBasicMaterial`, no AmbientLight-only rigs, no hardcoded hex (use `PALETTE[]`). Subtitles and body copy go in an HTML `<AbsoluteFill>` overlay at `zIndex: 1`, never in 3D.

## The scaffold (`type: 'react'`)

```jsx
<ThreeJSLayer
  setup={(THREE, scene, camera, renderer) => {
    const studio = buildInfiniteStudio(THREE, scene, camera, renderer)
    window.__box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), MATERIALS.metal(PALETTE[0]))
    window.__box.position.y = studio.floorY + 1
    window.__box.castShadow = true
    scene.add(window.__box)
    StudioCamera.setCamera(camera)
    StudioCamera.park([0, 3, 12], [0, 0, 0])
  }}
  update={(scene, camera, frame, config) => {
    const t = frame / config.fps
    updateShaderMaterials(scene, t)
    if (window.__box) window.__box.rotation.y = t * 0.4
    StudioCamera.follow(t, [
      { t: 0, pos: [0, 3, 12], lookAt: [0, 0, 0] },
      { t: 7, pos: [6, 4, 8], lookAt: [0, 0, 0], ease: 'expo.out' },
    ])
  }}
/>
```

Legacy standalone `type: 'three'` scenes have no bridge: drive them from `window.__tl` (the master anime.js Timeline; seconds) with a proxy tween — `const s = { t: 0 }; window.__tl.add(s, { t: [0, DURATION], duration: DURATION, ease: 'linear', onUpdate: () => renderAt(s.t) }, 0)` — calling `renderer.render(scene, camera)` inside `renderAt` plus once up front for the paused frame (or subscribe with `window.__dreambyte.onTick((t) => renderAt(t))`). Never call play/pause on `__tl`.

## Studio

`buildInfiniteStudio(THREE, scene, camera, renderer, { color:'white'|'dark'|'midnight'|hex, gridColor, gridSpacing, floorY, fog, shadows, envIntensity })` → `{ floorY, lights:{ambient,key,fill,rim}, grid, setColor(), setLights() }`. Ships a 3-point rig + procedural IBL; `envIntensity: 0` kills reflections.

Shadows need all four: `renderer.shadowMap.enabled` (studio sets it), `light.castShadow`, `mesh.castShadow`, `floor.receiveShadow`.

## Camera

`StudioCamera.*` take an optional trailing `cam` (defaults to `setCamera()`'s). Call in `update`; stateless.

- `setCamera(camera)`, `park(pos, lookAt)` — in `setup`.
- **`follow(t, [{ t, pos, lookAt, ease? }])` — PRIMARY for all camera motion.** Hold = repeat a pos; `ease` applies INTO that keyframe.
- Alternates: `orbit(t, opts)`, `dolly(t, duration, opts)`, `crane(t, opts)`, `spiralApproach(t, opts)`, `rackFocus(t, duration, cam, fromFOV, toFOV)`.
- `autoFrame(mesh, camera, { padding })` frames an object in `setup`, no distance guessing; `fitTo(mesh, { padding })` → `{ position, target }` for a `follow()` keyframe.

Easings: `linear`, `smooth`, `expo.out` (default), `expo.in`, `expo.inout`, `spring`, `bounce`.

`CAMERA_PRESETS.<name>(t, { target, duration, ...radius/dist/height pairs }, camera)`: `productReveal`, `cinematicSweep`, `heroDescend`, `pushIn`, `rackFocusReveal`.

`makeStudioSet(THREE, scene, [x,y,z])` → `{ addText(str, opts), addMesh(mesh), cameraPos(dist), lookAtPoint() }` — AE-style staging: sets sit 20–40 units apart in world space, the camera edits between them. `buildSceneSequencer({ name: set, ... })` drives it: `seq.cut(t, 'name')`, `seq.move(tStart, tEnd, 'from', 'to', ease)`, `seq.update(t, camera)` each frame. It emits `follow()` keyframes internally, so it stays scrub-safe.

`DreambyteCamera.orbit(opts)` / `.dolly3D(opts)` — call inside `React.useEffect(() => {...}, [])`. **There is no `<DreambyteCamera>` JSX tag.**

## Materials

`MATERIALS.<name>(color)`: `plastic`, `metal`, `glass`, `matte`, `glow`, `clearcoat`, `iridescent`, `velvet`, `lowpoly`; shader-backed (need `updateShaderMaterials`) `hologram`, `xray`, `pulse`, `fresnel(base, rim, opts)`.

Trap-free: `buildToonMaterial` (animate `mat.uniforms.uLightPos`), `buildDissolveMaterial` (`reverse` materializes in), `buildOutlineMaterial` (add the mesh, then a `clone()` wearing it), `enhanceMaterial(THREE, material, opts)`, `buildMorphBetween(THREE, scene, geoA, geoB, opts)` → `.setProgress(0-1)`, `buildMorphingShape` → `.update(t)`, `buildVideoTexture(THREE, url, opts)` → `{ texture, mesh, dispose }`. `buildMagicMarbleMaterial` and `buildProceduralMaterial` tick via `mat.userData.update(t)`; marble **cannot** be wrapped by `extendMaterial`.

- `buildWaveMaterial(THREE, { amplitude, frequency, speed, axis })` — **axis trap:** a plane rotated `-PI/2` needs `axis:'z'` for up/down waves; the default `'y'` displaces forward/back.
- `extendMaterial(THREE, BaseMaterial, { uniforms, vertexShader, fragmentShader, ... })` — shader chunks that keep shadows/fog/lighting; write `csm_Position`/`csm_Normal`/`csm_DiffuseColor`/`csm_FragColor`/`csm_Roughness`/`csm_Metalness`/`csm_Emissive`. Needs `/vendor/three-custom-shader-material.js`.
- `buildCSM(THREE, scene, camera, opts)` — set `camera.far` + `updateProjectionMatrix()` **before**; `csm.setupMaterial(mat)` on every caster; `csm.update()` every frame. Needs `/vendor/three-csm.js`.
- `applyPCSS(THREE, material, { lightSize })` — soft shadows on a `receiveShadow` material. **Call before the mesh joins the scene**, else set `material.needsUpdate = true`.
- `buildProceduralMaterial(THREE, kind, { scale, color1..3, ... })` — shader surfaces instead of image assets. Kinds `wood`, `bricks`, `concrete`, `polkaDots`, `grid`, `halftone`, `planet`, `gasGiant` (the only animated one). `wood`/`concrete`/`planet`/`gasGiant` are world-space — moving the mesh shifts the pattern; the rest UV-space. If the r183 chunk patch no-ops the material renders **flat white**; `[Studio3D] procMat=function` confirms it loaded.
- `buildGifTexture(THREE, url, opts)` adds `.update()`, but **GIFs are NOT scrubbable** (browser owns the clock) — transcode to MP4 + `buildVideoTexture` for frame-accurate sync.
- `buildProjectedMaterial(THREE, { camera, texture, cover, backgroundOpacity, ... })` — `mat.project(mesh)` once after the mesh is in final position (it bakes world matrices). `backgroundOpacity < 1` needs `transparent: true`. InstancedMesh: `mat.allocateProjectionData(geo, count)` **before** constructing the mesh, then `mat.projectInstanceAt(i, inst, matrix)`.
- `mergeTextures(THREE, { key: tex }, opts)` / `mergeTexturesAsync` → `{ texture, makeTexture(key), applyToGeometry(geo, key), dispose }`. Sync **throws on undecoded images** — use async after `TextureLoader.load()`. `applyToGeometry` mutates UVs in place. Never mix sRGB and linear inputs in one atlas.

## Particles, terrain, connections

All `(THREE, scene, opts)` → object with `.update(t)`; seeded ones accept `seed`.

Trap-free: `buildParticleField`, `buildParticles` (`shape`, `.explode(tSinceStart, secs)`), `buildDataParticles(THREE, scene, points, opts)`, `buildTrailPath(THREE, scene, [{ t, pos }], opts)`, `buildProceduralTerrain`, `buildRippleWater`, `buildOcean`, `buildFlatFloor`, `buildGrass`, `buildFlyLine`, `buildInstanced({ layout, getColor(i, rng), ... })` → `.update(t, fn)`, `.updateInstance(i, pos, sc, rot)`.

- `buildExplosion(opts)` — **`.update(t - triggerTime)`; pass time since trigger, not scene time.**
- `buildCloudField(opts)` — **`.update(t, camera)`; the camera arg is required** or billboards don't face the camera.
- `buildScreenPlane(opts)` — draw via `screen.ctx.*`, then `screen.refresh()` to push canvas → texture.
- `buildShatterReveal(THREE, { scene, geometry, texture, count, cubeSize, duration, swarmDistance, stagger, projector })` → `.update(t)`, `.setProgress`. The target geometry is **not** added to the scene. Keep `stagger * duration < duration` or the last cubes never arrive; `count` > ~10000 stalls the CPU matrix loop.
- `buildConnectionLine(THREE, scene, from, to, opts)` → `.drawOn(tSinceStart, duration)` — GPU draw-on, ≤20 animated edges. Past ~30 use `buildInstancedLines(THREE, scene, pairs, opts)` → `.update(newPairs)`.
- `buildLightShaft({ origin, direction, length, angle, dustCount })` — **`.update(t)` required every frame** for dust/flicker.

## Post-FX & audio

`applyPostFX(renderer, scene, camera, { bloom, vignette, grain, chromaticAberration, lensDistortion, tonemap })` — call ONCE in `setup`; it renders automatically, no `update()` wiring. Live: `setBloomStrength`, `setLensDistortion`, `setVignette`. Legacy `createPostProcessing(renderer, scene, camera, { bloom })` needs `pp.render()` in `update` instead. Hand-rolled composers must end with `OutputPass`.

`applyDepthOfField(renderer, scene, camera, { focusDistance, aperture, maxBlur, blurPasses, debugCoC })` → `{ render, setFocus, ... }`. Set `camera.near`/`far` **before** calling. Register as `scene.userData.__dreambyteComposer = { render: () => dof.render() }` and **never call `render()` yourself**; stash the handle to animate focus from `update`.

`buildGlitchEffect(THREE, renderer, opts)` → `.setIntensity`, `.apply(t)`. `buildTimeline(clips)` → `{ update(t), add(clip) }`, clips `{ mesh, prop, from, to, start, end, ease }` over `position.*`, `rotation.*`, `scale`, `material.opacity`, `visible`.

**Audio helpers are runtime-only — they do NOT add a timeline clip and are NOT in the MP4 export audio track.** Use `add_track` + `place_clip` (or `set_media_layer(kind:'audio')`) for real audio.

- `buildPannedAudio({ src, pan, volume, loop, autoplay })` → `.setPan(-1..1)`, `.tick(frame, fps)`. Mount once behind a `window.__x` guard (the React tree re-evaluates every render). **`tick()` every render** or pause/scrub is ignored; `setPan()` before `tick()`.
- `buildPositionalAudio(THREE, { camera, attachTo | scene + position, src, refDistance, rolloff, coneAngle })` → `.play()`, `.tick(frame, config.fps)`. Async decode queues an early `play()`; one reused `AudioListener` per camera.

## 3D text

- `buildText3D(THREE, text, { size, color, font, outlineColor, billboard, ... })` → Mesh. Canvas plane, **sync**; upgrades to SDF when `window._troika` is present. Labels and callouts.
- `buildExtrudedText(THREE, text, { size, depth, bevel, effect, font, perChar, charSpacing, ... }, onReady(group, chars))` → group — **hero text**. Async font fetch: the group returns **empty**, so `scene.add()` it immediately and grab refs in `onReady`. Fonts `helvetiker`, `helvetiker_bold`, `optimer`, `gentilis`, `droid_sans`, `droid_serif`, `mplus`. `buildTextPath(THREE, text, controlPoints, opts, onReady)` is the same contract along a curve.
- `animateChars(group, t, { entrance:'rise'|'drop'|'pop'|'wave'|'flip'|'scatter'|'fade', delay, duration, distance, amplitude, reverse })` — needs `perChar: true` at build time.
- `buildTextParticles(THREE, scene, text, opts)` → `.update(t, { mode:'converge'|'disperse'|'shimmer'|'chaos'|'text', startT, duration })`.
- `applyTextGradient(THREE, group, colorA, colorB, opts)` once in `onReady`; `animateTextSweep(THREE, group, t, opts)` per frame.
- `buildNeonSign(THREE, scene, opts)` → `.update(t)`; needs `window._troika` — before it loads the sign renders as a glowing box. `buildCounterAnimation(THREE, scene, opts)` → `.update(t)`.
- `buildLabel3D(THREE, text, opts)` → Sprite; batch via `buildSpriteAtlas(THREE, { size })` + `atlas.label3D(...)` (N labels, one GPU upload). Sprites **always billboard**. `atlas.dispose()` on teardown; `releaseLabel(sprite)` doesn't reclaim shelf space.

`TEXT_EFFECTS` keys (shared with `buildExtrudedSVG` as `effect:`, or `TEXT_EFFECTS.glass(THREE, color)` to tweak): `glass`, `chrome`, `gold`, `ice`, `obsidian`, `neon`, `pearl`, `matte`. **Bloom only for `neon` or `glow: true`** — on chrome/gold/glass it reads as fake glow.

## SVG-to-3D, models

`buildSVG3D(THREE, opts)` → `Promise<Mesh|Group>`. Prefer `buildExtrudedSVG(THREE, url, opts, onReady)`: `effect` (TEXT_EFFECTS plus `rubber|clay|brushed`), `bevel` (single-color only), `fitSize` (bbox max-dim → world units, ~3.2), `palette` (fallback for gradient/`url(#...)`/none fills), `glow` + `glowColor`, `color` (forces every path; omit and SVG fills flow through), `mergeMultiColor: false` (escape hatch for per-path animation). `depth` is in **raw SVG-coord units** — default `bbox * 0.18`, so hardcoding 20 turns a 24px icon into a tower; `bevelThickness`/`bevelSize` derive from it. Multi-color SVGs auto-merge into ONE vertex-colored mesh (bevel auto-off, animate it as a whole). **Never pass `csg`/`csg3d`** — dead toggles.

`setupEnvironment(scene, renderer)`, never a bare `RGBELoader().load(...)` — it lights the **first frame** procedurally, upgrades to HDRI on load, and keeps the fallback on a 404; a bare loader leaves metals dark for ~50–500ms. Pair with `THREE.AgXToneMapping` + `toneMappingExposure = 0.85`.

Models: CC0 GLBs at `/models/library/`; `find_media(kind:'3d')` returns a ready-to-load url. After loading, `model.scale.setScalar(...)` and traverse meshes setting `castShadow`/`receiveShadow`.
