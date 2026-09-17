---
id: svg-animation
type: skill
title: SVG Vector Animation
timestamp: 2026-06-17
tier: on-demand
name: SVG Vector Animation
category: renderer
tags: [svg, vector, animation, smil, css-animation, viewbox]
sceneType: svg
complexity: simple
requires: []
description: Animated SVG scenes with CSS animations or SMIL. Best for clean vector graphics with simple motion.
parameters:
  - name: viewBox
    type: string
    default: 0 0 1920 1080
    description: SVG viewBox dimensions
---

## SVG Scenes

- Set viewBox to the project size: `viewBox={"0 0 " + WIDTH + " " + HEIGHT}` (WIDTH/HEIGHT are injected globals — default 1920×1080 but 9:16 / 1:1 / 4:5 differ; never hardcode)
- Animate with CSS animations or SMIL, not JS character-by-character text
- Use the global palette colors from world state
- Apply stroke-width from global style
- Use seeded randomness: const rand = mulberry32(SEED);

## When to Use SVG

- Clean vector illustrations with simple animations
- Logo animations, icon sequences
- Scenes where sharp scaling matters
- Simple path morphing or drawing effects

## Gotchas

- SVG animations can't be seeked accurately — avoid for timeline-critical content
- No particle systems or complex procedural art
- Large SVG DOMs (1000+ elements) cause performance issues
