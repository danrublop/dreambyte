/**
 * dreambyte-studio3d.js — 3D Studio SDK for Dreambyte AI video scenes.
 *
 * Globals exposed on window:
 *
 *   buildInfiniteStudio(THREE, scene, camera, renderer, opts?) → Studio
 *     Full white infinite studio: sky, grid, lighting, IBL env map.
 *     opts: { color, gridColor, gridSpacing, fog, floorY, shadows }
 *
 *   buildText3D(THREE, text, opts?) → THREE.Mesh
 *     Canvas-texture plane in 3D space. Sync, no font loading. Good for overlays.
 *     opts: { size, color, font, weight, align, maxWidth, lineHeight,
 *             outlineColor, position, rotation, billboard }
 *
 *   buildExtrudedText(THREE, text, opts, onReady?) → THREE.Group
 *     Real 3D extruded text with PBR materials. Async font load (cached after first use).
 *     opts: { size, depth, bevel, bevelSize, bevelThickness, bevelSegments, curveSegments,
 *             effect, color, material, font, align, position, rotation, perChar, charSpacing }
 *     effect: 'glass'|'chrome'|'gold'|'ice'|'obsidian'|'neon'|'pearl'|'matte'
 *     font: 'helvetiker_bold'|'helvetiker'|'optimer'|'gentilis'|'droid_sans'|'droid_serif'|'mplus'
 *     perChar: true → individual char meshes; animateChars() drives their animation.
 *     onReady(group, chars) fires when geometry is built.
 *
 *   TEXT_EFFECTS — material factory map { glass, chrome, gold, ice, obsidian, neon, pearl, matte }
 *     Call TEXT_EFFECTS.chrome(THREE, '#hexcolor') → MeshPhysicalMaterial
 *
 *   animateChars(group, t, opts)
 *     Drive per-character entrance/idle on groups built with perChar:true.
 *     Call in ThreeJSLayer update() each frame.
 *     entrance: 'rise'|'drop'|'pop'|'wave'|'flip'|'scatter'|'fade'
 *     opts: { delay, duration, distance, amplitude, waveSpeed, reverse }
 *
 *   buildTextParticles(THREE, scene, text, opts, onReady?) → api
 *     Rasterize text into a GPU InstancedMesh particle cloud.
 *     Returns api { group, update(t, opts2), setColor(hex), dispose() }
 *     Call api.update(t, { mode, startT, duration }) in ThreeJSLayer update().
 *     mode: 'converge' | 'disperse' | 'shimmer' | 'chaos' | 'text'
 *     opts: { size, color, step, particleSize, disperseRange, font, position }
 *
 *   buildTextPath(THREE, text, pathPoints, opts, onReady?) → THREE.Group
 *     Distribute extruded chars along a CatmullRomCurve3 path.
 *     pathPoints: [[x,y,z], ...] control points
 *     opts: inherits buildExtrudedText opts + { tension, closed, startU, spanU, tiltToTangent }
 *     onReady(group, chars) fires when font is loaded and chars are placed.
 *
 *   applyTextGradient(THREE, group, fromColor, toColor, opts)
 *     Apply left-to-right color gradient across chars. Call once in onReady callback.
 *     opts: { axis: 'x'|'reverse', emissive: boolean }
 *
 *   animateTextSweep(THREE, group, t, opts)
 *     Animate a color/glow wave sweeping across chars. Call in update() each frame.
 *     opts: { from, to, speed, width, emissive, direction: 'forward'|'reverse'|'ping-pong', mode: 'color'|'glow'|'both' }
 *
 *   buildExtrudedSVG(THREE, svgUrl, opts, onReady?) → THREE.Group
 *     Real 3D extruded SVG with PBR materials. Async fetch, returns empty Group immediately.
 *     Parallel API to buildExtrudedText — same effect/material/bevel/center/fitSize/position keys.
 *     opts: { depth, bevel, bevelSize, bevelThickness, bevelSegments, curveSegments,
 *             effect, color, palette, material, fitSize, center, position, rotation, castShadow }
 *     effect: 'glass'|'chrome'|'gold'|'ice'|'obsidian'|'neon'|'pearl'|'matte'
 *     onReady(group, paths) fires after the SVG is parsed and geometry is built.
 *     Path colors: SVG fill → opts.color override → opts.palette fallback (when fill is gradient/url()).
 *
 *   extrudeSVGFile(THREE, url, opts, onReady) — legacy; prefer buildExtrudedSVG.
 *   extrudeSVGPaths(THREE, paths, opts) → THREE.Group — legacy sync variant.
 *
 *   StudioCamera — keyframe + easing camera system
 *     .setCamera(cam)
 *     .follow(t, keyframes, cam?)   — declarative timeline-driven position
 *     .orbit(t, opts, cam?)         — circular orbit
 *     .dolly(t, duration, opts, cam?) — dolly in/out
 *     .crane(t, opts, cam?)         — vertical crane
 *     .rackFocus(t, dur, cam?, fromFOV, toFOV) — FOV animation
 *
 *   makeStudioSet(THREE, scene, offsetPos?) → THREE.Group
 *     Group placed at offsetPos for After-Effects-style multi-set staging.
 *     .addText(text, opts) — adds buildText3D to the group
 *     .addMesh(mesh)       — adds any mesh to the group
 *     .cameraOffset()      — returns default camera position to see this set
 *
 *   buildGrass(THREE, scene, opts?) → { mesh, update(time) }
 *     Circular grass patch. Looks infinite when camera is close.
 *     opts: { radius, count, color, bladeH, bladeHVar, windSpeed, y }
 *     Call update(time) from ThreeJSLayer's update callback.
 *
 *   buildOcean(THREE, scene, opts?) → { water, update() }
 *     Reflective water plane (Three.js Water shader).
 *     opts: { size, waterColor, sunColor, distortionScale, sunDirection, y }
 *     Requires Water.js loaded before this script (window.THREEWater).
 *     Call update() from ThreeJSLayer's update callback.
 *
 *   buildProjectedMaterial(THREE, opts) → ProjectedMaterial (extends MeshPhysicalMaterial)
 *     Slide-projector material: a texture (image or VideoTexture) projected onto a
 *     mesh from a chosen camera. Use cases: video on a 3D screen, logo on a curved
 *     product, multi-projector lighting, per-instance decals on InstancedMesh.
 *     opts: { camera, texture, textureScale, textureOffset, cover, backgroundOpacity,
 *             ...any MeshPhysicalMaterial option (color, roughness, envMap, transparent) }
 *     Methods on the returned material:
 *       material.project(mesh)                           — bake the projection snapshot
 *       material.allocateProjectionData(geometry, n)     — instanced setup
 *       material.projectInstanceAt(i, instMesh, matrix)  — per-instance projection
 *     The mesh and camera can move freely after project(); call project() again to reproject.
 *
 *   buildSpriteAtlas(THREE, { size?, debug? }) → atlas
 *     Dynamic 3D text-label atlas. One canvas → one GPU upload → many sprites with
 *     sub-UV textures sharing memory. Use for callouts, step numbers, axis labels,
 *     character name tags, annotations on technical diagrams.
 *     atlas.label3D(text, opts) → THREE.Sprite (configured with sub-UV texture)
 *       opts: { font, fontSize, fontWeight, color, bgColor, padding, paddingX, paddingY,
 *               borderColor, borderWidth, radius, worldHeight (default 0.6),
 *               position: [x,y,z], scale, anchor: 'center'|'top'|'bottom', depthTest }
 *     atlas.releaseLabel(sprite) — clear the canvas slot for re-allocation
 *     atlas.flush()              — mark texture for GPU re-upload after batch updates
 *     atlas.dispose()            — free GPU resources
 *
 *   buildLabel3D(THREE, text, opts) → THREE.Sprite
 *   buildLabel3D(THREE, atlas, text, opts) → THREE.Sprite
 *     Convenience: lazily creates a shared global atlas if you don't pass one.
 *
 *   mergeTextures(THREE, hashOrArray, opts) → { texture, ranges, makeTexture, applyToGeometry, dispose }
 *     Pack many already-loaded textures into one POW2 atlas. Use for draw-call
 *     reduction (20 small textures → 1 GPU upload, 1 material). Returns per-key
 *     UV ranges plus helpers: makeTexture(key) → cloned texture sub-UV pointing
 *     at that slot (shares atlas via .uuid), applyToGeometry(geo, key) → bake the
 *     UVs into geometry.attributes.uv so a single shared material renders all of it.
 *     opts: { size? (auto-pow2), padding? (1px), background? (transparent) }
 *     mergeTexturesAsync(THREE, hashOrArray, opts) → Promise<result> — waits for
 *     image decode before merging; use when textures may not be ready yet.
 *
 *   buildShatterReveal(THREE, opts) → { mesh, projectorCamera, update(t), dispose }
 *     Codrops "swarm-in" brand-reveal preset: samples N points on a target
 *     geometry, places a small cube at each, projects the texture from a
 *     camera so each cube carries its slice of the image, animates cubes from
 *     scattered positions to their resting place. Per-instance delays + ease-out
 *     produce the "wave" assembling effect.
 *     opts: { scene, geometry, texture, count?: 2000, cubeSize?: 0.04,
 *             duration?: 1.5, swarmDistance?: 4, stagger?: 0.6, projector?,
 *             ease?, color?, roughness?, metalness?, cover? }
 *     Use for logo reveals, title cards, scene openers. Pair with bloom postfx.
 *
 *   buildPannedAudio({ src, pan?, volume?, loop?, autoplay? })
 *     → { audio, play, pause, stop, tick(frame, fps), setPan(p), setVolume(v), dispose }
 *     2D L/R stereo panning via Web Audio StereoPannerNode. Works in any scene
 *     type. pan: -1 (full left) … +1 (full right).
 *     Timeline-aware: call .tick(frame, fps) every render — auto-pauses when
 *     the timeline pauses, seeks on scrub. Without .tick(), audio plays freely
 *     and ignores playback controls. NOTE: this is a runtime helper; it does
 *     NOT add a clip to the project's timeline. For timeline clips, use the
 *     add_track + place_clip MCP tools.
 *
 *   buildPositionalAudio(THREE, { camera, src, scene? | attachTo?, position?,
 *                                  refDistance?, rolloff?, maxDistance?,
 *                                  volume?, loop?, autoplay?, coneAngle? })
 *     → { audio, listener, play, pause, stop, tick(frame, fps), setPosition, setVolume, dispose }
 *     3D positional audio with HRTF + distance falloff via THREE.PositionalAudio.
 *     Camera shares one AudioListener (lazy-attached). Pass attachTo:mesh to
 *     follow a moving object, or scene+position for a fixed source.
 *     Same .tick(frame, fps) contract — call from update() each frame for
 *     timeline-synced playback. Same caveat re: not a project track.
 *
 * Dependencies: window.THREE (loaded before this script)
 * Optional: window.SVGLoader (from /vendor/three-addons-160/SVGLoader.js)
 *           window._troika (from troika-three-text, if loaded separately)
 *           window.THREEWater (from /vendor/three-addons-160/Water.js — needed for buildOcean)
 */
(function (w) {
  'use strict';

  var SDK_VERSION = '2026-04-30-procedural-materials';

  // ─────────────────────────────────────────────────────────────────────────────
  // MULTI-COLOR EXTRUSION TUNING
  // ─────────────────────────────────────────────────────────────────────────────
  // All thresholds for the multi-color SVG → 3D pipeline live here so they can
  // be reasoned about together. Mesh-local SVG coords run roughly 0..bbox-max
  // (typical 24 for icons up to ~1000 for hi-res logos). Quantization values
  // assume that range — if you start scaling geometry BEFORE _finalize runs,
  // these would need to scale with it.

  // BSP rescue: keep the original (un-CSG'd) mesh when BSP returns < this
  // fraction of input polygons. 0.5 catches catastrophic carving (e.g.
  // Google G's red mesh shrinking to a sliver) while leaving room for
  // legitimate bevel-overlap trims (typically remove < 5% of polys).
  var CSG3D_KEEP_RATIO = 0.5;

  // BSP rescue: also revert when the result's bbox center is shifted by
  // more than this fraction of the input mesh's longest XY side. Catches
  // three-csg-ts's "subtract returns the mask, not the subtractee" bug
  // we observed on Google G. Lower would over-rescue legitimate carves
  // where the result genuinely concentrates to one side; higher would
  // miss the displacement bug.
  var CSG3D_BBOX_SHIFT_LIMIT = 0.5;

  // BSP coplanar-faces workaround: shift each path's geometry by this Z
  // increment before BSP, and undo afterward. Must be > three-csg-ts's
  // Plane.EPSILON (1e-5) and far below the smallest visible bevel/depth.
  var CSG3D_Z_EPSILON = 1e-3;

  // Plane-pair interior-face cull: triangle-plane bucket key quantization.
  // Both loosened from the original 100. Polygon-clipping does the 2D path
  // diff at sub-pixel precision but adjacent paths' "shared" cut-edges
  // aren't bit-exact — they drift by ~0.01-0.05 SVG units. Side-wall planes
  // inherit that drift, so a tighter precision misses most of the
  // back-to-back wall pairs and leaves visible interior stripes — notion's
  // N outline z-fights against the silhouette's hole.
  //   QN=50: 0.02 normal precision (~1.1° angular tolerance, still tight
  //   enough to avoid false matches).
  //   QD=20: 0.05 offset precision (well below typical seam-edge spacing).
  var INTERIOR_CULL_QN = 50;
  var INTERIOR_CULL_QD = 20;

  // ─────────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────────────────────

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Easing functions — all take t in [0,1] and return value in [0,1].
  var EASING = {
    linear:   function (t) { return t; },
    smooth:   function (t) { return t * t * (3 - 2 * t); },             // smoothstep
    smooth2:  function (t) { return t * t * t * (t * (6 * t - 15) + 10); }, // smootherstep
    'expo.in':  function (t) { return t === 0 ? 0 : Math.pow(2, 10 * t - 10); },
    'expo.out': function (t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    'expo.inout': function (t) {
      if (t === 0 || t === 1) return t;
      return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
    },
    spring: function (t) {
      var c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    bounce: function (t) {
      var n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) { t -= 1.5 / d1;  return n1 * t * t + 0.75; }
      if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
      t -= 2.625 / d1; return n1 * t * t + 0.984375;
    },
  };

  function applyEasing(t, name) {
    t = clamp(t, 0, 1);
    var fn = EASING[name] || EASING.smooth;
    return fn(t);
  }

  function wordWrap(ctx, text, maxPx) {
    var words = text.split(' ');
    var lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxPx && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [text];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2D path differencing for multi-color SVG extrusion
  // ───────────────────────────────────────────────────────────────────────────
  // Multi-color marks (Google G, antigravity, deepmind) layer SVG paths in
  // document order; later paints overwrite prior pixels in 2D. Once extruded
  // to 3D the overlapping volumes collide: bevel chamfers stick out where the
  // top path shrinks inward, side faces poke through silhouettes, and Z-fight
  // streaks the overlap zones — even with renderOrder + polygonOffset, because
  // the geometry is genuinely overlapping in 3-space.
  //
  // First attempt was 3D CSG (three-bvh-csg) on the extruded meshes. That hung
  // the renderer: bevel-tessellated geometry from ExtrudeGeometry has non-
  // manifold edges and thin slivers that send the BVH library into pathological
  // long-running builds. Replaced with 2D polygon clipping BEFORE extrude:
  // operate on flat path vertices (cheap, well-defined, always closed) and let
  // ExtrudeGeometry produce clean meshes from the differenced shapes.
  //
  // Library: polygon-clipping (mfogel, MIT, ~29KB UMD). Loaded as a classic
  // <script> in lib/sceneTemplate.ts so it's available synchronously as
  // window.polygonClipping — no fetch / blob / dynamic-import dance.

  // Lazy-loader for polygon-clipping. Scenes generated BEFORE the scene
  // template added the <script src="/vendor/polygon-clipping.umd.min.js">
  // tag won't have window.polygonClipping at SDK init. Without this, the
  // diff guard silently no-ops and the user sees no change after a fix.
  // Inject the script on demand so the library lazy-loads from any existing
  // scene HTML — no regeneration required.
  var _polyClipPromise = null;
  function _ensurePolygonClipping() {
    if (w.polygonClipping) return Promise.resolve(w.polygonClipping);
    if (_polyClipPromise) return _polyClipPromise;
    _polyClipPromise = new Promise(function (resolve) {
      // If a prior call already injected the tag (or the scene template did
      // and the script is mid-flight), wait on it instead of duplicating.
      var existing = document.querySelector('script[data-dreambyte-polyclip]');
      var s = existing || document.createElement('script');
      var done = function () { resolve(w.polygonClipping || null); };
      var fail = function (err) {
        console.warn('[dreambyte-studio3d] polygon-clipping load failed; 2D path diff disabled', err);
        resolve(null);
      };
      s.addEventListener('load', done);
      s.addEventListener('error', fail);
      if (!existing) {
        s.src = '/vendor/polygon-clipping.umd.min.js';
        s.setAttribute('data-dreambyte-polyclip', '1');
        s.async = true;
        (document.head || document.documentElement).appendChild(s);
      }
    });
    return _polyClipPromise;
  }
  // Kick off the load eagerly at SDK init so the library is usually ready
  // by the time buildExtrudedSVG fires (which itself goes through a fetch +
  // SVGLoader.parse async chain). Fire-and-forget; result reaches subsequent
  // callers via the cached promise.
  if (typeof document !== 'undefined' && !w.polygonClipping) {
    try { _ensurePolygonClipping(); } catch (_) {}
  }

  // Lazy-loader for three-csg-ts (window.__dreambyteThreeCSG). Same rationale as
  // polygon-clipping: scenes generated before the vendor tag was added to the
  // scene template need to lazy-load it. Loaded eagerly at SDK init but
  // ONLY required when opts.csg3d=true; the absence of the library is a
  // silent no-op (3D CSG step skipped, 2D-diff result is rendered instead).
  var _csg3dPromise = null;
  function _ensureCSG3D() {
    if (w.__dreambyteThreeCSG && w.__dreambyteThreeCSG.CSG) return Promise.resolve(w.__dreambyteThreeCSG);
    if (_csg3dPromise) return _csg3dPromise;
    _csg3dPromise = new Promise(function (resolve) {
      var existing = document.querySelector('script[data-dreambyte-csg3d]');
      var s = existing || document.createElement('script');
      var done = function () { resolve(w.__dreambyteThreeCSG || null); };
      var fail = function (err) {
        console.warn('[dreambyte-studio3d] three-csg-ts load failed; 3D CSG disabled', err);
        resolve(null);
      };
      s.addEventListener('load', done);
      s.addEventListener('error', fail);
      if (!existing) {
        s.src = '/vendor/three-csg.iife.js';
        s.setAttribute('data-dreambyte-csg3d', '1');
        s.async = true;
        (document.head || document.documentElement).appendChild(s);
      }
    });
    return _csg3dPromise;
  }
  if (typeof document !== 'undefined' && !(w.__dreambyteThreeCSG && w.__dreambyteThreeCSG.CSG)) {
    try { _ensureCSG3D(); } catch (_) {}
  }

  // Convert a THREE.Shape (outer + holes) into the polygon-clipping format:
  // [outerRing, ...holeRings], each ring an array of [x, y] pairs with the
  // first/last point repeated (closed). Returns null if the shape is degenerate.
  // Vertex quantization grid for polygon-clipping inputs. The Martinez sweep-
  // line algorithm crashes ("Unable to find segment in SweepLine tree") when
  // adjacent samples on tight bezier curves land within float-epsilon of each
  // other — firefox.svg's 12-gradient-paths fall into this trap on 5 of 12
  // paths. Snapping every input vertex to a 1e-3 SVG-unit grid (sub-pixel on
  // typical 0..256 viewBoxes) collapses near-duplicates to exact duplicates,
  // and we drop consecutive duplicates so the library never sees a degenerate
  // edge. Coarser would still be safe; finer reintroduces the crashes.
  var POLYCLIP_QUANTIZE = 1e-3;
  function _quantizeRing(pts) {
    if (!pts || pts.length < 3) return null;
    var Q = POLYCLIP_QUANTIZE;
    var ring = [];
    var prevX = NaN, prevY = NaN;
    for (var i = 0; i < pts.length; i++) {
      var qx = Math.round(pts[i].x / Q) * Q;
      var qy = Math.round(pts[i].y / Q) * Q;
      if (qx === prevX && qy === prevY) continue;
      ring.push([qx, qy]);
      prevX = qx; prevY = qy;
    }
    if (ring.length < 3) return null;
    var first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    } else if (ring.length < 4) {
      return null;
    }
    return ring;
  }

  function _shapeToPolyClip(T, shape, curveSegs) {
    var raw = shape.extractPoints(curveSegs);
    var outer = _quantizeRing(raw.shape);
    if (!outer) return null;
    var poly = [outer];
    if (raw.holes) {
      for (var h = 0; h < raw.holes.length; h++) {
        var hole = _quantizeRing(raw.holes[h]);
        if (hole) poly.push(hole);
      }
    }
    return poly;
  }

  // Inverse: turn a polygon-clipping polygon into a THREE.Shape. The library
  // returns rings with the closing point duplicated; THREE.Shape doesn't want
  // it duplicated (ExtrudeGeometry closes implicitly). Returns null if the
  // polygon is too small to extrude meaningfully.
  function _polyClipToShape(T, poly) {
    if (!poly || !poly.length) return null;
    var outer = poly[0];
    if (!outer || outer.length < 4) return null;
    var pts = [];
    for (var i = 0; i < outer.length - 1; i++) pts.push(new T.Vector2(outer[i][0], outer[i][1]));
    if (pts.length < 3) return null;
    var shape = new T.Shape(pts);
    for (var h = 1; h < poly.length; h++) {
      var hole = poly[h];
      if (!hole || hole.length < 4) continue;
      var hpts = [];
      for (var k = 0; k < hole.length - 1; k++) hpts.push(new T.Vector2(hole[k][0], hole[k][1]));
      if (hpts.length >= 3) shape.holes.push(new T.Path(hpts));
    }
    return shape;
  }

  // Inflate one ring (closed, with first==last duplicate) outward by `eps`.
  // Each vertex shifts along the angle-bisector of its incident edges. CCW
  // rings shift outward; CW rings (holes) shift inward (into the hole) so
  // the polygon's "solid" still grows everywhere. Sharp-corner mitering is
  // approximate (uses the simple bisector, not 1/sin(half-angle)) — an
  // under-shift at very sharp corners. Acceptable for our use case where
  // SVG paths are mostly arcs and curves.
  function _inflatePolyRing(ring, eps, isHole) {
    var n = ring.length - 1; // last point duplicates first
    if (n < 3) return ring;
    var sign = isHole ? -1 : 1;
    var out = [];
    for (var i = 0; i < n; i++) {
      var prev = ring[(i - 1 + n) % n];
      var curr = ring[i];
      var next = ring[(i + 1) % n];
      var v1x = curr[0] - prev[0], v1y = curr[1] - prev[1];
      var v2x = next[0] - curr[0], v2y = next[1] - curr[1];
      var l1 = Math.hypot(v1x, v1y) || 1;
      var l2 = Math.hypot(v2x, v2y) || 1;
      v1x /= l1; v1y /= l1; v2x /= l2; v2y /= l2;
      // Outward normal of an edge in a CCW ring: 90° clockwise rotation of
      // edge direction = (dy, -dx). Flip sign for CW (hole) rings.
      var n1x = sign * v1y, n1y = -sign * v1x;
      var n2x = sign * v2y, n2y = -sign * v2x;
      var bx = n1x + n2x, by = n1y + n2y;
      var bl = Math.hypot(bx, by);
      if (bl < 1e-9) { bx = n1x; by = n1y; }
      else { bx /= bl; by /= bl; }
      out.push([curr[0] + bx * eps, curr[1] + by * eps]);
    }
    out.push([out[0][0], out[0][1]]);
    return out;
  }
  function _inflatePoly(poly, eps) {
    if (!poly || !poly.length || eps <= 0) return poly;
    var rings = [_inflatePolyRing(poly[0], eps, false)];
    for (var i = 1; i < poly.length; i++) rings.push(_inflatePolyRing(poly[i], eps, true));
    return rings;
  }

  // Outer-only inflation: expand the polygon's outer ring outward by `eps`
  // SVG units, but leave any holes untouched. Used post-diff to give every
  // multi-color path a thin overhang ring at its silhouette so its front face
  // hides the abutting lower path's interior-hole side wall at the boundary.
  // Inflating holes here would shrink ORIGINAL SVG holes (e.g. the donut hole
  // in a `github_dark` icon) — those have nothing underneath, so shrinking
  // them adds material that wasn't in the source. Diff-induced holes are
  // exactly the ones we WANT to overhang against, but those are already
  // covered by the OTHER entry's outer-ring growth (the upper path), so
  // inflating only the outer is sufficient and avoids the donut-hole regression.
  function _inflateOuterRing(poly, eps) {
    if (!poly || !poly.length || eps <= 0) return poly;
    var rings = [_inflatePolyRing(poly[0], eps, false)];
    for (var i = 1; i < poly.length; i++) rings.push(poly[i]);
    return rings;
  }
  // Apply outer-only inflation to every entry's shape AFTER the diff. Returns
  // a new entries array; falls back to the original entry if conversion fails.
  function _inflateEntriesPostDiff(T, entries, curveSegs, eps) {
    if (!w.polygonClipping || !entries || entries.length <= 1 || !(eps > 0)) return entries;
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      try {
        var poly = _shapeToPolyClip(T, e.shape, curveSegs);
        if (!poly) { out.push(e); continue; }
        var inflated = _inflateOuterRing(poly, eps);
        var s = _polyClipToShape(T, inflated);
        if (s) out.push({ shape: s, path: e.path });
        else out.push(e);
      } catch (_) {
        out.push(e);
      }
    }
    return out;
  }

  // Differ all entries in document order. Each result entry's visible 2D region
  // = original shape MINUS union of every later entry's shape (where each
  // "later" polygon is INFLATED by `inflateEps` before subtraction). The
  // inflation is the trick that hides cut-edge bevel chamfers: when an upper
  // path's polygon is grown outward by ~bevelSize, the resulting cut on the
  // lower path lands *inside* the upper path's actual footprint. The upper
  // path's flat front face then occludes the lower path's cut chamfer in the
  // overlap zone, so neither the chamfer itself nor the back-to-back V-groove
  // between adjacent paths are visible from the front.
  //
  // Where the diff produces multiple disconnected polygons (rare — e.g., a
  // path carved into two pieces by a later one), each piece becomes its own
  // entry inheriting the original path's style/color. Where the diff produces
  // nothing (path fully covered), the entry is dropped.
  //
  // Failure mode is graceful: on any per-entry exception, that entry is kept
  // unchanged.
  // Shoelace area of a polygon-clipping ring (closed, last == first).
  function _polyClipRingArea(ring) {
    if (!ring || ring.length < 4) return 0;
    var a = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      a += ring[i][0] * ring[i+1][1] - ring[i+1][0] * ring[i][1];
    }
    return Math.abs(a) * 0.5;
  }

  // Pre-diff coalesce: paths painted with identical colors get unioned into
  // one polygon. Cuts down internal seams in multi-color SVGs where the same
  // brand color appears on multiple paths (firefox: 7 distinct colors across
  // 9 paths). Order is preserved by anchoring each color group at its first
  // entry's z-index and discarding later ones in the group. Falls back to
  // the original entries on any polygon-clipping failure.
  function _unionSameColorEntries(T, entries, curveSegs, keyFn) {
    if (!w.polygonClipping || entries.length <= 1) return entries;
    // Group polys by color key, anchoring at first occurrence.
    var firstIdx = {}, groups = {};
    for (var i = 0; i < entries.length; i++) {
      var k = keyFn(entries[i]);
      if (k === null || k === undefined) {
        // Unkeyable entry — keep as singleton (avoid corrupting other groups).
        var soloKey = '__solo_' + i;
        firstIdx[soloKey] = i;
        groups[soloKey] = [entries[i]];
        continue;
      }
      if (firstIdx[k] === undefined) {
        firstIdx[k] = i;
        groups[k] = [entries[i]];
      } else {
        groups[k].push(entries[i]);
      }
    }
    // Build keys sorted by their first-occurrence index so the output retains
    // the original z-order (lower-index entries render below higher).
    var keys = Object.keys(groups).sort(function (a, b) { return firstIdx[a] - firstIdx[b]; });
    var out = [];
    for (var ki = 0; ki < keys.length; ki++) {
      var grp = groups[keys[ki]];
      if (grp.length === 1) { out.push(grp[0]); continue; }
      // Convert all shapes in the group to polygon-clipping format and union.
      var polys = [];
      for (var gi = 0; gi < grp.length; gi++) {
        var p = _shapeToPolyClip(T, grp[gi].shape, curveSegs);
        if (p) polys.push([p]);
      }
      if (polys.length === 0) continue;
      if (polys.length === 1) { out.push(grp[0]); continue; }
      try {
        var u = w.polygonClipping.union.apply(w.polygonClipping, polys);
        if (u && u.length) {
          for (var ui = 0; ui < u.length; ui++) {
            var s = _polyClipToShape(T, u[ui]);
            if (s) out.push({ shape: s, path: grp[0].path });
          }
        } else {
          // Union returned nothing — keep originals.
          for (var gi2 = 0; gi2 < grp.length; gi2++) out.push(grp[gi2]);
        }
      } catch (err) {
        console.warn('[dreambyte-studio3d] same-color union failed; keeping ' + grp.length + ' originals', err);
        for (var gi3 = 0; gi3 < grp.length; gi3++) out.push(grp[gi3]);
      }
    }
    return out;
  }

  function _diffEntriesBeforeExtrude(T, entries, curveSegs, inflateEps) {
    if (!w.polygonClipping || entries.length <= 1) return entries;
    inflateEps = inflateEps || 0;
    var polys = [];
    var inflated = [];
    for (var i = 0; i < entries.length; i++) {
      var p = _shapeToPolyClip(T, entries[i].shape, curveSegs);
      polys.push(p);
      inflated.push(p && inflateEps > 0 ? _inflatePoly(p, inflateEps) : p);
    }
    // Total subject area for sliver-rejection threshold.
    var totalArea = 0;
    for (var ai = 0; ai < polys.length; ai++) {
      if (polys[ai] && polys[ai][0]) totalArea += _polyClipRingArea(polys[ai][0]);
    }
    // 0.05% of total area — anything smaller is almost certainly a polygon-
    // clipping precision artifact (sub-pixel sliver from imprecise edge
    // intersection in complex multi-subpath shapes like notion's book frame).
    // Letting these through extrudes thin tendrils that read as visual glitches.
    var sliverThreshold = totalArea * 0.0005;
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      if (!polys[i]) { out.push(entries[i]); continue; }
      var others = [];
      // Subject is the un-inflated polygon (kept at its real boundary so the
      // outer silhouette is unchanged); clips are the inflated upper polygons
      // (so the diff cuts slightly more than the visible boundary).
      for (var j = i + 1; j < entries.length; j++) {
        if (inflated[j]) others.push(inflated[j]);
      }
      if (!others.length) {
        // Top-most entry: nothing to subtract, but we STILL canonicalize through
        // polygon-clipping so its vertex precision matches the holes that
        // appear in lower entries (which all flow through library output).
        // Without this step, e.g. notion's N letter keeps raw SVGLoader vertices
        // while the white silhouette's N-hole comes from polygon-clipping —
        // their side walls drift sub-pixel, the interior-face cull misses the
        // pairs, and the leftover walls z-fight as the mesh rotates.
        try {
          var normalized = w.polygonClipping.union([polys[i]]);
          if (normalized && normalized.length) {
            for (var nk = 0; nk < normalized.length; nk++) {
              var narea = _polyClipRingArea(normalized[nk][0]);
              if (narea < sliverThreshold) continue;
              var ns = _polyClipToShape(T, normalized[nk]);
              if (ns) out.push({ shape: ns, path: entries[i].path });
            }
            continue;
          }
        } catch (_) { /* fall through to raw entry */ }
        out.push(entries[i]);
        continue;
      }
      try {
        var clipArgs = [];
        for (var c = 0; c < others.length; c++) clipArgs.push([others[c]]);
        var diffed = w.polygonClipping.difference.apply(
          w.polygonClipping,
          [[polys[i]]].concat(clipArgs)
        );
        if (!diffed || !diffed.length) continue;
        for (var k = 0; k < diffed.length; k++) {
          var area = _polyClipRingArea(diffed[k][0]);
          if (area < sliverThreshold) continue;
          var s = _polyClipToShape(T, diffed[k]);
          if (s) out.push({ shape: s, path: entries[i].path });
        }
      } catch (err) {
        console.warn('[dreambyte-studio3d] 2D path diff failed at index ' + i + '; keeping raw shape', err);
        out.push(entries[i]);
      }
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3D CSG path differencing (BSP-tree, opt-in)
  // ───────────────────────────────────────────────────────────────────────────
  // Loads via window.__dreambyteThreeCSG (bundled three-csg-ts; the modern fork of
  // evanw/csg.js + jumpjack's Three.js wrapper). Operates on the actual
  // extruded MESHES — runs `mesh[i] = mesh[i] − union(mesh[i+1..N-1])` so
  // each path occupies a 3D volume disjoint from every other path's volume.
  // Heavier than the 2D path: each subtraction rebuilds a BSP tree on the
  // mesh's triangles, which can be slow on bevel-tessellated geometry. Use
  // when 2D differencing leaves visible artifacts (rare).
  //
  // Failure mode is graceful: per-mesh try/catch, mesh-count cap (≤ 12 by
  // default; CSG cost grows roughly N² in the worst case), and the entire
  // pass is wrapped in a single try/catch so a thrown exception falls back
  // to the existing per-path meshes without dropping the build.
  function _csg3dDiffMeshes(T, meshes, opts) {
    if (!meshes || meshes.length <= 1) return meshes;
    var bvh = w.__dreambyteThreeCSG && w.__dreambyteThreeCSG.CSG;
    if (!bvh) {
      console.warn('[dreambyte-studio3d] window.__dreambyteThreeCSG.CSG missing; 3D CSG disabled');
      return meshes;
    }
    var maxMeshes = (opts && opts.csg3dMaxMeshes) || 12;
    if (meshes.length > maxMeshes) {
      console.warn('[dreambyte-studio3d] 3D CSG skipped: ' + meshes.length + ' meshes > maxMeshes=' + maxMeshes);
      return meshes;
    }
    // Make sure matrices are up-to-date — three-csg-ts uses mesh.matrix
    // when converting to/from CSG and a stale matrix would offset the
    // result mesh by whatever the parent transform was at construction time.
    for (var u = 0; u < meshes.length; u++) {
      meshes[u].updateMatrix();
      meshes[u].updateMatrixWorld(true);
    }
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // Bottom-up: maskCSG accumulates the union of every later-painted mesh,
    // and we subtract it from each lower mesh in turn. Building the mask
    // additively is O(N) CSG ops + O(N) subtractions = O(N) total ops.
    var maskCSG = null;
    var rescued = 0;
    // Opt-IN diagnostic logging (per-mesh poly counts, bbox checks, etc.).
    // Default OFF so production scenes don't flood the console — pass
    // opts.csg3dDebug: true when investigating BSP behavior.
    var debug = !!(opts && opts.csg3dDebug === true);
    // Coplanar-faces workaround: every path mesh extrudes to the same Z
    // range, so all front faces share Z=0 (back faces share Z=-depth).
    // three-csg-ts's splitPolygon classifies coplanar polys by normal
    // direction alone — XY position is ignored — and disjoint XY regions
    // can misclassify as "inside" each other's masks. Shift each mesh's
    // geometry by a tiny per-index Z increment to break coplanarity, then
    // undo at the end. (Tuning constants live in the file-top block.)
    var offsets = new Array(meshes.length);
    for (var oi = 0; oi < meshes.length; oi++) {
      offsets[oi] = oi * CSG3D_Z_EPSILON;
      meshes[oi].geometry.translate(0, 0, offsets[oi]);
    }
    function _hex(mat) {
      try { return '#' + mat.color.getHexString(); } catch (_) { return '?'; }
    }
    function _bbox(geo) {
      try {
        geo.computeBoundingBox();
        var b = geo.boundingBox;
        if (!b) return 'no-bbox';
        return 'bbox(' + b.min.x.toFixed(2) + ',' + b.min.y.toFixed(2) + ',' + b.min.z.toFixed(2) + ')..(' + b.max.x.toFixed(2) + ',' + b.max.y.toFixed(2) + ',' + b.max.z.toFixed(2) + ')';
      } catch (_) { return 'bbox-err'; }
    }
    for (var i = meshes.length - 1; i >= 0; i--) {
      var origGeo = meshes[i].geometry;
      var origPosCount = (origGeo && origGeo.attributes && origGeo.attributes.position && origGeo.attributes.position.count) | 0;
      var origColor = _hex(meshes[i].material);
      try {
        var meshCSG = bvh.fromMesh(meshes[i]);
        if (maskCSG) {
          var diffed = meshCSG.subtract(maskCSG);
          var origPolys = (meshCSG && meshCSG.polygons && meshCSG.polygons.length) | 0;
          var diffedPolys = (diffed && diffed.polygons && diffed.polygons.length) | 0;
          var keepRatio = origPolys > 0 ? (diffedPolys / origPolys) : 0;
          if (debug) console.log('[csg3d-debug] i=' + i + ' color=' + origColor + ' origPosVerts=' + origPosCount + ' origPolys=' + origPolys + ' diffedPolys=' + diffedPolys + ' ratio=' + keepRatio.toFixed(3) + ' ' + _bbox(origGeo));
          if (diffedPolys === 0 || keepRatio < CSG3D_KEEP_RATIO) {
            console.warn('[dreambyte-studio3d] 3D CSG kept too few polys at index ' + i + ' (' + diffedPolys + '/' + origPolys + ' = ' + keepRatio.toFixed(2) + '); reverting to raw mesh ' + origColor);
            rescued++;
            maskCSG = maskCSG.union(meshCSG);
          } else {
            var newMesh = bvh.toMesh(diffed, meshes[i].matrix, meshes[i].material);
            var posAttr = newMesh.geometry && newMesh.geometry.attributes && newMesh.geometry.attributes.position;
            var posCount = (posAttr && posAttr.count) | 0;
            if (posCount === 0) {
              console.warn('[dreambyte-studio3d] 3D CSG produced empty mesh at index ' + i + ' ' + origColor + '; keeping raw mesh');
              rescued++;
              maskCSG = maskCSG.union(meshCSG);
            } else {
              // Spatial sanity check: BSP `subtract` for disjoint inputs in
              // three-csg-ts has been observed (Google G) to return roughly
              // the SUBTRACTOR (mask) instead of the SUBTRACTEE − mask. The
              // result has plenty of polygons but its bbox is in the wrong
              // place. Detect by checking that the result's bbox center is
              // close to the input mesh's bbox center. If the centers diverge
              // by more than half the input's longest side, BSP returned
              // garbage — revert to the raw mesh.
              origGeo.computeBoundingBox();
              newMesh.geometry.computeBoundingBox();
              var ob = origGeo.boundingBox, nb = newMesh.geometry.boundingBox;
              var ocx = (ob.min.x + ob.max.x) / 2, ocy = (ob.min.y + ob.max.y) / 2;
              var ncx = (nb.min.x + nb.max.x) / 2, ncy = (nb.min.y + nb.max.y) / 2;
              var origSize = Math.max(ob.max.x - ob.min.x, ob.max.y - ob.min.y, 1e-6);
              var centerShift = Math.hypot(ncx - ocx, ncy - ocy);
              if (centerShift > origSize * CSG3D_BBOX_SHIFT_LIMIT) {
                console.warn('[dreambyte-studio3d] 3D CSG returned displaced bbox at index ' + i + ' ' + origColor + ' (shift=' + centerShift.toFixed(2) + ' size=' + origSize.toFixed(2) + '); reverting to raw mesh');
                rescued++;
                maskCSG = maskCSG.union(meshCSG);
              } else {
                newMesh.castShadow = meshes[i].castShadow;
                newMesh.receiveShadow = meshes[i].receiveShadow;
                if (debug) console.log('[csg3d-debug] i=' + i + ' newPosVerts=' + posCount + ' centerShift=' + centerShift.toFixed(3) + ' new ' + _bbox(newMesh.geometry));
                meshes[i].geometry.dispose();
                meshes[i].geometry = newMesh.geometry;
                maskCSG = maskCSG.union(bvh.fromMesh(meshes[i]));
              }
            }
          }
        } else {
          if (debug) console.log('[csg3d-debug] i=' + i + ' color=' + origColor + ' SEED (no subtract) origPosVerts=' + origPosCount + ' ' + _bbox(origGeo));
          maskCSG = meshCSG;
        }
      } catch (err) {
        console.warn('[dreambyte-studio3d] 3D CSG op failed at index ' + i + ' ' + origColor + '; keeping raw mesh', err);
      }
    }
    if (rescued > 0) {
      console.warn('[dreambyte-studio3d] 3D CSG rescued ' + rescued + '/' + meshes.length + ' mesh(es) (BSP polygon-loss threshold)');
    }
    // Undo per-mesh Z offset so meshes render back at their original Z.
    // Applies to whatever geometry is on each mesh now — the rescued
    // (original) meshes still have the +offset baked in, and the BSP-
    // produced ones inherited the offset because BSP was fed offset
    // input. Either way, translating back restores the intended Z.
    for (var ri = 0; ri < meshes.length; ri++) {
      if (meshes[ri].geometry && offsets[ri]) {
        meshes[ri].geometry.translate(0, 0, -offsets[ri]);
      }
    }
    var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (t1 - t0 > 250) {
      console.warn('[dreambyte-studio3d] 3D CSG took ' + (t1 - t0).toFixed(0) + 'ms (' + meshes.length + ' meshes)');
    }
    return meshes;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // buildInfiniteStudio
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build a proper infinite white (or dark) studio environment.
   *
   * Returns a Studio object:
   *   studio.floorY            — Y position of the floor plane
   *   studio.lights            — { ambient, key, fill, rim }
   *   studio.grid              — InfiniteGridHelper mesh (can setColor, setSpacing)
   *   studio.setColor(opts)    — change bg/grid at runtime
   *   studio.setLights(opts)   — fine-tune lighting intensity/color
   *
   * @param {object} opts
   *   color        'white' | 'dark' | 'midnight' | hex string  (default 'white')
   *   gridColor    hex string                                   (default matches color)
   *   gridSpacing  [minor, major]                               (default [10, 100])
   *   floorY       number                                       (default -2.5)
   *   fog          boolean                                      (default false)
   *   shadows      boolean                                      (default true)
   *   envIntensity number 0-1                                   (default 1)
   */
  w.buildInfiniteStudio = function (T, scene, camera, renderer, opts) {
    opts = opts || {};

    var PRESETS = {
      white:    { bg: '#ffffff', skyTop: '#e8e8e8', skyBot: '#ffffff', grid: '#c8c4c0', isLight: true },
      dark:     { bg: '#111010', skyTop: '#1a1818', skyBot: '#0e0c0c', grid: '#2a2826', isLight: false },
      midnight: { bg: '#080810', skyTop: '#0e0c18', skyBot: '#06040e', grid: '#1e1c28', isLight: false },
    };

    var preset;
    if (typeof opts.color === 'string' && opts.color.charAt(0) === '#') {
      var lum = parseInt(opts.color.slice(1, 3), 16);
      var light = lum > 128;
      preset = { bg: opts.color, skyTop: opts.color, skyBot: opts.color, grid: light ? '#c0bcb8' : '#282624', isLight: light };
    } else {
      preset = PRESETS[opts.color || 'white'] || PRESETS.white;
    }

    var gridColor   = opts.gridColor   || preset.grid;
    var gridSpacing = opts.gridSpacing || [10, 100];
    var floorY      = opts.floorY !== undefined ? opts.floorY : -2.5;
    var isLight     = preset.isLight;

    // ── Renderer ────────────────────────────────────────────────────────────
    renderer.setClearColor(new T.Color(preset.bg), 1);
    renderer.shadowMap.enabled = opts.shadows !== false;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = isLight ? 1.0 : 0.85;
    renderer.outputColorSpace = T.SRGBColorSpace || 'srgb';

    // ── Sky gradient sphere ──────────────────────────────────────────────────
    var skyGeo = new T.SphereGeometry(5000, 32, 64);
    var skyMat = new T.ShaderMaterial({
      side: T.BackSide,
      depthWrite: false,
      uniforms: {
        topColor:    { value: new T.Color(preset.skyTop) },
        bottomColor: { value: new T.Color(preset.skyBot) },
      },
      vertexShader: [
        'varying vec3 vWP;',
        'void main() {',
        '  vWP = (modelMatrix * vec4(position, 1.0)).xyz;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vWP;',
        'void main() {',
        '  float h = normalize(vWP).y * 0.5 + 0.5;',
        '  gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0);',
        '}',
      ].join('\n'),
    });
    var sky = new T.Mesh(skyGeo, skyMat);
    sky.name = '__studio_sky';
    scene.add(sky);

    // ── InfiniteGrid ─────────────────────────────────────────────────────────
    var grid;
    if (w.InfiniteGridHelper) {
      grid = new w.InfiniteGridHelper(gridSpacing[0], gridSpacing[1], gridColor, 8000);
    } else {
      // Inline fallback if the file wasn't loaded separately
      var gVS = ['varying vec3 worldPosition; uniform float uDistance;',
        'void main() { vec3 pos = position.xzy * uDistance; pos.xz += cameraPosition.xz;',
        'worldPosition = pos; gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0); }'].join('\n');
      var gFS = ['varying vec3 worldPosition; uniform float uSize1; uniform float uSize2;',
        'uniform vec3 uColor; uniform float uDistance;',
        'float getGrid(float s) { vec2 r = worldPosition.xz / s;',
        'vec2 g = abs(fract(r - 0.5) - 0.5) / fwidth(r); float l = min(g.x, g.y); return 1.0 - min(l, 1.0); }',
        'void main() { float d = 1.0 - min(distance(cameraPosition.xz, worldPosition.xz) / uDistance, 1.0);',
        'float g1 = getGrid(uSize1); float g2 = getGrid(uSize2);',
        'gl_FragColor = vec4(uColor.rgb, mix(g2, g1, g1) * pow(d, 3.0));',
        'gl_FragColor.a = mix(0.5 * gl_FragColor.a, gl_FragColor.a, g2);',
        'if (gl_FragColor.a <= 0.0) discard; }'].join('\n');
      var gGeo = new T.PlaneGeometry(2, 2, 1, 1);
      var gMat = new T.ShaderMaterial({
        side: T.DoubleSide, transparent: true, depthWrite: false,
        extensions: { derivatives: true },
        uniforms: {
          uSize1: { value: gridSpacing[0] }, uSize2: { value: gridSpacing[1] },
          uColor: { value: new T.Color(gridColor) }, uDistance: { value: 8000 },
        },
        vertexShader: gVS, fragmentShader: gFS,
      });
      grid = new T.Mesh(gGeo, gMat);
      grid.frustumCulled = false;
      grid.renderOrder = -1;
      grid.setColor = function (c) { gMat.uniforms.uColor.value.set(c); };
      grid.setSpacing = function (s1, s2) {
        gMat.uniforms.uSize1.value = s1;
        if (s2 !== undefined) gMat.uniforms.uSize2.value = s2;
      };
    }
    grid.position.y = floorY;
    grid.name = '__studio_grid';
    scene.add(grid);

    // ── Shadow-catcher floor ─────────────────────────────────────────────────
    var shadowFloor = new T.Mesh(
      new T.PlaneGeometry(600, 600),
      new T.ShadowMaterial({ opacity: isLight ? 0.1 : 0.35 })
    );
    shadowFloor.rotation.x = -Math.PI / 2;
    shadowFloor.position.y = floorY - 0.01;
    shadowFloor.receiveShadow = true;
    shadowFloor.name = '__studio_shadow_floor';
    scene.add(shadowFloor);

    // ── Optional fog ────────────────────────────────────────────────────────
    if (opts.fog) {
      scene.fog = new T.FogExp2(new T.Color(preset.bg), 0.004);
    }

    // ── 3-point studio lighting ──────────────────────────────────────────────
    var ambient = new T.AmbientLight(
      isLight ? 0xffffff : 0x111122,
      isLight ? 0.5 : 0.12
    );
    ambient.name = '__studio_ambient';
    scene.add(ambient);

    // Key — slightly warm, strong, casts shadows
    var key = new T.DirectionalLight(isLight ? 0xfff8f0 : 0xffffff, isLight ? 1.0 : 0.9);
    key.position.set(-5, 12, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left   = -20;
    key.shadow.camera.right  =  20;
    key.shadow.camera.top    =  20;
    key.shadow.camera.bottom = -20;
    key.shadow.bias = -0.001;
    key.name = '__studio_key';
    scene.add(key);

    // Fill — cool, from opposite side, no shadow
    var fill = new T.DirectionalLight(isLight ? 0xd8eeff : 0x3344aa, isLight ? 0.45 : 0.3);
    fill.position.set(7, 4, 5);
    fill.name = '__studio_fill';
    scene.add(fill);

    // Rim — warm backlight, separation from background
    var rim = new T.DirectionalLight(isLight ? 0xffece0 : 0xff6040, isLight ? 0.55 : 0.45);
    rim.position.set(0, 6, -10);
    rim.name = '__studio_rim';
    scene.add(rim);

    // ── IBL environment map (RoomEnvironment-style, no external files) ───────
    try {
      var pmrem = new T.PMREMGenerator(renderer);
      var envScene = new T.Scene();
      // Sky sphere in env scene
      var eSky = new T.Mesh(new T.SphereGeometry(50, 32, 16), new T.ShaderMaterial({
        side: T.BackSide,
        uniforms: {
          topColor:    { value: new T.Color(isLight ? 0xddeeff : 0x112244) },
          bottomColor: { value: new T.Color(isLight ? 0xfff8f0 : 0x0a080e) },
        },
        vertexShader: 'varying vec3 v; void main(){v=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(v,1.);}',
        fragmentShader: 'uniform vec3 topColor,bottomColor;varying vec3 v;void main(){float h=normalize(v).y*.5+.5;gl_FragColor=vec4(mix(bottomColor,topColor,h),1.);}',
      }));
      envScene.add(eSky);
      // Key-light panel for sharp reflections on metallic surfaces
      var panel = new T.Mesh(new T.PlaneGeometry(10, 6), new T.MeshBasicMaterial({
        color: isLight ? 0xffffff : 0x334488, side: T.DoubleSide,
      }));
      panel.position.set(-10, 14, 8);
      panel.lookAt(0, 0, 0);
      envScene.add(panel);
      scene.environment = pmrem.fromScene(envScene, 0.04).texture;
      if (opts.envIntensity !== undefined) scene.environmentIntensity = opts.envIntensity;
      pmrem.dispose();
    } catch (e) { /* env map is optional enhancement */ }

    // ── Studio return object ─────────────────────────────────────────────────
    var studio = {
      floorY: floorY,
      grid:   grid,
      lights: { ambient: ambient, key: key, fill: fill, rim: rim },
      scene:  scene,

      /** Change background / grid color at runtime. opts: { bg, gridColor } */
      setColor: function (colorOpts) {
        colorOpts = colorOpts || {};
        if (colorOpts.bg) {
          renderer.setClearColor(new T.Color(colorOpts.bg), 1);
          skyMat.uniforms.topColor.value.set(colorOpts.bg);
          skyMat.uniforms.bottomColor.value.set(colorOpts.bg);
        }
        if (colorOpts.gridColor) grid.setColor(colorOpts.gridColor);
      },

      /** Fine-tune light intensities. opts: { ambient, key, fill, rim } */
      setLights: function (lightOpts) {
        lightOpts = lightOpts || {};
        if (lightOpts.ambient !== undefined) ambient.intensity = lightOpts.ambient;
        if (lightOpts.key     !== undefined) key.intensity     = lightOpts.key;
        if (lightOpts.fill    !== undefined) fill.intensity    = lightOpts.fill;
        if (lightOpts.rim     !== undefined) rim.intensity     = lightOpts.rim;
        if (lightOpts.keyColor) key.color.set(lightOpts.keyColor);
        if (lightOpts.rimColor) rim.color.set(lightOpts.rimColor);
      },
    };

    return studio;
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildText3D — canvas-texture text plane in 3D space
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Creates a THREE.Mesh with a canvas-rendered text texture.
   * Sync, reliable, uses the scene's FONT global automatically.
   *
   * @param T       window.THREE
   * @param text    String to display
   * @param opts
   *   size         world-unit height of the text block  (default 1)
   *   color        CSS color string                     (default '#1a1917')
   *   font         CSS font-family                      (default FONT global or sans-serif)
   *   weight       400 | 700 | 800                      (default 700)
   *   align        'left' | 'center' | 'right'          (default 'center')
   *   maxWidth     max world-unit width (enables wrapping) (default: no wrap)
   *   lineHeight   multiplier of font size              (default 1.25)
   *   outlineColor CSS color for text outline           (default none)
   *   outlineWidth pixels at canvas resolution          (default 6)
   *   background   CSS color for text bg (null = transparent) (default null)
   *   padding      extra canvas padding fraction [0-0.5] (default 0.04)
   *   resolution   canvas width in px                  (default 2048)
   *   position     [x, y, z]
   *   rotation     [xDeg, yDeg, zDeg]
   *   billboard    true = always faces camera            (default false)
   *   castShadow   boolean                              (default false — text planes rarely cast useful shadows)
   */
  w.buildText3D = function (T, text, opts) {
    opts = opts || {};

    if (!T) { console.warn('buildText3D: window.THREE not loaded'); return new T.Group(); }

    // Try troika first if available
    if (w._troika && w._troika.Text) {
      return _buildTroikaText(T, text, opts);
    }

    var size        = opts.size        !== undefined ? opts.size : 1;
    var color       = opts.color       || '#1a1917';
    var fontFamily  = opts.font        || (w.FONT ? w.FONT + ', sans-serif' : 'system-ui, sans-serif');
    var weight      = opts.weight      || 700;
    var align       = opts.align       || 'center';
    var lineHeightM = opts.lineHeight  !== undefined ? opts.lineHeight : 1.25;
    var padding     = opts.padding     !== undefined ? opts.padding : 0.04;
    var resolution  = opts.resolution  || 2048;

    // ── Canvas text rendering ────────────────────────────────────────────────
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');

    // Choose a large reference font size for good sharpness
    var refSize = 180;
    ctx.font = weight + ' ' + refSize + 'px ' + fontFamily;

    // Word-wrap if maxWidth is set
    var maxPx   = opts.maxWidth ? (resolution * 0.9) : Infinity;
    var rawLines = text.split('\n');
    var lines   = [];
    rawLines.forEach(function (row) {
      if (opts.maxWidth && ctx.measureText(row).width > maxPx) {
        wordWrap(ctx, row, maxPx).forEach(function (l) { lines.push(l); });
      } else {
        lines.push(row);
      }
    });

    var lineH    = refSize * lineHeightM;
    var pad      = refSize * padding;
    var maxW     = 0;
    lines.forEach(function (l) { maxW = Math.max(maxW, ctx.measureText(l).width); });

    canvas.width  = Math.ceil(maxW + pad * 2);
    canvas.height = Math.ceil(lines.length * lineH + pad * 2);

    // Re-set font after resize (resize clears ctx state)
    ctx.font = weight + ' ' + refSize + 'px ' + fontFamily;

    // Background
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Outline pass (before fill so it's behind)
    if (opts.outlineColor) {
      ctx.strokeStyle = opts.outlineColor;
      ctx.lineWidth   = opts.outlineWidth || 6;
      ctx.lineJoin    = 'round';
      ctx.textBaseline = 'top';
      ctx.textAlign   = align;
      var ox = align === 'left' ? pad : (align === 'right' ? canvas.width - pad : canvas.width / 2);
      lines.forEach(function (l, i) { ctx.strokeText(l, ox, pad + i * lineH); });
    }

    // Fill
    ctx.fillStyle   = color;
    ctx.textBaseline = 'top';
    ctx.textAlign   = align;
    var tx = align === 'left' ? pad : (align === 'right' ? canvas.width - pad : canvas.width / 2);
    lines.forEach(function (l, i) { ctx.fillText(l, tx, pad + i * lineH); });

    // ── Three.js mesh ────────────────────────────────────────────────────────
    var tex = new T.CanvasTexture(canvas);
    tex.minFilter = T.LinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.generateMipmaps = false;
    if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;

    var aspect = canvas.width / canvas.height;
    var planeH = size;
    var planeW = size * aspect;

    var mesh;
    if (opts.billboard) {
      // Billboard: always faces camera (use Sprite — no PlaneGeometry needed)
      var spriteMat = new T.SpriteMaterial({ map: tex, transparent: true });
      mesh = new T.Sprite(spriteMat);
      mesh.scale.set(planeW, planeH, 1);
    } else {
      var geo = new T.PlaneGeometry(planeW, planeH);
      var mat = new T.MeshBasicMaterial({
        map:         tex,
        transparent: true,
        depthWrite:  false,
        side:        T.DoubleSide,
      });
      mesh = new T.Mesh(geo, mat);
      if (opts.castShadow) mesh.castShadow = true;
    }

    if (opts.position) mesh.position.set(opts.position[0], opts.position[1], opts.position[2]);
    if (opts.rotation) {
      mesh.rotation.x = (opts.rotation[0] || 0) * Math.PI / 180;
      mesh.rotation.y = (opts.rotation[1] || 0) * Math.PI / 180;
      mesh.rotation.z = (opts.rotation[2] || 0) * Math.PI / 180;
    }

    // Utility: redraw with new text (re-wraps and resizes canvas to fit)
    mesh.setText = function (newText) {
      ctx.font = weight + ' ' + refSize + 'px ' + fontFamily;
      var newRawLines = newText.split('\n');
      var newLines = [];
      newRawLines.forEach(function (row) {
        if (opts.maxWidth && ctx.measureText(row).width > maxPx) {
          wordWrap(ctx, row, maxPx).forEach(function (l) { newLines.push(l); });
        } else { newLines.push(row); }
      });
      var newMaxW = 0;
      newLines.forEach(function (l) { newMaxW = Math.max(newMaxW, ctx.measureText(l).width); });
      canvas.width  = Math.max(1, Math.ceil(newMaxW + pad * 2));
      canvas.height = Math.max(1, Math.ceil(newLines.length * lineH + pad * 2));
      ctx.font = weight + ' ' + refSize + 'px ' + fontFamily;
      if (opts.background) { ctx.fillStyle = opts.background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      if (opts.outlineColor) {
        ctx.strokeStyle = opts.outlineColor; ctx.lineWidth = opts.outlineWidth || 6;
        ctx.lineJoin = 'round'; ctx.textBaseline = 'top'; ctx.textAlign = align;
        var otx2 = align === 'left' ? pad : (align === 'right' ? canvas.width - pad : canvas.width / 2);
        newLines.forEach(function (l, i) { ctx.strokeText(l, otx2, pad + i * lineH); });
      }
      ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.textAlign = align;
      var ntx = align === 'left' ? pad : (align === 'right' ? canvas.width - pad : canvas.width / 2);
      newLines.forEach(function (l, i) { ctx.fillText(l, ntx, pad + i * lineH); });
      tex.needsUpdate = true;
    };

    mesh._canvas = canvas;
    return mesh;
  };

  // Troika path (used when window._troika is available)
  function _buildTroikaText(T, text, opts) {
    var troikaText = new w._troika.Text();
    troikaText.text       = text;
    troikaText.fontSize   = opts.size || 1;
    troikaText.color      = opts.color || '#1a1917';
    if (opts.font)        troikaText.font = opts.font;
    troikaText.fontWeight = opts.weight || 700;
    troikaText.textAlign  = opts.align || 'center';
    troikaText.anchorX    = opts.anchorX || 'center';
    troikaText.anchorY    = opts.anchorY || 'middle';
    if (opts.maxWidth)    troikaText.maxWidth    = opts.maxWidth;
    if (opts.lineHeight)  troikaText.lineHeight  = opts.lineHeight;
    if (opts.outlineColor) {
      troikaText.outlineWidth = opts.outlineWidth || 0.04;
      troikaText.outlineColor = opts.outlineColor;
    }
    if (opts.position) troikaText.position.set(opts.position[0], opts.position[1], opts.position[2]);
    if (opts.rotation) {
      troikaText.rotation.x = (opts.rotation[0] || 0) * Math.PI / 180;
      troikaText.rotation.y = (opts.rotation[1] || 0) * Math.PI / 180;
      troikaText.rotation.z = (opts.rotation[2] || 0) * Math.PI / 180;
    }
    troikaText.sync();
    return troikaText;
  }


  // ─────────────────────────────────────────────────────────────────────────────
  // buildExtrudedText / TEXT_EFFECTS / animateChars — real 3D text geometry
  // ─────────────────────────────────────────────────────────────────────────────

  w.__dreambyteFontCache = w.__dreambyteFontCache || {};

  // Built-in font presets — all shipped at /vendor/fonts/
  var _FONT_URLS = {
    'helvetiker':       '/vendor/fonts/helvetiker_regular.typeface.json',
    'helvetiker_bold':  '/vendor/fonts/helvetiker_bold.typeface.json',
    'optimer':          '/vendor/fonts/optimer_bold.typeface.json',
    'gentilis':         '/vendor/fonts/gentilis_bold.typeface.json',
    'droid_sans':       '/vendor/fonts/droid_sans_regular.typeface.json',
    'droid_serif':      '/vendor/fonts/droid_serif_bold.typeface.json',
    'mplus':            '/vendor/fonts/MPLUSRounded1c-Regular.typeface.json',
  };

  /**
   * TEXT_EFFECTS — material configs for buildExtrudedText / buildExtrudedSVG.
   * Pass one of these keys as opts.effect, or a full material as opts.material.
   *
   *   glass      — clear refractive glass
   *   chrome     — mirror chrome
   *   gold       — warm polished gold
   *   ice        — frosted pale-blue ice
   *   obsidian   — dark volcanic mirror
   *   neon       — emissive glow (pair with bloom)
   *   pearl      — iridescent pearlescent
   *   matte      — flat painted surface
   *
   * All effects use stock MeshPhysicalMaterial — kept simple after vecto3d.
   * Pair with HDRI env (scene.environment) + AgX tone mapping + Bloom postfx.
   */
  w.TEXT_EFFECTS = {
    glass: function(T, color) {
      return new T.MeshPhysicalMaterial({
        color: color ? new T.Color(color) : new T.Color(0xffffff),
        roughness: 0.05,
        metalness: 0.0,
        transmission: 1.0,
        thickness: 0.8,
        ior: 1.5,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        transparent: true,
        opacity: 1.0,
        side: T.FrontSide,
        envMapIntensity: 1.0,
      });
    },
    chrome: function(T, color) {
      return new T.MeshPhysicalMaterial({
        color: color ? new T.Color(color) : new T.Color(0xffffff),
        roughness: 0.25,
        metalness: 1.0,
        clearcoat: 0.5,
        clearcoatRoughness: 0.2,
        envMapIntensity: 0.7,
      });
    },
    gold: function(T, color) {
      return new T.MeshPhysicalMaterial({
        color: color ? new T.Color(color) : new T.Color(0xd4a840),
        roughness: 0.38,
        metalness: 1.0,
        clearcoat: 0.4,
        clearcoatRoughness: 0.22,
        envMapIntensity: 0.7,
      });
    },
    ice: function(T, color) {
      return new T.MeshPhysicalMaterial({
        color: color ? new T.Color(color) : new T.Color(0xc8e8f8),
        roughness: 0.12,
        metalness: 0.0,
        transmission: 0.9,
        thickness: 0.4,
        ior: 1.31,
        clearcoat: 0.8,
        clearcoatRoughness: 0.18,
        transparent: true,
        opacity: 1.0,
        envMapIntensity: 1.0,
      });
    },
    obsidian: function(T, color) {
      return new T.MeshPhysicalMaterial({
        color: color ? new T.Color(color) : new T.Color(0x101018),
        roughness: 0.18,
        metalness: 0.9,
        clearcoat: 0.7,
        clearcoatRoughness: 0.1,
        envMapIntensity: 0.7,
      });
    },
    neon: function(T, color) {
      var c = color || '#00ffcc';
      return new T.MeshStandardMaterial({
        color: new T.Color(c),
        emissive: new T.Color(c),
        emissiveIntensity: 2.5,
        roughness: 0.6,
        metalness: 0.0,
      });
    },
    pearl: function(T, color) {
      return new T.MeshPhysicalMaterial({
        color: color ? new T.Color(color) : new T.Color(0xf5f0ee),
        roughness: 0.20,
        metalness: 0.05,
        clearcoat: 0.6,
        clearcoatRoughness: 0.10,
        iridescence: 0.6,
        iridescenceIOR: 1.4,
        iridescenceThicknessRange: [120, 720],
        sheen: 0.6,
        sheenColor: new T.Color(0xffd0e8),
        sheenRoughness: 0.4,
        envMapIntensity: 0.9,
      });
    },
    matte: function(T, color) {
      return new T.MeshStandardMaterial({
        color: color ? new T.Color(color) : new T.Color(0x1a1a2e),
        roughness: 0.85,
        metalness: 0.0,
      });
    },
    // 3dsvg-inspired additions: rubber (soft, slightly sheen), clay (warm,
    // very rough, no clearcoat), brushed (chrome with anisotropic highlight).
    rubber: function(T, color) {
      return new T.MeshPhysicalMaterial({
        color: color ? new T.Color(color) : new T.Color(0x2a2a32),
        roughness: 0.75,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.6,
        sheen: 0.3,
        sheenColor: new T.Color(0x404048),
        sheenRoughness: 0.5,
        envMapIntensity: 0.4,
      });
    },
    clay: function(T, color) {
      return new T.MeshStandardMaterial({
        color: color ? new T.Color(color) : new T.Color(0xc7967a),
        roughness: 0.95,
        metalness: 0.0,
        envMapIntensity: 0.3,
      });
    },
    brushed: function(T, color) {
      // Anisotropic brushed metal: anisotropy stretches highlights along a
      // direction (vUv.x). Reads as machined steel rather than mirror chrome.
      return new T.MeshPhysicalMaterial({
        color: color ? new T.Color(color) : new T.Color(0xc8c8cc),
        roughness: 0.35,
        metalness: 1.0,
        anisotropy: 1.0,
        anisotropyRotation: 0,
        clearcoat: 0.4,
        clearcoatRoughness: 0.3,
        envMapIntensity: 0.85,
      });
    },
  };

  /**
   * buildExtrudedText — real 3D extruded text with PBR materials.
   * Async (font JSON fetch), returns an empty Group immediately; populates on load.
   *
   * @param T        window.THREE
   * @param text     string to display
   * @param opts
   *   size          font size in world units                (default 1)
   *   depth         extrusion depth                         (default 0.18)
   *   bevel         enable bevel                            (default true)
   *   bevelSize     bevel edge size                         (default 0.025)
   *   bevelThickness bevel depth                            (default 0.04)
   *   bevelSegments  bevel smoothness                       (default 6)
   *   curveSegments  glyph curve smoothness                 (default 14)
   *   effect        TEXT_EFFECTS key: 'glass'|'chrome'|'gold'|'ice'|'obsidian'|'neon'|'pearl'|'matte'  (default 'chrome')
   *   color         override color for the effect            (default: effect default)
   *   material      THREE.Material instance (overrides effect)
   *   font          preset key or URL                        (default 'helvetiker_bold')
   *   align         'left'|'center'|'right'                 (default 'center')
   *   position      [x, y, z]
   *   rotation      [xDeg, yDeg, zDeg]
   *   perChar       split into individual char meshes        (default false)
   *   charSpacing   extra gap between chars (world units)    (default 0)
   *   castShadow    boolean                                  (default true)
   * @param onReady  function(group, chars) — called when geometry is built
   * @returns        THREE.Group (empty until font loads)
   */
  w.buildExtrudedText = function(T, text, opts, onReady) {
    opts = opts || {};
    var group = new T.Group();

    if (opts.position) group.position.set(opts.position[0], opts.position[1], opts.position[2]);
    if (opts.rotation) {
      group.rotation.x = (opts.rotation[0] || 0) * Math.PI / 180;
      group.rotation.y = (opts.rotation[1] || 0) * Math.PI / 180;
      group.rotation.z = (opts.rotation[2] || 0) * Math.PI / 180;
    }

    // Resolve font URL
    var fontKey = opts.font || 'helvetiker_bold';
    var fontUrl = _FONT_URLS[fontKey] || fontKey; // accept raw URL too

    // Build material
    function makeMat() {
      if (opts.material) return opts.material;
      var effectFn = w.TEXT_EFFECTS[opts.effect || 'chrome'];
      if (effectFn) return effectFn(T, opts.color);
      return new T.MeshPhysicalMaterial({ color: new T.Color(opts.color || '#c0c0c0'), roughness: 0.1, metalness: 0.9 });
    }

    function buildGeometry(font) {
      var size           = opts.size           !== undefined ? opts.size           : 1;
      var depth          = opts.depth          !== undefined ? opts.depth          : 0.18;
      var bevel          = opts.bevel          !== undefined ? opts.bevel          : true;
      var bevelSize      = opts.bevelSize      !== undefined ? opts.bevelSize      : 0.025;
      var bevelThickness = opts.bevelThickness !== undefined ? opts.bevelThickness : 0.04;
      var bevelSegments  = opts.bevelSegments  !== undefined ? opts.bevelSegments  : 6;
      var curveSegments  = opts.curveSegments  !== undefined ? opts.curveSegments  : 14;
      var castShadow     = opts.castShadow     !== undefined ? opts.castShadow     : true;
      var align          = opts.align          || 'center';
      var extraGap       = opts.charSpacing    !== undefined ? opts.charSpacing    : 0;
      var TextGeo        = window.TextGeometry || T.TextGeometry;

      if (!TextGeo) {
        console.warn('buildExtrudedText: TextGeometry not available');
        if (onReady) onReady(group, []);
        return;
      }

      var geomOpts = {
        font: font,
        size: size,
        depth: depth,
        bevelEnabled: bevel,
        bevelSize: bevelSize,
        bevelThickness: bevelThickness,
        bevelSegments: bevelSegments,
        curveSegments: curveSegments,
      };

      if (opts.perChar) {
        // Per-character mode — individual meshes for animation
        var chars = [];
        var xCursor = 0;

        for (var i = 0; i < text.length; i++) {
          var ch = text[i];
          if (ch === ' ' || ch === '\t') { xCursor += size * 0.38; continue; }
          if (ch === '\n') { xCursor = 0; continue; }

          var charGeo = new TextGeo(ch, geomOpts);
          charGeo.computeBoundingBox();
          var bb = charGeo.boundingBox;
          var charW = bb.max.x - bb.min.x;

          var mat = makeMat();
          var charMesh = new T.Mesh(charGeo, mat);
          charMesh.position.x = xCursor;
          charMesh.userData.__origX = xCursor;
          charMesh.userData.__origY = 0;
          charMesh.userData.__origZ = 0;
          charMesh.castShadow = castShadow;
          group.add(charMesh);
          chars.push(charMesh);

          xCursor += charW + size * 0.04 + extraGap;
        }

        // Center group on X axis
        var totalWidth = xCursor;
        if (align === 'center') {
          group.children.forEach(function(c) {
            c.position.x -= totalWidth / 2;
            c.userData.__origX -= totalWidth / 2;
          });
        } else if (align === 'right') {
          group.children.forEach(function(c) {
            c.position.x -= totalWidth;
            c.userData.__origX -= totalWidth;
          });
        }

        group.userData.chars = chars;
        if (onReady) onReady(group, chars);

      } else {
        // Single mesh
        var geo = new TextGeo(text, geomOpts);
        geo.computeBoundingBox();

        if (align === 'center' || align === undefined) {
          var center = new T.Vector3();
          geo.boundingBox.getCenter(center);
          geo.translate(-center.x, -center.y, 0);
        } else if (align === 'right') {
          geo.translate(-(geo.boundingBox.max.x - geo.boundingBox.min.x), 0, 0);
        }

        var mesh = new T.Mesh(geo, makeMat());
        mesh.castShadow = castShadow;
        group.add(mesh);
        group.userData.chars = [mesh];
        if (onReady) onReady(group, [mesh]);
      }
    }

    // Load font (cached after first load)
    if (w.__dreambyteFontCache[fontUrl]) {
      buildGeometry(w.__dreambyteFontCache[fontUrl]);
    } else {
      var FL = window.FontLoader || (T && T.FontLoader);
      if (!FL) {
        console.warn('buildExtrudedText: FontLoader not available. Add <script src="/vendor/three-addons-160/FontLoader.js">');
        if (onReady) onReady(group, []);
        return group;
      }
      var loader = new FL();
      loader.load(fontUrl,
        function(font) {
          w.__dreambyteFontCache[fontUrl] = font;
          buildGeometry(font);
        },
        undefined,
        function(err) {
          console.warn('buildExtrudedText: failed to load font', fontUrl, err);
          if (onReady) onReady(group, []);
        }
      );
    }

    return group;
  };

  /**
   * animateChars — drive per-character entrance/exit/idle animations.
   * Call in ThreeJSLayer update() each frame after using perChar:true in buildExtrudedText.
   *
   * @param group    THREE.Group returned by buildExtrudedText
   * @param t        current time in seconds
   * @param opts
   *   entrance      'rise'|'drop'|'pop'|'wave'|'fade'|'flip'|'scatter'  (default 'rise')
   *   delay         per-character stagger in seconds                      (default 0.06)
   *   duration      entrance duration per character                       (default 0.5)
   *   distance      travel distance for rise/drop/scatter                 (default 2)
   *   amplitude     wave amplitude in world units                         (default 0.3)
   *   waveSpeed     wave frequency multiplier                             (default 3)
   *   reverse       animate from last to first character                  (default false)
   */
  w.animateChars = function(group, t, opts) {
    opts = opts || {};
    var chars = group.userData.chars;
    if (!chars || !chars.length) return;

    var delay     = opts.delay     !== undefined ? opts.delay     : 0.06;
    var duration  = opts.duration  !== undefined ? opts.duration  : 0.5;
    var distance  = opts.distance  !== undefined ? opts.distance  : 2;
    var amplitude = opts.amplitude !== undefined ? opts.amplitude : 0.3;
    var waveSpeed = opts.waveSpeed !== undefined ? opts.waveSpeed : 3;
    var entrance  = opts.entrance  || 'rise';
    var reverse   = opts.reverse   || false;
    var n         = chars.length;

    chars.forEach(function(char, rawI) {
      var i = reverse ? (n - 1 - rawI) : rawI;
      var charT    = t - i * delay;
      var p        = Math.max(0, Math.min(1, charT / duration));
      var eased    = 1 - Math.pow(1 - p, 3); // ease-out cubic
      var origX    = char.userData.__origX !== undefined ? char.userData.__origX : char.position.x;
      var origY    = char.userData.__origY !== undefined ? char.userData.__origY : 0;
      var origZ    = char.userData.__origZ !== undefined ? char.userData.__origZ : 0;

      switch (entrance) {
        case 'rise':
          char.position.x = origX;
          char.position.y = origY + (1 - eased) * (-distance);
          char.position.z = origZ;
          if (char.material) { char.material.transparent = true; char.material.opacity = p; }
          break;
        case 'drop':
          char.position.x = origX;
          char.position.y = origY + (1 - eased) * distance;
          char.position.z = origZ;
          if (char.material) { char.material.transparent = true; char.material.opacity = p; }
          break;
        case 'pop':
          var sc = Math.max(0.001, eased);
          char.scale.set(sc, sc, sc);
          char.position.x = origX;
          char.position.y = origY;
          char.position.z = origZ;
          break;
        case 'wave':
          char.position.x = origX;
          char.position.y = origY + Math.sin(t * waveSpeed + rawI * 0.6) * amplitude * eased;
          char.position.z = origZ;
          break;
        case 'flip':
          char.position.x = origX;
          char.position.y = origY;
          char.position.z = origZ;
          char.rotation.x = (1 - eased) * Math.PI;
          if (char.material) { char.material.transparent = true; char.material.opacity = p; }
          break;
        case 'scatter':
          var seed = rawI * 73.1;
          var scatterX = (((seed * 1.3) % 5) - 2.5) * distance * 0.6;
          var scatterY = (((seed * 2.7) % 5) - 2.5) * distance * 0.4;
          var scatterZ = (((seed * 0.9) % 3) - 1.5) * distance * 0.3;
          char.position.x = origX + scatterX * (1 - eased);
          char.position.y = origY + scatterY * (1 - eased);
          char.position.z = origZ + scatterZ * (1 - eased);
          if (char.material) { char.material.transparent = true; char.material.opacity = p; }
          break;
        case 'fade':
        default:
          char.position.x = origX;
          char.position.y = origY;
          char.position.z = origZ;
          if (char.material) { char.material.transparent = true; char.material.opacity = p; }
          break;
      }
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildTextParticles — text → GPU particle cloud (converge / disperse / shimmer)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildTextParticles — sample text pixels into an InstancedMesh particle cloud.
   * Inspired by cabbibo/Text. Each sampled pixel becomes a tiny cube particle.
   * Call .update(t, opts) in ThreeJSLayer update() each frame.
   *
   * @param T       window.THREE
   * @param scene   Three.js scene
   * @param text    string to rasterize
   * @param opts
   *   size          particle world width (default 10)
   *   color         particle color (default PALETTE[0])
   *   step          pixel sampling stride (lower = more particles, default 4)
   *   particleSize  individual cube size in world units (default 0.07)
   *   disperseRange max disperse distance in world units (default 8)
   *   font          CSS font-family (default FONT global or sans-serif)
   *   position      [x, y, z]
   * @param onReady  function(api) — api.update(t, opts) drives the animation
   * @returns        particle api { group, update, setColor, count } immediately
   */
  w.buildTextParticles = function(T, scene, text, opts, onReady) {
    opts = opts || {};

    var worldW        = opts.size          !== undefined ? opts.size          : 10;
    var particleSize  = opts.particleSize  !== undefined ? opts.particleSize  : 0.07;
    var step          = opts.step          !== undefined ? opts.step          : 4;
    var disperseRange = opts.disperseRange !== undefined ? opts.disperseRange : 8;
    var baseColor     = opts.color || (w.PALETTE && w.PALETTE[0]) || '#2563eb';
    var fontFamily    = opts.font || (w.FONT ? w.FONT + ', sans-serif' : 'system-ui, sans-serif');

    // ── Rasterize text to canvas ────────────────────────────────────────────
    var canvas = document.createElement('canvas');
    var canvasH = Math.round(worldW * 30); // proportional height
    var canvasW = Math.round(worldW * 100);
    canvas.width  = canvasW;
    canvas.height = canvasH;
    var ctx = canvas.getContext('2d');
    var fontSize = Math.round(canvasH * 0.75);
    ctx.font = '700 ' + fontSize + 'px ' + fontFamily;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvasW / 2, canvasH / 2);

    // ── Sample pixels ───────────────────────────────────────────────────────
    var imageData = ctx.getImageData(0, 0, canvasW, canvasH).data;
    var textPositions = [];

    for (var py = 0; py < canvasH; py += step) {
      for (var px = 0; px < canvasW; px += step) {
        var idx = (py * canvasW + px) * 4;
        if (imageData[idx + 3] > 100) {
          var wx = (px / canvasW - 0.5) * worldW;
          var wy = -(py / canvasH - 0.5) * (worldW * canvasH / canvasW);
          textPositions.push(wx, wy, 0);
        }
      }
    }

    var count = textPositions.length / 3;
    if (count === 0) {
      var emptyApi = { group: new T.Group(), update: function() {}, setColor: function() {}, count: 0 };
      if (onReady) onReady(emptyApi);
      return emptyApi;
    }

    var texPosArr = new Float32Array(textPositions);

    // ── Pre-compute random dispersed positions (seeded, deterministic) ──────
    var dispPosArr = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var s1 = Math.abs(Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
      var s2 = Math.abs(Math.sin(i * 269.5 + 183.3) * 43758.5453) % 1;
      var s3 = Math.abs(Math.sin(i * 419.2 + 77.1)  * 43758.5453) % 1;
      dispPosArr[i * 3]     = (s1 - 0.5) * disperseRange * 2;
      dispPosArr[i * 3 + 1] = (s2 - 0.5) * disperseRange;
      dispPosArr[i * 3 + 2] = (s3 - 0.5) * disperseRange * 0.6;
    }

    // ── Build InstancedMesh ─────────────────────────────────────────────────
    var geo = new T.BoxGeometry(particleSize, particleSize, particleSize * 0.55);
    var mat = new T.MeshStandardMaterial({
      color:             new T.Color(baseColor),
      emissive:          new T.Color(baseColor),
      emissiveIntensity: 0.35,
      roughness:         0.38,
      metalness:         0.65,
    });
    var mesh = new T.InstancedMesh(geo, mat, count);
    mesh.castShadow = true;

    var group = new T.Group();
    if (opts.position) group.position.set(opts.position[0], opts.position[1], opts.position[2]);
    group.add(mesh);
    scene.add(group);

    var dummy = new T.Object3D();

    var api = {
      group:  group,
      mesh:   mesh,
      count:  count,

      /**
       * update(t, opts2) — call every frame in ThreeJSLayer update().
       * opts2.mode: 'converge' | 'disperse' | 'shimmer' | 'chaos' | 'text'
       * opts2.startT: time in seconds when animation begins (default 0)
       * opts2.duration: transition duration in seconds (default 2)
       * opts2.amplitude: shimmer amplitude in world units (default 0.06)
       * opts2.frequency: shimmer/chaos frequency (default 3)
       */
      update: function(t, opts2) {
        opts2   = opts2 || {};
        var mode     = opts2.mode      || 'converge';
        var dur      = opts2.duration  !== undefined ? opts2.duration  : 2;
        var startT   = opts2.startT    !== undefined ? opts2.startT    : 0;
        var amp      = opts2.amplitude !== undefined ? opts2.amplitude : 0.06;
        var freq     = opts2.frequency !== undefined ? opts2.frequency : 3;
        var elapsed  = Math.max(0, t - startT);
        var rawP     = dur > 0 ? Math.min(elapsed / dur, 1) : 1;
        var p        = 1 - Math.pow(1 - rawP, 3); // ease-out cubic

        for (var ii = 0; ii < count; ii++) {
          var tx = texPosArr[ii * 3],     ty = texPosArr[ii * 3 + 1], tz = texPosArr[ii * 3 + 2];
          var dx = dispPosArr[ii * 3],    dy = dispPosArr[ii * 3 + 1], dz = dispPosArr[ii * 3 + 2];
          var ph = (Math.abs(Math.sin(ii * 13.7)) % 1) * Math.PI * 2;
          var wx, wy, wz, rx, ry, rz;

          if (mode === 'converge') {
            wx = dx + (tx - dx) * p;
            wy = dy + (ty - dy) * p;
            wz = dz + (tz - dz) * p;
            rx = ph * (1 - p); ry = ph * 0.5 * (1 - p); rz = ph * 0.3 * (1 - p);
          } else if (mode === 'disperse') {
            wx = tx + (dx - tx) * p;
            wy = ty + (dy - ty) * p;
            wz = tz + (dz - tz) * p;
            rx = ph * p; ry = ph * 0.5 * p; rz = ph * 0.3 * p;
          } else if (mode === 'shimmer') {
            wx = tx + Math.sin(t * freq + ph)       * amp;
            wy = ty + Math.cos(t * freq + ph * 1.3) * amp;
            wz = tz + Math.sin(t * freq * 0.7 + ph) * amp * 0.5;
            rx = 0; ry = 0; rz = 0;
          } else if (mode === 'chaos') {
            var chaos = Math.max(0, 1 - p);
            wx = tx + Math.sin(t * freq * 2 + ph) * amp * 3 * chaos;
            wy = ty + Math.cos(t * freq * 2 + ph) * amp * 3 * chaos;
            wz = tz + Math.sin(t * freq + ph * 2)  * amp * 2 * chaos;
            rx = ph * chaos; ry = ph * chaos; rz = 0;
          } else {
            wx = tx; wy = ty; wz = tz;
            rx = 0; ry = 0; rz = 0;
          }

          dummy.position.set(wx, wy, wz);
          dummy.rotation.set(rx, ry, rz);
          dummy.updateMatrix();
          mesh.setMatrixAt(ii, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      },

      setColor: function(color) {
        mat.color.set(color);
        mat.emissive.set(color);
      },

      dispose: function() {
        geo.dispose();
        mat.dispose();
        scene.remove(group);
      },
    };

    if (onReady) onReady(api);
    return api;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildTextPath — extruded text distributed along a CatmullRom curve
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildTextPath — place extruded characters along a 3D curve.
   * Each character is positioned and oriented to follow the curve's tangent.
   * Async (waits for font load), returns empty Group immediately.
   *
   * @param T         window.THREE
   * @param text      string to render
   * @param pathPoints array of [x,y,z] control points for CatmullRomCurve3
   * @param opts      inherits all buildExtrudedText opts, plus:
   *   tension       CatmullRom tension (default 0.5)
   *   closed        closed loop curve (default false)
   *   startU        arc-length offset to start text (0–1, default 0.05)
   *   spanU         fraction of curve to span (0–1, default 0.9)
   *   tiltToTangent tilt chars along curve slope (default true)
   * @param onReady   function(group, chars) when geometry is placed
   * @returns         THREE.Group (empty until font loads)
   */
  w.buildTextPath = function(T, text, pathPoints, opts, onReady) {
    opts = opts || {};

    var curve = new T.CatmullRomCurve3(
      pathPoints.map(function(p) { return new T.Vector3(p[0], p[1], p[2]); }),
      opts.closed  !== undefined ? opts.closed  : false,
      'catmullrom',
      opts.tension !== undefined ? opts.tension : 0.5
    );

    var group = new T.Group();
    if (opts.position) group.position.set(opts.position[0], opts.position[1], opts.position[2]);
    if (opts.rotation) {
      group.rotation.x = (opts.rotation[0] || 0) * Math.PI / 180;
      group.rotation.y = (opts.rotation[1] || 0) * Math.PI / 180;
      group.rotation.z = (opts.rotation[2] || 0) * Math.PI / 180;
    }

    var startU = opts.startU !== undefined ? opts.startU : 0.05;
    var spanU  = opts.spanU  !== undefined ? opts.spanU  : 0.9;
    var tilt   = opts.tiltToTangent !== undefined ? opts.tiltToTangent : true;
    var up     = new T.Vector3(0, 1, 0);

    // Build extruded chars left-aligned; reparent and curve-distribute on load
    var tempGroup = w.buildExtrudedText(T, text, {
      size:           opts.size           !== undefined ? opts.size           : 1,
      depth:          opts.depth          !== undefined ? opts.depth          : 0.15,
      bevel:          opts.bevel          !== undefined ? opts.bevel          : true,
      bevelSize:      opts.bevelSize      !== undefined ? opts.bevelSize      : 0.02,
      bevelThickness: opts.bevelThickness !== undefined ? opts.bevelThickness : 0.03,
      bevelSegments:  opts.bevelSegments  !== undefined ? opts.bevelSegments  : 5,
      curveSegments:  opts.curveSegments  !== undefined ? opts.curveSegments  : 12,
      effect:         opts.effect || 'chrome',
      color:          opts.color,
      material:       opts.material,
      font:           opts.font || 'helvetiker_bold',
      align:          'left',
      perChar:        true,
      charSpacing:    opts.charSpacing || 0,
    }, function(extGroup, chars) {
      if (!chars || !chars.length) {
        if (onReady) onReady(group, []);
        return;
      }

      // Measure total text width from char __origX positions
      var totalWidth = 0;
      chars.forEach(function(c) {
        var charX = c.userData.__origX !== undefined ? c.userData.__origX : c.position.x;
        if (c.geometry && !c.geometry.boundingBox) c.geometry.computeBoundingBox();
        var charW = c.geometry && c.geometry.boundingBox
          ? c.geometry.boundingBox.max.x - c.geometry.boundingBox.min.x
          : (opts.size || 1) * 0.55;
        totalWidth = Math.max(totalWidth, charX + charW);
      });

      // Distribute each char along the curve proportionally
      chars.forEach(function(char) {
        var charX = char.userData.__origX !== undefined ? char.userData.__origX : char.position.x;
        var u = startU + (totalWidth > 0 ? (charX / totalWidth) * spanU : 0);
        u = Math.min(Math.max(u, 0), 0.9999);

        var pos     = curve.getPointAt(u);
        var tangent = curve.getTangentAt(u);

        char.position.copy(pos);

        // Yaw: align with tangent's XZ direction
        char.rotation.y = Math.atan2(tangent.x, tangent.z);

        // Pitch: tilt along curve slope if tiltToTangent
        if (tilt && Math.abs(tangent.y) > 0.005) {
          char.rotation.x = -Math.atan2(tangent.y,
            Math.sqrt(tangent.x * tangent.x + tangent.z * tangent.z));
        }

        char.castShadow = true;
        group.add(char);
      });

      group.userData.chars = chars;
      group.userData.curve = curve;
      if (onReady) onReady(group, chars);
    });

    // tempGroup is discarded — chars get reparented to group above
    return group;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // applyTextGradient / animateTextSweep — per-char color + animated effects
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * applyTextGradient — apply a static left-to-right color gradient across chars.
   * Clones each char's material before modifying (non-destructive).
   * Call once (in setup or in the font onReady callback).
   *
   * @param group   THREE.Group from buildExtrudedText (perChar:true)
   * @param from    start CSS color (default PALETTE[0])
   * @param to      end CSS color (default PALETTE[1])
   * @param opts
   *   axis         'x' | 'y' | 'reverse' — gradient direction (default 'x')
   *   emissive     true = also set emissive (good for dark scenes, default false)
   */
  w.applyTextGradient = function(T, group, from, to, opts) {
    opts = opts || {};
    var chars = group.userData.chars;
    if (!chars || !chars.length) return;

    var fromColor = new T.Color(from || (w.PALETTE && w.PALETTE[0]) || '#2563eb');
    var toColor   = new T.Color(to   || (w.PALETTE && w.PALETTE[1]) || '#e84545');
    var n         = chars.length;
    var reverse   = opts.axis === 'reverse';

    chars.forEach(function(char, i) {
      var t = n > 1 ? i / (n - 1) : 0;
      if (reverse) t = 1 - t;
      var c = new T.Color().lerpColors(fromColor, toColor, t);
      if (char.material) {
        char.material = char.material.clone();
        char.material.color.copy(c);
        if (opts.emissive) {
          char.material.emissive = c.clone().multiplyScalar(0.4);
          char.material.emissiveIntensity = 1.0;
        }
        if (char.material.metalness !== undefined && char.material.roughness !== undefined) {
          // preserve PBR settings, just change color
        }
      }
    });
  };

  /**
   * animateTextSweep — animate a color/glow wave sweeping across characters.
   * Call in ThreeJSLayer update() each frame. Modifies material color + emissive.
   *
   * @param group    THREE.Group from buildExtrudedText (perChar:true)
   * @param t        current time in seconds
   * @param opts
   *   from          base color (default char's current color)
   *   to            peak sweep color (default PALETTE[0])
   *   speed         sweep cycles per second (default 0.6)
   *   width         sweep band width 0–1 (default 0.4)
   *   emissive      peak emissive intensity (default 0.9)
   *   direction     'forward' | 'reverse' | 'ping-pong' (default 'forward')
   *   mode          'color' | 'glow' | 'both' (default 'both')
   */
  w.animateTextSweep = function(T, group, t, opts) {
    opts = opts || {};
    var chars = group.userData.chars;
    if (!chars || !chars.length) return;
    if (!group.userData.__sweepMats) {
      // Clone materials once on first call
      group.userData.__sweepMats = chars.map(function(char) {
        if (char.material) {
          char.material = char.material.clone();
          return char.material;
        }
        return null;
      });
    }

    var mats      = group.userData.__sweepMats;
    var n         = chars.length;
    var speed     = opts.speed     !== undefined ? opts.speed     : 0.6;
    var bandWidth = opts.width     !== undefined ? opts.width     : 0.4;
    var maxEmiss  = opts.emissive  !== undefined ? opts.emissive  : 0.9;
    var dir       = opts.direction || 'forward';
    var mode      = opts.mode      || 'both';
    var toColor   = new T.Color(opts.to || (w.PALETTE && w.PALETTE[0]) || '#2563eb');

    var cycle = (t * speed) % 1;
    if (dir === 'reverse') cycle = 1 - cycle;
    else if (dir === 'ping-pong') cycle = Math.abs(((t * speed * 0.5) % 2) - 1);

    chars.forEach(function(char, i) {
      var mat = mats[i];
      if (!mat) return;

      var pos   = n > 1 ? i / (n - 1) : 0;
      var dist  = Math.abs(pos - cycle);
      // Wrap-around distance
      dist = Math.min(dist, 1 - dist);
      var inBand = Math.max(0, 1 - dist / (bandWidth * 0.5));
      // Smooth the band edge
      var strength = inBand * inBand * (3 - 2 * inBand);

      if (mode === 'color' || mode === 'both') {
        var baseCol = group.userData.__baseColors
          ? group.userData.__baseColors[i]
          : mat.color.clone();
        if (!group.userData.__baseColors) {
          if (!group.userData.__baseColors) group.userData.__baseColors = [];
          group.userData.__baseColors[i] = mat.color.clone();
        }
        mat.color.lerpColors(
          group.userData.__baseColors[i] || mat.color,
          toColor,
          strength
        );
      }
      if (mode === 'glow' || mode === 'both') {
        mat.emissive = mat.emissive || new T.Color(0, 0, 0);
        mat.emissive.copy(toColor).multiplyScalar(strength);
        mat.emissiveIntensity = strength * maxEmiss;
        mat.transparent = mat.transparent || false;
      }
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // extrudeSVGFile / extrudeSVGPaths — SVG → 3D ExtrudeGeometry
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Load an SVG file URL and extrude all paths to 3D geometry.
   * Async — calls onReady(group) when done.
   *
   * opts: { depth, bevel, bevelSize, bevelSegments, color, metalness,
   *         roughness, clearcoat, scale, position, rotation, material }
   */
  w.extrudeSVGFile = function (T, url, opts, onReady) {
    var loader = w.SVGLoader ? new w.SVGLoader() : null;
    if (!loader) {
      console.warn('extrudeSVGFile: window.SVGLoader not available. Add <script src="/vendor/three-addons-160/SVGLoader.js">');
      if (onReady) onReady(new T.Group());
      return;
    }
    loader.load(url, function (data) {
      var group = extrudePathsToGroup(T, data.paths, opts);
      if (onReady) onReady(group);
    }, undefined, function (err) {
      console.warn('extrudeSVGFile: failed to load ' + url, err);
      if (onReady) onReady(new T.Group());
    });
  };

  /**
   * Extrude an array of SVGLoader path objects to a THREE.Group. Sync.
   * Useful when you already have data.paths from a loaded SVG.
   */
  w.extrudeSVGPaths = function (T, paths, opts) {
    return extrudePathsToGroup(T, paths, opts);
  };

  function extrudePathsToGroup(T, paths, opts) {
    opts = opts || {};
    var group = new T.Group();

    var depth    = opts.depth    !== undefined ? opts.depth    : 0.15;
    var bevel    = opts.bevel    !== false;
    var bvThick  = opts.bevelThickness || depth * 0.15;
    var bvSize   = opts.bevelSize      || depth * 0.08;
    var bvSegs   = opts.bevelSegments  || 4;
    var scale    = opts.scale    !== undefined ? opts.scale    : 1;

    // Default PBR material — works well in studio lighting
    var defaultMat = opts.material || new T.MeshPhysicalMaterial({
      color:              new T.Color(opts.color || '#1a1917'),
      metalness:          opts.metalness  !== undefined ? opts.metalness  : 0.4,
      roughness:          opts.roughness  !== undefined ? opts.roughness  : 0.3,
      clearcoat:          opts.clearcoat  !== undefined ? opts.clearcoat  : 0.6,
      clearcoatRoughness: 0.1,
    });

    paths.forEach(function (path) {
      // Use SVGLoader.createShapes() per three.js research — handles holes
      var shapes = (w.SVGLoader && w.SVGLoader.createShapes)
        ? w.SVGLoader.createShapes(path)
        : path.toShapes(true);

      shapes.forEach(function (shape) {
        var geo = new T.ExtrudeGeometry(shape, {
          depth:          depth,
          bevelEnabled:   bevel,
          bevelThickness: bvThick,
          bevelSize:      bvSize,
          bevelSegments:  bvSegs,
          curveSegments:  12,
        });
        geo.center();

        var mat = defaultMat;
        // Preserve SVG fill colors when no color override is given
        if (!opts.color && path.color && path.color.isColor) {
          mat = defaultMat.clone();
          mat.color.copy(path.color);
        }

        var mesh = new T.Mesh(geo, mat);
        mesh.castShadow    = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      });
    });

    // SVG Y is flipped relative to Three.js — scale.y = -scale normalizes this.
    group.scale.set(scale, -scale, scale);

    if (opts.position) group.position.set(opts.position[0], opts.position[1], opts.position[2]);
    if (opts.rotation) {
      group.rotation.x = (opts.rotation[0] || 0) * Math.PI / 180;
      group.rotation.y = (opts.rotation[1] || 0) * Math.PI / 180;
      group.rotation.z = (opts.rotation[2] || 0) * Math.PI / 180;
    }

    return group;
  }

  // Y-flip helper used by buildExtrudedSVG. SVG y-axis is inverted vs Three.js.
  // Scaling y by -1 reverses triangle winding so backface culling shows the
  // inside; we reverse the index buffer to fix winding, then recompute normals.
  // Merge a parent group's child meshes into ONE Mesh+BufferGeometry with
  // vertex colors so the multi-color SVG renders as a single continuous
  // solid. Eliminates internal seam artifacts that haunt the per-path
  // approach: back-to-back side walls between adjacent paths (Z-fighting
  // sliver), bevel chamfer V-grooves (dark line at every color seam),
  // polygon-offset depth bias overhead. Reads each child's material.color
  // for vertex coloring, clones the first child's material as the merged
  // mesh's material with vertexColors:true. Children are removed from the
  // parent and replaced by the merged mesh.
  function _mergeMultiColorMeshes(T, parent) {
    if (!T) return;
    var children = parent.children.slice();
    if (children.length <= 1) return;
    var totalVerts = 0;
    var perChild = [];
    for (var i = 0; i < children.length; i++) {
      var m = children[i];
      if (!m.geometry || !m.material) continue;
      var g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      if (!g.attributes.position) continue;
      var n = g.attributes.position.count;
      perChild.push({
        geom: g,
        count: n,
        color: (m.material.color && m.material.color.r !== undefined) ? { r: m.material.color.r, g: m.material.color.g, b: m.material.color.b } : { r: 1, g: 1, b: 1 },
      });
      totalVerts += n;
    }
    if (perChild.length === 0 || totalVerts === 0) return;
    var positions = new Float32Array(totalVerts * 3);
    var normals   = new Float32Array(totalVerts * 3);
    var colors    = new Float32Array(totalVerts * 3);
    var off = 0;
    for (var k = 0; k < perChild.length; k++) {
      var pc = perChild[k];
      var posArr = pc.geom.attributes.position.array;
      var norArr = pc.geom.attributes.normal ? pc.geom.attributes.normal.array : null;
      positions.set(posArr, off * 3);
      if (norArr) normals.set(norArr, off * 3);
      var cr = pc.color.r, cg = pc.color.g, cb = pc.color.b;
      for (var v = 0; v < pc.count; v++) {
        var ci = (off + v) * 3;
        colors[ci] = cr; colors[ci + 1] = cg; colors[ci + 2] = cb;
      }
      off += pc.count;
      pc.geom.dispose();
    }
    // Vertex-weld: snap each (x, y, z) to a 0.05-SVG-unit grid (sub-pixel
    // on a 256-unit viewBox). Different paths' shared boundary vertices
    // come from different sources (raw SVGLoader vs polygon-clipping diff
    // output) and drift by 1e-3..1e-2 units. Without welding, adjacent
    // paths' side walls land on slightly different planes, the cull's
    // plane-bucket key misses the pair, and front faces overlap in
    // sub-pixel strips → visible z-fighting (firefox's flame edges).
    // After welding, vertices within Q of each other share IDENTICAL
    // coords, so coplanar walls bucket together and adjacent front faces
    // touch along bit-exact seams.
    // Snap every vertex to a 0.05-SVG-unit grid by direct rounding (NOT
    // canonical-first-mapping, which leaves the first-seen vertex at its
    // unrounded position and only rounds duplicates — and worse, two near-
    // by vertices straddling a grid line still land in different buckets).
    // Direct rounding puts every coord on an exact 0.05 multiple. Two
    // adjacent paths' shared boundary vertices, even with sub-pixel drift
    // from polygon-clipping precision vs raw SVGLoader output, all snap
    // to the same grid points → side walls become exactly coplanar →
    // interior-face cull pairs them up → no z-fighting at color seams.
    // 0.05 SVG-unit on a typical 256-unit viewBox is ~0.02% — well below
    // any visible threshold.
    var WELD_Q = 1 / 0.05;
    for (var wv = 0; wv < totalVerts * 3; wv++) {
      positions[wv] = Math.round(positions[wv] * WELD_Q) / WELD_Q;
    }
    // Interior-face removal: when two paths share a 2D boundary edge,
    // each extrudes a vertical side wall at that edge. The two walls
    // are COPLANAR with OPPOSITE normals — interior faces inside the
    // merged solid that should not render. Three.js has no hidden-
    // surface removal, so both render and create visible "stripes" at
    // every color seam.
    //
    // Centroid-based matching fails because the two paths' side walls
    // are triangulated DIFFERENTLY (path A walks the seam edge p1→p2,
    // path B walks p2→p1 reversed; the quad split lands differently
    // so centroids don't coincide). Instead, hash each triangle by
    // its PLANE alone (canonical direction-agnostic normal + offset).
    // Pair-up in pass 2 by min(pos.length, neg.length) per bucket so
    // ALL four triangles per shared edge get dropped — earlier
    // versions paired only the first two and left the rest visible.
    var triCount = (totalVerts / 3) | 0;
    var keep = new Uint8Array(triCount);
    for (var ki = 0; ki < triCount; ki++) keep[ki] = 1;
    // Plane-bucket quantization (constants live in file-top tuning block):
    //   INTERIOR_CULL_QN — normal precision (unit vectors, ~0.01)
    //   INTERIOR_CULL_QD — offset precision (mesh-local SVG units, ~0.01)
    // Pass 1: bucket every triangle by its CANONICAL plane (direction-
    // agnostic normal + offset). Each shared seam edge between two
    // paths produces FOUR triangles in the same bucket: 2 from path A
    // (positive sign) + 2 from path B (negative sign). Triangulation
    // differs between A and B (their quads split differently), so
    // bbox-based matching fails — we use plane-only here.
    var buckets = Object.create(null);
    for (var t = 0; t < triCount; t++) {
      var pi = t * 9;
      var x0 = positions[pi],   y0 = positions[pi+1], z0 = positions[pi+2];
      var x1 = positions[pi+3], y1 = positions[pi+4], z1 = positions[pi+5];
      var x2 = positions[pi+6], y2 = positions[pi+7], z2 = positions[pi+8];
      var ex1 = x1 - x0, ey1 = y1 - y0, ez1 = z1 - z0;
      var ex2 = x2 - x0, ey2 = y2 - y0, ez2 = z2 - z0;
      var nx = ey1 * ez2 - ez1 * ey2;
      var ny = ez1 * ex2 - ex1 * ez2;
      var nz = ex1 * ey2 - ey1 * ex2;
      var nlen = Math.sqrt(nx*nx + ny*ny + nz*nz);
      if (nlen < 1e-9) continue;
      nx /= nlen; ny /= nlen; nz /= nlen;
      var d = -(nx * x0 + ny * y0 + nz * z0);
      var sign = 0;
      if (Math.abs(nx) > 1e-6) sign = nx > 0 ? 1 : -1;
      else if (Math.abs(ny) > 1e-6) sign = ny > 0 ? 1 : -1;
      else if (Math.abs(nz) > 1e-6) sign = nz > 0 ? 1 : -1;
      else continue;
      var cnx = nx * sign, cny = ny * sign, cnz = nz * sign, cd = d * sign;
      var key =
        Math.round(cnx * INTERIOR_CULL_QN) + ':' + Math.round(cny * INTERIOR_CULL_QN) + ':' + Math.round(cnz * INTERIOR_CULL_QN) + ':' +
        Math.round(cd * INTERIOR_CULL_QD);
      // Skip the front and back face planes — those have many
      // coplanar triangles per path with normals pointing the
      // SAME direction, no opposite-sign pairs to worry about.
      // (We'd never pair them anyway, but they bloat the bucket.)
      var b = buckets[key];
      if (!b) { b = { pos: [], neg: [] }; buckets[key] = b; }
      (sign > 0 ? b.pos : b.neg).push(t);
    }
    // Pass 2: for each bucket with both positive and negative entries,
    // pair them off and drop the matched triangles. The match is plane-
    // level so we DROP IN PAIRS regardless of which specific triangle
    // partners with which — visually it doesn't matter, both sides of
    // the interior wall vanish.
    var paired = 0;
    for (var bk in buckets) {
      var bb = buckets[bk];
      var nPairs = Math.min(bb.pos.length, bb.neg.length);
      for (var pp = 0; pp < nPairs; pp++) {
        keep[bb.pos[pp]] = 0;
        keep[bb.neg[pp]] = 0;
        paired++;
      }
    }
    if (paired > 0) {
      // In-place compaction: walk the arrays with a write pointer that
      // only advances on keep[t]. Avoids allocating a second set of
      // Float32Arrays at compacted size — saves ~108 bytes per kept
      // triangle per multi-color extrusion. The BufferAttribute below
      // uses .subarray() so only the kept range is uploaded to the GPU;
      // the unused tail is GC'd when the geometry disposes.
      var w0 = 0;
      for (var t2 = 0; t2 < triCount; t2++) {
        if (!keep[t2]) continue;
        var src = t2 * 9;
        var dst = w0 * 9;
        if (src !== dst) {
          for (var u = 0; u < 9; u++) {
            positions[dst + u] = positions[src + u];
            normals[dst + u]   = normals[src + u];
            colors[dst + u]    = colors[src + u];
          }
        }
        w0++;
      }
      positions = positions.subarray(0, w0 * 9);
      normals   = normals.subarray(0, w0 * 9);
      colors    = colors.subarray(0, w0 * 9);
      console.info('[dreambyte-studio3d] interior-face removal: dropped ' + (paired * 2) + ' back-to-back triangles at color seams');
    }

    var merged = new T.BufferGeometry();
    merged.setAttribute('position', new T.BufferAttribute(positions, 3));
    merged.setAttribute('color',    new T.BufferAttribute(colors, 3));
    // Recompute normals from welded positions instead of copying per-child
    // normals. After the 0.05 grid snap, neighboring triangles' normals
    // computed from the SNAPPED positions are deterministic and consistent;
    // copied normals from the original (un-snapped) child geometries would
    // jitter as the mesh rotates because adjacent triangles' normals had
    // small precision-driven differences. Fresh normals = stable shading.
    // Tested adding indexed-dedup on top (one slot per unique position):
    // collapsed correct vertices on simple paths but merged front/back
    // touching points and fold-back points in complex paths (Adobe's A,
    // any shape with self-touching topology), producing non-manifold
    // collapse and degenerate triangles that visibly broke 30%+ of the
    // logos in the test grid. Reverted.
    merged.computeVertexNormals();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    // Reuse the first child's material so 'effect' (matte/chrome/glass/etc.)
    // is preserved. Enable vertexColors so per-path tints come through.
    // Reset material.color to white because the shader multiplies vertex
    // color by material color — leaving it as the first path's color
    // would double-tint everything to that color.
    var mat = children[0].material.clone();
    mat.vertexColors = true;
    if (mat.color && mat.color.set) mat.color.set(0xffffff);
    mat.polygonOffset = false;
    var mergedMesh = new T.Mesh(merged, mat);
    mergedMesh.castShadow = children[0].castShadow;
    mergedMesh.receiveShadow = children[0].receiveShadow;
    // Wipe the per-path children: dispose their geometries and unique
    // materials, then remove from parent. The merged mesh takes their place.
    for (var j = 0; j < children.length; j++) {
      var c = children[j];
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material !== mat && c.material.dispose) c.material.dispose();
      parent.remove(c);
    }
    parent.add(mergedMesh);
  }

  function _flipExtrudedGeoY(geo) {
    geo.scale(1, -1, 1);
    var idx = geo.index;
    if (idx) {
      for (var k = 0; k < idx.count; k += 3) {
        var t = idx.getX(k + 1);
        idx.setX(k + 1, idx.getX(k + 2));
        idx.setX(k + 2, t);
      }
      idx.needsUpdate = true;
    }
    geo.computeVertexNormals();
  }

  /**
   * buildExtrudedSVG — real 3D extruded SVG with PBR materials.
   * Parallel API to buildExtrudedText. Async (fetches the SVG file), returns
   * an empty Group immediately and populates on load.
   *
   * @param T        window.THREE
   * @param svgUrl   URL to the SVG file (absolute or app-relative)
   * @param opts
   *   depth          extrusion depth                              (default 0.18)
   *   bevel          enable bevel                                  (default true)
   *   bevelSize      edge size                                     (default 0.025)
   *   bevelThickness bevel depth                                   (default 0.04)
   *   bevelSegments  bevel smoothness                              (default 6)
   *   curveSegments  curve smoothness                              (default 14)
   *   effect         TEXT_EFFECTS key                              (default 'chrome')
   *   color          OVERRIDE every path's color. If omitted, the SVG's own
   *                  fill colors are preserved (path.color first, then
   *                  path.userData.style.fill string). For metals the color
   *                  tints reflections; for matte/glass/etc it sets diffuse.
   *   palette        fallback colors for paths without ANY resolvable fill
   *                  (default ['#1a1a2e','#e84545','#16a34a','#2563eb'])
   *   material       THREE.Material instance (overrides effect)
   *   fitSize        max world-unit size for bounding box          (default 4; null = no rescale)
   *   center         center geometry at origin                     (default true)
   *   position       [x, y, z] applied to the returned group
   *   rotation       [xDeg, yDeg, zDeg]
   *   castShadow     boolean                                       (default true)
   *   receiveShadow  boolean                                       (default true)
   *   glow           boolean | number — adds emissive glow (pair with bloom)
   *                  true → emissiveIntensity 0.7; number → that intensity
   *   glowColor      override emissive color (default = mat.color)
   * @param onReady  function(group, paths, error?) — called after geometry is
   *                 built. error is set when the SVG fetch failed, SVGLoader is
   *                 missing, or the build was cancelled via
   *                 group.userData.__cancelExtrude. paths is [] in those cases.
   * @returns        THREE.Group (empty until SVG loads; populated in-place)
   */
  // CSS named-color subset covering colors that actually appear in brand
  // SVGs (svgl/figma exports). Full SVG keyword list is 147 entries; this
  // is the practical subset. Unknown keywords fall through to null and the
  // resolver uses the palette fallback (same as before).
  var _CSS_COLORS = {
    white: '#ffffff', black: '#000000', red: '#ff0000', lime: '#00ff00',
    blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
    silver: '#c0c0c0', gray: '#808080', grey: '#808080', maroon: '#800000',
    olive: '#808000', green: '#008000', purple: '#800080', teal: '#008080',
    navy: '#000080', orange: '#ffa500', aqua: '#00ffff', fuchsia: '#ff00ff',
    transparent: null,
  };

  // Parse "#rgb", "#rgba", "#rrggbb", "rgb(r,g,b)", or a CSS keyword.
  // Returns {r,g,b} 0-255, or null on failure / fully transparent.
  function _parseColorRGB(s) {
    if (!s) return null;
    var t = String(s).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(_CSS_COLORS, t)) {
      var k = _CSS_COLORS[t];
      if (!k) return null;
      t = k;
    }
    if (t.charAt(0) === '#') {
      var hex = t.slice(1);
      // Tolerate the 4-digit form (#rgba shorthand or a stray typo like
      // github_dark.svg's "#ffff"): drop the alpha nibble and treat as #rgb.
      if (hex.length === 4) hex = hex.slice(0, 3);
      if (hex.length === 3) hex = hex.charAt(0)+hex.charAt(0)+hex.charAt(1)+hex.charAt(1)+hex.charAt(2)+hex.charAt(2);
      // 8-digit (#rrggbbaa) — drop alpha.
      if (hex.length === 8) hex = hex.slice(0, 6);
      if (hex.length !== 6 || /[^0-9a-f]/.test(hex)) return null;
      return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
    }
    var rgb = t.match(/rgba?\s*\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (rgb) return { r: Math.round(parseFloat(rgb[1])), g: Math.round(parseFloat(rgb[2])), b: Math.round(parseFloat(rgb[3])) };
    return null;
  }
  function _rgbToHex(c) {
    function h(v) { var s = Math.round(Math.max(0, Math.min(255, v))).toString(16); return s.length === 1 ? '0'+s : s; }
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }

  // Flatten every <linearGradient>/<radialGradient> in the SVG to a single
  // representative color. SVGLoader leaves fill as "url(#id)" — Three.Color
  // cannot parse that, so brand logos (firefox, google, meta, nextjs) render
  // with the wrong color. xlink:href chains resolve up to 4 levels.
  //
  // Strategy: average ALL stops weighted by offset range. First-stop alone
  // misrepresents many brand gradients — google's gradient `h` runs
  // green→yellow, so first-stop=green misses the visually dominant yellow
  // region of the G. Range-weighted average preserves the dominant color
  // (a stop spanning 0.0→0.5 contributes twice as much as one spanning
  // 0.5→0.7) and gracefully handles 2-stop and 10-stop gradients alike.
  // Per-gradient average opacity — populated alongside _extractGradients's
  // color map. Used to detect mostly-transparent overlay gradients (e.g.
  // firefox's gradient `l`: yellow with stop-opacity 0..0.8 painted on top
  // of the whole logo to add a soft glow). Without this we treat the overlay
  // as solid opaque yellow and bury every brand color underneath.
  var _GRADIENT_TRANSPARENT_THRESHOLD = 0.5;

  function _extractGradients(text, alphaMap) {
    var map = {};
    if (!text) return map;
    var inherits = {};
    var re = /<(linear|radial)Gradient\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1Gradient>)/gi;
    var m;
    while ((m = re.exec(text))) {
      var attrs = m[2] || '';
      var body = m[3] || '';
      var idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/);
      if (!idMatch) continue;
      var id = idMatch[1];
      // gradient-level opacity attribute: SVG spec says color is multiplied
      // by this. fabric.js does the same multiplicative fold.
      var gradOpa = 1;
      var gradOpaAttr = attrs.match(/\bopacity\s*=\s*["']([^"']+)["']/);
      if (gradOpaAttr) {
        var gv = parseFloat(gradOpaAttr[1]);
        if (isFinite(gv)) gradOpa = Math.max(0, Math.min(1, gv));
      }
      var stops = [];
      if (body) {
        var stopRe = /<stop\b([^>]*)>/gi;
        var sm;
        while ((sm = stopRe.exec(body))) {
          var sAttrs = sm[1] || '';
          var color = null;
          var attrColor = sAttrs.match(/\bstop-color\s*=\s*["']([^"']+)["']/);
          if (attrColor) color = attrColor[1];
          if (!color) {
            var styleAttr = sAttrs.match(/\bstyle\s*=\s*["']([^"']+)["']/);
            if (styleAttr) {
              var styleColor = styleAttr[1].match(/stop-color\s*:\s*([^;"']+)/i);
              if (styleColor) color = styleColor[1].trim();
            }
          }
          if (!color) continue;
          var offsetMatch = sAttrs.match(/\boffset\s*=\s*["']([^"']+)["']/);
          var off = offsetMatch ? parseFloat(offsetMatch[1]) : null;
          if (offsetMatch && /%\s*$/.test(offsetMatch[1])) off = off / 100;
          var rgb = _parseColorRGB(color);
          if (!rgb) continue;
          // stop-opacity (attribute or inline style); default 1.
          var opa = 1;
          var opaAttr = sAttrs.match(/\bstop-opacity\s*=\s*["']([^"']+)["']/);
          if (opaAttr) {
            var pv = parseFloat(opaAttr[1]);
            if (isFinite(pv)) opa = Math.max(0, Math.min(1, pv));
          } else {
            var styleAttr2 = sAttrs.match(/\bstyle\s*=\s*["']([^"']+)["']/);
            if (styleAttr2) {
              var styleOpa = styleAttr2[1].match(/stop-opacity\s*:\s*([0-9.]+)/i);
              if (styleOpa) {
                var pv2 = parseFloat(styleOpa[1]);
                if (isFinite(pv2)) opa = Math.max(0, Math.min(1, pv2));
              }
            }
          }
          stops.push({ off: off, rgb: rgb, opa: opa });
        }
      }
      if (stops.length === 0) {
        var href = attrs.match(/xlink:href\s*=\s*["']#([^"']+)["']/) ||
                   attrs.match(/\bhref\s*=\s*["']#([^"']+)["']/);
        if (href) inherits[id] = href[1];
        continue;
      }
      // Sort by offset (treat missing offsets as evenly distributed).
      var stopsSorted = stops.slice().map(function (s, idx) {
        return {
          off: (s.off === null || isNaN(s.off)) ? idx / Math.max(1, stops.length - 1) : s.off,
          rgb: s.rgb,
          opa: typeof s.opa === 'number' ? s.opa : 1,
        };
      }).sort(function (a, b) { return a.off - b.off; });
      var n = stopsSorted.length;
      // Stop-picking strategy: middle index. Tested luma×alpha×coverage
      // (per fabric.js + svgo conventions) — over-weighted bright stops,
      // pulled firefox's whole palette toward yellow. Middle-by-index gives
      // the best visual match for typical multi-stop brand gradients across
      // the svgl test set; the bookend stops are interpolation extras and
      // brand identity sits in the middle range.
      if (n === 1) {
        map[id] = _rgbToHex(stopsSorted[0].rgb);
      } else if (n === 2) {
        map[id] = _rgbToHex({
          r: (stopsSorted[0].rgb.r + stopsSorted[1].rgb.r) / 2,
          g: (stopsSorted[0].rgb.g + stopsSorted[1].rgb.g) / 2,
          b: (stopsSorted[0].rgb.b + stopsSorted[1].rgb.b) / 2,
        });
      } else {
        var midIdx = Math.floor(n / 2);
        map[id] = _rgbToHex(stopsSorted[midIdx].rgb);
      }
      if (alphaMap) {
        // Average effective alpha (stop-opacity × gradient.opacity) across
        // stops. Below the threshold we treat the gradient as a decorative
        // transparency overlay and skip the path during extrusion.
        // (Tried max-only: firefox `l` has stops [0, 0.217, 0.634, 0.8] —
        // max=0.8 would say "not decorative" but it IS a fade-to-transparent
        // overlay. Average=0.413 catches it correctly.)
        var aSum = 0;
        for (var ai = 0; ai < n; ai++) aSum += stopsSorted[ai].opa * gradOpa;
        alphaMap[id] = n > 0 ? aSum / n : 1;
      }
    }
    // Resolve href chains. Multiple passes handle A→B→C inheritance.
    for (var pass = 0; pass < 4; pass++) {
      var grew = false;
      for (var k in inherits) {
        if (!Object.prototype.hasOwnProperty.call(inherits, k)) continue;
        if (map[k]) continue;
        var target = inherits[k];
        if (map[target]) { map[k] = map[target]; grew = true; }
      }
      if (!grew) break;
    }
    return map;
  }

  w.buildExtrudedSVG = function (T, svgUrl, opts, onReady) {
    opts = opts || {};
    var group = new T.Group();
    var inner = new T.Group();
    group.add(inner);

    // Filled by the fetch handler before buildFromPaths runs.
    var gradientMap = {};
    // Per-gradient average alpha. Gradients below the transparency threshold
    // (firefox's `l`: avg 0.413) are skipped during path iteration so they
    // don't render as solid opaque overlays burying every brand color below.
    var gradientAlphaMap = {};

    if (opts.position) group.position.set(opts.position[0], opts.position[1], opts.position[2]);
    if (opts.rotation) {
      group.rotation.x = (opts.rotation[0] || 0) * Math.PI / 180;
      group.rotation.y = (opts.rotation[1] || 0) * Math.PI / 180;
      group.rotation.z = (opts.rotation[2] || 0) * Math.PI / 180;
    }

    function makeBaseMat() {
      if (opts.material) return opts.material;
      var effectFn = w.TEXT_EFFECTS && w.TEXT_EFFECTS[opts.effect || 'chrome'];
      if (effectFn) return effectFn(T, opts.color);
      return new T.MeshPhysicalMaterial({
        color: opts.color ? new T.Color(opts.color) : new T.Color(0xffffff),
        metalness: 0.8,
        roughness: 0.15,
        clearcoat: 1.0,
      });
    }

    // _thickenStrokePath: turn an open/closed polyline (Vector2 points) into a
    // closed Shape by offsetting each vertex ±halfWidth along its segment
    // normal, then concatenating the left and right edges. Lets stroke-only
    // SVGs (icons drawn as outlines) be extruded — without this they'd silently
    // drop because SVGLoader.createShapes returns nothing for fill="none".
    function _thickenStrokePath(T, points, halfWidth) {
      if (!points || points.length < 2 || halfWidth <= 0) return null;
      var leftSide = [];
      var rightSide = [];
      for (var i = 0; i < points.length; i++) {
        var prev = i > 0 ? points[i - 1] : points[i];
        var next = i < points.length - 1 ? points[i + 1] : points[i];
        var dx = next.x - prev.x;
        var dy = next.y - prev.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        // Normal = segment direction rotated 90° CCW. Average across incoming +
        // outgoing avoids miter spikes at sharp corners.
        var nx = -dy / len;
        var ny = dx / len;
        leftSide.push(new T.Vector2(points[i].x + nx * halfWidth, points[i].y + ny * halfWidth));
        rightSide.push(new T.Vector2(points[i].x - nx * halfWidth, points[i].y - ny * halfWidth));
      }
      // Build ring: forward along left, then reversed right. Closes the shape.
      var ring = leftSide.concat(rightSide.reverse());
      return new T.Shape(ring);
    }

    // Weld near-coincident contour points after tessellation. Many real-world
    // SVGs close paths with a microsegment (e.g., M(1,12.509) → ... →
    // L(1,21.013) → v-8.505 → z, leaving a 0.001-unit gap between the close
    // and the M point). When ExtrudeGeometry's bevel offset exceeds the
    // segment length, it produces degenerate side faces that read as a kink
    // in the middle of an otherwise straight edge. Welding within
    // bboxMax * 0.005 (0.5% of the shape's max dim) collapses these without
    // affecting genuine micro-curves.
    //
    // Spec: lib/sdk-regression/extrude-svg-safeguards.test.ts owns the
    // executable behavior for this and the bevel-vs-segment clamp below.
    function _weldShape(T, shape, curveSegs, tol) {
      var raw = shape.extractPoints(curveSegs);
      var weld = function (pts) {
        if (!pts || pts.length < 2) return pts;
        var out = [pts[0]];
        for (var i = 1; i < pts.length; i++) {
          if (pts[i].distanceTo(out[out.length - 1]) > tol) out.push(pts[i]);
        }
        // Also weld the closing seam (first ↔ last).
        if (out.length >= 3 && out[0].distanceTo(out[out.length - 1]) <= tol) {
          out.pop();
        }
        return out;
      };
      var outer = weld(raw.shape);
      if (!outer || outer.length < 3) return shape; // degenerate; bail
      var welded = new T.Shape(outer);
      if (raw.holes && raw.holes.length) {
        for (var h = 0; h < raw.holes.length; h++) {
          var hp = weld(raw.holes[h]);
          if (hp && hp.length >= 3) welded.holes.push(new T.Path(hp));
        }
      }
      return welded;
    }

    // Out-of-frame filter: SVGs with <mask>/<clipPath>/filter effects often
    // ship paths drawn outside the viewBox that the renderer is supposed to
    // clip away (e.g., antigravity-color.svg uses a mask to clip blurred
    // colored circles, with M-points at -12, +28 in a 0..24 viewBox). Three.js
    // SVGLoader ignores <mask>, so without this filter every blob gets
    // extruded and dragged the bbox wide — the on-canvas silhouette ends up
    // tiny while off-canvas filler dominates. Skip any shape whose bbox
    // center lies more than half a viewBox-dim outside the viewBox.
    function _isOutOfFrame(shape, vb) {
      if (!vb || !vb.w || !vb.h) return false;
      var pts = shape.getPoints(8);
      if (!pts.length) return false;
      var sumX = 0, sumY = 0;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var k = 0; k < pts.length; k++) {
        sumX += pts[k].x; sumY += pts[k].y;
        if (pts[k].x < minX) minX = pts[k].x;
        if (pts[k].y < minY) minY = pts[k].y;
        if (pts[k].x > maxX) maxX = pts[k].x;
        if (pts[k].y > maxY) maxY = pts[k].y;
      }
      var cx = sumX / pts.length, cy = sumY / pts.length;
      var marginX = vb.w * 0.25, marginY = vb.h * 0.25;
      var outsideCenter = cx < (vb.x - marginX) || cx > (vb.x + vb.w + marginX) ||
                          cy < (vb.y - marginY) || cy > (vb.y + vb.h + marginY);
      // Also skip if the shape's bbox doesn't intersect the viewBox at all —
      // catches paths that span far in one direction but happen to have a
      // center within tolerance.
      var noOverlap = maxX < vb.x || minX > (vb.x + vb.w) ||
                      maxY < vb.y || minY > (vb.y + vb.h);
      return outsideCenter || noOverlap;
    }

    // viewBox-rect filter: when an SVG ships with a full-bg rect (Figma /
    // Illustrator artifact), its bbox covers the whole viewBox. Skip any shape
    // whose bbox is ≥95% of the viewBox area AND whose aspect ratio matches —
    // those are nearly always the artifact, not a real path. Disabled when vb
    // is null (no parsable viewBox / width+height).
    function _isFullBoundsArtifact(shape, vb) {
      if (!vb || !vb.w || !vb.h) return false;
      // Target: an axis-aligned 4-vertex rectangle (a `<rect>` or 4-point
      // path) whose bbox matches the viewBox — these are the spacer/canvas-
      // background paths some SVGs include for layout (Google G's
      // `<path d="M1 1h22v22H1z" fill="none"/>`, etc.). MUST NOT drop:
      //   • Triangles that happen to span the viewBox (vercel's triangle is
      //     the logo). Earlier heuristics keyed on `uniq <= 12` and dropped
      //     any 3-vertex polygon with full-bounds bbox.
      //   • Circles that span the viewBox (nextjs black circle background).
      //     Still excluded because their sampled outline > 12 unique points.
      //   • Rounded rectangles, ovals, full-bounds curves — any non-axis-
      //     aligned-rect shape is preserved.
      var pts = shape.getPoints(32);
      if (!pts.length) return false;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var k = 0; k < pts.length; k++) {
        if (pts[k].x < minX) minX = pts[k].x;
        if (pts[k].y < minY) minY = pts[k].y;
        if (pts[k].x > maxX) maxX = pts[k].x;
        if (pts[k].y > maxY) maxY = pts[k].y;
      }
      var sw = maxX - minX, sh = maxY - minY;
      if (sw <= 0 || sh <= 0) return false;
      var areaRatio = (sw * sh) / (vb.w * vb.h);
      if (areaRatio < 0.80) return false;
      // Aspect ratio similarity (within 10%) — guards against tall thin shapes.
      var svgAR = vb.w / vb.h, shapeAR = sw / sh;
      var arDelta = Math.abs(svgAR - shapeAR) / svgAR;
      if (arDelta >= 0.1) return false;
      // Specifically detect axis-aligned 4-corner rectangles. Quantize then
      // dedup; a true rect produces exactly 4 unique vertices, all sitting
      // at one of the bbox corners (xmin|xmax × ymin|ymax). Vercel's
      // triangle has 3 unique points → returns false here. Circles &
      // rounded rects produce many more unique points → also false.
      var seen = Object.create(null);
      var uniqList = [];
      for (var p = 0; p < pts.length; p++) {
        var qx = Math.round(pts[p].x * 10);
        var qy = Math.round(pts[p].y * 10);
        var key = qx + ',' + qy;
        if (!seen[key]) { seen[key] = 1; uniqList.push([pts[p].x, pts[p].y]); }
      }
      if (uniqList.length !== 4) return false;
      // All 4 unique vertices must hug a bbox corner (within 1% of the
      // shape's smaller dimension). A non-rect 4-gon (parallelogram, kite,
      // etc.) misses this gate even with full-bounds bbox.
      var tol = Math.max(sw, sh) * 0.01;
      for (var u = 0; u < 4; u++) {
        var x = uniqList[u][0], y = uniqList[u][1];
        var atXEdge = Math.abs(x - minX) <= tol || Math.abs(x - maxX) <= tol;
        var atYEdge = Math.abs(y - minY) <= tol || Math.abs(y - maxY) <= tol;
        if (!atXEdge || !atYEdge) return false;
      }
      return true;
    }

    function buildFromPaths(paths, vb) {
      // SVG paths come in raw viewBox coords. Depth/bevel defaults are
      // bbox-relative so a 24-px icon and a 1000-px logo both read as chunky
      // slabs (not towering pillars). Inner group is scaled to fitSize.
      var bevel          = opts.bevel          !== undefined ? opts.bevel          : true;
      var bevelSegments  = opts.bevelSegments  !== undefined ? opts.bevelSegments  : 3;
      var curveSegments  = opts.curveSegments  !== undefined ? opts.curveSegments  : 24;
      // Both default OFF for extruded SVGs:
      //   • receiveShadow=false: with multiple per-path meshes (post-diff),
      //     neighbors' bevel chamfers cast onto each other's flat front
      //     face — visible as a soft gray haze across colored regions.
      //   • castShadow=false: in a grid layout, each logo's meshes cast
      //     shadows onto the FRONT face of adjacent logos at the same
      //     world Y. The drop-shadow on the FLOOR is what users actually
      //     want; the inter-mesh shadows are pure noise.
      // Caller can opt either back in via opts.castShadow / opts.receiveShadow
      // for a single-logo scene where self-shadowing reads as depth, or
      // when explicitly placing a ground-shadow setup.
      var castShadow     = opts.castShadow     !== undefined ? opts.castShadow     : false;
      var receiveShadow  = opts.receiveShadow  !== undefined ? opts.receiveShadow  : false;
      var center         = opts.center         !== undefined ? opts.center         : true;
      var fitSize        = opts.fitSize        !== undefined ? opts.fitSize        : 4;
      var palette        = opts.palette        || ['#1a1a2e', '#e84545', '#16a34a', '#2563eb'];

      // Pre-pass paths to compute the SVG bbox max-dim AND the shortest
      // (real) edge length. bbox autoscales depth + bevels; shortest edge
      // clamps bevels so they never exceed segment lengths (a bevel offset
      // bigger than the segment it chamfers produces degenerate side faces).
      // Explicit overrides always win.
      var bboxMax = 200;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      var allEdges = [];
      paths.forEach(function (p) {
        var pStyle = (p.userData && p.userData.style) || {};
        var pHasStroke = pStyle.stroke && pStyle.stroke !== 'none';
        if (pStyle.fill === 'none' && !pHasStroke) return; // invisible spacer
        var pShapes = (w.SVGLoader && w.SVGLoader.createShapes) ? w.SVGLoader.createShapes(p) : p.toShapes(true);
        pShapes.forEach(function (s) {
          if (_isFullBoundsArtifact(s, vb) || _isOutOfFrame(s, vb)) return;
          var pts = s.getPoints(curveSegments);
          for (var k = 0; k < pts.length; k++) {
            if (pts[k].x < minX) minX = pts[k].x;
            if (pts[k].y < minY) minY = pts[k].y;
            if (pts[k].x > maxX) maxX = pts[k].x;
            if (pts[k].y > maxY) maxY = pts[k].y;
            if (k > 0) allEdges.push(pts[k].distanceTo(pts[k - 1]));
          }
        });
      });
      if (isFinite(maxX) && isFinite(maxY)) {
        bboxMax = Math.max(maxX - minX, maxY - minY) || 200;
      }
      // Weld tolerance: 0.5% of bbox max-dim. Shortest "real" edge ignores
      // anything below this, since those will be welded out before extrusion.
      var weldTol = Math.max(0.001, bboxMax * 0.005);
      var shortestEdge = Infinity;
      for (var ei = 0; ei < allEdges.length; ei++) {
        if (allEdges[ei] > weldTol && allEdges[ei] < shortestEdge) shortestEdge = allEdges[ei];
      }
      // Default depth ≈ 18% of bbox max-dim — chunky but never a pillar.
      // Clamp so a 4-px sliver still gets visible thickness (min 1.5).
      var depth          = opts.depth          !== undefined ? opts.depth          : Math.max(1.5, bboxMax * 0.18);
      // Bevels scale to depth so the chamfer reads but doesn't dominate.
      var bevelSize      = opts.bevelSize      !== undefined ? opts.bevelSize      : depth * 0.06;
      var bevelThickness = opts.bevelThickness !== undefined ? opts.bevelThickness : depth * 0.10;

      // Apply fit-scale + centering UPFRONT from prepass bbox. Without this,
      // complex SVGs (50+ paths) trigger async batching, and the only fit-scale
      // pass — `_finalize` after all batches complete — runs late. During the
      // gap, meshes render at raw SVG-coord size (often 100s of world units),
      // a single icon can dominate the entire viewport. Y-flip (_flipExtrudedGeoY
      // negates Y) means inner-local Y is the SVG-Y negated, so the centering
      // offset's Y sign flips. Z is depth/2 in raw units (after scale).
      if (isFinite(maxX) && isFinite(maxY) && (center || fitSize)) {
        var preScale = fitSize ? (fitSize / (Math.max(maxX - minX, maxY - minY) || 1)) : 1;
        var preCenterX = (minX + maxX) / 2;
        var preCenterY = (minY + maxY) / 2;
        if (fitSize) inner.scale.set(preScale, preScale, preScale);
        if (center) inner.position.set(-preCenterX * preScale, preCenterY * preScale, -(depth / 2) * preScale);
      }
      // Second safeguard: clamp bevels to 45% of the shortest real edge.
      // ExtrudeGeometry's bevel offset can't exceed segment length without
      // producing degenerate triangles — same family of artifacts welding
      // catches at the path-close seam, but for SVGs with genuinely small
      // detail (thin notches, fine ornament). User overrides bypass this.
      if (isFinite(shortestEdge)) {
        var maxBevel = shortestEdge * 0.45;
        if (opts.bevelSize === undefined && bevelSize > maxBevel) bevelSize = maxBevel;
        if (opts.bevelThickness === undefined && bevelThickness > maxBevel) bevelThickness = maxBevel;
      }

      var baseMat = makeBaseMat();

      // Pre-resolve all shapes (with stroke-thickening + bg-rect filtering)
      // into a flat array. Lets the async batch loop yield without juggling
      // nested per-path / per-subpath state.
      var entries = [];
      paths.forEach(function (path) {
        var style = (path.userData && path.userData.style) || {};
        var styleFill = style.fill;
        var hasStroke = style.stroke && style.stroke !== 'none';
        // Explicit fill="none" with no stroke = invisible spacer (e.g.
        // Google G's `<path d="M1 1h22v22H1z" fill="none"/>` viewBox-rect
        // used to reserve canvas space). Skip — extruding it produces a
        // chrome slab wrapping the actual logo.
        if (styleFill === 'none' && !hasStroke) return;
        // Mostly-transparent gradient = decorative overlay (firefox's `l`:
        // yellow with stop-opacity 0..0.8 painted on top of the whole logo
        // for a soft glow). 3D extrusion can't fake the additive glow, and
        // rendering as solid opaque buries every brand color underneath.
        // Drop the path; whatever it was layered over now reads as the
        // top color at those pixels.
        if (typeof styleFill === 'string' && styleFill.charAt(0) === 'u') {
          var gid = styleFill.match(/#([^)\s'"]+)/);
          if (gid && typeof gradientAlphaMap[gid[1]] === 'number' &&
              gradientAlphaMap[gid[1]] < _GRADIENT_TRANSPARENT_THRESHOLD) {
            return;
          }
        }
        var shapes = (w.SVGLoader && w.SVGLoader.createShapes)
          ? w.SVGLoader.createShapes(path)
          : path.toShapes(true);
        var hasFill = !!shapes.length;
        if (!hasFill && hasStroke && path.subPaths && path.subPaths.length) {
          var sw = parseFloat(style.strokeWidth) || 1;
          var halfW = Math.max(0.5, sw / 2);
          path.subPaths.forEach(function (sub) {
            var pts = sub.getPoints(curveSegments);
            var sh = _thickenStrokePath(T, pts, halfW);
            if (sh) shapes.push(sh);
          });
        }
        shapes.forEach(function (shape) {
          if (_isFullBoundsArtifact(shape, vb) || _isOutOfFrame(shape, vb)) return;
          entries.push({ shape: shape, path: path });
        });
      });

      // Multi-color seam handling: when a single SVG defines paths with
      // different fills (Google G, antigravity, deepmind), each path
      // extrudes as its own mesh with its own bevel. At color seams the
      // back-to-back chamfers form a visible V-groove (darker line at
      // the meet point because the chamfer faces don't catch direct
      // light). Reduce bevel for multi-color extrusions so the V-groove
      // shrinks below the visible threshold while keeping a subtle
      // chamfer on the outer silhouette. Caller can override via
      // explicit opts.bevelSize / opts.bevelThickness.
      // Multi-color detection. Counts distinct fills across all entries.
      //   • path.color is set when the SVG uses fill="#xxxxxx" attributes
      //     directly (SVGLoader's parsed Color object).
      //   • path.userData.style.fill is set when the SVG uses CSS-style
      //     fills (style="fill:#xxx" or fill="rgb(...)") — SVGLoader keeps
      //     the raw string here without parsing it to a Color. Earlier
      //     versions only checked path.color, which mis-classified any
      //     SVG using style fills as single-color and skipped the multi-
      //     color pipeline. Normalize both into a string key so they
      //     dedupe across both representations.
      // When opts.color is set, every path renders the same override color
      // regardless of its SVG fill — treat as single-color so we don't
      // strip bevel from a logo the caller has explicitly recolored to one
      // tone. Same treatment when opts.color is a function (per-path
      // dynamic) since we can't predict its outputs without invoking it.
      var _seamColors = (function () {
        if (opts.color !== undefined && opts.color !== null) return 1;
        var seen = Object.create(null);
        var n = 0;
        for (var ec = 0; ec < entries.length; ec++) {
          var p = entries[ec].path;
          if (!p) continue;
          var key = null;
          // url(#id) takes precedence over p.color — SVGLoader sets a default
          // p.color when it can't parse url(...), which would mis-key every
          // gradient-painted path to that single default and collapse the
          // distinct-fill count back to 1.
          var styleFill = p.userData && p.userData.style && p.userData.style.fill;
          var fillExplicit = styleFill !== undefined && styleFill !== null && styleFill !== '';
          if (styleFill && styleFill.charAt(0) === 'u') {
            var gid = styleFill.match(/#([^)\s'"]+)/);
            if (gid && gradientMap[gid[1]]) key = String(gradientMap[gid[1]]).trim().toLowerCase();
          } else if (fillExplicit && p.color && typeof p.color.getHex === 'function') {
            key = '#' + p.color.getHex().toString(16).padStart(6, '0');
          } else if (fillExplicit && styleFill !== 'none') {
            key = String(styleFill).trim().toLowerCase();
          } else if (!fillExplicit) {
            // SVG default fill is black — distinct from any white-filled path.
            key = '#000000';
          }
          if (key === null) continue;
          if (!seen[key]) { seen[key] = 1; n++; }
        }
        return n;
      })();
      // For multi-color SVGs, the back-to-back chamfer V-groove between
      // adjacent paths reads as a visible dark line at every color seam.
      // No amount of shrink eliminates it — it's the lighting on the
      // chamfer face normal, not the chamfer size. Default to FLAT
      // extrusion (bevel disabled) for multi-color SVGs so seams are
      // clean color butt-joints. Caller can opt back in via explicit
      // opts.bevel:true AND opts.bevelSize/Thickness — passing bevel:true
      // alone is honored as "use small chamfer", not "full chamfer".
      if (_seamColors >= 2) {
        if (opts.bevelSize === undefined && opts.bevelThickness === undefined) {
          bevel = false;
          bevelSize = 0;
          bevelThickness = 0;
          console.info('[dreambyte-studio3d] multi-color SVG detected (' + _seamColors + ' distinct fills across ' + entries.length + ' paths) — bevel auto-disabled to avoid V-groove at color seams; pass explicit opts.bevelSize to override');
        } else {
          // Caller provided explicit sizes — respect them but shrink
          // unspecified ones to match.
          if (opts.bevelSize === undefined) bevelSize = bevelSize * 0.35;
          if (opts.bevelThickness === undefined) bevelThickness = bevelThickness * 0.35;
        }
      }

      // 2D path differencing — opt-OUT. Operates on flat polygons before
      // extrusion so the resulting meshes are guaranteed non-overlapping in
      // XY. The earlier 3D CSG attempt froze the editor because each op was
      // ~50ms and ran post-extrude on bevel-tessellated meshes; this 2D
      // version is ~1ms per entry on flat polygons. Cheap enough to default
      // ON. Caller can still pass opts.csg === false to disable. Skipped:
      //   • entries.length > 30 — guardrail against unexpectedly complex
      //     marks where N² polygon ops add up
      //   • all entries share the same fill — overlap is invisible at the
      //     pixel level, no need to cut geometry
      //   • polygon-clipping isn't loaded — silently no-op
      if (
        opts.csg !== false &&
        entries.length > 1 &&
        entries.length <= 30 &&
        w.polygonClipping
      ) {
        // Reuse the same gradient-aware key extraction as the seam counter —
        // path.color alone is unreliable here because SVGLoader silently
        // collapses every url(#…) fill to default white, which would make
        // google.svg / firefox.svg / meta.svg look single-colored and skip
        // the 2D path diff that prevents overlap rendering artifacts.
        var sameColor = (function () {
          if (entries.length < 2) return true;
          function keyOf(p) {
            if (!p) return null;
            var sf = p.userData && p.userData.style && p.userData.style.fill;
            var fillExplicit = sf !== undefined && sf !== null && sf !== '';
            if (sf && sf.charAt(0) === 'u') {
              var gid = sf.match(/#([^)\s'"]+)/);
              if (gid && gradientMap[gid[1]]) return String(gradientMap[gid[1]]).trim().toLowerCase();
              return null; // unresolved gradient — treat as "different" to be safe
            }
            if (fillExplicit && p.color && typeof p.color.getHex === 'function') {
              return '#' + p.color.getHex().toString(16).padStart(6, '0');
            }
            if (fillExplicit && sf !== 'none') return String(sf).trim().toLowerCase();
            if (!fillExplicit) return '#000000'; // SVG spec: no fill = black
            return null;
          }
          var first = keyOf(entries[0].path);
          if (first === null) return false;
          for (var i = 1; i < entries.length; i++) {
            if (keyOf(entries[i].path) !== first) return false;
          }
          return true;
        })();
        if (!sameColor) {
          try {
            // Pre-pass: UNION same-color entries so multiple paths painted
            // with identical colors collapse into a single polygon. firefox
            // has 9 paths after dropping transparent overlays but only 7
            // distinct colors after middle-stop flattening — 2 paths share
            // colors. Without this, those same-color paths each extrude
            // as separate meshes whose internal seams (between same-color
            // pieces) drift sub-pixel and cause z-fighting on rotation.
            // Same-color seams are INVISIBLE in 2D anyway (same color =
            // no visible boundary), so collapsing them is purely a win.
            entries = _unionSameColorEntries(T, entries, curveSegments, function (entry) {
              var p = entry.path;
              if (!p) return null;
              var sf = p.userData && p.userData.style && p.userData.style.fill;
              if (sf && sf.charAt(0) === 'u') {
                var gid = sf.match(/#([^)\s'"]+)/);
                if (gid && gradientMap[gid[1]]) return String(gradientMap[gid[1]]).trim().toLowerCase();
                return null;
              }
              if (sf && p.color && typeof p.color.getHex === 'function') {
                return '#' + p.color.getHex().toString(16).padStart(6, '0');
              }
              if (sf && sf !== 'none') return String(sf).trim().toLowerCase();
              if (sf === undefined || sf === null || sf === '') return '#000000';
              return null;
            });
            // Single transformation: diff every path so adjacent colors no
            // longer overlap in 2D. Each entry then extrudes as ONE mesh
            // per path with its OWN color and OWN bevel (path.color via the
            // standard color-resolution chain in _addOneMesh).
            //
            // No inflate: keeps adjacent paths' side walls coplanar so the
            // post-merge interior-face cull can pair them up. The remaining
            // sub-pixel precision drift is absorbed by the cull's plane-
            // bucket quantization (INTERIOR_CULL_QN/QD) and the merge-step
            // 0.05 grid weld.
            entries = _diffEntriesBeforeExtrude(T, entries, curveSegments, 0);
            // Seam cover: physically inflate every entry's OUTER ring outward
            // by ~0.3% of bboxMax (SVG units). Without this, an upper path's
            // outer wall and the lower path's hole-interior wall sit on the
            // exact same plane at every diff boundary — sub-pixel rasterization
            // lets the lower's inward-facing dark side wall poke through as a
            // thin perimeter line, visible during rotation (nextjs N, youtube
            // triangle, etc.). Inflating the OUTER ring only — leaving any
            // original SVG holes (donut hole in github_dark, letter O cores)
            // at their authored size — grows the upper's silhouette enough
            // for its front + side walls to physically OVERHANG the lower's
            // hole boundary by a sub-pixel-but-rasterizer-stable amount, so
            // every camera angle sees the upper's color, never the lower's
            // hole rim. Painter's order (renderOrder + polygonOffset +
            // depthWrite:false) handles the resulting overlap band on
            // adjacent paths' coincident regions. Caller can override eps via
            // opts.seamHide (SVG units) or set to 0 to disable.
            var _seamHideEps = (opts.seamHide !== undefined)
              ? Math.max(0, +opts.seamHide || 0)
              : Math.max(0.5, (isFinite(bboxMax) ? bboxMax : 100) * 0.012);
            if (_seamHideEps > 0) {
              var _beforeCount = entries.length;
              entries = _inflateEntriesPostDiff(T, entries, curveSegments, _seamHideEps);
              if (typeof console !== 'undefined' && console.info) {
                console.info('[dreambyte-studio3d] seam-hide inflate eps=' + _seamHideEps.toFixed(2) + ' SVG units; entries ' + _beforeCount + ' → ' + entries.length);
              }
            }
          } catch (err) {
            console.warn('[dreambyte-studio3d] 2D path diff threw; falling back to raw entries', err);
          }
        }
      }

      function _addOneMesh(entry, i) {
        var shape = entry.shape;
        var path = entry.path;
        var welded = _weldShape(T, shape, curveSegments, weldTol);
        // Flat-uppers: in multi-color mode, only the BOTTOM mesh (i==0)
        // gets the full extrusion. Upper meshes use ShapeGeometry — a flat
        // 2D mesh of the front face only — placed slightly forward of the
        // bottom's front cap. This eliminates the upper layers' side walls
        // entirely. Side walls were the actual cause of the rotation-
        // outline artifact: even with bevel disabled and depth halved, the
        // sharp 90° walls projected as a visible band at every silhouette
        // (nextjs N, youtube triangle, etc.). Three.js's official
        // examples/webgl_loader_svg.html uses ShapeGeometry for the same
        // reason — flat layers stacked by renderOrder, no extrusion. We
        // only flatten the UPPERS so the icon still reads as 3D from the
        // bottom layer's depth + side walls. Caller opt-out via
        // opts.solidUppers === true (also disables depthWrite:false above).
        var useFlatUpper = (
          _seamColors >= 2 &&
          i > 0 &&
          !opts.glow &&
          opts.solidUppers !== true
        );
        var geo;
        if (useFlatUpper) {
          geo = new T.ShapeGeometry(welded, curveSegments);
          _flipExtrudedGeoY(geo);
          // Translate the flat layer to sit at the bottom mesh's front
          // cap (Z = depth) plus a tiny forward offset proportional to
          // depth so depth-test puts it on top of the bottom's front
          // face without cracks. Each upper layer adds another tiny
          // increment so multiple uppers stack in document order.
          var zForward = depth + Math.max(0.0005, depth * 0.001) * (i + 1);
          geo.translate(0, 0, zForward);
        } else {
          geo = new T.ExtrudeGeometry(welded, {
            depth: depth,
            bevelEnabled: bevel,
            bevelSize: bevelSize,
            bevelThickness: bevelThickness,
            bevelSegments: bevelSegments,
            curveSegments: curveSegments,
          });
          _flipExtrudedGeoY(geo);
        }
        // When the caller passes a custom `opts.material` they expect THAT
        // material on every path — uniform glass/chrome/gold across the whole
        // mark, ignoring SVG fills. Cloning + overriding mat.color per path
        // (the default branch) silently re-tints the user's material with
        // brand colors, which is wrong for glass (transmission tinted by
        // logo color) and for any "make it all the same finish" use case.
        // Default: opts.material → reuse the same instance, skip per-path
        // color resolution entirely.
        // Opt-in: opts.colorize === true → restore the old behavior (clone
        // baseMat per path and override mat.color from SVG fill). Useful when
        // the caller wants brand colors but a custom non-color property like
        // metalness/roughness from their material.
        var keepMaterialAsIs = !!opts.material && opts.colorize !== true;
        var mat = keepMaterialAsIs ? baseMat : baseMat.clone();
        // Color resolution (vecto3d-style):
        //   1. opts.color → explicit override, ignores SVG fill
        //   2. path.color (THREE.Color from fill="…")
        //   3. path.userData.style.fill (string from style="fill:…")
        //   4. path.userData.style.stroke (when path is stroke-only)
        //   5. palette fallback (gradient/url(#…)/none)
        if (keepMaterialAsIs) {
          // Skip color resolution — caller's material is final.
        } else if (opts.color) {
          mat.color.set(opts.color);
        } else {
          var styleFill = path.userData && path.userData.style && path.userData.style.fill;
          var styleStroke = path.userData && path.userData.style && path.userData.style.stroke;
          // url(#id) MUST be checked before path.color — SVGLoader sets
          // path.color to a default (black/white) when it fails to parse
          // url(...), which would otherwise short-circuit the gradient
          // lookup and lock every gradient-painted path to that default.
          var pickedColor = null;
          if (styleFill && styleFill.charAt(0) === 'u') {
            var gradId = styleFill.match(/#([^)\s'"]+)/);
            if (gradId && gradientMap[gradId[1]]) pickedColor = gradientMap[gradId[1]];
          }
          // SVG `fill="currentColor"` inherits the CSS `color` property,
          // which we have no DOM context for here. SVGLoader fails to
          // parse "currentColor" and leaves path.color at its default
          // (white) — so monochrome icon sets like lobe-icons render as
          // white extrusions, which is invisible on light backgrounds and
          // wrong on dark ones too (a styleless browser draws currentColor
          // as black per SVG spec). Treat currentColor as black so mono
          // icons read consistently. Caller can override per-call via
          // opts.color or by editing the SVG before passing it.
          var isCurrentColor = (styleFill === 'currentColor');
          // SVG spec: a <path> without a fill attribute defaults to BLACK,
          // not the THREE.Color default of white. SVGLoader doesn't apply
          // this default — it leaves path.color at white when fill is
          // unset — so we apply it here. notion.svg has a 2nd path with no
          // fill that should render black; without this branch both paths
          // collapse to white and z-fight.
          var fillExplicit = styleFill !== undefined && styleFill !== null && styleFill !== '';
          if (pickedColor) {
            try { mat.color.set(pickedColor); }
            catch (_) { mat.color.set(palette[i % palette.length]); }
          } else if (isCurrentColor) {
            mat.color.set('#000000');
          } else if (fillExplicit && path.color && path.color.isColor) {
            mat.color.copy(path.color);
          } else if (fillExplicit && styleFill && styleFill !== 'none' && styleFill.charAt(0) !== 'u') {
            try { mat.color.set(styleFill); }
            catch (_) { mat.color.set(palette[i % palette.length]); }
          } else if (!fillExplicit && (!styleStroke || styleStroke === 'none')) {
            // No fill, no stroke — SVG default fill is black.
            mat.color.set('#000000');
          } else if (styleStroke && styleStroke !== 'none' && styleStroke.charAt(0) !== 'u') {
            try { mat.color.set(styleStroke); }
            catch (_) { mat.color.set(palette[i % palette.length]); }
          } else {
            mat.color.set(palette[i % palette.length]);
          }
        }
        if (opts.glow) {
          var gIntensity = typeof opts.glow === 'number' ? opts.glow : 0.7;
          var gColor = opts.glowColor ? new T.Color(opts.glowColor) : mat.color.clone();
          if (mat.emissive) {
            mat.emissive.copy(gColor);
            mat.emissiveIntensity = gIntensity;
          }
        }
        var mesh = new T.Mesh(geo, mat);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        // Painter's-order rendering: multi-color SVG marks (Google G,
        // antigravity, deepmind) layer paths that overlap by several units
        // — not just sub-pixel seams. Z-stagger alone exposes underlying
        // bevel chamfers wherever later paths shrink inward and earlier
        // paths peek through. SVG itself solves this by painting paths in
        // document order and letting later paths fully overwrite prior
        // pixels. Mirror that here:
        //   • renderOrder = i — Three.js renders meshes in this order
        //     within the same scene (no depth-buffer-based z-sort).
        //   • polygonOffsetFactor scales by index — biases depth so later
        //     paths are pulled forward at the rasterizer level. This is
        //     more robust than mesh.position.z because it handles the
        //     bevel slopes too, not just the front face plane.
        // Per-index Z stagger was tried in earlier iterations but always
        // produces visible "step" lines at every color boundary. With diff
        // applied, polygons no longer overlap in 2D so they meet flat at
        // the same Z and Z stagger is unnecessary. polygonOffset alone
        // handles any sub-pixel seam fighting.
        // Combined: later paths visually land on top, even at exact-overlap
        // zones, without visible separation.
        mesh.renderOrder = i;
        // No mesh.position.z stagger: with diff applied, adjacent polygons
        // don't overlap in 2D, so they meet at the same Z and form clean
        // butt joints on the front face. A Z stagger here re-introduces
        // visible STEPS at every color boundary (regression observed in a
        // prior iteration).
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = -i * 2;
        mat.polygonOffsetUnits = -i * 4;
        // Multi-color seam-hide: upper paths skip writing to the depth buffer
        // (mirrors the depthWrite:false trick in three.js examples/webgl_loader_svg.html
        // adapted for opaque rendering). Combined with renderOrder + polygonOffset
        // and the post-diff outer-ring inflation upstream, this stops the lower
        // path's hole-interior side wall from winning sub-pixel pixels at color
        // boundaries during rotation. We deliberately keep transparent:false so
        // the renderer's MSAA stays on the opaque pass — the transparent pass
        // softens silhouette AA in a way that reads as a fuzzy outline on dark/
        // light boundaries (nextjs N regression). The lower path (i==0) keeps
        // depthWrite:true so the floor + scene depth still resolve correctly.
        // Skipped for single-color logos (no seams), opts.glow (emissive
        // shadow casting needs depth), and opts.solidUppers === true (caller
        // opt-out for upper-layer shadows).
        if (_seamColors >= 2 && i > 0 && !opts.glow && opts.solidUppers !== true) {
          mat.depthWrite = false;
        }
        inner.add(mesh);
      }

      function _finalize() {
        // No re-fit here — fit-scale + centering was applied upfront from the
        // prepass bbox, so meshes render at correct size as async batches
        // populate. Re-fitting here would clobber the upfront scale with one
        // computed from the post-bevel bbox (slightly larger), causing a
        // visible "snap" on the last batch.
        //
        // 2D path differencing happens BEFORE extrusion (see entries-rewrite
        // immediately after the entries array is built), so by the time we get
        // here, every mesh's geometry is already non-overlapping in XY.
        //
        // OPT-IN: 3D CSG difference (opts.csg3d=true) runs an additional
        // BSP-tree subtraction pass on the actual extruded meshes. Heavier
        // than 2D but resolves volume-level overlap that 2D can't catch
        // (e.g., bevel chamfers from one path that protrude under an
        // adjacent path). Wrapped so failure falls back to the 2D-only
        // result instead of dropping the build.
        // Skip BSP entirely for multi-color SVGs: the 2D-diff + merge +
        // interior-face-cull pipeline already produces the correct
        // result, and BSP retesselates some meshes (different vertex
        // positions) which breaks the plane-based interior-face pair
        // matching downstream — visible seam stripes return for the
        // BSP-modified path. Empirically (Google G), BSP also rescues
        // 2/4 meshes anyway, so even successful runs add no value.
        if (opts.csg3d === true && _seamColors < 2) {
          try {
            _csg3dDiffMeshes(T, inner.children.slice(), opts);
          } catch (err) {
            console.warn('[dreambyte-studio3d] 3D CSG pass threw; rendering 2D-only result', err);
          }
        } else if (opts.csg3d === true) {
          console.info('[dreambyte-studio3d] 3D CSG skipped: multi-color SVG already handled by 2D diff + interior-face cull pipeline');
        }
        // Multi-color merge pass: collapse per-path meshes into ONE
        // BufferGeometry with vertex colors. Disabled by default now
        // (opt-IN via opts.mergeMultiColor === true): the merge created
        // its own rotation-z-fighting artifacts that proved harder to
        // chase than the V-grooves it was meant to eliminate. With
        // merge OFF, each path stays its own mesh with renderOrder + i
        // and polygonOffsetFactor scaled by index — Three.js's depth
        // test + polygon-offset combo handles draw order across paths
        // robustly, no precision-drift z-fighting between paths during
        // rotation. Trade-off: a slight V-groove can appear at color
        // seams where adjacent paths' bevel chamfers meet, but bevel
        // is auto-disabled for multi-color inputs anyway, so the
        // grooves are minimal.
        if (_seamColors >= 2 && opts.mergeMultiColor === true && !opts.glow && inner.children.length > 1) {
          try {
            _mergeMultiColorMeshes(T, inner);
          } catch (err) {
            console.warn('[dreambyte-studio3d] multi-color merge threw; keeping per-path meshes', err);
          }
        } else if (_seamColors >= 2 && opts.glow) {
          console.info('[dreambyte-studio3d] multi-color merge skipped: opts.glow is set and per-path emissive cannot be preserved across a single merged mesh; per-path meshes kept with V-groove seams');
        }
        if (onReady) onReady(group, paths);
      }

      // Async batching: complex SVGs (50+ paths → 200+ shapes) stall the main
      // thread when built synchronously. Yield every BATCH_SIZE shapes so the
      // first frame paints with what's built so far, the HDRI keeps loading,
      // and meshes pop in incrementally instead of one big freeze. Threshold
      // skips the yield entirely for simple icons (≤20 shapes = no perf risk).
      var BATCH_SIZE = 20;
      if (entries.length <= BATCH_SIZE) {
        for (var i = 0; i < entries.length; i++) _addOneMesh(entries[i], i);
        _finalize();
      } else {
        var idx = 0;
        function _runBatch() {
          if (group.userData && group.userData.__cancelExtrude) {
            if (onReady) onReady(group, paths, new Error('build cancelled by caller'));
            return;
          }
          var end = Math.min(idx + BATCH_SIZE, entries.length);
          for (; idx < end; idx++) _addOneMesh(entries[idx], idx);
          if (idx < entries.length) {
            setTimeout(_runBatch, 0);
          } else {
            _finalize();
          }
        }
        _runBatch();
      }
    }

    if (!w.SVGLoader) {
      console.warn('buildExtrudedSVG: window.SVGLoader not available. Add <script src="/vendor/three-addons-160/SVGLoader.js">');
      if (onReady) onReady(group, [], new Error('SVGLoader missing'));
      return group;
    }

    // Disposal guard: if the caller calls group.userData.__cancelExtrude = true
    // (e.g. on scene unmount), a still-flying fetch won't waste cycles building
    // meshes into a discarded group. The common case — scene.add(group) before
    // the fetch resolves — is unaffected because parent state isn't checked.
    fetch(svgUrl)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        if (group.userData && group.userData.__cancelExtrude) {
          if (onReady) onReady(group, [], new Error('build cancelled by caller'));
          return;
        }
        // Flatten gradient defs to first-stop colors so paths painted with
        // url(#id) resolve to a real color instead of falling through to
        // palette[i].
        gradientMap = _extractGradients(text, gradientAlphaMap);
        // Parse the SVG's viewBox so buildFromPaths can drop full-bg <rect>
        // artifacts that Figma/Illustrator emit. viewBox="minX minY w h"; falls
        // back to width/height attrs; null disables the filter entirely.
        var vb = null;
        var vbm = text.match(/viewBox\s*=\s*["']([^"']+)["']/i);
        if (vbm) {
          var parts = vbm[1].trim().split(/[\s,]+/).map(parseFloat);
          if (parts.length === 4 && parts.every(isFinite)) {
            vb = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
          }
        }
        if (!vb) {
          var wm = text.match(/<svg[^>]*\bwidth\s*=\s*["']([\d.]+)/i);
          var hm = text.match(/<svg[^>]*\bheight\s*=\s*["']([\d.]+)/i);
          if (wm && hm) vb = { x: 0, y: 0, w: parseFloat(wm[1]), h: parseFloat(hm[1]) };
        }
        var data = new w.SVGLoader().parse(text);
        // Wait for vendor libraries to be available before building meshes:
        //   • polygon-clipping (always needed — 2D diff is opt-out default)
        //   • three-csg-ts (only needed when opts.csg3d=true)
        // Both are cached after first load so subsequent SVGs don't pay the
        // cost. Awaiting only when opts.csg3d=true avoids paying the CSG
        // load latency on every scene.
        var pre = _ensurePolygonClipping();
        if (opts.csg3d === true) pre = pre.then(_ensureCSG3D);
        return pre.then(function () {
          buildFromPaths(data.paths, vb);
        });
      })
      .catch(function (e) {
        console.warn('buildExtrudedSVG: failed to load ' + svgUrl, e);
        if (onReady) onReady(group, [], e);
      });

    return group;
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // StudioCamera — keyframe + easing camera system
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Declarative camera controller.
   *
   * Design inspired by Sketchbook (spring-based smooth motion) and
   * animation timelines (explicit keyframe t values).
   *
   * All methods accept an optional `cam` override; if omitted they use
   * the camera bound via setCamera().
   */
  w.StudioCamera = (function () {
    var _cam = null;
    var _tmpA = null, _tmpB = null; // reused Vector3 objects
    var _splineCache = null; // [posPoints, targetPoints, posCurve, tgtCurve]

    function ensureVecs(T) {
      if (!_tmpA) { _tmpA = new T.Vector3(); _tmpB = new T.Vector3(); }
    }

    return {

      /** Bind a camera. Call once in ThreeJSLayer setup. */
      setCamera: function (cam) { _cam = cam; return this; },

      /** Instantly park camera at position, looking at target. */
      park: function (pos, lookAt, cam) {
        var c = cam || _cam; if (!c) return;
        c.position.set(pos[0], pos[1], pos[2]);
        c.lookAt(lookAt[0], lookAt[1], lookAt[2]);
      },

      /**
       * Timeline-driven keyframe camera.
       *
       * keyframes: Array of { t, pos: [x,y,z], lookAt: [x,y,z], ease? }
       *   t        — scene time in seconds at which this state is "reached"
       *   pos      — camera world position
       *   lookAt   — world point the camera aims at
       *   ease     — easing applied to the TRANSITION INTO this keyframe
       *              ('linear' | 'smooth' | 'expo.out' | 'spring' | 'bounce')
       *              Default: 'expo.out'
       *
       * Example:
       *   StudioCamera.follow(t, [
       *     { t: 0,  pos: [0, 3, 12], lookAt: [0, 0, 0] },
       *     { t: 4,  pos: [0, 3, 12], lookAt: [0, 0, 0] },              // hold
       *     { t: 6,  pos: [20, 3, 12], lookAt: [20, 0, 0], ease: 'expo.out' }, // move
       *     { t: 12, pos: [20, 3, 12], lookAt: [20, 0, 0] },
       *   ], camera)
       */
      follow: function (t, keyframes, cam) {
        var c = cam || _cam; if (!c || !keyframes || !keyframes.length) return;
        var kf = keyframes;

        // Before first KF
        if (t <= kf[0].t) {
          c.position.set(kf[0].pos[0], kf[0].pos[1], kf[0].pos[2]);
          c.lookAt(kf[0].lookAt[0], kf[0].lookAt[1], kf[0].lookAt[2]);
          return;
        }
        // After last KF
        var last = kf[kf.length - 1];
        if (t >= last.t) {
          c.position.set(last.pos[0], last.pos[1], last.pos[2]);
          c.lookAt(last.lookAt[0], last.lookAt[1], last.lookAt[2]);
          return;
        }

        // Find surrounding interval
        var from = kf[0], to = kf[1];
        for (var i = 0; i < kf.length - 1; i++) {
          if (t >= kf[i].t && t < kf[i + 1].t) { from = kf[i]; to = kf[i + 1]; break; }
        }

        // Normalize [0,1] within interval and apply easing
        var dur = to.t - from.t;
        var raw = dur > 0 ? (t - from.t) / dur : 0;
        var p   = applyEasing(raw, to.ease || 'expo.out');

        // Interpolate position
        c.position.set(
          lerp(from.pos[0], to.pos[0], p),
          lerp(from.pos[1], to.pos[1], p),
          lerp(from.pos[2], to.pos[2], p)
        );

        // Interpolate lookAt target (lerp the target point, not the direction)
        c.lookAt(
          lerp(from.lookAt[0], to.lookAt[0], p),
          lerp(from.lookAt[1], to.lookAt[1], p),
          lerp(from.lookAt[2], to.lookAt[2], p)
        );
      },

      /**
       * Circular orbit around a point.
       *
       * opts: { center, radius, height, speed, offset }
       *   center  [x, y, z]   orbit center  (default [0,0,0])
       *   radius  number       orbit radius  (default 10)
       *   height  number       camera height (default 4)
       *   speed   number       rad/s         (default 0.25)
       *   offset  number       start angle   (default 0)
       */
      orbit: function (t, opts, cam) {
        var c = cam || _cam; if (!c) return;
        opts = opts || {};
        var cx = (opts.center || [0,0,0])[0];
        var cy = (opts.center || [0,0,0])[1];
        var cz = (opts.center || [0,0,0])[2];
        var r  = opts.radius !== undefined ? opts.radius : 10;
        var h  = opts.height !== undefined ? opts.height : 4;
        var sp = opts.speed  !== undefined ? opts.speed  : 0.25;
        var off= opts.offset !== undefined ? opts.offset : 0;
        c.position.set(
          cx + Math.cos(t * sp + off) * r,
          cy + h,
          cz + Math.sin(t * sp + off) * r
        );
        c.lookAt(cx, cy, cz);
      },

      /**
       * Smooth dolly toward or away from a target.
       *
       * opts: { target, startDist, endDist, height, angle }
       *   target    [x, y, z]  (default [0,0,0])
       *   startDist              (default 18)
       *   endDist                (default 6)
       *   height                 (default 3)
       *   angle     radians      horizontal angle from front (default 0)
       */
      dolly: function (t, duration, opts, cam) {
        var c = cam || _cam; if (!c) return;
        opts = opts || {};
        var tx = (opts.target || [0,0,0])[0];
        var ty = (opts.target || [0,0,0])[1];
        var tz = (opts.target || [0,0,0])[2];
        var s  = opts.startDist !== undefined ? opts.startDist : 18;
        var e  = opts.endDist   !== undefined ? opts.endDist   : 6;
        var h  = opts.height    !== undefined ? opts.height    : 3;
        var a  = opts.angle     !== undefined ? opts.angle     : 0;
        var p  = applyEasing(clamp(t / (duration || 4), 0, 1), 'expo.out');
        var d  = lerp(s, e, p);
        c.position.set(tx + Math.sin(a) * d, ty + h, tz + Math.cos(a) * d);
        c.lookAt(tx, ty, tz);
      },

      /**
       * Crane — vertical rise while looking at a target.
       *
       * opts: { target, startY, endY, dist, duration }
       */
      crane: function (t, opts, cam) {
        var c = cam || _cam; if (!c) return;
        opts = opts || {};
        var tx = (opts.target || [0,0,0])[0];
        var ty = (opts.target || [0,0,0])[1];
        var tz = (opts.target || [0,0,0])[2];
        var sy = opts.startY !== undefined ? opts.startY : 2;
        var ey = opts.endY   !== undefined ? opts.endY   : 12;
        var d  = opts.dist   !== undefined ? opts.dist   : 10;
        var p  = applyEasing(clamp(t / (opts.duration || 6), 0, 1), 'smooth');
        c.position.set(tx + d * 0.3, lerp(sy, ey, p), tz + d);
        c.lookAt(tx, ty, tz);
      },

      /**
       * Rack focus — animate camera FOV (dolly-zoom / Hitchcock effect).
       * Call every frame while the effect should be active.
       *
       * fromFOV default 60, toFOV default 35
       */
      rackFocus: function (t, duration, cam, fromFOV, toFOV) {
        var c = cam || _cam; if (!c) return;
        var p = applyEasing(clamp(t / (duration || 2), 0, 1), 'smooth');
        c.fov = lerp(fromFOV !== undefined ? fromFOV : 60, toFOV !== undefined ? toFOV : 35, p);
        c.updateProjectionMatrix();
      },

      /**
       * Spiraling approach — orbit + dolly combined, great for hero reveals.
       *
       * opts: { center, startRadius, endRadius, startHeight, endHeight, speed, duration }
       */
      spiralApproach: function (t, opts, cam) {
        var c = cam || _cam; if (!c) return;
        opts = opts || {};
        var cx  = (opts.center || [0,0,0])[0];
        var cy  = (opts.center || [0,0,0])[1];
        var cz  = (opts.center || [0,0,0])[2];
        var sr  = opts.startRadius !== undefined ? opts.startRadius : 15;
        var er  = opts.endRadius   !== undefined ? opts.endRadius   : 6;
        var sh  = opts.startHeight !== undefined ? opts.startHeight : 8;
        var eh  = opts.endHeight   !== undefined ? opts.endHeight   : 3;
        var sp  = opts.speed       !== undefined ? opts.speed       : 0.4;
        var dur = opts.duration || 5;
        var p   = applyEasing(clamp(t / dur, 0, 1), 'expo.out');
        var r   = lerp(sr, er, p);
        var h   = lerp(sh, eh, p);
        c.position.set(cx + Math.cos(t * sp) * r, cy + h, cz + Math.sin(t * sp) * r);
        c.lookAt(cx, cy, cz);
      },

      /**
       * followCC — Keyframe camera path using camera-controls lerpLookAt.
       * Provides spherical arc interpolation between keyframes — avoids the
       * linear tunneling through geometry that StudioCamera.follow() can exhibit.
       *
       * keyframes: [{ t, pos:[x,y,z], target:[x,y,z] }, ...]  sorted ascending by t
       * controls:  CameraControls instance from buildCameraControls()
       *
       * Scrub-safe: enableTransition=false is always passed.
       */
      followCC: function (t, keyframes, controls) {
        if (!controls || !keyframes || keyframes.length < 2) return;
        var kf = keyframes;
        var first = kf[0], last = kf[kf.length - 1];
        if (t <= first.t) {
          controls.setLookAt(first.pos[0], first.pos[1], first.pos[2],
                             first.target[0], first.target[1], first.target[2], false);
          controls.update(0); return;
        }
        if (t >= last.t) {
          controls.setLookAt(last.pos[0], last.pos[1], last.pos[2],
                             last.target[0], last.target[1], last.target[2], false);
          controls.update(0); return;
        }
        for (var i = 0; i < kf.length - 1; i++) {
          var a = kf[i], b = kf[i + 1];
          if (t >= a.t && t < b.t) {
            var seg = (t - a.t) / (b.t - a.t);
            controls.lerpLookAt(
              a.pos[0], a.pos[1], a.pos[2], a.target[0], a.target[1], a.target[2],
              b.pos[0], b.pos[1], b.pos[2], b.target[0], b.target[1], b.target[2],
              seg, false
            );
            controls.update(0); return;
          }
        }
      },

      /**
       * pathSpline — Catmull-Rom smooth camera spline path.
       * Position and target each follow their own curve, giving film-quality
       * curved tracking shots. Spline is cached on posPoints identity.
       *
       * posPoints:    [[x,y,z], ...]  camera positions along the path (min 2)
       * targetPoints: [[x,y,z], ...]  look-at targets (same length as posPoints)
       * duration:     total seconds for the full path
       * cam:          optional camera override
       */
      pathSpline: function (t, posPoints, targetPoints, duration, cam) {
        var c = cam || _cam; if (!c || !posPoints || posPoints.length < 2) return;
        var T3 = window.THREE; if (!T3) return;
        if (!_splineCache || _splineCache[0] !== posPoints || _splineCache[1] !== targetPoints) {
          _splineCache = [
            posPoints, targetPoints,
            new T3.CatmullRomCurve3(posPoints.map(function (p) { return new T3.Vector3(p[0], p[1], p[2]); })),
            new T3.CatmullRomCurve3(targetPoints.map(function (p) { return new T3.Vector3(p[0], p[1], p[2]); }))
          ];
        }
        var u = clamp(t / (duration || 8), 0, 1);
        var pos = _splineCache[2].getPoint(u);
        var tgt = _splineCache[3].getPoint(u);
        c.position.copy(pos);
        c.lookAt(tgt.x, tgt.y, tgt.z);
      },

      /**
       * controlsOrbit — Gimbal-lock-free spherical orbit via camera-controls.
       * Uses rotateTo() for clean spherical rotation (no lookAt drift over time).
       *
       * opts:
       *   azimuthStart  (rad)  horizontal start  default 0
       *   azimuthEnd    (rad)  horizontal end    default Math.PI * 2  (full orbit)
       *   polarAngle    (rad)  vertical angle    default Math.PI / 3  (60°)
       *   duration      (s)                      default 8
       *   easing        string                   default 'linear'
       *
       * controls: CameraControls instance from buildCameraControls()
       */
      controlsOrbit: function (t, opts, controls) {
        if (!controls) return;
        opts = opts || {};
        var az0 = opts.azimuthStart !== undefined ? opts.azimuthStart : 0;
        var az1 = opts.azimuthEnd   !== undefined ? opts.azimuthEnd   : Math.PI * 2;
        var pol = opts.polarAngle   !== undefined ? opts.polarAngle   : Math.PI / 3;
        var dur = opts.duration     !== undefined ? opts.duration     : 8;
        var eas = opts.easing       || 'linear';
        var p   = applyEasing(clamp(t / dur, 0, 1), eas);
        controls.rotateTo(lerp(az0, az1, p), pol, false);
        controls.update(0);
      },

      /**
       * dollyZoom — Vertigo / Hitchcock effect.
       * Camera physically moves toward/away from subject while FOV changes in the
       * opposite direction, keeping the subject the same apparent size while the
       * background dramatically expands or compresses.
       *
       * opts: { target, startDist, endDist, startFOV, endFOV, height, angle, duration, easing }
       *   angle (rad) — camera approach direction from Z axis, default 0
       */
      dollyZoom: function (t, opts, cam) {
        var c = cam || _cam; if (!c) return;
        opts = opts || {};
        var tx  = (opts.target || [0,0,0])[0];
        var ty  = (opts.target || [0,0,0])[1];
        var tz  = (opts.target || [0,0,0])[2];
        var sd  = opts.startDist !== undefined ? opts.startDist : 6;
        var ed  = opts.endDist   !== undefined ? opts.endDist   : 18;
        var sf  = opts.startFOV  !== undefined ? opts.startFOV  : 35;
        var ef  = opts.endFOV    !== undefined ? opts.endFOV    : 70;
        var h   = opts.height    !== undefined ? opts.height    : 2;
        var ang = opts.angle     !== undefined ? opts.angle     : 0;
        var dur = opts.duration  !== undefined ? opts.duration  : 6;
        var eas = opts.easing    || 'smooth';
        var p   = applyEasing(clamp(t / dur, 0, 1), eas);
        var d   = lerp(sd, ed, p);
        c.position.set(tx + Math.sin(ang) * d, ty + h, tz + Math.cos(ang) * d);
        c.fov = lerp(sf, ef, p);
        c.lookAt(tx, ty, tz);
        c.updateProjectionMatrix();
      },

      /**
       * craneShot — Physical crane arm sweep through azimuth + elevation.
       * Simultaneously sweeps both horizontal and vertical spherical angles,
       * simulating a crane arm with a rotating head. More dramatic than
       * a pure dolly or orbit because both axes move at once.
       *
       * opts: { target, radius, azimuthStart, azimuthEnd, elevationStart, elevationEnd, duration, easing }
       *   All angles in radians.
       */
      craneShot: function (t, opts, cam) {
        var c = cam || _cam; if (!c) return;
        opts = opts || {};
        var tx  = (opts.target       || [0,0,0])[0];
        var ty  = (opts.target       || [0,0,0])[1];
        var tz  = (opts.target       || [0,0,0])[2];
        var r   = opts.radius         !== undefined ? opts.radius         : 12;
        var az0 = opts.azimuthStart   !== undefined ? opts.azimuthStart   : -Math.PI / 4;
        var az1 = opts.azimuthEnd     !== undefined ? opts.azimuthEnd     : Math.PI / 4;
        var el0 = opts.elevationStart !== undefined ? opts.elevationStart : 0.1;
        var el1 = opts.elevationEnd   !== undefined ? opts.elevationEnd   : Math.PI / 3;
        var dur = opts.duration       !== undefined ? opts.duration       : 6;
        var eas = opts.easing         || 'expo.out';
        var p   = applyEasing(clamp(t / dur, 0, 1), eas);
        var az  = lerp(az0, az1, p);
        var el  = lerp(el0, el1, p);
        c.position.set(
          tx + r * Math.cos(el) * Math.sin(az),
          ty + r * Math.sin(el),
          tz + r * Math.cos(el) * Math.cos(az)
        );
        c.lookAt(tx, ty, tz);
      },

      /**
       * shake(t, opts, cam?) — procedural camera shake. Call every frame to apply.
       * Deterministic from t — scrub-safe.
       *
       * opts:
       *   intensity  number  max position offset in world units  default 0.1
       *   frequency  number  shake oscillations per second        default 15
       *   decay      number  seconds over which shake fades       default 0 (no decay)
       *   startT     number  scene time when shake begins         default 0
       *   seed       number  RNG seed                             default 1
       *   rotational bool    also apply slight rotational shake   default true
       */
      shake: function(t, opts, cam) {
        var c = cam || _cam; if (!c) return;
        opts = opts || {};
        var intensity = opts.intensity !== undefined ? opts.intensity : 0.1;
        var freq      = opts.frequency !== undefined ? opts.frequency : 15;
        var decay     = opts.decay     !== undefined ? opts.decay     : 0;
        var startT    = opts.startT    !== undefined ? opts.startT    : 0;
        var seed      = opts.seed      !== undefined ? opts.seed      : 1;
        var rotational = opts.rotational !== false;
        var dt = Math.max(0, t - startT);
        var amp = intensity * (decay > 0 ? Math.max(0, 1 - dt / decay) : 1);
        if (amp < 0.00001) return;
        var nx = Math.sin(dt * freq * 2.14 + seed * 1.37) * Math.cos(dt * freq * 1.31 + seed * 2.73);
        var ny = Math.sin(dt * freq * 1.73 + seed * 1.91) * Math.cos(dt * freq * 2.43 + seed * 0.53);
        var nz = Math.sin(dt * freq * 2.87 + seed * 3.13) * Math.cos(dt * freq * 1.19 + seed * 1.31);
        c.position.x += nx * amp;
        c.position.y += ny * amp * 0.6;
        c.position.z += nz * amp * 0.3;
        if (rotational) {
          c.rotation.z += nx * amp * 0.015;
          c.rotation.x += ny * amp * 0.010;
        }
      },
    };
  }());


  // ─────────────────────────────────────────────────────────────────────────────
  // makeStudioSet — After Effects-style "set" group
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Creates a THREE.Group positioned at offsetPos.
   * All content added to this set is positioned relative to offsetPos,
   * enabling multiple independent "sets" in one Three.js scene — just like
   * having multiple compositions in After Effects at different world positions.
   *
   * Camera can then move between sets using StudioCamera.follow() keyframes.
   *
   * @param T          window.THREE
   * @param scene      THREE.Scene to add the group to
   * @param offsetPos  [x, y, z] world position of this set (default [0,0,0])
   *
   * Returns THREE.Group with extra helpers:
   *   .addText(text, opts)   → mesh  (uses buildText3D, position is local)
   *   .addMesh(mesh, pos?)   → this  (adds mesh, optionally setting local position)
   *   .cameraPos(dist?, h?)  → [x,y,z]  world camera position to face this set
   *   .lookAtPoint()         → [x,y,z]  world center of this set
   */
  w.makeStudioSet = function (T, scene, offsetPos) {
    var offset = offsetPos || [0, 0, 0];
    var group = new T.Group();
    group.position.set(offset[0], offset[1], offset[2]);
    if (scene) scene.add(group);

    group.addText = function (text, opts) {
      var mesh = w.buildText3D(T, text, opts);
      group.add(mesh);
      return mesh;
    };

    group.addMesh = function (mesh, pos) {
      if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
      group.add(mesh);
      return group;
    };

    group.cameraPos = function (dist, height) {
      dist   = dist   !== undefined ? dist   : 12;
      height = height !== undefined ? height : 3;
      return [offset[0], offset[1] + height, offset[2] + dist];
    };

    group.lookAtPoint = function () {
      return [offset[0], offset[1], offset[2]];
    };

    return group;
  };

  /**
   * buildGrass(THREE, scene, opts?) → { mesh, update(time) }
   *
   * Circular grass patch. Looks infinite when the camera is close.
   *
   * opts:
   *   radius     (number)  - patch radius in world units. default 25
   *   count      (number)  - blade count.                 default 80000
   *   color      (string)  - base grass color hex.        default '#3a7d2c'
   *   bladeH     (number)  - blade height.                default 0.8
   *   bladeHVar  (number)  - blade height variation.      default 0.6
   *   windSpeed  (number)  - sway speed multiplier.       default 1.0
   *   y          (number)  - world Y position.            default 0
   */
  w.buildGrass = function (T, scene, opts) {
    opts = opts || {};
    var radius    = opts.radius    !== undefined ? opts.radius    : 25;
    var count     = opts.count     !== undefined ? opts.count     : 80000;
    var color     = opts.color     !== undefined ? opts.color     : '#3a7d2c';
    var bladeH    = opts.bladeH    !== undefined ? opts.bladeH    : 0.8;
    var bladeHVar = opts.bladeHVar !== undefined ? opts.bladeHVar : 0.6;
    var windSpeed = opts.windSpeed !== undefined ? opts.windSpeed : 1.0;
    var posY      = opts.y         !== undefined ? opts.y         : 0;

    var BLADE_WIDTH        = 0.1;
    var BLADE_VERTEX_COUNT = 5;
    var BLADE_TIP_OFFSET   = 0.1;

    function lerp(val, oldMin, oldMax, newMin, newMax) {
      return ((val - oldMin) * (newMax - newMin)) / (oldMax - oldMin) + newMin;
    }

    var seed = opts.seed !== undefined ? opts.seed : 42;
    var _rng = mulberry32(seed);

    function computeBlade(center, index) {
      var height   = bladeH + _rng() * bladeHVar;
      var vIndex   = index * BLADE_VERTEX_COUNT;
      var yaw      = _rng() * Math.PI * 2;
      var yawVec   = [Math.sin(yaw), 0, -Math.cos(yaw)];
      var bend     = _rng() * Math.PI * 2;
      var bendVec  = [Math.sin(bend), 0, -Math.cos(bend)];
      var bl = yawVec.map(function (n, i) { return n * (BLADE_WIDTH / 2)  + center[i]; });
      var br = yawVec.map(function (n, i) { return n * (BLADE_WIDTH / 2) * -1 + center[i]; });
      var tl = yawVec.map(function (n, i) { return n * (BLADE_WIDTH / 4)  + center[i]; });
      var tr = yawVec.map(function (n, i) { return n * (BLADE_WIDTH / 4) * -1 + center[i]; });
      var tc = bendVec.map(function (n, i) { return n * BLADE_TIP_OFFSET  + center[i]; });
      tl[1] += height / 2;
      tr[1] += height / 2;
      tc[1] += height;
      return {
        positions: [].concat(bl, br, tr, tl, tc),
        indices: [vIndex, vIndex+1, vIndex+2, vIndex+2, vIndex+4, vIndex+3, vIndex+3, vIndex, vIndex+2]
      };
    }

    var positions = [], uvs = [], indices = [];
    var surfaceMin = -radius, surfaceMax = radius;
    for (var i = 0; i < count; i++) {
      var r     = radius * _rng();
      var theta = _rng() * 2 * Math.PI;
      var x     = r * Math.cos(theta);
      var z     = r * Math.sin(theta);
      for (var v = 0; v < BLADE_VERTEX_COUNT; v++) {
        uvs.push(
          lerp(x, surfaceMin, surfaceMax, 0, 1),
          lerp(z, surfaceMin, surfaceMax, 0, 1)
        );
      }
      var blade = computeBlade([x, 0, z], i);
      positions.push.apply(positions, blade.positions);
      indices.push.apply(indices, blade.indices);
    }

    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('uv',       new T.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    var rgb = (function hexToRgb(hex) {
      var r = parseInt(hex.slice(1,3),16)/255;
      var g = parseInt(hex.slice(3,5),16)/255;
      var b = parseInt(hex.slice(5,7),16)/255;
      return [r,g,b];
    })(color.replace(/^#?/, '#').slice(0,7));

    var mat = new T.ShaderMaterial({
      uniforms: {
        uTime:   { value: 0 },
        uColor:  { value: new T.Vector3(rgb[0], rgb[1], rgb[2]) },
        uWind:   { value: windSpeed },
      },
      side: T.DoubleSide,
      vertexShader: `
        uniform float uTime;
        uniform float uWind;
        varying vec3 vPosition;
        varying vec2 vUv;
        varying vec3 vNormal;
        float wave(float waveSize, float yPos) {
          return sin((uTime * uWind / 500.0) + waveSize) * max(0.0, yPos) * 0.35;
        }
        void main() {
          vPosition = position;
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vPosition.x += wave(uv.x * 10.0, vPosition.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(vPosition, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying vec3 vPosition;
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
          vec3 dark  = uColor * 0.55;
          vec3 light = uColor * 1.15;
          vec3 col   = mix(dark, light, clamp(vPosition.y * 1.4, 0.0, 1.0));
          float lighting = normalize(dot(vNormal, vec3(10.0)));
          gl_FragColor = vec4(col + lighting * 0.04, 1.0);
        }`,
    });

    var mesh = new T.Mesh(geo, mat);
    mesh.position.y = posY;

    var floor = new T.Mesh(
      new T.CircleGeometry(radius, 16).rotateX(-Math.PI / 2),
      mat
    );
    floor.position.y = -0.001;
    mesh.add(floor);

    if (scene) scene.add(mesh);

    return {
      mesh: mesh,
      update: function (time) {
        mat.uniforms.uTime.value = time;
      },
      dispose: function() { mesh.geometry.dispose(); mat.dispose(); if (scene) scene.remove(mesh); },
    };
  };

  /**
   * buildOcean(THREE, scene, opts?) → { water, update() }
   *
   * Full reflective ocean using Three.js Water shader.
   * Requires: Water.js loaded before dreambyte-studio3d.js → window.THREEWater
   *
   * opts:
   *   size           (number)  - plane size in world units.   default 10000
   *   waterColor     (hex)     - water tint.                  default '#001e0f'
   *   sunColor       (hex)     - specular sun color.          default '#ffffff'
   *   distortionScale(number)  - wave choppiness.             default 3.7
   *   sunDirection   ([x,y,z]) - sun vector.                  default [0.5,1,0.5]
   *   y              (number)  - world Y position.            default 0
   */
  w.buildOcean = function (T, scene, opts) {
    opts = opts || {};
    var size           = opts.size           !== undefined ? opts.size           : 10000;
    var waterColor     = opts.waterColor     !== undefined ? opts.waterColor     : '#001e0f';
    var sunColor       = opts.sunColor       !== undefined ? opts.sunColor       : '#ffffff';
    var distortionScale= opts.distortionScale!== undefined ? opts.distortionScale: 3.7;
    var sunDir         = opts.sunDirection   !== undefined ? opts.sunDirection   : [0.5, 1.0, 0.5];
    var posY           = opts.y              !== undefined ? opts.y              : 0;

    if (!window.THREEWater) {
      console.warn('buildOcean: THREEWater not found. Load /vendor/three-addons-160/Water.js before dreambyte-studio3d.js');
      return null;
    }

    var normals = new T.TextureLoader().load('/vendor/waternormals.jpg', function (tex) {
      tex.wrapS = tex.wrapT = T.RepeatWrapping;
    });

    var waterGeo = new T.PlaneGeometry(size, size);
    var water = new window.THREEWater(waterGeo, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: normals,
      sunDirection: new T.Vector3(sunDir[0], sunDir[1], sunDir[2]).normalize(),
      sunColor: sunColor,
      waterColor: waterColor,
      distortionScale: distortionScale,
      fog: false,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = posY;
    if (scene) scene.add(water);

    return {
      water: water,
      // t is scene time in seconds — scrub-safe direct assignment
      update: function (t) {
        water.material.uniforms['time'].value = t !== undefined ? t : (water.material.uniforms['time'].value + 1.0 / 60.0);
      },
      dispose: function() { waterGeo.dispose(); if (scene) scene.remove(water); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Removed: buildAvatar3D / buildTalkingAvatar3D / buildAvatarStage / preloadAnimations
  // ─────────────────────────────────────────────────────────────────────────────
  // The in-scene 3D avatar helpers and their remote sample models/animation clips
  // were removed. Saved scenes that still call them get an empty group (with a
  // no-op seek) plus a console warning, so the rest of the scene keeps rendering.
  var REMOVED_AVATAR_MSG = 'This avatar used a removed local avatar model';
  function _removedAvatarGroup(T) {
    console.warn('[dreambyte] ' + REMOVED_AVATAR_MSG);
    var g = T && T.Group ? new T.Group() : null;
    if (g) g.userData.seek = function () {};
    return g;
  }
  w.buildAvatar3D = function (T) { return Promise.resolve(_removedAvatarGroup(T)); };
  w.buildTalkingAvatar3D = w.buildAvatar3D;
  w.buildAvatarStage = function (T, scene) {
    var avatar = _removedAvatarGroup(T);
    if (avatar && scene && scene.add) scene.add(avatar);
    return Promise.resolve({ avatar: avatar, studio: null });
  };
  w.preloadAnimations = function () { return Promise.resolve(); };

  // ─────────────────────────────────────────────────────────────────────────────
  // CAMERA-CONTROLS INTEGRATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildCameraControls(camera, renderer, opts?) → CameraControls | null
   *
   * Creates a camera-controls instance wrapping the ThreeJSLayer camera.
   * Requires /vendor/camera-controls.min.js loaded before dreambyte-studio3d.js.
   *
   * opts:
   *   interactive  boolean   enable mouse/touch drag (default false — video mode)
   *   smoothTime   number    damping time in seconds (default 0.25)
   *   minDistance  number    min dolly distance
   *   maxDistance  number    max dolly distance
   *
   * Usage in ThreeJSLayer setup:
   *   const controls = buildCameraControls(camera, renderer)
   *   StudioCamera.fitTo(myMesh, {}, controls)   // auto-frame myMesh
   *
   * Usage in ThreeJSLayer update (interactive preview only):
   *   controls.update(1 / config.fps)
   *   // NOTE: update() uses internal spring state — NOT scrub-safe.
   *   // For exported video, use StudioCamera.follow() instead.
   */
  w.buildCameraControls = function(camera, renderer, opts) {
    if (!w.CameraControls) {
      console.warn('[Studio3D] camera-controls not loaded — /vendor/camera-controls.min.js must come before dreambyte-studio3d.js');
      return null;
    }
    opts = opts || {};
    // CameraControls.install() is called once in the template's inline script.
    // If it hasn't run yet (e.g. standalone scene), call it here.
    try { w.CameraControls.install({ THREE: window.THREE }); } catch(_e) {}

    var controls = new w.CameraControls(camera, opts.domElement || renderer.domElement);
    controls.enabled = opts.interactive || false;
    controls.smoothTime = opts.smoothTime !== undefined ? opts.smoothTime : 0.25;
    controls.draggingSmoothTime = opts.draggingSmoothTime !== undefined ? opts.draggingSmoothTime : 0.125;
    if (opts.minDistance !== undefined) controls.minDistance = opts.minDistance;
    if (opts.maxDistance !== undefined) controls.maxDistance = opts.maxDistance;
    if (opts.minPolarAngle !== undefined) controls.minPolarAngle = opts.minPolarAngle;
    if (opts.maxPolarAngle !== undefined) controls.maxPolarAngle = opts.maxPolarAngle;
    return controls;
  };

  /**
   * StudioCamera.fitTo(targetOrMesh, opts?, controls?) → { position, target }
   *
   * Auto-frames a mesh or Box3 using camera-controls geometry math.
   * If controls is provided, applies the position instantly (enableTransition=false — scrub-safe).
   * Always returns the ideal { position:[x,y,z], target:[x,y,z] } for manual use.
   *
   * opts:
   *   padding    number    extra world-unit clearance around the object (default 2.5)
   *   direction  [x,y,z]  view direction vector (default slightly above front: [0,0.3,1])
   *   fov        number    assume this FOV for distance math (default camera.fov or 50)
   */
  w.StudioCamera.fitTo = function(targetOrMesh, opts, controls) {
    opts = opts || {};
    var T = window.THREE;
    if (!T) return null;

    // Get bounding box
    var box = new T.Box3();
    if (targetOrMesh && targetOrMesh.isBox3) {
      box.copy(targetOrMesh);
    } else if (targetOrMesh && (targetOrMesh.isMesh || targetOrMesh.isGroup || targetOrMesh.isObject3D)) {
      box.setFromObject(targetOrMesh);
    } else {
      console.warn('StudioCamera.fitTo: pass a Mesh, Group, or Box3');
      return null;
    }

    var center = new T.Vector3();
    var size   = new T.Vector3();
    box.getCenter(center);
    box.getSize(size);

    var padding = opts.padding !== undefined ? opts.padding : 2.5;
    var maxDim  = Math.max(size.x, size.y, size.z);
    var fov     = opts.fov || 50;
    var dist    = (maxDim * 0.5 + padding) / Math.tan((fov * 0.5) * Math.PI / 180);

    var dir = opts.direction ? new T.Vector3(opts.direction[0], opts.direction[1], opts.direction[2]).normalize()
                             : new T.Vector3(0, 0.3, 1).normalize();
    var pos = center.clone().addScaledVector(dir, dist);

    if (controls && typeof controls.setLookAt === 'function') {
      controls.setLookAt(pos.x, pos.y, pos.z, center.x, center.y, center.z, false);
      controls.update(0);
    }

    return {
      position: [pos.x, pos.y, pos.z],
      target:   [center.x, center.y, center.z],
    };
  };

  /**
   * StudioCamera.autoFrame(meshOrBox, camera, opts?) — instantly positions camera
   * to frame an object. Simpler than fitTo — no controls instance needed.
   *
   * opts: { padding, direction, fov }
   */
  w.StudioCamera.autoFrame = function(meshOrBox, camera, opts) {
    var result = w.StudioCamera.fitTo(meshOrBox, opts, null);
    if (!result || !camera) return;
    camera.position.set(result.position[0], result.position[1], result.position[2]);
    camera.lookAt(result.target[0], result.target[1], result.target[2]);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // PARTICLE SYSTEMS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildParticleField(THREE, scene, opts?) → { mesh, update(t), setColor(c), setOpacity(v) }
   *
   * Ambient floating particle cloud. Deterministic at time t — fully scrub-safe.
   *
   * opts:
   *   count    number    particle count (default 400)
   *   bounds   number    volume half-extent in world units (default 18)
   *   size     number    point size in world units (default 0.06)
   *   color    hex       particle color (default '#ffffff')
   *   opacity  number    0-1 (default 0.45)
   *   drift    number    max drift amplitude per axis (default 0.8)
   *   seed     number    RNG seed for deterministic layout (default 42)
   *
   * Call update(t) inside ThreeJSLayer update callback:
   *   const field = buildParticleField(THREE, scene, { color: PALETTE[2] })
   *   // in update: field.update(t)
   */
  w.buildParticleField = function(T, scene, opts) {
    opts = opts || {};
    var count   = opts.count   !== undefined ? opts.count   : 400;
    var bounds  = opts.bounds  !== undefined ? opts.bounds  : 18;
    var size    = opts.size    !== undefined ? opts.size    : 0.06;
    var color   = opts.color   || '#ffffff';
    var opacity = opts.opacity !== undefined ? opts.opacity : 0.45;
    var drift   = opts.drift   !== undefined ? opts.drift   : 0.8;
    var seed    = opts.seed    || 42;

    var positions = new Float32Array(count * 3);
    var basePos   = new Float32Array(count * 3);
    var seeds     = new Float32Array(count * 3);

    for (var i = 0; i < count; i++) {
      var rng = mulberry32(i * 1337 + seed);
      var bx = (rng() - 0.5) * bounds * 2;
      var by = (rng() - 0.5) * bounds * 2;
      var bz = (rng() - 0.5) * bounds * 2;
      basePos[i * 3]     = positions[i * 3]     = bx;
      basePos[i * 3 + 1] = positions[i * 3 + 1] = by;
      basePos[i * 3 + 2] = positions[i * 3 + 2] = bz;
      seeds[i * 3]     = rng() * 6.28318;
      seeds[i * 3 + 1] = rng() * 6.28318;
      seeds[i * 3 + 2] = rng() * 6.28318;
    }

    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(positions, 3));

    var mat = new T.PointsMaterial({
      color: new T.Color(color),
      size: size,
      transparent: true,
      opacity: opacity,
      sizeAttenuation: true,
      depthWrite: false,
    });

    var particles = new T.Points(geo, mat);
    if (scene) scene.add(particles);

    return {
      mesh: particles,
      update: function(t) {
        var sp = 0.14;
        var pos = particles.geometry.attributes.position.array;
        for (var i = 0; i < count; i++) {
          pos[i * 3]     = basePos[i * 3]     + Math.sin(t * sp + seeds[i * 3])     * drift;
          pos[i * 3 + 1] = basePos[i * 3 + 1] + Math.cos(t * sp * 0.7 + seeds[i * 3 + 1]) * drift * 0.55;
          pos[i * 3 + 2] = basePos[i * 3 + 2] + Math.sin(t * sp * 0.5 + seeds[i * 3 + 2]) * drift;
        }
        particles.geometry.attributes.position.needsUpdate = true;
      },
      setColor:   function(c) { mat.color.set(c); },
      setOpacity: function(o) { mat.opacity = o; },
      dispose: function() { particles.geometry.dispose(); mat.dispose(); if (scene) scene.remove(particles); },
    };
  };

  /**
   * buildParticles(THREE, scene, opts?) → { mesh, update(t), explode(t, dur) }
   *
   * Shaped particle cloud — sphere, ring, cone, or box volume.
   * Rotates continuously. Deterministic from shape geometry — scrub-safe.
   *
   * opts:
   *   count        number    (default 600)
   *   shape        string    'sphere'|'ring'|'cone'|'box' (default 'sphere')
   *   radius       number    shape radius (default 5)
   *   size         number    point size (default 0.04)
   *   color        hex
   *   opacity      number    (default 0.6)
   *   rotateSpeed  number    rad/s (default 0.12)
   *   rotateX      number    optional X-axis rotation speed
   *   seed         number    (default 7)
   */
  w.buildParticles = function(T, scene, opts) {
    opts = opts || {};
    var count       = opts.count       !== undefined ? opts.count       : 600;
    var shape       = opts.shape       || 'sphere';
    var radius      = opts.radius      !== undefined ? opts.radius      : 5;
    var sz          = opts.size        !== undefined ? opts.size        : 0.04;
    var color       = opts.color       || '#ffffff';
    var opacity     = opts.opacity     !== undefined ? opts.opacity     : 0.6;
    var rotateSpeed = opts.rotateSpeed !== undefined ? opts.rotateSpeed : 0.12;
    var seed        = opts.seed        || 7;

    var positions = new Float32Array(count * 3);

    for (var i = 0; i < count; i++) {
      var rng = mulberry32(i * 997 + seed);
      var u = rng(), v = rng(), wr = rng();

      if (shape === 'sphere') {
        var theta = Math.acos(2 * u - 1);
        var phi   = 6.28318 * v;
        var r     = radius * Math.pow(wr, 1/3);
        positions[i * 3]     = r * Math.sin(theta) * Math.cos(phi);
        positions[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
        positions[i * 3 + 2] = r * Math.cos(theta);
      } else if (shape === 'ring') {
        var phi2  = 6.28318 * u;
        var ringR = radius * (0.75 + v * 0.5);
        positions[i * 3]     = Math.cos(phi2) * ringR;
        positions[i * 3 + 1] = (wr - 0.5) * radius * 0.25;
        positions[i * 3 + 2] = Math.sin(phi2) * ringR;
      } else if (shape === 'cone') {
        var h    = u * radius;
        var phi3 = 6.28318 * v;
        var rc   = (h / radius) * radius * 0.6;
        positions[i * 3]     = Math.cos(phi3) * rc;
        positions[i * 3 + 1] = h - radius * 0.5;
        positions[i * 3 + 2] = Math.sin(phi3) * rc;
      } else {
        positions[i * 3]     = (u  - 0.5) * radius * 2;
        positions[i * 3 + 1] = (v  - 0.5) * radius * 2;
        positions[i * 3 + 2] = (wr - 0.5) * radius * 2;
      }
    }

    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(positions, 3));

    var mat = new T.PointsMaterial({
      color: new T.Color(color),
      size: sz,
      transparent: true,
      opacity: opacity,
      sizeAttenuation: true,
      depthWrite: false,
    });

    var points = new T.Points(geo, mat);
    if (scene) scene.add(points);

    return {
      mesh: points,
      update: function(t) {
        points.rotation.y = t * rotateSpeed;
        if (opts.rotateX) points.rotation.x = t * opts.rotateX;
      },
      // Expand particles outward, fading to transparent — use for reveal endings
      explode: function(t, duration) {
        var p = applyEasing(clamp(t / (duration || 2), 0, 1), 'expo.out');
        points.scale.setScalar(1 + p * 4);
        mat.opacity = opacity * (1 - p);
      },
      setColor:   function(c) { mat.color.set(c); },
      setOpacity: function(o) { mat.opacity = o; opacity = o; },
      dispose: function() { points.geometry.dispose(); mat.dispose(); if (scene) scene.remove(points); },
    };
  };

  /**
   * buildDataParticles(THREE, scene, points, opts?) → { mesh, update(t) }
   *
   * Particles fly from scattered positions to data-driven world coordinates.
   * Staggered reveal — each point arrives at a different time.
   *
   * points:  Array of [x, y, z] target positions
   *
   * opts:
   *   size           number    point size (default 0.08)
   *   color          hex       (default PALETTE[0] or '#4488ff')
   *   opacity        number    (default 0.9)
   *   revealDuration number    seconds for all points to arrive (default 2)
   *   seed           number    (default 13)
   */
  w.buildDataParticles = function(T, scene, points, opts) {
    opts = opts || {};
    var sz      = opts.size           !== undefined ? opts.size           : 0.08;
    var color   = opts.color          || (w.PALETTE && w.PALETTE[0]) || '#4488ff';
    var opacity = opts.opacity        !== undefined ? opts.opacity        : 0.9;
    var revDur  = opts.revealDuration !== undefined ? opts.revealDuration : 2;
    var seed    = opts.seed           || 13;
    var count   = points.length;

    var targetPos = new Float32Array(count * 3);
    var startPos  = new Float32Array(count * 3);

    for (var i = 0; i < count; i++) {
      targetPos[i * 3]     = points[i][0];
      targetPos[i * 3 + 1] = points[i][1];
      targetPos[i * 3 + 2] = points[i][2];
      var rng = mulberry32(i * 1999 + seed);
      var theta = Math.acos(2 * rng() - 1);
      var phi   = 6.28318 * rng();
      var r     = 12 + rng() * 6;
      startPos[i * 3]     = r * Math.sin(theta) * Math.cos(phi);
      startPos[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
      startPos[i * 3 + 2] = r * Math.cos(theta);
    }

    var geo = new T.BufferGeometry();
    var posAttr = new T.BufferAttribute(new Float32Array(count * 3), 3);
    geo.setAttribute('position', posAttr);

    var mat = new T.PointsMaterial({
      color: new T.Color(color),
      size: sz,
      transparent: true,
      opacity: opacity,
      sizeAttenuation: true,
      depthWrite: false,
    });

    var mesh = new T.Points(geo, mat);
    if (scene) scene.add(mesh);

    return {
      mesh: mesh,
      update: function(t) {
        var pos = posAttr.array;
        for (var i = 0; i < count; i++) {
          var delay = (i / count) * revDur * 0.55;
          var p = applyEasing(clamp((t - delay) / (revDur * 0.45 + 0.001), 0, 1), 'expo.out');
          pos[i * 3]     = lerp(startPos[i * 3],     targetPos[i * 3],     p);
          pos[i * 3 + 1] = lerp(startPos[i * 3 + 1], targetPos[i * 3 + 1], p);
          pos[i * 3 + 2] = lerp(startPos[i * 3 + 2], targetPos[i * 3 + 2], p);
        }
        posAttr.needsUpdate = true;
      },
      setColor: function(c) { mat.color.set(c); },
      dispose: function() { mesh.geometry.dispose(); mat.dispose(); if (scene) scene.remove(mesh); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // ANIMATED CONNECTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildConnectionLine(THREE, scene, pointA, pointB, opts?) →
   *   { tube, dotA, dotB, drawOn(t, dur), setColor(c) }
   *
   * Tube with endpoint dots that animates draw-on from A to B.
   * Call drawOn(t, duration) each frame to reveal the connection over time.
   *
   * pointA/B: [x, y, z]
   *
   * opts:
   *   color      hex     (default '#ffffff')
   *   thickness  number  tube radius (default 0.035)
   *   segments   number  tube segments (default 20)
   *   opacity    number  (default 0.9)
   */
  w.buildConnectionLine = function(T, scene, pointA, pointB, opts) {
    opts = opts || {};
    var color     = opts.color     || '#ffffff';
    var thickness = opts.thickness !== undefined ? opts.thickness : 0.035;
    var segments  = opts.segments  !== undefined ? opts.segments  : 20;
    var opacity   = opts.opacity   !== undefined ? opts.opacity   : 0.9;

    var pA = new T.Vector3(pointA[0], pointA[1], pointA[2]);
    var pB = new T.Vector3(pointB[0], pointB[1], pointB[2]);

    // Shader-based draw-on: single full-length TubeGeometry built once.
    // A uProgress uniform clips fragments via discard in onBeforeCompile —
    // zero CPU geometry rebuild per frame vs the old approach (67 rebuilds/s).
    var mat = new T.MeshStandardMaterial({
      color: new T.Color(color),
      roughness: 0.35,
      metalness: 0.6,
      transparent: true,
      opacity: opacity,
      side: T.DoubleSide,
    });

    var _shaderRef = null;
    mat.onBeforeCompile = function(shader) {
      shader.uniforms.uProgress = { value: 0.0 };
      // Declare varying for tube-length UV (TubeGeometry uv.x = 0→1 along path)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vTubeU;')
        .replace('#include <begin_vertex>', 'vTubeU = uv.x;\n#include <begin_vertex>');
      // Discard fragments beyond current progress (GPU-side clip, no geometry work)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uProgress;\nvarying float vTubeU;')
        .replace('void main() {', 'void main() {\n  if (vTubeU > uProgress) discard;');
      _shaderRef = shader;
    };
    mat.needsUpdate = true;

    var fullCurve = new T.LineCurve3(pA.clone(), pB.clone());
    // Tube always stays in scene — uProgress=0 makes it invisible without visibility toggle
    var tube = new T.Mesh(new T.TubeGeometry(fullCurve, segments, thickness, 8, false), mat);
    tube.castShadow = true;
    if (scene) scene.add(tube);

    // Dots use their own plain material — they must NOT share the tube's
    // onBeforeCompile mat (SphereGeometry UV.x wraps around the equator 0→1,
    // so the uProgress discard would clip the spheres as partial surfaces).
    var dotMat = new T.MeshStandardMaterial({
      color: new T.Color(color),
      roughness: 0.35, metalness: 0.6,
      transparent: opacity < 1, opacity: opacity,
    });
    var dotGeo = new T.SphereGeometry(thickness * 2.8, 10, 10);
    var dotA = new T.Mesh(dotGeo, dotMat);
    var dotB = new T.Mesh(dotGeo.clone(), dotMat);
    dotA.position.copy(pA);
    dotB.position.copy(pA);
    dotB.visible = false;
    if (scene) { scene.add(dotA); scene.add(dotB); }

    return {
      tube: tube,
      dotA: dotA,
      dotB: dotB,
      drawOn: function(t, duration) {
        var p = applyEasing(clamp(t / (duration || 1.2), 0, 1), 'expo.out');
        if (_shaderRef) _shaderRef.uniforms.uProgress.value = p;
        dotB.visible = p > 0.005;
        if (dotB.visible) dotB.position.lerpVectors(pA, pB, p);
      },
      setColor: function(c) { mat.color.set(c); dotMat.color.set(c); },
      setOpacity: function(v) {
        mat.opacity = v; mat.transparent = v < 1;
        dotMat.opacity = v; dotMat.transparent = v < 1;
      },
      dispose: function() {
        mat.dispose(); dotMat.dispose();
        tube.geometry.dispose();
        dotGeo.dispose();
        if (dotB.geometry !== dotGeo) dotB.geometry.dispose();
        if (scene) { scene.remove(tube); scene.remove(dotA); scene.remove(dotB); }
      },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // SHADER MATERIAL UTILITIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * updateShaderMaterials(scene, t)
   *
   * Walks the scene graph and sets `time` uniform on every ShaderMaterial
   * that has one. Call once per update() tick to animate hologram/pulse/xray mats.
   *
   * Example:
   *   // In ThreeJSLayer update:
   *   updateShaderMaterials(scene, t)
   */
  w.updateShaderMaterials = function(scene, t) {
    if (!scene) return;
    scene.traverse(function(obj) {
      if (!obj.isMesh && !obj.isPoints && !obj.isLine) return;
      var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(function(m) {
        if (m && m.uniforms && m.uniforms.time !== undefined) {
          m.uniforms.time.value = t;
        }
      });
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // SCENE SEQUENCER — After Effects-style timeline composition
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildSceneSequencer(namedSets) → sequencer
   *
   * The most AE-like pattern: define named sets at world positions, declare
   * a timeline of camera moves between them, then call sequencer.update(t, camera).
   *
   * namedSets: object of name → makeStudioSet group
   *   { intro: setA, solution: setB, cta: setC }
   *
   * Returns:
   *   sequencer.cut(t, setName, opts?)     — instant camera cut to a set
   *   sequencer.move(startT, endT, fromSet, toSet, ease?) — animated camera move
   *   sequencer.update(t, camera?)         — call every frame in ThreeJSLayer update
   *
   * Each cut/move generates StudioCamera.follow() keyframes internally.
   *
   * Example:
   *   const setA = makeStudioSet(THREE, scene, [0, 0, 0])
   *   const setB = makeStudioSet(THREE, scene, [30, 0, 0])
   *   const seq = buildSceneSequencer({ hero: setA, feature: setB })
   *   seq.cut(0, 'hero')           // start at hero set
   *   seq.move(5, 7, 'hero', 'feature', 'expo.out')  // pan to feature over 2s
   *   seq.cut(12, 'feature')       // hold at feature
   *   // In update: seq.update(t, camera)
   */
  w.buildSceneSequencer = function(namedSets) {
    var events = [];
    var _kfCache = null;
    var _dirty = true;

    function _buildKeyframes() {
      var sorted = events.slice().sort(function(a, b) { return a.t - b.t; });
      var kfs = [];
      sorted.forEach(function(ev) {
        var set = namedSets[ev.set];
        if (!set) return;
        var offset = ev.opts || {};
        var dist   = offset.dist   !== undefined ? offset.dist   : 12;
        var height = offset.height !== undefined ? offset.height : 3;
        var angle  = offset.angle  !== undefined ? offset.angle  : 0;
        var ox = set.position.x + Math.sin(angle) * dist;
        var oy = set.position.y + height;
        var oz = set.position.z + Math.cos(angle) * dist;
        var lx = set.position.x, ly = set.position.y, lz = set.position.z;

        if (ev.type === 'cut') {
          kfs.push({ t: ev.t, pos: [ox, oy, oz], lookAt: [lx, ly, lz], fov: ev.fov });
        } else if (ev.type === 'move') {
          var toSet = namedSets[ev.toSet];
          if (!toSet) return;
          var tox = toSet.position.x + Math.sin(angle) * dist;
          var toy = toSet.position.y + height;
          var toz = toSet.position.z + Math.cos(angle) * dist;
          var tlx = toSet.position.x, tly = toSet.position.y, tlz = toSet.position.z;
          kfs.push({ t: ev.t,   pos: [ox, oy, oz],   lookAt: [lx, ly, lz] });
          kfs.push({ t: ev.endT, pos: [tox, toy, toz], lookAt: [tlx, tly, tlz], ease: ev.ease, fov: ev.fov });
        } else if (ev.type === 'zoomTo') {
          var zSet = namedSets[ev.set];
          if (!zSet) return;
          kfs.push({ t: ev.t, pos: [ox, oy, oz], lookAt: [lx, ly, lz], fov: ev.fov });
        }
      });
      return kfs;
    }

    var seq = {
      cut: function(t, setName, opts) {
        opts = opts || {};
        events.push({ t: t, type: 'cut', set: setName, opts: opts, fov: opts.fov });
        _dirty = true;
        return seq;
      },
      move: function(startT, endT, fromSet, toSet, ease) {
        events.push({ t: startT, type: 'move', set: fromSet, endT: endT, toSet: toSet, ease: ease || 'expo.out' });
        _dirty = true;
        return seq;
      },
      /** zoomTo(t, setName, fov, opts?) — cut to set at t with FOV change */
      zoomTo: function(t, setName, fov, opts) {
        opts = opts || {};
        events.push({ t: t, type: 'zoomTo', set: setName, opts: opts, fov: fov });
        _dirty = true;
        return seq;
      },
      update: function(t, camera) {
        if (_dirty) { _kfCache = _buildKeyframes(); _dirty = false; }
        var keyframes = _kfCache;
        if (!keyframes || keyframes.length === 0) return;

        // Handle FOV keyframes
        var cam = camera || w.StudioCamera._cam;
        if (cam) {
          var fovKfs = keyframes.filter(function(k) { return k.fov !== undefined; });
          if (fovKfs.length >= 2) {
            var ff = fovKfs[0], fl = fovKfs[fovKfs.length - 1];
            if (t <= ff.t) { cam.fov = ff.fov; cam.updateProjectionMatrix(); }
            else if (t >= fl.t) { cam.fov = fl.fov; cam.updateProjectionMatrix(); }
            else {
              for (var fi = 0; fi < fovKfs.length - 1; fi++) {
                var fa = fovKfs[fi], fb = fovKfs[fi+1];
                if (t >= fa.t && t < fb.t) {
                  var fp = (t - fa.t) / (fb.t - fa.t);
                  cam.fov = fa.fov + (fb.fov - fa.fov) * fp;
                  cam.updateProjectionMatrix();
                  break;
                }
              }
            }
          } else if (fovKfs.length === 1 && t >= fovKfs[0].t) {
            cam.fov = fovKfs[0].fov;
            cam.updateProjectionMatrix();
          }
        }

        if (keyframes.length >= 2) {
          w.StudioCamera.follow(t, keyframes, camera);
        } else if (keyframes.length === 1) {
          w.StudioCamera.park(keyframes[0].pos, keyframes[0].lookAt, camera);
        }
      },
      reset: function() { events = []; _kfCache = null; _dirty = true; return seq; },
    };

    return seq;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // CAMERA PRESET MOVES (call from ThreeJSLayer update)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * CAMERA_PRESETS — cinematic camera preset functions.
   *
   * All presets are deterministic at time t — scrub-safe.
   * All accept an optional camera override (last arg).
   *
   * Usage:
   *   CAMERA_PRESETS.productReveal(t, { target: [0,0,0], duration: 8 }, camera)
   */
  w.CAMERA_PRESETS = {

    /**
     * productReveal — 360 orbit with simultaneous dolly in, then hold.
     * Great for product launches and hero reveals.
     *
     * opts: { target, startRadius, endRadius, startHeight, endHeight, duration, orbitRounds }
     */
    productReveal: function(t, opts, cam) {
      opts = opts || {};
      var c    = cam || w.StudioCamera._cam;
      if (!c) return;
      var tx   = (opts.target || [0,0,0])[0];
      var ty   = (opts.target || [0,0,0])[1];
      var tz   = (opts.target || [0,0,0])[2];
      var sr   = opts.startRadius !== undefined ? opts.startRadius : 14;
      var er   = opts.endRadius   !== undefined ? opts.endRadius   : 7;
      var sh   = opts.startHeight !== undefined ? opts.startHeight : 6;
      var eh   = opts.endHeight   !== undefined ? opts.endHeight   : 3;
      var dur  = opts.duration    || 8;
      var rnd  = opts.orbitRounds !== undefined ? opts.orbitRounds : 1.5;
      var p    = applyEasing(clamp(t / dur, 0, 1), 'expo.out');
      var r    = lerp(sr, er, p);
      var h    = lerp(sh, eh, p);
      var ang  = t * (rnd * 6.28318 / dur);
      c.position.set(tx + Math.cos(ang) * r, ty + h, tz + Math.sin(ang) * r);
      c.lookAt(tx, ty, tz);
    },

    /**
     * cinematicSweep — smooth arc from one side to the other.
     * Great for transitional moments between scenes.
     *
     * opts: { target, radius, startAngle, endAngle, height, duration }
     */
    cinematicSweep: function(t, opts, cam) {
      opts = opts || {};
      var c    = cam || w.StudioCamera._cam;
      if (!c) return;
      var tx   = (opts.target || [0,0,0])[0];
      var ty   = (opts.target || [0,0,0])[1];
      var tz   = (opts.target || [0,0,0])[2];
      var r    = opts.radius    !== undefined ? opts.radius    : 10;
      var sa   = opts.startAngle !== undefined ? opts.startAngle : -Math.PI * 0.3;
      var ea   = opts.endAngle   !== undefined ? opts.endAngle   : Math.PI * 0.3;
      var h    = opts.height    !== undefined ? opts.height    : 3.5;
      var dur  = opts.duration  || 5;
      var p    = applyEasing(clamp(t / dur, 0, 1), 'smooth');
      var ang  = lerp(sa, ea, p);
      c.position.set(tx + Math.cos(ang) * r, ty + h, tz + Math.sin(ang) * r);
      c.lookAt(tx, ty, tz);
    },

    /**
     * heroDescend — camera drops from above while orbiting slightly.
     * Great for opening scenes — sky→ground reveal.
     *
     * opts: { target, startHeight, endHeight, radius, duration }
     */
    heroDescend: function(t, opts, cam) {
      opts = opts || {};
      var c    = cam || w.StudioCamera._cam;
      if (!c) return;
      var tx   = (opts.target || [0,0,0])[0];
      var ty   = (opts.target || [0,0,0])[1];
      var tz   = (opts.target || [0,0,0])[2];
      var sh   = opts.startHeight !== undefined ? opts.startHeight : 18;
      var eh   = opts.endHeight   !== undefined ? opts.endHeight   : 4;
      var r    = opts.radius   !== undefined ? opts.radius   : 10;
      var dur  = opts.duration || 6;
      var p    = applyEasing(clamp(t / dur, 0, 1), 'expo.out');
      var h    = lerp(sh, eh, p);
      var ang  = t * 0.15; // slow drift
      var cr   = lerp(r * 0.5, r, 1 - p);
      c.position.set(tx + Math.cos(ang) * cr, ty + h, tz + Math.sin(ang) * cr);
      c.lookAt(tx, ty, tz);
    },

    /**
     * pushIn — slow, deliberate push toward the subject. Cinema verité feel.
     *
     * opts: { target, startDist, endDist, height, angle, duration }
     */
    pushIn: function(t, opts, cam) {
      opts = opts || {};
      var c    = cam || w.StudioCamera._cam;
      if (!c) return;
      var tx   = (opts.target || [0,0,0])[0];
      var ty   = (opts.target || [0,0,0])[1];
      var tz   = (opts.target || [0,0,0])[2];
      var sd   = opts.startDist !== undefined ? opts.startDist : 16;
      var ed   = opts.endDist   !== undefined ? opts.endDist   : 6;
      var h    = opts.height   !== undefined ? opts.height   : 3;
      var ang  = opts.angle    !== undefined ? opts.angle    : 0;
      var dur  = opts.duration || 5;
      var p    = applyEasing(clamp(t / dur, 0, 1), 'smooth');
      var d    = lerp(sd, ed, p);
      c.position.set(tx + Math.sin(ang) * d, ty + h, tz + Math.cos(ang) * d);
      c.lookAt(tx, ty, tz);
    },

    /**
     * rackFocusReveal — dolly-zoom (Hitchcock effect): push in while widening FOV.
     * Keeps subject same size but warps perspective.
     *
     * opts: { target, startDist, endDist, startFOV, endFOV, height, duration }
     */
    rackFocusReveal: function(t, opts, cam) {
      opts = opts || {};
      var c    = cam || w.StudioCamera._cam;
      if (!c) return;
      var tx   = (opts.target || [0,0,0])[0];
      var ty   = (opts.target || [0,0,0])[1];
      var tz   = (opts.target || [0,0,0])[2];
      var sd   = opts.startDist !== undefined ? opts.startDist : 16;
      var ed   = opts.endDist   !== undefined ? opts.endDist   : 4;
      var sf   = opts.startFOV  !== undefined ? opts.startFOV  : 70;
      var ef   = opts.endFOV    !== undefined ? opts.endFOV    : 22;
      var h    = opts.height   !== undefined ? opts.height   : 3;
      var dur  = opts.duration || 5;
      var p    = applyEasing(clamp(t / dur, 0, 1), 'smooth');
      var d    = lerp(sd, ed, p);
      c.position.set(tx, ty + h, tz + d);
      c.lookAt(tx, ty, tz);
      c.fov = lerp(sf, ef, p);
      c.updateProjectionMatrix();
    },
  };

  // Keep _cam accessible for CAMERA_PRESETS
  w.StudioCamera._cam = null;
  var _origSetCamera = w.StudioCamera.setCamera;
  w.StudioCamera.setCamera = function(cam) {
    w.StudioCamera._cam = cam;
    return _origSetCamera.call(w.StudioCamera, cam);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // MULBERRY32 — fast seeded pseudo-random number generator (used by particle builders)
  // ─────────────────────────────────────────────────────────────────────────────
  if (!w.mulberry32) {
    w.mulberry32 = function(seed) {
      return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MATERIALS — PBR + shader material presets
  // Shader variants (hologram, xray, pulse, fresnel) require updateShaderMaterials(scene,t) each frame.
  // ─────────────────────────────────────────────────────────────────────────────
  w.MATERIALS = {
    plastic:    function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), roughness: 0.6, metalness: 0 }); },
    metal:      function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), roughness: 0.2, metalness: 0.9 }); },
    glass:      function(c) { var T = window.THREE; return new T.MeshPhysicalMaterial({ color: new T.Color(c), transparent: true, opacity: 0.3, roughness: 0, transmission: 0.9 }); },
    matte:      function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), roughness: 1, metalness: 0 }); },
    glow:       function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), emissive: new T.Color(c), emissiveIntensity: 0.8 }); },
    clearcoat:  function(c) { var T = window.THREE; return new T.MeshPhysicalMaterial({ color: new T.Color(c), clearcoat: 1.0, clearcoatRoughness: 0.1, roughness: 0.3, metalness: 0.5 }); },
    iridescent: function(c) { var T = window.THREE; return new T.MeshPhysicalMaterial({ color: new T.Color(c), iridescence: 1.0, iridescenceIOR: 1.5, roughness: 0.2, metalness: 0.8 }); },
    velvet:     function(c) { var T = window.THREE; return new T.MeshPhysicalMaterial({ color: new T.Color(c), sheen: 1.0, sheenRoughness: 0.8, sheenColor: new T.Color(c), roughness: 0.9 }); },
    lowpoly:    function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), roughness: 0.7, metalness: 0, flatShading: true }); },
    hologram: function(c, opts) {
      var T = window.THREE; opts = opts || {};
      return new T.ShaderMaterial({
        uniforms: {
          color:    { value: new T.Color(c || '#00ffaa') },
          time:     { value: 0 },
          opacity:  { value: opts.opacity !== undefined ? opts.opacity : 0.88 },
          scanFreq: { value: opts.scanFreq || 22 },
          rimPow:   { value: opts.rimPow   || 2.5 },
        },
        vertexShader: [
          'varying vec3 vNormal; varying vec3 vWorldPos;',
          'void main() {',
          '  vNormal = normalize(normalMatrix * normal);',
          '  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 color; uniform float time; uniform float opacity;',
          'uniform float scanFreq; uniform float rimPow;',
          'varying vec3 vNormal; varying vec3 vWorldPos;',
          'void main() {',
          '  vec3 viewDir = normalize(cameraPosition - vWorldPos);',
          '  float rim = 1.0 - abs(dot(normalize(vNormal), viewDir));',
          '  rim = pow(rim, rimPow);',
          '  float scan = sin(vWorldPos.y * scanFreq - time * 3.2) * 0.5 + 0.5;',
          '  scan = pow(scan, 4.0) * 0.38 + 0.62;',
          '  float flicker = sin(time * 11.7) * 0.035 + 0.965;',
          '  vec3 col = color * (rim * 0.75 + 0.25) * scan * flicker;',
          '  float alpha = (rim * 0.72 + 0.28) * opacity * scan * flicker;',
          '  gl_FragColor = vec4(col, alpha);',
          '}'
        ].join('\n'),
        transparent: true, side: T.FrontSide, depthWrite: false,
      });
    },
    xray: function(c, opts) {
      var T = window.THREE; opts = opts || {};
      return new T.ShaderMaterial({
        uniforms: {
          color:   { value: new T.Color(c || '#88ccff') },
          power:   { value: opts.power   || 3.0 },
          opacity: { value: opts.opacity || 0.75 },
        },
        vertexShader: [
          'varying vec3 vNormal; varying vec3 vViewPos;',
          'void main() {',
          '  vNormal = normalize(normalMatrix * normal);',
          '  vec4 vp = modelViewMatrix * vec4(position, 1.0);',
          '  vViewPos = vp.xyz;',
          '  gl_Position = projectionMatrix * vp;',
          '}'
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 color; uniform float power; uniform float opacity;',
          'varying vec3 vNormal; varying vec3 vViewPos;',
          'void main() {',
          '  float rim = abs(dot(normalize(vNormal), normalize(-vViewPos)));',
          '  rim = pow(1.0 - rim, power);',
          '  gl_FragColor = vec4(color, rim * opacity);',
          '}'
        ].join('\n'),
        transparent: true, side: T.DoubleSide, depthWrite: false,
      });
    },
    pulse: function(c, opts) {
      var T = window.THREE; opts = opts || {};
      return new T.ShaderMaterial({
        uniforms: {
          color:   { value: new T.Color(c) },
          time:    { value: 0 },
          speed:   { value: opts.speed || 2.0 },
          minI:    { value: opts.min   || 0.35 },
          maxI:    { value: opts.max   || 1.0 },
        },
        vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: [
          'uniform vec3 color; uniform float time, speed, minI, maxI;',
          'void main() {',
          '  float p = sin(time * speed) * 0.5 + 0.5;',
          '  gl_FragColor = vec4(color * mix(minI, maxI, p), 1.0);',
          '}'
        ].join('\n'),
      });
    },
    fresnel: function(c, rimColor, opts) {
      var T = window.THREE; opts = opts || {};
      return new T.ShaderMaterial({
        uniforms: {
          baseColor:   { value: new T.Color(c) },
          rimColor:    { value: new T.Color(rimColor || '#ffffff') },
          power:       { value: opts.power || 2.0 },
          rimStrength: { value: opts.rimStrength || 1.0 },
        },
        vertexShader: [
          'varying vec3 vNormal; varying vec3 vViewDir;',
          'void main() {',
          '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
          '  vNormal = normalize(normalMatrix * normal);',
          '  vViewDir = normalize(-mvPos.xyz);',
          '  gl_Position = projectionMatrix * mvPos;',
          '}'
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 baseColor, rimColor; uniform float power, rimStrength;',
          'varying vec3 vNormal, vViewDir;',
          'void main() {',
          '  float fresnel = pow(1.0 - abs(dot(vNormal, vViewDir)), power);',
          '  vec3 col = mix(baseColor, rimColor, fresnel * rimStrength);',
          '  gl_FragColor = vec4(col, 1.0);',
          '}'
        ].join('\n'),
      });
    },
    /**
     * subsurface(c, opts) — cheap subsurface scattering.
     * Great for skin, wax, jade, candles. Call updateShaderMaterials(scene,t) each frame.
     * opts: { backColor, backIntensity, scatterPower, roughness }
     */
    subsurface: function(c, opts) {
      var T = window.THREE; opts = opts || {};
      return new T.ShaderMaterial({
        uniforms: {
          baseColor:      { value: new T.Color(c || '#e8c0a0') },
          backColor:      { value: new T.Color(opts.backColor || '#ff4400') },
          backIntensity:  { value: opts.backIntensity  !== undefined ? opts.backIntensity  : 0.5 },
          scatterPower:   { value: opts.scatterPower   !== undefined ? opts.scatterPower   : 3.0 },
          roughness:      { value: opts.roughness      !== undefined ? opts.roughness      : 0.7 },
          time:           { value: 0 },
        },
        vertexShader: [
          'varying vec3 vNormal; varying vec3 vWorldPos;',
          'void main() {',
          '  vNormal = normalize(mat3(modelMatrix) * normal);',
          '  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
          '}',
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 baseColor, backColor; uniform float backIntensity, scatterPower, roughness;',
          'varying vec3 vNormal, vWorldPos;',
          'void main() {',
          '  vec3 N = normalize(vNormal);',
          '  vec3 L = normalize(vec3(5.0, 10.0, 7.0) - vWorldPos);',
          '  vec3 V = normalize(cameraPosition - vWorldPos);',
          '  float NdL  = max(0.0, dot(N, L));',
          '  float diff = 0.15 + 0.85 * NdL;',
          '  vec3 H = normalize(L + V);',
          '  float spec = pow(max(0.0, dot(N, H)), mix(128.0, 4.0, roughness)) * mix(0.5, 0.05, roughness);',
          '  float backScatter = pow(max(0.0, dot(-L, V)), scatterPower);',
          '  vec3 scatter = backColor * backScatter * backIntensity * (1.0 - NdL * 0.5);',
          '  vec3 col = baseColor * diff + vec3(spec) + scatter;',
          '  gl_FragColor = vec4(col, 1.0);',
          '}',
        ].join('\n'),
      });
    },
    /**
     * matcap(url, opts) — MatCap shading. Loads matcap texture asynchronously.
     * Material works immediately with grey fallback; updates when texture loads.
     * opts: { color }
     */
    matcap: function(url, opts) {
      var T = window.THREE; opts = opts || {};
      var mat = new T.MeshMatcapMaterial({ color: new T.Color(opts.color || 0xffffff) });
      if (url) {
        new T.TextureLoader().load(url, function(tex) {
          if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
          mat.matcap = tex;
          mat.needsUpdate = true;
        }, undefined, function() {
          console.warn('[Studio3D] MATERIALS.matcap: failed to load', url);
        });
      }
      return mat;
    },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // applyPostFX — single-call cinematic post-processing pipeline
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * applyPostFX(renderer, scene, camera, opts?) → composer
   *
   * Sets up a full post-processing pipeline and wires it to the ThreeJSLayer
   * bridge via scene.userData.__dreambyteComposer. The bridge calls composer.render()
   * automatically each frame instead of renderer.render().
   *
   * Call once in ThreeJSLayer setup — no update() call needed.
   *
   * opts:
   *   bloom: {
   *     threshold  (0-1)   luminance cutoff for bloom — default 0.7
   *     strength   (0-3)   additive bloom intensity   — default 1.2
   *     passes     (int)   blur iterations (more = wider glow) — default 3
   *   }
   *   vignette: {
   *     darkness   (0-1)   edge darkening — default 0.5
   *     offset     (0-1)   vignette start radius — default 0.45
   *   }
   *   grain: {
   *     opacity    (0-0.1)  film grain strength — default 0.025
   *     size       (0.5-4)  grain scale: 1=pixel, 4=coarse — default 1.0
   *   }
   *   chromaticAberration: {
   *     strength   (0-0.02) RGB split amount — default 0 (off)
   *   }
   *   lensDistortion: {
   *     strength   (-0.5-0.5) barrel (positive) or pincushion (negative) warp — default 0 (off)
   *   }
   *   tonemap    boolean    ACES filmic tone mapping — default true
   *
   * Returns the composer object (also stored at scene.userData.__dreambyteComposer).
   * composer.setBloomStrength(v), composer.setThreshold(v) adjust live.
   * composer.setLensDistortion(v) adjusts warp live.
   * composer.dispose() frees GPU memory on cleanup.
   *
   * Example:
   *   setup: (THREE, scene, camera, renderer) => {
   *     buildInfiniteStudio(THREE, scene, camera, renderer, { color: 'dark' })
   *     applyPostFX(renderer, scene, camera, {
   *       bloom:   { threshold: 0.5, strength: 1.8 },
   *       vignette: { darkness: 0.6 },
   *     })
   *   }
   *   // No changes to update() needed — composer renders automatically.
   */
  w.applyPostFX = function(renderer, scene, camera, opts) {
    opts = opts || {};
    var T = window.THREE;
    if (!T) { console.warn('[Studio3D] applyPostFX: THREE not loaded'); return null; }

    var W = renderer.domElement.width  || 1920;
    var H = renderer.domElement.height || 1080;
    var bW = Math.max(1, Math.floor(W / 2));
    var bH = Math.max(1, Math.floor(H / 2));

    var rtOpts = { minFilter: T.LinearFilter, magFilter: T.LinearFilter, format: T.RGBAFormat };
    var mainRT   = new T.WebGLRenderTarget(W,  H,  Object.assign({}, rtOpts, { type: T.HalfFloatType }));
    var bloomRT1 = new T.WebGLRenderTarget(bW, bH, rtOpts);
    var bloomRT2 = new T.WebGLRenderTarget(bW, bH, rtOpts);

    var fsCamera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var fsGeo    = new T.PlaneGeometry(2, 2);

    var vsSimple = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

    var bOpts = opts.bloom            || {};
    var vOpts = opts.vignette         || {};
    var gOpts = opts.grain            || {};
    var cOpts = opts.chromaticAberration || {};
    var lOpts = opts.lensDistortion   || {};

    // ── Threshold pass ───────────────────────────────────────────────────────
    var thresholdMat = new T.ShaderMaterial({
      uniforms: {
        tDiffuse:  { value: null },
        threshold: { value: bOpts.threshold !== undefined ? bOpts.threshold : 0.7 },
      },
      vertexShader: vsSimple,
      fragmentShader: [
        'uniform sampler2D tDiffuse; uniform float threshold; varying vec2 vUv;',
        'void main() {',
        '  vec4 c = texture2D(tDiffuse, vUv);',
        '  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));',
        '  float soft = clamp((lum - threshold) / max(threshold * 0.5, 0.001), 0.0, 1.0);',
        '  gl_FragColor = vec4(c.rgb * soft, 1.0);',
        '}',
      ].join('\n'),
    });

    // ── Separable Gaussian blur (9-tap, shared H/V via dir uniform) ──────────
    var blurMat = new T.ShaderMaterial({
      uniforms: {
        tDiffuse:   { value: null },
        resolution: { value: new T.Vector2(bW, bH) },
        dir:        { value: new T.Vector2(1, 0) },
      },
      vertexShader: vsSimple,
      fragmentShader: [
        'uniform sampler2D tDiffuse; uniform vec2 resolution, dir; varying vec2 vUv;',
        'void main() {',
        '  vec2 step = dir / resolution;',
        '  vec4 c = vec4(0.0);',
        '  c += texture2D(tDiffuse, vUv - step*4.0) * 0.0508;',
        '  c += texture2D(tDiffuse, vUv - step*3.0) * 0.0918;',
        '  c += texture2D(tDiffuse, vUv - step*2.0) * 0.1227;',
        '  c += texture2D(tDiffuse, vUv - step*1.0) * 0.1927;',
        '  c += texture2D(tDiffuse, vUv           ) * 0.2240;',
        '  c += texture2D(tDiffuse, vUv + step*1.0) * 0.1927;',
        '  c += texture2D(tDiffuse, vUv + step*2.0) * 0.1227;',
        '  c += texture2D(tDiffuse, vUv + step*3.0) * 0.0918;',
        '  c += texture2D(tDiffuse, vUv + step*4.0) * 0.0508;',
        '  gl_FragColor = vec4(c.rgb, 1.0);',
        '}',
      ].join('\n'),
    });

    // ── Composite: scene + bloom + vignette + grain + CA + ACES ─────────────
    var compositeMat = new T.ShaderMaterial({
      uniforms: {
        tScene:        { value: null },
        tBloom:        { value: null },
        bloomStrength: { value: bOpts.strength    !== undefined ? bOpts.strength    : 1.2  },
        vigDarkness:   { value: vOpts.darkness    !== undefined ? vOpts.darkness    : 0.5  },
        vigOffset:     { value: vOpts.offset      !== undefined ? vOpts.offset      : 0.45 },
        grainOpacity:  { value: gOpts.opacity     !== undefined ? gOpts.opacity     : 0.025 },
        grainSize:     { value: gOpts.size        !== undefined ? gOpts.size        : 1.0  },
        caStrength:    { value: cOpts.strength    !== undefined ? cOpts.strength    : 0.0  },
        ldStrength:    { value: lOpts.strength    !== undefined ? lOpts.strength    : 0.0  },
        doTonemap:     { value: opts.tonemap !== false ? 1 : 0 },
        time:          { value: 0.0 },
      },
      vertexShader: vsSimple,
      fragmentShader: [
        'uniform sampler2D tScene, tBloom;',
        'uniform float bloomStrength, vigDarkness, vigOffset, grainOpacity, grainSize, caStrength, ldStrength, time;',
        'uniform int doTonemap;',
        'varying vec2 vUv;',
        'float rand(vec2 n) { return fract(sin(dot(n,vec2(12.9898,4.1414)))*43758.5453); }',
        '// Gaussian-approximated grain: 2-tap Box-Muller inspired (better bell-curve distribution)',
        'float gaussGrain(vec2 uv, float t) {',
        '  float n1 = rand(uv + vec2(t*0.017, 0.0));',
        '  float n2 = rand(uv + vec2(0.0, t*0.013));',
        '  return (n1 + n2) * 0.5 * 2.0 - 1.0;',
        '}',
        'vec3 aces(vec3 x) { return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }',
        'void main() {',
        '  // Lens distortion — barrel (ldStrength>0) or pincushion (ldStrength<0)',
        '  vec2 uv = vUv;',
        '  if (ldStrength != 0.0) {',
        '    vec2 cc = uv - 0.5;',
        '    float r2 = dot(cc, cc);',
        '    uv = clamp(0.5 + cc*(1.0 + ldStrength*r2*4.0), 0.0, 1.0);',
        '  }',
        '  // Chromatic aberration (offset in distorted space)',
        '  vec3 color;',
        '  if (caStrength > 0.0) {',
        '    vec2 d = (uv - 0.5) * caStrength;',
        '    color = vec3(texture2D(tScene,uv+d).r, texture2D(tScene,uv).g, texture2D(tScene,uv-d).b);',
        '  } else { color = texture2D(tScene, uv).rgb; }',
        '  color += texture2D(tBloom, uv).rgb * bloomStrength;',
        '  if (doTonemap == 1) color = aces(color);',
        '  // Vignette (applied in original UV space so it stays circular)',
        '  float vig = smoothstep(vigOffset+vigDarkness*0.5, vigOffset-vigDarkness*0.5, length(vUv-0.5));',
        '  color *= vig;',
        '  // Film grain (gaussian, scaleable)',
        '  if (grainOpacity > 0.0) color += gaussGrain(uv*grainSize, mod(time,1000.0)) * grainOpacity;',
        '  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);',
        '}',
      ].join('\n'),
    });

    // Mini scene per pass (no lights / materials needed — raw shader quads)
    function makePassScene(mat) {
      var s = new T.Scene();
      s.add(new T.Mesh(fsGeo, mat));
      return s;
    }
    var thresholdScene = makePassScene(thresholdMat);
    var blurScene      = makePassScene(blurMat);
    var compositeScene = makePassScene(compositeMat);

    var BLUR_PASSES = bOpts.passes !== undefined ? bOpts.passes : 3;

    var composer = {
      render: function(t) {
        var prevAutoClear = renderer.autoClear;
        renderer.autoClear = true;

        // 1. Render 3D scene to HDR buffer
        renderer.setRenderTarget(mainRT);
        renderer.render(scene, camera);

        // 2. Threshold → bloomRT1
        thresholdMat.uniforms.tDiffuse.value = mainRT.texture;
        renderer.setRenderTarget(bloomRT1);
        renderer.render(thresholdScene, fsCamera);

        // 3. Ping-pong Gaussian blur (H then V, repeated BLUR_PASSES times)
        for (var i = 0; i < BLUR_PASSES; i++) {
          blurMat.uniforms.tDiffuse.value = bloomRT1.texture;
          blurMat.uniforms.dir.value.set(1, 0);
          renderer.setRenderTarget(bloomRT2);
          renderer.render(blurScene, fsCamera);

          blurMat.uniforms.tDiffuse.value = bloomRT2.texture;
          blurMat.uniforms.dir.value.set(0, 1);
          renderer.setRenderTarget(bloomRT1);
          renderer.render(blurScene, fsCamera);
        }

        // 4. Composite to screen
        compositeMat.uniforms.tScene.value = mainRT.texture;
        compositeMat.uniforms.tBloom.value = bloomRT1.texture;
        compositeMat.uniforms.time.value   = t !== undefined ? t : performance.now() * 0.001;
        renderer.setRenderTarget(null);
        renderer.render(compositeScene, fsCamera);

        renderer.autoClear = prevAutoClear;
      },

      setBloomStrength:  function(v) { compositeMat.uniforms.bloomStrength.value = v; },
      setThreshold:      function(v) { thresholdMat.uniforms.threshold.value = v; },
      setLensDistortion: function(v) { compositeMat.uniforms.ldStrength.value = v; },
      setVignette:       function(darkness, offset) {
        if (darkness !== undefined) compositeMat.uniforms.vigDarkness.value = darkness;
        if (offset   !== undefined) compositeMat.uniforms.vigOffset.value   = offset;
      },
      setGrain: function(opacity, size) {
        if (opacity !== undefined) compositeMat.uniforms.grainOpacity.value = opacity;
        if (size    !== undefined) compositeMat.uniforms.grainSize.value    = size;
      },
      setChromaticAberration: function(v) { compositeMat.uniforms.caStrength.value = v; },

      dispose: function() {
        mainRT.dispose(); bloomRT1.dispose(); bloomRT2.dispose();
        thresholdMat.dispose(); blurMat.dispose(); compositeMat.dispose();
        fsGeo.dispose();
        if (scene.userData.__dreambyteComposer === this) delete scene.userData.__dreambyteComposer;
      },
    };

    scene.userData.__dreambyteComposer = composer;
    return composer;
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildTimeline — declarative per-object keyframe animation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildTimeline(clips) → { update(t), add(clip) }
   *
   * Declarative keyframe animation for Three.js objects. Each clip drives one
   * property of one object over a time interval, with easing. Scrub-safe —
   * calling update(t) at any t produces the correct state instantly.
   *
   * clips: Array of {
   *   mesh    object      The Three.js Object3D (or material) to animate
   *   prop    string      Dot-path to the property: 'position.y', 'rotation.z',
   *                       'material.opacity', 'scale' (uniform xyz), 'visible'
   *   from    number      Start value
   *   to      number      End value
   *   start   number      Scene time (s) when animation begins
   *   end     number      Scene time (s) when animation ends
   *   ease    string      Easing name — same keys as StudioCamera.follow:
   *                       'linear' | 'smooth' | 'expo.out' | 'spring' | 'bounce'
   * }
   *
   * Example:
   *   const tl = buildTimeline([
   *     { mesh: cube,   prop: 'position.y',      from: -5, to: 0,          start: 0, end: 1.5, ease: 'expo.out' },
   *     { mesh: cube,   prop: 'rotation.y',      from: 0,  to: Math.PI*2,  start: 0, end: 6,   ease: 'linear'  },
   *     { mesh: sphere, prop: 'scale',            from: 0,  to: 1,          start: 1, end: 2,   ease: 'spring'  },
   *     { mesh: sphere, prop: 'material.opacity', from: 0,  to: 1,          start: 1, end: 2,   ease: 'smooth'  },
   *   ])
   *   // In update: tl.update(t)
   */
  w.buildTimeline = function(clips) {
    clips = clips || [];

    function setProp(mesh, prop, val) {
      if (prop === 'scale') { mesh.scale.set(val, val, val); return; }
      if (prop === 'visible') { mesh.visible = val >= 0.5; return; }
      var parts = prop.split('.');
      var obj = mesh;
      for (var i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
        if (obj == null) return;
      }
      var last = parts[parts.length - 1];
      // THREE.Color support: if the target object is a Color, call .set()
      if (obj && obj[last] && typeof obj[last].set === 'function' && obj[last].isColor) {
        obj[last].set(val);
      } else {
        obj[last] = val;
      }
    }

    return {
      update: function(t) {
        for (var i = 0; i < clips.length; i++) {
          var c = clips[i];
          // Callback clip: { fn, start, end, ease }
          if (typeof c.fn === 'function') {
            var cs = c.start !== undefined ? c.start : 0;
            var ce = c.end   !== undefined ? c.end   : 1;
            var cp = ce > cs ? applyEasing(clamp((t - cs) / (ce - cs), 0, 1), c.ease || 'linear') : (t >= cs ? 1 : 0);
            c.fn(t, cp);
            continue;
          }
          var mesh = c.mesh || c.target;
          if (!mesh) continue;
          var s    = c.start !== undefined ? c.start : 0;
          var e    = c.end   !== undefined ? c.end   : 1;
          var from = c.from  !== undefined ? c.from  : 0;
          var to   = c.to    !== undefined ? c.to    : 1;
          var ease = c.ease  || 'expo.out';
          var prop = c.prop  || 'position.y';

          if (t <= s) {
            setProp(mesh, prop, from);
          } else if (t >= e) {
            setProp(mesh, prop, to);
          } else {
            var p = applyEasing((t - s) / (e - s), ease);
            setProp(mesh, prop, lerp(from, to, p));
          }
        }
      },

      /** Append a clip after timeline creation. Returns `this` for chaining. */
      add: function(clip) { clips.push(clip); return this; },

      /** Returns a copy of the clips array (for inspection/debugging). */
      clips: function() { return clips.slice(); },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildInstanced — high-performance instanced mesh builder
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildInstanced(THREE, scene, opts) → { mesh, update(t, fn), updateInstance(i,...), count }
   *
   * Creates a THREE.InstancedMesh — renders thousands of identical geometries in
   * one draw call, enabling data-vis fields, architectural arrays, particle-scale
   * counts without per-object draw-call overhead.
   *
   * opts:
   *   count      (int)         number of instances            default 100
   *   geometry   Geometry      shared geometry                default SphereGeometry(0.5)
   *   material   Material      shared material                default MeshStandardMaterial
   *   seed       (int)         RNG seed for determinism       default 42
   *
   *   Layout (pick one):
   *   layout     string        'random' | 'sphere' | 'ring' | 'grid'  default 'random'
   *   radius     (m)           sphere/ring radius             default 5
   *   extents    (m)           half-size of random box        default 10
   *   spacing    (m)           grid cell size                 default 1
   *
   *   Override per-instance:
   *   getPosition(i, rng) → [x,y,z]   overrides layout
   *   getScale(i, rng)    → [x,y,z]   overrides scale
   *   getRotation(i, rng) → [x,y,z]   Euler angles in radians
   *   getColor(i, rng)    → [r,g,b]   0-1 range, enables per-instance color
   *
   *   scale       number|[x,y,z]  uniform or per-axis scale  default 1
   *   scaleRange  [min, max]       random scale range
   *   randomRotation boolean        random rotation on all axes  default false
   *
   * update(t, fn):
   *   fn(i, pos, scale, rot, t, dummy) — called per instance each frame.
   *   Mutate dummy.position / dummy.rotation / dummy.scale, then the matrix
   *   is written automatically. For expensive per-frame updates.
   *
   * Example (5 000 floating cubes):
   *   const field = buildInstanced(THREE, scene, {
   *     count: 5000, geometry: new THREE.BoxGeometry(0.3,0.3,0.3),
   *     material: MATERIALS.metal(THREE),
   *     layout: 'sphere', radius: 12,
   *     scaleRange: [0.5, 1.5], randomRotation: true,
   *   })
   *   // In update: field.update(t, (i, pos) => {
   *   //   field.mesh.setMatrixAt(...) — or use field.update(t, fn)
   *   // })
   */
  w.buildInstanced = function(T, scene, opts) {
    opts = opts || {};
    var count   = opts.count    !== undefined ? opts.count    : 100;
    var geo     = opts.geometry || new T.SphereGeometry(0.5, 8, 8);
    var mat     = opts.material || new T.MeshStandardMaterial({ color: 0xffffff, metalness: 0.4, roughness: 0.6 });
    var rng     = mulberry32(opts.seed !== undefined ? opts.seed : 42);
    var layout  = opts.layout || 'random';
    var radius  = opts.radius  !== undefined ? opts.radius  : 5;
    var extents = opts.extents !== undefined ? opts.extents : 10;
    var spacing = opts.spacing !== undefined ? opts.spacing : 1;

    var mesh = new T.InstancedMesh(geo, mat, count);
    mesh.castShadow    = opts.castShadow    || false;
    mesh.receiveShadow = opts.receiveShadow || false;

    var dummy     = new T.Object3D();
    var positions = new Array(count);
    var scales    = new Array(count);
    var rotations = new Array(count);

    var hasColor = typeof opts.getColor === 'function';

    for (var i = 0; i < count; i++) {
      // Position
      var pos;
      if (typeof opts.getPosition === 'function') {
        pos = opts.getPosition(i, rng);
      } else if (opts.positions && opts.positions[i]) {
        pos = opts.positions[i];
      } else if (layout === 'sphere') {
        var theta = rng() * Math.PI * 2;
        var phi   = Math.acos(2 * rng() - 1);
        var r     = radius * (opts.shellOnly ? 1 : 0.5 + rng() * 0.5);
        pos = [r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)];
      } else if (layout === 'ring') {
        var ang = (i / count) * Math.PI * 2;
        pos = [Math.cos(ang) * radius, (rng() - 0.5) * (opts.ringHeight || 0), Math.sin(ang) * radius];
      } else if (layout === 'grid') {
        var cols = Math.ceil(Math.sqrt(count));
        pos = [(i % cols - cols / 2 + 0.5) * spacing, 0, (Math.floor(i / cols) - cols / 2 + 0.5) * spacing];
      } else {
        pos = [(rng() - 0.5) * extents * 2, (rng() - 0.5) * extents * 2, (rng() - 0.5) * extents * 2];
      }

      // Scale
      var sc;
      if (typeof opts.getScale === 'function') {
        sc = opts.getScale(i, rng);
      } else if (opts.scaleRange) {
        var sv = lerp(opts.scaleRange[0], opts.scaleRange[1], rng());
        sc = [sv, sv, sv];
      } else if (Array.isArray(opts.scale)) {
        sc = opts.scale;
      } else {
        var sv2 = opts.scale !== undefined ? opts.scale : 1;
        sc = [sv2, sv2, sv2];
      }

      // Rotation
      var rot;
      if (typeof opts.getRotation === 'function') {
        rot = opts.getRotation(i, rng);
      } else if (opts.randomRotation) {
        rot = [rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2];
      } else {
        rot = [0, 0, 0];
      }

      positions[i] = pos;
      scales[i]    = sc;
      rotations[i] = rot;

      dummy.position.set(pos[0], pos[1], pos[2]);
      dummy.scale.set(sc[0], sc[1], sc[2]);
      dummy.rotation.set(rot[0], rot[1], rot[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      if (hasColor) {
        var col = opts.getColor(i, rng);
        mesh.setColorAt(i, new T.Color(col[0], col[1], col[2]));
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (hasColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (scene) scene.add(mesh);

    return {
      mesh:      mesh,
      count:     count,
      positions: positions,
      scales:    scales,
      rotations: rotations,
      dummy:     dummy,

      /** Animate all instances each frame via a callback. */
      update: function(t, fn) {
        if (!fn) return;
        for (var i = 0; i < count; i++) {
          dummy.position.set(positions[i][0], positions[i][1], positions[i][2]);
          dummy.scale.set(scales[i][0], scales[i][1], scales[i][2]);
          dummy.rotation.set(rotations[i][0], rotations[i][1], rotations[i][2]);
          fn(i, positions[i], scales[i], rotations[i], t, dummy);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      },

      /** Update a single instance's transform. */
      updateInstance: function(i, pos, sc, rot) {
        var p = pos || positions[i];
        var s = sc  || scales[i];
        var r = rot || rotations[i];
        dummy.position.set(p[0], p[1], p[2]);
        if (Array.isArray(s)) dummy.scale.set(s[0], s[1], s[2]);
        else dummy.scale.setScalar(s);
        dummy.rotation.set(r[0], r[1], r[2]);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.instanceMatrix.needsUpdate = true;
      },

      dispose: function() {
        if (scene) scene.remove(mesh);
        geo.dispose();
        mat.dispose();
      },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // SHADER MATERIALS — toon, dissolve, wave, outline, holographic+
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildToonMaterial(THREE, opts?) → THREE.ShaderMaterial
   *
   * 4-band cel/toon shading. Discrete lighting steps instead of smooth PBR
   * gradients — Ghibli-style, stylized, cartoon. Fully scrub-safe.
   *
   * opts:
   *   color       hex/Color   base object color         default 0x88aacc
   *   bands       [c0,c1,c2,c3]  four THREE.Color steps  auto-derived from color
   *   thresholds  [t0,t1,t2]     brightness cutoffs       default [0.85, 0.4, 0.05]
   *   lightPos    [x,y,z]        key light direction      default [15,15,15]
   *   rimColor    hex/Color      rim/outline color        default 0xffffff
   *   rimPower    number         rim tightness            default 3.0
   *   outline     boolean        draw silhouette outline  default false
   *
   * Usage:
   *   const m = buildToonMaterial(THREE, { color: 0x44aaff, outline: true })
   *   mesh.material = m
   *   // In update: m.uniforms.uLightPos.value.set(x,y,z) to move light
   */
  w.buildToonMaterial = function(T, opts) {
    opts = opts || {};
    var col = opts.color !== undefined ? new T.Color(opts.color) : new T.Color(0x88aacc);
    var thr = opts.thresholds || [0.85, 0.4, 0.05];
    var lp  = opts.lightPos   || [15, 15, 15];
    var rim = opts.rimColor !== undefined ? new T.Color(opts.rimColor) : new T.Color(1, 1, 1);
    var rp  = opts.rimPower !== undefined ? opts.rimPower : 3.0;

    // Auto-generate 4 bands from base color if not provided
    var bands;
    if (opts.bands) {
      bands = opts.bands.map(function(c) { return new T.Color(c); });
    } else {
      var h = {}, s = {}, l = {};
      col.getHSL(h); s = h.s || 0; l = h.l || 0.5; h = h.h || 0;
      bands = [
        new T.Color().setHSL(h, s * 0.6, Math.min(1, l * 1.5)),
        new T.Color().setHSL(h, s * 0.8, l),
        new T.Color().setHSL(h, s,        l * 0.6),
        new T.Color().setHSL(h, s * 1.1,  l * 0.3),
      ];
    }

    return new T.ShaderMaterial({
      uniforms: {
        uBands:      { value: bands },
        uThresholds: { value: new T.Vector3(thr[0], thr[1], thr[2]) },
        uLightPos:   { value: new T.Vector3(lp[0], lp[1], lp[2]) },
        uRimColor:   { value: rim },
        uRimPower:   { value: rp },
        uRimStrength:{ value: opts.rimStrength !== undefined ? opts.rimStrength : 0.5 },
      },
      vertexShader: [
        'varying vec3 vNormal; varying vec3 vWorldPos; varying vec3 vViewDir;',
        'void main() {',
        '  vNormal   = normalize(mat3(modelMatrix) * normal);',
        '  vWorldPos = (modelMatrix * vec4(position,1.0)).xyz;',
        '  vViewDir  = normalize(cameraPosition - vWorldPos);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uBands[4]; uniform vec3 uThresholds; uniform vec3 uLightPos;',
        'uniform vec3 uRimColor; uniform float uRimPower, uRimStrength;',
        'varying vec3 vNormal; varying vec3 vWorldPos; varying vec3 vViewDir;',
        'void main() {',
        '  vec3  L   = normalize(uLightPos - vWorldPos);',
        '  float NdL = dot(vNormal, L);',
        '  vec3  col;',
        '  if      (NdL > uThresholds.x) col = uBands[0];',
        '  else if (NdL > uThresholds.y) col = uBands[1];',
        '  else if (NdL > uThresholds.z) col = uBands[2];',
        '  else                           col = uBands[3];',
        '  float rim = pow(1.0 - max(0.0, dot(vNormal, vViewDir)), uRimPower);',
        '  col = mix(col, uRimColor, rim * uRimStrength);',
        '  gl_FragColor = vec4(col, 1.0);',
        '}',
      ].join('\n'),
      side: opts.side !== undefined ? opts.side : T.FrontSide,
    });
  };


  /**
   * buildDissolveMaterial(THREE, opts?) → { material, update(t) }
   *
   * Animated noise-based dissolve/burn effect. The mesh appears to burn away
   * or materialize from nothing based on a progress value 0→1.
   *
   * opts:
   *   color       hex     base color             default 0x4488ff
   *   edgeColor   hex     burn/dissolve edge     default 0xff6600
   *   edgeWidth   0-0.1   glow edge thickness    default 0.04
   *   noiseScale  number  dissolve grain size    default 3.0
   *   progress    0-1     manual override (else use update(t))
   *   duration    s       time for full dissolve  default 3.0
   *   reverse     bool    materialize in instead  default false
   *
   * Usage:
   *   const d = buildDissolveMaterial(THREE, { color: 0x44aaff, duration: 2 })
   *   mesh.material = d.material
   *   // In update: d.update(t)
   */
  w.buildDissolveMaterial = function(T, opts) {
    opts = opts || {};
    var mat = new T.ShaderMaterial({
      uniforms: {
        uColor:      { value: new T.Color(opts.color      !== undefined ? opts.color      : 0x4488ff) },
        uEdgeColor:  { value: new T.Color(opts.edgeColor  !== undefined ? opts.edgeColor  : 0xff6600) },
        uEdgeWidth:  { value: opts.edgeWidth  !== undefined ? opts.edgeWidth  : 0.04  },
        uNoiseScale: { value: opts.noiseScale !== undefined ? opts.noiseScale : 3.0   },
        uProgress:   { value: opts.reverse ? 1.0 : 0.0 },
        uTime:       { value: 0 },
      },
      vertexShader: [
        'varying vec3 vPos; varying vec3 vNormal;',
        'void main() {',
        '  vPos = position; vNormal = normal;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor, uEdgeColor; uniform float uEdgeWidth, uNoiseScale, uProgress, uTime;',
        'varying vec3 vPos; varying vec3 vNormal;',
        '// 3D value noise',
        'vec3 hash3(vec3 p) { p=fract(p*vec3(443.8975,397.2973,491.1871)); p+=dot(p,p.yxz+19.19); return fract((p.xxy+p.yxx)*p.zyx); }',
        'float noise(vec3 p) {',
        '  vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.0-2.0*f);',
        '  return mix(mix(mix(hash3(i+vec3(0,0,0)).x,hash3(i+vec3(1,0,0)).x,f.x),',
        '                 mix(hash3(i+vec3(0,1,0)).x,hash3(i+vec3(1,1,0)).x,f.x),f.y),',
        '             mix(mix(hash3(i+vec3(0,0,1)).x,hash3(i+vec3(1,0,1)).x,f.x),',
        '                 mix(hash3(i+vec3(0,1,1)).x,hash3(i+vec3(1,1,1)).x,f.x),f.y),f.z);',
        '}',
        'void main() {',
        '  float n = noise(vPos * uNoiseScale);',
        '  float thresh = uProgress;',
        '  if (n < thresh) discard;',
        '  float edge = smoothstep(thresh, thresh + uEdgeWidth, n);',
        '  vec3  col  = mix(uEdgeColor, uColor, edge);',
        '  gl_FragColor = vec4(col, 1.0);',
        '}',
      ].join('\n'),
      side: T.DoubleSide,
      transparent: false,
    });

    var dur     = opts.duration !== undefined ? opts.duration : 3.0;
    var rev     = opts.reverse  || false;
    var started = null;

    return {
      material: mat,
      update: function(t) {
        mat.uniforms.uTime.value = t;
        if (opts.progress !== undefined) {
          mat.uniforms.uProgress.value = rev ? 1.0 - opts.progress : opts.progress;
        } else {
          var p = clamp(t / dur, 0, 1);
          mat.uniforms.uProgress.value = rev ? 1.0 - p : p;
        }
      },
      setProgress: function(p) { mat.uniforms.uProgress.value = clamp(p, 0, 1); },
    };
  };


  /**
   * buildWaveMaterial(THREE, opts?) → { material, update(t) }
   *
   * Animated vertex displacement — smooth sine waves on any mesh geometry.
   * Great for flags, cloth, liquid surfaces, breathing organic shapes.
   *
   * opts:
   *   color       hex     surface color           default 0x2244aa
   *   amplitude   number  wave height             default 0.3
   *   frequency   number  wave density            default 2.0
   *   speed       number  wave travel speed       default 1.0
   *   axis        string  'y' | 'x' | 'z'        default 'y'
   *   metalness   0-1                              default 0.3
   *   roughness   0-1                              default 0.6
   *
   * Usage:
   *   const w = buildWaveMaterial(THREE, { amplitude: 0.5, speed: 2 })
   *   flagMesh.material = w.material
   *   // In update: w.update(t)
   */
  w.buildWaveMaterial = function(T, opts) {
    opts = opts || {};
    var mat = new T.ShaderMaterial({
      uniforms: {
        uColor:     { value: new T.Color(opts.color !== undefined ? opts.color : 0x2244aa) },
        uAmplitude: { value: opts.amplitude !== undefined ? opts.amplitude : 0.3  },
        uFrequency: { value: opts.frequency !== undefined ? opts.frequency : 2.0  },
        uSpeed:     { value: opts.speed     !== undefined ? opts.speed     : 1.0  },
        uTime:      { value: 0.0 },
        uAxis:      { value: opts.axis === 'x' ? 0 : opts.axis === 'z' ? 2 : 1 },
        // PBR-ish: use ambient + normal for shading
        uLightDir:  { value: new T.Vector3(1, 2, 1).normalize() },
        uMetalness: { value: opts.metalness !== undefined ? opts.metalness : 0.3 },
        uRoughness: { value: opts.roughness !== undefined ? opts.roughness : 0.6 },
      },
      vertexShader: [
        'uniform float uAmplitude, uFrequency, uSpeed, uTime; uniform int uAxis;',
        'varying vec3 vNormal; varying vec3 vWorldPos;',
        'void main() {',
        '  vec3 pos = position;',
        '  float wave = sin(pos.x * uFrequency + uTime * uSpeed)',
        '             + sin(pos.z * uFrequency * 0.7 + uTime * uSpeed * 1.3);',
        '  wave *= uAmplitude * 0.5;',
        '  if      (uAxis == 0) pos.x += wave;',
        '  else if (uAxis == 2) pos.z += wave;',
        '  else                 pos.y += wave;',
        '  // Approximate displaced normal',
        '  float dx = cos(pos.x * uFrequency + uTime * uSpeed) * uFrequency * uAmplitude * 0.5;',
        '  vNormal = normalize(normal + vec3(-dx, 1.0, -dx));',
        '  vWorldPos = (modelMatrix * vec4(pos,1.0)).xyz;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos,1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor, uLightDir; uniform float uMetalness, uRoughness;',
        'varying vec3 vNormal; varying vec3 vWorldPos;',
        'void main() {',
        '  vec3  N    = normalize(vNormal);',
        '  float NdL  = max(0.0, dot(N, normalize(uLightDir)));',
        '  float diff = 0.2 + 0.8 * NdL;',
        '  gl_FragColor = vec4(uColor * diff, 1.0);',
        '}',
      ].join('\n'),
      side: T.DoubleSide,
    });

    return {
      material: mat,
      update: function(t) { mat.uniforms.uTime.value = t; },
    };
  };


  /**
   * buildOutlineMaterial(THREE, opts?) → THREE.ShaderMaterial
   *
   * Single-pass silhouette outline using back-face extrusion.
   * Render the mesh twice: once with normal material, once with this.
   *
   * opts:
   *   color     hex     outline color    default 0x000000
   *   thickness number  extrusion dist   default 0.03
   *
   * Usage:
   *   scene.add(mesh)  // normal material
   *   const outlineMesh = mesh.clone()
   *   outlineMesh.material = buildOutlineMaterial(THREE, { color: 0x000000, thickness: 0.04 })
   *   scene.add(outlineMesh)
   */
  w.buildOutlineMaterial = function(T, opts) {
    opts = opts || {};
    return new T.ShaderMaterial({
      uniforms: {
        uColor:     { value: new T.Color(opts.color     !== undefined ? opts.color     : 0x000000) },
        uThickness: { value: opts.thickness !== undefined ? opts.thickness : 0.03 },
      },
      vertexShader: [
        'uniform float uThickness;',
        'void main() {',
        '  vec3 n = normalize(normalMatrix * normal);',
        '  vec4 pos = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
        '  vec2 offset = normalize(mat2(projectionMatrix) * n.xy) * uThickness * pos.w * 0.1;',
        '  pos.xy += offset;',
        '  gl_Position = pos;',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'void main() { gl_FragColor = vec4(uColor, 1.0); }',
      ].join('\n'),
      side: T.BackSide,
    });
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // LIBRARY WRAPPERS — CustomShaderMaterial, enhanceMaterial, buildCSM
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * extendMaterial(THREE, BaseMaterialClass, opts) → CustomShaderMaterial
   *
   * Wraps three-custom-shader-material. Lets you write custom vertex/fragment
   * shader chunks ON TOP of any PBR material (MeshStandardMaterial,
   * MeshPhysicalMaterial, etc.) while keeping shadows, fog, and lighting intact.
   *
   * This is the most powerful material tool — custom effects WITHOUT losing PBR.
   *
   * opts:
   *   uniforms        object   extra uniforms { uTime: { value: 0 } }
   *   vertexShader    string   GLSL chunk — use `csm_Position` to displace verts
   *   fragmentShader  string   GLSL chunk — use `csm_DiffuseColor` to tint
   *   ...any MeshStandardMaterial props (color, metalness, roughness, etc.)
   *
   * Output variables available in your shaders:
   *   Vertex:   csm_Position (vec3), csm_Normal (vec3)
   *   Fragment: csm_DiffuseColor (vec4), csm_FragColor (vec4),
   *             csm_Roughness, csm_Metalness, csm_Emissive
   *
   * Example — animated vertex wave keeping PBR shading:
   *   const mat = extendMaterial(THREE, THREE.MeshStandardMaterial, {
   *     color: 0x4488ff, metalness: 0.6, roughness: 0.3,
   *     uniforms: { uTime: { value: 0 } },
   *     vertexShader: `
   *       uniform float uTime;
   *       void main() {
   *         csm_Position.y += sin(position.x * 3.0 + uTime) * 0.3;
   *       }
   *     `,
   *   })
   *   // In update: mat.uniforms.uTime.value = t
   *
   * Requires /vendor/three-custom-shader-material.js loaded before SDK.
   */
  w.extendMaterial = function(T, BaseMaterialClass, opts) {
    var CSM = window.CustomShaderMaterial;
    if (!CSM) {
      console.warn('[Studio3D] extendMaterial: CustomShaderMaterial not loaded — /vendor/three-custom-shader-material.js must come before SDK');
      return new T.MeshStandardMaterial(opts);
    }
    opts = opts || {};
    var uniforms       = opts.uniforms       || {};
    var vertexShader   = opts.vertexShader   || '';
    var fragmentShader = opts.fragmentShader || '';

    // Strip our custom keys before passing to base material
    var matOpts = {};
    var skipKeys = { uniforms:1, vertexShader:1, fragmentShader:1, patchMap:1 };
    Object.keys(opts).forEach(function(k) { if (!skipKeys[k]) matOpts[k] = opts[k]; });

    try {
      return new CSM(Object.assign({
        baseMaterial: BaseMaterialClass,
        uniforms:       uniforms,
        vertexShader:   vertexShader   || undefined,
        fragmentShader: fragmentShader || undefined,
        patchMap:       opts.patchMap  || undefined,
      }, matOpts));
    } catch(e) {
      console.warn('[Studio3D] extendMaterial failed:', e.message);
      return new BaseMaterialClass(matOpts);
    }
  };


  /**
   * enhanceMaterial(THREE, material, opts?) → material (mutated in place)
   *
   * Wraps enhance-shader-lighting. Improves AO, IBL, and lightmap quality on any
   * MeshStandardMaterial or MeshPhysicalMaterial by injecting shader modifications
   * via material.onBeforeCompile. Works transparently — same material, better look.
   *
   * opts (all optional):
   *   aoPower            number  AO intensity boost          default 1.0
   *   aoSmoothing        number  AO edge softness            default 1.0
   *   aoColor            hex     AO shadow tint              default 0x000000
   *   sunIntensity       number  direct light boost          default 1.0
   *   envPower           number  environment/IBL boost       default 1.0
   *   irradianceColor    hex     indirect diffuse tint
   *   radianceColor      hex     indirect specular tint
   *   lightMapSaturation number  lightmap color richness     default 1.0
   *   lightMapContrast   number  lightmap contrast           default 1.0
   *   mapContrast        number  albedo contrast             default 1.0
   *   roughnessPower     number  roughness curve adjustment  default 1.0
   *
   * Usage:
   *   const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.4 })
   *   enhanceMaterial(THREE, mat, { aoPower: 1.5, sunIntensity: 1.2 })
   *   mesh.material = mat
   *
   * Requires /vendor/enhance-shader-lighting.js loaded before SDK.
   */
  w.enhanceMaterial = function(T, material, opts) {
    var enhance = window.enhanceShaderLighting;
    if (typeof enhance !== 'function') {
      console.warn('[Studio3D] enhanceMaterial: enhance-shader-lighting not loaded — /vendor/enhance-shader-lighting.js must come before SDK');
      return material;
    }
    opts = opts || {};

    // Convert hex color opts to THREE.Color uniforms
    function colorUniform(val) {
      return val !== undefined ? { value: new T.Color(val) } : undefined;
    }

    var config = {};
    var numKeys = ['aoPower','aoSmoothing','sunIntensity','envPower','irradianceIntensity',
                   'radianceIntensity','lightMapGamma','lightMapSaturation','lightMapContrast',
                   'mapContrast','roughnessPower'];
    numKeys.forEach(function(k) { if (opts[k] !== undefined) config[k] = opts[k]; });

    var colKeys = ['aoColor','hemisphereColor','irradianceColor','radianceColor'];
    colKeys.forEach(function(k) {
      if (opts[k] !== undefined) config[k] = colorUniform(opts[k]);
    });

    var prev = material.onBeforeCompile;
    material.onBeforeCompile = function(shader, renderer) {
      if (prev) prev(shader, renderer);
      try { enhance(shader, config); } catch(e) { console.warn('[Studio3D] enhanceMaterial error:', e.message); }
    };
    material.needsUpdate = true;
    return material;
  };


  /**
   * buildCSM(THREE, scene, camera, opts?) → csm
   *
   * Cascaded Shadow Maps for large-scale scenes with high-quality shadows.
   * Splits the view frustum into multiple cascades — near shadows are
   * high resolution, distant shadows degrade gracefully.
   *
   * opts:
   *   cascades      int     number of shadow layers    default 4
   *   shadowMapSize int     resolution per cascade     default 2048
   *   maxFar        number  shadow draw distance        default 500
   *   lightDir      [x,y,z] sun direction               default [-1,-2,-1]
   *   mode          string  'practical'|'uniform'|'logarithmic'  default 'practical'
   *   fade          bool    blend between cascades      default true
   *   bias          number  shadow bias                 default 0.000001
   *
   * IMPORTANT: call csm.setupMaterial(mesh.material) on every shadow-casting material.
   * IMPORTANT: call csm.update() in your update() callback every frame.
   *
   * Usage:
   *   const csm = buildCSM(THREE, scene, camera, { cascades: 3, maxFar: 300 })
   *   csm.setupMaterial(mesh.material)
   *   // In update: csm.update()
   *
   * Requires /vendor/three-csm.js loaded before SDK.
   */
  w.buildCSM = function(T, scene, camera, opts) {
    var CSMClass = window.CSM || (window.ThreeCSMLib && window.ThreeCSMLib.CSM);
    if (!CSMClass) {
      console.warn('[Studio3D] buildCSM: three-csm not loaded — /vendor/three-csm.js must come before SDK');
      return null;
    }
    opts = opts || {};
    var ld = opts.lightDir || [-1, -2, -1];
    var csm = new CSMClass({
      camera:        camera,
      parent:        scene,
      cascades:      opts.cascades      !== undefined ? opts.cascades      : 4,
      shadowMapSize: opts.shadowMapSize !== undefined ? opts.shadowMapSize : 2048,
      maxFar:        opts.maxFar        !== undefined ? opts.maxFar        : 500,
      mode:          opts.mode          || 'practical',
      fade:          opts.fade          !== false,
      bias:          opts.bias          !== undefined ? opts.bias          : 0.000001,
      normalBias:    opts.normalBias    !== undefined ? opts.normalBias    : 0.05,
      lightDirection: new T.Vector3(ld[0], ld[1], ld[2]).normalize(),
    });
    return csm;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildMagicMarbleMaterial — procedural volumetric marble via fbm noise
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildMagicMarbleMaterial(THREE, opts) → ShaderMaterial
   *
   * Procedural marble ShaderMaterial using 5-octave fractional Brownian motion
   * to drive sine-based veining. Supports animated slow drift.
   *
   * opts:
   *   color1       hex   base marble color — default '#f5f0e8' (warm white)
   *   color2       hex   vein color — default '#1a0a00' (dark brown)
   *   scale        float world-space noise scale — default 3.0 (lower = larger slabs)
   *   veinFreq     float vein sine frequency — default 8.0
   *   veinStrength float noise warp strength — default 4.0
   *   roughness    0-1   specular roughness — default 0.1 (polished)
   *   animated     bool  slow noise drift — default true
   *   side         THREE.FrontSide | DoubleSide — default FrontSide
   *
   * Call mat.userData.update(t) in ThreeJSLayer update() for animated drift.
   *
   * Example:
   *   const mat = buildMagicMarbleMaterial(THREE, { color1: '#ede0d4', color2: '#4a2c0a', roughness: 0.05 })
   *   const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.5, 64, 64), mat)
   *   scene.add(sphere)
   *   // In update:
   *   mat.userData.update(t)
   */
  w.buildMagicMarbleMaterial = function(T, opts) {
    if (!T) T = window.THREE;
    opts = opts || {};
    var animated = opts.animated !== false;

    var mat = new T.ShaderMaterial({
      uniforms: {
        color1:        { value: new T.Color(opts.color1        || '#f5f0e8') },
        color2:        { value: new T.Color(opts.color2        || '#1a0a00') },
        scale:         { value: opts.scale         !== undefined ? opts.scale         : 3.0 },
        veinFreq:      { value: opts.veinFreq      !== undefined ? opts.veinFreq      : 8.0 },
        veinStrength:  { value: opts.veinStrength  !== undefined ? opts.veinStrength  : 4.0 },
        roughness:     { value: opts.roughness     !== undefined ? opts.roughness     : 0.1 },
        time:          { value: 0.0 },
      },
      vertexShader: [
        'varying vec3 vWorldPos;',
        'varying vec3 vNormal;',
        'void main() {',
        '  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
        '  vNormal   = normalize(normalMatrix * normal);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 color1, color2;',
        'uniform float scale, veinFreq, veinStrength, roughness, time;',
        'varying vec3 vWorldPos, vNormal;',
        // 3D value noise
        'float h1(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }',
        'float n3(vec3 p){',
        '  vec3 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);',
        '  return mix(',
        '    mix(mix(h1(i),h1(i+vec3(1,0,0)),u.x),mix(h1(i+vec3(0,1,0)),h1(i+vec3(1,1,0)),u.x),u.y),',
        '    mix(mix(h1(i+vec3(0,0,1)),h1(i+vec3(1,0,1)),u.x),mix(h1(i+vec3(0,1,1)),h1(i+vec3(1,1,1)),u.x),u.y),',
        '  u.z);',
        '}',
        'float fbm(vec3 p){ float v=0.,a=0.5; for(int i=0;i<5;i++){v+=a*n3(p);p*=2.01;a*=0.5;} return v; }',
        'void main(){',
        '  vec3 p = vWorldPos * scale;',
        '  float n = fbm(p + time * 0.05);',
        '  float marble = sin(p.y * veinFreq + n * veinStrength) * 0.5 + 0.5;',
        '  vec3 base = mix(color2, color1, marble);',
        '  vec3 N = normalize(vNormal);',
        '  vec3 L = normalize(vec3(1.0, 2.0, 1.0));',
        '  float diff = max(dot(N,L), 0.0)*0.7 + 0.3;',
        '  vec3 V = normalize(cameraPosition - vWorldPos);',
        '  vec3 H = normalize(L+V);',
        '  float spec = pow(max(dot(N,H),0.0), mix(256.0,8.0,roughness)) * mix(0.9,0.1,roughness);',
        '  gl_FragColor = vec4(base*diff + vec3(spec), 1.0);',
        '}',
      ].join('\n'),
      side: opts.side !== undefined ? opts.side : T.FrontSide,
    });

    mat.userData.update = function(t) { if (animated) mat.uniforms.time.value = t; };
    return mat;
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // applyPCSS — Percentage Closer Soft Shadows via onBeforeCompile
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * applyPCSS(THREE, material, opts?) → void
   *
   * Patches a receiveShadow material with Poisson-disk PCSS (soft shadows).
   * Replaces Three.js's default PCF with a two-pass blocker search + variable
   * PCF radius proportional to estimated penumbra width.
   *
   * Call once per material, before the material is compiled (i.e., before the
   * mesh is added to the scene, or immediately after with needsUpdate forced).
   *
   * opts:
   *   lightSize  (float) world-space blocker search radius — default 3.0
   *              Higher values = softer/wider shadows. Tune per scene.
   *
   * Example:
   *   const floor = new THREE.Mesh(new THREE.PlaneGeometry(20,20), new THREE.MeshStandardMaterial())
   *   floor.receiveShadow = true
   *   applyPCSS(THREE, floor.material, { lightSize: 4.0 })
   *   scene.add(floor)
   *
   * Requires shadowMap enabled on the renderer:
   *   renderer.shadowMap.enabled = true
   *   renderer.shadowMap.type = THREE.PCFSoftShadowMap  (or PCFShadowMap)
   */
  w.applyPCSS = function(T, material, opts) {
    if (!T) T = window.THREE;
    if (!material) { console.warn('[Studio3D] applyPCSS: material required'); return; }
    opts = opts || {};
    var ls = (opts.lightSize !== undefined ? opts.lightSize : 3.0).toFixed(4);

    // 17-tap Poisson disk (threejs-sandbox, MIT)
    var PD_X = [-0.9420162, 0.9455861,-0.0941841, 0.3449594,-0.9158858,-0.8154423,-0.3827754, 0.9748440, 0.4432333, 0.5374298,-0.2649691, 0.7919751,-0.2418884,-0.8140996, 0.1998413, 0.1438316,-0.4409954];
    var PD_Y = [-0.3990622,-0.7689073,-0.9293887, 0.2938776, 0.4577143,-0.8791246, 0.2767685, 0.7564838,-0.9751155,-0.4737342,-0.4189302, 0.1909019, 0.9970651, 0.9143759, 0.7864137,-0.1410079, 0.5782656];
    var pdArr = 'const vec2 PCSS_PD[17] = vec2[17](\n  ' +
      PD_X.map(function(x,i){ return 'vec2('+x.toFixed(7)+','+PD_Y[i].toFixed(7)+')'; }).join(',\n  ') + '\n);\n';

    // Replacement for Three.js's getShadow — keeps identical signature so all
    // call sites in lights_fragment_begin work unchanged. The brace-counting
    // replacement below finds the original function regardless of formatting.
    var pcssFunc = [
      pdArr,
      'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {',
      '  shadowCoord.xyz /= shadowCoord.w;',
      '  shadowCoord.z += shadowBias;',
      '  bvec4 iv = bvec4(shadowCoord.x>=0.,shadowCoord.x<=1.,shadowCoord.y>=0.,shadowCoord.y<=1.);',
      '  if (!all(iv) || shadowCoord.z > 1.0) return 1.0;',
      '  vec2 ts = vec2(1.0)/shadowMapSize;',
      '  float z = shadowCoord.z;',
      '  float bsum=0.; int bcnt=0;',
      '  for(int i=0;i<17;i++){',
      '    float d=unpackRGBAToDepth(texture2D(shadowMap,shadowCoord.xy+PCSS_PD[i]*('+ls+'*ts.x)));',
      '    if(d<z-0.001){bsum+=d;bcnt++;}',
      '  }',
      '  if(bcnt==0) return 1.0;',
      '  float avgB=bsum/float(bcnt);',
      '  float fr=((z-avgB)/avgB)*('+ls+'*ts.x);',
      '  float shadow=0.;',
      '  for(int i=0;i<17;i++){',
      '    shadow+=step(z,unpackRGBAToDepth(texture2D(shadowMap,shadowCoord.xy+PCSS_PD[i]*fr)));',
      '  }',
      '  return mix(1., shadow/17., shadowIntensity);',
      '}',
    ].join('\n');

    material.onBeforeCompile = function(shader) {
      var fs = shader.fragmentShader;
      // Find the DEFINITION (before void main) not a call site
      var mainIdx = fs.indexOf('void main()');
      var start = mainIdx > 0 ? fs.lastIndexOf('float getShadow(', mainIdx) : fs.indexOf('float getShadow(');
      if (start === -1) return; // material has no shadow sampling
      // Brace-count to find end of function (robust against nested if/for)
      var i = fs.indexOf('{', start);
      if (i === -1) return;
      var depth = 0;
      for (; i < fs.length; i++) {
        if (fs[i] === '{') depth++;
        else if (fs[i] === '}') { if (--depth === 0) break; }
      }
      shader.fragmentShader = fs.slice(0, start) + pcssFunc + fs.slice(i + 1);
    };
    material.needsUpdate = true;
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildFlyLine — sliding gradient signal along a Catmull-Rom tube
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildFlyLine(THREE, scene, opts) → { mesh, update(t), setSpeed(v), setColor(hex), setGlowColor(hex), dispose() }
   *
   * Builds a TubeGeometry along a Catmull-Rom spline and applies a ShaderMaterial
   * with a sliding glowing window — the "signal travelling through a fiber" look.
   * Call update(t) each frame to advance the animation.
   *
   * opts:
   *   points       Array<[x,y,z]>  control points — default gentle S-curve
   *   radius       (m)   tube thickness — default 0.05
   *   segments     (int) tube resolution along length — default 80
   *   color        hex   trail body color — default '#00ff88'
   *   glowColor    hex   bright leading edge color — default '#ffffff'
   *   trailLength  0-1   fraction of tube lit at once — default 0.25
   *   speed        s⁻¹   loops per second — default 0.4
   *   opacity      0-1   max opacity — default 1.0
   *   addToScene   bool  auto-add mesh to scene — default true
   *
   * Example:
   *   const fly = buildFlyLine(THREE, scene, {
   *     points: [[-5,0,0],[0,3,0],[5,0,0]],
   *     color: '#00aaff', glowColor: '#ffffff', speed: 0.5
   *   })
   *   // In update: fly.update(t)
   */
  w.buildFlyLine = function(T, scene, opts) {
    if (!T) T = window.THREE;
    opts = opts || {};

    var pts = (opts.points || [[-5,0,0],[-2,3,-1],[0,1,2],[3,4,0],[5,0,0]])
      .map(function(p){ return new T.Vector3(p[0],p[1],p[2]); });

    var curve      = new T.CatmullRomCurve3(pts);
    var segments   = opts.segments    !== undefined ? opts.segments   : 80;
    var radius     = opts.radius      !== undefined ? opts.radius     : 0.05;
    var trailLength = opts.trailLength !== undefined ? opts.trailLength : 0.25;
    var speed       = opts.speed      !== undefined ? opts.speed      : 0.4;

    var geo = new T.TubeGeometry(curve, segments, radius, 8, false);

    var mat = new T.ShaderMaterial({
      uniforms: {
        color:      { value: new T.Color(opts.color     || '#00ff88') },
        glowColor:  { value: new T.Color(opts.glowColor || '#ffffff') },
        head:       { value: 0.0 },
        trailLen:   { value: trailLength },
        opacity:    { value: opts.opacity !== undefined ? opts.opacity : 1.0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: [
        'uniform vec3 color, glowColor;',
        'uniform float head, trailLen, opacity;',
        'varying vec2 vUv;',
        'void main(){',
        '  float u = vUv.x;',                // 0=curve start, 1=curve end
        '  float tail = head - trailLen;',
        '  float inWindow;',
        '  if(tail >= 0.0){',
        '    inWindow = step(tail, u) * step(u, head);',
        '  } else {',
        '    // window wraps around 0/1 boundary',
        '    inWindow = max(step(tail+1.0, u), step(u, head));',
        '  }',
        '  if(inWindow < 0.5) discard;',
        '  // gradient: 0=at tail(dim), 1=at head(bright)',
        '  float distFromHead = mod(head - u + 1.0, 1.0);',
        '  float grad = 1.0 - clamp(distFromHead / max(trailLen, 0.001), 0.0, 1.0);',
        '  vec3 c = mix(color * 0.4, glowColor, grad * grad);',
        '  gl_FragColor = vec4(c, grad * opacity);',
        '}',
      ].join('\n'),
      transparent: true,
      depthWrite:  false,
      side: T.DoubleSide,
    });

    var mesh = new T.Mesh(geo, mat);
    if (opts.addToScene !== false) scene.add(mesh);

    return {
      mesh: mesh,
      update: function(t) {
        mat.uniforms.head.value = ((t * speed) % 1.0 + 1.0) % 1.0;
      },
      setSpeed:     function(v) { speed = v; },
      setColor:     function(c) { mat.uniforms.color.value.set(c); },
      setGlowColor: function(c) { mat.uniforms.glowColor.value.set(c); },
      dispose:      function() {
        geo.dispose(); mat.dispose();
        if (mesh.parent) mesh.parent.remove(mesh);
      },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildTrailPath — scrub-safe reveal trail along a pre-defined path
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildTrailPath(THREE, scene, keyframes, opts) → { mesh, update(t), setColor, dispose }
   *
   * Draws a ribbon trail that reveals itself progressively as t increases.
   * Scrub-safe — deterministic at any t. Great for missile paths, drawing-on
   * arrows, and animated connectors.
   *
   * keyframes: [{t, pos:[x,y,z]}, ...] sorted ascending by scene time
   *
   * opts:
   *   width    (m)   ribbon half-width  default 0.12
   *   color    hex                      default '#ffffff'
   *   opacity  0-1                      default 0.9
   *   ease     string  easing per segment  default 'linear'
   */
  w.buildTrailPath = function(T, scene, keyframes, opts) {
    opts = opts || {};
    if (!keyframes || keyframes.length < 2) { console.warn('[Studio3D] buildTrailPath: need >=2 keyframes'); return null; }
    var width   = opts.width   !== undefined ? opts.width   : 0.12;
    var color   = opts.color   || '#ffffff';
    var opacity = opts.opacity !== undefined ? opts.opacity : 0.9;

    var n = keyframes.length;
    // 2 verts per keyframe point, 3 floats each
    var verts  = new Float32Array(n * 2 * 3);
    var uvArr  = new Float32Array(n * 2 * 2);
    var idxArr = [];
    for (var i = 0; i < n - 1; i++) {
      var b = i * 2;
      idxArr.push(b, b+1, b+2, b+2, b+1, b+3);
    }
    var geo      = new T.BufferGeometry();
    var posAttr  = new T.BufferAttribute(verts, 3);
    var uvAttr   = new T.BufferAttribute(uvArr, 2);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('uv',       uvAttr);
    geo.setIndex(idxArr);

    var mat = new T.MeshBasicMaterial({
      color: new T.Color(color), transparent: true, opacity: opacity,
      side: T.DoubleSide, depthWrite: false,
    });
    var mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false;
    if (scene) scene.add(mesh);

    // Pre-compute cumulative lengths for progress mapping
    var totLen = 0;
    var lens = [0];
    for (var j = 1; j < n; j++) {
      var dx = keyframes[j].pos[0]-keyframes[j-1].pos[0];
      var dy = keyframes[j].pos[1]-keyframes[j-1].pos[1];
      var dz = keyframes[j].pos[2]-keyframes[j-1].pos[2];
      totLen += Math.sqrt(dx*dx+dy*dy+dz*dz);
      lens.push(totLen);
    }

    var _up = new T.Vector3(0, 1, 0);

    return {
      mesh: mesh,
      update: function(t) {
        var tStart = keyframes[0].t, tEnd = keyframes[n-1].t;
        var prog = tEnd > tStart ? clamp((t - tStart) / (tEnd - tStart), 0, 1) : 1;
        var targetLen = prog * totLen;
        var pos = posAttr.array;

        for (var i = 0; i < n; i++) {
          var ptLen = lens[i];
          var kp = keyframes[i].pos;
          var alive = ptLen <= targetLen ? 1 : 0;

          // Compute side vector (ribbon orientation)
          var fwd = new T.Vector3();
          if (i < n-1) {
            var np = keyframes[i+1].pos;
            fwd.set(np[0]-kp[0], np[1]-kp[1], np[2]-kp[2]).normalize();
          } else if (i > 0) {
            var pp = keyframes[i-1].pos;
            fwd.set(kp[0]-pp[0], kp[1]-pp[1], kp[2]-pp[2]).normalize();
          } else { fwd.set(0,0,1); }

          var side = new T.Vector3().crossVectors(fwd, _up).normalize().multiplyScalar(width * alive);
          var base = i * 6;
          pos[base]   = kp[0]-side.x; pos[base+1] = kp[1]-side.y; pos[base+2] = kp[2]-side.z;
          pos[base+3] = kp[0]+side.x; pos[base+4] = kp[1]+side.y; pos[base+5] = kp[2]+side.z;
          var u = totLen > 0 ? ptLen / totLen : i / (n-1);
          uvArr[i*4]   = u; uvArr[i*4+1] = 0;
          uvArr[i*4+2] = u; uvArr[i*4+3] = 1;
        }
        posAttr.needsUpdate = true;
        uvAttr.needsUpdate  = true;
      },
      setColor:   function(c) { mat.color.set(c); },
      setOpacity: function(o) { mat.opacity = o; },
      dispose:    function() { geo.dispose(); mat.dispose(); if (mesh.parent) mesh.parent.remove(mesh); },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildInstancedLines — GPU-instanced edge network (hundreds of tubes, 1 draw call)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildInstancedLines(THREE, scene, pairs, opts) → { mesh, update(newPairs), setColor, dispose }
   *
   * Render hundreds of point-to-point tubes in ONE draw call using InstancedMesh.
   * Much faster than creating one buildConnectionLine per edge.
   *
   * pairs: Array of [[x1,y1,z1],[x2,y2,z2]]  — one entry per line
   *
   * opts:
   *   radius    (m)   tube radius    default 0.03
   *   color     hex                  default '#ffffff'
   *   roughness 0-1                  default 0.35
   *   metalness 0-1                  default 0.6
   *   opacity   0-1                  default 1.0
   */
  w.buildInstancedLines = function(T, scene, pairs, opts) {
    opts = opts || {};
    if (!pairs || pairs.length === 0) { console.warn('[Studio3D] buildInstancedLines: pairs array required'); return null; }
    var count     = pairs.length;
    var radius    = opts.radius    !== undefined ? opts.radius    : 0.03;
    var color     = opts.color     || '#ffffff';
    var roughness = opts.roughness !== undefined ? opts.roughness : 0.35;
    var metalness = opts.metalness !== undefined ? opts.metalness : 0.6;
    var opacity   = opts.opacity   !== undefined ? opts.opacity   : 1.0;

    var geo = new T.CylinderGeometry(radius, radius, 1, 6, 1);
    // Pivot at bottom so we can position at pointA and scale to length
    var posArr = geo.attributes.position.array;
    for (var vi = 0; vi < posArr.length; vi += 3) posArr[vi+1] += 0.5;
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingBox();

    var mat = new T.MeshStandardMaterial({
      color: new T.Color(color), roughness: roughness, metalness: metalness,
      transparent: opacity < 1, opacity: opacity,
    });

    var mesh = new T.InstancedMesh(geo, mat, count);
    mesh.castShadow    = opts.castShadow    || false;
    mesh.receiveShadow = opts.receiveShadow || false;
    var dummy = new T.Object3D();
    var _up   = new T.Vector3(0, 1, 0);

    function applyPair(i, pair) {
      var a = new T.Vector3(pair[0][0], pair[0][1], pair[0][2]);
      var b = new T.Vector3(pair[1][0], pair[1][1], pair[1][2]);
      var dir = new T.Vector3().subVectors(b, a);
      var len = dir.length();
      dummy.position.copy(a);
      dummy.scale.set(1, Math.max(0.0001, len), 1);
      if (len > 0.0001) dummy.quaternion.setFromUnitVectors(_up, dir.normalize());
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }

    for (var i = 0; i < count; i++) applyPair(i, pairs[i]);
    mesh.instanceMatrix.needsUpdate = true;
    if (scene) scene.add(mesh);

    return {
      mesh: mesh,
      /** Update all pairs at once (call when pairs data changes) */
      update: function(newPairs) {
        var nc = Math.min(newPairs.length, count);
        for (var i = 0; i < nc; i++) applyPair(i, newPairs[i]);
        mesh.instanceMatrix.needsUpdate = true;
      },
      /** Update a single pair by index */
      updateOne: function(i, pair) { applyPair(i, pair); mesh.instanceMatrix.needsUpdate = true; },
      setColor:   function(c) { mat.color.set(c); },
      setOpacity: function(o) { mat.opacity = o; mat.transparent = o < 1; },
      dispose:    function() { geo.dispose(); mat.dispose(); if (mesh.parent) mesh.parent.remove(mesh); },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildExplosion — scrub-safe one-shot additive particle burst
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildExplosion(THREE, scene, opts) → { burst(pos, triggerT), update(t), setColor, dispose }
   *
   * One-shot additive particle burst. Scrub-safe: pass the scene time `t` when
   * calling `burst(pos, t)` — `update(t)` computes particle state from `t - triggerT`.
   *
   * opts:
   *   count    int     particle count      default 80
   *   speed    m/s     outward velocity    default 6
   *   duration s       fade-out time       default 1.8
   *   size     m       point size          default 0.14
   *   color    hex                         default '#ff8833'
   *   seed     int     determinism seed    default 1
   */
  w.buildExplosion = function(T, scene, opts) {
    opts = opts || {};
    var count    = opts.count    !== undefined ? opts.count    : 80;
    var speed    = opts.speed    !== undefined ? opts.speed    : 6;
    var duration = opts.duration !== undefined ? opts.duration : 1.8;
    var sz       = opts.size     !== undefined ? opts.size     : 0.14;
    var color    = opts.color    || '#ff8833';
    var seed     = opts.seed     || 1;

    var vels = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var rng   = mulberry32(i * 997 + seed);
      var theta = Math.acos(2 * rng() - 1);
      var phi   = 6.28318 * rng();
      var spd   = speed * (0.4 + rng() * 0.6);
      vels[i*3]   = Math.sin(theta) * Math.cos(phi) * spd;
      vels[i*3+1] = Math.sin(theta) * Math.sin(phi) * spd;
      vels[i*3+2] = Math.cos(theta) * spd;
    }

    var geo     = new T.BufferGeometry();
    var posAttr = new T.BufferAttribute(new Float32Array(count * 3), 3);
    geo.setAttribute('position', posAttr);

    var mat = new T.PointsMaterial({
      color: new T.Color(color), size: sz,
      transparent: true, opacity: 1,
      sizeAttenuation: true, depthWrite: false,
      blending: T.AdditiveBlending,
    });

    var mesh    = new T.Points(geo, mat);
    mesh.visible = false;
    if (scene) scene.add(mesh);

    var _triggerT  = null;
    var _origin    = [0, 0, 0];

    return {
      mesh: mesh,
      /**
       * Trigger a burst at world position `pos` at scene time `triggerT`.
       * Pass the current scene `t` so the burst is scrub-safe.
       */
      burst: function(pos, triggerT) {
        _origin   = pos || [0, 0, 0];
        _triggerT = triggerT !== undefined ? triggerT : 0;
        mesh.visible = true;
      },
      update: function(t) {
        if (_triggerT === null) return;
        var dt = t - _triggerT;
        if (dt < 0) { mesh.visible = false; return; }
        if (dt > duration * 1.2) { mesh.visible = false; return; }
        mesh.visible = true;
        var prog = clamp(dt / duration, 0, 1);
        mat.opacity = Math.max(0, 1 - prog * prog * 1.2);
        var pos = posAttr.array;
        for (var i = 0; i < count; i++) {
          var drag = Math.exp(-dt * 1.8);
          pos[i*3]   = _origin[0] + vels[i*3]   * dt * drag;
          pos[i*3+1] = _origin[1] + vels[i*3+1] * dt * drag - dt * dt * 3.5;
          pos[i*3+2] = _origin[2] + vels[i*3+2] * dt * drag;
        }
        posAttr.needsUpdate = true;
      },
      setColor: function(c) { mat.color.set(c); },
      dispose:  function() { geo.dispose(); mat.dispose(); if (mesh.parent) mesh.parent.remove(mesh); },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildFlatFloor — PBR visible floor (marble, concrete, dark, wood styles)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildFlatFloor(THREE, scene, opts) → { mesh, material, update(t), dispose }
   *
   * A visible PBR floor plane. Uses buildMagicMarbleMaterial for 'marble' style,
   * MeshStandardMaterial for others. Receives shadows.
   *
   * opts:
   *   style     string  'concrete'|'dark'|'marble'|'wood'  default 'concrete'
   *   size      m       plane size (both axes)               default 200
   *   y         m       world Y position                     default -2.5
   *   color1    hex     marble color1 (marble style only)
   *   color2    hex     marble color2 (marble style only)
   */
  w.buildFlatFloor = function(T, scene, opts) {
    opts = opts || {};
    var style = opts.style || 'concrete';
    var size  = opts.size  !== undefined ? opts.size  : 200;
    var y     = opts.y     !== undefined ? opts.y     : -2.5;

    var mat;
    if (style === 'marble' && w.buildMagicMarbleMaterial) {
      mat = w.buildMagicMarbleMaterial(T, {
        color1: opts.color1 || '#f5f0e8',
        color2: opts.color2 || '#2a1808',
        scale: opts.scale || 2.5,
        roughness: 0.08,
        animated: opts.animated !== false,
      });
    } else {
      var presets = {
        concrete: { color: '#b0a898', roughness: 0.92, metalness: 0.0 },
        dark:     { color: '#1a1818', roughness: 0.65, metalness: 0.15 },
        wood:     { color: '#8b5e3c', roughness: 0.82, metalness: 0.0 },
      };
      var p = presets[style] || presets.concrete;
      mat = new T.MeshStandardMaterial({
        color: new T.Color(opts.color || p.color),
        roughness: opts.roughness !== undefined ? opts.roughness : p.roughness,
        metalness: opts.metalness !== undefined ? opts.metalness : p.metalness,
      });
    }

    var geo  = new T.PlaneGeometry(size, size, 1, 1);
    var mesh = new T.Mesh(geo, mat);
    mesh.rotation.x  = -Math.PI / 2;
    mesh.position.y  = y;
    mesh.receiveShadow = true;
    if (scene) scene.add(mesh);

    return {
      mesh:     mesh,
      material: mat,
      update:   function(t) { if (mat.userData && mat.userData.update) mat.userData.update(t); },
      dispose:  function() { geo.dispose(); mat.dispose(); if (mesh.parent) mesh.parent.remove(mesh); },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildLightShaft — volumetric god ray / dust shaft
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildLightShaft(THREE, scene, opts) → { cone, dust, update(t), setOpacity, setColor, dispose }
   *
   * Additive cone mesh + floating dust particles simulate a volumetric light shaft.
   * No raymarching — pure mesh + shader. Great for studio spotlights and window shafts.
   *
   * opts:
   *   origin     [x,y,z]  apex of the shaft            default [0, 8, 0]
   *   direction  [x,y,z]  shaft direction (normalized)  default [0, -1, 0]
   *   length     m        shaft depth                   default 12
   *   angle      rad      cone half-angle               default 0.15
   *   color      hex                                    default '#fffbe8'
   *   opacity    0-0.5                                  default 0.12
   *   dustCount  int      floating dust particles       default 200
   */
  w.buildLightShaft = function(T, scene, opts) {
    opts = opts || {};
    var origin    = opts.origin    || [0, 8, 0];
    var dirArr    = opts.direction || [0, -1, 0];
    var length    = opts.length    !== undefined ? opts.length    : 12;
    var angle     = opts.angle     !== undefined ? opts.angle     : 0.15;
    var color     = opts.color     || '#fffbe8';
    var opacity   = opts.opacity   !== undefined ? opts.opacity   : 0.12;
    var dustCount = opts.dustCount !== undefined ? opts.dustCount : 200;

    var baseR = length * Math.tan(angle);
    var coneGeo = new T.ConeGeometry(baseR, length, 16, 8, true);
    // Pivot at APEX (tip of cone): apex at local y=0, base at local y=-length.
    // ConeGeometry default: apex at +length/2, base at -length/2.
    // Subtract length/2 so apex moves to y=0.
    var cpa = coneGeo.attributes.position.array;
    for (var vi = 0; vi < cpa.length; vi += 3) cpa[vi+1] -= length * 0.5;
    coneGeo.attributes.position.needsUpdate = true;

    var coneMat = new T.ShaderMaterial({
      uniforms: {
        uColor:   { value: new T.Color(color) },
        uOpacity: { value: opacity },
        time:     { value: 0 },
      },
      vertexShader: [
        'varying float vFade;',
        'void main() {',
        // apex=y=0 (near source, bright), base=y=-length (far end, transparent)
        '  vFade = clamp(1.0 + position.y / ' + length.toFixed(2) + ', 0.0, 1.0);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uOpacity, time;',
        'varying float vFade;',
        'void main() {',
        '  float flicker = 0.92 + sin(time * 3.7) * 0.04 + sin(time * 11.3) * 0.02;',
        '  gl_FragColor = vec4(uColor, uOpacity * vFade * vFade * flicker);',
        '}',
      ].join('\n'),
      transparent: true, depthWrite: false, side: T.FrontSide,
      blending: T.AdditiveBlending,
    });

    var cone = new T.Mesh(coneGeo, coneMat);
    cone.position.set(origin[0], origin[1], origin[2]);
    var dirV = new T.Vector3(dirArr[0], dirArr[1], dirArr[2]).normalize();
    cone.quaternion.setFromUnitVectors(new T.Vector3(0, -1, 0), dirV);
    if (scene) scene.add(cone);

    // Dust particles inside the shaft volume
    var dustBase = new Float32Array(dustCount * 3);
    var dustSeeds = new Float32Array(dustCount * 3);
    for (var di = 0; di < dustCount; di++) {
      var rng2 = mulberry32(di * 1234 + 77);
      var u2 = rng2(), v2 = rng2(), h2 = rng2();
      var dr = baseR * h2 * Math.sqrt(u2);
      var da = 6.28318 * v2;
      dustBase[di*3]   = Math.cos(da) * dr;
      dustBase[di*3+1] = -h2 * length;
      dustBase[di*3+2] = Math.sin(da) * dr;
      dustSeeds[di*3]   = rng2() * 6.28318;
      dustSeeds[di*3+1] = rng2() * 6.28318;
      dustSeeds[di*3+2] = rng2() * 0.08 + 0.01;
    }

    var dustGeo  = new T.BufferGeometry();
    var dustAttr = new T.BufferAttribute(new Float32Array(dustCount * 3), 3);
    dustGeo.setAttribute('position', dustAttr);
    var dustMat = new T.PointsMaterial({
      color: new T.Color(color), size: 0.025,
      transparent: true, opacity: Math.min(1, opacity * 5),
      sizeAttenuation: true, depthWrite: false, blending: T.AdditiveBlending,
    });
    var dustMesh = new T.Points(dustGeo, dustMat);
    dustMesh.position.copy(cone.position);
    dustMesh.quaternion.copy(cone.quaternion);
    if (scene) scene.add(dustMesh);

    return {
      cone: cone,
      dust: dustMesh,
      update: function(t) {
        coneMat.uniforms.time.value = t;
        var arr = dustAttr.array;
        for (var i = 0; i < dustCount; i++) {
          var rise = (t * dustSeeds[i*3+2] + dustSeeds[i*3+1]) % length;
          arr[i*3]   = dustBase[i*3]   + Math.sin(t * 0.4 + dustSeeds[i*3]) * 0.06;
          arr[i*3+1] = -(((dustBase[i*3+1] * -1) + rise) % length);
          arr[i*3+2] = dustBase[i*3+2] + Math.cos(t * 0.4 + dustSeeds[i*3+1]) * 0.06;
        }
        dustAttr.needsUpdate = true;
      },
      setOpacity: function(o) {
        coneMat.uniforms.uOpacity.value = o;
        dustMat.opacity = Math.min(1, o * 5);
        opacity = o;
      },
      setColor: function(c) {
        coneMat.uniforms.uColor.value.set(c);
        dustMat.color.set(c);
      },
      dispose: function() {
        coneGeo.dispose(); coneMat.dispose();
        dustGeo.dispose(); dustMat.dispose();
        if (cone.parent) cone.parent.remove(cone);
        if (dustMesh.parent) dustMesh.parent.remove(dustMesh);
      },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // buildMorphBetween — animated vertex morph between two geometries
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * buildMorphBetween(THREE, scene, geoA, geoB, opts) → { mesh, update(t), setProgress, dispose }
   *
   * Animates a smooth vertex-level shape change from geoA to geoB using Three.js morph targets.
   * Both geometries MUST have the same vertex count.
   *
   * opts:
   *   duration   s      morph time              default 2.0
   *   ease       string easing                  default 'smooth'
   *   color      hex    material color          default 0x4488ff
   *   roughness  0-1                            default 0.4
   *   metalness  0-1                            default 0.3
   *   position   [x,y,z]
   */
  w.buildMorphBetween = function(T, scene, geoA, geoB, opts) {
    opts = opts || {};
    var posA = geoA.attributes.position.array;
    var posB = geoB.attributes.position.array;
    if (posB.length !== posA.length) {
      console.warn('[Studio3D] buildMorphBetween: geometries must have equal vertex count (' + posA.length/3 + ' vs ' + posB.length/3 + ')');
      return null;
    }

    var morphGeo = geoA.clone();
    morphGeo.morphAttributes.position = [new T.BufferAttribute(new Float32Array(posB), 3)];
    morphGeo.morphTargetsRelative = false;

    var mat = new T.MeshStandardMaterial({
      color:     new T.Color(opts.color     !== undefined ? opts.color     : 0x4488ff),
      roughness: opts.roughness !== undefined ? opts.roughness : 0.4,
      metalness: opts.metalness !== undefined ? opts.metalness : 0.3,
      morphTargets: true,
    });

    var mesh = new T.Mesh(morphGeo, mat);
    mesh.castShadow    = opts.castShadow    !== false;
    mesh.receiveShadow = opts.receiveShadow || false;
    if (opts.position) mesh.position.set(opts.position[0], opts.position[1], opts.position[2]);
    if (scene) scene.add(mesh);

    var dur = opts.duration !== undefined ? opts.duration : 2.0;
    var eas = opts.ease     || 'smooth';

    return {
      mesh: mesh,
      update: function(t) {
        mesh.morphTargetInfluences[0] = applyEasing(clamp(t / dur, 0, 1), eas);
      },
      setProgress: function(p) { mesh.morphTargetInfluences[0] = clamp(p, 0, 1); },
      dispose: function() { morphGeo.dispose(); mat.dispose(); if (mesh.parent) mesh.parent.remove(mesh); },
    };
  };


  // ─────────────────────────────────────────────────────────────────────────────
  // DEPTH OF FIELD
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * applyDepthOfField(renderer, scene, camera, opts?) → dof
   *
   * Post-processing depth of field via Circle of Confusion + separable bokeh blur.
   * Renders the scene internally. Use instead of (or chained from) applyPostFX.
   *
   * opts:
   *   focusDistance  number   world-space focus depth in units  (default 5)
   *   aperture       number   blur scale factor (larger = more blur) (default 0.1)
   *   maxBlur        number   max blur radius in UV space (0.0–0.05) (default 0.018)
   *   blurPasses     number   H+V pass count (1=fast, 2=smooth, 3=softest) (default 2)
   *   debugCoC       boolean  visualize CoC map (default false)
   *
   * Returns:
   *   { render(t), setFocus(dist), setAperture(v), setMaxBlur(v), dispose() }
   *
   * Example (ThreeJSLayer setup):
   *   var dof = applyDepthOfField(renderer, scene, camera, { focusDistance: 6, aperture: 0.15 });
   *   // In update: dof.render(t);
   *   // Animate focus rack: dof.setFocus(interpolate(t,[0,1],[8,3]));
   */
  w.applyDepthOfField = function(renderer, scene, camera, opts) {
    opts = opts || {};
    var T = window.THREE;
    if (!T) { console.warn('[Studio3D] applyDepthOfField: THREE not loaded'); return null; }
    if (!T.DepthTexture) { console.warn('[Studio3D] applyDepthOfField: THREE.DepthTexture not available'); return null; }

    var focusDistance = opts.focusDistance !== undefined ? opts.focusDistance : 5.0;
    var aperture      = opts.aperture      !== undefined ? opts.aperture      : 0.1;
    var maxBlur       = opts.maxBlur       !== undefined ? opts.maxBlur       : 0.018;
    var blurPasses    = opts.blurPasses    !== undefined ? opts.blurPasses    : 2;
    var debugCoC      = opts.debugCoC      || false;

    var W = renderer.domElement.width  || 1920;
    var H = renderer.domElement.height || 1080;
    var bW = Math.max(1, Math.floor(W / 2));
    var bH = Math.max(1, Math.floor(H / 2));

    // Full-res color + depth render target
    var depthTex = new T.DepthTexture(W, H);
    var colorRT = new T.WebGLRenderTarget(W, H, {
      depthBuffer: true,
      depthTexture: depthTex,
      type: T.HalfFloatType,
      minFilter: T.LinearFilter,
      magFilter: T.LinearFilter,
      format: T.RGBAFormat,
    });

    var rtOpts = { minFilter: T.LinearFilter, magFilter: T.LinearFilter, format: T.RGBAFormat };
    var blurRT1 = new T.WebGLRenderTarget(bW, bH, rtOpts);
    var blurRT2 = new T.WebGLRenderTarget(bW, bH, rtOpts);

    var fsCamera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var fsGeo    = new T.PlaneGeometry(2, 2);
    var vsSimple = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

    // Pass 1: per-pixel CoC (circle of confusion) → stores result in alpha channel
    var cocMat = new T.ShaderMaterial({
      uniforms: {
        tColor:        { value: null },
        tDepth:        { value: null },
        focusDistance: { value: focusDistance },
        aperture:      { value: aperture },
        maxBlur:       { value: maxBlur },
        nearPlane:     { value: camera.near },
        farPlane:      { value: camera.far },
        debugCoC:      { value: debugCoC ? 1 : 0 },
      },
      vertexShader: vsSimple,
      fragmentShader: [
        'uniform sampler2D tColor, tDepth;',
        'uniform float focusDistance, aperture, maxBlur, nearPlane, farPlane;',
        'uniform int debugCoC;',
        'varying vec2 vUv;',
        'float linearDepth(float d) {',
        '  float z = d * 2.0 - 1.0;',
        '  return (2.0 * nearPlane * farPlane) / (farPlane + nearPlane - z * (farPlane - nearPlane));',
        '}',
        'void main() {',
        '  float rawDepth = texture2D(tDepth, vUv).r;',
        '  float depth = linearDepth(rawDepth);',
        '  float coc = clamp(abs(depth - focusDistance) * aperture / max(depth, 0.001), 0.0, maxBlur);',
        '  if (debugCoC == 1) { gl_FragColor = vec4(coc / max(maxBlur, 0.0001), 0.0, 1.0 - coc / max(maxBlur, 0.0001), 1.0); return; }',
        '  gl_FragColor = vec4(texture2D(tColor, vUv).rgb, coc);',
        '}',
      ].join('\n'),
    });

    // Pass 2: separable 9-tap Gaussian bokeh — blur radius driven by CoC in alpha
    var bokehMat = new T.ShaderMaterial({
      uniforms: {
        tDiffuse:   { value: null },
        resolution: { value: new T.Vector2(bW, bH) },
        dir:        { value: new T.Vector2(1, 0) },
      },
      vertexShader: vsSimple,
      fragmentShader: [
        'uniform sampler2D tDiffuse; uniform vec2 resolution, dir; varying vec2 vUv;',
        'void main() {',
        '  vec4 center = texture2D(tDiffuse, vUv);',
        '  float coc = center.a;',
        '  if (coc < 0.00005) { gl_FragColor = center; return; }',
        '  vec2 step = dir * coc / resolution;',
        '  float w0=0.0508, w1=0.0918, w2=0.1227, w3=0.1927, w4=0.2240;',
        '  vec4 c = vec4(0.0);',
        '  c += texture2D(tDiffuse, vUv - step*4.0) * w0;',
        '  c += texture2D(tDiffuse, vUv - step*3.0) * w1;',
        '  c += texture2D(tDiffuse, vUv - step*2.0) * w2;',
        '  c += texture2D(tDiffuse, vUv - step*1.0) * w3;',
        '  c += texture2D(tDiffuse, vUv           ) * w4;',
        '  c += texture2D(tDiffuse, vUv + step*1.0) * w3;',
        '  c += texture2D(tDiffuse, vUv + step*2.0) * w2;',
        '  c += texture2D(tDiffuse, vUv + step*3.0) * w1;',
        '  c += texture2D(tDiffuse, vUv + step*4.0) * w0;',
        '  gl_FragColor = vec4(c.rgb, coc);',
        '}',
      ].join('\n'),
    });

    // Pass 3: composite sharp (full-res) and blurred (half-res) — blend driven by CoC
    var dofCompMat = new T.ShaderMaterial({
      uniforms: {
        tSharp:        { value: null },
        tBlur:         { value: null },
        tDepth:        { value: null },
        focusDistance: { value: focusDistance },
        aperture:      { value: aperture },
        maxBlur:       { value: maxBlur },
        nearPlane:     { value: camera.near },
        farPlane:      { value: camera.far },
      },
      vertexShader: vsSimple,
      fragmentShader: [
        'uniform sampler2D tSharp, tBlur, tDepth;',
        'uniform float focusDistance, aperture, maxBlur, nearPlane, farPlane;',
        'varying vec2 vUv;',
        'float linearDepth(float d) {',
        '  float z = d * 2.0 - 1.0;',
        '  return (2.0 * nearPlane * farPlane) / (farPlane + nearPlane - z * (farPlane - nearPlane));',
        '}',
        'void main() {',
        '  float rawDepth = texture2D(tDepth, vUv).r;',
        '  float depth = linearDepth(rawDepth);',
        '  float coc = clamp(abs(depth - focusDistance) * aperture / max(depth, 0.001), 0.0, maxBlur);',
        '  float blend = smoothstep(0.0, maxBlur * 0.4, coc);',
        '  vec3 sharp  = texture2D(tSharp, vUv).rgb;',
        '  vec3 blurry = texture2D(tBlur,  vUv).rgb;',
        '  gl_FragColor = vec4(mix(sharp, blurry, blend), 1.0);',
        '}',
      ].join('\n'),
    });

    function makePassScene(mat) {
      var s = new T.Scene();
      s.add(new T.Mesh(fsGeo, mat));
      return s;
    }
    var cocScene  = makePassScene(cocMat);
    var blurScene = makePassScene(bokehMat);
    var compScene = makePassScene(dofCompMat);

    var dof = {
      render: function() {
        var prevAutoClear = renderer.autoClear;
        renderer.autoClear = true;

        // 1. Render scene to full-res color+depth
        renderer.setRenderTarget(colorRT);
        renderer.render(scene, camera);

        // 2. CoC pass → half-res blurRT1 (color in rgb, coc in alpha)
        cocMat.uniforms.tColor.value    = colorRT.texture;
        cocMat.uniforms.tDepth.value    = depthTex;
        cocMat.uniforms.nearPlane.value = camera.near;
        cocMat.uniforms.farPlane.value  = camera.far;
        renderer.setRenderTarget(blurRT1);
        renderer.render(cocScene, fsCamera);

        // 3. Separable bokeh blur (H then V, repeated blurPasses times)
        for (var i = 0; i < blurPasses; i++) {
          bokehMat.uniforms.tDiffuse.value = blurRT1.texture;
          bokehMat.uniforms.dir.value.set(1, 0);
          renderer.setRenderTarget(blurRT2);
          renderer.render(blurScene, fsCamera);

          bokehMat.uniforms.tDiffuse.value = blurRT2.texture;
          bokehMat.uniforms.dir.value.set(0, 1);
          renderer.setRenderTarget(blurRT1);
          renderer.render(blurScene, fsCamera);
        }

        // 4. Composite: full-res sharp mixed with half-res blur, weighted by CoC
        dofCompMat.uniforms.tSharp.value       = colorRT.texture;
        dofCompMat.uniforms.tBlur.value        = blurRT1.texture;
        dofCompMat.uniforms.tDepth.value       = depthTex;
        dofCompMat.uniforms.nearPlane.value    = camera.near;
        dofCompMat.uniforms.farPlane.value     = camera.far;
        renderer.setRenderTarget(null);
        renderer.render(compScene, fsCamera);

        renderer.autoClear = prevAutoClear;
      },

      setFocus: function(distance) {
        focusDistance = distance;
        cocMat.uniforms.focusDistance.value    = distance;
        dofCompMat.uniforms.focusDistance.value = distance;
      },

      setAperture: function(v) {
        aperture = v;
        cocMat.uniforms.aperture.value    = v;
        dofCompMat.uniforms.aperture.value = v;
      },

      setMaxBlur: function(v) {
        maxBlur = v;
        cocMat.uniforms.maxBlur.value    = v;
        dofCompMat.uniforms.maxBlur.value = v;
      },

      dispose: function() {
        colorRT.dispose(); depthTex.dispose();
        blurRT1.dispose(); blurRT2.dispose();
        cocMat.dispose(); bokehMat.dispose(); dofCompMat.dispose();
        fsGeo.dispose();
        if (scene.userData.__dreambyteDoF === this) delete scene.userData.__dreambyteDoF;
      },
    };

    scene.userData.__dreambyteDoF = dof;
    return dof;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildProceduralTerrain — noise-displaced PlaneGeometry with auto-materials
  // Returns { mesh, update(t) }. update(t) animates flow if animated:true.
  // opts: { width, depth, segments, height, color, animated, flow, wireframe, metalness, roughness }
  w.buildProceduralTerrain = function(T, scene, opts) {
    opts = opts || {};
    var W = opts.width || 20, D = opts.depth || 20;
    var segs = opts.segments || 64;
    var maxH = opts.height || 2;
    var animated = opts.animated !== false;
    var flowSpeed = opts.flow || 0.3;
    var wireframe = opts.wireframe || false;
    var geo = new T.PlaneGeometry(W, D, segs, segs);
    geo.rotateX(-Math.PI / 2);
    var posArr = geo.attributes.position.array;
    var originY = new Float32Array(posArr.length / 3);
    // Store flat Y for animation reference
    for (var i = 0; i < posArr.length / 3; i++) originY[i] = posArr[i * 3 + 1];
    // Noise helper (value noise via sin)
    function noise2(x, z) {
      var n = Math.sin(x * 1.7 + z * 2.3) * 0.5
            + Math.sin(x * 3.1 - z * 1.9) * 0.25
            + Math.sin(x * 0.8 + z * 4.7) * 0.125
            + Math.sin(x * 5.3 + z * 0.7) * 0.0625;
      return n / 0.9375;
    }
    // Initial displacement
    for (var i = 0; i < posArr.length / 3; i++) {
      var x = posArr[i * 3], z = posArr[i * 3 + 2];
      posArr[i * 3 + 1] = originY[i] + noise2(x * 0.4, z * 0.4) * maxH;
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    var mat;
    if (wireframe) {
      mat = new T.MeshBasicMaterial({ color: opts.color || 0x00ff88, wireframe: true });
    } else {
      mat = new T.MeshStandardMaterial({
        color: opts.color || 0x2a6a44,
        metalness: opts.metalness != null ? opts.metalness : 0.0,
        roughness: opts.roughness != null ? opts.roughness : 0.85,
        side: T.DoubleSide,
      });
    }
    var mesh = new T.Mesh(geo, mat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return {
      mesh: mesh,
      update: function(t) {
        if (!animated) return;
        var phase = t * flowSpeed;
        var pa = geo.attributes.position.array;
        for (var i = 0; i < pa.length / 3; i++) {
          var x = pa[i * 3], z = pa[i * 3 + 2];
          pa[i * 3 + 1] = originY[i] + noise2(x * 0.4 + phase, z * 0.4 + phase * 0.7) * maxH;
        }
        geo.attributes.position.needsUpdate = true;
        geo.computeVertexNormals();
      },
      dispose: function() { geo.dispose(); mat.dispose(); scene.remove(mesh); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildCloudField — sprite-based volumetric cloud/fog (billboard quads)
  // Returns { group, update(t) }. Clouds slowly drift and pulse opacity.
  // opts: { count, spread, height, color, opacity, size, drift }
  w.buildCloudField = function(T, scene, opts) {
    opts = opts || {};
    var count = opts.count || 30;
    var spread = opts.spread || 15;
    var h = opts.height != null ? opts.height : 3;
    var color = opts.color != null ? opts.color : 0xffffff;
    var baseOpacity = opts.opacity != null ? opts.opacity : 0.18;
    var size = opts.size || 4;
    var drift = opts.drift != null ? opts.drift : 0.5;
    var group = new T.Group();
    var clouds = [];
    var geo = new T.PlaneGeometry(1, 1);
    for (var i = 0; i < count; i++) {
      var mat = new T.MeshBasicMaterial({
        color: color, transparent: true,
        opacity: baseOpacity * (0.5 + Math.random() * 0.5),
        depthWrite: false, side: T.DoubleSide,
      });
      var m = new T.Mesh(geo, mat);
      var sx = (0.6 + Math.random() * 0.8) * size;
      var sy = (0.4 + Math.random() * 0.5) * size;
      m.scale.set(sx, sy, 1);
      m.position.set(
        (Math.random() - 0.5) * spread * 2,
        h + (Math.random() - 0.5) * size * 0.5,
        (Math.random() - 0.5) * spread * 2
      );
      m.rotation.y = Math.random() * Math.PI;
      m.userData._phase = Math.random() * Math.PI * 2;
      m.userData._dx = (Math.random() - 0.5) * 0.01 * drift;
      m.userData._dz = (Math.random() - 0.5) * 0.01 * drift;
      group.add(m);
      clouds.push(m);
    }
    scene.add(group);
    return {
      group: group,
      update: function(t, camera) {
        for (var i = 0; i < clouds.length; i++) {
          var c = clouds[i];
          if (camera) c.quaternion.copy(camera.quaternion);
          c.position.x += c.userData._dx;
          c.position.z += c.userData._dz;
          // Wrap within spread
          if (Math.abs(c.position.x) > spread) c.position.x *= -0.9;
          if (Math.abs(c.position.z) > spread) c.position.z *= -0.9;
          c.material.opacity = baseOpacity * (0.6 + 0.4 * Math.sin(t * 0.4 + c.userData._phase));
        }
      },
      dispose: function() { geo.dispose(); clouds.forEach(function(c) { c.material.dispose(); }); scene.remove(group); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildVideoTexture — load a video URL as a Three.js texture for geometry
  // Returns { texture, video, mesh? }. Pass mesh:true to get a plane with it applied.
  // opts: { loop, muted, autoplay, width, height, planeWidth, planeHeight, position }
  w.buildVideoTexture = function(T, url, opts) {
    opts = opts || {};
    var video = document.createElement('video');
    video.src = url;
    video.loop = opts.loop !== false;
    video.muted = opts.muted !== false;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    if (opts.autoplay !== false) video.play().catch(function() {});
    var texture = new T.VideoTexture(video);
    texture.colorSpace = T.SRGBColorSpace || 'srgb';
    var result = { texture: texture, video: video };
    if (opts.scene) {
      var pw = opts.planeWidth || 16, ph = opts.planeHeight || 9;
      var geo = new T.PlaneGeometry(pw, ph);
      var mat = new T.MeshBasicMaterial({ map: texture, side: T.DoubleSide });
      var mesh = new T.Mesh(geo, mat);
      if (opts.position) mesh.position.fromArray(opts.position);
      opts.scene.add(mesh);
      result.mesh = mesh;
      result.mat = mat;
      result.geo = geo;
    }
    result.dispose = function() {
      video.pause(); video.src = '';
      texture.dispose();
      if (result.geo) result.geo.dispose();
      if (result.mat) result.mat.dispose();
    };
    return result;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildGifTexture — animated GIF as a Three.js texture
  //
  // The browser advances animated GIFs natively when bound to an <img>. We
  // render that <img> to an offscreen canvas every rAF tick and feed the
  // canvas into a CanvasTexture. This avoids shipping a GIF decoder for the
  // common "ambient looping clip" use case.
  //
  // Trade-off vs. buildVideoTexture: GIFs are NOT timeline-scrubbable — the
  // browser's GIF decoder runs on its own clock and we cannot seek to a
  // specific frame. For frame-accurate sync, transcode the GIF to MP4 and
  // use buildVideoTexture instead.
  //
  // buildGifTexture(THREE, url, opts?) → { texture, image, canvas, mesh?, update, dispose }
  //   opts: { scene?, planeWidth?: 4, planeHeight?: 4, position?, transparent?: true,
  //           autoUpdate?: true, onLoad?, onError? }
  w.buildGifTexture = function (T, url, opts) {
    if (!T) { console.warn('[buildGifTexture] window.THREE not loaded'); return null; }
    if (!url) throw new Error('[buildGifTexture] requires a url');
    opts = opts || {};

    var img = new Image();
    img.crossOrigin = 'anonymous';

    var canvas = document.createElement('canvas');
    // Allocate at 1×1 until the GIF reports its real dimensions — avoids a
    // visible flash of placeholder pixels if the texture is bound before load.
    canvas.width = 1;
    canvas.height = 1;
    var ctx2d = canvas.getContext('2d');

    var texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace || 'srgb';
    texture.minFilter = T.LinearFilter;
    texture.magFilter = T.LinearFilter;
    texture.generateMipmaps = false;

    var loaded = false;
    var disposed = false;
    var rafId = 0;

    function paint() {
      if (disposed || !loaded) return;
      // Draw the (browser-animated) GIF frame into our canvas. The browser
      // advances the GIF on its own; drawImage samples whatever frame is
      // currently visible in the <img>.
      ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      texture.needsUpdate = true;
    }

    function loop() {
      paint();
      if (!disposed && opts.autoUpdate !== false) {
        rafId = requestAnimationFrame(loop);
      }
    }

    img.onload = function () {
      loaded = true;
      canvas.width = img.naturalWidth || 1;
      canvas.height = img.naturalHeight || 1;
      paint();
      if (opts.autoUpdate !== false) loop();
      if (typeof opts.onLoad === 'function') {
        try { opts.onLoad(img); } catch (e) {}
      }
    };
    img.onerror = function (e) {
      console.warn('[buildGifTexture] failed to load "' + url + '"');
      if (typeof opts.onError === 'function') {
        try { opts.onError(e); } catch (err) {}
      }
    };
    img.src = url;

    var result = { texture: texture, image: img, canvas: canvas, update: paint };

    if (opts.scene) {
      var pw = opts.planeWidth || 4;
      var ph = opts.planeHeight || 4;
      var geo = new T.PlaneGeometry(pw, ph);
      var mat = new T.MeshBasicMaterial({
        map: texture,
        side: T.DoubleSide,
        transparent: opts.transparent !== false,
      });
      var mesh = new T.Mesh(geo, mat);
      if (opts.position) mesh.position.fromArray(opts.position);
      opts.scene.add(mesh);
      result.mesh = mesh;
      result.material = mat;
      result.geometry = geo;
    }

    result.dispose = function () {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      img.onload = null;
      img.onerror = null;
      img.src = '';
      texture.dispose();
      if (result.geometry) result.geometry.dispose();
      if (result.material) result.material.dispose();
      if (result.mesh && result.mesh.parent) result.mesh.parent.remove(result.mesh);
    };

    return result;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildProjectedMaterial — slide-projector material (texture projected from a camera)
  //
  // Adapted from marcofugaro/three-projected-material (MIT). Source inlined because
  // the lib's `import * as THREE from 'three'` doesn't fit Dreambyte's window-global SDK
  // pattern. Class is built lazily and memoized on the THREE namespace.
  //
  // Use cases: video on a curved/3D screen, logo wrapped on a product mesh, multi-
  // projector lighting (gobos), per-instance decals on InstancedMesh.
  //
  // buildProjectedMaterial(T, { camera, texture, ... }) → ProjectedMaterial
  //   Pass a PerspectiveCamera or OrthographicCamera as the projector and any
  //   THREE.Texture (incl. VideoTexture). Other opts forward to MeshPhysicalMaterial:
  //     textureScale (default 1), textureOffset (Vector2), backgroundOpacity (default 1),
  //     cover (default false → 'contain'-style; true → 'cover'-style),
  //     plus color/roughness/metalness/envMap/transparent/etc.
  //   On the returned material:
  //     mat.project(mesh)             — bake the projection snapshot for `mesh`
  //     mat.allocateProjectionData(geometry, count) — instanced setup (call before InstancedMesh ctor)
  //     mat.projectInstanceAt(i, instMesh, dummyMatrix) — instanced projection per-element
  //   Move the mesh or camera freely after project(); call project() again to reproject.

  function _ensureProjectedMaterialClass(T) {
    if (T.__dreambyteProjectedMaterial) return T.__dreambyteProjectedMaterial;

    function _monkeyPatch(shader, opts) {
      var defines = opts.defines || {};
      var header = opts.header || '';
      var main = opts.main || '';
      var patched = shader;
      Object.keys(opts).forEach(function (k) {
        if (k === 'defines' || k === 'header' || k === 'main') return;
        var before = patched;
        patched = patched.split(k).join(opts[k]);
        if (before === patched) {
          // Replacement anchor not found — Three.js shader chunks may have changed.
          console.warn('[buildProjectedMaterial] shader replacement anchor not found:', k.slice(0, 60));
        }
      });
      var anchor = 'void main() {';
      if (patched.indexOf(anchor) === -1) {
        console.warn('[buildProjectedMaterial] shader has no "void main() {" — header/main inserts skipped (Three.js chunk format may have changed)');
      } else {
        patched = patched.replace(anchor, '\n' + header + '\nvoid main() {\n' + main + '\n');
      }
      var defineStr = Object.keys(defines).map(function (d) {
        return '#define ' + d + ' ' + defines[d];
      }).join('\n');
      return defineStr + '\n' + patched;
    }

    // Returns "loaded" when the texture has decoded pixel data we can sample from.
    // For images: needs naturalWidth > 0 (actual decode, not just <img> tag existence).
    // For videos: needs videoWidth > 0 (first frame decoded).
    // For canvas / generated: image is present and width is set.
    function _isTextureReady(texture) {
      var img = texture && texture.image;
      if (!img) return false;
      if (img.videoWidth !== undefined && img.videoHeight !== undefined) {
        // Video element — wait for first frame
        return img.videoWidth > 0 && img.videoHeight > 0;
      }
      if (img.naturalWidth !== undefined) {
        // <img> element — wait for decode
        return img.naturalWidth > 0;
      }
      // CanvasTexture / DataTexture / fallback — assume ready
      return img.width > 0 || img.complete;
    }

    // Polls until the texture is ready, then fires callback. Returns the interval id
    // so the caller can cancel (dispose, texture swap). Stops polling after MAX_WAIT
    // so a permanently-broken texture (404, blocked) doesn't leak forever.
    var MAX_WAIT_MS = 10000;
    function _addLoadListener(texture, callback) {
      if (_isTextureReady(texture)) {
        callback(texture);
        return null;
      }
      var startedAt = Date.now();
      var iv = setInterval(function () {
        if (_isTextureReady(texture)) {
          clearInterval(iv);
          callback(texture);
          return;
        }
        if (Date.now() - startedAt > MAX_WAIT_MS) {
          clearInterval(iv);
          console.warn('[buildProjectedMaterial] texture failed to load within ' + MAX_WAIT_MS + 'ms — giving up');
        }
      }, 50);
      return iv;
    }

    function _getCameraRatio(camera) {
      if (camera.isPerspectiveCamera) return camera.aspect;
      if (camera.isOrthographicCamera) {
        var width = Math.abs(camera.right - camera.left);
        var height = Math.abs(camera.top - camera.bottom);
        return width / height;
      }
      throw new Error('[buildProjectedMaterial] unsupported camera type: ' + camera.type);
    }

    function _computeScaledDimensions(texture, camera, textureScale, cover) {
      if (!texture.image) return [1, 1];
      if (texture.image.videoWidth === 0 && texture.image.videoHeight === 0) return [1, 1];
      // .width / .height fallback handles HTMLCanvasElement and OffscreenCanvas
      // — neither has naturalWidth/videoWidth, and clientWidth is 0 when offscreen.
      // Without this fallback, sw/sh = 0, ratio = NaN, UV remap math blows up.
      var sw = texture.image.naturalWidth || texture.image.videoWidth || texture.image.clientWidth || texture.image.width;
      var sh = texture.image.naturalHeight || texture.image.videoHeight || texture.image.clientHeight || texture.image.height;
      var ratio = sw / sh;
      var ratioCamera = _getCameraRatio(camera);
      var widthCamera = 1, heightCamera = 1 / ratioCamera;
      var widthScaled, heightScaled;
      if (cover ? ratio > ratioCamera : ratio < ratioCamera) {
        var width = heightCamera * ratio;
        widthScaled = 1 / ((width / widthCamera) * textureScale);
        heightScaled = 1 / textureScale;
      } else {
        var height = widthCamera * (1 / ratio);
        heightScaled = 1 / ((height / heightCamera) * textureScale);
        widthScaled = 1 / textureScale;
      }
      return [widthScaled, heightScaled];
    }

    var ProjectedMaterial = class extends T.MeshPhysicalMaterial {
      constructor(opts) {
        opts = opts || {};
        var camera = opts.camera || new T.PerspectiveCamera();
        var texture = opts.texture || new T.Texture();
        var textureScale = opts.textureScale != null ? opts.textureScale : 1;
        var textureOffset = opts.textureOffset || new T.Vector2();
        var backgroundOpacity = opts.backgroundOpacity != null ? opts.backgroundOpacity : 1;
        var cover = !!opts.cover;
        var passthrough = {};
        Object.keys(opts).forEach(function (k) {
          if (['camera', 'texture', 'textureScale', 'textureOffset', 'backgroundOpacity', 'cover'].indexOf(k) === -1) {
            passthrough[k] = opts[k];
          }
        });

        if (!texture.isTexture) throw new Error('[buildProjectedMaterial] invalid texture');
        if (!camera.isCamera) throw new Error('[buildProjectedMaterial] invalid camera');
        if (backgroundOpacity < 1 && !passthrough.transparent) {
          console.warn('[buildProjectedMaterial] pass transparent:true to use backgroundOpacity');
        }

        super(passthrough);

        Object.defineProperty(this, 'isProjectedMaterial', { value: true });
        this._camera = camera;
        this._cover = cover;
        this._textureScale = textureScale;

        var dims = _computeScaledDimensions(texture, camera, textureScale, cover);

        this.uniforms = {
          projectedTexture: { value: texture },
          isTextureLoaded: { value: Boolean(texture.image) },
          isTextureProjected: { value: false },
          backgroundOpacity: { value: backgroundOpacity },
          viewMatrixCamera: { value: new T.Matrix4() },
          projectionMatrixCamera: { value: new T.Matrix4() },
          projPosition: { value: new T.Vector3() },
          projDirection: { value: new T.Vector3(0, 0, -1) },
          savedModelMatrix: { value: new T.Matrix4() },
          widthScaled: { value: dims[0] },
          heightScaled: { value: dims[1] },
          textureOffset: { value: textureOffset },
        };

        var self = this;
        this._loadInterval = null;
        this.onBeforeCompile = function (shader) {
          Object.assign(self.uniforms, shader.uniforms);
          shader.uniforms = self.uniforms;
          if (self._camera.isOrthographicCamera) shader.defines.ORTHOGRAPHIC = '';

          // Detect sRGB textures so we can convert to linear inside the shader.
          // Three.js auto-injects this for `map` samples but our custom texture2D
          // call is opaque to the renderer's color-management. Without this fix,
          // VideoTexture (which Dreambyte's buildVideoTexture tags as sRGB) and any
          // sRGB-tagged image render washed out / over-bright.
          var tex = self.uniforms.projectedTexture.value;
          var SRGB = T.SRGBColorSpace || 'srgb';
          // Match against the resolved string token AND the raw constant in case Three exposes both.
          // T.sRGBEncoding is the legacy r-pre-152 enum; check defensively.
          var sRGBEncoding = T.sRGBEncoding;
          var isSRGB = !!tex && (tex.colorSpace === SRGB || (sRGBEncoding != null && tex.encoding === sRGBEncoding));
          if (isSRGB) shader.defines.PROJECTED_SRGB = '';

          shader.vertexShader = _monkeyPatch(shader.vertexShader, {
            header: [
              'uniform mat4 viewMatrixCamera;',
              'uniform mat4 projectionMatrixCamera;',
              '#ifdef USE_INSTANCING',
              'attribute vec4 savedModelMatrix0;',
              'attribute vec4 savedModelMatrix1;',
              'attribute vec4 savedModelMatrix2;',
              'attribute vec4 savedModelMatrix3;',
              '#else',
              'uniform mat4 savedModelMatrix;',
              '#endif',
              'varying vec3 vSavedNormal;',
              'varying vec4 vTexCoords;',
              '#ifndef ORTHOGRAPHIC',
              'varying vec4 vWorldPosition;',
              '#endif',
            ].join('\n'),
            main: [
              '#ifdef USE_INSTANCING',
              'mat4 savedModelMatrix = mat4(savedModelMatrix0, savedModelMatrix1, savedModelMatrix2, savedModelMatrix3);',
              '#endif',
              'vSavedNormal = mat3(savedModelMatrix) * normal;',
              'vTexCoords = projectionMatrixCamera * viewMatrixCamera * savedModelMatrix * vec4(position, 1.0);',
              '#ifndef ORTHOGRAPHIC',
              'vWorldPosition = savedModelMatrix * vec4(position, 1.0);',
              '#endif',
            ].join('\n'),
          });

          shader.fragmentShader = _monkeyPatch(shader.fragmentShader, {
            header: [
              'uniform sampler2D projectedTexture;',
              'uniform bool isTextureLoaded;',
              'uniform bool isTextureProjected;',
              'uniform float backgroundOpacity;',
              'uniform vec3 projPosition;',
              'uniform vec3 projDirection;',
              'uniform float widthScaled;',
              'uniform float heightScaled;',
              'uniform vec2 textureOffset;',
              'varying vec3 vSavedNormal;',
              'varying vec4 vTexCoords;',
              '#ifndef ORTHOGRAPHIC',
              'varying vec4 vWorldPosition;',
              '#endif',
              'float mapRange(float value, float min1, float max1, float min2, float max2) {',
              '  return min2 + (value - min1) * (max2 - min2) / (max1 - min1);',
              '}',
            ].join('\n'),
            'vec4 diffuseColor = vec4( diffuse, opacity );': [
              'float w = max(vTexCoords.w, 0.0);',
              'vec2 uv = (vTexCoords.xy / w) * 0.5 + 0.5;',
              'uv += textureOffset;',
              'uv.x = mapRange(uv.x, 0.0, 1.0, 0.5 - widthScaled / 2.0, 0.5 + widthScaled / 2.0);',
              'uv.y = mapRange(uv.y, 0.0, 1.0, 0.5 - heightScaled / 2.0, 0.5 + heightScaled / 2.0);',
              'bool isInTexture = (max(uv.x, uv.y) <= 1.0 && min(uv.x, uv.y) >= 0.0);',
              '#ifdef ORTHOGRAPHIC',
              'vec3 projectorDirection = projDirection;',
              '#else',
              'vec3 projectorDirection = normalize(projPosition - vWorldPosition.xyz);',
              '#endif',
              'float dotProduct = dot(vSavedNormal, projectorDirection);',
              'bool isFacingProjector = dotProduct > 0.0000001;',
              'vec4 diffuseColor = vec4(diffuse, opacity * backgroundOpacity);',
              'if (isFacingProjector && isInTexture && isTextureLoaded && isTextureProjected) {',
              '  vec4 textureColor = texture2D(projectedTexture, uv);',
              '  #ifdef PROJECTED_SRGB',
              // sRGB → linear so the rest of the standard chain (tone-mapping → sRGB
              // output) renders the texture's perceived colors. Without this branch
              // an sRGB-tagged texture gets treated as linear and looks washed out.
              '    textureColor.rgb = pow(textureColor.rgb, vec3(2.2));',
              '  #endif',
              '  textureColor.a *= opacity;',
              '  diffuseColor = textureColor * textureColor.a + diffuseColor * (1.0 - textureColor.a);',
              '}',
            ].join('\n'),
          });
        };

        this._saveCameraProjectionMatrix = function () {
          self.uniforms.projectionMatrixCamera.value.copy(self._camera.projectionMatrix);
          self._saveDimensions();
        };
        this._saveDimensions = function () {
          var d = _computeScaledDimensions(self.uniforms.projectedTexture.value, self._camera, self._textureScale, self._cover);
          self.uniforms.widthScaled.value = d[0];
          self.uniforms.heightScaled.value = d[1];
        };
        window.addEventListener('resize', this._saveCameraProjectionMatrix);

        this._loadInterval = _addLoadListener(texture, function () {
          self._loadInterval = null;
          self.uniforms.isTextureLoaded.value = true;
          self.dispatchEvent({ type: 'textureload' });
          self._saveDimensions();
        });
      }

      get camera() { return this._camera; }
      set camera(c) {
        if (!c || !c.isCamera) throw new Error('[buildProjectedMaterial] invalid camera');
        if (c.type !== this._camera.type) throw new Error('[buildProjectedMaterial] cannot change camera type');
        this._camera = c;
        this._saveDimensions();
      }
      get texture() { return this.uniforms.projectedTexture.value; }
      set texture(t) {
        if (!t || !t.isTexture) throw new Error('[buildProjectedMaterial] invalid texture');
        // Cancel any in-flight load poll for the previous texture so we don't
        // accumulate intervals when the user swaps textures repeatedly.
        if (this._loadInterval) { clearInterval(this._loadInterval); this._loadInterval = null; }
        this.uniforms.projectedTexture.value = t;
        var ready = _isTextureReady(t);
        this.uniforms.isTextureLoaded.value = ready;
        // Mark needs-recompile so PROJECTED_SRGB define re-evaluates against the new texture.
        this.needsUpdate = true;
        var self = this;
        if (!ready) {
          this._loadInterval = _addLoadListener(t, function () {
            self._loadInterval = null;
            self.uniforms.isTextureLoaded.value = true;
            self.dispatchEvent({ type: 'textureload' });
            self._saveDimensions();
          });
        } else {
          this._saveDimensions();
        }
      }
      get textureScale() { return this._textureScale; }
      set textureScale(v) { this._textureScale = v; this._saveDimensions(); }
      get textureOffset() { return this.uniforms.textureOffset.value; }
      set textureOffset(v) { this.uniforms.textureOffset.value = v; }
      get backgroundOpacity() { return this.uniforms.backgroundOpacity.value; }
      set backgroundOpacity(v) {
        this.uniforms.backgroundOpacity.value = v;
        if (v < 1 && !this.transparent) console.warn('[buildProjectedMaterial] pass transparent:true for backgroundOpacity');
      }
      get cover() { return this._cover; }
      set cover(v) { this._cover = v; this._saveDimensions(); }

      _saveCameraMatrices() {
        this._camera.updateProjectionMatrix();
        this._camera.updateMatrixWorld();
        this._camera.updateWorldMatrix();
        this.uniforms.viewMatrixCamera.value.copy(this._camera.matrixWorldInverse);
        this.uniforms.projectionMatrixCamera.value.copy(this._camera.projectionMatrix);
        this.uniforms.projPosition.value.setFromMatrixPosition(this._camera.matrixWorld);
        this.uniforms.projDirection.value.set(0, 0, 1).applyMatrix4(this._camera.matrixWorld);
        this.uniforms.isTextureProjected.value = true;
      }

      project(mesh) {
        var mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!mats.some(function (m) { return m.isProjectedMaterial; })) {
          throw new Error('[buildProjectedMaterial] mesh material is not a ProjectedMaterial');
        }
        if (!mats.some(function (m) { return m === this; }, this)) {
          throw new Error('[buildProjectedMaterial] mesh material differs from where project() was called');
        }
        mesh.updateWorldMatrix(true, false);
        this.uniforms.savedModelMatrix.value.copy(mesh.matrixWorld);
        if (Array.isArray(mesh.material)) {
          var idx = mesh.material.indexOf(this);
          if (!mesh.material[idx].transparent) {
            console.warn('[buildProjectedMaterial] pass transparent:true when using multiple materials');
          }
          if (idx > 0) this.uniforms.backgroundOpacity.value = 0;
        }
        this._saveCameraMatrices();
      }

      allocateProjectionData(geometry, count) {
        var keys = ['savedModelMatrix0', 'savedModelMatrix1', 'savedModelMatrix2', 'savedModelMatrix3'];
        keys.forEach(function (k) {
          geometry.setAttribute(k, new T.InstancedBufferAttribute(new Float32Array(count * 4), 4));
        });
      }

      projectInstanceAt(index, instancedMesh, matrixWorld, opts) {
        opts = opts || {};
        if (!instancedMesh.isInstancedMesh) throw new Error('[buildProjectedMaterial] not an InstancedMesh');
        var mats = Array.isArray(instancedMesh.material) ? instancedMesh.material : [instancedMesh.material];
        if (!mats.every(function (m) { return m.isProjectedMaterial; })) {
          throw new Error('[buildProjectedMaterial] InstancedMesh material is not ProjectedMaterial');
        }
        var attrs = instancedMesh.geometry.attributes;
        if (!attrs.savedModelMatrix0 || !attrs.savedModelMatrix1 || !attrs.savedModelMatrix2 || !attrs.savedModelMatrix3) {
          throw new Error('[buildProjectedMaterial] call allocateProjectionData(geometry, count) first');
        }
        var e = matrixWorld.elements;
        attrs.savedModelMatrix0.setXYZW(index, e[0], e[1], e[2], e[3]);
        attrs.savedModelMatrix1.setXYZW(index, e[4], e[5], e[6], e[7]);
        attrs.savedModelMatrix2.setXYZW(index, e[8], e[9], e[10], e[11]);
        attrs.savedModelMatrix3.setXYZW(index, e[12], e[13], e[14], e[15]);
        if (Array.isArray(instancedMesh.material)) {
          var idx = instancedMesh.material.indexOf(this);
          if (!instancedMesh.material[idx].transparent) {
            console.warn('[buildProjectedMaterial] pass transparent:true when using multiple materials');
          }
          if (idx > 0) this.uniforms.backgroundOpacity.value = 0;
        }
        if (index === 0 || opts.forceCameraSave) this._saveCameraMatrices();
      }

      copy(source) {
        super.copy(source);
        this.camera = source.camera;
        this.texture = source.texture;
        this.textureScale = source.textureScale;
        this.textureOffset = source.textureOffset;
        this.cover = source.cover;
        return this;
      }

      dispose() {
        super.dispose();
        window.removeEventListener('resize', this._saveCameraProjectionMatrix);
        if (this._loadInterval) { clearInterval(this._loadInterval); this._loadInterval = null; }
      }
    };

    T.__dreambyteProjectedMaterial = ProjectedMaterial;
    return ProjectedMaterial;
  }

  w.buildProjectedMaterial = function (T, opts) {
    if (!T) { console.warn('[buildProjectedMaterial] window.THREE not loaded'); return null; }
    var Cls = _ensureProjectedMaterialClass(T);
    return new Cls(opts || {});
  };

  // Convenience: allocate instanced projection data without holding a material instance.
  w.allocateProjectionData = function (T, geometry, count) {
    if (!T || !geometry) return;
    var keys = ['savedModelMatrix0', 'savedModelMatrix1', 'savedModelMatrix2', 'savedModelMatrix3'];
    keys.forEach(function (k) {
      geometry.setAttribute(k, new T.InstancedBufferAttribute(new Float32Array(count * 4), 4));
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildSpriteAtlas / buildLabel3D — dynamic 3D text labels backed by a shared atlas
  //
  // Dreambyte-native equivalent of Leeft/three-sprite-texture-atlas-manager (MIT) — a
  // simpler shelf-packer instead of binary-tree knapsack since text labels are
  // ~uniform in height. One canvas → one GPU upload → many sprites with sub-UV
  // textures sharing the upload via the .uuid trick.
  //
  // Use cases: callouts on 3D meshes, step numbers, axis labels, character name
  // tags, annotations on technical diagrams. Replaces the awkward TextGeometry
  // path (no font loading, no kerning issues, no per-mesh GPU cost).
  //
  // buildSpriteAtlas(T, { size = 1024, debug = false }) → atlas
  //   atlas.label3D(text, opts) → THREE.Sprite
  //     opts: { font, fontSize, fontWeight, color, bgColor, padding,
  //             paddingX, paddingY, borderColor, borderWidth, radius,
  //             worldHeight (default 0.6) — sprite world-space height in 3D units,
  //             position: [x,y,z], scale, anchor: 'center'|'top'|'bottom',
  //             depthTest (default true) }
  //   atlas.releaseLabel(sprite)  // free the slot for re-allocation
  //   atlas.flush()               // mark texture for GPU re-upload after batch updates
  //   atlas.dispose()             // free GPU resources
  //
  // buildLabel3D(T, text, opts)
  // buildLabel3D(T, atlas, text, opts)   — explicit atlas instead of shared
  //   Convenience: same signature as label3D but lazily creates a shared per-T
  //   global atlas if you don't pass one. All labels still share GPU memory.

  function _ensureSpriteAtlasClass(T) {
    if (T.__dreambyteSpriteAtlas) return T.__dreambyteSpriteAtlas;

    var SpriteAtlas = class {
      constructor(opts) {
        opts = opts || {};
        this.size = opts.size || 1024;
        this.debug = !!opts.debug;

        this.canvas = document.createElement('canvas');
        this.canvas.width = this.canvas.height = this.size;
        this.ctx = this.canvas.getContext('2d');

        // Master texture — every label gets a clone with its own .offset / .repeat,
        // and we copy the master's .uuid onto each clone so Three.js shares the GPU
        // upload across all of them.
        this.texture = new T.CanvasTexture(this.canvas);
        if ('colorSpace' in this.texture) this.texture.colorSpace = T.SRGBColorSpace || 'srgb';
        this.texture.minFilter = T.LinearFilter;
        this.texture.magFilter = T.LinearFilter;
        this.texture.generateMipmaps = false;

        // Shelf packer state
        this._shelfX = 0;
        this._shelfY = 0;
        this._shelfH = 0;
        this._slots = [];

        if (this.debug) {
          this.ctx.fillStyle = '#1a1a28';
          this.ctx.fillRect(0, 0, this.size, this.size);
        }
      }

      // Reserve a w×h rectangle in the canvas. Returns { x, y, w, h } pixel coords.
      _reserve(w, h) {
        if (w > this.size || h > this.size) {
          throw new Error('[buildSpriteAtlas] requested ' + w + 'x' + h + ' exceeds atlas size ' + this.size);
        }
        if (this._shelfX + w > this.size) {
          this._shelfY += this._shelfH;
          this._shelfX = 0;
          this._shelfH = 0;
        }
        if (this._shelfY + h > this.size) {
          throw new Error('[buildSpriteAtlas] atlas full — increase size (current: ' + this.size + ')');
        }
        var slot = { x: this._shelfX, y: this._shelfY, w: w, h: h };
        this._shelfX += w;
        if (h > this._shelfH) this._shelfH = h;
        return slot;
      }

      label3D(text, opts) {
        opts = opts || {};
        var fontFamily = opts.font || 'sans-serif';
        var fontSize = opts.fontSize || 64;
        var fontWeight = opts.fontWeight || 'bold';
        var color = opts.color || '#ffffff';
        var bgColor = opts.bgColor || null;
        var padX = opts.paddingX != null ? opts.paddingX : (opts.padding != null ? opts.padding : 16);
        var padY = opts.paddingY != null ? opts.paddingY : (opts.padding != null ? opts.padding : 10);
        var borderColor = opts.borderColor || null;
        var borderWidth = opts.borderWidth || 0;
        var radius = opts.radius != null ? opts.radius : (bgColor ? 8 : 0);

        var fontStr = fontWeight + ' ' + fontSize + 'px ' + fontFamily;
        this.ctx.font = fontStr;
        var metrics = this.ctx.measureText(text);
        var textW = Math.ceil(metrics.width);
        var textH = fontSize;
        var slotW = textW + padX * 2 + borderWidth * 2;
        var slotH = textH + padY * 2 + borderWidth * 2;

        var slot = this._reserve(slotW, slotH);
        var ctx = this.ctx;
        ctx.clearRect(slot.x, slot.y, slot.w, slot.h);

        if (bgColor) {
          ctx.fillStyle = bgColor;
          if (radius > 0) {
            this._roundRect(slot.x, slot.y, slot.w, slot.h, radius);
            ctx.fill();
          } else {
            ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
          }
        }
        if (borderColor && borderWidth > 0) {
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = borderWidth;
          if (radius > 0) {
            this._roundRect(slot.x + borderWidth / 2, slot.y + borderWidth / 2,
                            slot.w - borderWidth, slot.h - borderWidth, radius);
            ctx.stroke();
          } else {
            ctx.strokeRect(slot.x + borderWidth / 2, slot.y + borderWidth / 2,
                           slot.w - borderWidth, slot.h - borderWidth);
          }
        }
        ctx.font = fontStr;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, slot.x + slot.w / 2, slot.y + slot.h / 2);

        if (this.debug) {
          ctx.strokeStyle = 'rgba(0, 255, 0, 0.7)';
          ctx.lineWidth = 1;
          ctx.strokeRect(slot.x + 0.5, slot.y + 0.5, slot.w - 1, slot.h - 1);
        }

        this.texture.needsUpdate = true;

        // Per-sprite cloned texture pointing at the sub-rectangle.
        var subTex = this.texture.clone();
        subTex.uuid = this.texture.uuid;
        subTex.needsUpdate = false;
        // CanvasTexture flipY = true → V=0 maps to canvas bottom, V=1 to canvas top.
        var u0 = slot.x / this.size;
        var v0 = 1 - (slot.y + slot.h) / this.size;
        var uW = slot.w / this.size;
        var vH = slot.h / this.size;
        subTex.offset.set(u0, v0);
        subTex.repeat.set(uW, vH);

        var spriteMat = new T.SpriteMaterial({
          map: subTex,
          transparent: true,
          depthWrite: false,
          depthTest: opts.depthTest !== false,
        });
        var sprite = new T.Sprite(spriteMat);

        var worldH = opts.worldHeight != null ? opts.worldHeight : 0.6;
        var worldW = worldH * (slot.w / slot.h);
        sprite.scale.set(worldW, worldH, 1);

        if (opts.position) sprite.position.fromArray(opts.position);
        if (opts.scale != null) sprite.scale.multiplyScalar(opts.scale);

        if (opts.anchor === 'top') sprite.center.set(0.5, 1);
        else if (opts.anchor === 'bottom') sprite.center.set(0.5, 0);

        sprite.userData._dreambyteAtlasSlot = slot;
        sprite.userData._dreambyteAtlasSubTex = subTex;
        this._slots.push({ slot: slot, sprite: sprite });

        return sprite;
      }

      _roundRect(x, y, w, h, r) {
        var ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      }

      flush() { this.texture.needsUpdate = true; }

      releaseLabel(sprite) {
        var s = sprite && sprite.userData && sprite.userData._dreambyteAtlasSlot;
        if (!s) return;
        this.ctx.clearRect(s.x, s.y, s.w, s.h);
        if (sprite.material) sprite.material.dispose();
        if (sprite.userData._dreambyteAtlasSubTex) sprite.userData._dreambyteAtlasSubTex.dispose();
        this.texture.needsUpdate = true;
      }

      dispose() {
        if (this.texture) this.texture.dispose();
        this._slots.forEach(function (s) {
          if (s.sprite && s.sprite.material) s.sprite.material.dispose();
        });
        this._slots.length = 0;
      }
    };

    T.__dreambyteSpriteAtlas = SpriteAtlas;
    return SpriteAtlas;
  }

  w.buildSpriteAtlas = function (T, opts) {
    if (!T) { console.warn('[buildSpriteAtlas] window.THREE not loaded'); return null; }
    var Cls = _ensureSpriteAtlasClass(T);
    return new Cls(opts || {});
  };

  w.buildLabel3D = function (T, atlasOrText, textOrOpts, maybeOpts) {
    if (!T) { console.warn('[buildLabel3D] window.THREE not loaded'); return null; }
    var atlas, text, opts;
    if (atlasOrText && typeof atlasOrText === 'object' && typeof atlasOrText.label3D === 'function') {
      atlas = atlasOrText; text = textOrOpts; opts = maybeOpts || {};
    } else {
      if (!T.__dreambyteSharedSpriteAtlas) {
        T.__dreambyteSharedSpriteAtlas = w.buildSpriteAtlas(T, { size: 2048 });
      }
      atlas = T.__dreambyteSharedSpriteAtlas; text = atlasOrText; opts = textOrOpts || {};
    }
    return atlas.label3D(text, opts);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // mergeTextures — pack many textures into one POW2 atlas
  //
  // Dreambyte-native equivalent of oguzeroglu/TextureMerger (MIT). Cuts draw calls
  // when a 3D scene has many small distinct textures (uploaded stickers, per-
  // bar chart images, 12+ logos on planes). Inputs MUST be already-loaded
  // textures — use mergeTexturesAsync if any might still be decoding.
  //
  // mergeTextures(T, { brick: tex1, marble: tex2, concrete: tex3 }, opts)
  //   → { texture, ranges, makeTexture, applyToGeometry, dispose }
  //   ranges.brick = { x, y, w, h, u0, v0, u1, v1 }  // pixel + UV coords
  //
  // mergeTextures(T, [tex1, tex2, tex3])  // array form → numeric keys 0/1/2
  //
  // opts: { size?: number,        // explicit POW2 atlas size; auto if omitted
  //         padding?: number,     // gap between slots in px (default 1)
  //         background?: string,  // canvas fill color before draw (default transparent)
  //         debug?: boolean }     // outline each slot
  //
  // Methods:
  //   .makeTexture(key)               → cloned texture w/ offset+repeat for that slot
  //                                     (uuid shared with .texture so the GPU upload
  //                                     is reused across every clone)
  //   .applyToGeometry(geometry, key) → rewrite geometry.attributes.uv so the geometry
  //                                     samples its slice of the atlas. Pass a plain
  //                                     material with map=result.texture. The geometry
  //                                     UVs are remapped from [0..1] → its slot UV range
  //                                     including half-texel insets.
  //   .dispose()                      → dispose the canvas-backed texture
  //
  // Notes:
  // - Half-texel inset prevents linear-filter bleed from neighboring slots.
  // - Atlas size auto-grows to next POW2 if shelf packer overflows.
  // - colorSpace: by default the atlas is tagged sRGB. Pass opts.colorSpace
  //   to override (e.g. T.NoColorSpace for normal/data textures).

  function _isImageReady(img) {
    if (!img) return false;
    if (img.complete === false) return false;
    var w = img.naturalWidth || img.videoWidth || img.width || 0;
    var h = img.naturalHeight || img.videoHeight || img.height || 0;
    return w > 0 && h > 0;
  }

  function _imageDimensions(img) {
    return {
      w: img.naturalWidth || img.videoWidth || img.width || 0,
      h: img.naturalHeight || img.videoHeight || img.height || 0,
    };
  }

  function _nextPow2(n) {
    var p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function _packShelf(items, size) {
    // items: [{ key, w, h }] sorted descending by max-dim. Returns null on overflow.
    var x = 0, y = 0, shelfH = 0;
    var placed = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.w > size || it.h > size) return null;
      if (x + it.w > size) {
        y += shelfH;
        x = 0;
        shelfH = 0;
      }
      if (y + it.h > size) return null;
      placed.push({ key: it.key, x: x, y: y, w: it.w, h: it.h });
      x += it.w;
      if (it.h > shelfH) shelfH = it.h;
    }
    return placed;
  }

  w.mergeTextures = function (T, input, opts) {
    if (!T) { console.warn('[mergeTextures] window.THREE not loaded'); return null; }
    opts = opts || {};
    var padding = opts.padding != null ? opts.padding : 1;
    var debug = !!opts.debug;
    var bg = opts.background || null;

    // Normalize input to entries [{ key, texture }]
    var entries = [];
    var isArray = Array.isArray(input);
    if (isArray) {
      for (var i = 0; i < input.length; i++) entries.push({ key: i, texture: input[i] });
    } else {
      var keys = Object.keys(input);
      for (var k = 0; k < keys.length; k++) entries.push({ key: keys[k], texture: input[keys[k]] });
    }
    if (entries.length === 0) {
      console.warn('[mergeTextures] no input textures');
      return null;
    }

    // Validate all images ready and collect dimensions
    var items = [];
    var sumArea = 0, maxDim = 0;
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (!e.texture || !e.texture.image) {
        throw new Error('[mergeTextures] entry "' + e.key + '" has no image (use mergeTexturesAsync if loading)');
      }
      if (!_isImageReady(e.texture.image)) {
        throw new Error('[mergeTextures] entry "' + e.key + '" image not ready (use mergeTexturesAsync)');
      }
      var dims = _imageDimensions(e.texture.image);
      var paddedW = dims.w + padding * 2;
      var paddedH = dims.h + padding * 2;
      items.push({ key: e.key, srcW: dims.w, srcH: dims.h, w: paddedW, h: paddedH, image: e.texture.image, srcTex: e.texture });
      sumArea += paddedW * paddedH;
      if (paddedW > maxDim) maxDim = paddedW;
      if (paddedH > maxDim) maxDim = paddedH;
    }

    // Sort by max dim descending (best fit for shelf packer)
    items.sort(function (a, b) { return Math.max(b.w, b.h) - Math.max(a.w, a.h); });

    // Warn on mixed colorSpace — drawing linear and sRGB textures onto the same
    // 2D canvas re-encodes everything as sRGB and corrupts the linear data
    // (normal/roughness/metalness maps). Common pitfall when a user passes a
    // mix of textures from different loaders.
    var firstSpace = items[0].srcTex && items[0].srcTex.colorSpace;
    if (firstSpace !== undefined) {
      for (var ci = 1; ci < items.length; ci++) {
        var s = items[ci].srcTex && items[ci].srcTex.colorSpace;
        if (s !== undefined && s !== firstSpace) {
          console.warn('[mergeTextures] mixed colorSpace inputs ("' + firstSpace + '" vs "' + s +
            '"). The atlas tags one colorSpace; merging linear data with sRGB data corrupts the linear texture.');
          break;
        }
      }
    }

    // Pick atlas size: explicit, or grow until pack succeeds
    var size = opts.size ? _nextPow2(opts.size) : _nextPow2(Math.max(maxDim, Math.ceil(Math.sqrt(sumArea * 1.3))));
    var packed = _packShelf(items, size);
    var attempts = 0;
    while (!packed) {
      size *= 2;
      attempts++;
      if (size > 16384 || attempts > 6) {
        throw new Error('[mergeTextures] cannot pack ' + items.length + ' textures into atlas (max 16384)');
      }
      packed = _packShelf(items, size);
    }

    // Build canvas + atlas texture
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, size, size);
    }

    // _packShelf preserves the input order, so packed[p] corresponds to items[p].
    // Avoid the O(N²) find() that the previous version used.
    var ranges = isArray ? new Array(entries.length) : {};
    for (var p = 0; p < packed.length; p++) {
      var slot = packed[p];
      var item = items[p];
      // Draw image inset by `padding` so the gap stays clean
      ctx.drawImage(item.image, slot.x + padding, slot.y + padding, item.srcW, item.srcH);
      if (debug) {
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(slot.x + padding + 0.5, slot.y + padding + 0.5, item.srcW - 1, item.srcH - 1);
      }
      // Compute UVs with half-texel inset (CanvasTexture flipY=true → V=0 is canvas bottom)
      var halfTexel = 0.5;
      var px = slot.x + padding + halfTexel;
      var py = slot.y + padding + halfTexel;
      var pw = item.srcW - halfTexel * 2;
      var ph = item.srcH - halfTexel * 2;
      var u0 = px / size;
      var u1 = (px + pw) / size;
      // flipY: canvas top (low y) → high V; canvas bottom (high y) → low V
      var v1 = 1 - py / size;            // top of image in canvas → high V
      var v0 = 1 - (py + ph) / size;     // bottom of image in canvas → low V
      ranges[slot.key] = {
        x: slot.x + padding, y: slot.y + padding, w: item.srcW, h: item.srcH,
        u0: u0, v0: v0, u1: u1, v1: v1,
      };
    }

    var atlasTex = new T.CanvasTexture(canvas);
    atlasTex.minFilter = T.LinearFilter;
    atlasTex.magFilter = T.LinearFilter;
    atlasTex.generateMipmaps = false;
    if ('colorSpace' in atlasTex) {
      atlasTex.colorSpace = opts.colorSpace || T.SRGBColorSpace || 'srgb';
    }
    atlasTex.needsUpdate = true;

    function makeTexture(key) {
      var r = ranges[key];
      if (!r) throw new Error('[mergeTextures] unknown key: ' + key);
      var sub = atlasTex.clone();
      sub.uuid = atlasTex.uuid; // share GPU upload
      sub.needsUpdate = false;
      sub.offset.set(r.u0, r.v0);
      sub.repeat.set(r.u1 - r.u0, r.v1 - r.v0);
      return sub;
    }

    function applyToGeometry(geometry, key) {
      var r = ranges[key];
      if (!r) throw new Error('[mergeTextures] unknown key: ' + key);
      var uvAttr = geometry.attributes.uv;
      if (!uvAttr) throw new Error('[mergeTextures] geometry has no uv attribute');
      var arr = uvAttr.array;
      // Spot-check that incoming UVs are in [0..1]. If they're not, either
      // (a) the geometry was already remapped by a prior applyToGeometry call
      // (double-compression), or (b) the user has tiled UVs that would sample
      // outside the slot and into neighboring atlas slots. Warn once per call.
      var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var s = 0; s < arr.length; s += 2) {
        var u = arr[s], v = arr[s + 1];
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      var EPS = 0.001;
      if (minU < -EPS || maxU > 1 + EPS || minV < -EPS || maxV > 1 + EPS) {
        console.warn('[mergeTextures.applyToGeometry] geometry UVs out of [0..1] range ' +
          '(u: ' + minU.toFixed(3) + '..' + maxU.toFixed(3) +
          ', v: ' + minV.toFixed(3) + '..' + maxV.toFixed(3) +
          '). Linear remap will sample neighboring atlas slots. ' +
          'Either clone+normalize the geometry first, or use makeTexture(key) instead.');
      }
      var du = r.u1 - r.u0;
      var dv = r.v1 - r.v0;
      for (var i = 0; i < arr.length; i += 2) {
        // Geometry UV in [0..1] → atlas slot UV
        arr[i] = r.u0 + arr[i] * du;
        arr[i + 1] = r.v0 + arr[i + 1] * dv;
      }
      uvAttr.needsUpdate = true;
      return geometry;
    }

    function dispose() {
      atlasTex.dispose();
    }

    return {
      texture: atlasTex,
      ranges: ranges,
      size: size,
      makeTexture: makeTexture,
      applyToGeometry: applyToGeometry,
      dispose: dispose,
    };
  };

  w.mergeTexturesAsync = function (T, input, opts) {
    if (!T) return Promise.reject(new Error('[mergeTexturesAsync] window.THREE not loaded'));
    var entries = Array.isArray(input)
      ? input.map(function (t, i) { return { key: i, texture: t }; })
      : Object.keys(input).map(function (k) { return { key: k, texture: input[k] }; });

    var TIMEOUT_MS = (opts && opts.timeoutMs) || 10000;

    function pollUntilReady(img, key) {
      return new Promise(function (resolve, reject) {
        if (_isImageReady(img)) return resolve();
        var iv = setInterval(function () {
          if (_isImageReady(img)) {
            clearInterval(iv);
            clearTimeout(to);
            resolve();
          }
        }, 50);
        var to = setTimeout(function () {
          clearInterval(iv);
          reject(new Error('[mergeTexturesAsync] entry "' + key + '" not ready after ' + TIMEOUT_MS + 'ms'));
        }, TIMEOUT_MS);
      });
    }

    var promises = entries.map(function (e) {
      var img = e.texture && e.texture.image;
      if (!img) return Promise.reject(new Error('[mergeTexturesAsync] entry "' + e.key + '" has no image'));
      if (_isImageReady(img)) return Promise.resolve();
      // HTMLImageElement.decode() resolves after pixel decode — preferred over polling.
      // It can reject for cross-origin or already-decoded images, so fall back to
      // a readiness poll that rejects on timeout instead of silently resolving.
      if (typeof img.decode === 'function') {
        return img.decode().catch(function () { return pollUntilReady(img, e.key); });
      }
      // Generic readiness poll (videos, canvases without decode())
      return pollUntilReady(img, e.key);
    });

    return Promise.all(promises).then(function () {
      return w.mergeTextures(T, input, opts);
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildShatterReveal — Codrops-style "swarm-in" brand reveal
  //
  // Recipe distilled from marcofugaro/codrops-texture-projection (Codrops article
  // "Playing with Texture Projection in Three.js"). Takes a target geometry +
  // texture, samples N points on the surface, places a small cube at each
  // point with the texture slice projected at its rest position, then animates
  // the cubes "swarming in" from scattered offscreen positions.
  //
  // The trick is `buildProjectedMaterial`'s instanced path: each cube bakes
  // its rest-pose matrix once via `projectInstanceAt`, so even while the cube
  // flies through space the shader samples the texture as it would appear at
  // its resting place. The mosaic resolves into a clean image at progress=1.
  //
  // Use cases: brand reveals (logo on a flat plane), title cards, scene
  // openers. Pair with a fast bloom postfx for extra punch.
  //
  // buildShatterReveal(T, opts) → { mesh, projectorCamera, update(t), dispose }
  //   opts: {
  //     scene,                     // required — adds the InstancedMesh to scene
  //     geometry,                  // target geometry — cubes sample its surface
  //     texture,                   // THREE.Texture (image or VideoTexture)
  //     count?: 2000,              // number of cubes
  //     cubeSize?: 0.04,           // cube edge length in world units
  //     duration?: 1.5,            // seconds — how long the reveal animation runs
  //     swarmDistance?: 4,         // how far cubes scatter from rest position
  //     stagger?: 0.6,             // 0 = all cubes arrive together, 1 = max delay spread
  //     projector?: { camera?, distance?: 4 },
  //                                // explicit projector camera, or auto-build orthographic
  //                                // facing the geometry along +Z at `distance`
  //     ease?: function(t) { ... } // ease-out easing (default: 1 - (1-t)^3)
  //   }
  //
  //   .update(t)        // call each frame; t in seconds since reveal start
  //   .setProgress(p)   // alternative: set 0..1 directly
  //   .dispose()        // free GPU resources
  //
  // Notes:
  // - Geometry is sampled by face-area-weighted random points. For most
  //   geometries this looks great; for very anisotropic meshes consider a
  //   Poisson-disk sampler (not bundled — kept the helper dep-free).
  // - The target geometry itself is NOT added to the scene — only the swarming
  //   cubes. If you want a "fade out target as cubes appear" effect, add the
  //   target separately and tween its opacity yourself.
  // - At progress=0 the cubes are 100% scattered; at progress=1 they form the
  //   resolved image. Set `stagger: 0` for a synchronous landing, or higher
  //   values for a "wave" effect.

  function _sampleSurfacePoints(T, geometry, count) {
    // Returns { positions: Float32Array(count*3), normals: Float32Array(count*3) }
    var posAttr = geometry.attributes.position;
    if (!posAttr) throw new Error('[buildShatterReveal] geometry has no position attribute');
    geometry.computeVertexNormals && (!geometry.attributes.normal) && geometry.computeVertexNormals();
    var normAttr = geometry.attributes.normal;
    var index = geometry.index;

    // Build face area cumulative distribution
    var faceCount = index ? index.count / 3 : posAttr.count / 3;
    var areas = new Float32Array(faceCount);
    var totalArea = 0;
    var vA = new T.Vector3(), vB = new T.Vector3(), vC = new T.Vector3();
    var ab = new T.Vector3(), ac = new T.Vector3(), cross = new T.Vector3();
    for (var f = 0; f < faceCount; f++) {
      var ia, ib, ic;
      if (index) {
        ia = index.getX(f * 3);
        ib = index.getX(f * 3 + 1);
        ic = index.getX(f * 3 + 2);
      } else {
        ia = f * 3; ib = f * 3 + 1; ic = f * 3 + 2;
      }
      vA.fromBufferAttribute(posAttr, ia);
      vB.fromBufferAttribute(posAttr, ib);
      vC.fromBufferAttribute(posAttr, ic);
      ab.subVectors(vB, vA);
      ac.subVectors(vC, vA);
      cross.crossVectors(ab, ac);
      var area = cross.length() * 0.5;
      areas[f] = area;
      totalArea += area;
    }
    if (totalArea <= 0) throw new Error('[buildShatterReveal] geometry has zero total area');

    // Inverse CDF: cumulative array
    var cdf = new Float32Array(faceCount);
    var acc = 0;
    for (var c = 0; c < faceCount; c++) {
      acc += areas[c] / totalArea;
      cdf[c] = acc;
    }

    var positions = new Float32Array(count * 3);
    var normals = new Float32Array(count * 3);
    var tmpN = new T.Vector3();

    for (var i = 0; i < count; i++) {
      // Pick a face by binary search on CDF
      var r = Math.random();
      var lo = 0, hi = faceCount - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cdf[mid] < r) lo = mid + 1; else hi = mid;
      }
      var face = lo;
      var ja, jb, jc;
      if (index) {
        ja = index.getX(face * 3);
        jb = index.getX(face * 3 + 1);
        jc = index.getX(face * 3 + 2);
      } else {
        ja = face * 3; jb = face * 3 + 1; jc = face * 3 + 2;
      }
      // Random barycentric (sqrt trick for uniform distribution)
      var u = Math.random();
      var v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      var w_ = 1 - u - v;
      vA.fromBufferAttribute(posAttr, ja);
      vB.fromBufferAttribute(posAttr, jb);
      vC.fromBufferAttribute(posAttr, jc);
      positions[i * 3] = vA.x * u + vB.x * v + vC.x * w_;
      positions[i * 3 + 1] = vA.y * u + vB.y * v + vC.y * w_;
      positions[i * 3 + 2] = vA.z * u + vB.z * v + vC.z * w_;

      if (normAttr) {
        var nA = new T.Vector3().fromBufferAttribute(normAttr, ja);
        var nB = new T.Vector3().fromBufferAttribute(normAttr, jb);
        var nC = new T.Vector3().fromBufferAttribute(normAttr, jc);
        tmpN.set(
          nA.x * u + nB.x * v + nC.x * w_,
          nA.y * u + nB.y * v + nC.y * w_,
          nA.z * u + nB.z * v + nC.z * w_
        ).normalize();
      } else {
        // Face normal fallback
        ab.subVectors(vB, vA);
        ac.subVectors(vC, vA);
        tmpN.crossVectors(ab, ac).normalize();
      }
      normals[i * 3] = tmpN.x;
      normals[i * 3 + 1] = tmpN.y;
      normals[i * 3 + 2] = tmpN.z;
    }

    return { positions: positions, normals: normals };
  }

  w.buildShatterReveal = function (T, opts) {
    if (!T) { console.warn('[buildShatterReveal] window.THREE not loaded'); return null; }
    if (!opts || !opts.scene || !opts.geometry || !opts.texture) {
      throw new Error('[buildShatterReveal] requires opts.scene, opts.geometry, opts.texture');
    }
    if (typeof w.buildProjectedMaterial !== 'function') {
      throw new Error('[buildShatterReveal] buildProjectedMaterial not available — load order issue');
    }

    var count = opts.count || 2000;
    var cubeSize = opts.cubeSize || 0.04;
    var duration = opts.duration || 1.5;
    var swarmDistance = opts.swarmDistance != null ? opts.swarmDistance : 4;
    // Clamp stagger to [0, 0.99]. At >=1 the per-instance span denominator
    // collapses to a floor and every cube snaps to progress=1 instantly.
    var stagger = opts.stagger != null ? opts.stagger : 0.6;
    if (stagger < 0) stagger = 0;
    if (stagger > 0.99) stagger = 0.99;
    var ease = opts.ease || function (t) { return 1 - Math.pow(1 - t, 3); };

    var samples = _sampleSurfacePoints(T, opts.geometry, count);

    // Build/configure projector camera. Default: orthographic looking at the
    // target along +Z, sized to the geometry bounding box.
    opts.geometry.computeBoundingBox();
    var bbox = opts.geometry.boundingBox;
    var bboxSize = new T.Vector3();
    bbox.getSize(bboxSize);
    var bboxCenter = new T.Vector3();
    bbox.getCenter(bboxCenter);
    var projector;
    if (opts.projector && opts.projector.camera) {
      projector = opts.projector.camera;
    } else {
      var halfW = bboxSize.x * 0.5 || 1;
      var halfH = bboxSize.y * 0.5 || 1;
      var distance = (opts.projector && opts.projector.distance) || 4;
      projector = new T.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, distance + Math.max(bboxSize.z, 1) + 10);
      projector.position.set(bboxCenter.x, bboxCenter.y, bboxCenter.z + distance);
      projector.lookAt(bboxCenter);
      projector.updateProjectionMatrix();
      projector.updateMatrixWorld(true);
    }

    // Build a ProjectedMaterial with a small cube geometry
    var mat = w.buildProjectedMaterial(T, {
      camera: projector,
      texture: opts.texture,
      cover: opts.cover != null ? opts.cover : true,
      color: opts.color != null ? opts.color : 0x999999,
      roughness: opts.roughness != null ? opts.roughness : 0.4,
      metalness: opts.metalness != null ? opts.metalness : 0.1,
    });

    var cubeGeo = new T.BoxGeometry(cubeSize, cubeSize, cubeSize);
    mat.allocateProjectionData(cubeGeo, count);

    var instMesh = new T.InstancedMesh(cubeGeo, mat, count);
    instMesh.frustumCulled = false; // cubes can fly outside bbox during animation

    // Per-instance state. Pre-compute rest matrices and scattered start offsets.
    var restMatrices = new Array(count);
    var startOffsets = new Float32Array(count * 3);
    var perInstanceDelay = new Float32Array(count);

    var dummy = new T.Object3D();
    var restMat = new T.Matrix4();
    var quat = new T.Quaternion();
    var up = new T.Vector3(0, 1, 0);
    var normal = new T.Vector3();

    for (var i2 = 0; i2 < count; i2++) {
      // Rest matrix: translate to surface point, orient to surface normal
      dummy.position.set(samples.positions[i2 * 3], samples.positions[i2 * 3 + 1], samples.positions[i2 * 3 + 2]);
      normal.set(samples.normals[i2 * 3], samples.normals[i2 * 3 + 1], samples.normals[i2 * 3 + 2]);
      // Build a rotation that aligns local +Y to the surface normal.
      // setFromUnitVectors handles the antiparallel case internally (180° around an
      // arbitrary perpendicular axis), adequate for randomly-sampled surface points.
      quat.setFromUnitVectors(up, normal);
      dummy.quaternion.copy(quat);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      restMat.copy(dummy.matrix);
      restMatrices[i2] = restMat.clone();

      // Bake the rest matrix as the projection snapshot
      mat.projectInstanceAt(i2, instMesh, restMat);

      // Set initial instance matrix to rest pose so the first frame before
      // any update() call still renders correctly.
      instMesh.setMatrixAt(i2, restMat);

      // Random scattered start: a sphere of radius `swarmDistance` around rest pos
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      var r2 = swarmDistance * (0.6 + Math.random() * 0.6);
      startOffsets[i2 * 3] = r2 * Math.sin(phi) * Math.cos(theta);
      startOffsets[i2 * 3 + 1] = r2 * Math.sin(phi) * Math.sin(theta);
      startOffsets[i2 * 3 + 2] = r2 * Math.cos(phi);

      // Per-instance delay based on rest x-position (left-to-right wave) +
      // randomization for organic feel. Range [0, stagger * duration].
      var bias = (samples.positions[i2 * 3] - bboxCenter.x) / Math.max(bboxSize.x, 0.01);
      bias = (bias + 1) * 0.5; // [0..1] left-to-right
      perInstanceDelay[i2] = (bias * 0.7 + Math.random() * 0.3) * stagger * duration;
    }

    instMesh.instanceMatrix.needsUpdate = true;
    // projectInstanceAt mutates the savedModelMatrix* attributes via setXYZW
    // but doesn't mark them dirty. Without this the GPU keeps zeroed buffers
    // on first render and the projection looks like every cube samples (0,0).
    cubeGeo.attributes.savedModelMatrix0.needsUpdate = true;
    cubeGeo.attributes.savedModelMatrix1.needsUpdate = true;
    cubeGeo.attributes.savedModelMatrix2.needsUpdate = true;
    cubeGeo.attributes.savedModelMatrix3.needsUpdate = true;
    opts.scene.add(instMesh);

    // State
    var state = {
      mesh: instMesh,
      projectorCamera: projector,
      material: mat,
      _progress: 0,
      _localT: 0,
    };

    var tmpMat = new T.Matrix4();
    var tmpVec = new T.Vector3();
    var tmpQuat = new T.Quaternion();
    var tmpScale = new T.Vector3();
    // Hoisted per-frame temporaries — without these we'd allocate two new
    // Vector3/Quaternion per cube per frame (240k allocs/sec at 2k cubes,
    // 60fps) and trigger GC stutter during the most visually demanding moment.
    var spinAxis = new T.Vector3();
    var spinQuat = new T.Quaternion();
    var invSpan = 1 / Math.max(duration - stagger * duration, 0.0001);

    function applyProgress(globalProgress) {
      state._progress = globalProgress;
      for (var k = 0; k < count; k++) {
        // Each instance has its own delay-shifted progress
        var local = (globalProgress * duration - perInstanceDelay[k]) * invSpan;
        if (local < 0) local = 0;
        if (local > 1) local = 1;
        var eased = ease(local);
        var oneMinusEased = 1 - eased;

        // Decompose rest matrix to get position + quat + scale
        restMatrices[k].decompose(tmpVec, tmpQuat, tmpScale);

        // Lerp position from (rest + scattered offset) to rest
        var ox = startOffsets[k * 3], oy = startOffsets[k * 3 + 1], oz = startOffsets[k * 3 + 2];
        tmpVec.x = tmpVec.x + ox * oneMinusEased;
        tmpVec.y = tmpVec.y + oy * oneMinusEased;
        tmpVec.z = tmpVec.z + oz * oneMinusEased;

        // Add some spin during flight (eased out). Skip when the offset is
        // (near-)zero — normalize() of a zero vector yields NaN, which would
        // propagate through the quaternion and erase the cube. This matters
        // when the caller passes swarmDistance: 0 (a static reveal where
        // cubes assemble in place).
        if (eased < 1) {
          var lenSq = ox * ox + oy * oy + oz * oz;
          if (lenSq > 1e-12) {
            var invLen = 1 / Math.sqrt(lenSq);
            spinAxis.set(ox * invLen, oy * invLen, oz * invLen);
            spinQuat.setFromAxisAngle(spinAxis, oneMinusEased * 4);
            tmpQuat.multiplyQuaternions(spinQuat, tmpQuat);
          }
        }

        // Slight scale-up at start (cubes shrink as they assemble) — optional
        var s = 0.7 + 0.3 * eased;
        tmpScale.set(s, s, s);

        tmpMat.compose(tmpVec, tmpQuat, tmpScale);
        instMesh.setMatrixAt(k, tmpMat);
      }
      instMesh.instanceMatrix.needsUpdate = true;
    }

    state.update = function (t) {
      state._localT = t;
      var p = t / duration;
      if (p < 0) p = 0;
      if (p > 1) p = 1;
      applyProgress(p);
    };

    state.setProgress = function (p) {
      if (p < 0) p = 0;
      if (p > 1) p = 1;
      state._localT = p * duration;
      applyProgress(p);
    };

    state.dispose = function () {
      opts.scene.remove(instMesh);
      cubeGeo.dispose();
      mat.dispose();
    };

    // Initial state: fully scattered (progress = 0)
    applyProgress(0);
    return state;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Spatial audio — buildPannedAudio (2D L/R) + buildPositionalAudio (3D world)
  //
  // Two helpers for "audio that sounds like it comes from somewhere":
  //
  // - buildPannedAudio(opts) — works in any scene type. Stereo L/R pan via
  //   StereoPannerNode. Use for: text overlay that pans as it slides across
  //   screen, click sound at the click position, footstep sounds matching a
  //   character's screen-X position in a Canvas2D scene.
  //
  // - buildPositionalAudio(THREE, opts) — works in ThreeJSLayer scenes. True
  //   3D positional audio with HRTF + distance falloff via THREE.PositionalAudio.
  //   Use for: TV mesh in a 3D room speaks from its world position, character
  //   speaks from where they stand, ambient sound emanating from a 3D object.
  //
  // Both honor the browser's autoplay policy — `play()` resumes a suspended
  // AudioContext automatically. Call from a user-gesture handler if your
  // scene preview blocks autoplay; in Dreambyte's video export pipeline it's fine.
  //
  // buildPannedAudio({ src, pan? (0), volume? (1), loop? (false), autoplay? (false) })
  //   → { audio, play, pause, stop, setPan(p), setVolume(v), dispose }
  //   pan: -1 (full left) … +1 (full right)
  //
  // buildPositionalAudio(THREE, {
  //     camera, src, scene? | attachTo? (a Mesh/Object3D),
  //     position? ([x,y,z]),
  //     refDistance? (1), rolloff? (1), maxDistance? (10000),
  //     volume? (1), loop? (false), autoplay? (false),
  //     coneAngle? — for directional sources: { inner, outer, outerGain }
  //   }) → { audio, listener, play, pause, stop, setPosition(x,y,z), setVolume(v), dispose }
  //
  //   Pass `attachTo: someMesh` to follow a moving object, or `scene: scene`
  //   + `position: [x,y,z]` for a fixed point. Camera shares one AudioListener
  //   per page (lazy-attached on first call). Use multiple buildPositionalAudio
  //   calls with the same camera to add multiple sound sources to one scene.

  function _ensureAudioCtx() {
    if (w.__dreambyteAudioCtx) return w.__dreambyteAudioCtx;
    var Ctx = w.AudioContext || w.webkitAudioContext;
    if (!Ctx) {
      console.warn('[buildPannedAudio] Web Audio API unavailable');
      return null;
    }
    w.__dreambyteAudioCtx = new Ctx();
    return w.__dreambyteAudioCtx;
  }

  w.buildPannedAudio = function (opts) {
    opts = opts || {};
    if (!opts.src) throw new Error('[buildPannedAudio] requires opts.src');
    var ctx = _ensureAudioCtx();
    if (!ctx) return null;

    // crossOrigin must be set BEFORE src for cross-origin sources to be
    // routable through Web Audio (otherwise MediaElementAudioSourceNode emits
    // silence and warns about a tainted origin).
    var audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.loop = !!opts.loop;
    audio.src = opts.src;

    var src = ctx.createMediaElementSource(audio);
    var panNode = ctx.createStereoPanner();
    panNode.pan.value = opts.pan != null ? opts.pan : 0;
    var gainNode = ctx.createGain();
    gainNode.gain.value = opts.volume != null ? opts.volume : 1;

    src.connect(panNode).connect(gainNode).connect(ctx.destination);

    var paused = false;
    var driftThresholdSec = opts.driftThresholdSec != null ? opts.driftThresholdSec : 0.2;
    var staleThresholdMs = opts.staleThresholdMs != null ? opts.staleThresholdMs : 100;

    function play() {
      paused = false;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(function (e) {
          console.warn('[buildPannedAudio] AudioContext resume failed (autoplay blocked?):', e.message);
        });
      }
      audio.play().catch(function (e) {
        console.warn('[buildPannedAudio] play() blocked — call from a user-gesture handler:', e.message);
      });
    }

    if (opts.autoplay) play();

    // Timeline-aware tick. The helper:
    //   - seeks audio.currentTime to match (frame / fps) on drift > threshold
    //   - pauses when frame stops advancing. Only works while the host keeps
    //     calling tick() during pause; if your render loop stops firing,
    //     call .setPaused(true) explicitly.
    //   - resumes when frame starts advancing again
    //   - leaves a finished non-looping clip alone (no re-seek past the end)
    var lastFrame = -1, staleSinceMs = 0;
    function tick(frame, fps) {
      if (audio.readyState < 2 || !fps) return;
      var nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var rawTarget = frame / fps;
      var dur = (audio.duration && isFinite(audio.duration)) ? audio.duration : 0;
      var targetTime = (audio.loop && dur > 0) ? (rawTarget % dur) : rawTarget;
      var ended = !audio.loop && dur > 0 && rawTarget >= dur;

      if (ended) {
        if (!audio.paused) audio.pause();
        lastFrame = frame;
        return;
      }
      if (Math.abs(audio.currentTime - targetTime) > driftThresholdSec) {
        try { audio.currentTime = targetTime; } catch (e) {}
      }
      if (frame === lastFrame) {
        if (staleSinceMs === 0) staleSinceMs = nowMs;
        if (nowMs - staleSinceMs > staleThresholdMs && !audio.paused) {
          audio.pause();
          paused = true;
        }
      } else {
        staleSinceMs = 0;
        if (audio.paused && !paused) {
          if (ctx.state === 'suspended') ctx.resume().catch(function () {});
          audio.play().catch(function () {});
        }
      }
      lastFrame = frame;
    }

    return {
      audio: audio,
      panNode: panNode,
      gainNode: gainNode,
      play: play,
      pause: function () { paused = true; audio.pause(); },
      stop: function () { paused = false; audio.pause(); audio.currentTime = 0; },
      // Explicit pause toggle for hosts whose render loop stops firing tick()
      // while paused.
      setPaused: function (p) {
        paused = !!p;
        if (paused) audio.pause();
        else audio.play().catch(function () {});
      },
      tick: tick,
      setPan: function (p) {
        panNode.pan.value = Math.max(-1, Math.min(1, p));
      },
      setVolume: function (v) { gainNode.gain.value = Math.max(0, v); },
      dispose: function () {
        audio.pause();
        audio.src = '';
        try { src.disconnect(); panNode.disconnect(); gainNode.disconnect(); } catch (e) {}
      },
    };
  };

  w.buildPositionalAudio = function (T, opts) {
    if (!T) { console.warn('[buildPositionalAudio] window.THREE not loaded'); return null; }
    opts = opts || {};
    if (!opts.camera) throw new Error('[buildPositionalAudio] requires opts.camera');
    if (!opts.src) throw new Error('[buildPositionalAudio] requires opts.src');

    // Camera lazily attaches an AudioListener on first call. Multiple
    // buildPositionalAudio calls with the same camera reuse it so the listener
    // tree stays clean.
    if (!opts.camera.userData.__dreambyteAudioListener) {
      var listener = new T.AudioListener();
      opts.camera.add(listener);
      opts.camera.userData.__dreambyteAudioListener = listener;
    }
    var listener = opts.camera.userData.__dreambyteAudioListener;

    var sound = new T.PositionalAudio(listener);
    var pendingPlay = false;
    var loaded = false;
    var paused = false;
    var seekThresholdSec = opts.seekThresholdSec != null ? opts.seekThresholdSec : 0.5;
    var staleThresholdMs = opts.staleThresholdMs != null ? opts.staleThresholdMs : 100;

    sound.setRefDistance(opts.refDistance != null ? opts.refDistance : 1);
    sound.setRolloffFactor(opts.rolloff != null ? opts.rolloff : 1);
    if (opts.maxDistance != null) sound.setMaxDistance(opts.maxDistance);
    sound.setLoop(!!opts.loop);
    sound.setVolume(opts.volume != null ? opts.volume : 1);
    if (opts.coneAngle) {
      sound.setDirectionalCone(
        opts.coneAngle.inner != null ? opts.coneAngle.inner : 360,
        opts.coneAngle.outer != null ? opts.coneAngle.outer : 360,
        opts.coneAngle.outerGain != null ? opts.coneAngle.outerGain : 0
      );
    }

    // Track our own start-on-context-clock so tick() doesn't depend on
    // THREE.Audio._startedAt — that's a private field whose name has
    // shifted between releases. Reset on every play/restart-with-offset.
    var startedAtCtxTime = -1;
    var startedFromOffset = 0;
    function startSound(offsetSec) {
      if (offsetSec != null) sound.offset = offsetSec;
      startedFromOffset = sound.offset || 0;
      startedAtCtxTime = sound.context.currentTime;
      try { sound.play(); } catch (e) { return false; }
      return true;
    }

    var loader = new T.AudioLoader();
    loader.load(opts.src, function (buffer) {
      sound.setBuffer(buffer);
      loaded = true;
      if (pendingPlay || opts.autoplay) {
        if (sound.context.state === 'suspended') {
          sound.context.resume().then(function () { startSound(0); }).catch(function () {});
        } else {
          startSound(0);
        }
      }
    }, undefined, function (err) {
      console.warn('[buildPositionalAudio] failed to load "' + opts.src + '":', err && err.message);
    });

    if (opts.position) sound.position.fromArray(opts.position);
    if (opts.attachTo && typeof opts.attachTo.add === 'function') {
      opts.attachTo.add(sound);
    } else if (opts.scene) {
      opts.scene.add(sound);
    } else {
      throw new Error('[buildPositionalAudio] requires opts.attachTo or opts.scene');
    }

    // Timeline-aware tick. THREE.Audio uses a one-shot BufferSourceNode, so
    // "seek" means stop+restart with offset. Skip seeking when a non-looping
    // clip has finished (targetTime ≥ duration); without that gate, every
    // frame past the end would re-trigger stop+play forever.
    var lastFrame = -1, staleSinceMs = 0;
    function tick(frame, fps) {
      if (!loaded || !fps) return;
      var nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var dur = sound.buffer ? sound.buffer.duration : 0;
      var rawTarget = frame / fps;
      var looping = sound.getLoop();
      var targetTime = (looping && dur > 0) ? (rawTarget % dur) : rawTarget;
      var ended = !looping && dur > 0 && rawTarget >= dur;

      var srcTime = -1;
      if (sound.isPlaying && startedAtCtxTime >= 0 && dur > 0) {
        var elapsed = sound.context.currentTime - startedAtCtxTime + startedFromOffset;
        srcTime = looping ? (elapsed % dur) : elapsed;
      }

      if (ended) {
        if (sound.isPlaying) {
          try { sound.stop(); } catch (e) {}
          startedAtCtxTime = -1;
        }
        lastFrame = frame;
        return;
      }

      if (srcTime >= 0 && Math.abs(srcTime - targetTime) > seekThresholdSec) {
        try {
          sound.stop();
          startSound(targetTime);
        } catch (e) {}
      }

      if (frame === lastFrame) {
        if (staleSinceMs === 0) staleSinceMs = nowMs;
        if (nowMs - staleSinceMs > staleThresholdMs && sound.isPlaying) {
          try { sound.pause(); paused = true; } catch (e) {}
        }
      } else {
        staleSinceMs = 0;
        if (!sound.isPlaying && !paused) {
          if (sound.context.state === 'suspended') {
            sound.context.resume().then(function () { startSound(targetTime); }).catch(function () {});
          } else {
            startSound(targetTime);
          }
        }
      }
      lastFrame = frame;
    }

    return {
      audio: sound,
      listener: listener,
      play: function () {
        paused = false;
        if (sound.context.state === 'suspended') {
          sound.context.resume().then(function () { if (loaded) startSound(0); }).catch(function () {});
        }
        if (loaded) startSound(0);
        else pendingPlay = true;
      },
      pause: function () {
        pendingPlay = false;
        paused = true;
        if (loaded && sound.isPlaying) sound.pause();
      },
      stop: function () {
        pendingPlay = false;
        paused = false;
        startedAtCtxTime = -1;
        if (loaded && sound.isPlaying) sound.stop();
      },
      // Explicit pause toggle for hosts whose render loop stops firing tick()
      // while paused.
      setPaused: function (p) {
        paused = !!p;
        if (loaded) {
          if (paused && sound.isPlaying) { try { sound.pause(); } catch (e) {} }
          else if (!paused && !sound.isPlaying) { try { startSound(sound.offset || 0); } catch (e) {} }
        }
      },
      tick: tick,
      setPosition: function (x, y, z) { sound.position.set(x, y, z); },
      setVolume: function (v) { sound.setVolume(v); },
      dispose: function () {
        try { if (sound.isPlaying) sound.stop(); } catch (e) {}
        if (sound.parent) sound.parent.remove(sound);
      },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildScreenPlane — builds a flat display plane for data/UI content
  // Useful for mockups: glowing monitor-like panel with optional border glow
  // Returns { mesh, setContent(canvas), dispose }
  w.buildScreenPlane = function(T, scene, opts) {
    opts = opts || {};
    var w2 = opts.width || 9.6, h2 = opts.height || 5.4;
    var pos = opts.position || [0, 0, 0];
    var rot = opts.rotation || [0, 0, 0];
    var col = opts.color != null ? opts.color : 0x0a0a14;
    var glowColor = opts.glowColor != null ? opts.glowColor : 0x4488ff;
    var glowStrength = opts.glowStrength != null ? opts.glowStrength : 0.4;
    // Main screen
    var geo = new T.PlaneGeometry(w2, h2);
    var canvas = document.createElement('canvas');
    canvas.width = 1920; canvas.height = 1080;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#' + col.toString(16).padStart(6, '0');
    ctx.fillRect(0, 0, 1920, 1080);
    var tex = new T.CanvasTexture(canvas);
    var mat = new T.MeshStandardMaterial({ map: tex, color: 0xffffff, emissive: new T.Color(col), emissiveIntensity: 0.1 });
    var mesh = new T.Mesh(geo, mat);
    mesh.position.fromArray(pos);
    mesh.rotation.set(rot[0], rot[1], rot[2]);
    mesh.receiveShadow = false;
    scene.add(mesh);
    // Glow border via RectAreaLight
    if (typeof T.RectAreaLight !== 'undefined') {
      var rl = new T.RectAreaLight(glowColor, glowStrength * 2, w2 + 0.2, h2 + 0.2);
      rl.position.fromArray(pos);
      rl.rotation.set(rot[0], rot[1], rot[2]);
      scene.add(rl);
    }
    return {
      mesh: mesh, tex: tex, canvas: canvas, ctx: ctx,
      setContent: function(srcCanvas) {
        ctx.clearRect(0, 0, 1920, 1080);
        ctx.drawImage(srcCanvas, 0, 0, 1920, 1080);
        tex.needsUpdate = true;
      },
      refresh: function() { tex.needsUpdate = true; },
      dispose: function() { geo.dispose(); mat.dispose(); tex.dispose(); scene.remove(mesh); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildRippleWater — animated water plane with custom wave shader
  // Returns { mesh, update(t) }
  // opts: { width, depth, segments, color, speed, amplitude, frequency, metalness }
  w.buildRippleWater = function(T, scene, opts) {
    opts = opts || {};
    var W = opts.width || 20, D = opts.depth || 20;
    var segs = opts.segments || 80;
    var speed = opts.speed || 1.0, amp = opts.amplitude || 0.15, freq = opts.frequency || 3.0;
    var color = opts.color != null ? opts.color : 0x0055aa;
    var geo = new T.PlaneGeometry(W, D, segs, segs);
    geo.rotateX(-Math.PI / 2);
    var pos = geo.attributes.position.array;
    var originZ = new Float32Array(pos.length / 3);
    for (var i = 0; i < pos.length / 3; i++) originZ[i] = pos[i * 3 + 1];
    var mat = new T.MeshStandardMaterial({
      color: color,
      metalness: opts.metalness != null ? opts.metalness : 0.6,
      roughness: 0.1,
      transparent: true,
      opacity: opts.opacity != null ? opts.opacity : 0.82,
      side: T.DoubleSide,
    });
    var mesh = new T.Mesh(geo, mat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return {
      mesh: mesh,
      update: function(t) {
        var pa = geo.attributes.position.array;
        for (var i = 0; i < pa.length / 3; i++) {
          var x = pa[i * 3], z = pa[i * 3 + 2];
          var r = Math.sqrt(x * x + z * z);
          pa[i * 3 + 1] = originZ[i]
            + Math.sin(r * freq - t * speed) * amp
            + Math.sin(x * 2.3 + t * speed * 0.7) * amp * 0.4;
        }
        geo.attributes.position.needsUpdate = true;
        geo.computeVertexNormals();
      },
      dispose: function() { geo.dispose(); mat.dispose(); scene.remove(mesh); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildNeonSign — glowing neon tube text (line segments + point lights)
  // Returns { group, update(t) } — update(t) flickers neon if flicker:true
  // opts: { text, color, intensity, size, position, flicker, flickerSpeed }
  w.buildNeonSign = function(T, scene, opts) {
    opts = opts || {};
    var text = opts.text || 'NEON';
    var color = opts.color != null ? opts.color : 0xff2299;
    var intensity = opts.intensity != null ? opts.intensity : 3.0;
    var size = opts.size || 1.0;
    var pos = opts.position || [0, 0, 0];
    var flicker = opts.flicker !== false;
    var flickSpeed = opts.flickerSpeed || 8;
    var group = new T.Group();
    group.position.fromArray(pos);
    // Use troika text if available, else plain emissive plane as fallback
    var neonMat = new T.MeshStandardMaterial({
      color: color, emissive: new T.Color(color),
      emissiveIntensity: intensity, roughness: 0.1, metalness: 0.0,
    });
    if (window._troika) {
      var txt = new window._troika.Text();
      txt.text = text; txt.fontSize = size; txt.color = '#' + color.toString(16).padStart(6, '0');
      txt.anchorX = 'center'; txt.anchorY = 'middle';
      txt.material = neonMat;
      txt.sync();
      group.add(txt);
    } else {
      // Fallback: glowing box background
      var fbGeo = new T.BoxGeometry(text.length * size * 0.6, size * 1.2, 0.05);
      var fbMesh = new T.Mesh(fbGeo, neonMat);
      group.add(fbMesh);
    }
    // Point light for glow
    var light = new T.PointLight(color, intensity * 2, size * 8);
    group.add(light);
    scene.add(group);
    var _baseIntensity = intensity;
    return {
      group: group,
      update: function(t) {
        if (!flicker) return;
        // Simulate neon flicker: mostly on, occasional dip
        var f = Math.sin(t * flickSpeed) * Math.sin(t * flickSpeed * 1.7 + 0.3);
        var dip = f > 0.85 ? 0.1 + Math.random() * 0.3 : 1.0;
        neonMat.emissiveIntensity = _baseIntensity * dip;
        light.intensity = _baseIntensity * 2 * dip;
      },
      dispose: function() { neonMat.dispose(); scene.remove(group); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildGlitchEffect — scanline/digital glitch overlay on renderer output
  // Returns { apply(renderer, scene, camera, t), dispose }
  // opts: { intensity, scanlines, rgbShift, blockGlitch }
  w.buildGlitchEffect = function(T, renderer, opts) {
    opts = opts || {};
    var intensity = opts.intensity != null ? opts.intensity : 0.5;
    var W = renderer.domElement.width, H = renderer.domElement.height;
    // Overlay canvas on top of renderer
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;mix-blend-mode:overlay;';
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var active = true;
    function applyGlitch(t) {
      if (!active) return;
      ctx.clearRect(0, 0, W, H);
      // Scanlines
      if (opts.scanlines !== false) {
        ctx.fillStyle = 'rgba(0,0,0,0.03)';
        for (var y = 0; y < H; y += 4) { ctx.fillRect(0, y, W, 2); }
      }
      // Digital block glitch
      if (opts.blockGlitch !== false && Math.random() < intensity * 0.15) {
        var bx = Math.random() * W, by = Math.random() * H;
        var bw = 20 + Math.random() * 120, bh = 2 + Math.random() * 8;
        ctx.fillStyle = 'rgba(' + [Math.round(Math.random()*255), 0, Math.round(Math.random()*255), 0.4].join(',') + ')';
        ctx.fillRect(bx, by, bw, bh);
      }
      // Horizontal displacement lines
      if (Math.random() < intensity * 0.08) {
        var ly = Math.random() * H, lh = 1 + Math.random() * 6;
        var ld = (Math.random() - 0.5) * 40 * intensity;
        ctx.drawImage(canvas, 0, ly, W, lh, ld, ly, W, lh);
      }
    }
    return {
      apply: applyGlitch,
      setIntensity: function(v) { intensity = v; },
      dispose: function() { active = false; if (canvas.parentNode) canvas.parentNode.removeChild(canvas); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildCounterAnimation — animates a numeric counter from start to end
  // Returns { group, update(t), setValue(n) }. Uses troika Text or canvas fallback.
  // opts: { start, end, duration, prefix, suffix, decimals, color, fontSize, position, easing }
  w.buildCounterAnimation = function(T, scene, opts) {
    opts = opts || {};
    var start = opts.start != null ? opts.start : 0;
    var end = opts.end != null ? opts.end : 100;
    var dur = opts.duration != null ? opts.duration : 3;
    var prefix = opts.prefix || '';
    var suffix = opts.suffix || '';
    var decimals = opts.decimals != null ? opts.decimals : 0;
    var color = opts.color || '#ffffff';
    var fontSize = opts.fontSize || 1.0;
    var pos = opts.position || [0, 0, 0];
    var group = new T.Group();
    group.position.fromArray(pos);
    var currentValue = start;
    var textObj = null;
    if (window._troika) {
      textObj = new window._troika.Text();
      textObj.text = prefix + start.toFixed(decimals) + suffix;
      textObj.fontSize = fontSize;
      textObj.color = color;
      textObj.anchorX = 'center';
      textObj.anchorY = 'middle';
      textObj.sync();
      group.add(textObj);
    }
    scene.add(group);
    function easeOut(t) { return 1 - Math.pow(1 - Math.min(t, 1), 3); }
    return {
      group: group,
      update: function(t) {
        var progress = easeOut(Math.max(0, t) / dur);
        currentValue = start + (end - start) * progress;
        var display = prefix + currentValue.toFixed(decimals) + suffix;
        if (textObj) { textObj.text = display; textObj.sync(); }
      },
      setValue: function(n) {
        currentValue = n;
        var display = prefix + n.toFixed(decimals) + suffix;
        if (textObj) { textObj.text = display; textObj.sync(); }
      },
      getValue: function() { return currentValue; },
      dispose: function() { scene.remove(group); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildMorphingShape — smoothly morphs between geometric primitives over time
  // Returns { mesh, update(t) }
  // opts: { shapes, duration, color, size, metalness, roughness }
  // shapes: array of 'sphere'|'box'|'torus'|'cone'|'cylinder'|'icosahedron'
  w.buildMorphingShape = function(T, scene, opts) {
    opts = opts || {};
    var shapes = opts.shapes || ['sphere', 'box', 'torus', 'icosahedron'];
    var dur = opts.duration || 2.0;
    var size = opts.size || 1.5;
    var col = opts.color != null ? opts.color : 0x8844ff;
    var segs = 48;

    function makeGeo(name) {
      switch (name) {
        case 'sphere':      return new T.SphereGeometry(size, segs, segs);
        case 'box':         return new T.BoxGeometry(size * 1.6, size * 1.6, size * 1.6, 8, 8, 8);
        case 'torus':       return new T.TorusGeometry(size * 0.9, size * 0.35, 24, segs);
        case 'cone':        return new T.ConeGeometry(size, size * 2, segs);
        case 'cylinder':    return new T.CylinderGeometry(size * 0.6, size * 0.6, size * 1.8, segs);
        case 'icosahedron': return new T.IcosahedronGeometry(size, 2);
        default:            return new T.SphereGeometry(size, segs, segs);
      }
    }

    // Build morph targets from each shape (resampled to same vertex count)
    var baseGeo = makeGeo(shapes[0]);
    var baseCount = baseGeo.attributes.position.count;
    var mat = new T.MeshStandardMaterial({
      color: col,
      metalness: opts.metalness != null ? opts.metalness : 0.3,
      roughness: opts.roughness != null ? opts.roughness : 0.4,
      morphTargets: true,
    });

    // Add morph targets (resample other shapes to base vertex count)
    var morphTargets = [];
    for (var s = 1; s < shapes.length; s++) {
      var tGeo = makeGeo(shapes[s]);
      var tPos = tGeo.attributes.position;
      // Resample or pad to match baseCount
      var arr = new Float32Array(baseCount * 3);
      for (var v = 0; v < baseCount; v++) {
        var si = v % tPos.count;
        arr[v * 3]     = tPos.getX(si);
        arr[v * 3 + 1] = tPos.getY(si);
        arr[v * 3 + 2] = tPos.getZ(si);
      }
      baseGeo.morphAttributes.position = baseGeo.morphAttributes.position || [];
      baseGeo.morphAttributes.position.push(new T.Float32BufferAttribute(arr, 3));
      morphTargets.push(s - 1);
      tGeo.dispose();
    }

    var mesh = new T.Mesh(baseGeo, mat);
    mesh.castShadow = true;
    scene.add(mesh);

    return {
      mesh: mesh,
      update: function(t) {
        var cycle = shapes.length - 1;
        if (cycle < 1) return;
        var globalProgress = (t % (dur * cycle)) / dur;
        var idx = Math.floor(globalProgress);
        var frac = globalProgress - idx;
        // Ease in-out
        var eased = frac < 0.5 ? 2 * frac * frac : 1 - Math.pow(-2 * frac + 2, 2) / 2;
        // Reset all influence
        for (var i = 0; i < morphTargets.length; i++) {
          mesh.morphTargetInfluences[i] = 0;
        }
        if (idx < morphTargets.length) {
          mesh.morphTargetInfluences[idx] = eased;
        }
      },
      dispose: function() { baseGeo.dispose(); mat.dispose(); scene.remove(mesh); },
    };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // buildProceduralMaterial — Dreambyte-native procedural textures (no asset cost)
  //
  // Returns a THREE.MeshStandardMaterial whose diffuse color is generated in
  // the fragment shader. Cheaper than tsl-textures (which requires WebGPU);
  // sufficient for the explainer-video material library: wood, bricks,
  // concrete, polkaDots, grid, halftone, planet, gasGiant.
  //
  // Usage:
  //   var mat = buildProceduralMaterial(THREE, 'wood', { color1: '#7a4a1f', color2: '#3a1f0a', scale: 1.5 });
  //   var mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), mat);
  //
  // For animated kinds (gasGiant), call mat.userData.update(timeSec) per frame.
  // Static kinds ignore time; calling update is a no-op.

  var _PROC_DEFAULTS = {
    wood:      { color1: '#a86a32', color2: '#4a2510', color3: '#7a4520', scale: 1.5, roughness: 0.85, metalness: 0.0 },
    bricks:    { color1: '#a64b3a', color2: '#3a3530', color3: '#7a3525', scale: 1.0, roughness: 0.95, metalness: 0.0 },
    concrete:  { color1: '#9a9692', color2: '#7a7672', color3: '#bab6b2', scale: 1.0, roughness: 1.0,  metalness: 0.0 },
    polkaDots: { color1: '#ffffff', color2: '#222222', color3: '#ff4477', scale: 1.0, roughness: 0.6,  metalness: 0.0 },
    grid:      { color1: '#202830', color2: '#60aaff', color3: '#90c8ff', scale: 1.0, roughness: 0.5,  metalness: 0.1 },
    halftone:  { color1: '#fdfbf7', color2: '#1a1a1a', color3: '#888888', scale: 1.0, roughness: 0.9,  metalness: 0.0 },
    planet:    { color1: '#3a7a4a', color2: '#cab690', color3: '#1a3060', scale: 1.0, roughness: 0.7,  metalness: 0.0 },
    gasGiant:  { color1: '#d8a878', color2: '#7a4530', color3: '#f0d8b0', scale: 1.0, roughness: 0.8,  metalness: 0.0 },
  };

  // Shared GLSL: hash-based 3D value noise + 2D wrapper + FBM. ~30 lines, cheap.
  var _PROC_NOISE_GLSL = [
    'float dreambyteHash(vec3 p) {',
    '  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));',
    '  p *= 17.0;',
    '  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));',
    '}',
    'float dreambyteNoise3(vec3 p) {',
    '  vec3 i = floor(p);',
    '  vec3 f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  return mix(',
    '    mix(mix(dreambyteHash(i + vec3(0.0,0.0,0.0)), dreambyteHash(i + vec3(1.0,0.0,0.0)), f.x),',
    '        mix(dreambyteHash(i + vec3(0.0,1.0,0.0)), dreambyteHash(i + vec3(1.0,1.0,0.0)), f.x), f.y),',
    '    mix(mix(dreambyteHash(i + vec3(0.0,0.0,1.0)), dreambyteHash(i + vec3(1.0,0.0,1.0)), f.x),',
    '        mix(dreambyteHash(i + vec3(0.0,1.0,1.0)), dreambyteHash(i + vec3(1.0,1.0,1.0)), f.x), f.y),',
    '    f.z);',
    '}',
    'float dreambyteNoise2(vec2 p) { return dreambyteNoise3(vec3(p, 0.0)); }',
    'float dreambyteFbm(vec3 p) {',
    '  float a = 0.5; float r = 0.0;',
    '  for (int k = 0; k < 5; k++) { r += a * dreambyteNoise3(p); p *= 2.13; a *= 0.5; }',
    '  return r;',
    '}',
    ''
  ].join('\n');

  // Per-kind body of `vec3 dreambyteProc()`. Each returns the diffuse color.
  // vDreambyteUv = mesh uv. vDreambyteWP = world-space position.
  var _PROC_KIND_GLSL = {
    wood: [
      'vec3 dreambyteProc() {',
      '  vec3 p = vDreambyteWP * uDreambyteScale;',
      '  float r = length(p.xy) * 2.0;',
      '  float rings = sin(r * 6.0 + dreambyteFbm(p * 1.5) * 5.0) * 0.5 + 0.5;',
      '  rings = smoothstep(0.3, 0.7, rings);',
      '  vec3 col = mix(uDreambyteColor2, uDreambyteColor1, rings);',
      '  float grain = dreambyteNoise3(p * vec3(30.0, 8.0, 30.0));',
      '  col *= 0.82 + 0.32 * grain;',
      '  col = mix(col, uDreambyteColor3, smoothstep(0.7, 0.9, dreambyteNoise3(p * 0.8)) * 0.25);',
      '  return col;',
      '}'
    ].join('\n'),
    bricks: [
      'vec3 dreambyteProc() {',
      '  vec2 p = vDreambyteUv * uDreambyteScale * vec2(6.0, 12.0);',
      '  float row = floor(p.y);',
      '  if (mod(row, 2.0) > 0.5) p.x += 0.5;',
      '  vec2 cell = fract(p) - 0.5;',
      '  vec2 d = abs(cell) - vec2(0.45, 0.4);',
      '  float mortar = smoothstep(0.04, 0.0, max(d.x, d.y));',
      '  float n = dreambyteNoise2(p * 4.0 + vec2(row * 13.0, 0.0));',
      '  vec3 brick = mix(uDreambyteColor3, uDreambyteColor1, n);',
      '  return mix(uDreambyteColor2, brick, mortar);',
      '}'
    ].join('\n'),
    concrete: [
      'vec3 dreambyteProc() {',
      '  vec3 p = vDreambyteWP * uDreambyteScale;',
      '  float n1 = dreambyteFbm(p * 4.0);',
      '  float n2 = dreambyteNoise3(p * 24.0);',
      '  float blot = smoothstep(0.55, 0.72, n1);',
      '  vec3 base = mix(uDreambyteColor1, uDreambyteColor3, n1);',
      '  base = mix(base, uDreambyteColor2, blot * 0.6);',
      '  base *= 0.9 + 0.2 * n2;',
      '  return base;',
      '}'
    ].join('\n'),
    polkaDots: [
      'vec3 dreambyteProc() {',
      '  vec2 p = fract(vDreambyteUv * uDreambyteScale * 6.0) - 0.5;',
      '  float d = length(p);',
      '  float dotEdge = smoothstep(0.3, 0.27, d);',
      '  return mix(uDreambyteColor1, uDreambyteColor2, dotEdge);',
      '}'
    ].join('\n'),
    grid: [
      'vec3 dreambyteProc() {',
      '  vec2 p = vDreambyteUv * uDreambyteScale * 8.0;',
      '  vec2 g = abs(fract(p) - 0.5);',
      '  float line = min(g.x, g.y);',
      '  float lineMask = 1.0 - smoothstep(0.02, 0.06, line);',
      '  vec2 g2 = abs(fract(p / 8.0) - 0.5);',
      '  float major = 1.0 - smoothstep(0.005, 0.015, min(g2.x, g2.y));',
      '  vec3 col = mix(uDreambyteColor1, uDreambyteColor2, lineMask);',
      '  col = mix(col, uDreambyteColor3, major);',
      '  return col;',
      '}'
    ].join('\n'),
    halftone: [
      'vec3 dreambyteProc() {',
      '  vec2 p = vDreambyteUv * uDreambyteScale * 30.0;',
      '  vec2 cell = fract(p) - 0.5;',
      '  float d = length(cell);',
      '  float val = dreambyteFbm(vec3(vDreambyteUv * uDreambyteScale * 4.0, 0.0));',
      '  float size = mix(0.1, 0.45, val);',
      '  float dotMask = smoothstep(size + 0.03, size, d);',
      '  return mix(uDreambyteColor1, uDreambyteColor2, dotMask);',
      '}'
    ].join('\n'),
    planet: [
      'vec3 dreambyteProc() {',
      '  vec3 p = normalize(vDreambyteWP) * uDreambyteScale;',
      '  float n = dreambyteFbm(p * 2.5);',
      '  vec3 land = mix(uDreambyteColor1, uDreambyteColor2, smoothstep(0.4, 0.65, n));',
      '  vec3 ocean = uDreambyteColor3 * (0.7 + 0.3 * dreambyteNoise3(p * 6.0));',
      '  return mix(ocean, land, smoothstep(0.45, 0.5, n));',
      '}'
    ].join('\n'),
    gasGiant: [
      'vec3 dreambyteProc() {',
      '  vec3 p = normalize(vDreambyteWP) * uDreambyteScale;',
      '  float warp = dreambyteFbm(p * 3.0 + vec3(uDreambyteTime * 0.02, 0.0, 0.0)) * 0.3;',
      '  float band = sin((p.y + warp) * 7.0);',
      '  vec3 col = mix(uDreambyteColor1, uDreambyteColor2, smoothstep(-0.2, 0.2, band));',
      '  float storm = smoothstep(0.72, 0.9, dreambyteFbm(p * 6.0 + vec3(0.0, uDreambyteTime * 0.01, 0.0)));',
      '  col = mix(col, uDreambyteColor3, storm * 0.7);',
      '  return col;',
      '}'
    ].join('\n')
  };

  w.buildProceduralMaterial = function(T, kind, opts) {
    if (!T) T = window.THREE;
    if (!T) { console.warn('[buildProceduralMaterial] window.THREE not loaded'); return null; }
    if (!_PROC_DEFAULTS[kind]) {
      console.warn('[buildProceduralMaterial] unknown kind: ' + kind + ' — valid: wood, bricks, concrete, polkaDots, grid, halftone, planet, gasGiant');
      return new T.MeshStandardMaterial({ color: '#cccccc' });
    }
    opts = opts || {};
    var d = _PROC_DEFAULTS[kind];

    var mat = new T.MeshStandardMaterial({
      color: '#ffffff',
      roughness: opts.roughness != null ? opts.roughness : d.roughness,
      metalness: opts.metalness != null ? opts.metalness : d.metalness,
      side: opts.side != null ? opts.side : T.FrontSide,
    });

    // Uniforms outlive shader compilation — both onBeforeCompile and userData.update
    // mutate the same objects. Declared once; shader receives references.
    var uniforms = {
      uDreambyteTime:   { value: 0 },
      uDreambyteScale:  { value: opts.scale != null ? opts.scale : d.scale },
      uDreambyteColor1: { value: new T.Color(opts.color1 != null ? opts.color1 : d.color1) },
      uDreambyteColor2: { value: new T.Color(opts.color2 != null ? opts.color2 : d.color2) },
      uDreambyteColor3: { value: new T.Color(opts.color3 != null ? opts.color3 : d.color3) },
    };
    mat.userData.uniforms = uniforms;
    mat.userData.kind = kind;
    mat.userData.update = function(timeSec) { uniforms.uDreambyteTime.value = timeSec || 0; };

    var kindGlsl = _PROC_KIND_GLSL[kind];

    mat.onBeforeCompile = function(shader) {
      shader.uniforms.uDreambyteTime   = uniforms.uDreambyteTime;
      shader.uniforms.uDreambyteScale  = uniforms.uDreambyteScale;
      shader.uniforms.uDreambyteColor1 = uniforms.uDreambyteColor1;
      shader.uniforms.uDreambyteColor2 = uniforms.uDreambyteColor2;
      shader.uniforms.uDreambyteColor3 = uniforms.uDreambyteColor3;

      // Vertex shader: pass uv + world position to fragment.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vDreambyteWP;\nvarying vec2 vDreambyteUv;'
      );
      // begin_vertex sets `transformed`; we hook before the matrix multiplies
      // happen so position is still object-space (use modelMatrix for world).
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDreambyteUv = uv;\nvDreambyteWP = (modelMatrix * vec4(position, 1.0)).xyz;'
      );

      // Fragment shader: declare uniforms/varyings, inline noise + per-kind body.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\n' +
          'uniform float uDreambyteTime;\n' +
          'uniform float uDreambyteScale;\n' +
          'uniform vec3 uDreambyteColor1;\n' +
          'uniform vec3 uDreambyteColor2;\n' +
          'uniform vec3 uDreambyteColor3;\n' +
          'varying vec3 vDreambyteWP;\n' +
          'varying vec2 vDreambyteUv;\n' +
          _PROC_NOISE_GLSL +
          kindGlsl
      );

      // Override diffuseColor.rgb with our procedural sample. <map_fragment> is
      // empty when USE_MAP isn't defined; injecting here keeps lighting/AO/env
      // contributions intact downstream — full PBR on procedural color.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        'diffuseColor.rgb = dreambyteProc();\n#include <map_fragment>'
      );
    };

    // Force shader recompile so onBeforeCompile fires immediately.
    mat.needsUpdate = true;

    return mat;
  };

  // Convenience shorthand registry — buildProceduralMaterial.kinds for agent discovery.
  w.buildProceduralMaterial.kinds = Object.keys(_PROC_DEFAULTS);

  // ─────────────────────────────────────────────────────────────────────────────

  // Version sentinel — print after all definitions so function names are accurate
  console.log(
    '[Studio3D] v=' + SDK_VERSION,
    '| toon=' + typeof w.buildToonMaterial,
    '| dissolve=' + typeof w.buildDissolveMaterial,
    '| wave=' + typeof w.buildWaveMaterial,
    '| marble=' + typeof w.buildMagicMarbleMaterial,
    '| pcss=' + typeof w.applyPCSS,
    '| flyLine=' + typeof w.buildFlyLine,
    '| trailPath=' + typeof w.buildTrailPath,
    '| instancedLines=' + typeof w.buildInstancedLines,
    '| explosion=' + typeof w.buildExplosion,
    '| flatFloor=' + typeof w.buildFlatFloor,
    '| lightShaft=' + typeof w.buildLightShaft,
    '| morphBetween=' + typeof w.buildMorphBetween,
    '| subsurface=' + typeof w.MATERIALS.subsurface,
    '| matcap=' + typeof w.MATERIALS.matcap,
    '| dof=' + typeof w.applyDepthOfField,
    '| terrain=' + typeof w.buildProceduralTerrain,
    '| clouds=' + typeof w.buildCloudField,
    '| videoTex=' + typeof w.buildVideoTexture,
    '| gifTex=' + typeof w.buildGifTexture,
    '| projMat=' + typeof w.buildProjectedMaterial,
    '| spriteAtlas=' + typeof w.buildSpriteAtlas,
    '| label3D=' + typeof w.buildLabel3D,
    '| mergeTex=' + typeof w.mergeTextures,
    '| shatter=' + typeof w.buildShatterReveal,
    '| pannedAudio=' + typeof w.buildPannedAudio,
    '| posAudio=' + typeof w.buildPositionalAudio,
    '| screenPlane=' + typeof w.buildScreenPlane,
    '| water=' + typeof w.buildRippleWater,
    '| neon=' + typeof w.buildNeonSign,
    '| glitch=' + typeof w.buildGlitchEffect,
    '| counter=' + typeof w.buildCounterAnimation,
    '| morphShape=' + typeof w.buildMorphingShape,
    '| procMat=' + typeof w.buildProceduralMaterial
  );

}(window));
