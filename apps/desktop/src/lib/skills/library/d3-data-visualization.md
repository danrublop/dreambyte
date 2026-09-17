---
id: d3-data-visualization
type: skill
title: D3 Data Visualization
timestamp: 2026-06-17
tier: on-demand
name: D3 Data Visualization
category: data-viz
tags: [d3, chart, data, visualization, bar, line, pie, scatter, gauge, dashboard]
sceneType: d3
complexity: medium
requires: []
description: D3-powered data visualizations. Prefer the chart tool for standard charts; use raw D3 only for custom/exotic visualizations.
parameters:
  - name: chartType
    type: string
    default: bar
    description: Chart type
    enum: [bar, line, pie, donut, scatter, area, gauge, number, stacked_bar, grouped_bar]
  - name: animated
    type: boolean
    default: true
    description: Enable cinematic chart reveals
---

## D3 Scenes — PREFER the `chart` tool + structured edits

For standard charts (bar, line, pie, donut, scatter, area, gauge, number, stacked/grouped bar), use `chart` with `op:'create'` (append) and `op:'update'` / `op:'reorder'` to edit, `remove_layer` to delete. These maintain `chartLayers` and recompile DreambyteCharts — same data the user can edit manually in Layers. No raw D3 code unless necessary.

- `chart(op:'create')`: sceneId, chartType, data, config, animated, optional name, optional layout {x,y,width,height} (percent)
- `chart(op:'update')`: sceneId, chartId (from context), partial fields (data, config, layout, timing, name, chartType, animated)
- `remove_layer`: sceneId, layerId (chart layer ids work here)
- `chart(op:'reorder')`: sceneId, orderedChartIds (every chart id once, back-to-front order)
- Set `animated: true` for cinematic reveals (bars grow, lines draw, numbers count up). Requires scene duration to be set.
- Data formats: bar/line/area/scatter: [{label, value}]. stacked/grouped: [{label, values: {key: num}}]. pie/donut: [{label, value}]. number: {value, label}. gauge: {value, max}.
- Readability default (IMPORTANT): unless the user explicitly asks for a stylized/minimal look, include clear labels and accessible typography (title, x/y labels when applicable, grid, legend where useful, readable font sizes and contrast).
- If user requests camera animation for a D3 scene, call set_camera_motion with structured moves. Do NOT switch scene type to motion/three just to simulate camera.

Only use `add_layer` with layerType 'd3' for exotic/custom visualizations that don't fit any preset chart type.

## Raw D3 Usage (via add_layer)

When using raw D3:

- Use D3 v7 — NO d3.event (use event parameter in callbacks)
- Append to #chart div, NOT body
- viewBox for SVG charts to be responsive
- Use the timeline proxy pattern on window.\_\_tl (the master anime.js Timeline, seconds): `const s = { p: 0 }; window.__tl.add(s, { p: [0, 1], duration: 0.8, ease: 'outCubic', onUpdate: () => render(s.p) }, 0.5)` — preferred over d3.transition for seekability. Never call play/pause on \_\_tl
- NEVER schedule animation with setTimeout/setInterval; sequencing must be timeline positions on window.\_\_tl
