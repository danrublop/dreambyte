---
id: lottie-animation
type: skill
title: Lottie Animation
timestamp: 2026-06-17
tier: on-demand
name: Lottie Animation
category: animation
tags: [lottie, bodymovin, json, vector, animation, keyframes, easing, motion-personality, quality-score]
sceneType: lottie
complexity: complex
requires: []
description: Lottie JSON animations rendered by lottie-web (bodymovin 5.12.2). For complex vector animations with precise keyframe control. Includes auto-validation, quality scoring, and motion personality system.
parameters:
  - name: frameRate
    type: number
    default: 30
    description: Animation frame rate
  - name: width
    type: number
    default: 1920
    description: Canvas width
  - name: height
    type: number
    default: 1080
    description: Canvas height
  - name: motionPersonality
    type: string
    default: corporate
    description: 'Motion personality: playful, premium, corporate, or energetic'
---

## Lottie in Dreambyte

### Three ways to use Lottie

1. **`find_media(kind:'lottie', query, count)`** (preferred for complex animations)
   - Search the curated library by visual keyword (icon, illustration, transition, loader, celebration, data-viz, character, abstract)
   - Returns URLs for pre-made professional animations
   - Use `DreambyteMotion.lottieSync()` in motion scenes or `LottieFromURL` in React scenes

2. **Generated Lottie** (simple geometric only)
   - AI generates raw Lottie JSON via `/api/generate-lottie`
   - Supports `motionPersonality` parameter (playful, premium, corporate, energetic)
   - Auto-validated: missing easing handles are fixed before render
   - Quality scored: 5-dimension analysis (visual, technical, emotional, performance, completeness)
   - Use `<LottieLayer data={json} />` in React scenes

3. **DreambyteMotion components** (no Lottie needed)
   - For text reveals, fades, counters, progress bars — use DreambyteMotion directly
   - Simpler, more reliable, better performance

### Auto-Validation Pipeline

Generated Lottie JSON passes through `validateLottieJSON()` + `scoreLottieQuality()`:

1. **Structure check**: Required fields (v, fr, ip, op, w, h, layers)
2. **Easing handle check**: Every animated keyframe (except last) must have `i`/`o` bezier handles
3. **Auto-fix**: Missing handles injected with safe corporate defaults (the #1 crash cause, now eliminated)
4. **Dimensionality check**: 1D handles for opacity/rotation, 3D for position/scale/anchor
5. **Quality score** (0-100): visual, technical, emotional, performance, completeness

### Motion Personality Integration

Call `choose_motion_style` before generating Lottie to get personality-specific easing:

```
choose_motion_style({ sceneContext: "opening hook", emotion: "excitement" })
→ { personality: "energetic", easing: { entrance: { lottie1d: {...}, lottie3d: {...} } } }
```

The generate-lottie API accepts `motionPersonality` to inject the right easing curves into the prompt.

### Lottie JSON Structure

- Canvas: w=WIDTH, h=HEIGHT, fr=30 — match the project dimensions (injected globals; default 1920×1080 but varies by aspect ratio, never hardcode)
- Keyframe easing handles (CRITICAL):
  - 1D: `"i": {"x":[0.58],"y":[1]}, "o": {"x":[0.42],"y":[0]}`
  - 3D: `"i": {"x":[0.58,0.58,0.58],"y":[1,1,1]}, "o": {"x":[0.42,0.42,0.42],"y":[0,0,0]}`
- Shape types: el (ellipse), rc (rect), sr (star), sh (bezier path), fl (fill), st (stroke), gr (group)
- Layer ty: 4 = shape layer, 1 = solid

### Narrative Structure for Generated Lotties

Distribute keyframes across three phases:

- **Setup** (0-25% of frames): Elements appear, establish positions. Use entrance easing.
- **Action** (25-65%): Primary animation. Use emphasis/personality easing.
- **Resolution** (65-100%): Settle to final state. Hold or gentle ambient.

### LottieLayer in React Scenes

lottie-web is loaded globally. Use `<LottieLayer data={json} />` for inline JSON
or build a `LottieFromURL` component for URL-based loading.

Canvas renderer available for performance: `<LottieLayer data={json} renderer="canvas" />`

### When NOT to Use Lottie

- Text animations → use `interpolate()` or `DreambyteMotion.textReveal()`
- Element reveals → use `interpolate()` + `spring()`
- Counting numbers → use `DreambyteMotion.countUp()`
- Bar charts → use `<D3Layer>` or `chart(op:'create')`
- Simple fades/slides → pure JSX animation
