# @dreambyte/motion-dsl

A motion DSL for AI-driven animated video — 56 named presets, a React style compiler, and a flat operator-tagged choreography vocabulary distilled from animate.css, motion-canvas, react-spring, and mojs.

Designed for LLM ergonomics: every animation request is a flat object with a single discriminator. No nested trees, no string DSL parsing, no bracket balancing. The agent picks `{ kind: 'preset', preset: 'fadeInUp' }`, the compiler does the rest.

```ts
import { compileMotionRefToStyleAt } from '@dreambyte/motion-dsl/compiler/react'
import type { MotionRef } from '@dreambyte/motion-dsl'

const ref: MotionRef = { kind: 'preset', preset: 'fadeInUp', durationFrames: 18 }
const style = compileMotionRefToStyleAt(ref, undefined, 9)
// → { opacity: 0.75, transform: 'translate(0px, 15px) scale(1, 1) rotate(0deg)' }
```

## Why a DSL

Animation libraries optimize for handwritten code. AI agents fill flat shapes cleanly but stumble on nested timeline calls, inline easings, and cross-renderer coordination. The DSL collapses 70% of agent-written `interpolate()`/`spring()` boilerplate into a named-preset reference.

## Public surface

```ts
import {
  // Discriminated MotionRef + types
  type MotionRef,
  type MotionPreset,
  type ChoreographyStep,
  type RendererKind,
  type EasingName,
  type SpringName,

  // Catalog
  MOTION_PRESETS,
  MOTION_PRESET_IDS,
  getMotionPreset,
  listMotionPresets,

  // Springs
  SPRINGS,

  // Validation
  validateMotionRef,
  suggestPresetId,
} from '@dreambyte/motion-dsl'
```

The React style compiler lives in a subpath import so consumers only pull what they need:

```ts
import { compileMotionRefToStyleAt, emitReactMotionHelper } from '@dreambyte/motion-dsl/compiler/react'
```

## Catalog

56 presets across four categories:

- **entrance** (28): fadeInUp, fadeInDown, slideInLeft, slideInRight, zoomIn, bounceIn, rollIn, lightSpeedInLeft, jackInTheBox, …
- **exit** (14): fadeOutUp, slideOutLeft, zoomOut, hinge, rollOut, …
- **emphasis** (11): pulse, shake, swing, tada, jello, rubberBand, wobble, …
- **ambient** (3): floating, breathing, drifting

## Choreography

```ts
import type { ChoreographyStep } from '@dreambyte/motion-dsl'

const steps: ChoreographyStep[] = [
  { op: 'animate', layerId: 'logo', preset: 'fadeInUp', durationFrames: 18 },
  { op: 'wait', frames: 6 },
  {
    op: 'parallel',
    items: [
      { op: 'animate', layerId: 'h1', preset: 'slideInLeft' },
      { op: 'animate', layerId: 'h2', preset: 'slideInRight' },
    ],
  },
  { op: 'stagger', layerIds: ['c1', 'c2', 'c3'], preset: 'zoomIn', offsetFrames: 4 },
]
```

## Status

Extracted from [Dreambyte](https://dreambyte.app). Pre-1.0; breaking changes possible across minor versions.

## License

MIT. See [LICENSE](./LICENSE).
