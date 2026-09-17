# Third-Party Notices

Dreambyte is licensed under the [MIT License](../LICENSE). This file credits third-party code,
content, and assets that are included in, adapted by, or distributed with Dreambyte, and
reproduces the NOTICE texts required by Apache-2.0 components. Hand-written sections cover
vendored and adapted material; the [npm dependencies](#npm-dependencies) section at the end is generated from
`package-lock.json`. Audio sources are listed in [docs/THIRD_PARTY_AUDIO.md](THIRD_PARTY_AUDIO.md).

## Apache-2.0 NOTICE texts

The following Apache-2.0 components ship a NOTICE file. Their attribution notices are reproduced
here as required by section 4(d) of the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0).

```text
--------------------------------------------------------------------------------
Impeccable design skills (apps/desktop/.agents/skills/, apps/desktop/.claude/skills/)
https://github.com/pbakaus/impeccable
Copyright 2025 Paul Bakaus. Licensed under the Apache License, Version 2.0.
Based on Anthropic's frontend-design skill (https://github.com/anthropics/skills,
Apache License 2.0).

  Upstream NOTICE: This project includes content derived from third-party work,
  used under the terms of its original license. The platform reference files
  are distilled from ehmo's platform-design-skills
  (https://github.com/ehmo/platform-design-skills), MIT License.

--------------------------------------------------------------------------------
import-in-the-middle (npm dependency of @sentry/electron)
Copyright 2024 Node.js contributors. All rights reserved.
Licensed under the Apache License, Version 2.0.

  This product includes software developed at Datadog
  (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

--------------------------------------------------------------------------------
bare-path (npm dependency of tar-fs, via sharp)
Copyright 2023 Holepunch Inc. Licensed under the Apache License, Version 2.0.
Includes code Copyright Joyent, Inc. and other Node contributors (MIT License).
```

## Distributed runtime

### Electron and Chromium

Desktop builds embed [Electron](https://github.com/electron/electron) (MIT — Copyright (c) Electron
contributors, Copyright (c) 2013-2020 GitHub Inc.), which bundles Chromium, Node.js, and their
dependencies. Their license texts ship with the app as `LICENSE.electron.txt` and
`LICENSES.chromium.html` in the app's resources directory.

### FFmpeg (not bundled)

MP4 export and audio/video processing run the user's own FFmpeg installation, found at runtime
(`DREAMBYTE_FFMPEG_PATH`/`FFMPEG_PATH`, `PATH`, or Homebrew). Dreambyte does not distribute FFmpeg
binaries. FFmpeg (https://ffmpeg.org) is licensed by the FFmpeg developers under the
LGPL-2.1-or-later, or the GPL for builds configured with GPL components. The app ships these helpers
from `render-server/node_modules` to drive it (each package's own LICENSE file ships with it):

| Package         | Version | License                                                                 |
| --------------- | ------- | ----------------------------------------------------------------------- |
| `fluent-ffmpeg` | 2.1.3   | MIT — Copyright (c) 2011-2015 The fluent-ffmpeg contributors             |
| `async`         | 0.2.10  | MIT — Copyright (c) 2010 Caolan McMahon                                  |
| `which`         | 1.3.1   | ISC — Copyright (c) Isaac Z. Schlueter and Contributors                  |
| `isexe`         | 2.0.0   | ISC — Copyright (c) Isaac Z. Schlueter and Contributors                  |
| `uuid`          | 9.0.1   | MIT — Copyright (c) 2010-2020 Robert Kieffer and other contributors      |

### MediaPipe face detector model

- **Used in:** `assets/mediapipe/blaze_face_short_range.tflite` (copied into the app at build time)
- **Source:** https://github.com/google-ai-edge/mediapipe (Google)
- **License:** Apache-2.0

## Code and content

### Open Generative AI — prompt enhancement tags

- **Used in:** `lib/media/prompt-enhancer.ts` (the `ENHANCE_TAGS` pattern, adapted from
  `apps/desktop/src/lib/promptUtils.js`; the tag registry itself is Dreambyte-specific)
- **Source:** https://github.com/Anil-matcha/Open-Generative-AI
- **License:** MIT — Copyright (c) 2026 Open Generative AI Contributors

### Impeccable — design skills

- **Used in:** `apps/desktop/.agents/skills/` (`impeccable`, `adapt`, `animate`, `audit`, `bolder`, `clarify`,
  `colorize`, `critique`, `delight`, `distill`, `layout`, `optimize`, `overdrive`, `polish`,
  `quieter`, `shape`, `typeset`; mirrored into `apps/desktop/.claude/skills/`)
- **Source:** https://github.com/pbakaus/impeccable
- **License:** Apache-2.0 — Copyright 2025 Paul Bakaus. Based on Anthropic's `frontend-design`
  skill (Apache-2.0). See [apps/desktop/.agents/skills/impeccable/NOTICE.md](../apps/desktop/.agents/skills/impeccable/NOTICE.md).

### HeyGen Hyperframes — preview playback model

- **Used in:** `lib/compositor/preview-media-pool.ts` (debounced media drift sync and its
  thresholds), `lib/scene-html/playback-controller.ts`, `lib/code-text-slots.ts`,
  `lib/preview-bridge.ts`, `components/PreviewMediaLayer.tsx` (patterns modeled on Hyperframes'
  all-DOM player, media sync, and DOM-edit descriptors)
- **Source:** https://github.com/heygen-com/hyperframes
- **License:** Apache-2.0 (no NOTICE file upstream)

### Animate.css — motion preset keyframes

- **Used in:** `lib/motion-dsl/presets.generated.ts` (named presets such as `bounceIn`,
  `heartBeat`, `jackInTheBox`, `rubberBand` follow Animate.css keyframes)
- **Source:** https://github.com/animate-css/animate.css (3.x line)
- **License:** MIT — Copyright (c) 2019 Daniel Eden. Animate.css 4.x and later are under the
  Hippocratic License 2.1; a few preset names (`lightSpeedInLeft`, `lightSpeedInRight`, `shakeY`)
  follow 4.x naming and are mirrors of 3.x keyframes.

### react-spring — spring presets

- **Used in:** `lib/motion-dsl/springs.ts` (named tension/friction presets)
- **Source:** https://github.com/pmndrs/react-spring
- **License:** MIT — Copyright (c) 2018-present Paul Henschel, react-spring, all contributors

## 3D models

### Kenney — model library

- **Used in:** `apps/desktop/public/models/library/` (all 25 `.glb` models and their `Textures/colormap.png`,
  catalogued in `apps/desktop/public/models/library/index.json`)
- **Source:** Kenney asset kits, https://kenney.nl
- **License:** CC0 1.0 Universal (public domain dedication; credit appreciated, not required)

## Vendored runtime libraries (`apps/desktop/public/vendor/`, `apps/desktop/public/sdk/`)

These are copied or bundled into the repo so scenes render offline. Each keeps its upstream
license; where the minified file carries its own header, that header is authoritative.

| File(s)                                                                                                                      | Upstream                                                                                                                                                                             | License                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `apps/desktop/public/sdk/babel.min.js`                                                                                                    | [@babel/standalone](https://github.com/babel/babel) 7.x                                                                                                                              | MIT — Copyright (c) 2014-present Sebastian McKenzie and other contributors |
| `apps/desktop/public/vendor/animejs/anime.umd.min.js`                                                                                     | [anime.js](https://github.com/juliangarnier/anime) 4.5.0 (UMD bundle, unmodified; license text in `apps/desktop/public/vendor/animejs/LICENSE.md`)                                                | MIT — Copyright (c) 2025 Julian Garnier                                    |
| `apps/desktop/public/vendor/html2canvas/html2canvas.min.js`                                                                               | [niklasvh/html2canvas](https://github.com/niklasvh/html2canvas) 1.4.1 (unmodified; license text in `apps/desktop/public/vendor/html2canvas/LICENSE`) — loaded inside isolated export scene frames | MIT — Copyright (c) 2012 Niklas von Hertzen                                |
| `apps/desktop/public/vendor/camera-controls.min.js`                                                                                       | [yomotsu/camera-controls](https://github.com/yomotsu/camera-controls)                                                                                                                | MIT — (c) 2017 @yomotsu                                                    |
| `apps/desktop/public/vendor/polygon-clipping.umd.min.js`                                                                                  | [mfogel/polygon-clipping](https://github.com/mfogel/polygon-clipping) (bundles splaytree, MIT)                                                                                       | MIT                                                                        |
| `apps/desktop/public/vendor/three-csg.iife.js`                                                                                            | [three-csg-ts](https://github.com/Jiro-Digital/three-csg-ts) bundled with three.js                                                                                                   | MIT (three-csg-ts; three.js — Copyright 2010-2026 Three.js Authors)        |
| `apps/desktop/public/vendor/three-bvh-csg.esm.js`                                                                                         | [gkjohnson/three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) 0.0.17                                                                                                         | MIT — Copyright (c) Garrett Johnson                                        |
| `apps/desktop/public/vendor/troika-three-text.esm.js`                                                                                     | [protectwise/troika](https://github.com/protectwise/troika) `troika-three-text` (bundles Typr.ts, woff2otf, fflate, unicode-font-resolver — all MIT)                                 | MIT                                                                        |
| `apps/desktop/public/vendor/three-custom-shader-material.js`                                                                              | [FarazzShaikh/THREE-CustomShaderMaterial](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial)                                                                                | MIT — Copyright (c) Faraz Shaikh                                           |
| `apps/desktop/public/vendor/enhance-shader-lighting.js`                                                                                   | [0beqz/enhance-shader-lighting](https://github.com/0beqz/enhance-shader-lighting)                                                                                                    | MIT                                                                        |
| `apps/desktop/public/vendor/three-csm.js`                                                                                                 | three.js `examples/jsm/csm` (cascaded shadow maps), esbuild-wrapped                                                                                                                  | MIT — Three.js Authors                                                     |
| `apps/desktop/public/vendor/three-sky.js`, `apps/desktop/public/vendor/three-addons-160/*.js` (FontLoader, GLTFLoader, SVGLoader, TextGeometry, Water) | three.js r160 `examples/jsm`, rewritten as classic scripts                                                                                                                           | MIT — Copyright 2010-2023 Three.js Authors                                 |
| `apps/desktop/public/vendor/infinite-grid-helper.js`                                                                                      | [Fyrestar/THREE.InfiniteGridHelper](https://github.com/Fyrestar/THREE.InfiniteGridHelper) (adapted)                                                                                  | MIT                                                                        |
| `apps/desktop/public/vendor/waternormals.jpg`                                                                                             | three.js `examples/textures/waternormals.jpg`                                                                                                                                        | MIT (three.js repository)                                                  |
| `apps/desktop/public/sdk/dreambyte-studio3d.js`                                                                                           | Dreambyte code (MIT); inlines MIT helpers from troika-three-text, three.js CSM, and CustomShaderMaterial listed above                                                         | MIT (see rows above)                                                       |

## Fonts

| File(s)                                                                                  | Font                                                                                                                   | License                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/public/vendor/fonts/MPLUSRounded1c-Regular.typeface.json`                               | Rounded M+ 1c (M PLUS Rounded 1c), converted to three.js typeface JSON — Copyright 2016 The Rounded M+ Project Authors | SIL Open Font License 1.1 — full text in `apps/desktop/public/vendor/fonts/LICENSE.MPLUSRounded.txt`                                                                        |
| `apps/desktop/public/vendor/fonts/helvetiker_*.typeface.json`, `optimer_bold.typeface.json`           | MgOpen-derived fonts shipped with three.js — Copyright 2004 MAGENTA Ltd.                                               | MAGENTA/MgOpen license (permissive; may not be sold by themselves) — text in `apps/desktop/public/vendor/fonts/LICENSE` (also `LICENSE.magenta.txt`, `LICENSE.threejs.txt`) |
| `apps/desktop/public/vendor/fonts/gentilis_bold.typeface.json`                                        | Gentilis (Gentium) — Copyright (c) SIL International, 2003-2008                                                        | SIL Open Font License 1.1 (https://openfontlicense.org)                                                                                                        |
| `apps/desktop/public/vendor/fonts/droid_sans_regular.typeface.json`, `droid_serif_bold.typeface.json` | Droid Sans / Droid Serif — digitized data copyright 2006 Google Corporation                                            | Apache-2.0                                                                                                                                                     |
| `apps/desktop/public/fonts/SairaStencil-Variable.ttf`                                                 | Saira Stencil (Omnibus-Type, via Google Fonts)                                                                         | SIL Open Font License 1.1                                                                                                                                      |

## Textures and environment maps

| File(s)                                                                                                                       | Source                                                                                    | License |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `apps/desktop/public/vendor/hdri/studio_small_03_1k.hdr` | [Poly Haven — studio_small_03](https://polyhaven.com/a/studio_small_03), Sergej Majboroda | CC0 1.0 |

## Logos

| File(s)                                                    | Source                 | License                                                  |
| ---------------------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| `apps/desktop/public/assets/*-logo.svg`, `apps/desktop/public/assets/heygen-symbol-white.svg` | Provider/company logos | Trademarks of their respective owners; used nominatively |

<!-- BEGIN GENERATED: npm-dependencies (apps/desktop/scripts/release/gen-third-party-notices.mjs) -->

## npm dependencies

Generated from `package-lock.json` (738 non-dev packages, including optional platform binaries). Regenerate with `node apps/desktop/scripts/release/gen-third-party-notices.mjs` after `npm ci`. Development-only tooling is not listed because it is not distributed with the app.

**Licenses:** MIT (521), Apache-2.0 (91), ISC (26), BSD-3-Clause (24), OFL-1.1 (23), UNKNOWN (14), LGPL-3.0-or-later (10), BSD-2-Clause (7), Apache-2.0 AND LGPL-3.0-or-later (3), MIT-0 (2), BlueOak-1.0.0 (2), Apache-2.0 AND LGPL-3.0-or-later AND MIT (1), Apache-2.0 AND MIT (1), BSD-3-Clause OR MIT (1), Python-2.0 (1), CC-BY-4.0 (1), (MPL-2.0 OR Apache-2.0) (1), BSD (1), (MIT OR WTFPL) (1), SEE LICENSE IN LICENSE.txt (1), SIL OPEN FONT LICENSE (1), CC0-1.0 (1), MPL-2.0 (1), (BSD-2-Clause OR MIT OR Apache-2.0) (1), 0BSD (1), MIT/X11 (1)

| Package | Version | License | Copyright | Text |
| --- | --- | --- | --- | --- |
| @ant-design/cssinjs | 2.1.2 | MIT | Copyright (c) 2019-present afc163; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L1](#license-text-l1) |
| @anthropic-ai/sdk | 0.37.0 | MIT | Copyright 2023 Anthropic, PBC.; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L2](#license-text-l2) |
| @asamuzakjp/css-color | 5.1.11 | MIT | Copyright (c) 2024 asamuzaK (Kazz); The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @asamuzakjp/dom-selector | 7.1.1 | MIT | Copyright (c) 2023 asamuzaK (Kazz); The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @asamuzakjp/generational-cache | 1.0.1 | MIT | Copyright (c) 2026 asamuzaK (Kazz); The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @asamuzakjp/nwsapi | 2.3.9 | MIT | Copyright (c) 2007-2019 Diego Perini (http://www.iport.it/); The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L4](#license-text-l4) |
| @babel/code-frame | 7.29.0 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/generator | 7.29.1 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/helper-globals | 7.28.0 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/helper-module-imports | 7.28.6 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/helper-string-parser | 7.27.1 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/helper-validator-identifier | 7.28.5 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/parser | 7.29.2 | MIT | Copyright (C) 2012-2014 by various contributors (see AUTHORS); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| @babel/runtime | 7.29.2 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/template | 7.28.6 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/traverse | 7.29.0 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @babel/types | 7.29.0 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| @bramus/specificity | 2.4.2 | MIT | Copyright (c) 2022 Bramus Van Damme - https://www.bram.us/; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L7](#license-text-l7) |
| @csstools/color-helpers | 6.0.2 | MIT-0 | Copyright © CSSTools Contributors; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L8](#license-text-l8) |
| @csstools/css-calc | 3.2.1 | MIT | Copyright 2022 Romain Menke, Antonio Laguna &lt;antonio@laguna.es>; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| @csstools/css-color-parser | 4.1.1 | MIT | Copyright 2022 Romain Menke, Antonio Laguna &lt;antonio@laguna.es>; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| @csstools/css-parser-algorithms | 4.0.0 | MIT | Copyright 2022 Romain Menke, Antonio Laguna &lt;antonio@laguna.es>; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| @csstools/css-syntax-patches-for-csstree | 1.1.4 | MIT-0 | Copyright © CSSTools Contributors; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L8](#license-text-l8) |
| @csstools/css-tokenizer | 4.0.0 | MIT | Copyright 2022 Romain Menke, Antonio Laguna &lt;antonio@laguna.es>; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| @dnd-kit/accessibility | 3.1.1 | MIT | Copyright (c) 2021, Claudéric Demers; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @dnd-kit/core | 6.3.1 | MIT | Copyright (c) 2021, Claudéric Demers; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @dnd-kit/sortable | 8.0.0 | MIT | Copyright (c) 2021, Claudéric Demers; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @dnd-kit/utilities | 3.2.2 | MIT | Copyright (c) 2021, Claudéric Demers; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emnapi/runtime | 1.9.2 | MIT | Copyright (c) 2021-present Toyobayashi; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/babel-plugin | 11.13.5 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/cache | 11.14.0 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/css | 11.13.5 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/hash | 0.8.0 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/hash | 0.9.2 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/memoize | 0.9.0 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/react | 11.14.0 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/serialize | 1.3.3 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/sheet | 1.4.0 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/unitless | 0.10.0 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/unitless | 0.7.5 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/use-insertion-effect-with-fallbacks | 1.2.0 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/utils | 1.4.2 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @emotion/weak-memoize | 0.4.0 | MIT | Copyright (c) Emotion team and other contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @exodus/bytes | 1.15.0 | MIT | Copyright (c) 2024-2025 Exodus Movement; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @fal-ai/serverless-client | 0.15.0 | MIT | Copyright 2024 https://fal.ai; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L10](#license-text-l10) |
| @fontsource-variable/figtree | 5.2.10 | OFL-1.1 | Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree) Figtree-Italic[wght].ttf: Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource-variable/inter | 5.2.8 | OFL-1.1 | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource-variable/source-serif-4 | 5.2.9 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L12](#license-text-l12) |
| @fontsource-variable/vollkorn | 5.2.10 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L13](#license-text-l13) |
| @fontsource/architects-daughter | 5.2.7 | OFL-1.1 | Copyright (c) 2010, Kimberly Geswein (kimberlygeswein.com); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/bebas-neue | 5.2.7 | OFL-1.1 | Copyright 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/bitter | 5.2.10 | OFL-1.1 | Copyright 2011 The Bitter Project Authors (https://github.com/solmatas/BitterPro) Bitter-Italic[wght].ttf: Copyright 2011 The Bitter Project Authors (https://github.com/solmatas/BitterPro); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/bricolage-grotesque | 5.2.10 | OFL-1.1 | Copyright 2022 The Bricolage Grotesque Project Authors (https://github.com/ateliertriay/bricolage); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/caveat | 5.2.8 | OFL-1.1 | Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/dm-mono | 5.2.7 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L14](#license-text-l14) |
| @fontsource/fira-code | 5.2.7 | OFL-1.1 | Copyright 2014-2020 The Fira Code Project Authors (https://github.com/tonsky/FiraCode); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/fredoka | 5.2.10 | OFL-1.1 | Copyright 2016 The Fredoka Project Authors (https://github.com/hafontia/Fredoka-One); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/jetbrains-mono | 5.2.8 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L15](#license-text-l15) |
| @fontsource/kalam | 5.2.8 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L16](#license-text-l16) |
| @fontsource/manrope | 5.2.8 | OFL-1.1 | Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/merriweather | 5.2.11 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L17](#license-text-l17) |
| @fontsource/nunito | 5.2.7 | OFL-1.1 | Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito) Nunito-Italic[wght].ttf: Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/patrick-hand | 5.2.8 | OFL-1.1 | Copyright (c) 2010-2012 Patrick Wagesreiter (mail@patrickwagesreiter.at); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/permanent-marker | 5.2.7 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @fontsource/poppins | 5.2.7 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L19](#license-text-l19) |
| @fontsource/righteous | 5.2.7 | OFL-1.1 | Copyright (c) 2011 by Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Name "Righteous"; "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/sora | 5.2.8 | OFL-1.1 | Copyright 2019 The Sora Project Authors (https://github.com/sora-xor/sora-font); "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L11](#license-text-l11) |
| @fontsource/space-mono | 5.2.9 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L20](#license-text-l20) |
| @fontsource/work-sans | 5.2.8 | OFL-1.1 | "Font Software" refers to the set of files released by the Copyright; copyright statement(s).; distributed by the Copyright Holder(s). | [L21](#license-text-l21) |
| @google/genai | 1.46.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @huggingface/jinja | 0.2.2 | MIT | Copyright (c) 2023 Hugging Face; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @img/colour | 1.1.0 | MIT | Copyright (c) 2012 Heather Arthur; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L22](#license-text-l22) |
| @img/sharp-darwin-arm64 | 0.34.5 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by the copyright; available under the License, as indicated by a copyright notice that is included; by the copyright owner or by an individual or Legal Entity authorized to submit | [L23](#license-text-l23) |
| @img/sharp-darwin-x64 | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-libvips-darwin-arm64 | 1.2.4 | LGPL-3.0-or-later | Copyright (c) Lovell Fuller | no license file in package; standard LGPL-3.0-or-later terms |
| @img/sharp-libvips-darwin-x64 | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-libvips-linux-arm | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-libvips-linux-arm64 | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-libvips-linux-ppc64 | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-libvips-linux-riscv64 | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-libvips-linux-s390x | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-libvips-linux-x64 | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-libvips-linuxmusl-arm64 | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-libvips-linuxmusl-x64 | 1.2.4 | LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-linux-arm | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-linux-arm64 | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-linux-ppc64 | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-linux-riscv64 | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-linux-s390x | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-linux-x64 | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-linuxmusl-arm64 | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-linuxmusl-x64 | 0.34.5 | Apache-2.0 |  | platform binary not installed where generated |
| @img/sharp-wasm32 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT |  | platform binary not installed where generated |
| @img/sharp-win32-arm64 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-win32-ia32 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later |  | platform binary not installed where generated |
| @img/sharp-win32-x64 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later |  | platform binary not installed where generated |
| @jridgewell/gen-mapping | 0.3.13 | MIT | Copyright 2024 Justin Ridgewell &lt;justin@ridgewell.name>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| @jridgewell/resolve-uri | 3.1.2 | MIT | Copyright 2019 Justin Ridgewell &lt;jridgewell@google.com>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT | Copyright 2024 Justin Ridgewell &lt;justin@ridgewell.name>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| @jridgewell/trace-mapping | 0.3.31 | MIT | Copyright 2024 Justin Ridgewell &lt;justin@ridgewell.name>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| @libsql/client | 0.17.2 | MIT |  | no license file in package; standard MIT terms |
| @libsql/core | 0.17.2 | MIT |  | no license file in package; standard MIT terms |
| @libsql/darwin-arm64 | 0.5.29 | MIT | Copyright (c) Pekka Enberg | no license file in package; standard MIT terms |
| @libsql/darwin-x64 | 0.5.29 | MIT |  | platform binary not installed where generated |
| @libsql/hrana-client | 0.9.0 | MIT | Copyright 2023 the sqld authors; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L24](#license-text-l24) |
| @libsql/isomorphic-ws | 0.1.5 | MIT |  | no license file in package; standard MIT terms |
| @libsql/linux-arm-gnueabihf | 0.5.29 | MIT |  | platform binary not installed where generated |
| @libsql/linux-arm-musleabihf | 0.5.29 | MIT |  | platform binary not installed where generated |
| @libsql/linux-arm64-gnu | 0.5.29 | MIT |  | platform binary not installed where generated |
| @libsql/linux-arm64-musl | 0.5.29 | MIT |  | platform binary not installed where generated |
| @libsql/linux-x64-gnu | 0.5.29 | MIT |  | platform binary not installed where generated |
| @libsql/linux-x64-musl | 0.5.29 | MIT |  | platform binary not installed where generated |
| @libsql/win32-x64-msvc | 0.5.29 | MIT |  | platform binary not installed where generated |
| @lobehub/icons | 5.10.0 | MIT | Copyright (c) 2023 LobeHub; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @magenta/music | 1.23.1 | Apache-2.0 | Copyright (c) Magenta | no license file in package; standard Apache-2.0 terms |
| @mediapipe/tasks-vision | 0.10.17 | Apache-2.0 | Copyright (c) mediapipe@google.com | no license file in package; standard Apache-2.0 terms |
| @monaco-editor/loader | 1.7.0 | MIT | Copyright (c) 2021 Suren Atoyan; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @monaco-editor/react | 4.7.0 | MIT | Copyright (c) 2018 Suren Atoyan; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @msgpack/msgpack | 3.1.3 | ISC | Copyright 2019 The MessagePack Community. | [L25](#license-text-l25) |
| @napi-rs/canvas | 0.1.100 | MIT | Copyright (c) 2020 lynweklm@gmail.com; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @napi-rs/canvas-android-arm64 | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-darwin-arm64 | 0.1.100 | MIT |  | no license file in package; standard MIT terms |
| @napi-rs/canvas-darwin-x64 | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-linux-arm-gnueabihf | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-linux-arm64-gnu | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-linux-arm64-musl | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-linux-riscv64-gnu | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-linux-x64-gnu | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-linux-x64-musl | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-win32-arm64-msvc | 0.1.100 | MIT |  | platform binary not installed where generated |
| @napi-rs/canvas-win32-x64-msvc | 0.1.100 | MIT |  | platform binary not installed where generated |
| @neon-rs/load | 0.0.4 | MIT | Copyright (c) 2023 David Herman; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @next/env | 16.2.1 | MIT | Copyright (c) Next.js Team | no license file in package; standard MIT terms |
| @next/swc-darwin-arm64 | 16.2.1 | MIT |  | no license file in package; standard MIT terms |
| @next/swc-darwin-x64 | 16.2.1 | MIT |  | platform binary not installed where generated |
| @next/swc-linux-arm64-gnu | 16.2.1 | MIT |  | platform binary not installed where generated |
| @next/swc-linux-arm64-musl | 16.2.1 | MIT |  | platform binary not installed where generated |
| @next/swc-linux-x64-gnu | 16.2.1 | MIT |  | platform binary not installed where generated |
| @next/swc-linux-x64-musl | 16.2.1 | MIT |  | platform binary not installed where generated |
| @next/swc-win32-arm64-msvc | 16.2.1 | MIT |  | platform binary not installed where generated |
| @next/swc-win32-x64-msvc | 16.2.1 | MIT |  | platform binary not installed where generated |
| @opentelemetry/api | 1.9.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/api-logs | 0.53.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/api-logs | 0.57.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/api-logs | 0.57.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/context-async-hooks | 1.30.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/core | 1.30.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation | 0.53.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation | 0.57.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation | 0.57.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-amqplib | 0.46.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-connect | 0.43.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-dataloader | 0.16.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-express | 0.47.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-fastify | 0.44.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-fs | 0.19.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-generic-pool | 0.43.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-graphql | 0.47.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-hapi | 0.45.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-http | 0.57.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-ioredis | 0.47.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-kafkajs | 0.7.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-knex | 0.44.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-koa | 0.47.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-lru-memoizer | 0.44.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-mongodb | 0.51.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-mongoose | 0.46.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-mysql | 0.45.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-mysql2 | 0.45.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-nestjs-core | 0.44.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-pg | 0.50.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-redis-4 | 0.46.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-tedious | 0.18.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/instrumentation-undici | 0.10.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/redis-common | 0.36.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/resources | 1.30.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/sdk-trace-base | 1.30.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/semantic-conventions | 1.27.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/semantic-conventions | 1.28.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/semantic-conventions | 1.41.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @opentelemetry/sql-common | 0.40.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @pixi/colord | 2.9.6 | MIT | Copyright (c) Vlad Shilov | no license file in package; standard MIT terms |
| @prisma/instrumentation | 5.22.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/codegen | 2.0.4 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/eventemitter | 1.1.0 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/fetch | 1.1.0 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/float | 1.0.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/inquire | 1.1.0 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/path | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @protobufjs/utf8 | 1.1.0 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L27](#license-text-l27) |
| @rc-component/util | 1.11.1 | MIT | Copyright (c) 2014-present yiminghe; Copyright (c) 2015-present Alipay.com, https://www.alipay.com/; The above copyright notice and this permission notice shall be included in | [L28](#license-text-l28) |
| @sentry-internal/browser-utils | 8.55.0 | MIT | Copyright (c) 2020-2024 Functional Software, Inc. dba Sentry; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @sentry-internal/feedback | 8.55.0 | MIT | Copyright (c) 2023-2024 Functional Software, Inc. dba Sentry; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @sentry-internal/replay | 8.55.0 | MIT | Copyright (c) 2022-2024 Functional Software, Inc. dba Sentry; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @sentry-internal/replay-canvas | 8.55.0 | MIT | Copyright (c) 2024 Functional Software, Inc. dba Sentry; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @sentry/browser | 8.55.0 | MIT | Copyright (c) 2019-2024 Functional Software, Inc. dba Sentry; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @sentry/core | 8.55.0 | MIT | Copyright (c) 2019-2024 Functional Software, Inc. dba Sentry; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @sentry/electron | 5.12.0 | MIT | Copyright (c) 2018 Functional Software, Inc. dba Sentry; Copyright (c) 2017 Tim Fish; The above copyright notice and this permission notice shall be included in all | [L3](#license-text-l3) |
| @sentry/node | 8.55.0 | MIT | Copyright (c) 2023-2024 Functional Software, Inc. dba Sentry; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @sentry/opentelemetry | 8.55.0 | MIT | Copyright (c) 2023-2024 Functional Software, Inc. dba Sentry; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| @swc/helpers | 0.5.15 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @tensorflow/tfjs | 2.8.6 | Apache-2.0 |  | no license file in package; standard Apache-2.0 terms |
| @tensorflow/tfjs-backend-cpu | 2.8.6 | Apache-2.0 |  | no license file in package; standard Apache-2.0 terms |
| @tensorflow/tfjs-backend-webgl | 2.8.6 | Apache-2.0 |  | no license file in package; standard Apache-2.0 terms |
| @tensorflow/tfjs-converter | 2.8.6 | Apache-2.0 |  | no license file in package; standard Apache-2.0 terms |
| @tensorflow/tfjs-core | 2.8.6 | Apache-2.0 |  | no license file in package; standard Apache-2.0 terms |
| @tensorflow/tfjs-data | 2.8.6 | Apache-2.0 |  | no license file in package; standard Apache-2.0 terms |
| @tensorflow/tfjs-layers | 2.8.6 | Apache-2.0 AND MIT | COPYRIGHT; Copyright (c) 2015 - 2018, François Chollet.; Copyright (c) 2015 - 2018, Google LLC. | [L29](#license-text-l29) |
| @tonaljs/abc-notation | 4.9.1 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/array | 4.8.4 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/chord | 6.1.2 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/chord-detect | 4.9.1 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/chord-type | 5.1.1 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/collection | 4.9.0 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/core | 5.0.2 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/duration-value | 4.9.0 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/interval | 5.1.0 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/key | 4.11.2 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/midi | 4.10.2 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/mode | 4.9.2 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/note | 4.12.1 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/pcset | 4.10.1 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/pitch | 5.0.2 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/pitch-distance | 5.0.5 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/pitch-interval | 6.1.0 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/pitch-note | 6.1.0 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/progression | 4.9.2 | MIT | Copyright (c) danigb@gmail.com | no license file in package; standard MIT terms |
| @tonaljs/range | 4.9.2 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/rhythm-pattern | 1.0.0 | MIT | Copyright (c) danigb@gmail.com | no license file in package; standard MIT terms |
| @tonaljs/roman-numeral | 4.9.1 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/scale | 4.13.4 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/scale-type | 4.9.2 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/time-signature | 4.9.0 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/voice-leading | 5.1.2 | MIT | Copyright (c) 2020 felixroos; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/voicing | 5.1.3 | MIT | Copyright (c) 2020 felixroos; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonaljs/voicing-dictionary | 5.1.3 | MIT | Copyright (c) 2020 felixroos; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| @tonejs/midi | 2.0.28 | MIT | Copyright © 2016 Yotam Mann; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L30](#license-text-l30) |
| @types/connect | 3.4.36 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/debug | 4.1.13 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/dom-mediacapture-transform | 0.1.11 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/dom-webcodecs | 0.1.13 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/earcut | 3.0.0 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/estree | 1.0.8 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/estree-jsx | 1.0.5 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/hast | 3.0.4 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/long | 4.0.2 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/mdast | 4.0.4 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/ms | 2.1.0 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/mysql | 2.15.26 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/node | 18.19.130 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/node | 22.20.3 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/node-fetch | 2.6.13 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/offscreencanvas | 2019.3.0 | MIT | Copyright (c) Microsoft Corporation. All rights reserved.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/parse-json | 4.0.2 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/pg | 8.6.1 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/pg-pool | 2.0.6 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/retry | 0.12.0 | MIT | Copyright (c) Microsoft Corporation. All rights reserved.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/seedrandom | 2.4.27 | MIT | Copyright (c) Kern Handa | no license file in package; standard MIT terms |
| @types/shimmer | 1.2.0 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/tedious | 4.0.14 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/trusted-types | 2.0.7 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/unist | 2.0.11 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/unist | 3.0.3 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/webgl-ext | 0.0.30 | MIT | Copyright (c) Microsoft Corporation. All rights reserved.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/webgl2 | 0.0.5 | MIT | Copyright (c) Microsoft Corporation. All rights reserved.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @types/ws | 8.18.1 | MIT | Copyright (c) Microsoft Corporation.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L31](#license-text-l31) |
| @ungap/structured-clone | 1.3.0 | ISC | Copyright (c) 2021, Andrea Giammarchi, @WebReflection; copyright notice and this permission notice appear in all copies. | [L32](#license-text-l32) |
| @webgpu/types | 0.1.69 | BSD-3-Clause | Copyright 2022 WebGPU Developers; 1. Redistributions of source code must retain the above copyright notice,; 2. Redistributions in binary form must reproduce the above copyright notice, | [L33](#license-text-l33) |
| @xenova/transformers | 2.17.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| @xmldom/xmldom | 0.8.12 | MIT | Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors; Copyright 2012 - 2017 @jindw &lt;jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L2](#license-text-l2) |
| abort-controller | 3.0.0 | MIT | Copyright (c) 2017 Toru Nagashima; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| acorn | 7.4.1 | MIT | Copyright (C) 2012-2018 by various contributors (see AUTHORS); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L34](#license-text-l34) |
| acorn | 8.16.0 | MIT | Copyright (C) 2012-2022 by various contributors (see AUTHORS); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L34](#license-text-l34) |
| acorn-import-attributes | 1.9.5 | MIT | Copyright (c) 2023 Sven Sauleau; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| agent-base | 7.1.4 | MIT | Copyright (c) 2013 Nathan Rajlich &lt;nathan@tootallnate.net>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| agentkeepalive | 4.6.0 | MIT | Copyright(c) node-modules and other contributors.; Copyright(c) 2012 - 2015 fengmk2 &lt;fengmk2@gmail.com>; The above copyright notice and this permission notice shall be | [L36](#license-text-l36) |
| ajv | 8.18.0 | MIT | Copyright (c) 2015-2021 Evgeny Poberezkin; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| align-text | 0.1.4 | MIT | Copyright (c) 2015, Jon Schlinkert.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| amdefine | 1.0.1 | BSD-3-Clause OR MIT | Copyright (c) 2011-2016, The Dojo Foundation; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L38](#license-text-l38) |
| ansi-regex | 5.0.1 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| ansi-styles | 4.3.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| antd-style | 4.1.0 | MIT | Copyright (c) 2022-current Arvin Xu; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| argparse | 1.0.10 | MIT | Copyright (C) 2012 by Vitaly Puzrin; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L40](#license-text-l40) |
| argparse | 2.0.1 | Python-2.0 | provided, however, that PSF's License Agreement and PSF's notice of copyright,; i.e., "Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,; License Agreement and CNRI's notice of copyright, i.e., "Copyright (c) | [L41](#license-text-l41) |
| array-flatten | 3.0.0 | MIT | Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| async | 0.2.10 | UNKNOWN | Copyright (c) 2010 Caolan McMahon; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| asynckit | 0.4.0 | MIT | Copyright (c) 2016 Alex Indigo; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| automation-events | 7.1.19 | MIT | Copyright (c) 2026 Christoph Guttandin; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| b4a | 1.8.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| babel-plugin-macros | 3.1.0 | MIT | Copyright (c) 2020 Kent C. Dodds; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| bail | 2.0.2 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| bare-events | 2.9.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| bare-fs | 4.7.4 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| bare-path | 3.1.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| bare-stream | 2.13.3 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| bare-url | 2.4.5 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| base64-arraybuffer | 1.0.2 | MIT | Copyright (c) 2012 Niklas von Hertzen; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L4](#license-text-l4) |
| base64-js | 1.5.1 | MIT | Copyright (c) 2014 Jameson Little; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| baseline-browser-mapping | 2.10.10 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| bidi-js | 1.0.3 | MIT | Copyright (c) 2021 Jason Johnston; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L5](#license-text-l5) |
| bignumber.js | 9.3.1 | MIT | Copyright © `&lt;2025>` `Michael Mclaughlin`; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L42](#license-text-l42) |
| bit-twiddle | 1.0.2 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| bl | 4.1.0 | MIT | Copyright (c) 2013-2019 bl contributors; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L43](#license-text-l43) |
| buffer | 5.7.1 | MIT | Copyright (c) Feross Aboukhadijeh, and other contributors.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause | Copyright (c) 2013, GoInstant Inc., a salesforce.com company; * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. | [L44](#license-text-l44) |
| buffer-from | 1.1.2 | MIT | Copyright (c) 2016, 2018 Linus Unnebäck; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| builder-util-runtime | 9.5.1 | MIT | Copyright (c) 2015 Loopline Systems; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| call-bind-apply-helpers | 1.0.2 | MIT | Copyright (c) 2024 Jordan Harband; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| callsites | 3.1.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| camelcase | 1.2.1 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| caniuse-lite | 1.0.30001781 | CC-BY-4.0 | original works of authorship and other material subject to copyright; copyright and certain other rights. Our licenses are; limitation to copyright. More considerations for licensors: | [L45](#license-text-l45) |
| ccount | 2.0.1 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| center-align | 0.1.3 | MIT | Copyright (c) 2015, Jon Schlinkert.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| chalk | 4.1.2 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| character-entities | 2.0.2 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| character-entities-html4 | 2.1.0 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| character-entities-legacy | 3.0.0 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| character-reference-invalid | 2.0.1 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| chownr | 1.1.4 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| cjs-module-lexer | 1.4.3 | MIT | Copyright (C) 2018-2020 Guy Bedford; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L47](#license-text-l47) |
| client-only | 0.0.1 | MIT |  | no license file in package; standard MIT terms |
| cliui | 2.1.0 | ISC | Copyright (c) 2015, Contributors; that the above copyright notice and this permission notice | [L48](#license-text-l48) |
| cliui | 7.0.4 | ISC | Copyright (c) 2015, Contributors; that the above copyright notice and this permission notice | [L48](#license-text-l48) |
| clsx | 2.1.1 | MIT | Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com> (lukeed.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| color | 4.2.3 | MIT | Copyright (c) 2012 Heather Arthur; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L49](#license-text-l49) |
| color-convert | 2.0.1 | MIT | Copyright (c) 2011-2016 Heather Arthur &lt;fayearthur@gmail.com>; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L49](#license-text-l49) |
| color-name | 1.1.4 | MIT | Copyright (c) 2015 Dmitry Ivanov; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L1](#license-text-l1) |
| color-string | 1.9.1 | MIT | Copyright (c) 2011 Heather Arthur &lt;fayearthur@gmail.com>; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L49](#license-text-l49) |
| combined-stream | 1.0.8 | MIT | Copyright (c) 2011 Debuggable Limited &lt;felix@debuggable.com>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| comma-separated-tokens | 2.0.3 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| concat-stream | 1.6.2 | MIT | Copyright (c) 2013 Max Ogden; The above copyright notice and this permission notice; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR | [L50](#license-text-l50) |
| convert-source-map | 1.9.0 | MIT | Copyright 2013 Thorsten Lorenz.; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L51](#license-text-l51) |
| core-js | 3.49.0 | MIT | Copyright (c) 2013–2025 Denis Pushkarev (zloirock.ru); Copyright (c) 2025–2026 CoreJS Company (core-js.io); The above copyright notice and this permission notice shall be included in | [L6](#license-text-l6) |
| core-util-is | 1.0.2 | MIT | Copyright Node.js contributors. All rights reserved.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| cosmiconfig | 7.1.0 | MIT | Copyright (c) 2015 David Clark; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| cross-fetch | 4.1.0 | MIT | Copyright (c) 2017 Leonardo Quixadá; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| css-line-break | 2.1.0 | MIT | Copyright (c) 2017 Niklas von Hertzen; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L4](#license-text-l4) |
| css-tree | 3.2.1 | MIT | Copyright (C) 2016-2026 by Roman Dvornov; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| csstype | 3.2.3 | MIT | Copyright (c) 2017-2018 Fredrik Nicol; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L7](#license-text-l7) |
| cwise | 1.0.10 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| cwise-compiler | 1.1.3 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| cwise-parser | 1.0.3 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| data-uri-to-buffer | 4.0.1 | MIT | Copyright (c) Nathan Rajlich (http://n8.io/) | no license file in package; standard MIT terms |
| data-urls | 7.0.0 | MIT | Copyright © Domenic Denicola &lt;d@domenic.me>; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L2](#license-text-l2) |
| debug | 4.4.3 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk &lt;tj@vision-media.ca>; Copyright (c) 2018-2021 Josh Junon; The above copyright notice and this permission notice shall be included in all copies or substantial | [L52](#license-text-l52) |
| decamelize | 1.2.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| decimal.js | 10.6.0 | MIT | Copyright (c) 2025 Michael Mclaughlin; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L53](#license-text-l53) |
| decode-named-character-reference | 1.3.0 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| decompress-response | 6.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (https://sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| deep-extend | 0.6.0 | MIT | Copyright (c) 2013-2018, Viacheslav Lotsmanov; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| deepmerge | 4.3.1 | MIT | Copyright (c) 2012 James Halliday, Josh Duff, and other contributors; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| delayed-stream | 1.0.0 | MIT | Copyright (c) 2011 Debuggable Limited &lt;felix@debuggable.com>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| dequal | 2.0.3 | MIT | Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com> (lukeed.com); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| detect-libc | 2.0.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L54](#license-text-l54) |
| detect-libc | 2.1.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L54](#license-text-l54) |
| devlop | 1.1.0 | MIT | Copyright (c) 2023 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| dompurify | 3.4.7 | (MPL-2.0 OR Apache-2.0) | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| dotenv | 17.3.1 | BSD-2-Clause | Copyright (c) 2015, Scott Motte; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L55](#license-text-l55) |
| drizzle-orm | 0.45.1 | Apache-2.0 | Copyright (c) Drizzle Team | no license file in package; standard Apache-2.0 terms |
| dunder-proto | 1.0.1 | MIT | Copyright (c) 2024 ECMAScript Shims; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| dup | 1.0.0 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| duplexer2 | 0.0.2 | BSD | Copyright (c) 2013, Deoxxa Development; 1. Redistributions of source code must retain the above copyright; 2. Redistributions in binary form must reproduce the above copyright | [L56](#license-text-l56) |
| earcut | 3.0.2 | ISC | Copyright (c) 2024, Mapbox; with or without fee is hereby granted, provided that the above copyright notice | [L57](#license-text-l57) |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L54](#license-text-l54) |
| electron-updater | 6.8.3 | MIT | Copyright (c) 2015 Loopline Systems; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| emoji-regex | 8.0.0 | MIT | Copyright (c) Mathias Bynens | no license file in package; standard MIT terms |
| end-of-stream | 1.4.5 | MIT | Copyright (c) 2014 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| entities | 8.0.0 | BSD-2-Clause | Copyright (c) Felix Böhm; Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. | [L58](#license-text-l58) |
| error-ex | 1.3.4 | MIT | Copyright (c) 2015 JD Ballard; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| es-define-property | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| es-errors | 1.3.0 | MIT | Copyright (c) 2024 Jordan Harband; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| es-object-atoms | 1.1.1 | MIT | Copyright (c) 2024 Jordan Harband; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| es-set-tostringtag | 2.1.0 | MIT | Copyright (c) 2022 ECMAScript Shims; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| es-toolkit | 1.45.1 | MIT | Copyright (c) 2024 Viva Republica, Inc; Copyright OpenJS Foundation and other contributors; The above copyright notice and this permission notice shall be included in all | [L59](#license-text-l59) |
| escalade | 3.2.0 | MIT | Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com> (lukeed.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| escape-string-regexp | 4.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (https://sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| escodegen | 0.0.28 | UNKNOWN |  | no license file in package; standard UNKNOWN terms |
| escodegen | 1.3.3 | UNKNOWN |  | no license file in package; standard UNKNOWN terms |
| esprima | 1.0.4 | UNKNOWN |  | no license file in package; standard UNKNOWN terms |
| esprima | 1.1.1 | UNKNOWN | Copyright (c) Ariya Hidayat | no license file in package; standard UNKNOWN terms |
| esprima | 1.2.5 | UNKNOWN | Copyright (c) Ariya Hidayat | no license file in package; standard UNKNOWN terms |
| estraverse | 1.3.2 | UNKNOWN |  | no license file in package; standard UNKNOWN terms |
| estraverse | 1.5.1 | UNKNOWN |  | no license file in package; standard UNKNOWN terms |
| estree-util-is-identifier-name | 3.0.0 | MIT | Copyright (c) 2020 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| esutils | 1.0.0 | UNKNOWN |  | no license file in package; standard UNKNOWN terms |
| event-target-shim | 5.0.1 | MIT | Copyright (c) 2015 Toru Nagashima; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| eventemitter3 | 5.0.4 | MIT | Copyright (c) 2014 Arnout Kazemier; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| events-universal | 1.0.1 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| eventsource-parser | 1.1.2 | MIT | Copyright (c) 2024 Espen Hovlandsdal &lt;espen@hovlandsdal.com>; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| expand-template | 2.0.3 | (MIT OR WTFPL) | Copyright (c) 2018 Lars-Magnus Skog; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| extend | 3.0.2 | MIT | Copyright (c) 2014 Stefan Thomas; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L60](#license-text-l60) |
| falafel | 2.2.5 | MIT | Copyright (c) 2012 James Halliday; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| fast-deep-equal | 3.1.3 | MIT | Copyright (c) 2017 Evgeny Poberezkin; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| fast-fifo | 1.3.2 | MIT | Copyright (c) 2019 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| fast-uri | 3.1.0 | BSD-3-Clause | Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae; Copyright (c) 2021-present The Fastify team; * Redistributions of source code must retain the above copyright | [L61](#license-text-l61) |
| fetch-blob | 3.2.0 | MIT | Copyright (c) 2019 David Frank; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| fft.js | 4.0.4 | MIT | Copyright (c) Fedor Indutny | no license file in package; standard MIT terms |
| find-root | 1.1.0 | MIT | Copyright © 2017 jsdnxx; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L10](#license-text-l10) |
| fix-webm-duration | 1.0.6 | MIT | Copyright (c) 2018 Yury Sitnikov; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L62](#license-text-l62) |
| flatbuffers | 1.12.0 | SEE LICENSE IN LICENSE.txt | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| fluent-ffmpeg | 2.1.3 | MIT | Copyright (c) 2011-2015 The fluent-ffmpeg contributors; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L63](#license-text-l63) |
| form-data | 4.0.5 | MIT | Copyright (c) 2012 Felix Geisendörfer (felix@debuggable.com) and contributors; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| form-data-encoder | 1.7.2 | MIT | Copyright (c) 2021-present Nick K.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| formdata-node | 4.4.1 | MIT | Copyright (c) 2017-present Nick K.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| formdata-polyfill | 4.0.10 | MIT | Copyright (c) 2016 Jimmy Karl Roland Wärting; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| forwarded-parse | 2.1.2 | MIT | Copyright (c) 2015 Luigi Pinca; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| framer-motion | 12.38.0 | MIT | Copyright (c) 2018 Framer B.V.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| fs-constants | 1.0.0 | MIT | Copyright (c) 2018 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| fs-extra | 10.1.0 | MIT | Copyright (c) 2011-2017 JP Richardson; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.; OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, | [L64](#license-text-l64) |
| function-bind | 1.1.2 | MIT | Copyright (c) 2013 Raynos.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| gaxios | 7.1.4 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| gcp-metadata | 8.1.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| geist | 1.7.0 | SIL OPEN FONT LICENSE | Copyright (c) 2023 Vercel, in collaboration with basement.studio; "Font Software" refers to the set of files released by the Copyright; copyright statement(s). | [L65](#license-text-l65) |
| get-caller-file | 2.0.5 | ISC | Copyright 2018 Stefan Penner | [L66](#license-text-l66) |
| get-intrinsic | 1.3.0 | MIT | Copyright (c) 2020 Jordan Harband; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| get-proto | 1.0.1 | MIT | Copyright (c) 2025 Jordan Harband; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| gifuct-js | 2.1.2 | MIT | Copyright (c) 2015 Matt Way; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| github-from-package | 0.0.0 | MIT | The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L67](#license-text-l67) |
| google-auth-library | 10.6.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| google-logging-utils | 1.1.3 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| gopd | 1.2.0 | MIT | Copyright (c) 2022 Jordan Harband; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| graceful-fs | 4.2.11 | ISC | Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| guid-typescript | 1.0.9 | ISC | Copyright (c) nicolas | no license file in package; standard ISC terms |
| has | 1.0.4 | MIT | Copyright (c) Thiago de Arruda | no license file in package; standard MIT terms |
| has-flag | 4.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| has-symbols | 1.1.0 | MIT | Copyright (c) 2016 Jordan Harband; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| has-tostringtag | 1.0.2 | MIT | Copyright (c) 2021 Inspect JS; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| hasown | 2.0.2 | MIT | Copyright (c) Jordan Harband and contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| hast-util-to-jsx-runtime | 2.3.6 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| hast-util-whitespace | 3.0.0 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| hoist-non-react-statics | 3.3.2 | BSD-3-Clause | Copyright (c) 2015, Yahoo! Inc. All rights reserved.; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L68](#license-text-l68) |
| html-encoding-sniffer | 6.0.0 | MIT | Copyright © Domenic Denicola &lt;d@domenic.me>; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L2](#license-text-l2) |
| html-url-attributes | 3.0.1 | MIT | Copyright (c) Titus Wormer; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L40](#license-text-l40) |
| html2canvas | 1.4.1 | MIT | Copyright (c) 2012 Niklas von Hertzen; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L4](#license-text-l4) |
| https-proxy-agent | 7.0.6 | MIT | Copyright (c) 2013 Nathan Rajlich &lt;nathan@tootallnate.net>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| humanize-ms | 1.2.1 | MIT | The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| ieee754 | 1.2.1 | BSD-3-Clause | Copyright 2008 Fair Oaks Labs, Inc.; 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.; 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission. | [L69](#license-text-l69) |
| import-fresh | 3.3.1 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (https://sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| import-in-the-middle | 1.15.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| inherits | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| ini | 1.3.8 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| inline-style-parser | 0.2.7 | MIT | Copyright (c) 2012 TJ Holowaychuk &lt;tj@vision-media.ca>; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L63](#license-text-l63) |
| iota-array | 1.0.0 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| is-alphabetical | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| is-alphanumerical | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| is-arrayish | 0.2.1 | MIT | Copyright (c) 2015 JD Ballard; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| is-arrayish | 0.3.4 | MIT | Copyright (c) 2015 JD Ballard; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| is-buffer | 1.1.6 | MIT | Copyright (c) Feross Aboukhadijeh; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| is-core-module | 2.16.1 | MIT | Copyright (c) 2014 Dave Justice; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| is-decimal | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| is-fullwidth-code-point | 3.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| is-hexadecimal | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| is-mobile | 5.0.0 | MIT | Copyright (c) Julian Gruber | no license file in package; standard MIT terms |
| is-plain-obj | 4.1.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (https://sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| is-potential-custom-element-name | 1.0.1 | MIT | Copyright (c) Mathias Bynens | no license file in package; standard MIT terms |
| isarray | 0.0.1 | MIT | Copyright (c) Julian Gruber | no license file in package; standard MIT terms |
| isarray | 1.0.0 | MIT | Copyright (c) Julian Gruber | no license file in package; standard MIT terms |
| isarray | 2.0.5 | MIT | Copyright (c) 2013 Julian Gruber &lt;julian@juliangruber.com>; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| isexe | 2.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| ismobilejs | 1.1.1 | MIT | Copyright (c) 2019 Kai Mallea; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| js-base64 | 3.7.8 | BSD-3-Clause | Copyright (c) 2014, Dan Kogai; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L70](#license-text-l70) |
| js-binary-schema-parser | 2.0.3 | MIT | Copyright (c) 2015 Matt Way; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| js-tokens | 4.0.0 | MIT | Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| js-yaml | 4.1.1 | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L40](#license-text-l40) |
| jsdom | 29.1.1 | MIT | Copyright (c) 2010 Elijah Insua; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L4](#license-text-l4) |
| jsesc | 3.1.0 | MIT | Copyright (c) Mathias Bynens | no license file in package; standard MIT terms |
| jsfxr | 1.4.1 | UNKNOWN |  | no license file in package; standard UNKNOWN terms |
| json-bigint | 1.0.0 | MIT | Copyright (c) 2013 Andrey Sidorov; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| json-parse-even-better-errors | 2.3.1 | MIT | Copyright 2017 Kat Marchán; Copyright npm, Inc.; The above copyright notice and this permission notice shall be included in | [L71](#license-text-l71) |
| json-schema-traverse | 1.0.0 | MIT | Copyright (c) 2017 Evgeny Poberezkin; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| jsonfile | 6.2.0 | MIT | Copyright (c) 2012-2015, JP Richardson &lt;jprichardson@gmail.com>; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.; OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, | [L64](#license-text-l64) |
| jwa | 2.0.1 | MIT | Copyright (c) 2013 Brian J. Brennan; The above copyright notice and this permission notice shall be included in all; PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE | [L72](#license-text-l72) |
| jws | 4.0.1 | MIT | Copyright (c) 2013 Brian J. Brennan; The above copyright notice and this permission notice shall be included in all; PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE | [L72](#license-text-l72) |
| kind-of | 3.2.2 | MIT | Copyright (c) 2014-2017, Jon Schlinkert; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| lazy-cache | 1.0.4 | MIT | Copyright (c) 2015-2016, Jon Schlinkert.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| lazy-val | 1.0.5 | MIT | Copyright (c) Vladimir Krivosheev | no license file in package; standard MIT terms |
| libsql | 0.5.29 | MIT | Copyright (c) 2017 Joshua Wise; Copyright (c) 2023 Pekka Enberg; The above copyright notice and this permission notice shall be included in all | [L26](#license-text-l26) |
| lines-and-columns | 1.2.4 | MIT | Copyright (c) 2015 Brian Donovan; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| lodash.escaperegexp | 4.1.2 | MIT | Copyright jQuery Foundation and other contributors &lt;https://jquery.org/>; Based on Underscore.js, copyright Jeremy Ashkenas,; The above copyright notice and this permission notice shall be | [L73](#license-text-l73) |
| lodash.isequal | 4.5.0 | MIT | Copyright JS Foundation and other contributors &lt;https://js.foundation/>; Based on Underscore.js, copyright Jeremy Ashkenas,; The above copyright notice and this permission notice shall be | [L73](#license-text-l73) |
| long | 4.0.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| long | 5.3.2 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| longest | 1.0.1 | MIT | Copyright (c) 2014-2015, Jon Schlinkert.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| longest-streak | 3.1.0 | MIT | Copyright (c) 2015 Titus Wormer &lt;mailto:tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| loose-envify | 1.4.0 | MIT | Copyright (c) 2015 Andres Suarez &lt;zertosh@gmail.com>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| lru-cache | 11.5.1 | BlueOak-1.0.0 | ## Copyright; copyright in it. | [L74](#license-text-l74) |
| lucide-react | 0.400.0 | ISC | Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.; copyright notice and this permission notice appear in all copies. | [L32](#license-text-l32) |
| lucide-react | 0.469.0 | ISC | Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.; copyright notice and this permission notice appear in all copies. | [L32](#license-text-l32) |
| math-intrinsics | 1.1.0 | MIT | Copyright (c) 2024 ECMAScript Shims; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| mdast-util-from-markdown | 2.0.3 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| mdast-util-mdx-expression | 2.0.1 | MIT | Copyright (c) 2020 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| mdast-util-mdx-jsx | 3.2.0 | MIT | Copyright (c) 2020 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| mdast-util-mdxjs-esm | 2.0.1 | MIT | Copyright (c) 2020 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| mdast-util-phrasing | 4.1.0 | MIT | Copyright (c) 2017 Titus Wormer &lt;tituswormer@gmail.com>; Copyright (c) 2017 Victor Felder &lt;victor@draft.li>; The above copyright notice and this permission notice shall be | [L35](#license-text-l35) |
| mdast-util-to-hast | 13.2.1 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| mdast-util-to-markdown | 2.1.2 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| mdast-util-to-string | 4.0.0 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| mdn-data | 2.27.1 | CC0-1.0 | exclusive Copyright and Related Rights (defined below) upon the creator and; Work (the "Affirmer"), to the extent that he or she is an owner of Copyright; Copyright and Related Rights in the Work and the meaning and intended legal | [L75](#license-text-l75) |
| mediabunny | 1.40.1 | MPL-2.0 | (c) under Patent Claims infringed by Covered Software in the absence of; applicable copyright doctrines of fair use, fair dealing, or other; (including copyright notices, patent notices, disclaimers of warranty, | [L76](#license-text-l76) |
| micromark | 4.0.2 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-core-commonmark | 2.0.3 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-factory-destination | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-factory-label | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-factory-space | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-factory-title | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-factory-whitespace | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-character | 2.1.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-chunked | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-classify-character | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-combine-extensions | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-decode-string | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-encode | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-html-tag-name | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-normalize-identifier | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-resolve-all | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-sanitize-uri | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-subtokenize | 2.1.0 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-symbol | 2.0.1 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| micromark-util-types | 2.0.2 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| midi-file | 1.2.4 | MIT | Copyright © 2016 Carter Thaxton; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L30](#license-text-l30) |
| mime-db | 1.52.0 | MIT | Copyright (c) 2014 Jonathan Ong &lt;me@jongleberry.com>; Copyright (c) 2015-2022 Douglas Christopher Wilson &lt;doug@somethingdoug.com>; The above copyright notice and this permission notice shall be | [L35](#license-text-l35) |
| mime-types | 2.1.35 | MIT | Copyright (c) 2014 Jonathan Ong &lt;me@jongleberry.com>; Copyright (c) 2015 Douglas Christopher Wilson &lt;doug@somethingdoug.com>; The above copyright notice and this permission notice shall be | [L35](#license-text-l35) |
| mimic-response | 3.1.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (https://sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| minimist | 0.0.8 | MIT | The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L67](#license-text-l67) |
| minimist | 1.2.8 | MIT | The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L67](#license-text-l67) |
| mkdirp-classic | 0.5.3 | MIT | Copyright (c) 2020 James Halliday (mail@substack.net) and Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| module-details-from-path | 1.0.4 | MIT | Copyright (c) 2016-2025 Thomas Watson Steen; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| motion | 12.38.0 | MIT | Copyright (c) 2024 [Motion](https://motion.dev) B.V.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| motion-dom | 12.38.0 | MIT | Copyright (c) 2024 [Motion](https://motion.dev) B.V.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| motion-utils | 12.36.0 | MIT | Copyright (c) 2024 [Motion](https://motion.dev) B.V.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| ms | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| nanoid | 3.3.11 | MIT | Copyright 2017 Andrey Sitnik &lt;andrey@sitnik.ru>; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| napi-build-utils | 2.0.0 | MIT | Copyright (c) 2018 inspiredware; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| ndarray | 1.0.19 | MIT | Copyright (c) 2013-2016 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| ndarray-fft | 1.0.3 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| ndarray-ops | 1.2.2 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| ndarray-resample | 1.0.1 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| ndarray-scratch | 1.2.0 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| next | 16.2.1 | MIT | Copyright (c) 2025 Vercel, Inc.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| node-abi | 3.94.0 | MIT | Copyright (c) 2016 Lukas Geiger; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| node-addon-api | 6.1.0 | MIT | Copyright (c) 2017 Node.js API collaborators; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L77](#license-text-l77) |
| node-domexception | 1.0.0 | MIT | Copyright (c) 2021 Jimmy Wärting; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| node-fetch | 2.6.13 | MIT | Copyright (c) 2016 David Frank; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| node-fetch | 2.7.0 | MIT | Copyright (c) 2016 David Frank; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| node-fetch | 3.3.2 | MIT | Copyright (c) 2016 - 2020 Node Fetch Team; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| object-inspect | 0.4.0 | MIT | The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L67](#license-text-l67) |
| object-keys | 0.4.0 | MIT | Copyright (c) Jordan Harband | no license file in package; standard MIT terms |
| once | 1.4.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| onnx-proto | 4.0.4 | MIT | Copyright 2017 Christoph Koerner; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L2](#license-text-l2) |
| onnxruntime-common | 1.14.0 | MIT | Copyright (c) fs-eire | no license file in package; standard MIT terms |
| onnxruntime-node | 1.14.0 | MIT | Copyright (c) fs-eire | no license file in package; standard MIT terms |
| onnxruntime-web | 1.14.0 | MIT | Copyright (c) fs-eire | no license file in package; standard MIT terms |
| openai | 6.33.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| p-retry | 4.6.2 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| parent-module | 1.0.1 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| parse-entities | 4.0.2 | MIT | Copyright (c) Titus Wormer &lt;mailto:tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| parse-json | 5.2.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (https://sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| parse-svg-path | 0.1.2 | MIT | Copyright (c) 2013 Jake Rosoman &lt;jkroso@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L36](#license-text-l36) |
| parse5 | 8.0.1 | MIT | Copyright (c) 2013-2019 Ivan Nikulin (ifaaan@gmail.com, https://github.com/inikulin); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| path-parse | 1.0.7 | MIT | Copyright (c) 2015 Javier Blanco; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| path-type | 4.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| pdfjs-dist | 4.10.38 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L78](#license-text-l78) |
| pg-int8 | 1.0.1 | ISC | Copyright © 2017, Charmander &lt;~@charmander.me>; copyright notice and this permission notice appear in all copies. | [L79](#license-text-l79) |
| pg-protocol | 1.13.0 | MIT | Copyright (c) 2010 - 2021 Brian Carlson; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| pg-types | 2.2.0 | MIT | Copyright (c) Brian M. Carlson | no license file in package; standard MIT terms |
| picocolors | 1.1.1 | ISC | Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov; copyright notice and this permission notice appear in all copies. | [L32](#license-text-l32) |
| pixi.js | 8.17.1 | MIT | Copyright (c) 2013-2023 Mathew Groves, Chad Engler; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L80](#license-text-l80) |
| platform | 1.3.6 | MIT | Copyright 2014-2020 Benjamin Tan; Copyright 2011-2013 John-David Dalton; The above copyright notice and this permission notice shall be | [L49](#license-text-l49) |
| polished | 4.3.1 | MIT | Copyright (c) 2016-Present Brian Hough and Maximilian Stoiber; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| postcss | 8.4.31 | MIT | Copyright 2013 Andrey Sitnik &lt;andrey@sitnik.ru>; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| postgres-array | 2.0.0 | MIT | Copyright (c) Ben Drucker &lt;bvdrucker@gmail.com> (bendrucker.me); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| postgres-bytea | 1.0.1 | MIT | Copyright (c) Ben Drucker &lt;bvdrucker@gmail.com> (bendrucker.me); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| postgres-date | 1.0.7 | MIT | Copyright (c) Ben Drucker &lt;bvdrucker@gmail.com> (bendrucker.me); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| postgres-interval | 1.2.0 | MIT | Copyright (c) Ben Drucker &lt;bvdrucker@gmail.com> (bendrucker.me); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| prebuild-install | 7.1.3 | MIT | Copyright (c) 2015 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| process-nextick-args | 2.0.1 | MIT | # Copyright (c) 2015 Calvin Metcalf; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L81](#license-text-l81) |
| promise-limit | 2.7.0 | ISC | Copyright (c) Tim Macfarlane | no license file in package; standard ISC terms |
| property-information | 7.1.0 | MIT | Copyright (c) Titus Wormer &lt;mailto:tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| protobufjs | 6.11.6 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L82](#license-text-l82) |
| protobufjs | 7.5.4 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz  All rights reserved.; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L82](#license-text-l82) |
| pump | 3.0.4 | MIT | Copyright (c) 2014 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| punycode | 2.3.1 | MIT | Copyright (c) Mathias Bynens | no license file in package; standard MIT terms |
| quote-stream | 0.0.0 | MIT | The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L67](#license-text-l67) |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | Copyright (c) Dominic Tarr (dominictarr.com) | no license file in package; standard (BSD-2-Clause OR MIT OR Apache-2.0) terms |
| react | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| react-dom | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| react-is | 16.13.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| react-is | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| react-markdown | 10.1.0 | MIT | Copyright (c) Espen Hovlandsdal; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| readable-stream | 1.0.34 | MIT | Copyright Joyent, Inc. and other Node contributors. All rights reserved.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| readable-stream | 1.1.14 | MIT | Copyright Joyent, Inc. and other Node contributors. All rights reserved.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| readable-stream | 2.3.8 | MIT | Copyright Node.js contributors. All rights reserved.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L83](#license-text-l83) |
| readable-stream | 3.6.2 | MIT | Copyright Node.js contributors. All rights reserved.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L83](#license-text-l83) |
| regenerator-runtime | 0.13.11 | MIT | Copyright (c) 2014-present, Facebook, Inc.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| remark-parse | 11.0.0 | MIT | Copyright (c) 2014 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L40](#license-text-l40) |
| remark-rehype | 11.1.2 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| repeat-string | 1.6.1 | MIT | Copyright (c) 2014-2016, Jon Schlinkert.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| require-directory | 2.1.1 | MIT | Copyright (c) 2011 Troy Goode &lt;troygoode@gmail.com>; The above copyright notice and this permission notice shall be included; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L84](#license-text-l84) |
| require-from-string | 2.0.2 | MIT | Copyright (c) Vsevolod Strukchinsky &lt;floatdrop@gmail.com> (github.com/floatdrop); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| require-in-the-middle | 7.5.2 | MIT | Copyright (c) 2016-2019, Thomas Watson Steen; Copyright (c) 2019-2025, Elasticsearch B.V.; Copyright (c) 2025+, require-in-the-middle contributors | [L26](#license-text-l26) |
| resolve | 1.22.11 | MIT | Copyright (c) 2012 James Halliday; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| resolve-from | 4.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| retry | 0.13.1 | MIT | Copyright (c) 2011:; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L85](#license-text-l85) |
| right-align | 0.1.3 | MIT | Copyright (c) 2015, Jon Schlinkert.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| robot3 | 0.4.1 | BSD-2-Clause | Copyright (c) Matthew Phillips | no license file in package; standard BSD-2-Clause terms |
| safe-buffer | 5.1.2 | MIT | Copyright (c) Feross Aboukhadijeh; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| safe-buffer | 5.2.1 | MIT | Copyright (c) Feross Aboukhadijeh; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| sax | 1.6.0 | BlueOak-1.0.0 | ## Copyright; copyright in it. | [L74](#license-text-l74) |
| saxes | 6.0.0 | ISC | Copyright (c) Louis-Dominique Dubeau | no license file in package; standard ISC terms |
| scheduler | 0.23.2 | MIT | Copyright (c) Facebook, Inc. and its affiliates.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| seedrandom | 2.4.3 | MIT | Copyright (c) David Bau | no license file in package; standard MIT terms |
| semver | 7.7.4 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| server-only | 0.0.1 | MIT |  | no license file in package; standard MIT terms |
| shallow-copy | 0.0.1 | MIT | The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L67](#license-text-l67) |
| sharp | 0.32.6 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by the copyright; available under the License, as indicated by a copyright notice that is included; by the copyright owner or by an individual or Legal Entity authorized to submit | [L23](#license-text-l23) |
| sharp | 0.34.5 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by the copyright; available under the License, as indicated by a copyright notice that is included; by the copyright owner or by an individual or Legal Entity authorized to submit | [L23](#license-text-l23) |
| shimmer | 1.2.1 | BSD-2-Clause | Copyright (c) 2013-2019, Forrest L Norvell; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L86](#license-text-l86) |
| simple-concat | 1.0.1 | MIT | Copyright (c) Feross Aboukhadijeh; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| simple-get | 4.0.1 | MIT | Copyright (c) Feross Aboukhadijeh; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L9](#license-text-l9) |
| simple-swizzle | 0.2.4 | MIT | Copyright (c) 2015 Josh Junon; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| sonner | 2.0.7 | MIT | Copyright (c) 2023 Emil Kowalski; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| source-map | 0.1.43 | UNKNOWN | Copyright (c) 2009-2011, Mozilla Foundation and contributors; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L87](#license-text-l87) |
| source-map | 0.5.7 | BSD-3-Clause | Copyright (c) 2009-2011, Mozilla Foundation and contributors; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L87](#license-text-l87) |
| source-map | 0.6.1 | BSD-3-Clause | Copyright (c) 2009-2011, Mozilla Foundation and contributors; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L87](#license-text-l87) |
| source-map-js | 1.2.1 | BSD-3-Clause | Copyright (c) 2009-2011, Mozilla Foundation and contributors; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L87](#license-text-l87) |
| space-separated-tokens | 2.0.2 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| spessasynth_core | 4.3.10 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| sprintf-js | 1.0.3 | BSD-3-Clause | Copyright (c) 2007-2014, Alexandru Marasteanu &lt;hello [at) alexei (dot] ro>; * Redistributions of source code must retain the above copyright; * Redistributions in binary form must reproduce the above copyright | [L88](#license-text-l88) |
| staffrender | 0.2.1 | Apache-2.0 | Copyright 2019 Pascual de Juan.  All rights reserved.; "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License. | [L18](#license-text-l18) |
| standardized-audio-context | 25.3.77 | MIT | Copyright (c) 2024 Christoph Guttandin; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| state-local | 1.0.7 | MIT | Copyright (c) 2020 Suren Atoyan; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| static-eval | 0.2.4 | MIT | The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L67](#license-text-l67) |
| static-module | 1.5.0 | MIT | The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L67](#license-text-l67) |
| streamx | 2.28.0 | MIT | Copyright (c) 2019 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| string_decoder | 0.10.31 | MIT | Copyright Joyent, Inc. and other Node contributors.; The above copyright notice and this permission notice shall be included; NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, | [L89](#license-text-l89) |
| string_decoder | 1.1.1 | MIT | Copyright Node.js contributors. All rights reserved.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L83](#license-text-l83) |
| string_decoder | 1.3.0 | MIT | Copyright Node.js contributors. All rights reserved.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L83](#license-text-l83) |
| string-width | 4.2.3 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| stringify-entities | 4.0.4 | MIT | Copyright (c) 2015 Titus Wormer &lt;mailto:tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| strip-ansi | 6.0.1 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| strip-json-comments | 2.0.1 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| style-to-js | 1.1.21 | MIT | Copyright (c) 2020 Menglin "Mark" Xu &lt;mark@remarkablemark.org>; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L60](#license-text-l60) |
| style-to-object | 1.0.14 | MIT | Copyright (c) 2017 Menglin "Mark" Xu &lt;mark@remarkablemark.org>; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE | [L60](#license-text-l60) |
| styled-jsx | 5.1.6 | MIT | Copyright (c) 2016-present Vercel, Inc.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| stylis | 4.2.0 | MIT | Copyright (c) 2016-present Sultan Tarimo; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| stylis | 4.4.0 | MIT | Copyright (c) 2016-present Sultan Tarimo; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| supports-color | 7.2.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| supports-preserve-symlinks-flag | 1.0.0 | MIT | Copyright (c) 2022 Inspect JS; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| symbol-tree | 3.2.4 | MIT | Copyright (c) 2015 Joris van der Wel; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| tailwind-merge | 3.5.0 | MIT | Copyright (c) 2021 Dany Castillo; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| tar-fs | 2.1.5 | MIT | Copyright (c) 2014 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| tar-fs | 3.1.3 | MIT | Copyright (c) 2014 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| tar-stream | 2.2.0 | MIT | Copyright (c) 2014 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| tar-stream | 3.2.0 | MIT | Copyright (c) 2014 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| teex | 1.0.1 | MIT | Copyright (c) 2020 Mathias Buus; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| text-decoder | 1.2.7 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L18](#license-text-l18) |
| text-segmentation | 1.0.3 | MIT | Copyright (c) 2021 Niklas von Hertzen; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L4](#license-text-l4) |
| three | 0.183.2 | MIT | Copyright © 2010-2026 three.js authors; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L80](#license-text-l80) |
| through2 | 0.4.2 | MIT | Copyright 2013, Rod Vagg (the "Original Author"); The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L90](#license-text-l90) |
| tiny-lru | 11.4.7 | BSD-3-Clause | Copyright (c) 2026, Jason Mulligan; * Redistributions of source code must retain the above copyright notice, this; * Redistributions in binary form must reproduce the above copyright notice, | [L91](#license-text-l91) |
| tiny-typed-emitter | 2.1.0 | MIT | Copyright (c) 2020 Zurab Benashvili (binier) &lt;zura.bena@gmail.com>; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| tldts | 7.0.27 | MIT | Copyright (c) 2017 Thomas Parisot, 2018 Rémi Berson; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.; FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, | [L92](#license-text-l92) |
| tldts-core | 7.0.27 | MIT | Copyright (c) 2017 Thomas Parisot, 2018 Rémi Berson; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.; FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, | [L92](#license-text-l92) |
| tonal | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal | 6.4.3 | MIT | Copyright (c) 2015 danigb; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| tonal-array | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal-chord | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal-dictionary | 2.2.2 | MIT | Copyright (c) danigb@gmail.com | no license file in package; standard MIT terms |
| tonal-distance | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal-interval | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal-key | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal-note | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal-pcset | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal-roman-numeral | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tonal-scale | 2.2.2 | MIT | Copyright (c) danigb | no license file in package; standard MIT terms |
| tone | 14.9.17 | MIT | Copyright (c) 2014-2020 Yotam Mann; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| tough-cookie | 6.0.1 | BSD-3-Clause | Copyright (c) 2015, Salesforce.com, Inc.; 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. | [L93](#license-text-l93) |
| tr46 | 0.0.3 | MIT | Copyright (c) Sebastian Mayr | no license file in package; standard MIT terms |
| tr46 | 6.0.0 | MIT | Copyright (c) Sebastian Mayr; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L26](#license-text-l26) |
| trim-lines | 3.0.1 | MIT | Copyright (c) 2015 Titus Wormer &lt;mailto:tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| trough | 2.2.0 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L40](#license-text-l40) |
| tslib | 2.8.1 | 0BSD | Copyright (c) Microsoft Corporation. | [L94](#license-text-l94) |
| tunnel-agent | 0.6.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License. | [L95](#license-text-l95) |
| typedarray | 0.0.6 | MIT | Copyright (c) 2010, Linden Research, Inc.; Copyright (c) 2012, Joshua Bell; The above copyright notice and this permission notice shall be included in | [L96](#license-text-l96) |
| typedarray-pool | 1.2.0 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| uglify-js | 2.8.29 | BSD-2-Clause | Copyright 2012-2013 (c) Mihai Bazon &lt;mihai.bazon@gmail.com>; copyright notice, this list of conditions and the following; THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY | [L97](#license-text-l97) |
| uglify-to-browserify | 1.0.2 | MIT | Copyright (c) 2013 Forbes Lindesay; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| undici | 7.27.0 | MIT | Copyright (c) Matteo Collina and Undici contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| undici-types | 5.26.5 | MIT |  | no license file in package; standard MIT terms |
| undici-types | 6.21.0 | MIT | Copyright (c) Matteo Collina and Undici contributors; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| unified | 11.0.5 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L40](#license-text-l40) |
| uniq | 1.0.1 | MIT | Copyright (c) 2013 Mikola Lysenko; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| unist-util-is | 6.0.1 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L98](#license-text-l98) |
| unist-util-position | 5.0.0 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| unist-util-stringify-position | 4.0.0 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| unist-util-visit | 5.1.0 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| unist-util-visit-parents | 6.0.2 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| universalify | 2.0.1 | MIT | Copyright (c) 2017, Ryan Zimmerman &lt;opensrc@ryanzim.com>; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L99](#license-text-l99) |
| use-merge-value | 1.2.0 | MIT | Copyright (c) 2019-present chenshuai2144 (qixian.cs@outlook.com); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| use-sync-external-store | 1.6.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates.; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| util-deprecate | 1.0.2 | MIT | Copyright (c) 2014 Nathan Rajlich &lt;nathan@tootallnate.net>; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L100](#license-text-l100) |
| utrie | 1.0.2 | MIT | Copyright (c) 2021 Niklas von Hertzen; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L4](#license-text-l4) |
| uuid | 9.0.1 | MIT | Copyright (c) 2010-2020 Robert Kieffer and other contributors; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L1](#license-text-l1) |
| vfile | 6.0.3 | MIT | Copyright (c) 2015 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L40](#license-text-l40) |
| vfile-message | 4.0.3 | MIT | Copyright (c) Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| w3c-xmlserializer | 5.0.0 | MIT | Copyright © Sebastian Mayr; The above copyright notice and this permission notice shall be; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | [L42](#license-text-l42) |
| web-demuxer | 4.0.0 | UNKNOWN | Copyright (c) 2024 ForeverSc; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| web-streams-polyfill | 3.3.3 | MIT | Copyright (c) 2024 Mattias Buelens; Copyright (c) 2016 Diwank Singh Tomer; The above copyright notice and this permission notice shall be included in all | [L26](#license-text-l26) |
| web-streams-polyfill | 4.0.0-beta.3 | MIT | Copyright (c) 2021 Mattias Buelens; Copyright (c) 2016 Diwank Singh Tomer; The above copyright notice and this permission notice shall be included in all | [L26](#license-text-l26) |
| webidl-conversions | 3.0.1 | BSD-2-Clause | Copyright (c) 2014, Domenic Denicola; 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. | [L101](#license-text-l101) |
| webidl-conversions | 8.0.1 | BSD-2-Clause | Copyright (c) 2014, Domenic Denicola; 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. | [L101](#license-text-l101) |
| whatwg-mimetype | 5.0.0 | MIT | Copyright © Domenic Denicola &lt;d@domenic.me>; The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L2](#license-text-l2) |
| whatwg-url | 16.0.1 | MIT | Copyright (c) Sebastian Mayr; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| whatwg-url | 5.0.0 | MIT | Copyright (c) 2015–2016 Sebastian Mayr; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| which | 1.3.1 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| window-size | 0.1.0 | UNKNOWN | Copyright (c) Jon Schlinkert | no license file in package; standard UNKNOWN terms |
| wordwrap | 0.0.2 | MIT/X11 | Copyright (c) James Halliday | no license file in package; standard MIT/X11 terms |
| wrap-ansi | 7.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com> (https://sindresorhus.com); The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. | [L39](#license-text-l39) |
| wrappy | 1.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors; copyright notice and this permission notice appear in all copies. | [L46](#license-text-l46) |
| ws | 8.20.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik &lt;einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors | [L102](#license-text-l102) |
| xml-name-validator | 5.0.0 | Apache-2.0 | "Licensor" shall mean the copyright owner or entity authorized by; the copyright owner that is granting the License.; copyright notice that is included in or attached to the work | [L78](#license-text-l78) |
| xmlchars | 2.2.0 | MIT | Copyright Louis-Dominique Dubeau and contributors to xmlchars; The above copyright notice and this permission notice shall be included in all; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER | [L102](#license-text-l102) |
| xtend | 2.1.2 | UNKNOWN | Copyright (c) 2012 Raynos.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L6](#license-text-l6) |
| xtend | 4.0.2 | MIT | Copyright (c) 2012-2014 Raynos.; The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L37](#license-text-l37) |
| y18n | 5.0.8 | ISC | Copyright (c) 2015, Contributors; with or without fee is hereby granted, provided that the above copyright notice | [L103](#license-text-l103) |
| yaml | 1.10.3 | ISC | Copyright 2018 Eemeli Aro &lt;eemeli@gmail.com>; with or without fee is hereby granted, provided that the above copyright notice | [L103](#license-text-l103) |
| yaml | 2.8.3 | ISC | Copyright Eemeli Aro &lt;eemeli@gmail.com>; with or without fee is hereby granted, provided that the above copyright notice | [L103](#license-text-l103) |
| yargs | 16.2.0 | MIT | Copyright 2010 James Halliday (mail@substack.net); Modified work Copyright 2014 Contributors (ben@npmjs.com); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L34](#license-text-l34) |
| yargs | 3.10.0 | MIT | Copyright 2010 James Halliday (mail@substack.net); The above copyright notice and this permission notice shall be included in; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L104](#license-text-l104) |
| yargs-parser | 20.2.9 | ISC | Copyright (c) 2016, Contributors; that the above copyright notice and this permission notice | [L48](#license-text-l48) |
| zod | 4.3.6 | MIT | Copyright (c) 2025 Colin McDonnell; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| zustand | 4.5.7 | MIT | Copyright (c) 2019 Paul Henschel; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |
| zwitch | 2.0.4 | MIT | Copyright (c) 2016 Titus Wormer &lt;tituswormer@gmail.com>; The above copyright notice and this permission notice shall be; IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY | [L35](#license-text-l35) |
| zzfx | 1.3.2 | MIT | Copyright (c) 2019 Frank Force; The above copyright notice and this permission notice shall be included in all; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER | [L3](#license-text-l3) |

## License texts

### License text L1

Used by: @ant-design/cssinjs@2.1.2, color-name@1.1.4, uuid@9.0.1

```text
The MIT License (MIT)

Copyright (c) 2019-present afc163

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L2

Used by: @anthropic-ai/sdk@0.37.0, @xmldom/xmldom@0.8.12, data-urls@7.0.0, html-encoding-sniffer@6.0.0, onnx-proto@4.0.4, whatwg-mimetype@5.0.0

```text
Copyright 2023 Anthropic, PBC.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L3

Used by: @asamuzakjp/css-color@5.1.11, @asamuzakjp/dom-selector@7.1.1, @asamuzakjp/generational-cache@1.0.1, @dnd-kit/accessibility@3.1.1, @dnd-kit/core@6.3.1, @dnd-kit/sortable@8.0.0, @dnd-kit/utilities@3.2.2, @emnapi/runtime@1.9.2, @emotion/babel-plugin@11.13.5, @emotion/cache@11.14.0, @emotion/css@11.13.5, @emotion/hash@0.8.0, @emotion/hash@0.9.2, @emotion/memoize@0.9.0, @emotion/react@11.14.0, @emotion/serialize@1.3.3, @emotion/sheet@1.4.0, @emotion/unitless@0.10.0, @emotion/unitless@0.7.5, @emotion/use-insertion-effect-with-fallbacks@1.2.0, @emotion/utils@1.4.2, @emotion/weak-memoize@0.4.0, @exodus/bytes@1.15.0, @huggingface/jinja@0.2.2, @lobehub/icons@5.10.0, @monaco-editor/loader@1.7.0, @monaco-editor/react@4.7.0, @napi-rs/canvas@0.1.100, @sentry-internal/browser-utils@8.55.0, @sentry-internal/feedback@8.55.0, @sentry-internal/replay@8.55.0, @sentry-internal/replay-canvas@8.55.0, @sentry/browser@8.55.0, @sentry/core@8.55.0, @sentry/electron@5.12.0, @sentry/node@8.55.0, @sentry/opentelemetry@8.55.0, abort-controller@3.0.0, acorn-import-attributes@1.9.5, antd-style@4.1.0, automation-events@7.1.19, buffer-from@1.1.2, call-bind-apply-helpers@1.0.2, dunder-proto@1.0.1, es-define-property@1.0.1, es-errors@1.3.0, es-object-atoms@1.1.1, es-set-tostringtag@2.1.0, eventsource-parser@1.1.2, falafel@2.2.5, fast-deep-equal@3.1.3, fetch-blob@3.2.0, formdata-polyfill@4.0.10, get-intrinsic@1.3.0, get-proto@1.0.1, gopd@1.2.0, has-symbols@1.1.0, has-tostringtag@1.0.2, hasown@2.0.2, isarray@2.0.5, ismobilejs@1.1.1, json-schema-traverse@1.0.0, math-intrinsics@1.1.0, napi-build-utils@2.0.0, node-abi@3.94.0, node-domexception@1.0.0, pg-protocol@1.13.0, polished@4.3.1, react@18.3.1, react-dom@18.3.1, react-is@16.13.1, react-is@18.3.1, regenerator-runtime@0.13.11, resolve@1.22.11, scheduler@0.23.2, sonner@2.0.7, standardized-audio-context@25.3.77, state-local@1.0.7, styled-jsx@5.1.6, stylis@4.2.0, stylis@4.4.0, supports-preserve-symlinks-flag@1.0.0, tailwind-merge@3.5.0, tiny-typed-emitter@2.1.0, tone@14.9.17, undici@7.27.0, undici-types@6.21.0, use-sync-external-store@1.6.0, web-demuxer@4.0.0, zod@4.3.6, zustand@4.5.7, zzfx@1.3.2

```text
MIT License

Copyright (c) 2024 asamuzaK (Kazz)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text L4

Used by: @asamuzakjp/nwsapi@2.3.9, base64-arraybuffer@1.0.2, css-line-break@2.1.0, html2canvas@1.4.1, jsdom@29.1.1, text-segmentation@1.0.3, utrie@1.0.2

```text
Copyright (c) 2007-2019 Diego Perini (http://www.iport.it/)

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### License text L5

Used by: @babel/code-frame@7.29.0, @babel/generator@7.29.1, @babel/helper-globals@7.28.0, @babel/helper-module-imports@7.28.6, @babel/helper-string-parser@7.27.1, @babel/helper-validator-identifier@7.28.5, @babel/runtime@7.29.2, @babel/template@7.28.6, @babel/traverse@7.29.0, @babel/types@7.29.0, bidi-js@1.0.3

```text
MIT License

Copyright (c) 2014-present Sebastian McKenzie and other contributors

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L6

Used by: @babel/parser@7.29.2, @jridgewell/gen-mapping@0.3.13, @jridgewell/resolve-uri@3.1.2, @jridgewell/sourcemap-codec@1.5.5, @jridgewell/trace-mapping@0.3.31, async@0.2.10, combined-stream@1.0.8, core-js@3.49.0, core-util-is@1.0.2, css-tree@3.2.1, delayed-stream@1.0.0, form-data@4.0.5, forwarded-parse@2.1.2, function-bind@1.1.2, humanize-ms@1.2.1, parse5@8.0.1, readable-stream@1.0.34, readable-stream@1.1.14, uglify-to-browserify@1.0.2, xtend@2.1.2

```text
Copyright (C) 2012-2014 by various contributors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L7

Used by: @bramus/specificity@2.4.2, csstype@3.2.3

```text
Copyright (c) 2022 Bramus Van Damme - https://www.bram.us/

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L8

Used by: @csstools/color-helpers@6.0.2, @csstools/css-syntax-patches-for-csstree@1.1.4

```text
MIT No Attribution (MIT-0)

Copyright © CSSTools Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text L9

Used by: @csstools/css-calc@3.2.1, @csstools/css-color-parser@4.1.1, @csstools/css-parser-algorithms@4.0.0, @csstools/css-tokenizer@4.0.0, deep-extend@0.6.0, is-core-module@2.16.1, json-bigint@1.0.0, nanoid@3.3.11, postcss@8.4.31, simple-concat@1.0.1, simple-get@4.0.1

```text
The MIT License (MIT)

Copyright 2022 Romain Menke, Antonio Laguna <antonio@laguna.es>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L10

Used by: @fal-ai/serverless-client@0.15.0, find-root@1.1.0

```text
Copyright 2024 https://fal.ai

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L11

Used by: @fontsource-variable/figtree@5.2.10, @fontsource-variable/inter@5.2.8, @fontsource/architects-daughter@5.2.7, @fontsource/bebas-neue@5.2.7, @fontsource/bitter@5.2.10, @fontsource/bricolage-grotesque@5.2.10, @fontsource/caveat@5.2.8, @fontsource/fira-code@5.2.7, @fontsource/fredoka@5.2.10, @fontsource/manrope@5.2.8, @fontsource/nunito@5.2.7, @fontsource/patrick-hand@5.2.8, @fontsource/righteous@5.2.7, @fontsource/sora@5.2.8

```text
Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree) Figtree-Italic[wght].ttf: Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L12

Used by: @fontsource-variable/source-serif-4@5.2.9

```text
Google Inc.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L13

Used by: @fontsource-variable/vollkorn@5.2.10

```text
Copyright 2018 The Vollkorn Project Authors (https://github.com/FAlthausen/Vollkorn-Typeface) Vollkorn-Italic[wght].ttf: Copyright 2018 The Vollkorn Project Authors (https://github.com/FAlthausen/Vollkorn-Typeface)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L14

Used by: @fontsource/dm-mono@5.2.7

```text
Copyright 2020 The DM Mono Project Authors (https://www.github.com/googlefonts/dm-mono) DMMono-LightItalic.ttf: Copyright 2020 The DM Mono Project Authors (https://www.github.com/googlefonts/dm-mono) DMMono-Regular.ttf: Copyright 2020 The DM Mono Project Authors (https://www.github.com/googlefonts/dm-mono) DMMono-Italic.ttf: Copyright 2020 The DM Mono Project Authors (https://www.github.com/googlefonts/dm-mono) DMMono-Medium.ttf: Copyright 2020 The DM Mono Project Authors (https://www.github.com/googlefonts/dm-mono) DMMono-MediumItalic.ttf: Copyright 2020 The DM Mono Project Authors (https://www.github.com/googlefonts/dm-mono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L15

Used by: @fontsource/jetbrains-mono@5.2.8

```text
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L16

Used by: @fontsource/kalam@5.2.8

```text
Copyright (c) 2014 Indian Type Foundry (info@indiantypefoundry.com) Kalam-Regular.ttf: Copyright (c) 2014 Indian Type Foundry (info@indiantypefoundry.com) Kalam-Bold.ttf: Copyright (c) 2014 Indian Type Foundry (info@indiantypefoundry.com)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L17

Used by: @fontsource/merriweather@5.2.11

```text
Copyright 2024 The Merriweather Project Authors (https://github.com/EbenSorkin/Merriweather4) with Reserved Font Name "Merriweather". Merriweather-Italic[opsz,wdth,wght].ttf: Copyright 2024 The Merriweather Project Authors (https://github.com/EbenSorkin/Merriweather4) with Reserved Font Name "Merriweather".

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L18

Used by: @fontsource/permanent-marker@5.2.7, @google/genai@1.46.0, @opentelemetry/api@1.9.1, @opentelemetry/api-logs@0.53.0, @opentelemetry/api-logs@0.57.1, @opentelemetry/api-logs@0.57.2, @opentelemetry/context-async-hooks@1.30.1, @opentelemetry/core@1.30.1, @opentelemetry/instrumentation@0.53.0, @opentelemetry/instrumentation@0.57.1, @opentelemetry/instrumentation@0.57.2, @opentelemetry/instrumentation-amqplib@0.46.1, @opentelemetry/instrumentation-connect@0.43.0, @opentelemetry/instrumentation-dataloader@0.16.0, @opentelemetry/instrumentation-express@0.47.0, @opentelemetry/instrumentation-fastify@0.44.1, @opentelemetry/instrumentation-fs@0.19.0, @opentelemetry/instrumentation-generic-pool@0.43.0, @opentelemetry/instrumentation-graphql@0.47.0, @opentelemetry/instrumentation-hapi@0.45.1, @opentelemetry/instrumentation-http@0.57.1, @opentelemetry/instrumentation-ioredis@0.47.0, @opentelemetry/instrumentation-kafkajs@0.7.0, @opentelemetry/instrumentation-knex@0.44.0, @opentelemetry/instrumentation-koa@0.47.0, @opentelemetry/instrumentation-lru-memoizer@0.44.0, @opentelemetry/instrumentation-mongodb@0.51.0, @opentelemetry/instrumentation-mongoose@0.46.0, @opentelemetry/instrumentation-mysql@0.45.0, @opentelemetry/instrumentation-mysql2@0.45.0, @opentelemetry/instrumentation-nestjs-core@0.44.0, @opentelemetry/instrumentation-pg@0.50.0, @opentelemetry/instrumentation-redis-4@0.46.0, @opentelemetry/instrumentation-tedious@0.18.0, @opentelemetry/instrumentation-undici@0.10.0, @opentelemetry/redis-common@0.36.2, @opentelemetry/resources@1.30.1, @opentelemetry/sdk-trace-base@1.30.1, @opentelemetry/semantic-conventions@1.27.0, @opentelemetry/semantic-conventions@1.28.0, @opentelemetry/semantic-conventions@1.41.1, @opentelemetry/sql-common@0.40.1, @prisma/instrumentation@5.22.0, @swc/helpers@0.5.15, @xenova/transformers@2.17.2, b4a@1.8.1, bare-events@2.9.1, bare-fs@4.7.4, bare-path@3.1.1, bare-stream@2.13.3, bare-url@2.4.5, baseline-browser-mapping@2.10.10, dompurify@3.4.7, events-universal@1.0.1, flatbuffers@1.12.0, gaxios@7.1.4, gcp-metadata@8.1.2, google-auth-library@10.6.2, google-logging-utils@1.1.3, import-in-the-middle@1.15.0, long@4.0.0, long@5.3.2, openai@6.33.0, spessasynth_core@4.3.10, staffrender@0.2.1, text-decoder@1.2.7

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright (c) 2010 by Font Diner, Inc. All rights reserved.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text L19

Used by: @fontsource/poppins@5.2.7

```text
Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ThinItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ExtraLight.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ExtraLightItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Light.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-LightItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Regular.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Italic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Medium.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-MediumItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-SemiBold.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-SemiBoldItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Bold.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-BoldItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ExtraBold.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ExtraBoldItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Black.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-BlackItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L20

Used by: @fontsource/space-mono@5.2.9

```text
Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono) SpaceMono-Italic.ttf: Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono) SpaceMono-Bold.ttf: Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono) SpaceMono-BoldItalic.ttf: Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L21

Used by: @fontsource/work-sans@5.2.8

```text
Copyright 2019 The Work Sans Project Authors (https://github.com/weiweihuanghuang/Work-Sans) WorkSans-Italic[wght].ttf: Copyright 2019 The Work Sans Project Authors (https://github.com/weiweihuanghuang/Work-Sans)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L22

Used by: @img/colour@1.1.0

```text
# Licensing

## color

Copyright (c) 2012 Heather Arthur

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## color-convert

Copyright (c) 2011-2016 Heather Arthur <fayearthur@gmail.com>.
Copyright (c) 2016-2021 Josh Junon <josh@junon.me>.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## color-string

Copyright (c) 2011 Heather Arthur <fayearthur@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## color-name

The MIT License (MIT)
Copyright (c) 2015 Dmitry Ivanov

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L23

Used by: @img/sharp-darwin-arm64@0.34.5, sharp@0.32.6, sharp@0.34.5

```text
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and
distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright
owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities
that control, are controlled by, or are under common control with that entity.
For the purposes of this definition, "control" means (i) the power, direct or
indirect, to cause the direction or management of such entity, whether by
contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the
outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising
permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including
but not limited to software source code, documentation source, and configuration
files.

"Object" form shall mean any form resulting from mechanical transformation or
translation of a Source form, including but not limited to compiled object code,
generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made
available under the License, as indicated by a copyright notice that is included
in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that
is based on (or derived from) the Work and for which the editorial revisions,
annotations, elaborations, or other modifications represent, as a whole, an
original work of authorship. For the purposes of this License, Derivative Works
shall not include works that remain separable from, or merely link (or bind by
name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version
of the Work and any modifications or additions to that Work or Derivative Works
thereof, that is intentionally submitted to Licensor for inclusion in the Work
by the copyright owner or by an individual or Legal Entity authorized to submit
on behalf of the copyright owner. For the purposes of this definition,
"submitted" means any form of electronic, verbal, or written communication sent
to the Licensor or its representatives, including but not limited to
communication on electronic mailing lists, source code control systems, and
issue tracking systems that are managed by, or on behalf of, the Licensor for
the purpose of discussing and improving the Work, but excluding communication
that is conspicuously marked or otherwise designated in writing by the copyright
owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf
of whom a Contribution has been received by Licensor and subsequently
incorporated within the Work.

2. Grant of Copyright License.

Subject to the terms and conditions of this License, each Contributor hereby
grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
irrevocable copyright license to reproduce, prepare Derivative Works of,
publicly display, publicly perform, sublicense, and distribute the Work and such
Derivative Works in Source or Object form.

3. Grant of Patent License.

Subject to the terms and conditions of this License, each Contributor hereby
grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
irrevocable (except as stated in this section) patent license to make, have
made, use, offer to sell, sell, import, and otherwise transfer the Work, where
such license applies only to those patent claims licensable by such Contributor
that are necessarily infringed by their Contribution(s) alone or by combination
of their Contribution(s) with the Work to which such Contribution(s) was
submitted. If You institute patent litigation against any entity (including a
cross-claim or counterclaim in a lawsuit) alleging that the Work or a
Contribution incorporated within the Work constitutes direct or contributory
patent infringement, then any patent licenses granted to You under this License
for that Work shall terminate as of the date such litigation is filed.

4. Redistribution.

You may reproduce and distribute copies of the Work or Derivative Works thereof
in any medium, with or without modifications, and in Source or Object form,
provided that You meet the following conditions:

You must give any other recipients of the Work or Derivative Works a copy of
this License; and
You must cause any modified files to carry prominent notices stating that You
changed the files; and
You must retain, in the Source form of any Derivative Works that You distribute,
all copyright, patent, trademark, and attribution notices from the Source form
of the Work, excluding those notices that do not pertain to any part of the
Derivative Works; and
If the Work includes a "NOTICE" text file as part of its distribution, then any
Derivative Works that You distribute must include a readable copy of the
attribution notices contained within such NOTICE file, excluding those notices
that do not pertain to any part of the Derivative Works, in at least one of the
following places: within a NOTICE text file distributed as part of the
Derivative Works; within the Source form or documentation, if provided along
with the Derivative Works; or, within a display generated by the Derivative
Works, if and wherever such third-party notices normally appear. The contents of
the NOTICE file are for informational purposes only and do not modify the
License. You may add Your own attribution notices within Derivative Works that
You distribute, alongside or as an addendum to the NOTICE text from the Work,
provided that such additional attribution notices cannot be construed as
modifying the License.
You may add Your own copyright statement to Your modifications and may provide
additional or different license terms and conditions for use, reproduction, or
distribution of Your modifications, or for any such Derivative Works as a whole,
provided Your use, reproduction, and distribution of the Work otherwise complies
with the conditions stated in this License.

5. Submission of Contributions.

Unless You explicitly state otherwise, any Contribution intentionally submitted
for inclusion in the Work by You to the Licensor shall be under the terms and
conditions of this License, without any additional terms or conditions.
Notwithstanding the above, nothing herein shall supersede or modify the terms of
any separate license agreement you may have executed with Licensor regarding
such Contributions.

6. Trademarks.

This License does not grant permission to use the trade names, trademarks,
service marks, or product names of the Licensor, except as required for
reasonable and customary use in describing the origin of the Work and
reproducing the content of the NOTICE file.

7. Disclaimer of Warranty.

Unless required by applicable law or agreed to in writing, Licensor provides the
Work (and each Contributor provides its Contributions) on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied,
including, without limitation, any warranties or conditions of TITLE,
NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are
solely responsible for determining the appropriateness of using or
redistributing the Work and assume any risks associated with Your exercise of
permissions under this License.

8. Limitation of Liability.

In no event and under no legal theory, whether in tort (including negligence),
contract, or otherwise, unless required by applicable law (such as deliberate
and grossly negligent acts) or agreed to in writing, shall any Contributor be
liable to You for damages, including any direct, indirect, special, incidental,
or consequential damages of any character arising as a result of this License or
out of the use or inability to use the Work (including but not limited to
damages for loss of goodwill, work stoppage, computer failure or malfunction, or
any and all other commercial damages or losses), even if such Contributor has
been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability.

While redistributing the Work or Derivative Works thereof, You may choose to
offer, and charge a fee for, acceptance of support, warranty, indemnity, or
other liability obligations and/or rights consistent with this License. However,
in accepting such obligations, You may act only on Your own behalf and on Your
sole responsibility, not on behalf of any other Contributor, and only if You
agree to indemnify, defend, and hold each Contributor harmless for any liability
incurred by, or claims asserted against, such Contributor by reason of your
accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work

To apply the Apache License to your work, attach the following boilerplate
notice, with the fields enclosed by brackets "[]" replaced with your own
identifying information. (Don't include the brackets!) The text should be
enclosed in the appropriate comment syntax for the file format. We also
recommend that a file or class name and description of purpose be included on
the same "printed page" as the copyright notice for easier identification within
third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text L24

Used by: @libsql/hrana-client@0.9.0

```text
MIT License

Copyright 2023 the sqld authors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L25

Used by: @msgpack/msgpack@3.1.3

```text
Copyright 2019 The MessagePack Community.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text L26

Used by: @neon-rs/load@0.0.4, @tonaljs/abc-notation@4.9.1, @tonaljs/array@4.8.4, @tonaljs/chord@6.1.2, @tonaljs/chord-detect@4.9.1, @tonaljs/chord-type@5.1.1, @tonaljs/collection@4.9.0, @tonaljs/core@5.0.2, @tonaljs/duration-value@4.9.0, @tonaljs/interval@5.1.0, @tonaljs/key@4.11.2, @tonaljs/midi@4.10.2, @tonaljs/mode@4.9.2, @tonaljs/note@4.12.1, @tonaljs/pcset@4.10.1, @tonaljs/pitch@5.0.2, @tonaljs/pitch-distance@5.0.5, @tonaljs/pitch-interval@6.1.0, @tonaljs/pitch-note@6.1.0, @tonaljs/range@4.9.2, @tonaljs/roman-numeral@4.9.1, @tonaljs/scale@4.13.4, @tonaljs/scale-type@4.9.2, @tonaljs/time-signature@4.9.0, @tonaljs/voice-leading@5.1.2, @tonaljs/voicing@5.1.3, @tonaljs/voicing-dictionary@5.1.3, ajv@8.18.0, asynckit@0.4.0, babel-plugin-macros@3.1.0, builder-util-runtime@9.5.1, cosmiconfig@7.1.0, cross-fetch@4.1.0, electron-updater@6.8.3, event-target-shim@5.0.1, eventemitter3@5.0.4, form-data-encoder@1.7.2, formdata-node@4.4.1, framer-motion@12.38.0, gifuct-js@2.1.2, js-binary-schema-parser@2.0.3, libsql@0.5.29, module-details-from-path@1.0.4, motion@12.38.0, motion-dom@12.38.0, motion-utils@12.36.0, ms@2.1.3, next@16.2.1, node-fetch@2.6.13, node-fetch@2.7.0, node-fetch@3.3.2, path-parse@1.0.7, react-markdown@10.1.0, require-in-the-middle@7.5.2, tonal@6.4.3, tr46@6.0.0, web-streams-polyfill@3.3.3, web-streams-polyfill@4.0.0-beta.3

```text
The MIT License (MIT)

Copyright (c) 2023 David Herman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text L27

Used by: @protobufjs/aspromise@1.1.2, @protobufjs/base64@1.1.2, @protobufjs/codegen@2.0.4, @protobufjs/eventemitter@1.1.0, @protobufjs/fetch@1.1.0, @protobufjs/float@1.0.2, @protobufjs/inquire@1.1.0, @protobufjs/path@1.1.2, @protobufjs/pool@1.1.0, @protobufjs/utf8@1.1.0

```text
Copyright (c) 2016, Daniel Wirtz  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of its author, nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L28

Used by: @rc-component/util@1.11.1

```text
The MIT License (MIT)

Copyright (c) 2014-present yiminghe
Copyright (c) 2015-present Alipay.com, https://www.alipay.com/

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS 
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF 
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. 
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY 
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, 
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE 
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L29

Used by: @tensorflow/tfjs-layers@2.8.6

```text
TensorFlow.js Layers is licensed under both the MIT and the Apache 2.0 licenses.

================================================================================
COPYRIGHT

All contributions by François Chollet:
Copyright (c) 2015 - 2018, François Chollet.
All rights reserved.

All contributions by Google:
Copyright (c) 2015 - 2018, Google LLC.
All rights reserved.

All contributions by Microsoft:
Copyright (c) 2017 - 2018, Microsoft, LLC
All rights reserved.

All other contributions:
Copyright (c) 2015 - 2018, the respective contributors.
All rights reserved.

Each contributor holds copyright over their respective contributions.
The project versioning (Git) records all such contribution source information.

LICENSE

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

================================================================================

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text L30

Used by: @tonejs/midi@2.0.28, midi-file@1.2.4

```text
[The MIT License](http://opensource.org/licenses/MIT)

Copyright © 2016 Yotam Mann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L31

Used by: @types/connect@3.4.36, @types/debug@4.1.13, @types/dom-mediacapture-transform@0.1.11, @types/dom-webcodecs@0.1.13, @types/earcut@3.0.0, @types/estree@1.0.8, @types/estree-jsx@1.0.5, @types/hast@3.0.4, @types/long@4.0.2, @types/mdast@4.0.4, @types/ms@2.1.0, @types/mysql@2.15.26, @types/node@18.19.130, @types/node@22.20.3, @types/node-fetch@2.6.13, @types/offscreencanvas@2019.3.0, @types/parse-json@4.0.2, @types/pg@8.6.1, @types/pg-pool@2.0.6, @types/retry@0.12.0, @types/shimmer@1.2.0, @types/tedious@4.0.14, @types/trusted-types@2.0.7, @types/unist@2.0.11, @types/unist@3.0.3, @types/webgl-ext@0.0.30, @types/webgl2@0.0.5, @types/ws@8.18.1

```text
MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```

### License text L32

Used by: @ungap/structured-clone@1.3.0, lucide-react@0.400.0, lucide-react@0.469.0, picocolors@1.1.1

```text
ISC License

Copyright (c) 2021, Andrea Giammarchi, @WebReflection

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### License text L33

Used by: @webgpu/types@0.1.69

```text
Copyright 2022 WebGPU Developers

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

   1. Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.

   2. Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

   3. Neither the name of the copyright holder nor the names of its
      contributors may be used to endorse or promote products derived from this
      software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L34

Used by: acorn@7.4.1, acorn@8.16.0, yargs@16.2.0

```text
MIT License

Copyright (C) 2012-2018 by various contributors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L35

Used by: agent-base@7.1.4, bail@2.0.2, ccount@2.0.1, character-entities@2.0.2, character-entities-html4@2.1.0, character-entities-legacy@3.0.0, character-reference-invalid@2.0.1, comma-separated-tokens@2.0.3, decode-named-character-reference@1.3.0, devlop@1.1.0, estree-util-is-identifier-name@3.0.0, hast-util-to-jsx-runtime@2.3.6, hast-util-whitespace@3.0.0, https-proxy-agent@7.0.6, is-alphabetical@2.0.1, is-alphanumerical@2.0.1, is-decimal@2.0.1, is-hexadecimal@2.0.1, longest-streak@3.1.0, mdast-util-from-markdown@2.0.3, mdast-util-mdx-expression@2.0.1, mdast-util-mdx-jsx@3.2.0, mdast-util-mdxjs-esm@2.0.1, mdast-util-phrasing@4.1.0, mdast-util-to-hast@13.2.1, mdast-util-to-markdown@2.1.2, mdast-util-to-string@4.0.0, micromark@4.0.2, micromark-core-commonmark@2.0.3, micromark-factory-destination@2.0.1, micromark-factory-label@2.0.1, micromark-factory-space@2.0.1, micromark-factory-title@2.0.1, micromark-factory-whitespace@2.0.1, micromark-util-character@2.1.1, micromark-util-chunked@2.0.1, micromark-util-classify-character@2.0.1, micromark-util-combine-extensions@2.0.1, micromark-util-decode-numeric-character-reference@2.0.2, micromark-util-decode-string@2.0.1, micromark-util-encode@2.0.1, micromark-util-html-tag-name@2.0.1, micromark-util-normalize-identifier@2.0.1, micromark-util-resolve-all@2.0.1, micromark-util-sanitize-uri@2.0.1, micromark-util-subtokenize@2.1.0, micromark-util-symbol@2.0.1, micromark-util-types@2.0.2, mime-db@1.52.0, mime-types@2.1.35, parse-entities@4.0.2, property-information@7.1.0, remark-rehype@11.1.2, space-separated-tokens@2.0.2, stringify-entities@4.0.4, trim-lines@3.0.1, unist-util-position@5.0.0, unist-util-stringify-position@4.0.0, unist-util-visit@5.1.0, unist-util-visit-parents@6.0.2, vfile-message@4.0.3, zwitch@2.0.4

```text
(The MIT License)

Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L36

Used by: agentkeepalive@4.6.0, parse-svg-path@0.1.2

```text
The MIT License

Copyright(c) node-modules and other contributors.
Copyright(c) 2012 - 2015 fengmk2 <fengmk2@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L37

Used by: align-text@0.1.4, array-flatten@3.0.0, base64-js@1.5.1, bit-twiddle@1.0.2, buffer@5.7.1, camelcase@1.2.1, center-align@0.1.3, cwise@1.0.10, cwise-compiler@1.1.3, cwise-parser@1.0.3, decamelize@1.2.0, deepmerge@4.3.1, dequal@2.0.3, dup@1.0.0, end-of-stream@1.4.5, error-ex@1.3.4, expand-template@2.0.3, fast-fifo@1.3.2, fs-constants@1.0.0, iota-array@1.0.0, is-arrayish@0.2.1, is-arrayish@0.3.4, is-buffer@1.1.6, js-tokens@4.0.0, kind-of@3.2.2, lazy-cache@1.0.4, lines-and-columns@1.2.4, longest@1.0.1, loose-envify@1.4.0, mkdirp-classic@0.5.3, ndarray@1.0.19, ndarray-fft@1.0.3, ndarray-ops@1.2.2, ndarray-resample@1.0.1, ndarray-scratch@1.2.0, postgres-array@2.0.0, postgres-bytea@1.0.1, postgres-date@1.0.7, postgres-interval@1.2.0, prebuild-install@7.1.3, pump@3.0.4, repeat-string@1.6.1, require-from-string@2.0.2, right-align@0.1.3, safe-buffer@5.1.2, safe-buffer@5.2.1, simple-swizzle@0.2.4, streamx@2.28.0, strip-json-comments@2.0.1, symbol-tree@3.2.4, tar-fs@2.1.5, tar-fs@3.1.3, tar-stream@2.2.0, tar-stream@3.2.0, teex@1.0.1, typedarray-pool@1.2.0, uniq@1.0.1, use-merge-value@1.2.0, whatwg-url@16.0.1, whatwg-url@5.0.0, xtend@4.0.2

```text
The MIT License (MIT)

Copyright (c) 2015, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L38

Used by: amdefine@1.0.1

```text
amdefine is released under two licenses: new BSD, and MIT. You may pick the
license that best suits your development needs. The text of both licenses are
provided below.


The "New" BSD License:
----------------------

Copyright (c) 2011-2016, The Dojo Foundation
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

  * Redistributions of source code must retain the above copyright notice, this
    list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.
  * Neither the name of the Dojo Foundation nor the names of its contributors
    may be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.



MIT License
-----------

Copyright (c) 2011-2016, The Dojo Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L39

Used by: ansi-regex@5.0.1, ansi-styles@4.3.0, callsites@3.1.0, chalk@4.1.2, clsx@2.1.1, decompress-response@6.0.0, escalade@3.2.0, escape-string-regexp@4.0.0, has-flag@4.0.0, import-fresh@3.3.1, is-fullwidth-code-point@3.0.0, is-plain-obj@4.1.0, mimic-response@3.1.0, p-retry@4.6.2, parent-module@1.0.1, parse-json@5.2.0, path-type@4.0.0, resolve-from@4.0.0, string-width@4.2.3, strip-ansi@6.0.1, supports-color@7.2.0, wrap-ansi@7.0.0

```text
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L40

Used by: argparse@1.0.10, html-url-attributes@3.0.1, js-yaml@4.1.1, remark-parse@11.0.0, trough@2.2.0, unified@11.0.5, vfile@6.0.3

```text
(The MIT License)

Copyright (C) 2012 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L41

Used by: argparse@2.0.1

```text
A. HISTORY OF THE SOFTWARE
==========================

Python was created in the early 1990s by Guido van Rossum at Stichting
Mathematisch Centrum (CWI, see http://www.cwi.nl) in the Netherlands
as a successor of a language called ABC.  Guido remains Python's
principal author, although it includes many contributions from others.

In 1995, Guido continued his work on Python at the Corporation for
National Research Initiatives (CNRI, see http://www.cnri.reston.va.us)
in Reston, Virginia where he released several versions of the
software.

In May 2000, Guido and the Python core development team moved to
BeOpen.com to form the BeOpen PythonLabs team.  In October of the same
year, the PythonLabs team moved to Digital Creations, which became
Zope Corporation.  In 2001, the Python Software Foundation (PSF, see
https://www.python.org/psf/) was formed, a non-profit organization
created specifically to own Python-related Intellectual Property.
Zope Corporation was a sponsoring member of the PSF.

All Python releases are Open Source (see http://www.opensource.org for
the Open Source Definition).  Historically, most, but not all, Python
releases have also been GPL-compatible; the table below summarizes
the various releases.

    Release         Derived     Year        Owner       GPL-
                    from                                compatible? (1)

    0.9.0 thru 1.2              1991-1995   CWI         yes
    1.3 thru 1.5.2  1.2         1995-1999   CNRI        yes
    1.6             1.5.2       2000        CNRI        no
    2.0             1.6         2000        BeOpen.com  no
    1.6.1           1.6         2001        CNRI        yes (2)
    2.1             2.0+1.6.1   2001        PSF         no
    2.0.1           2.0+1.6.1   2001        PSF         yes
    2.1.1           2.1+2.0.1   2001        PSF         yes
    2.1.2           2.1.1       2002        PSF         yes
    2.1.3           2.1.2       2002        PSF         yes
    2.2 and above   2.1.1       2001-now    PSF         yes

Footnotes:

(1) GPL-compatible doesn't mean that we're distributing Python under
    the GPL.  All Python licenses, unlike the GPL, let you distribute
    a modified version without making your changes open source.  The
    GPL-compatible licenses make it possible to combine Python with
    other software that is released under the GPL; the others don't.

(2) According to Richard Stallman, 1.6.1 is not GPL-compatible,
    because its license has a choice of law clause.  According to
    CNRI, however, Stallman's lawyer has told CNRI's lawyer that 1.6.1
    is "not incompatible" with the GPL.

Thanks to the many outside volunteers who have worked under Guido's
direction to make these releases possible.


B. TERMS AND CONDITIONS FOR ACCESSING OR OTHERWISE USING PYTHON
===============================================================

PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2
--------------------------------------------

1. This LICENSE AGREEMENT is between the Python Software Foundation
("PSF"), and the Individual or Organization ("Licensee") accessing and
otherwise using this software ("Python") in source or binary form and
its associated documentation.

2. Subject to the terms and conditions of this License Agreement, PSF hereby
grants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,
analyze, test, perform and/or display publicly, prepare derivative works,
distribute, and otherwise use Python alone or in any derivative version,
provided, however, that PSF's License Agreement and PSF's notice of copyright,
i.e., "Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020 Python Software Foundation;
All Rights Reserved" are retained in Python alone or in any derivative version
prepared by Licensee.

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python.

4. PSF is making Python available to Licensee on an "AS IS"
basis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between PSF and
Licensee.  This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using Python, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.


BEOPEN.COM LICENSE AGREEMENT FOR PYTHON 2.0
-------------------------------------------

BEOPEN PYTHON OPEN SOURCE LICENSE AGREEMENT VERSION 1

1. This LICENSE AGREEMENT is between BeOpen.com ("BeOpen"), having an
office at 160 Saratoga Avenue, Santa Clara, CA 95051, and the
Individual or Organization ("Licensee") accessing and otherwise using
this software in source or binary form and its associated
documentation ("the Software").

2. Subject to the terms and conditions of this BeOpen Python License
Agreement, BeOpen hereby grants Licensee a non-exclusive,
royalty-free, world-wide license to reproduce, analyze, test, perform
and/or display publicly, prepare derivative works, distribute, and
otherwise use the Software alone or in any derivative version,
provided, however, that the BeOpen Python License is retained in the
Software, alone or in any derivative version prepared by Licensee.

3. BeOpen is making the Software available to Licensee on an "AS IS"
basis.  BEOPEN MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, BEOPEN MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE SOFTWARE WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

4. BEOPEN SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF THE
SOFTWARE FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS
AS A RESULT OF USING, MODIFYING OR DISTRIBUTING THE SOFTWARE, OR ANY
DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

5. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

6. This License Agreement shall be governed by and interpreted in all
respects by the law of the State of California, excluding conflict of
law provisions.  Nothing in this License Agreement shall be deemed to
create any relationship of agency, partnership, or joint venture
between BeOpen and Licensee.  This License Agreement does not grant
permission to use BeOpen trademarks or trade names in a trademark
sense to endorse or promote products or services of Licensee, or any
third party.  As an exception, the "BeOpen Python" logos available at
http://www.pythonlabs.com/logos.html may be used according to the
permissions granted on that web page.

7. By copying, installing or otherwise using the software, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.


CNRI LICENSE AGREEMENT FOR PYTHON 1.6.1
---------------------------------------

1. This LICENSE AGREEMENT is between the Corporation for National
Research Initiatives, having an office at 1895 Preston White Drive,
Reston, VA 20191 ("CNRI"), and the Individual or Organization
("Licensee") accessing and otherwise using Python 1.6.1 software in
source or binary form and its associated documentation.

2. Subject to the terms and conditions of this License Agreement, CNRI
hereby grants Licensee a nonexclusive, royalty-free, world-wide
license to reproduce, analyze, test, perform and/or display publicly,
prepare derivative works, distribute, and otherwise use Python 1.6.1
alone or in any derivative version, provided, however, that CNRI's
License Agreement and CNRI's notice of copyright, i.e., "Copyright (c)
1995-2001 Corporation for National Research Initiatives; All Rights
Reserved" are retained in Python 1.6.1 alone or in any derivative
version prepared by Licensee.  Alternately, in lieu of CNRI's License
Agreement, Licensee may substitute the following text (omitting the
quotes): "Python 1.6.1 is made available subject to the terms and
conditions in CNRI's License Agreement.  This Agreement together with
Python 1.6.1 may be located on the Internet using the following
unique, persistent identifier (known as a handle): 1895.22/1013.  This
Agreement may also be obtained from a proxy server on the Internet
using the following URL: http://hdl.handle.net/1895.22/1013".

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python 1.6.1 or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python 1.6.1.

4. CNRI is making Python 1.6.1 available to Licensee on an "AS IS"
basis.  CNRI MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, CNRI MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON 1.6.1 WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. CNRI SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
1.6.1 FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON 1.6.1,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. This License Agreement shall be governed by the federal
intellectual property law of the United States, including without
limitation the federal copyright law, and, to the extent such
U.S. federal law does not apply, by the law of the Commonwealth of
Virginia, excluding Virginia's conflict of law provisions.
Notwithstanding the foregoing, with regard to derivative works based
on Python 1.6.1 that incorporate non-separable material that was
previously distributed under the GNU General Public License (GPL), the
law of the Commonwealth of Virginia shall govern this License
Agreement only as to issues arising under or with respect to
Paragraphs 4, 5, and 7 of this License Agreement.  Nothing in this
License Agreement shall be deemed to create any relationship of
agency, partnership, or joint venture between CNRI and Licensee.  This
License Agreement does not grant permission to use CNRI trademarks or
trade name in a trademark sense to endorse or promote products or
services of Licensee, or any third party.

8. By clicking on the "ACCEPT" button where indicated, or by copying,
installing or otherwise using Python 1.6.1, Licensee agrees to be
bound by the terms and conditions of this License Agreement.

        ACCEPT


CWI LICENSE AGREEMENT FOR PYTHON 0.9.0 THROUGH 1.2
--------------------------------------------------

Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam,
The Netherlands.  All rights reserved.

Permission to use, copy, modify, and distribute this software and its
documentation for any purpose and without fee is hereby granted,
provided that the above copyright notice appear in all copies and that
both that copyright notice and this permission notice appear in
supporting documentation, and that the name of Stichting Mathematisch
Centrum or CWI not be used in advertising or publicity pertaining to
distribution of the software without specific, written prior
permission.

STICHTING MATHEMATISCH CENTRUM DISCLAIMS ALL WARRANTIES WITH REGARD TO
THIS SOFTWARE, INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS, IN NO EVENT SHALL STICHTING MATHEMATISCH CENTRUM BE LIABLE
FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text L42

Used by: bignumber.js@9.3.1, w3c-xmlserializer@5.0.0

```text
The MIT License (MIT)
=====================

Copyright © `<2025>` `Michael Mclaughlin`

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the “Software”), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### License text L43

Used by: bl@4.1.0

```text
The MIT License (MIT)
=====================

Copyright (c) 2013-2019 bl contributors
----------------------------------

*bl contributors listed at <https://github.com/rvagg/bl#contributors>*

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L44

Used by: buffer-equal-constant-time@1.0.1

```text
Copyright (c) 2013, GoInstant Inc., a salesforce.com company
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

* Neither the name of salesforce.com, nor GoInstant, nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L45

Used by: caniuse-lite@1.0.30001781

```text
Attribution 4.0 International

=======================================================================

Creative Commons Corporation ("Creative Commons") is not a law firm and
does not provide legal services or legal advice. Distribution of
Creative Commons public licenses does not create a lawyer-client or
other relationship. Creative Commons makes its licenses and related
information available on an "as-is" basis. Creative Commons gives no
warranties regarding its licenses, any material licensed under their
terms and conditions, or any related information. Creative Commons
disclaims all liability for damages resulting from their use to the
fullest extent possible.

Using Creative Commons Public Licenses

Creative Commons public licenses provide a standard set of terms and
conditions that creators and other rights holders may use to share
original works of authorship and other material subject to copyright
and certain other rights specified in the public license below. The
following considerations are for informational purposes only, are not
exhaustive, and do not form part of our licenses.

     Considerations for licensors: Our public licenses are
     intended for use by those authorized to give the public
     permission to use material in ways otherwise restricted by
     copyright and certain other rights. Our licenses are
     irrevocable. Licensors should read and understand the terms
     and conditions of the license they choose before applying it.
     Licensors should also secure all rights necessary before
     applying our licenses so that the public can reuse the
     material as expected. Licensors should clearly mark any
     material not subject to the license. This includes other CC-
     licensed material, or material used under an exception or
     limitation to copyright. More considerations for licensors:
	wiki.creativecommons.org/Considerations_for_licensors

     Considerations for the public: By using one of our public
     licenses, a licensor grants the public permission to use the
     licensed material under specified terms and conditions. If
     the licensor's permission is not necessary for any reason--for
     example, because of any applicable exception or limitation to
     copyright--then that use is not regulated by the license. Our
     licenses grant only permissions under copyright and certain
     other rights that a licensor has authority to grant. Use of
     the licensed material may still be restricted for other
     reasons, including because others have copyright or other
     rights in the material. A licensor may make special requests,
     such as asking that all changes be marked or described.
     Although not required by our licenses, you are encouraged to
     respect those requests where reasonable. More_considerations
     for the public: 
	wiki.creativecommons.org/Considerations_for_licensees

=======================================================================

Creative Commons Attribution 4.0 International Public License

By exercising the Licensed Rights (defined below), You accept and agree
to be bound by the terms and conditions of this Creative Commons
Attribution 4.0 International Public License ("Public License"). To the
extent this Public License may be interpreted as a contract, You are
granted the Licensed Rights in consideration of Your acceptance of
these terms and conditions, and the Licensor grants You such rights in
consideration of benefits the Licensor receives from making the
Licensed Material available under these terms and conditions.


Section 1 -- Definitions.

  a. Adapted Material means material subject to Copyright and Similar
     Rights that is derived from or based upon the Licensed Material
     and in which the Licensed Material is translated, altered,
     arranged, transformed, or otherwise modified in a manner requiring
     permission under the Copyright and Similar Rights held by the
     Licensor. For purposes of this Public License, where the Licensed
     Material is a musical work, performance, or sound recording,
     Adapted Material is always produced where the Licensed Material is
     synched in timed relation with a moving image.

  b. Adapter's License means the license You apply to Your Copyright
     and Similar Rights in Your contributions to Adapted Material in
     accordance with the terms and conditions of this Public License.

  c. Copyright and Similar Rights means copyright and/or similar rights
     closely related to copyright including, without limitation,
     performance, broadcast, sound recording, and Sui Generis Database
     Rights, without regard to how the rights are labeled or
     categorized. For purposes of this Public License, the rights
     specified in Section 2(b)(1)-(2) are not Copyright and Similar
     Rights.

  d. Effective Technological Measures means those measures that, in the
     absence of proper authority, may not be circumvented under laws
     fulfilling obligations under Article 11 of the WIPO Copyright
     Treaty adopted on December 20, 1996, and/or similar international
     agreements.

  e. Exceptions and Limitations means fair use, fair dealing, and/or
     any other exception or limitation to Copyright and Similar Rights
     that applies to Your use of the Licensed Material.

  f. Licensed Material means the artistic or literary work, database,
     or other material to which the Licensor applied this Public
     License.

  g. Licensed Rights means the rights granted to You subject to the
     terms and conditions of this Public License, which are limited to
     all Copyright and Similar Rights that apply to Your use of the
     Licensed Material and that the Licensor has authority to license.

  h. Licensor means the individual(s) or entity(ies) granting rights
     under this Public License.

  i. Share means to provide material to the public by any means or
     process that requires permission under the Licensed Rights, such
     as reproduction, public display, public performance, distribution,
     dissemination, communication, or importation, and to make material
     available to the public including in ways that members of the
     public may access the material from a place and at a time
     individually chosen by them.

  j. Sui Generis Database Rights means rights other than copyright
     resulting from Directive 96/9/EC of the European Parliament and of
     the Council of 11 March 1996 on the legal protection of databases,
     as amended and/or succeeded, as well as other essentially
     equivalent rights anywhere in the world.

  k. You means the individual or entity exercising the Licensed Rights
     under this Public License. Your has a corresponding meaning.


Section 2 -- Scope.

  a. License grant.

       1. Subject to the terms and conditions of this Public License,
          the Licensor hereby grants You a worldwide, royalty-free,
          non-sublicensable, non-exclusive, irrevocable license to
          exercise the Licensed Rights in the Licensed Material to:

            a. reproduce and Share the Licensed Material, in whole or
               in part; and

            b. produce, reproduce, and Share Adapted Material.

       2. Exceptions and Limitations. For the avoidance of doubt, where
          Exceptions and Limitations apply to Your use, this Public
          License does not apply, and You do not need to comply with
          its terms and conditions.

       3. Term. The term of this Public License is specified in Section
          6(a).

       4. Media and formats; technical modifications allowed. The
          Licensor authorizes You to exercise the Licensed Rights in
          all media and formats whether now known or hereafter created,
          and to make technical modifications necessary to do so. The
          Licensor waives and/or agrees not to assert any right or
          authority to forbid You from making technical modifications
          necessary to exercise the Licensed Rights, including
          technical modifications necessary to circumvent Effective
          Technological Measures. For purposes of this Public License,
          simply making modifications authorized by this Section 2(a)
          (4) never produces Adapted Material.

       5. Downstream recipients.

            a. Offer from the Licensor -- Licensed Material. Every
               recipient of the Licensed Material automatically
               receives an offer from the Licensor to exercise the
               Licensed Rights under the terms and conditions of this
               Public License.

            b. No downstream restrictions. You may not offer or impose
               any additional or different terms or conditions on, or
               apply any Effective Technological Measures to, the
               Licensed Material if doing so restricts exercise of the
               Licensed Rights by any recipient of the Licensed
               Material.

       6. No endorsement. Nothing in this Public License constitutes or
          may be construed as permission to assert or imply that You
          are, or that Your use of the Licensed Material is, connected
          with, or sponsored, endorsed, or granted official status by,
          the Licensor or others designated to receive attribution as
          provided in Section 3(a)(1)(A)(i).

  b. Other rights.

       1. Moral rights, such as the right of integrity, are not
          licensed under this Public License, nor are publicity,
          privacy, and/or other similar personality rights; however, to
          the extent possible, the Licensor waives and/or agrees not to
          assert any such rights held by the Licensor to the limited
          extent necessary to allow You to exercise the Licensed
          Rights, but not otherwise.

       2. Patent and trademark rights are not licensed under this
          Public License.

       3. To the extent possible, the Licensor waives any right to
          collect royalties from You for the exercise of the Licensed
          Rights, whether directly or through a collecting society
          under any voluntary or waivable statutory or compulsory
          licensing scheme. In all other cases the Licensor expressly
          reserves any right to collect such royalties.


Section 3 -- License Conditions.

Your exercise of the Licensed Rights is expressly made subject to the
following conditions.

  a. Attribution.

       1. If You Share the Licensed Material (including in modified
          form), You must:

            a. retain the following if it is supplied by the Licensor
               with the Licensed Material:

                 i. identification of the creator(s) of the Licensed
                    Material and any others designated to receive
                    attribution, in any reasonable manner requested by
                    the Licensor (including by pseudonym if
                    designated);

                ii. a copyright notice;

               iii. a notice that refers to this Public License;

                iv. a notice that refers to the disclaimer of
                    warranties;

                 v. a URI or hyperlink to the Licensed Material to the
                    extent reasonably practicable;

            b. indicate if You modified the Licensed Material and
               retain an indication of any previous modifications; and

            c. indicate the Licensed Material is licensed under this
               Public License, and include the text of, or the URI or
               hyperlink to, this Public License.

       2. You may satisfy the conditions in Section 3(a)(1) in any
          reasonable manner based on the medium, means, and context in
          which You Share the Licensed Material. For example, it may be
          reasonable to satisfy the conditions by providing a URI or
          hyperlink to a resource that includes the required
          information.

       3. If requested by the Licensor, You must remove any of the
          information required by Section 3(a)(1)(A) to the extent
          reasonably practicable.

       4. If You Share Adapted Material You produce, the Adapter's
          License You apply must not prevent recipients of the Adapted
          Material from complying with this Public License.


Section 4 -- Sui Generis Database Rights.

Where the Licensed Rights include Sui Generis Database Rights that
apply to Your use of the Licensed Material:

  a. for the avoidance of doubt, Section 2(a)(1) grants You the right
     to extract, reuse, reproduce, and Share all or a substantial
     portion of the contents of the database;

  b. if You include all or a substantial portion of the database
     contents in a database in which You have Sui Generis Database
     Rights, then the database in which You have Sui Generis Database
     Rights (but not its individual contents) is Adapted Material; and

  c. You must comply with the conditions in Section 3(a) if You Share
     all or a substantial portion of the contents of the database.

For the avoidance of doubt, this Section 4 supplements and does not
replace Your obligations under this Public License where the Licensed
Rights include other Copyright and Similar Rights.


Section 5 -- Disclaimer of Warranties and Limitation of Liability.

  a. UNLESS OTHERWISE SEPARATELY UNDERTAKEN BY THE LICENSOR, TO THE
     EXTENT POSSIBLE, THE LICENSOR OFFERS THE LICENSED MATERIAL AS-IS
     AND AS-AVAILABLE, AND MAKES NO REPRESENTATIONS OR WARRANTIES OF
     ANY KIND CONCERNING THE LICENSED MATERIAL, WHETHER EXPRESS,
     IMPLIED, STATUTORY, OR OTHER. THIS INCLUDES, WITHOUT LIMITATION,
     WARRANTIES OF TITLE, MERCHANTABILITY, FITNESS FOR A PARTICULAR
     PURPOSE, NON-INFRINGEMENT, ABSENCE OF LATENT OR OTHER DEFECTS,
     ACCURACY, OR THE PRESENCE OR ABSENCE OF ERRORS, WHETHER OR NOT
     KNOWN OR DISCOVERABLE. WHERE DISCLAIMERS OF WARRANTIES ARE NOT
     ALLOWED IN FULL OR IN PART, THIS DISCLAIMER MAY NOT APPLY TO YOU.

  b. TO THE EXTENT POSSIBLE, IN NO EVENT WILL THE LICENSOR BE LIABLE
     TO YOU ON ANY LEGAL THEORY (INCLUDING, WITHOUT LIMITATION,
     NEGLIGENCE) OR OTHERWISE FOR ANY DIRECT, SPECIAL, INDIRECT,
     INCIDENTAL, CONSEQUENTIAL, PUNITIVE, EXEMPLARY, OR OTHER LOSSES,
     COSTS, EXPENSES, OR DAMAGES ARISING OUT OF THIS PUBLIC LICENSE OR
     USE OF THE LICENSED MATERIAL, EVEN IF THE LICENSOR HAS BEEN
     ADVISED OF THE POSSIBILITY OF SUCH LOSSES, COSTS, EXPENSES, OR
     DAMAGES. WHERE A LIMITATION OF LIABILITY IS NOT ALLOWED IN FULL OR
     IN PART, THIS LIMITATION MAY NOT APPLY TO YOU.

  c. The disclaimer of warranties and limitation of liability provided
     above shall be interpreted in a manner that, to the extent
     possible, most closely approximates an absolute disclaimer and
     waiver of all liability.


Section 6 -- Term and Termination.

  a. This Public License applies for the term of the Copyright and
     Similar Rights licensed here. However, if You fail to comply with
     this Public License, then Your rights under this Public License
     terminate automatically.

  b. Where Your right to use the Licensed Material has terminated under
     Section 6(a), it reinstates:

       1. automatically as of the date the violation is cured, provided
          it is cured within 30 days of Your discovery of the
          violation; or

       2. upon express reinstatement by the Licensor.

     For the avoidance of doubt, this Section 6(b) does not affect any
     right the Licensor may have to seek remedies for Your violations
     of this Public License.

  c. For the avoidance of doubt, the Licensor may also offer the
     Licensed Material under separate terms or conditions or stop
     distributing the Licensed Material at any time; however, doing so
     will not terminate this Public License.

  d. Sections 1, 5, 6, 7, and 8 survive termination of this Public
     License.


Section 7 -- Other Terms and Conditions.

  a. The Licensor shall not be bound by any additional or different
     terms or conditions communicated by You unless expressly agreed.

  b. Any arrangements, understandings, or agreements regarding the
     Licensed Material not stated herein are separate from and
     independent of the terms and conditions of this Public License.


Section 8 -- Interpretation.

  a. For the avoidance of doubt, this Public License does not, and
     shall not be interpreted to, reduce, limit, restrict, or impose
     conditions on any use of the Licensed Material that could lawfully
     be made without permission under this Public License.

  b. To the extent possible, if any provision of this Public License is
     deemed unenforceable, it shall be automatically reformed to the
     minimum extent necessary to make it enforceable. If the provision
     cannot be reformed, it shall be severed from this Public License
     without affecting the enforceability of the remaining terms and
     conditions.

  c. No term or condition of this Public License will be waived and no
     failure to comply consented to unless expressly agreed to by the
     Licensor.

  d. Nothing in this Public License constitutes or may be interpreted
     as a limitation upon, or waiver of, any privileges and immunities
     that apply to the Licensor or You, including from the legal
     processes of any jurisdiction or authority.


=======================================================================

Creative Commons is not a party to its public
licenses. Notwithstanding, Creative Commons may elect to apply one of
its public licenses to material it publishes and in those instances
will be considered the “Licensor.” The text of the Creative Commons
public licenses is dedicated to the public domain under the CC0 Public
Domain Dedication. Except for the limited purpose of indicating that
material is shared under a Creative Commons public license or as
otherwise permitted by the Creative Commons policies published at
creativecommons.org/policies, Creative Commons does not authorize the
use of the trademark "Creative Commons" or any other trademark or logo
of Creative Commons without its prior written consent including,
without limitation, in connection with any unauthorized modifications
to any of its public licenses or any other arrangements,
understandings, or agreements concerning use of licensed material. For
the avoidance of doubt, this paragraph does not form part of the
public licenses.

Creative Commons may be contacted at creativecommons.org.
```

### License text L46

Used by: chownr@1.1.4, graceful-fs@4.2.11, inherits@2.0.4, ini@1.3.8, isexe@2.0.0, once@1.4.0, semver@7.7.4, which@1.3.1, wrappy@1.0.2

```text
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text L47

Used by: cjs-module-lexer@1.4.3

```text
MIT License
-----------

Copyright (C) 2018-2020 Guy Bedford

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L48

Used by: cliui@2.1.0, cliui@7.0.4, yargs-parser@20.2.9

```text
Copyright (c) 2015, Contributors

Permission to use, copy, modify, and/or distribute this software
for any purpose with or without fee is hereby granted, provided
that the above copyright notice and this permission notice
appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE
LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text L49

Used by: color@4.2.3, color-convert@2.0.1, color-string@1.9.1, platform@1.3.6

```text
Copyright (c) 2012 Heather Arthur

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L50

Used by: concat-stream@1.6.2

```text
The MIT License

Copyright (c) 2013 Max Ogden

Permission is hereby granted, free of charge, 
to any person obtaining a copy of this software and 
associated documentation files (the "Software"), to 
deal in the Software without restriction, including 
without limitation the rights to use, copy, modify, 
merge, publish, distribute, sublicense, and/or sell 
copies of the Software, and to permit persons to whom 
the Software is furnished to do so, 
subject to the following conditions:

The above copyright notice and this permission notice 
shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, 
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES 
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. 
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR 
ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, 
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE 
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L51

Used by: convert-source-map@1.9.0

```text
Copyright 2013 Thorsten Lorenz. 
All rights reserved.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### License text L52

Used by: debug@4.4.3

```text
(The MIT License)

Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2018-2021 Josh Junon

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the 'Software'), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L53

Used by: decimal.js@10.6.0

```text
The MIT Licence.

Copyright (c) 2025 Michael Mclaughlin

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L54

Used by: detect-libc@2.0.2, detect-libc@2.1.2, ecdsa-sig-formatter@1.0.11

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright {yyyy} {name of copyright owner}

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text L55

Used by: dotenv@17.3.1

```text
Copyright (c) 2015, Scott Motte
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L56

Used by: duplexer2@0.0.2

```text
Copyright (c) 2013, Deoxxa Development
======================================
All rights reserved.
--------------------
  
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:  
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.  
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.  
3. Neither the name of Deoxxa Development nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.  
  
THIS SOFTWARE IS PROVIDED BY DEOXXA DEVELOPMENT ''AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL DEOXXA DEVELOPMENT BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L57

Used by: earcut@3.0.2

```text
ISC License

Copyright (c) 2024, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text L58

Used by: entities@8.0.0

```text
Copyright (c) Felix Böhm
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L59

Used by: es-toolkit@1.45.1

```text
MIT License

Copyright (c) 2024 Viva Republica, Inc

Copyright OpenJS Foundation and other contributors

Parts of the test suite and compatibility layer in `es-toolkit/compat` are derived from Lodash (https://github.com/lodash/lodash) by the OpenJS Foundation (https://openjsf.org/) and Underscore.js by Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors (http://underscorejs.org/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text L60

Used by: extend@3.0.2, style-to-js@1.1.21, style-to-object@1.0.14

```text
The MIT License (MIT)

Copyright (c) 2014 Stefan Thomas

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L61

Used by: fast-uri@3.1.0

```text
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team
All rights reserved.

The Fastify team members are listed at https://github.com/fastify/fastify#team.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

### License text L62

Used by: fix-webm-duration@1.0.6

```text
The MIT license

Copyright (c) 2018 Yury Sitnikov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L63

Used by: fluent-ffmpeg@2.1.3, inline-style-parser@0.2.7

```text
(The MIT License)

Copyright (c) 2011-2015 The fluent-ffmpeg contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L64

Used by: fs-extra@10.1.0, jsonfile@6.2.0

```text
(The MIT License)

Copyright (c) 2011-2017 JP Richardson

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files
(the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify,
 merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
 ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L65

Used by: geist@1.7.0

```text
Copyright (c) 2023 Vercel, in collaboration with basement.studio

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text L66

Used by: get-caller-file@2.0.5

```text
ISC License (ISC)
Copyright 2018 Stefan Penner

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text L67

Used by: github-from-package@0.0.0, minimist@0.0.8, minimist@1.2.8, object-inspect@0.4.0, quote-stream@0.0.0, shallow-copy@0.0.1, static-eval@0.2.4, static-module@1.5.0

```text
This software is released under the MIT license:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L68

Used by: hoist-non-react-statics@3.3.2

```text
Software License Agreement (BSD License)
========================================

Copyright (c) 2015, Yahoo! Inc. All rights reserved.
----------------------------------------------------

Redistribution and use of this software in source and binary forms, with or
without modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright notice, this
    list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.
  * Neither the name of Yahoo! Inc. nor the names of YUI's contributors may be
    used to endorse or promote products derived from this software without
    specific prior written permission of Yahoo! Inc.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L69

Used by: ieee754@1.2.1

```text
Copyright 2008 Fair Oaks Labs, Inc.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L70

Used by: js-base64@3.7.8

```text
Copyright (c) 2014, Dan Kogai
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of {{{project}}} nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L71

Used by: json-parse-even-better-errors@2.3.1

```text
Copyright 2017 Kat Marchán
Copyright npm, Inc.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

---

This library is a fork of 'better-json-errors' by Kat Marchán, extended and
distributed under the terms of the MIT license above.
```

### License text L72

Used by: jwa@2.0.1, jws@4.0.1

```text
Copyright (c) 2013 Brian J. Brennan

Permission is hereby granted, free of charge, to any person obtaining a copy 
of this software and associated documentation files (the "Software"), to deal in 
the Software without restriction, including without limitation the rights to use, 
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the 
Software, and to permit persons to whom the Software is furnished to do so, 
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all 
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, 
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR 
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L73

Used by: lodash.escaperegexp@4.1.2, lodash.isequal@4.5.0

```text
Copyright jQuery Foundation and other contributors <https://jquery.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```

### License text L74

Used by: lru-cache@11.5.1, sax@1.6.0

```text
# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```

### License text L75

Used by: mdn-data@2.27.1

```text
CC0 1.0 Universal

Statement of Purpose

The laws of most jurisdictions throughout the world automatically confer
exclusive Copyright and Related Rights (defined below) upon the creator and
subsequent owner(s) (each and all, an "owner") of an original work of
authorship and/or a database (each, a "Work").

Certain owners wish to permanently relinquish those rights to a Work for the
purpose of contributing to a commons of creative, cultural and scientific
works ("Commons") that the public can reliably and without fear of later
claims of infringement build upon, modify, incorporate in other works, reuse
and redistribute as freely as possible in any form whatsoever and for any
purposes, including without limitation commercial purposes. These owners may
contribute to the Commons to promote the ideal of a free culture and the
further production of creative, cultural and scientific works, or to gain
reputation or greater distribution for their Work in part through the use and
efforts of others.

For these and/or other purposes and motivations, and without any expectation
of additional consideration or compensation, the person associating CC0 with a
Work (the "Affirmer"), to the extent that he or she is an owner of Copyright
and Related Rights in the Work, voluntarily elects to apply CC0 to the Work
and publicly distribute the Work under its terms, with knowledge of his or her
Copyright and Related Rights in the Work and the meaning and intended legal
effect of CC0 on those rights.

1. Copyright and Related Rights. A Work made available under CC0 may be
protected by copyright and related or neighboring rights ("Copyright and
Related Rights"). Copyright and Related Rights include, but are not limited
to, the following:

  i. the right to reproduce, adapt, distribute, perform, display, communicate,
  and translate a Work;

  ii. moral rights retained by the original author(s) and/or performer(s);

  iii. publicity and privacy rights pertaining to a person's image or likeness
  depicted in a Work;

  iv. rights protecting against unfair competition in regards to a Work,
  subject to the limitations in paragraph 4(a), below;

  v. rights protecting the extraction, dissemination, use and reuse of data in
  a Work;

  vi. database rights (such as those arising under Directive 96/9/EC of the
  European Parliament and of the Council of 11 March 1996 on the legal
  protection of databases, and under any national implementation thereof,
  including any amended or successor version of such directive); and

  vii. other similar, equivalent or corresponding rights throughout the world
  based on applicable law or treaty, and any national implementations thereof.

2. Waiver. To the greatest extent permitted by, but not in contravention of,
applicable law, Affirmer hereby overtly, fully, permanently, irrevocably and
unconditionally waives, abandons, and surrenders all of Affirmer's Copyright
and Related Rights and associated claims and causes of action, whether now
known or unknown (including existing as well as future claims and causes of
action), in the Work (i) in all territories worldwide, (ii) for the maximum
duration provided by applicable law or treaty (including future time
extensions), (iii) in any current or future medium and for any number of
copies, and (iv) for any purpose whatsoever, including without limitation
commercial, advertising or promotional purposes (the "Waiver"). Affirmer makes
the Waiver for the benefit of each member of the public at large and to the
detriment of Affirmer's heirs and successors, fully intending that such Waiver
shall not be subject to revocation, rescission, cancellation, termination, or
any other legal or equitable action to disrupt the quiet enjoyment of the Work
by the public as contemplated by Affirmer's express Statement of Purpose.

3. Public License Fallback. Should any part of the Waiver for any reason be
judged legally invalid or ineffective under applicable law, then the Waiver
shall be preserved to the maximum extent permitted taking into account
Affirmer's express Statement of Purpose. In addition, to the extent the Waiver
is so judged Affirmer hereby grants to each affected person a royalty-free,
non transferable, non sublicensable, non exclusive, irrevocable and
unconditional license to exercise Affirmer's Copyright and Related Rights in
the Work (i) in all territories worldwide, (ii) for the maximum duration
provided by applicable law or treaty (including future time extensions), (iii)
in any current or future medium and for any number of copies, and (iv) for any
purpose whatsoever, including without limitation commercial, advertising or
promotional purposes (the "License"). The License shall be deemed effective as
of the date CC0 was applied by Affirmer to the Work. Should any part of the
License for any reason be judged legally invalid or ineffective under
applicable law, such partial invalidity or ineffectiveness shall not
invalidate the remainder of the License, and in such case Affirmer hereby
affirms that he or she will not (i) exercise any of his or her remaining
Copyright and Related Rights in the Work or (ii) assert any associated claims
and causes of action with respect to the Work, in either case contrary to
Affirmer's express Statement of Purpose.

4. Limitations and Disclaimers.

  a. No trademark or patent rights held by Affirmer are waived, abandoned,
  surrendered, licensed or otherwise affected by this document.

  b. Affirmer offers the Work as-is and makes no representations or warranties
  of any kind concerning the Work, express, implied, statutory or otherwise,
  including without limitation warranties of title, merchantability, fitness
  for a particular purpose, non infringement, or the absence of latent or
  other defects, accuracy, or the present or absence of errors, whether or not
  discoverable, all to the greatest extent permissible under applicable law.

  c. Affirmer disclaims responsibility for clearing rights of other persons
  that may apply to the Work or any use thereof, including without limitation
  any person's Copyright and Related Rights in the Work. Further, Affirmer
  disclaims responsibility for obtaining any necessary consents, permissions
  or other rights required for any use of the Work.

  d. Affirmer understands and acknowledges that Creative Commons is not a
  party to this document and has no duty or obligation with respect to this
  CC0 or use of the Work.

For more information, please see
<http://creativecommons.org/publicdomain/zero/1.0/>
```

### License text L76

Used by: mediabunny@1.40.1

```text
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

### License text L77

Used by: node-addon-api@6.1.0

```text
The MIT License (MIT)
=====================

Copyright (c) 2017 Node.js API collaborators
-----------------------------------

*Node.js API collaborators listed at <https://github.com/nodejs/node-addon-api#collaborators>*

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L78

Used by: pdfjs-dist@4.10.38, xml-name-validator@5.0.0

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

### License text L79

Used by: pg-int8@1.0.1

```text
Copyright © 2017, Charmander <~@charmander.me>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED “AS IS” AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### License text L80

Used by: pixi.js@8.17.1, three@0.183.2

```text
The MIT License

Copyright (c) 2013-2023 Mathew Groves, Chad Engler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text L81

Used by: process-nextick-args@2.0.1

```text
# Copyright (c) 2015 Calvin Metcalf

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.**
```

### License text L82

Used by: protobufjs@6.11.6, protobufjs@7.5.4

```text
This license applies to all parts of protobuf.js except those files
either explicitly including or referencing a different license or
located in a directory containing a different LICENSE file.

---

Copyright (c) 2016, Daniel Wirtz  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of its author, nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

---

Code generated by the command line utilities is owned by the owner
of the input file used when generating it. This code is not
standalone and requires a support library to be linked with it. This
support library is itself covered by the above license.
```

### License text L83

Used by: readable-stream@2.3.8, readable-stream@3.6.2, string_decoder@1.1.1, string_decoder@1.3.0

```text
Node.js is licensed for use as follows:

"""
Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""

This license applies to parts of Node.js originating from the
https://github.com/joyent/node repository:

"""
Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""
```

### License text L84

Used by: require-directory@2.1.1

```text
The MIT License (MIT)

Copyright (c) 2011 Troy Goode <troygoode@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L85

Used by: retry@0.13.1

```text
Copyright (c) 2011:
Tim Koschützki (tim@debuggable.com)
Felix Geisendörfer (felix@debuggable.com)

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
```

### License text L86

Used by: shimmer@1.2.1

```text
BSD 2-Clause License

Copyright (c) 2013-2019, Forrest L Norvell
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L87

Used by: source-map@0.1.43, source-map@0.5.7, source-map@0.6.1, source-map-js@1.2.1

```text
Copyright (c) 2009-2011, Mozilla Foundation and contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the names of the Mozilla Foundation nor the names of project
  contributors may be used to endorse or promote products derived from this
  software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L88

Used by: sprintf-js@1.0.3

```text
Copyright (c) 2007-2014, Alexandru Marasteanu <hello [at) alexei (dot] ro>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of this software nor the names of its contributors may be
  used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L89

Used by: string_decoder@0.10.31

```text
Copyright Joyent, Inc. and other Node contributors.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L90

Used by: through2@0.4.2

```text
Copyright 2013, Rod Vagg (the "Original Author")
All rights reserved.

MIT +no-false-attribs License

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

Distributions of all or part of the Software intended to be used
by the recipients as they would use the unmodified Software,
containing modifications that substantially alter, remove, or
disable functionality of the Software, outside of the documented
configuration mechanisms provided by the Software, shall be
modified such that the Original Author's bug reporting email
addresses and urls are either replaced with the contact information
of the parties responsible for the changes, or removed entirely.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.


Except where noted, this license applies to any and all software
programs and associated documentation files created by the
Original Author, when distributed with the Software.
```

### License text L91

Used by: tiny-lru@11.4.7

```text
Copyright (c) 2026, Jason Mulligan
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of tiny-lru nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L92

Used by: tldts@7.0.27, tldts-core@7.0.27

```text
Copyright (c) 2017 Thomas Parisot, 2018 Rémi Berson

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L93

Used by: tough-cookie@6.0.1

```text
Copyright (c) 2015, Salesforce.com, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of Salesforce.com nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L94

Used by: tslib@2.8.1

```text
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### License text L95

Used by: tunnel-agent@0.6.0

```text
Apache License

Version 2.0, January 2004

http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

"Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:

You must give any other recipients of the Work or Derivative Works a copy of this License; and

You must cause any modified files to carry prominent notices stating that You changed the files; and

You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and

If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License. You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```

### License text L96

Used by: typedarray@0.0.6

```text
/*
 Copyright (c) 2010, Linden Research, Inc.
 Copyright (c) 2012, Joshua Bell

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 $/LicenseInfo$
 */

// Original can be found at:
//   https://bitbucket.org/lindenlab/llsd
// Modifications by Joshua Bell inexorabletash@gmail.com
//   https://github.com/inexorabletash/polyfill

// ES3/ES5 implementation of the Krhonos Typed Array Specification
//   Ref: http://www.khronos.org/registry/typedarray/specs/latest/
//   Date: 2011-02-01
//
// Variations:
//  * Allows typed_array.get/set() as alias for subscripts (typed_array[])
```

### License text L97

Used by: uglify-js@2.8.29

```text
UglifyJS is released under the BSD license:

Copyright 2012-2013 (c) Mihai Bazon <mihai.bazon@gmail.com>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

    * Redistributions of source code must retain the above
      copyright notice, this list of conditions and the following
      disclaimer.

    * Redistributions in binary form must reproduce the above
      copyright notice, this list of conditions and the following
      disclaimer in the documentation and/or other materials
      provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```

### License text L98

Used by: unist-util-is@6.0.1

```text
(The MIT license)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L99

Used by: universalify@2.0.1

```text
(The MIT License)

Copyright (c) 2017, Ryan Zimmerman <opensrc@ryanzim.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the 'Software'), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L100

Used by: util-deprecate@1.0.2

```text
(The MIT License)

Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net>

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### License text L101

Used by: webidl-conversions@3.0.1, webidl-conversions@8.0.1

```text
# The BSD 2-Clause License

Copyright (c) 2014, Domenic Denicola
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text L102

Used by: ws@8.20.0, xmlchars@2.2.0

```text
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text L103

Used by: y18n@5.0.8, yaml@1.10.3, yaml@2.8.3

```text
Copyright (c) 2015, Contributors

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text L104

Used by: yargs@3.10.0

```text
Copyright 2010 James Halliday (mail@substack.net)

This project is free software released under the MIT/X11 license:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

<!-- END GENERATED: npm-dependencies -->
