/**
 * Complete tool definitions for the Dreambyte agent system.
 * These are formatted for the Claude API tool_use feature.
 */

import type { ClaudeToolDefinition } from './types'
import { ALL_TRANSITION_IDS } from '../transitions'
import { FONT_FAMILIES, FONT_PAIRING_IDS } from '../fonts/catalog'
import { INSTANTIABLE_TEMPLATE_IDS } from '../templates/built-in'
import { DREAMBYTE_CHART_TYPES } from '../charts/structured-d3'
import { CLONE_CAPABLE_PROVIDERS } from '../audio/voice-clone-providers'

// ── Scene Tools ───────────────────────────────────────────────────────────────

export const CREATE_SCENE: ClaudeToolDefinition = {
  name: 'create_scene',
  description: `Create a new scene in the project. Use this when you need to add a new scene.
After creating a scene, use add_layer or scene_props to populate it.
Returns the new scene's ID.`,
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable scene name, e.g. "Opening Hook" or "Data Overview"' },
      prompt: { type: 'string', description: 'One-sentence description of what this scene should show' },
      duration: { type: 'number', description: 'Scene duration in seconds (3–30)' },
      bgColor: { type: 'string', description: 'Background hex color, e.g. "#1a1a2e"' },
      position: { type: 'number', description: 'Index to insert at (0 = beginning). Omit to append at end.' },
    },
    required: ['name', 'prompt', 'duration'],
  },
}

export const DELETE_SCENE: ClaudeToolDefinition = {
  name: 'delete_scene',
  mutates: 'scene',
  description: 'Delete a scene from the project. This is permanent.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'ID of the scene to delete' },
    },
    required: ['sceneId'],
  },
}

export const DUPLICATE_SCENE: ClaudeToolDefinition = {
  name: 'duplicate_scene',
  description: 'Duplicate an existing scene. The copy is inserted immediately after the original.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'ID of the scene to duplicate' },
    },
    required: ['sceneId'],
  },
}

export const REORDER_SCENES: ClaudeToolDefinition = {
  name: 'reorder_scenes',
  description: 'Move a scene from one position to another in the timeline.',
  input_schema: {
    type: 'object',
    properties: {
      fromIndex: { type: 'number', description: 'Current 0-based index of the scene' },
      toIndex: { type: 'number', description: 'Target 0-based index to move it to' },
    },
    required: ['fromIndex', 'toIndex'],
  },
}

/**
 * scene_props — the scene-level property setters, one tool, one `op`.
 *
 * set_scene_duration (308b) and set_scene_background (315b) were two-field tools, but
 * the bytes were in the other two: set_transition and set_all_transitions BOTH carried
 * the whole 36-value ALL_TRANSITION_IDS enum. The union declares it once, which is the
 * entire saving — merging only the three same-file scene tools would have banked ~170b.
 *
 * Per-op required args are enforced in the handler: duration needs `duration`, background
 * needs `bgColor`, both transition ops need `transition`, and everything except
 * transition_all needs `sceneId`. An unknown op errors honestly rather than no-opping.
 *
 * op:'transition_all' dispatches to the STYLE handler, which carries the plan-fidelity
 * guard: flattening every scene to one transition when the plan deliberately
 * varies them is the "all 8 scenes → dissolve" defect, so that call is skipped and steered
 * back to op:'transition'. Both write through normalizeTransition(), so an id outside the
 * catalog degrades to 'none' — which is why the enum above must stay derived from
 * src/lib/transitions.ts and never be hand-listed.
 */
export const SCENE_PROPS: ClaudeToolDefinition = {
  name: 'scene_props',
  mutates: 'scene',
  description:
    'Set a scene-level property: its duration, its background colour, or the transition played after it (one scene, or every scene at once).',
  input_schema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['duration', 'background', 'transition', 'transition_all'],
        description: 'Which property to set. "transition_all" applies one transition to EVERY scene in the project.',
      },
      sceneId: { type: 'string', description: 'Scene ID — required for every op except transition_all.' },
      duration: { type: 'number', description: 'op:duration — playback length in seconds (3–30)' },
      bgColor: { type: 'string', description: 'op:background — hex color string, e.g. "#0d0d0d"' },
      transition: {
        type: 'string',
        enum: ALL_TRANSITION_IDS,
        description:
          'op:transition / transition_all — the effect between this scene and the next. "none" = instant cut. Prefer crossfade/dissolve for calm explainers; wipes/slides for energy.',
      },
    },
    required: ['op'],
  },
}

// ── Layer Tools ───────────────────────────────────────────────────────────────

export const ADD_LAYER: ClaudeToolDefinition = {
  name: 'add_layer',
  description: `Add a new animated layer to a scene. This generates the layer's visual content using AI.
For react (DEFAULT): generates a React component with bridge components for mixed rendering (Three.js, Canvas2D, D3, SVG, Lottie). Use for all new scenes.
For motion: generates CSS/JS choreographed animation and text-heavy explainer layouts.
For canvas2d: generates rough hand-drawn Canvas2D animation code.
For d3: generates D3.js chart/visualization.
For three: generates Three.js 3D scene with r183 ES modules — supports 3D text (troika), CSG booleans, post-processing (bloom/DOF/SSAO), PBR materials (clearcoat/iridescent/velvet/lowpoly), animated GLTF models, and 34 pre-built components. Use createStudioScene() for instant studio setup, createPostProcessing() for bloom.
For svg: generates rough hand-drawn SVG illustration.
For lottie: generates Lottie JSON animation.
For zdog: generates Zdog pseudo-3D illustration.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID to add the layer to' },
      layerType: {
        type: 'string',
        enum: ['react', 'svg', 'canvas2d', 'd3', 'three', 'motion', 'lottie', 'zdog'],
        description: 'Type of layer to generate. Default: react',
      },
      prompt: { type: 'string', description: 'Detailed description of what to generate' },
      zIndex: { type: 'number', description: 'Stack order (higher = on top). Default: 2' },
      opacity: { type: 'number', description: 'Layer opacity 0–1. Default: 1' },
      startAt: { type: 'number', description: 'Seconds into scene when layer appears. Default: 0' },
    },
    required: ['sceneId', 'layerType', 'prompt'],
  },
}

// apply_canvas_motion_template and three_data_scatter_scene were deleted in the L3
// TRANSCODER cut. Both took structured JSON and string-built scene code the model
// already writes: the first ran buildCanvasAnimationCode(templateId) to emit Canvas2D
// JS (and demoted the scene to the legacy canvas2d type on the way), the second ran
// buildThreeDataScatterSceneCode() to emit a `three` module. Neither had a single call
// across 3,153 recorded tool calls, and the knowledge each schema carried is already
// on the surface for free: the three prompt block lists every stage-env id and the
// createDreambyteDataScatterplot / updateDreambyteDataScatterplot window globals
// (prompts.ts "STAGE ENVIRONMENTS" + "SDK HELPERS"), and Canvas2DLayer is the
// documented bridge for particles and procedural art. write_scene_code is the
// most-used tool in the system — it does not need a JSON front-end.

export const CREATE_ZDOG_COMPOSED_SCENE: ClaudeToolDefinition = {
  name: 'create_zdog_composed_scene',
  description: `Create a deterministic Zdog scene from reusable assets (people, modules, beats) with zero LLM generation.
Use this when you need reliable, repeatable pseudo-3D storytelling and should avoid model API costs.
Each person is generated from a seed-driven formula and animated via preset clips.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID to update' },
      seed: { type: 'number', description: 'Global seed for deterministic person/style variation' },
      people: {
        type: 'array',
        description: 'People to place. Each entry: { id, formula?, placement:{x,y,z,scale?,rotationY?} }',
        items: { type: 'object' },
      },
      modules: {
        type: 'array',
        description: 'Reusable scene modules: barChart, lineChart, donutChart, presentationBoard, desk, tablet',
        items: { type: 'object' },
      },
      beats: {
        type: 'array',
        description: 'Animation beats. Each: { at, action, targetPersonId, duration? }',
        items: { type: 'object' },
      },
      title: { type: 'string', description: 'Optional scene title metadata' },
    },
    required: ['sceneId', 'seed', 'people', 'modules', 'beats'],
  },
}

/**
 * save_zdog_asset — the two Zdog library WRITERS, one tool, one `kind`.
 *
 * They write the same project library from different sides: a person FORMULA vs a
 * shape ASSEMBLY. The READER already returns both (list_zdog_person_assets), so the
 * split existed only on the write path.
 */
export const SAVE_ZDOG_ASSET: ClaudeToolDefinition = {
  name: 'save_zdog_asset',
  description: `Save a reusable Zdog asset to the project library for later use in composed scenes. list_zdog_person_assets lists both kinds back.

kind:'person' — a person FORMULA (pass \`formula\`, a full ZdogPersonFormula object).
kind:'shapes' — a shape ASSEMBLY (character, item, prop, icon): pass \`shapes\`, a parent-child hierarchy via parentId. Each shape has a type (Ellipse, Rect, RoundedRect, Polygon, Shape, Anchor, Group, Box, Cylinder, Cone, Hemisphere), properties (stroke, color, fill, diameter, width, height, depth, …) and transforms (translate, rotate, scale).
  Common patterns — person rig: hips (Shape) → spine (Anchor) → chest (Shape) → head (Shape) + arms + legs. Props: Box/Cylinder combos. Icons: Ellipse/Shape combos.
  Zdog coordinates: x=right, y=DOWN, z=toward camera. Use stroke for rounded depth; Anchor/Group for invisible grouping nodes.`,
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['person', 'shapes'],
        description: "'person' saves a formula, 'shapes' saves a shape assembly.",
      },
      name: { type: 'string', description: 'Asset name, e.g. "Presenter Base A", "Office Chair", "Laptop"' },
      formula: { type: 'object', description: "kind:'person' — full ZdogPersonFormula object." },
      shapes: {
        type: 'array',
        description: "kind:'shapes' — array of ZdogStudioShape objects defining the hierarchy.",
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique shape identifier' },
            type: {
              type: 'string',
              enum: [
                'Ellipse',
                'Rect',
                'RoundedRect',
                'Polygon',
                'Shape',
                'Anchor',
                'Group',
                'Box',
                'Cylinder',
                'Cone',
                'Hemisphere',
              ],
            },
            parentId: { type: 'string', description: 'Parent shape ID (omit for root shapes)' },
            name: { type: 'string', description: 'Human-readable shape name' },
            properties: {
              type: 'object',
              description:
                'Shape properties: stroke, color, fill, diameter, width, height, depth, length, cornerRadius, sides, radius, quarters, closed, visible, backface, frontFace/rearFace/leftFace/rightFace/topFace/bottomFace (Box), path (Shape)',
            },
            transforms: {
              type: 'object',
              description: '{ translate: {x,y,z}, rotate: {x,y,z}, scale: number|{x,y,z} }',
              properties: {
                translate: { type: 'object' },
                rotate: { type: 'object' },
                scale: { type: 'number', description: 'Uniform number or {x,y,z} vector' },
              },
            },
          },
          required: ['id', 'type', 'name', 'properties', 'transforms'],
        },
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
    },
    required: ['kind', 'name'],
  },
}

export const LIST_ZDOG_PERSON_ASSETS: ClaudeToolDefinition = {
  name: 'list_zdog_person_assets',
  description: 'List saved reusable Zdog person assets in the project library.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
}

// build_zdog_asset merged into save_zdog_asset(kind:'shapes') — see SAVE_ZDOG_ASSET.

/**
 * chart — the D3 chart-layer authoring surface, one tool, one `op`.
 *
 * NOT AI generation despite the old `generate_chart` name: this is structured
 * chart-layer authoring (data + config → recompiled D3 scene code), so it is a
 * verb-split like any other. create/update shared most of their properties —
 * chartType, data, config, layout, animated, name were all declared twice.
 *
 * remove_chart was already deleted (remove_layer carries a D3 chart-layer branch on
 * the same ids). reorder stays because reorder_layer only z-indexes ONE svgObject.
 */
export const CHART: ClaudeToolDefinition = {
  name: 'chart',
  mutates: 'scene',
  description: `Author a D3 chart layer on a scene. Much faster and more consistent than hand-writing D3 via add_layer — fall back to add_layer(layerType:'d3') only for exotic visualizations no preset fits.

op:'create' (default) — append a chart to the scene (multi-chart scenes are supported) and recompile the scene's D3 code. Needs chartType + data.
op:'update' — edit an existing chart by chartId (from chartLayers in context). Merges config; can replace data, layout, timing, chartType or name. Prefer this over raw code patches.
op:'reorder' — set draw order when charts overlap (first id = back, last = front). Must list every chart id exactly once.

Static by default: the chart renders at its final state immediately. animated:true starts it invisible and adds a cinematic reveal to the scene's master timeline (title fades in, axes appear, bars grow / lines draw / pies sweep, labels count up) — requires the scene to have a duration.`,
  input_schema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['create', 'update', 'reorder'],
        description: "Which operation. Default 'create'.",
      },
      sceneId: { type: 'string', description: 'Scene ID. Required for every op.' },
      chartId: { type: 'string', description: "op:'update' — layer id from chartLayers." },
      chartType: {
        type: 'string',
        enum: [...DREAMBYTE_CHART_TYPES],
        description: "Chart type preset. Required for op:'create'.",
      },
      data: {
        anyOf: [{ type: 'array', items: { type: 'object' } }, { type: 'object' }],
        description:
          'Chart data: array for most DreambyteCharts; object for number/gauge; funnel uses [{label,value}]; plotly uses { traces: [...] }; recharts uses [{label,value}] (or custom keys via config.categoryKey / valueKey) for bar|line|area (config.rechartsVariant).',
      } as import('./types').ClaudePropertySchema,
      config: {
        type: 'object',
        description:
          'Chart configuration (op:update MERGES it): title, subtitle, xLabel, yLabel, valueFormat, colors (array), theme ("dark"|"light"), textColor, axisColor, gridColor, titleColor, tickLabelColor, axisLabelColor, legendTextColor, valueLabelColor, useSceneAxisColors (bool), barStroke, barStrokeWidth. For plotly: plotlyLayout and plotlyConfig. For recharts: rechartsVariant ("bar"|"line"|"area"), categoryKey, valueKey, showGrid, colors.',
      },
      animated: {
        type: 'boolean',
        description:
          'true = animate onto the scene master timeline with a cinematic reveal (needs a scene duration). false (default) = render at final state.',
      },
      name: { type: 'string', description: 'Display name for this chart in the layer stack (optional).' },
      layout: {
        type: 'object',
        description:
          'Position in percent of the #chart area: x, y, width, height (0–100). Optional; defaults to full-area, or an auto-grid when several charts share the scene.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
      timing: {
        type: 'object',
        description: "op:'update' — when the chart plays.",
        properties: {
          startAt: { type: 'number' },
          duration: { type: 'number' },
        },
      },
      orderedChartIds: {
        type: 'array',
        items: { type: 'string' },
        description: "op:'reorder' — the full ordered list of chart layer ids.",
      },
    },
    required: ['sceneId'],
  },
}

export const REMOVE_LAYER: ClaudeToolDefinition = {
  name: 'remove_layer',
  mutates: 'scene',
  description: 'Remove a layer from a scene.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      layerId: { type: 'string', description: 'Layer/object ID to remove' },
    },
    required: ['sceneId', 'layerId'],
  },
}

export const REORDER_LAYER: ClaudeToolDefinition = {
  name: 'reorder_layer',
  description: 'Change the z-index (stacking order) of a layer within a scene.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      layerId: { type: 'string', description: 'Layer ID' },
      zIndex: { type: 'number', description: 'New z-index value' },
    },
    required: ['sceneId', 'layerId', 'zIndex'],
  },
}

export const REGENERATE_LAYER: ClaudeToolDefinition = {
  name: 'regenerate_layer',
  description:
    'Completely regenerate a layer with a new or updated prompt. Works for SVG objects, D3 chart scenes, ' +
    'AI image/sticker layers (regenerated in place from their provenance — geometry, timing and z-order are ' +
    'preserved), and whole code scenes (pass layerId === sceneId). An unknown layerId errors — it never ' +
    'falls through to regenerating the whole scene. Use when the user wants to redo a layer from scratch.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      layerId: {
        type: 'string',
        description: 'Layer ID to regenerate. For a whole code scene, pass the sceneId here.',
      },
      prompt: {
        type: 'string',
        description:
          'New prompt for generation. Can be same or updated. For AI image/sticker layers, omit to reuse the stored provenance prompt.',
      },
      params: {
        type: 'object',
        description:
          'Optional AI-layer overrides (image/sticker only): model, aspectRatio, style, referenceImageUrl. Ignored for code/SVG/D3 layers.',
        properties: {
          model: { type: 'string', description: 'Override the image model (e.g. flux-1.1-pro).' },
          aspectRatio: { type: 'string', description: 'Override aspect ratio (e.g. 16:9).' },
          style: { type: 'string', description: 'Override image style.' },
          referenceImageUrl: { type: 'string', description: 'Reference image URL for i2i regeneration.' },
        },
      },
    },
    required: ['sceneId', 'layerId', 'prompt'],
  },
}

export const PATCH_LAYER_CODE: ClaudeToolDefinition = {
  name: 'patch_layer_code',
  mutates: 'scene',
  description: `Make a surgical code edit to an existing layer's code (SVG markup, Canvas JS, D3 JS, Three.js, etc.).
Finds oldCode as an exact substring in the layer's code and replaces with newCode.
Use for targeted fixes: color changes, timing adjustments, removing unwanted animations.
IMPORTANT: oldCode must be an exact match — copy it precisely from the world state.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      layerId: { type: 'string', description: 'Layer/object ID whose code to patch' },
      oldCode: { type: 'string', description: 'Exact substring to find and replace' },
      newCode: { type: 'string', description: 'Replacement code' },
    },
    required: ['sceneId', 'layerId', 'oldCode', 'newCode'],
  },
}

// migrate_to_react was deleted in the L3 TRANSCODER cut: its whole job was
// wrapSceneAsReact(scene) — take the scene's existing code and paste it inside a
// React shell with the matching bridge component. That is a string transform on code
// the model can already read (read_scene_code) and rewrite (write_scene_code), and
// no scene it could target can still be created: write_scene_code's sceneType enum is
// ['react'] and plan_scenes is react-only, so the only inputs were pre-existing legacy
// scenes. Zero calls across 3,153 recorded tool calls.

export const WRITE_SCENE_CODE: ClaudeToolDefinition = {
  name: 'write_scene_code',
  mutates: 'scene',
  description: `Directly set a scene's code without triggering AI generation. Use this when you already know the exact code to write — skips the extra LLM generation call that add_layer uses.

Pass raw JSX as sceneCode for React scenes. For other scene types, pass the appropriate code format.
If sceneId is omitted, creates a new scene. If provided, replaces the existing scene's code.

This is faster and cheaper than add_layer when you've already reasoned about the code.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID to update. Omit to create a new scene.' },
      sceneCode: { type: 'string', description: 'Raw scene code (JSX for React, JS for Canvas2D, etc.)' },
      styles: { type: 'string', description: 'Optional CSS styles (no <style> tags).' },
      name: { type: 'string', description: 'Scene name (for new scenes).' },
      duration: { type: 'number', description: 'Duration in seconds (default 8).' },
      bgColor: { type: 'string', description: 'Background color hex (default "#0a0c10").' },
      sceneType: {
        type: 'string',
        enum: ['react'],
        description: "Always 'react'. Compose other renderers via bridge layers inside the JSX.",
      },
    },
    required: ['sceneCode'],
  },
}

/**
 * inspect — the four read-only introspection tools, one tool, one `kind`.
 *
 * describe_scene_state / read_scene_code / read_editor_state / list_snapshots were
 * four separate tools whose descriptions spent most of their bytes telling the model
 * which of the OTHER three to use instead ("PREFER THIS over read_scene_code…",
 * "For STRUCTURAL questions use describe_scene_state instead…"). One tool with a
 * `kind` turns that cross-referencing prose into a four-value enum the model picks
 * from directly. Every kind maps back to its original handler.
 */
export const INSPECT: ClaudeToolDefinition = {
  name: 'inspect',
  description: `Read-only introspection. Nothing here mutates anything.

kind:'scene' (default) — cheap STRUCTURAL summary without code bodies: layer inventory (renderers + code size, text overlays, SVG objects, AI layers, chart/physics/interaction/camera counts, video/audio presence, hidden layers, stacking order). With sceneId: that scene. Without: every scene plus { sceneCount, totalDurationSec }. Use this for "what layers exist?", "what's the stacking order?", "how long is the video so far?".
kind:'code' — the FULL source of a scene's layers (reactCode, svgContent, canvasCode, sceneCode, lottieSource, SVG objects and AI layers). Requires sceneId. Often tens of KB — only take it when you intend to edit code (then patch with patch_layer_code).
kind:'editor' — the user's live editor state: { selectedSceneId, selectedClipIds, currentTime, isPlaying, totalDuration, timelineZoom, capturedAt }. Call this whenever the user says "this", "the current", "the selected clip", or any reference that depends on what they're looking at. Snapshot is taken at run start — a hint, not absolute truth.
kind:'snapshots' — the run's NAMED checkpoints, created automatically before destructive operations (delete_scene, remove_layer, remove_track, clip(op:'remove'), element(op:'delete')). Returns { checkpoints: [{ id, label, timestamp, sceneCount }] }. Feed an id to rollback_to_snapshot to undo without rebuilding.`,
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['scene', 'code', 'editor', 'snapshots'],
        description: "What to read. Default 'scene' (the cheap structural summary).",
      },
      sceneId: {
        type: 'string',
        description:
          "kind:'code' — required, the scene to read. kind:'scene' — optional; omit for a project-wide summary.",
      },
    },
    required: [],
  },
}

export const ROLLBACK_TO_SNAPSHOT: ClaudeToolDefinition = {
  name: 'rollback_to_snapshot',
  // mutates: it replaces scenes + globalStyle wholesale — without this tag the
  // destructive-preview approval gate would not pause it.
  mutates: 'project',
  description: `Restore the project to a checkpoint — undo a destructive mistake or a failed experiment in one call instead of rebuilding. With checkpointId (from inspect kind:'snapshots'): restores that named checkpoint. Without it: restores the most recent named checkpoint, or — if none exist yet — the state before the last tool call.

Restores scenes and globalStyle wholesale. AI layers restore BY VALUE: existing asset URLs come back as-is; nothing is regenerated and no generation cost is incurred.`,
  input_schema: {
    type: 'object',
    properties: {
      checkpointId: {
        type: 'string',
        description:
          "Checkpoint id from inspect(kind:'snapshots'). Omit to roll back to the most recent checkpoint (or the state before the last tool call if no checkpoints exist).",
      },
    },
    required: [],
  },
}

export const SEND_FEEDBACK: ClaudeToolDefinition = {
  name: 'send_feedback',
  description: `Report a shortcoming in your own toolset so the Dreambyte team can fix it. Use it ONCE per problem, when the request is blocked because a tool does not exist, fails, or hands back output that is obviously incorrect. It is also fine to use after finishing a task if you had to work around something and can name a specific improvement (for example a parameter that should exist).

Context such as your recent tool calls, the latest error, the app version and the project is attached for you, so leave it out. Write a PARAPHRASE of the problem in your own words and never copy the user's text into it. Do not use it for ordinary design decisions, for questions you asked the user, or for a problem already reported in this session. After calling it, tell the user in a short clause that you reported it and move on. Only a handful of reports are accepted per session.`,
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['missing_capability', 'wrong_result', 'confusing_ux', 'failure', 'suggestion'],
        description:
          'missing_capability: you needed a tool or option that is not available. wrong_result: the tool succeeded but its output was plainly incorrect. confusing_ux: a tool behaved in a surprising or hard-to-use way. failure: a tool call errored out. suggestion: a specific improvement, even though the task got done.',
      },
      summary: {
        type: 'string',
        description:
          'A single short line in your own words that names the problem; used as the report title. Do not quote the user.',
      },
      details: {
        type: 'string',
        description:
          'Optional extra context in one or two sentences, such as what you attempted and what you expected instead. Keep it in your own words.',
      },
      severity: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Optional: how much the problem got in the way.',
      },
    },
    required: ['category', 'summary'],
  },
}

// read_scene_code → inspect(kind:'code'); read_editor_state → inspect(kind:'editor').
// Both handler cases are unchanged; only the model-facing names moved (see INSPECT).

export const ANALYZE_REFERENCE_MEDIA: ClaudeToolDefinition = {
  name: 'analyze_reference_media',
  description: `Re-analyze one piece of reference media the user attached to this prompt, in detail.

An up-front understanding brief is already injected at the top of the conversation. Call this when you need MORE than the summary about a specific attachment — e.g. the exact text in an image, its color palette, the full transcript of an audio clip, or the timed events in a reference video. Pass the media id shown in the brief.

Returns: { analysis: { kind, caption, ocrText, palette, transcript, audioTags, events, backend }, summary, modelsUsed, styleTokens }. Fields are populated best-effort per media kind; missing fields mean that engine didn't produce them. \`styleTokens\` is a structured { palette, fonts, mood, lighting, composition, subjects } distillation of the visual style — pass these into design_brief (referenceTokens) to seed a matching design brief, or rely on them being applied automatically by generate_image(source:'reference').`,
  input_schema: {
    type: 'object',
    properties: {
      mediaId: { type: 'string', description: 'The reference media id (as listed in the understanding brief).' },
    },
    required: ['mediaId'],
  },
}

// ── Element Tools ─────────────────────────────────────────────────────────────

/**
 * element — add / edit / delete a text overlay, one tool, one `op`.
 *
 * add_element and edit_element declared the SAME ten overlay fields twice (that is
 * where the bytes were), and delete_element was a 311b tool for `{sceneId, elementId}`.
 * The union declares each field once.
 *
 * edit already absorbed move_element (x/y), resize_element (size), reorder_element
 * (zIndex) and adjust_element_timing (delay/duration) in an earlier pass — the handler
 * applies `{ ...overlay, ...updates }` generically, so those needed a schema entry, not
 * code. Those four names remain dispatch-only (no schema, never offered).
 *
 * Per-op required args are enforced in the handler (they were three `required` blocks
 * before): add needs content + x + y, edit/delete need elementId. An unknown op errors
 * honestly rather than no-opping.
 */
export const ELEMENT: ClaudeToolDefinition = {
  name: 'element',
  mutates: 'scene',
  description: `Add, edit, or delete a text overlay element on a scene.
op:'add' creates one. op:'edit' changes ONLY the fields you pass on an existing element — pass as many as you like in one call. op:'delete' removes it.`,
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'edit', 'delete'], description: 'What to do with the overlay.' },
      sceneId: { type: 'string', description: 'Scene ID' },
      elementId: { type: 'string', description: 'edit / delete — the text overlay ID' },
      content: { type: 'string', description: 'Text content to display' },
      font: { type: 'string', description: 'Font family, e.g. "Caveat", "Sora", "Bitter"' },
      size: { type: 'number', description: 'Font size in pixels (24–180). Nothing below 24px in video.' },
      color: { type: 'string', description: 'Text hex color' },
      x: { type: 'number', description: 'Horizontal position as % of canvas width (0–100)' },
      y: { type: 'number', description: 'Vertical position as % of canvas height (0–100)' },
      zIndex: { type: 'number', description: 'edit — stack order' },
      animation: {
        type: 'string',
        enum: ['fade-in', 'slide-up', 'none'],
        description: 'Entrance animation. Default: "fade-in"',
      },
      duration: { type: 'number', description: 'Animation duration in seconds. Default: 0.6' },
      delay: { type: 'number', description: 'Delay before animation starts (seconds). Default: 0' },
    },
    required: ['op', 'sceneId'],
  },
}

// ── Research Tools (web search, URL reader) ──────────────────────────────────
// Gated by the Web Search / Web Fetch switches. set_research_mode flips those
// gates under an explicit per-session grant (in-app approval card, or the MCP
// client's own tool-permission prompt) — so the gates are no longer only a
// manual UI toggle.

export const WEB_SEARCH: ClaudeToolDefinition = {
  name: 'web_search',
  description: `Search the web for information. Use this when the scene needs real-world facts,
current events, product specs, brand details, or any topic outside your training data.
Returns titles, URLs, snippets, and source domains. Follow up with fetch_url_content
on the most promising results to get full article text before writing scene copy.`,
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Be specific: "Tesla Model Y 0-60 specs 2026" not just "tesla"',
      },
      count: { type: 'number', description: 'Number of results (1–10). Default: 5' },
      recency: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year', 'any'],
        description: 'Freshness filter. Use "week" or "month" for current events. Default: "any"',
      },
      site: { type: 'string', description: 'Optional: restrict to a single domain, e.g. "wikipedia.org"' },
    },
    required: ['query'],
  },
}

/**
 * Approval proxy injected by the context-builder only when Web Search is ON, Auto-Accept is OFF,
 * and the user hasn't approved search this session yet. Calling it pauses the run for a one-time
 * approval card; on approval the real native web_search is injected and this proxy disappears.
 * Lives in ALL_TOOLS (so executeTool recognizes it as canonical) but is NOT in any AGENT_TOOLS
 * list — it is only ever added dynamically. Name kept in sync with REQUEST_WEB_SEARCH_TOOL_NAME
 * in tool-handlers/research-tools.ts (kept a literal here to avoid an import cycle).
 */
export const REQUEST_WEB_SEARCH: ClaudeToolDefinition = {
  name: 'request_web_search',
  description:
    'Ask the user for permission to search the web (required once per session because Auto-Accept Web Search is off). Call this when the task needs current or external web information. After the user approves, the real web_search tool becomes available on your next turn.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'One short sentence on why web search is needed.' },
    },
    required: [],
  },
}

export const SET_RESEARCH_MODE: ClaudeToolDefinition = {
  name: 'set_research_mode',
  description:
    'Enable or disable Research mode (Web Search / Web Fetch gates) for this session. Call this when a research tool (find_media, fetch_url_content) reported that Web Search or Web Fetch is off and the task needs it. Enabling requires a one-time user grant: in-app this surfaces an approval card; on the MCP path the grant is the permission prompt you already passed to call this tool. Disabling is always allowed.',
  input_schema: {
    type: 'object',
    properties: {
      webSearch: {
        type: 'boolean',
        description: 'Enable/disable the Web Search gate (stock + archival media search).',
      },
      webFetch: {
        type: 'boolean',
        description: 'Enable/disable the Web Fetch gate (fetch_url_content, fetch_video_from_url).',
      },
      reason: { type: 'string', description: 'One short sentence on why research access is needed (audit trail).' },
    },
    required: [],
  },
}

export const FETCH_URL_CONTENT: ClaudeToolDefinition = {
  name: 'fetch_url_content',
  description: `Fetch and extract readable content from a URL. Returns title, description,
publish date, author, cleaned body text, images, and embedded videos (YouTube, Vimeo, inline <video>).
Use after web_search to get full article text, or directly on a URL the user provides.
Use extract="metadata" for a fast metadata-only fetch when you just need title + og:image + videos.`,
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL to fetch' },
      extract: {
        type: 'string',
        enum: ['article', 'full', 'metadata'],
        description:
          '"article" = readable body text (default). "metadata" = title + og tags only. "full" = full cleaned HTML text.',
      },
    },
    required: ['url'],
  },
}

/**
 * find_media — the three real-media discovery tools, one tool, one `kind`.
 *
 * find_stock_videos / find_stock_images / find_archival_footage each re-declared `query`
 * and `count`, and two of them re-declared the `orientation` enum and `minWidth`. They
 * also repeated the same "returns urls + thumbnail + attribution + license" preamble
 * three times. The union declares each once.
 *
 * The RESULT is discriminated, not shared: each kind returns its own provider shape
 * (stock video → multi-resolution MP4s; stock image → dimensions + author; archival →
 * mediaUrl + mediaType + date), and src/lib/research/harvest.ts already switches on the op
 * to read them. That switch is unchanged — the handler maps `kind` back to the original
 * op name, so every downstream reader keeps its shape.
 *
 * The "ONE broad search" line is deliberate (without it builds fire many
 * near-identical archival queries), so it must stay in the description.
 */
export const FIND_MEDIA: ClaudeToolDefinition = {
  name: 'find_media',
  description: `Find media to drop into a scene — the ONE asset-discovery lookup. Returns direct urls, thumbnails, dimensions/durations, attribution and license. Available even with the Web Search switch off — these are provider APIs and curated local libraries, not live web.
kind:'video' — stock clips (Pexels, Pixabay), free for commercial use. Pass the highest-resolution MP4 url to set_media_layer(kind:'video') to drop it into a scene.
kind:'image' — stock photography (Unsplash, Openverse). Prefer over AI imagery when the subject is recognizable (a brand, a celebrity, a landmark) or photorealism matters. Place the returned url with place_image / use_asset_in_scene.
kind:'archival' — historical and public-domain material, fanned out across Internet Archive + NASA + Wikimedia in parallel. Each item carries mediaUrl, mediaType ('image' | 'video' | 'audio') and a date. For moon landings, old newsreels, scientific imagery — real history, never faked with generation.
kind:'3d' — the curated CC0 GLB model library for Three.js scenes. Returns id, name, category, tags, description, scale and a ready-to-load GLTFLoader url. Omit query to list a whole category. CC0: commercial use, no attribution.
kind:'lottie' — pre-made LottieFiles animations: a checkmark, rocket, spinner, lock, celebration — polished illustration/icon work that would take hours by hand. Returns urls ready for DreambyteMotion.lottieSync() or LottieFromURL. Do NOT use it for text animation, element reveals, counting numbers or bar charts — DreambyteMotion does those.
Make ONE broad search (ask for 12+ results) and pick from it — do NOT fire many near-identical queries for the same subject; that is slow and returns the same material.`,
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['video', 'image', 'archival', '3d', 'lottie'],
        description: 'Which library to search.',
      },
      query: {
        type: 'string',
        description:
          'Visual keyword. Be concrete: "ocean waves sunset", "tesla model y red", "apollo 11 moon landing", "laptop", "checkmark success green".',
      },
      count: {
        type: 'number',
        description: 'Number of results (1–30). Default 12 — ask for 12+ so one search is enough.',
      },
      category: {
        type: 'string',
        enum: [
          'tech',
          'business',
          'abstract',
          'people',
          'transport',
          'environment',
          'data',
          'icon',
          'illustration',
          'transition',
          'loader',
          'celebration',
          'data-viz',
          'character',
        ],
        description:
          '3d — tech | business | abstract | people | transport | environment | data. lottie — icon | illustration | transition | loader | celebration | data-viz | character | abstract.',
      },
      orientation: {
        type: 'string',
        enum: ['landscape', 'portrait', 'square'],
        description: 'video / image — filter by orientation. Match the project aspect ratio.',
      },
      minWidth: { type: 'number', description: 'video / image — minimum width in pixels. 1920 for HD.' },
      minDurationSec: { type: 'number', description: 'video — minimum clip duration in seconds' },
      maxDurationSec: {
        type: 'number',
        description: 'video — maximum clip duration. Keep under 15s for scene-length clips.',
      },
      source: {
        type: 'string',
        enum: ['pexels', 'pixabay'],
        description: 'video — override provider selection. Omit to use configured preference (Pexels first).',
      },
      mediaType: {
        type: 'string',
        enum: ['image', 'video', 'audio', 'any'],
        description: 'archival — filter by media type. Default: video.',
      },
      yearFrom: { type: 'number', description: 'archival — earliest publication year (Archive.org and NASA).' },
      yearTo: { type: 'number', description: 'archival — latest publication year.' },
    },
    required: ['kind', 'query'],
  },
}

export const FETCH_VIDEO_FROM_URL: ClaudeToolDefinition = {
  name: 'fetch_video_from_url',
  description: `Download a video from an arbitrary URL (YouTube, Vimeo, TikTok, Twitter/X, 1000+ sites supported via yt-dlp) into the project's media library.
Two-step flow:
  (a) Call without formatId — returns available formats/resolutions/filesizes + a recommended format. Present these to the user.
  (b) Call again with the chosen formatId — downloads and registers the asset.
Content is subject to the source site's terms; usage is the user's responsibility. Max duration 600s, max file 200MB.
Returns { mode: "probe" | "download", ... }. After download, the returned asset.id is usable with set_media_layer / place_clip.
This tool requires the user to have accepted the yt-dlp legal disclaimer once per project.`,
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL of the video page (not a direct file URL).' },
      formatId: {
        type: 'string',
        description: 'Omit to probe formats. Pass a formatId from a prior probe response to actually download.',
      },
    },
    required: ['url'],
  },
}

export const RESEARCH_TOOLS: ClaudeToolDefinition[] = [
  WEB_SEARCH,
  SET_RESEARCH_MODE,
  FETCH_URL_CONTENT,
  FIND_MEDIA,
  FETCH_VIDEO_FROM_URL,
]

// ── Asset / Media Tools ───────────────────────────────────────────────────────

// search_images was REMOVED as a strictly-worse duplicate of find_media(kind:'image').
// Both ended at unsplashImageSearch, but search_images called it directly — no cache,
// no provider fallback, and it required an Unsplash key — while find_media goes
// through runStockImageSearch, which adds a result cache, orientation/minWidth filters,
// richer returns (dimensions, thumbnail, attribution, license) and a keyless $0 floor
// (SearXNG → Openverse) that works with no key configured at all. Offering both gave
// the model a coin-flip between a good path and a worse one for the same job.

export const PLACE_IMAGE: ClaudeToolDefinition = {
  name: 'place_image',
  description: 'Place a stock photo or uploaded image into a scene as an image layer.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      imageUrl: { type: 'string', description: 'URL of the image to place' },
      x: { type: 'number', description: 'Left position in pixels (0–1920)' },
      y: { type: 'number', description: 'Top position in pixels (0–1080)' },
      width: { type: 'number', description: 'Width in pixels' },
      height: { type: 'number', description: 'Height in pixels' },
      opacity: { type: 'number', description: 'Opacity 0–1. Default: 1' },
      zIndex: { type: 'number', description: 'Stack order. Default: 1' },
    },
    required: ['sceneId', 'imageUrl', 'x', 'y', 'width', 'height'],
  },
}

// ── AI Layer Editing Tools ───────────────────────────────────────────────────

// animate_ai_layer (deprecated since the motion DSL landed) was DELETED in the
// Removed: superseded by animate_layer's preset DSL, never
// offered to scene-maker, zero recorded usage. Replayed calls fail soft via
// tool-executor's unknown-tool error result.

// The three AI-layer setters are folded into SET_LAYER_PROPS (transform / filter /
// crop); their names stay live as INTERNAL_ONLY_TOOL_NAMES ops that set_layer_props'
// executor delegates to. AI_LAYER_TOOLS itself was an empty array still being spread
// into ALL_TOOLS and AGENT_TOOLS['scene-maker'] — deleted.

/**
 * set_layer_props — the single layer-property editor.
 *
 * Replaces seven one-verb setters that all took the same (sceneId, layerId) and
 * differed only in which field they wrote: set_layer_opacity, set_layer_visibility,
 * set_layer_timing, set_layer_grade, set_layer_filter, crop_image_layer and
 * update_ai_layer. Offering all seven cost 5,660 bytes of schema every turn and, worse,
 * cost TURNS: nudging one image and fading it was two round-trips, and restyling four
 * layers was eight.
 *
 * Shaped as a batch array rather than a discriminator router: an `entries[]`/`moves[]`
 * list is easier for the model to fill than an `action:` switch. Batching wins tokens
 * AND undo granularity: one call is one transaction.
 *
 * The seven original names remain live INTERNAL ops. This tool's executor decomposes each
 * update into those existing handler cases rather than reimplementing them, so every
 * validation, clamp and regenerate-HTML path is byte-identical to before.
 */
export const SET_LAYER_PROPS: ClaudeToolDefinition = {
  name: 'set_layer_props',
  mutates: 'scene',
  description: `Set any combination of properties on one or more layers in a scene, in a single call.

Batch freely — pass every layer you want to change in \`updates\`, and every property you want to change on each. Only the fields you include are touched. Prefer one batched call over several single-property ones.

Property groups (all optional, mix as needed):
- opacity / visible / startAt — basic layer state, any layer type
- transform — move/resize/rotate/restack an AI layer (image, sticker, avatar, veo3)
- filter — CSS filter string on an AI layer, e.g. "blur(3px) brightness(1.1)", or "none" to clear
- crop — show only part of an image/sticker layer
- grade / resetGrade — the colour-correction stack on a video or AI image layer. MERGES into the existing grade. Omit layerId (or pass "video") to grade the scene's video footage. For a quick named look on a timeline CLIP use apply_color's \`look\` instead.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      updates: {
        type: 'array',
        description: 'One entry per layer. Batch every layer you are changing into a single call.',
        items: {
          type: 'object',
          properties: {
            layerId: {
              type: 'string',
              description: "Layer ID. For `grade` only, omit or pass 'video' to target the scene's video footage.",
            },
            opacity: { type: 'number', description: 'Opacity 0–1' },
            visible: { type: 'boolean', description: 'Whether the layer renders' },
            startAt: { type: 'number', description: 'Seconds into the scene when the layer becomes visible' },
            filter: {
              type: 'string',
              description:
                'CSS filter string on an AI layer: blur(Npx), brightness(N), contrast(N), grayscale(N), saturate(N), sepia(N), hue-rotate(Ndeg), invert(N), opacity(N), drop-shadow(x y blur color). "none" clears.',
            },
            transform: {
              type: 'object',
              description: 'Geometry of an AI layer (image, sticker, avatar, veo3). Only the fields you pass change.',
              properties: {
                x: { type: 'number', description: 'Center X position (0–1920)' },
                y: { type: 'number', description: 'Center Y position (0–1080)' },
                width: { type: 'number', description: 'Width in pixels' },
                height: { type: 'number', description: 'Height in pixels' },
                rotation: { type: 'number', description: 'Rotation in degrees (0–360)' },
                zIndex: { type: 'number', description: 'Stack order' },
                label: { type: 'string', description: 'Display label' },
              },
            },
            crop: {
              type: 'object',
              description: 'Crop an image/sticker layer to a visible region (CSS object-position semantics).',
              properties: {
                x: { type: 'number', description: 'Horizontal offset percent 0–100 (0 left, 50 center, 100 right)' },
                y: { type: 'number', description: 'Vertical offset percent 0–100 (0 top, 50 center, 100 bottom)' },
                width: { type: 'number', description: 'Visible width of the container in pixels' },
                height: { type: 'number', description: 'Visible height of the container in pixels' },
              },
              required: ['width', 'height'],
            },
            resetGrade: { type: 'boolean', description: 'Clear this layer’s grade entirely (ignores `grade`)' },
            grade: {
              type: 'object',
              description: 'Correction-stack fields to MERGE in. All optional. Scalars are neutral at 0.',
              properties: {
                exposure: { type: 'number', description: '-1..1 (brighter +)' },
                contrast: { type: 'number', description: '-1..1' },
                saturation: { type: 'number', description: '-1..1 (-1 grayscale, +1 = 2x)' },
                temperature: { type: 'number', description: '-1..1 (warm +, cool -)' },
                tint: { type: 'number', description: '-1..1 (magenta +, green -)' },
                hue: { type: 'number', description: 'degrees -180..180' },
                vignette: { type: 'number', description: '0..1' },
                sharpen: { type: 'number', description: '0..1' },
                lift: { type: 'object', description: 'Shadows wheel {r,g,b,master}, each -1..1' },
                gamma: { type: 'object', description: 'Midtones wheel {r,g,b,master}, each -1..1' },
                gain: { type: 'object', description: 'Highlights wheel {r,g,b,master}, each -1..1' },
                curves: {
                  type: 'object',
                  description: 'Per-channel tone curves: { rgb?, r?, g?, b? } each an array of {x,y} points in 0..1',
                },
              },
            },
          },
        },
      },
    },
    required: ['sceneId', 'updates'],
  },
}

/**
 * set_media_layer — the scene's two media layers, one tool, one `kind`.
 *
 * set_audio_layer / set_video_layer were the same handler with the same (sceneId, src)
 * head and a different tail. Kept as one gate-per-kind in filterToolsForAgent so the
 * 'audio' / 'video' category chips still mean what they meant.
 */
export const SET_MEDIA_LAYER: ClaudeToolDefinition = {
  name: 'set_media_layer',
  mutates: 'scene',
  description: `Configure a scene's background media layer. kind:'video' = the background video clip; kind:'audio' = the scene's audio bed (music or narration). Pass src:null to clear the layer.`,
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['video', 'audio'], description: 'Which layer to configure.' },
      sceneId: { type: 'string', description: 'Scene ID' },
      src: { type: 'string', description: 'Media file URL, or null to clear the layer.' },
      volume: { type: 'number', description: "kind:'audio' — volume 0–1. Default 1." },
      fadeIn: { type: 'boolean', description: "kind:'audio' — fade in at start. Default false." },
      fadeOut: { type: 'boolean', description: "kind:'audio' — fade out at end. Default false." },
      startOffset: {
        type: 'number',
        description: "kind:'audio' — start playback at this offset in seconds. Default 0.",
      },
      opacity: { type: 'number', description: "kind:'video' — video opacity 0–1. Default 1." },
      trimStart: { type: 'number', description: "kind:'video' — start playback at this second. Default 0." },
      trimEnd: { type: 'number', description: "kind:'video' — stop playback at this second. null = play to end." },
    },
    required: ['kind', 'sceneId'],
  },
}

// ── Global Style Tools ────────────────────────────────────────────────────────

export const SET_STYLE: ClaudeToolDefinition = {
  name: 'set_style',
  mutates: 'project',
  description: `Set visual style — global (across the whole project) or for one scene. Pass scope:'global' for the project-wide look, scope:'scene' (with sceneId) to override a single scene.
Presets are optional starting points — scope:'global' with presetId:"none" gives full style autonomy.
Scene use: before/after comparisons, highlighting key scenes, chalkboard sections, technical blueprint diagrams.`,
  input_schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['scene', 'global'],
        description: "'global' = project-wide style. 'scene' = override one scene (requires sceneId).",
      },
      sceneId: { type: 'string', description: 'scope:scene — the scene to override.' },
      presetId: {
        type: 'string',
        description:
          'scope:global — style preset ID (e.g. "whiteboard", "cinematic"), or the literal string "none" to clear the preset and give the agent full style autonomy.',
      },
      preset: {
        type: 'string',
        enum: ['before', 'after', 'warning', 'highlight', 'chalkboard', 'blueprint', 'newspaper', 'neon'],
        description: 'scope:scene — named preset to apply. Overrides individual properties below.',
      },
      applyScope: {
        type: 'string',
        enum: ['project_default', 'all_scenes', 'new_scenes_only'],
        description:
          'scope:global — project_default/new_scenes_only: sets default for new scenes (existing scenes keep their overrides). all_scenes: clears all per-scene overrides and re-applies globally.',
      },
      palette: {
        type: 'array',
        description: 'Hex color array. scope:global = 5 colors [bg, bg2, accent, dark, light]; scope:scene = 4 colors.',
        items: { type: 'string', description: 'Hex color string' },
      },
      bgColor: { type: 'string', description: 'scope:scene — background hex color' },
      font: {
        type: 'string',
        enum: FONT_FAMILIES,
        description: 'Heading/display font family from the curated catalog. Pick one that matches the content tone.',
      },
      bodyFont: {
        type: 'string',
        enum: FONT_FAMILIES,
        description:
          'Body text font family. Use a different font from the heading for typographic contrast. Optional — defaults to the heading font.',
      },
      fontPairing: {
        type: 'string',
        enum: FONT_PAIRING_IDS,
        description: 'Curated font pairing ID (sets both heading + body font). Overrides font/bodyFont if provided.',
      },
      strokeWidth: {
        type: 'number',
        description: 'scope:global — global stroke/line weight 1–5. Lower = precise, higher = hand-drawn look',
      },
      roughnessLevel: { type: 'number', description: 'scope:scene — roughness 0–3' },
      defaultTool: { type: 'string', description: 'scope:scene — drawing tool: marker, pen, chalk, brush' },
      theme: {
        type: 'string',
        enum: ['dark', 'light'],
        description: 'scope:global — overall editor theme',
      },
      duration: {
        type: 'number',
        description: 'scope:global — default scene duration in seconds for newly created scenes',
      },
    },
    required: ['scope'],
  },
}

const PLAN_SCENES_INPUT_SCHEMA: ClaudeToolDefinition['input_schema'] = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Project/video title' },
    approach: {
      type: 'string',
      description:
        'The through-line, 3-5 sentences: how these beats connect into ONE piece (not a slide deck), what carries across cuts (a motif, a moving camera, a recurring subject), and the researched facts grounding a real topic. Concrete to THIS subject — the builders read it. Do NOT decree one fixed look for every scene ("dark bg + one accent + big type"): that is the text-poster slideshow to avoid. Plan the spine; let each beat look DIFFERENT.',
    },
    scenes: {
      type: 'array',
      description: 'Planned scenes in order',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id — echo it when re-planning so built work is kept.' },
          name: { type: 'string', description: 'Scene name' },
          purpose: { type: 'string', description: 'What this scene accomplishes narratively' },
          duration: { type: 'number', description: 'Seconds (6-30); raised to fit narrationDraft.' },
          transition: { type: 'string', enum: ALL_TRANSITION_IDS, description: 'Transition to next scene' },
          narrationDraft: { type: 'string', description: 'Draft VO at ~150 WPM. Sets the duration floor.' },
          visualForm: {
            type: 'string',
            enum: ['chart', 'imagery', 'diagram', '3d', 'stat', 'text'],
            description:
              "Routes the renderer; enforced at build time. Decide from the CONTENT: chart = quantitative (scores, %, rankings, timelines); imagery = a real person/place/event/product (a photo/clip, never CSS shapes); diagram = a process or relationship; 3d = a spatial object; stat = ONE hero number; text = LAST RESORT (pure quote/headline). A data or real-subject beat marked 'text' is the #1 failure and fails the build check.",
          },
          visualElements: {
            type: 'string',
            description:
              'What is ON SCREEN and how it is COMPOSED — vary it across scenes, not "big headline + label" every time. For a real subject name the real imagery ("full-bleed archival photo of the penalty save"), not CSS shapes standing in.',
          },
          audioNotes: { type: 'string', description: 'SFX/music cues: "whoosh on transition, click per step"' },
          chartSpec: {
            type: 'object',
            description: "For a 'chart' beat.",
            properties: {
              type: { type: 'string', enum: [...DREAMBYTE_CHART_TYPES] },
              dataDescription: {
                type: 'string',
                description: 'The data: "Revenue by quarter Q1-Q4 2024, 2.1M to 3.8M"',
              },
            },
          },
          mediaLayers: {
            type: 'string',
            description:
              'The actual footage/photo to place, e.g. "full-bleed archival photo of the celebration; crowd b-roll behind the stat". Also avatar PIP / music cues.',
          },
          cameraMovement: {
            type: 'string',
            description: 'Camera motion: "kenBurns slow zoom 1.04x", "cinematicPush to center", "orbit the object"',
          },
          handoffToNext: {
            type: 'object',
            description:
              'CONTINUITY — how this beat hands off to the next so the cut flows instead of reading as a separate slide. match-cut = next opens on the same shape/position; zoom-into = push into a detail it starts on.',
            properties: {
              type: { type: 'string', enum: ['match-cut', 'zoom-into', 'hard-cut', 'motif-return'] },
              note: { type: 'string', description: 'The concrete cut: "match this circle to the next scene\'s sun"' },
            },
          },
          carriedElements: {
            type: 'array',
            items: { type: 'string' },
            description:
              'CONTINUITY: motifs this beat passes FORWARD, e.g. ["the orange arrow"], so the next builder carries them instead of resetting.',
          },
        },
        required: ['name', 'purpose', 'duration', 'visualForm'],
      },
    },
    totalDuration: { type: 'number', description: 'Total planned duration in seconds' },
    styleNotes: { type: 'string', description: 'Visual style direction for the whole piece' },
    featureFlags: {
      type: 'object',
      description:
        'Educational/narrative → narration + music true. Abstract art → narration false. narration defaults ON.',
      properties: {
        narration: { type: 'boolean' },
        music: { type: 'boolean', description: 'Background music bed' },
        sfx: { type: 'boolean' },
        interactions: { type: 'boolean', description: 'Interactive elements (interactive output mode only)' },
      },
    },
  },
  required: ['title', 'approach', 'scenes', 'totalDuration'],
}

export const PLAN_SCENES: ClaudeToolDefinition = {
  name: 'plan_scenes',
  description: `Plan the whole video before building it. Stores the scene plan every later step reads, so call it first on a multi-scene build.

A SHOT LIST, not just a script. Art-direct each beat to what THIS prompt and the assets you have call for (rich input → align + use it; sparse → research first; honor an explicit minimal/text-only ask). visualForm routes the renderer; vary composition and cameraMovement across beats, or the cut reads as one flat slideshow. narrationDraft sets each duration.`,
  input_schema: PLAN_SCENES_INPUT_SCHEMA,
}

/**
 * dispatch_scene_builder — agent-decided delegation. Calling this hands the
 * planned scenes to parallel scene-builder sub-agents (one per scene). The
 * runner runs the orchestration when it sees this call, so the AGENT decides
 * when to delegate instead of relying on a hardcoded heuristic.
 */
export const DISPATCH_SCENE_BUILDER: ClaudeToolDefinition = {
  name: 'dispatch_scene_builder',
  description: `Build all planned scenes in parallel by delegating each planned scene to a focused
scene-builder sub-agent. Call this AFTER plan_scenes (a scene plan exists) and after set_style,
once the structure and look are locked — this is the BUILD step for a multi-scene video. Each sub-agent
gets one scene, an isolated workspace, and a share of the run budget; they verify their own work. Prefer
this over building scenes one at a time when the video has several scenes.`,
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          'Brief note on why you are delegating now (e.g. "structure + style locked, building 5 scenes in parallel").',
      },
    },
    required: [],
  },
}

/**
 * dispatch_subagent — spawn one focused, typed sub-agent and get its result back
 * inline. Unlike dispatch_scene_builder (which builds the whole scene plan and
 * ends the turn), this runs a single scoped worker, hands its brief back as the
 * tool result, and lets you keep working. Each type has a locked-down toolset.
 */
export const DISPATCH_SUBAGENT: ClaudeToolDefinition = {
  name: 'dispatch_subagent',
  description: `Delegate a focused task to a single sub-agent with a scoped toolset, and get its written brief back so you can keep working with it. Use this to fan out work without doing it inline.

Types:
- Explore — read-only researcher (web search, URL fetch, skill lookup). Use to research an unfamiliar topic before planning/building. Returns a cited brief.
- Plan — drafts a written plan (read + research, no building).
- Verification — inspects already-built work and reports pass/fail + issues (read-only).
- general-purpose — full toolset; use only when the scoped types don't fit.

The sub-agent runs in an isolated copy of the project, shares your run budget, and CANNOT do anything outside its toolset. Its final message is returned to you as the tool result. This is blocking — you get the brief, then continue.`,
  input_schema: {
    type: 'object',
    properties: {
      subagentType: {
        type: 'string',
        enum: ['Explore', 'Plan', 'Verification', 'general-purpose'],
        description: 'The kind of sub-agent to spawn. Pick the most specific type that fits the task.',
      },
      task: {
        type: 'string',
        description:
          'A clear, self-contained description of what the sub-agent should do and what to return. The sub-agent has no other context.',
      },
    },
    required: ['subagentType', 'task'],
  },
}

/**
 * dispatch_to_branches — agent-decided branch fan-out. Spawns N
 * independent full agent runs, each on its own branch off the user's current
 * branch, all working the same instruction — so the user gets N alternative
 * takes to compare. Terminal like dispatch_scene_builder: calling it ENDS the
 * run. The runner emits a fan-out spec the renderer executes via the existing
 * variant pipeline (parallel, per-branch budget reservation). Compare via the
 * branch selector when they finish.
 */
export const DISPATCH_TO_BRANCHES: ClaudeToolDefinition = {
  name: 'dispatch_to_branches',
  description: `Generate several ALTERNATIVE takes of the same request in parallel, each on its own branch, so the user can compare and pick a winner. Use this when the user asks for variations / options / "a few versions" / "some takes to choose from", or when the best direction is genuinely ambiguous and worth exploring in parallel. Each branch is an independent full build off the current branch; they run in parallel and share the run budget (split evenly). This ENDS your turn — you do NOT get another turn after calling it, and you can't review the results yourself this run; the user compares the finished branches in the branch selector. For a single definitive build, use dispatch_scene_builder or build directly instead — not this.`,
  input_schema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description:
          'How many alternative takes to generate, a whole number from 2 to 8 (clamped to that range). Default to what the user asked for, else 3.',
      },
      instruction: {
        type: 'string',
        description:
          'The self-contained build instruction each branch follows. Each branch starts from the same context, so include everything a fresh build needs (topic, style direction, constraints). Phrase it so independent takes can legitimately differ.',
      },
    },
    required: ['count', 'instruction'],
  },
}

/**
 * dispatch_to_projects — agent-decided CROSS-PROJECT fan-out. Applies
 * the same instruction to several of the user's OTHER projects (shared brand kit,
 * batch re-export, studio-wide ops). Terminal like dispatch_to_branches: calling
 * it ENDS the run. The runner emits a crossproject_proposed spec; the renderer
 * lets the USER pick which target projects to apply to (cross-project edits other
 * projects, so the user confirms targets), then fires the dispatch. Each target
 * runs fully isolated under its OWN settings. NOT for variations of the current
 * project (use dispatch_to_branches) or a single build (build directly).
 *
 * NOTE: defined but NOT yet in any active toolset — wiring it needs the runner emit +
 * renderer picker and registers it. Dormant until then.
 */
export const DISPATCH_TO_PROJECTS: ClaudeToolDefinition = {
  name: 'dispatch_to_projects',
  description: `Apply the same change across several of the user's OTHER projects at once (e.g. "apply this brand kit to all my projects", "re-export every project at 4K", studio-wide edits). Use ONLY when the user explicitly wants a change to span MULTIPLE projects beyond the current one. The user will pick exactly which target projects it applies to before anything runs (cross-project edits modify other projects, so they confirm). Each target runs as an independent full build under its own settings. This ENDS your turn — you do NOT get another turn after calling it, and you can't review the results yourself this run. For alternative takes of the CURRENT project use dispatch_to_branches; for a single build, build directly — not this.`,
  input_schema: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description:
          'The self-contained instruction applied to each target project. Each target starts from its OWN content/settings, so phrase it generically (no references to the current project specific scenes). Include everything a fresh run on another project needs.',
      },
    },
    required: ['instruction'],
  },
}

/**
 * write_plan — the agentic plan surface. Writes a free-form markdown
 * plan that becomes the user-facing planning artifact, shown in chat as a plan
 * card. This REPLACES the plan_scenes form for planning; the internal
 * scene plan is derived silently from the approved plan at build time.
 */
export const WRITE_PLAN: ClaudeToolDefinition = {
  name: 'write_plan',
  description: `Write a short, clear plan for what you're about to build, shown to the user as a plan card. Use this for any substantial build (a multi-scene video, a non-trivial change) BEFORE you start building — it's how the user sees your intent and, in Plan-first mode, approves it.

Write the plan as concise markdown: what you'll make, the key scenes/sections, the look, and anything you researched. Pair it with a todo list (one item per scene or major step) so progress is visible as you build. Re-issue write_plan to revise the plan after the user replies with feedback — it replaces the prior plan in place.

This is a written artifact, not a form: don't ask the user to fill anything in. After the plan, in Plan-first mode you stop for approval; otherwise you keep building, updating todos as you go.`,
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'A short title for the plan (e.g. "Explainer: how RAG works"). Shown in the card header.',
      },
      plan: {
        type: 'string',
        description:
          'The plan body as markdown — concise, skimmable. Cover what you will build, the structure, and the look.',
      },
      todos: {
        type: 'array',
        description:
          'Optional initial checklist — one item per scene or major step. You can also add them later with update_todos.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What this step does (e.g. "Scene 1 — hook: title + motion intro").' },
          },
          required: ['text'],
        },
      },
    },
    required: ['plan'],
  },
}

/**
 * update_todos — maintain the plan card's tracked checklist. Always
 * send the FULL current list; it replaces the prior one. Drives the inline
 * checklist and the "building N/M" progress indicator.
 */
export const UPDATE_TODOS: ClaudeToolDefinition = {
  name: 'update_todos',
  description: `Update the plan's todo checklist to reflect progress. Send the FULL current list every time (it replaces the previous one). Mark exactly one item "in_progress" while you work it, flip it to "completed" when done, and "failed" if it couldn't be finished. This keeps the user oriented as you build.`,
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete current checklist, in order.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable id from a prior write_plan/update_todos. Omit for new items.' },
            text: { type: 'string', description: 'The step text.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'failed'],
              description: 'Current state of this step.',
            },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['todos'],
  },
}

// ── Interaction Tools ─────────────────────────────────────────────────────────

/**
 * interaction — add one or many, one tool, one array.
 *
 * add_interaction was add_multiple_interactions with a one-element array, and the two
 * declared the same eight-property item shape twice (both `type` and `style` enums
 * appeared in each). Batching also wins undo granularity: one call is one transaction.
 */
export const INTERACTION: ClaudeToolDefinition = {
  name: 'interaction',
  mutates: 'scene',
  description: `Add interactive elements to a scene. Pass every element you want in \`items\` — one call for one hotspot, one call for a whole labelled diagram or a quiz + gate pair.

Uses the DreambyteInteract component library for production-ready visuals: provide content/config only, the visual design is handled for you across 6 preset styles. Style "auto" detects from the scene preset.

Types: hotspot (clickable/hover info on diagram parts), choice (branching options), quiz (assessment with correct/incorrect feedback), gate (blocks progression until a condition is met), tooltip (persistent or triggered info overlay), form (data collection mid-scene), slider (numeric input bound to a variable — "adjust interest rate"), toggle (boolean on/off bound to a variable).

Slider and toggle are variable-driven: pair them with useVariable() in the scene code so the scene reactively updates when the viewer moves the control.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      items: {
        type: 'array',
        description: 'One entry per interactive element. Batch them all into a single call.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['hotspot', 'choice', 'quiz', 'gate', 'tooltip', 'form', 'slider', 'toggle'],
              description: 'Interaction element type',
            },
            style: {
              type: 'string',
              enum: ['professional', 'glassmorphic', 'minimal', 'terminal', 'chalk', 'edu', 'auto'],
              description:
                '"auto" detects from the scene preset. professional=corporate, glassmorphic=frosted glass (dark scenes), minimal=near-invisible, terminal=amber phosphor, chalk=hand-drawn, edu=friendly rounded.',
            },
            x: { type: 'number', description: 'X position as % of canvas (0–100)' },
            y: { type: 'number', description: 'Y position as % of canvas (0–100)' },
            width: { type: 'number', description: 'Width as % of canvas (0–100)' },
            height: { type: 'number', description: 'Height as % of canvas (0–100)' },
            appearsAt: { type: 'number', description: 'Seconds into the scene when the element appears' },
            config: {
              type: 'object',
              description: 'Type-specific configuration (label, options, question, explanation, …)',
              properties: {},
            },
            placementNote: {
              type: 'string',
              description: 'Optional note about why this interaction is here and what it achieves',
            },
          },
          required: ['type', 'x', 'y', 'width', 'height', 'appearsAt', 'config'],
        },
      },
    },
    required: ['sceneId', 'items'],
  },
}

export const EDIT_INTERACTION: ClaudeToolDefinition = {
  name: 'edit_interaction',
  description: 'Edit an existing interaction element.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      elementId: { type: 'string', description: 'Interaction element ID' },
      updates: {
        type: 'object',
        description: 'Fields to update on the interaction element',
        properties: {},
      },
    },
    required: ['sceneId', 'elementId', 'updates'],
  },
}

export const DEFINE_SCENE_VARIABLE: ClaudeToolDefinition = {
  name: 'define_scene_variable',
  description: `Define a typed variable on a scene. Variables are used by:
- Slider/toggle overlays (setsVariable binds to this)
- useVariable() hook in React scene code (reads/writes this)
- Variable conditions on scene graph edges (branches based on this)

Define variables BEFORE adding sliders/toggles that reference them, or before generating
React scene code that uses useVariable(). The variable persists across the scene session.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      name: { type: 'string', description: 'Variable name (camelCase, e.g. "interestRate", "showLabels")' },
      type: {
        type: 'string',
        enum: ['string', 'number', 'boolean'],
        description: 'Variable type',
      },
      defaultValue: {
        description: 'Default value matching the type',
      },
    },
    required: ['sceneId', 'name', 'type', 'defaultValue'],
  },
}

export const CONNECT_SCENES: ClaudeToolDefinition = {
  name: 'connect_scenes',
  description: 'Create an edge in the scene graph connecting two scenes (for Interactive mode).',
  input_schema: {
    type: 'object',
    properties: {
      fromSceneId: { type: 'string', description: 'Source scene ID' },
      toSceneId: { type: 'string', description: 'Destination scene ID' },
      conditionType: {
        type: 'string',
        enum: ['auto', 'hotspot', 'choice', 'quiz', 'gate', 'variable', 'slider', 'toggle'],
        description:
          '"auto" = plays automatically after duration. "variable" = jumps when a variable condition is met.',
      },
      variableCondition: {
        type: 'object',
        description: 'For "variable" conditionType: evaluate a variable to decide navigation',
        properties: {
          variableName: { type: 'string' },
          operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'truthy', 'falsy'] },
          value: { description: 'Comparison value (not needed for truthy/falsy)' },
        },
      },
      interactionId: {
        type: 'string',
        description: 'ID of the interaction that triggers this edge (for non-auto conditions)',
      },
    },
    required: ['fromSceneId', 'toSceneId', 'conditionType'],
  },
}

// ── Avatar Narration Tool ────────────────────────────────────────────────────

export const GENERATE_AVATAR_NARRATION: ClaudeToolDefinition = {
  name: 'generate_avatar_narration',
  description: `Generate a talking avatar video for a scene. The avatar speaks the provided text with synchronized lip movements.

The project's configured avatar provider determines quality and cost:
- musetalk/fabric/aurora: Photorealistic talking head via fal.ai (~$0.04-0.15/scene)
- heygen: Premium quality via HeyGen API

The result is automatically composited into the scene as a picture-in-picture overlay or full-screen presenter.

PIP avatars are true overlays — do NOT add padding, margins, maxWidth restrictions, or reserved columns in scene code to make room. The scene should use the full viewport; the avatar floats on top and may partially overlap content. Only avatar_scene uses a split layout.

Use when the user asks for a presenter, host, narrator avatar, talking head, or person explaining something on screen.
Do NOT add an avatar unless the user asks for one. Many explainer videos work better without a presenter.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: {
        type: 'string',
        description: 'Scene to add the avatar to',
      },
      text: {
        type: 'string',
        description: 'What the avatar should say. Keep it natural and conversational.',
      },
      placement: {
        type: 'string',
        enum: ['pip_bottom_right', 'pip_bottom_left', 'fullscreen', 'pip_top_right'],
        description:
          'How to position the avatar in the scene. pip = picture-in-picture overlay. Default: pip_bottom_right',
      },
      avatarConfigId: {
        type: 'string',
        description: 'Specific avatar config to use. Omit to use project default.',
      },
      sourceImageUrl: {
        type: 'string',
        description: 'URL of a face image (for fal.ai providers). Omit to use the configured default.',
      },
      characterId: {
        type: 'string',
        description:
          "A Cast member / character name or id (from character(action:'create')). Its saved face image drives the talking head, so the same person is reused across scenes without re-supplying an image. Takes effect when sourceImageUrl is omitted. Ignored by providers that don't use a face image (heygen).",
      },
    },
    required: ['sceneId', 'text'],
  },
}

export const GENERATE_AVATAR_SCENE: ClaudeToolDefinition = {
  name: 'generate_avatar_scene',
  description: `Create a full avatar presenter scene where the talking-head video is the main focus.
Use instead of a regular scene when the scene should feature a talking avatar as the primary visual — presenter mode, tutorial, walkthrough.

The configured avatar provider (HeyGen / fal.ai) renders the presenter video; content panels animate in beside it.

Best for: step-by-step explanations, data walkthroughs, educational content, corporate spokesperson.
Do NOT use for: data-heavy scenes (use PIP avatar), abstract concept scenes, or scenes < 5 seconds.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: {
        type: 'string',
        description: 'Target scene ID',
      },
      narration_script: {
        type: 'object',
        description: 'Full narration script with mood, view, gestures, and lines',
        properties: {
          mood: { type: 'string', enum: ['neutral', 'happy', 'sad', 'angry', 'fear', 'surprise'] },
          view: { type: 'string', enum: ['full', 'mid', 'upper', 'head'] },
          lipsyncHeadMovement: { type: 'boolean' },
          eyeContact: { type: 'number', description: '0-1, default 0.7' },
          position: { type: 'string', enum: ['fullscreen', 'fullscreen_left', 'fullscreen_right'] },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                mood: { type: 'string', enum: ['neutral', 'happy', 'sad', 'angry', 'fear', 'surprise'] },
                gesture: {
                  type: 'string',
                  enum: ['wave', 'handup', 'index', 'ok', 'thumbup', 'thumbdown', 'side', 'shrug'],
                },
                gestureHand: { type: 'string', enum: ['left', 'right'] },
                lookAt: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
                lookCamera: { type: 'boolean' },
                pauseBefore: { type: 'number', description: 'ms pause before this line' },
                animation: { type: 'string' },
              },
              required: ['text'],
            },
          },
        },
        required: ['mood', 'view', 'lines'],
      },
      content_panels: {
        type: 'array',
        description: 'Content panels shown beside the avatar',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            html: { type: 'string', description: 'HTML content for the panel' },
            position: { type: 'string', enum: ['left', 'right'] },
            revealAt: { type: 'string', description: 'When to reveal: seconds as string' },
            exitAt: { type: 'string' },
          },
          required: ['html', 'revealAt'],
        },
      },
      backdrop: { type: 'string', description: 'CSS background for the scene' },
      avatar_position: { type: 'string', enum: ['left', 'right', 'center'], description: 'Where to place the avatar' },
      avatar_size: { type: 'number', description: 'Percentage of viewport width (default 40)' },
      avatar_config_id: { type: 'string', description: 'Specific avatar config. Omit for project default.' },
    },
    required: ['sceneId', 'narration_script'],
  },
}

// get_avatar_status merged into get_status(kind:'avatar') — see GET_STATUS below.
// Its handler case is unchanged; only the model-facing name moved.

// ── Export / Publish Tools ────────────────────────────────────────────────────

/**
 * export — one tool per NOUN, `format` as the discriminator, mp4 as the default.
 *
 * Replaces export_mp4 and — more importantly — reaches three capabilities that had a
 * live IPC handler but no agent tool at all, so the agent simply could not do them:
 *   • fcpxml        → dreambyte:export.fcpxml  (src/electron/ipc/export-fcpxml.ts)
 *   • embed         → dreambyte:publish.run    (src/electron/ipc/publish.ts)
 *   • scope:'scene' → the per-scene renderer export (exportSolidSceneMp4 + writeFile)
 * All three ride the SAME `run_export` client-action round-trip export_mp4 already
 * used, so no new transport exists — the renderer branches on `format` / `sceneId`.
 *
 * The mp4 knobs (profile / burnCaptions / outputName) were reachable only through the
 * Export panel; an agent asked for "a fast draft" had no way to ask for one.
 *
 * Status polling is NOT an op here — it moved to get_status(kind:'export'), which
 * merges the three pollers (export / video / avatar) that were the same shape.
 */
export const EXPORT: ClaudeToolDefinition = {
  name: 'export',
  description: `Export or publish the project. With no arguments: a 1080p 30fps MP4 of the whole video.

format:'mp4' (default) — render an MP4. Returns a jobId immediately (a long video takes minutes); poll get_status(kind:'export', jobId) until status is "complete" to get the output file path. scope:'scene' + sceneId renders ONE scene instead of the whole video.
format:'fcpxml' — write a Final Cut Pro XML interchange file of the timeline, for finishing in Final Cut / Premiere / Resolve. Whole project only; the user picks the destination.
format:'embed' — publish the project as a hosted interactive embed and return its URL. Whole project only; for interactive projects.`,
  input_schema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['mp4', 'fcpxml', 'embed'],
        description: "What to produce. Default 'mp4'.",
      },
      scope: {
        type: 'string',
        enum: ['project', 'scene'],
        description:
          "'project' (default) = the whole video. 'scene' = just sceneId. mp4 only — fcpxml and embed are whole-project.",
      },
      sceneId: { type: 'string', description: "Required when scope:'scene'." },
      resolution: {
        type: 'string',
        enum: ['720p', '1080p', '4k'],
        description: 'mp4 — export resolution. Default 1080p.',
      },
      fps: {
        type: 'number',
        description: 'mp4 — frames per second: 24, 30, or 60. Default 30.',
      },
      profile: {
        type: 'string',
        enum: ['fast', 'quality'],
        description: "mp4 — encoder profile. 'fast' for a draft the user is reviewing, 'quality' (default) to ship.",
      },
      burnCaptions: {
        type: 'boolean',
        description:
          'mp4 — hardcode the narration captions into the pixels (one extra re-encode). Sidecar .srt/.vtt ship either way. Default false.',
      },
      outputName: {
        type: 'string',
        description: 'mp4 — base filename (no extension) for the written file. Defaults to the project name.',
      },
    },
    required: [],
  },
}

/**
 * get_status — the three async-job pollers, one tool, one `kind`.
 *
 * export / video / avatar were three ~identical "poll until done" tools differing only
 * in which id they take and which poll fn they call. Each `kind` maps back to its
 * ORIGINAL handler case (tool-executor registers the router), so every job-registry
 * read, layer write-back and honest-failure path is unchanged.
 */
export const GET_STATUS: ClaudeToolDefinition = {
  name: 'get_status',
  description: `Poll a long-running job and finish it.

kind:'export' — an MP4 export started by \`export\`. Pass its jobId. Returns { status: "rendering" | "complete" | "error" | "none", progress (0-100 overall, monotonic), sceneProgress (0-100 within the current scene), currentScene, totalScenes, outputPath (when complete), error }. Poll until "complete", then report outputPath to the user.
kind:'video' — an AI video generation started by generate_veo3_video. Pass its operationName. While generating returns { done: false, status: "generating" }; on completion it fills the placed video layer in place (status "ready", videoUrl) and regenerates the scene. Generation takes 2-10 min — poll ~30s apart until done:true.
kind:'avatar' — a HeyGen avatar render started by generate_avatar_narration / generate_avatar_scene. Pass the sceneId + layerId they returned (or heygenVideoId). Renders take 1-3 min — poll ~30s apart. Only HeyGen is async; musetalk/fabric/aurora finish synchronously and never need this.`,
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['export', 'video', 'avatar'],
        description: 'Which job to poll.',
      },
      jobId: {
        type: 'string',
        description: "kind:'export' — the job id returned by `export`. Required; pass the exact id.",
      },
      operationName: {
        type: 'string',
        description: "kind:'video' — the operation id returned by generate_veo3_video. Required.",
      },
      sceneId: {
        type: 'string',
        description:
          "kind:'avatar' — scene containing the avatar layer. kind:'video' — optional fallback (with layerId) when the operationName is unknown.",
      },
      layerId: {
        type: 'string',
        description:
          "kind:'avatar' — the avatar layerId returned by the generate call. kind:'video' — optional fallback with sceneId.",
      },
      heygenVideoId: {
        type: 'string',
        description: "kind:'avatar' — optional HeyGen videoId, to locate the layer when sceneId/layerId are unknown.",
      },
    },
    required: ['kind'],
  },
}

// ── Template Tools ────────────────────────────────────────────────────────────

export const USE_TEMPLATE: ClaudeToolDefinition = {
  name: 'use_template',
  description: `Instantiate a built-in INTERACTIVE template as a new scene (decision, quiz, gate, hotspot, form, tooltip grid, true/false, survey, story branch, reveal). Fills placeholders from the user's intent.
Interactive output mode only — for a normal visual scene use create_scene + write_scene_code, which is the path that can actually render one.`,
  input_schema: {
    type: 'object',
    properties: {
      // Enumerated from the registry, not hand-listed: the other 20 built-ins
      // carry no layers and no interactions, so instantiating one produced a
      // blank scene and reported success.
      templateId: { type: 'string', enum: INSTANTIABLE_TEMPLATE_IDS, description: 'Template ID to instantiate' },
      scenePrompt: { type: 'string', description: 'What this scene is about (fills template placeholders)' },
      position: { type: 'number', description: 'Index to insert scene at. Omit to append.' },
    },
    required: ['templateId', 'scenePrompt'],
  },
}

// ── Tool Collections ──────────────────────────────────────────────────────────

/** All scene-level tools */
export const SET_CAMERA_MOTION: ClaudeToolDefinition = {
  name: 'set_camera_motion',
  description: `Add camera motion to a scene. Camera motion makes scenes feel cinematic and professional.

Available moves:
- kenBurns: Slow pan+zoom on static content. Use on image backgrounds or scenes with little movement.
- dollyIn: Push toward an element when it appears. Use on key stats, headlines, reveals.
- dollyOut: Pull back to show context. Use at start of scenes that build up to something.
- pan: Lateral camera movement. Use to follow action or create a sense of space.
- rackFocus: Blur transition between subjects. Use at major topic shifts within a scene.
- cut: Instant recomposition. Use for hard cuts to a new angle within a scene.
- shake: Impact shake. Use on dramatic reveals or surprising statistics.
- orbit: 3D scenes only. Rotate camera around a subject.
- dolly3D: 3D scenes only. Push camera along its view axis.
- rackFocus3D: 3D scenes only. Animate focal length (FOV) for cinematic compression.

Presets (recommended for most cases):
- presetReveal: Default for any scene — gentle Ken Burns throughout
- presetEmphasis: Dolly in on a specific element, then reset
- presetCinematicPush: Slow broadcast-style push, good for avatar scenes
- presetRackTransition: Rack focus blur at a scene transition point

Use camera motion sparingly. Not every scene needs it. Avoid combining more than 2-3 moves per scene.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      moves: {
        type: 'array',
        description: 'List of camera moves to apply in order',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [
                'kenBurns',
                'dollyIn',
                'dollyOut',
                'pan',
                'rackFocus',
                'cut',
                'shake',
                'reset',
                'orbit',
                'dolly3D',
                'rackFocus3D',
                'presetReveal',
                'presetEmphasis',
                'presetCinematicPush',
                'presetRackTransition',
              ],
            },
            params: {
              type: 'object',
              description:
                'Parameters for this move (duration, at, targetSelector, toScale, fromScale, endX, endY, ease, etc.)',
            },
          },
          required: ['type'],
        },
      },
    },
    required: ['sceneId', 'moves'],
  },
}

export const SCENE_TOOLS: ClaudeToolDefinition[] = [
  CREATE_SCENE,
  DELETE_SCENE,
  DUPLICATE_SCENE,
  REORDER_SCENES,
  SCENE_PROPS,
  SET_CAMERA_MOTION,
]

/** All layer tools */
export const LAYER_TOOLS: ClaudeToolDefinition[] = [
  ADD_LAYER,
  CREATE_ZDOG_COMPOSED_SCENE,
  SAVE_ZDOG_ASSET,
  LIST_ZDOG_PERSON_ASSETS,
  CHART,
  REMOVE_LAYER,
  REORDER_LAYER,
  SET_LAYER_PROPS,
  REGENERATE_LAYER,
  PATCH_LAYER_CODE,
  WRITE_SCENE_CODE,
  INSPECT,
  ROLLBACK_TO_SNAPSHOT,
  ANALYZE_REFERENCE_MEDIA,
]

/** All element (text overlay) tools */
export const ELEMENT_TOOLS: ClaudeToolDefinition[] = [
  // element(op) absorbed add / edit / delete; edit had already absorbed move / resize /
  // reorder / adjust_element_timing — they wrote the same textOverlay fields through the
  // same spread. All seven stay dispatchable as internal ops (ELEMENT_TOOL_NAMES).
  ELEMENT,
]

/** Audio tools */
export const ADD_NARRATION: ClaudeToolDefinition = {
  name: 'add_narration',
  description:
    'Generate text-to-speech narration for a scene. The TTS provider is automatically selected based on configured API keys. Audio replaces any existing narration.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID to add narration to' },
      text: { type: 'string', description: 'Narration text to speak. Keep to ~150 words/minute pace.' },
      voiceId: { type: 'string', description: 'Voice ID (optional, uses project default)' },
      provider: {
        type: 'string',
        enum: [
          'auto',
          'elevenlabs',
          'openai-tts',
          'gemini-tts',
          'google-tts',
          'openai-edge-tts',
          'pocket-tts',
          'voxcpm',
        ],
        description: 'TTS provider (optional, default: auto)',
      },
      instructions: {
        type: 'string',
        description: 'Style instructions for OpenAI gpt-4o-mini-tts or Gemini (e.g. "Speak cheerfully and slowly")',
      },
    },
    required: ['sceneId', 'text'],
  },
}

export const ADD_MUSIC: ClaudeToolDefinition = {
  name: 'add_music',
  description:
    'Add a background-music track to a scene. `source` picks how: "library" = search royalty-free libraries ' +
    '(Pixabay/Freesound) by `query`; "generate" = a paid model composes an original clip from `prompt` ' +
    '(ElevenLabs Music / Lyria / Stable Audio); "compose" = a LOCAL $0 sequencer renders a template bed ' +
    '(pick `templateId` + key/tempo/intensity). Music loops and ducks under narration. Prefer "compose" for ' +
    'free instant beds; "generate" (PAID, spend-gated) for bespoke; "library" for real tracks.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      source: {
        type: 'string',
        enum: ['library', 'generate', 'compose'],
        description:
          'library = search (uses `query`); generate = paid model (uses `prompt`); compose = local $0 (uses `templateId`). Default library.',
      },
      query: {
        type: 'string',
        description: 'source:library — music search query, e.g. "upbeat corporate", "calm piano".',
      },
      prompt: {
        type: 'string',
        description: 'source:generate — describe the music, e.g. "warm lofi piano, ~90 BPM, no drums".',
      },
      templateId: {
        type: 'string',
        enum: ['lofi', 'ambient', 'corporate', 'tension', 'upbeat', 'cinematic', 'dnb', 'synthwave', 'folk'],
        description: 'source:compose — musical style template. Default lofi.',
      },
      key: { type: 'string', description: 'source:compose — musical key, e.g. "C minor", "G major".' },
      tempo: { type: 'number', description: 'source:compose — tempo in BPM (clamped to the template range).' },
      intensity: { type: 'number', description: 'source:compose — 0..1 density/drum busyness/lead. Default 0.6.' },
      melody: {
        type: 'string',
        enum: ['template', 'ml'],
        description: "source:compose — lead-line source ('ml' = local Magenta melody, $0).",
      },
      groove: {
        type: 'string',
        enum: ['template', 'ml'],
        description: "source:compose — drum groove source ('ml' = local GrooVAE humanize, $0).",
      },
      duration: { type: 'number', description: 'source:generate/compose — target length in seconds (~30 default).' },
      volume: { type: 'number', description: 'Volume 0-1 (default 0.12).' },
      loop: { type: 'boolean', description: 'Loop music (default true).' },
      duckDuringTTS: { type: 'boolean', description: 'Reduce volume during narration (default true).' },
      provider: {
        type: 'string',
        description:
          "Force a provider. library: 'pixabay-music'|'freesound-music'. generate: 'elevenlabs-music'|'lyria'|'stable-audio'. Omit for auto.",
      },
    },
    required: ['sceneId', 'source'],
  },
}

export const ADD_SFX: ClaudeToolDefinition = {
  name: 'add_sfx',
  description:
    'Add a sound effect to a scene at a timestamp. `source` picks how: "library" = search the bundled LOCAL ' +
    'library ($0) plus free/paid providers (Freesound/Pixabay/ElevenLabs) by `query`; "synthesize" = generate ' +
    'the sound LOCALLY ($0, no key) via a nature ambience, a modal impact, an exact retro archetype (ZzFX), ' +
    'stacked layers, or a generative retro category (jsfxr). Use "synthesize" for retro/UI/nature textures, ' +
    '"library" for a specific recorded sound (a real dog bark, a real door).',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      source: {
        type: 'string',
        enum: ['library', 'synthesize'],
        description:
          'library = search (uses `query`); synthesize = local $0 (uses nature/material/archetype/generate/layers). Default library.',
      },
      query: { type: 'string', description: 'source:library — search query / generation prompt for the sound.' },
      provider: {
        type: 'string',
        enum: ['auto', 'local', 'freesound', 'pixabay', 'elevenlabs-sfx'],
        description: "source:library — SFX provider. 'local' = bundled library ($0). Default auto.",
      },
      nature: {
        type: 'string',
        enum: ['wind', 'wind-howl', 'rain', 'fire', 'ocean', 'thunder', 'stream', 'static', 'rumble', 'sizzle'],
        description:
          'source:synthesize — NATURAL ambience (noise-based). `duration` = seconds 1–30, `intensity` 0–1, `variation` seed.',
      },
      material: {
        type: 'string',
        enum: ['metal', 'wood', 'glass', 'ceramic', 'membrane'],
        description:
          'source:synthesize — MODAL struck-object impact. Knobs: `pitch` 0.25–4, `duration` 0.25–4, `intensity` 0–1, `variation` 0–1.',
      },
      generate: {
        type: 'string',
        enum: [
          'explosion',
          'laser',
          'shoot',
          'coin',
          'pickup',
          'powerup',
          'hit',
          'hurt',
          'jump',
          'blip',
          'select',
          'tone',
          'random',
        ],
        description: 'source:synthesize — GENERATIVE retro category (jsfxr); bump `variation` for a different take.',
      },
      archetype: {
        type: 'string',
        description:
          'source:synthesize — EXACT ZzFX preset id (laser, zap, explosion, coin, powerup, jump, click, chime, whoosh, riser, glitch, kick, snare, hat, …).',
      },
      layers: {
        type: 'array',
        description:
          'source:synthesize — stack 2–6 archetypes into ONE compound sound; each layer has its own pitch/duration/volume/offsetMs.',
        items: {
          type: 'object',
          properties: {
            archetype: { type: 'string', description: 'Archetype/preset id for this layer.' },
            pitch: { type: 'number', description: 'Frequency multiplier 0.25–4.' },
            duration: { type: 'number', description: 'Length multiplier 0.25–4.' },
            variation: { type: 'number', description: '0–1 randomness.' },
            volume: { type: 'number', description: 'Layer gain 0–2 (default 1).' },
            offsetMs: { type: 'number', description: 'Start delay in ms (default 0).' },
          },
          required: ['archetype'],
        },
      },
      intensity: { type: 'number', description: 'source:synthesize — nature density / modal brightness. Default 0.6.' },
      pitch: { type: 'number', description: 'source:synthesize — frequency multiplier 0.25–4. Default 1.' },
      duration: {
        type: 'number',
        description: 'source:synthesize — length multiplier (archetype) or seconds (nature). ',
      },
      variation: { type: 'number', description: 'source:synthesize — 0–1 deterministic randomness. Default 0.' },
      triggerAt: { type: 'number', description: 'Seconds into the scene when the SFX plays (default 0).' },
      volume: { type: 'number', description: 'Volume 0–1 (default 0.8).' },
    },
    required: ['sceneId', 'source'],
  },
}
const SET_AUDIO_MIX: ClaudeToolDefinition = {
  name: 'set_audio_mix',
  description:
    'Adjust a scene\'s audio MIX after sounds are added: per-bus gain (narration/music/SFX), a master trim, music-under-narration ducking, and loudness normalization. Use this to rebalance ("narration too quiet under the music"), tune ducking, or normalize loudness for delivery. Gain is a bus multiplier on top of each clip\'s own volume. Ducking enable/level applies in both export engines. Normalization is applied once to the FINISHED video at export (target LUFS), so it is delivery-consistent regardless of scene count. Partial updates merge — only the fields you pass change.',
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID' },
      masterGain: {
        type: 'number',
        description:
          'Linear master trim on the whole scene mix, 1=unchanged (0-4). Ignored at export if normalization is on.',
      },
      ttsGain: { type: 'number', description: 'Bus gain on narration, 1=unchanged (0-4)' },
      musicGain: { type: 'number', description: 'Bus gain on background music, 1=unchanged (0-4)' },
      sfxGain: { type: 'number', description: 'Bus gain on all SFX, 1=unchanged (0-4)' },
      normalize: {
        type: 'object',
        description: 'Program loudness normalization, applied once to the final exported video.',
        properties: {
          enabled: { type: 'boolean', description: 'Turn normalization on/off' },
          targetLufs: {
            type: 'number',
            description:
              'Integrated loudness target in LUFS (default -14 for social/YouTube; -16 for podcast). Range -30..-9.',
          },
        },
        required: ['enabled'],
      },
      ducking: {
        type: 'object',
        description: 'Music-under-narration ducking. enabled is the authoritative on/off gate.',
        properties: {
          enabled: { type: 'boolean', description: 'Enable/disable ducking music while narration plays' },
          duckLevel: {
            type: 'number',
            description: 'Music level while narration plays, 0-1 (lower = more duck, default 0.2)',
          },
          attackMs: { type: 'number', description: 'Fade-down time ms (default 100, 5-1000)' },
          releaseMs: { type: 'number', description: 'Fade-up time ms (default 500, 50-3000)' },
          ratio: { type: 'number', description: 'Sidechain compression ratio (default 10, 2-20)' },
        },
      },
    },
    required: ['sceneId'],
  },
}

export const DUB_VIDEO: ClaudeToolDefinition = {
  name: 'dub_video',
  description: `Dub a talking-head source video into another language: transcribe the speech, translate it, re-speak it (a preset target-language voice, or a cloned voice to keep the original speaker's voice), and re-lip-sync the source video to the new audio with segment-level timing so the lips track.

Use when the user asks to translate / dub / localize a video, or "make this speak <language>". Requires a source video with clear speech (talking head). Paid: translation + TTS + the re-lip generation are gated.`,
  input_schema: {
    type: 'object',
    properties: {
      sourceVideoUrl: {
        type: 'string',
        description: 'The source talking-head video to dub (an uploaded asset URL, /uploads path, or data: URL).',
      },
      targetLanguage: {
        type: 'string',
        description: 'Language to dub INTO, e.g. "Spanish" / "es" / "Japanese".',
      },
      sourceLanguage: {
        type: 'string',
        description: 'Optional source-language hint; omit to auto-detect from the audio.',
      },
      voiceId: {
        type: 'string',
        description:
          "Optional cloned voice id (from clone_voice) to dub in the original speaker's own voice. Omit to use a preset target-language voice.",
      },
      provider: { type: 'string', description: 'Optional TTS provider override; omit for the multilingual default.' },
    },
    required: ['sourceVideoUrl', 'targetLanguage'],
  },
}

export const CLONE_VOICE: ClaudeToolDefinition = {
  name: 'clone_voice',
  description: `Clone a custom voice from a user-provided audio sample, creating a reusable cloned voice (a "Cast member" voice). The sample is sent to a third-party provider (ElevenLabs) to build a voiceprint.

BIOMETRIC + CONSENT: a voice sample is biometric data. The first clone to a provider in a project surfaces an in-chat consent card naming the destination; nothing is uploaded until the user approves. The paid clone is also spend-gated.

Use when the user asks to clone their (or a provided) voice, create a custom/personal voice, or give a Cast member a specific voice. Requires an uploaded audio sample (audioUrl). After cloning, bind the returned voice to a character so avatar narration speaks in it. Only clone a voice the user has the right to use.`,
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A name for the cloned voice (unique per project).' },
      audioUrl: {
        type: 'string',
        description: 'A reference to the voice sample to clone: an uploaded asset URL, /uploads path, or data: URL.',
      },
      provider: {
        type: 'string',
        enum: [...CLONE_CAPABLE_PROVIDERS],
        description:
          "Clone provider. 'elevenlabs' (paid, cloud) is default; 'voxcpm'/'pocket-tts' are local/free. Omit for default.",
      },
    },
    required: ['name', 'audioUrl'],
  },
}

export const AUDIO_TOOLS: ClaudeToolDefinition[] = [
  ADD_NARRATION,
  ADD_MUSIC,
  ADD_SFX,
  SET_AUDIO_MIX,
  DUB_VIDEO,
  CLONE_VOICE,
  GENERATE_AVATAR_NARRATION,
  GENERATE_AVATAR_SCENE,
]

/** Project media library tools */
export const USE_ASSET_IN_SCENE: ClaudeToolDefinition = {
  name: 'use_asset_in_scene',
  description:
    'Reference an uploaded project asset in a scene. Use when the user mentions their logo, uploaded image, video clip, or any named asset. Returns the asset URL and metadata needed to embed it in scene HTML.',
  input_schema: {
    type: 'object',
    properties: {
      assetId: { type: 'string', description: 'ID of the asset from the project media library' },
      usage: {
        type: 'string',
        enum: ['fullscreen', 'overlay', 'watermark', 'background', 'inline'],
        description: 'How the asset will be used in the scene',
      },
      position: {
        type: 'object',
        description: 'For overlay/watermark usage. x/y as percentage of scene dimensions.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number', description: 'Percentage of scene width' },
          anchor: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'] },
        },
      },
    },
    required: ['assetId', 'usage'],
  },
}

export const ADD_WATERMARK: ClaudeToolDefinition = {
  name: 'add_watermark',
  description:
    'Add a persistent logo or watermark overlay to all scenes in the project, or to specified scenes only. The watermark is injected automatically into scene HTML during render.',
  input_schema: {
    type: 'object',
    properties: {
      assetId: { type: 'string', description: 'ID of an image/SVG asset from the media library' },
      position: {
        type: 'string',
        enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        description: 'Corner position (default: bottom-right)',
      },
      opacity: { type: 'number', description: 'Opacity 0-1 (default: 0.8)' },
      sizePercent: { type: 'number', description: 'Width as % of scene width (default: 12)' },
    },
    required: ['assetId'],
  },
}

// get_video_status merged into get_status(kind:'video') — see GET_STATUS.
// Its handler case is unchanged; only the model-facing name moved.

export const CHARACTER: ClaudeToolDefinition = {
  name: 'character',
  description: `Define or re-render a reusable CHARACTER — a named person/creature whose look stays consistent across scenes. Consistency is enforced by three levers: a pinned seed, a reference image, and a style descriptor.

action:'create' — define the character. Provide a prompt to generate a first reference portrait, OR a referenceAssetId to adopt an existing library image as the reference.
action:'render' — re-render an existing character in a NEW pose/scene/action while keeping the same identity (conditions on its reference image + pinned seed). Returns the new image as a library asset (place it with use_asset_in_scene).

Either action that generates makes one paid image — image generation permission is required.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'render'],
        description: "'create' defines a new character; 'render' re-renders an existing one in a new pose/scene.",
      },
      name: {
        type: 'string',
        description: 'action:create — the character name, e.g. "Aria" — used to refer to them later',
      },
      description: {
        type: 'string',
        description:
          'action:create — appearance/style descriptor folded into every render (hair, face, clothing, art style). The identity anchor beyond the seed.',
      },
      referenceAssetId: {
        type: 'string',
        description: 'action:create — adopt this existing library image as the reference instead of generating one.',
      },
      model: { type: 'string', description: 'action:create — i2i model to use when the character is reused' },
      seed: {
        type: 'number',
        description: 'action:create — pin a specific seed for reproducibility (omit to auto-assign)',
      },
      character: { type: 'string', description: 'action:render — the character name or id (from a create call)' },
      prompt: {
        type: 'string',
        description:
          'action:create — generate a first reference portrait from this prompt (omit if using referenceAssetId). action:render — the new scene/pose/action for the character.',
      },
      negativePrompt: { type: 'string', description: 'action:render — what to avoid' },
      aspectRatio: { type: 'string', description: 'Optional aspect ratio' },
    },
    required: ['action'],
  },
}

// Paid AI-generation surface. Handlers are complete (image-video-tools.ts) but these
// schemas were never registered, so the model was told (by the plan_scenes recipe) to
// call generate_image / generate_veo3_video yet was never offered them → no AI imagery.
// Gated at offer time in filterToolsForAgent by category + provider availability.
/**
 * generate_image — text-to-image, image-to-image and re-roll, one tool, one `source`.
 *
 * generate_image_from_reference and regenerate_asset re-declared `model`, `aspectRatio`
 * and `enhanceTags` that this tool already carried; the union declares each once.
 *
 * The NAME is deliberately unchanged. generate_image is the name the plan_scenes recipe,
 * the director loop, the media-sourcing rule pack and the composing-a-media-scene chain
 * all point the model at, and a schema that was never registered under this exact name is
 * a phantom-tool outage (the handler exists, the tool is never offered, and every
 * imagery brief silently falls back to CSS). Keeping it costs nothing
 * and removes a whole class of stale-prose risk.
 *
 * The three sources still run their ORIGINAL handlers untouched — the merge only maps
 * `source` back to the old op name — so each keeps its own permission gate, its own
 * enrichPermission payload, its provenance/lineage writes and its place in
 * MEDIA_GEN_TOOL_SET (the 180s tier that stops a billed i2i round-trip being rolled back
 * and re-billed on retry).
 */
export const GENERATE_IMAGE: ClaudeToolDefinition = {
  name: 'generate_image',
  description: `Generate an AI image. The primary way to add photographic / illustrated / rendered imagery a scene needs (a still CSS can't draw). Persists to the media library for reuse. One paid image — image generation permission is required. Prefer media_library first if a matching image may already exist.
source:'prompt' (default) — a NEW image from text, placed in sceneId.
source:'reference' — image-to-image conditioned on a library image (referenceAssetId), for "in the style of [image X]" or an uploaded mood board. The reference is recorded in provenance. The primary lever for style-consistency across scenes: feed every generation the same reference.
source:'regenerate' — retry a prior generated asset (assetId) with optional overrides, recording parentAssetId so the library shows lineage. Use for "try again", "make it sharper", or to compare models on one prompt. Images only.`,
  input_schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['prompt', 'reference', 'regenerate'],
        description: 'Where the image comes from. Default "prompt".',
      },
      sceneId: { type: 'string', description: 'source:prompt — target scene id to place the image in' },
      prompt: {
        type: 'string',
        description:
          'What the image should depict (subject, style, composition, lighting). Required for prompt and reference; on regenerate use promptOverride instead.',
      },
      referenceAssetId: { type: 'string', description: 'source:reference — asset id of the reference image' },
      assetId: { type: 'string', description: 'source:regenerate — the parent asset id to retry' },
      promptOverride: { type: 'string', description: 'source:regenerate — replace the original prompt' },
      model: {
        type: 'string',
        description:
          'Optional image model: "flux-schnell" (cheap default), "flux-1.1-pro", "ideogram-v3", "recraft-v3", "stable-diffusion-3", "dall-e-3".',
      },
      aspectRatio: { type: 'string', description: 'Optional: "1:1" (default) | "16:9" | "9:16" | "4:3" | "3:4"' },
      style: { type: 'string', description: 'source:prompt — style descriptor folded into the prompt' },
      negativePrompt: { type: 'string', description: 'source:prompt — what to avoid' },
      enhanceTags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'source:reference / regenerate — enhancement tags (quality, lighting, mood, style, medium, camera)',
      },
      removeBackground: {
        type: 'boolean',
        description: 'source:prompt — cut out the background for a transparent PNG (a second paid step ~$0.01)',
      },
      mode: {
        type: 'string',
        enum: ['image', 'sticker'],
        description:
          "source:prompt — 'sticker' = a clean cut-out sticker/icon on a transparent PNG (illustration style + background removal, recraft-v3 default). Default 'image'.",
      },
    },
    required: ['prompt'],
  },
}

export const GENERATE_VEO3_VIDEO: ClaudeToolDefinition = {
  name: 'generate_veo3_video',
  description: `Generate an AI VIDEO clip (Veo 3 / Kling / Runway / Seedance …) and place it as a video layer. ASYNC by design: returns immediately with status 'generating' and an operationName; a background worker fills the clip into the timeline in 2-10 min. Do NOT loop the poller — continue building the rest of the scene; call get_status (kind video) at most ONCE if you specifically need the final URL this turn. For image-to-video, pass imageUrl (e.g. a still from generate_image) so motion matches the look. Paid — video generation permission is required. NOTE: a video layer forces the slower legacy export path, and exporting BEFORE the clip finishes yields a black frame.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Target scene id to place the clip in' },
      prompt: { type: 'string', description: 'What the clip should show (subject, motion, camera)' },
      provider: {
        type: 'string',
        description:
          'Optional provider: omit for "auto" (FAL-first, key-aware), or one of veo3, veo31, kling, kling25, seedance, seedance2, ltx, wan, hailuo, runway.',
      },
      aspectRatio: { type: 'string', description: 'Optional: "16:9" (default) | "9:16" | "1:1"' },
      duration: { type: 'number', description: 'Optional clip length in seconds: 5 (default) or 8' },
      imageUrl: {
        type: 'string',
        description:
          'Optional: first-frame image URL for image-to-video (e.g. a generate_image result) so motion matches the still',
      },
      negativePrompt: { type: 'string', description: 'Optional: what to avoid' },
    },
    required: ['sceneId', 'prompt'],
  },
}

export const MEDIA_LIBRARY: ClaudeToolDefinition = {
  name: 'media_library',
  description: `Manage the project's media library. \`action:'query'\` searches uploaded + AI-generated assets BEFORE generating new ones (filter by type/source/promptContains/tag/limit; returns id/thumbnailUrl/prompt/provider). \`action:'tag'\` adds/replaces tags on an asset (mode append|replace). \`action:'import'\` downloads a direct media URL into the library (deduped by SHA256) — use after find_media to persist a chosen result.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['query', 'tag', 'import'], description: 'query | tag | import. Default query.' },
      // query
      type: { type: 'string', enum: ['image', 'video', 'svg'], description: 'query — restrict to one asset type.' },
      source: {
        type: 'string',
        enum: ['upload', 'generated'],
        description: 'query — only uploads or only AI-generated.',
      },
      promptContains: { type: 'string', description: 'query — case-insensitive substring of the stored prompt.' },
      tag: { type: 'string', description: 'query — filter by a user tag.' },
      limit: { type: 'number', description: 'query — 1-50 (default 10).' },
      // tag / import
      assetId: { type: 'string', description: 'tag — asset ID to tag.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'tag/import — tags to attach (max 30).' },
      mode: {
        type: 'string',
        enum: ['append', 'replace'],
        description: 'tag — merge or overwrite tags. Default append.',
      },
      url: { type: 'string', description: 'import — direct media URL (image/video/svg file, not a video page).' },
      name: { type: 'string', description: 'import — display name (defaults to filename).' },
    },
    required: ['action'],
  },
}

export const MEDIA_LIBRARY_TOOLS: ClaudeToolDefinition[] = [
  USE_ASSET_IN_SCENE,
  ADD_WATERMARK,
  MEDIA_LIBRARY,
  GENERATE_IMAGE,
  GENERATE_VEO3_VIDEO,
  CHARACTER,
]

// ── Recording Tools ──────────────────────────────────────────────────────────

/**
 * NOT OFFERED to any agent today, and that is deliberate.
 *
 * `start_recording` is absent from `AGENT_TOOLS['scene-maker']`, and the MCP surface
 * (mcp-adapter.getToolDefinitions) now runs the same filter, so nothing advertises
 * it. It used to be MCP-only via a hand-added `MCP_TOOLS` entry — which was the one
 * path where it could NEVER work: the sole consumer of `world.recordingCommand` is
 * use-agent-run.ts, a renderer hook fed by the in-app run's final state_change, so
 * recording-tools.ts honest-fails every MCP call. Offering it there was pure
 * schema tax plus a wasted turn.
 *
 * The schema + handler stay so re-wiring is a one-line add to the scene-maker array
 * once an in-app trigger exists. Users record via the editor's record control.
 */
export const START_RECORDING: ClaudeToolDefinition = {
  name: 'start_recording',
  description:
    "Request a screen recording. The recording begins when this run COMPLETES (the command dispatches with the final state change) via the native OS screen picker — the agent cannot stop, pause, or monitor it; the user stops it from the editor's record control. Optionally set device toggles and a scene to auto-attach the result to when the user stops the recording.",
  input_schema: {
    type: 'object',
    properties: {
      sourceId: {
        type: 'string',
        description: 'Ignored — source selection always uses the native OS screen picker (getDisplayMedia).',
      },
      sceneId: {
        type: 'string',
        description: 'Scene ID to auto-attach the recorded video to when the user stops the recording',
      },
      micEnabled: { type: 'boolean', description: 'Enable microphone capture (default true)' },
      systemAudioEnabled: { type: 'boolean', description: 'Enable system audio capture (default true)' },
      webcamEnabled: { type: 'boolean', description: 'Enable webcam capture (default false)' },
      fps: { type: 'number', description: 'Preferred capture frame rate (e.g. 30, 60)' },
      resolution: {
        type: 'string',
        enum: ['720p', '1080p', '1440p', '2160p', 'source'],
        description: 'Preferred capture resolution',
      },
    },
    required: [],
  },
}

export const RECORDING_TOOLS: ClaudeToolDefinition[] = [START_RECORDING]

/** Asset / media tools */
export const ASSET_TOOLS: ClaudeToolDefinition[] = [
  PLACE_IMAGE,
  SET_MEDIA_LAYER,
  ...RECORDING_TOOLS,
  ...MEDIA_LIBRARY_TOOLS,
]

/** Global style tools */
/**
 * ask_user — pause the run and ask the user a question, then continue with their
 * answer. Use SPARINGLY: only when you are genuinely blocked on intent you can't
 * infer (ambiguous format/type, a fork the user must decide). One sharp question,
 * options when you can. The run pauses (no tokens burned waiting) and resumes on
 * the answer. Do NOT use it to narrate or for things you can reasonably assume.
 */
export const ASK_USER: ClaudeToolDefinition = {
  name: 'ask_user',
  description:
    'Pause and ask the user ONE clarifying question, then continue once they answer. Use only when genuinely unsure about intent you cannot infer (e.g. the format/type was guessed at low confidence, or a real fork only the user can decide). Provide `options` for a quick pick when the choices are known; free-text is always allowed. Prefer building on a reasonable assumption over asking when you can.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The single, specific question to put to the user.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional quick-pick answers (e.g. ["16:9 explainer", "9:16 short"]). The user can also type free-text.',
      },
      context: { type: 'string', description: 'Optional one-line context for why you are asking.' },
    },
    required: ['question'],
  },
}

export const GLOBAL_TOOLS: ClaudeToolDefinition[] = [SET_STYLE, PLAN_SCENES, ASK_USER]

/** Template tools */
export const TEMPLATE_TOOLS: ClaudeToolDefinition[] = [USE_TEMPLATE]

/**
 * Interactive-only surface, DERIVED from the array above so a second template tool
 * can't be added without inheriting the outputMode gate in filterToolsForAgent.
 * (Hand-typed name lists are exactly how use_template shipped on mp4 runs for
 * months while its own description said "Interactive output mode only".)
 */
export const TEMPLATE_TOOL_NAMES: ReadonlySet<string> = new Set(TEMPLATE_TOOLS.map((t) => t.name))

/** Interaction tools */
export const INTERACTION_TOOLS: ClaudeToolDefinition[] = [
  INTERACTION,
  EDIT_INTERACTION,
  CONNECT_SCENES,
  DEFINE_SCENE_VARIABLE,
]

/** 3D model library tools */
// search_3d_models merged into find_media(kind:'3d').

export const MODEL_LIBRARY_TOOLS: ClaudeToolDefinition[] = []

// search_lottie merged into find_media(kind:'lottie').

/** Export tools */
export const CAPTURE_FRAME: ClaudeToolDefinition = {
  name: 'capture_frame',
  description: `Capture a rendered frame of the scene at a specific time. Returns a PNG/JPEG screenshot of the live preview (what the user sees) alongside a structural text summary of layers, positions, text content, and code issues.
Use this after generating or editing a scene to verify the visual result — layout, typography, colors, element positioning, and animation state at the captured time.
The image is delivered in the tool result; inspect it like any vision input. If the client can't render the scene, the image will be omitted and the summary still returned.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID to capture' },
      time: { type: 'number', description: 'Time in seconds to capture at (0 = start). Defaults to 1 second in.' },
    },
    required: ['sceneId'],
  },
}

/**
 * review — the two review tools, one tool, one `scope`.
 *
 * Both handlers only VALIDATE and return a stub client-action; the real work is a
 * runner-level interception keyed on `clientAction`. The runner still sees the same
 * two clientAction values, so its two interception branches are untouched.
 */
export const REVIEW: ClaudeToolDefinition = {
  name: 'review',
  description: `Look at what you built and judge it. Reports reviewable:false — never a false clean pass — when it cannot honestly review (no scenes, no vision/video engine, or the run cost cap would be exceeded).

scope:'cut' (default) — review the FINISHED CUT as a whole. Captures one representative frame per scene, then runs a single vision pass on pacing, redundancy and continuity across the sequence, returning a structured cut-review brief. Use after a multi-scene build to judge how the scenes read TOGETHER — not individual-scene correctness (that's verify_scene / capture_frame). Still frames + timing; it does not perceive motion or audio.
scope:'motion' — watch ONE scene actually PLAY (needs sceneId). Exports the scene to a short clip (video + audio) and runs a native-video pass judging MOTION (janky easing, mistimed or missing entrances/exits, broken transitions, flash-then-blank, jitter) and AUDIO↔VIDEO SYNC (narration/SFX landing off the on-screen beat). Use after building or editing a scene with animation and/or narration — it perceives what still-frame checks cannot. Degrades to sampled frames + audio-timing text when no native-video engine is available.`,
  input_schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['cut', 'motion'],
        description: "'cut' (default) = the whole video, still frames. 'motion' = one scene, actually playing.",
      },
      sceneId: { type: 'string', description: "scope:'motion' — the scene to watch play. Required for that scope." },
    },
    required: [],
  },
}

export const VERIFY_SCENE: ClaudeToolDefinition = {
  name: 'verify_scene',
  description: `Verify a scene after generating or editing it. Captures the scene state and returns a structured assessment.
MANDATORY: Call this after every add_layer, regenerate_layer, or chart to check your work.
Returns a checklist of: layout quality, text readability, palette adherence, animation presence, and layer completeness.
If issues are found, fix them with patch_layer_code or regenerate_layer before moving to the next scene.`,
  input_schema: {
    type: 'object',
    properties: {
      sceneId: { type: 'string', description: 'Scene ID to verify' },
      time: { type: 'number', description: 'Time in seconds to check at (default: 1s — shows initial animated state)' },
      expectedElements: {
        type: 'array',
        items: { type: 'string' },
        description:
          'List of elements you expect to see (e.g. ["title text", "bar chart", "legend"]). Used to check completeness.',
      },
    },
    required: ['sceneId'],
  },
}

// verify_scene_pedagogy was deleted. Its own description called it "signature
// tool of the Tutor agent", and the Tutor persona is gone — `AgentType` is
// `'scene-maker'` and nothing else (types.ts). It billed ~1.4KB of schema every
// turn to mandate a rubric for an agent that cannot exist. Handler retained in
// pedagogy-tools.ts so historical runs still replay.

export const DESIGN_BRIEF: ClaudeToolDefinition = {
  name: 'design_brief',
  description: `Read or write the project design brief (DESIGN.md). Pass action:'read' to retrieve the current brief, action:'write' (default) to generate and save one.

WRITE: Generate and save a project-specific design brief (DESIGN.md) for this video. Call this BEFORE your first create_scene on any new multi-scene project.

The brief is injected into every scene-authoring turn as the visual spec. Exact token values (hex, px, font name) are copied verbatim into scene code — precision here prevents palette drift across scenes.


The \`content\` string must be a full DESIGN.md: YAML frontmatter with \`colors\` (bg, bg-secondary, text-primary, text-secondary, accent), \`typography\` (display/heading/body/label, each with fontFamily + fontSize + fontWeight + lineHeight), \`spacing\`, \`rounded\` and \`components\` — then prose sections for Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Motion & Camera, Real Objects, Components, and Do's and Don'ts.

Skip writing the brief only when: single isolated scene, editing an existing scene, or a style preset is already active.

READ: Return the current project design brief. Use mid-build to refresh exact token values (hex colors, font names, px sizes) before writing scene code — especially when building scene 3+ and confirming you're still on scene 1's palette.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write'],
        description: "'write' (default) generates and saves the brief; 'read' returns the current brief.",
      },
      content: {
        type: 'string',
        description:
          "action:write — complete DESIGN.md: YAML frontmatter with exact token values (colors, typography, spacing, rounded, components) + markdown sections (Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Motion & Camera, Real Objects, Components, Do's and Don'ts). Honors the Motion Design Contract (light-default bg, color-by-meaning, object depth, sequential beats, no chrome). Derived from first-principles analysis of the prompt — not from a preset.",
      },
      referenceTokens: {
        type: 'object',
        description:
          "Optional structured style tokens from analyze_reference_media (palette, fonts, mood, lighting, composition). When the user attached a reference design to match, pass its styleTokens here to seed the brief and remember them for this project. If omitted, the most recently analyzed reference's tokens are used automatically. The brief's own explicit token values always take precedence — these only fill gaps.",
        properties: {
          palette: { type: 'array', items: { type: 'string' } },
          fonts: { type: 'array', items: { type: 'string' } },
          mood: { type: 'string' },
          lighting: { type: 'string' },
          composition: { type: 'string' },
          subjects: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    required: [],
  },
}

// ── Timeline / Clip Tools ─────────────────────────────────────────────────────

export const INIT_TIMELINE: ClaudeToolDefinition = {
  name: 'init_timeline',
  description:
    'Initialize the NLE timeline from the current scenes. Creates a single video track with one clip per scene. Call this before using clip/track tools. Idempotent — does nothing if timeline already exists.',
  input_schema: { type: 'object', properties: {} },
}

export const READ_TIMELINE: ClaudeToolDefinition = {
  name: 'read_timeline',
  description:
    'Read the current NLE timeline: every track (id, name, type, position, muted/solo/hidden/locked) and its clips (id, sourceType, sourceId, label, startTime, duration), plus defaultVideoTrackId / defaultAudioTrackId. Call this BEFORE place_clip or any clip edit so you place onto the EXISTING default V1/A1 instead of creating a new track each time — add_track is only for genuinely new lanes (e.g. a V2 for stacking).',
  input_schema: { type: 'object', properties: {} },
}

export const ADD_TRACK: ClaudeToolDefinition = {
  name: 'add_track',
  description: 'Add a new track to the timeline. Returns the track ID.',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['video', 'audio', 'image', 'text', 'graphics', 'scene'],
        description: 'Track type. "graphics" replaces the legacy "overlay" kind.',
      },
      name: { type: 'string', description: 'Track name (e.g. "B-Roll", "Narration")' },
    },
    required: ['type'],
  },
}

export const PLACE_CLIP: ClaudeToolDefinition = {
  name: 'place_clip',
  description: `Place a clip on the timeline at a specific time. Sources can be:
- "scene" + sceneId: a generated scene
- "video" + file path: real footage
- "image" + URL: a still image
- "audio" + URL: an audio file
- "title" + text: a text card
OMIT trackId and the software auto-routes the clip to the correct default track —
scene/video/image/title to the lowest free video lane (V1), audio to A1 — spilling
to a new lane (V2/A2) only when it would overlap. Don't add_track + pass a trackId
for the base case; just place the clip. Returns the clip ID.`,
  input_schema: {
    type: 'object',
    properties: {
      trackId: {
        type: 'string',
        description:
          'OPTIONAL. Omit to let the software pick the right default track (recommended). Only pass a specific track id to force a particular lane.',
      },
      sourceType: {
        type: 'string',
        enum: ['scene', 'video', 'image', 'audio', 'title'],
        description: 'What kind of source',
      },
      sourceId: { type: 'string', description: 'Scene ID, file path, URL, or text content' },
      label: { type: 'string', description: 'Display name for the clip' },
      startTime: { type: 'number', description: 'Position on timeline in seconds' },
      duration: { type: 'number', description: 'Clip duration in seconds' },
      trimStart: { type: 'number', description: 'Source in-point (seconds). Default 0.' },
      trimEnd: { type: 'number', description: 'Source out-point (seconds). Omit for full duration.' },
      opacity: { type: 'number', description: 'Clip opacity 0–1. Default 1.' },
    },
    required: ['sourceType', 'sourceId', 'startTime', 'duration'],
  },
}

/**
 * clip — the six clip verbs, one tool, one `op`.
 *
 * move / trim / split / remove / props / slip all keyed solely on `clipId` and all
 * dispatch into the SAME timeline handler; `slip` even writes the same
 * trimStart/trimEnd and emits the same `clip/trim` action as `trim`. Six schemas
 * declaring the same clipId head was the split a model picks wrong.
 *
 * The handler maps `op` back to its ORIGINAL internal case, so every overlap guard,
 * finite-check, write-through and emitted action stays byte-identical.
 */
export const CLIP: ClaudeToolDefinition = {
  name: 'clip',
  mutates: 'scene',
  description: `Edit a clip on the timeline. Every op takes the clipId (from read_timeline).

op:'move' — move it to a different track and/or time (toTrackId + startTime). An overlap on a video/scene track is refused; on an audio track it spills to a free lane.
op:'trim' — set the in/out points and/or playback duration (trimStart / trimEnd / duration).
op:'slip' — shift the SOURCE window by offsetSeconds without moving the clip on the timeline: duration and position are unchanged, only which part of the source plays.
op:'split' — cut it in two at atTime (relative to the clip's start). Returns the ids of the left and right halves.
op:'remove' — RIPPLE-delete it: later clips on the same track shift left to close the gap. Use this for silence, unwanted segments, anything where an empty gap would break the edit.
op:'props' — set fades / blend mode / a visual filter. Fades and blend and filters render in the editor preview but are NOT yet rendered in the MP4 export. To change how long the clip occupies the timeline use op:'trim' or scene_props(op:'duration').`,
  input_schema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['move', 'trim', 'slip', 'split', 'remove', 'props'],
        description: 'Which edit to make.',
      },
      clipId: { type: 'string', description: 'The clip to edit. Required for every op.' },
      toTrackId: { type: 'string', description: "op:'move' — destination track ID." },
      startTime: { type: 'number', description: "op:'move' — new start time on the timeline (seconds)." },
      trimStart: { type: 'number', description: "op:'trim' — source in-point (seconds)." },
      trimEnd: { type: 'number', description: "op:'trim' — source out-point (seconds). Null for end of source." },
      duration: { type: 'number', description: "op:'trim' — new playback duration (seconds)." },
      offsetSeconds: {
        type: 'number',
        description: "op:'slip' — seconds to shift the source window (positive = later in the source).",
      },
      atTime: { type: 'number', description: "op:'split' — time relative to the clip's start (seconds)." },
      rightClipId: {
        type: 'string',
        description: "op:'split' — optional explicit id for the right half (planned multi-step edits pre-name it).",
      },
      fadeIn: {
        type: 'number',
        description:
          "op:'props' — fade-in seconds (0 clears). Must be <= duration; fadeIn + fadeOut must not exceed it.",
      },
      fadeOut: { type: 'number', description: "op:'props' — fade-out seconds (0 clears). Same bounds as fadeIn." },
      blendMode: {
        type: 'string',
        enum: [
          'normal',
          'multiply',
          'screen',
          'overlay',
          'darken',
          'lighten',
          'color-dodge',
          'color-burn',
          'hard-light',
          'soft-light',
          'difference',
          'exclusion',
          'add',
          'subtract',
          'luminosity',
          'saturation',
        ],
        description: "op:'props' — how the clip composites with layers below it.",
      },
      filter: {
        type: 'object',
        description:
          "op:'props' — add/replace a filter with { filterType, value }, or REMOVE it with { filterType } / value:null. Ranges: blur 0-20px, brightness/contrast/saturate 0-3 (1 = normal), grayscale/sepia 0-1, hue-rotate 0-360.",
        properties: {
          filterType: {
            type: 'string',
            enum: ['blur', 'brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'hue-rotate'],
            description: 'Filter type',
          },
          value: { type: 'number', description: 'Filter value; omit or null to REMOVE this filter.' },
        },
        required: ['filterType'],
      },
    },
    required: ['op', 'clipId'],
  },
}

export const KEYFRAME: ClaudeToolDefinition = {
  name: 'keyframe',
  mutates: 'scene',
  description: `Set or remove a keyframe on a clip property. action:'set' upserts a keyframe (the compositor interpolates between keyframes for smooth animation); action:'remove' deletes the keyframe matching property + time.
Properties: x, y, scaleX, scaleY, opacity, rotation, speed. Speed keyframes create speed ramps (slow-mo transitions).
Keyframes render in the editor preview but are not yet rendered in the MP4 export.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'remove'],
        description: "'set' upserts a keyframe, 'remove' deletes one",
      },
      clipId: { type: 'string', description: 'Clip to keyframe' },
      property: {
        type: 'string',
        enum: ['x', 'y', 'scaleX', 'scaleY', 'opacity', 'rotation', 'speed'],
        description: 'Property to animate',
      },
      time: { type: 'number', description: 'Time relative to clip start (seconds)' },
      value: { type: 'number', description: "Value at this keyframe (required for action:'set')" },
      easing: {
        type: 'string',
        enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out'],
        description: "Easing curve to this keyframe (action:'set'). Default: linear.",
      },
    },
    required: ['action', 'clipId', 'property', 'time'],
  },
}

// slip_edit merged into clip(op:'slip') — see CLIP above.

// ── Tool defs added for the new reducers ─────────────────────────
// Each maps 1:1 to a reducer in src/lib/actions/reducers/. Names follow the
// existing camelCase/snake_case mix already established in TIMELINE_TOOLS.

export const REMOVE_TRACK: ClaudeToolDefinition = {
  name: 'remove_track',
  description:
    'Remove a track from the timeline. Drops every clip on it. Use with care — undoable but the inverse only re-adds the empty track; clips must be re-added separately.',
  input_schema: {
    type: 'object',
    properties: {
      trackId: { type: 'string', description: 'Track to remove' },
    },
    required: ['trackId'],
  },
}

export const SET_TRACK_PROPS: ClaudeToolDefinition = {
  name: 'set_track_props',
  mutates: 'project',
  description: `Set one or more properties on a track in a single call. Pass only the fields you want to change.
- locked: locked tracks reject add/move/trim/remove on their clips.
- muted: mute/unmute at playback / export time.
- solo: when any track is soloed, all non-solo tracks are silenced/hidden during playback.
- hidden: hide/show in the preview (hidden tracks still exist, just not rendered).
- volume: mixer fader (LINEAR gain 0..2, 1 = unity / 0 dB, max 2 = +6 dB). Rejected on a locked track.
- pan: stereo pan -1 (hard left) … 0 (center) … +1 (hard right). Rejected on a locked track.`,
  input_schema: {
    type: 'object',
    properties: {
      trackId: { type: 'string', description: 'Track to modify' },
      locked: { type: 'boolean', description: 'true = lock, false = unlock' },
      muted: { type: 'boolean', description: 'true = mute, false = unmute' },
      solo: { type: 'boolean', description: 'true = solo, false = unsolo' },
      hidden: { type: 'boolean', description: 'true = hide, false = show' },
      volume: { type: 'number', description: 'Linear gain 0..2 (1 = unity / 0 dB)' },
      pan: { type: 'number', description: 'Pan -1 (left) … 0 (center) … +1 (right)' },
    },
    required: ['trackId'],
  },
}

// apply_color_grade merged into apply_color's `look` / `lookIntensity` — see below.

export const APPLY_COLOR: ClaudeToolDefinition = {
  name: 'apply_color',
  description:
    "The colour tool for a clip: grade video/image clips, or a media-asset scene (a video/image dropped on the timeline). Either pick a named `look`, or set individual controls. Calls MERGE into the clip's existing grade — anything you don't pass is kept, so small follow-up tweaks are cheap; reset:true starts from neutral. The grade is rendered inside the compositor, so preview and export match. Primaries, temperature/tint, wheels and curves work on media and scene clips. LUTs and hue curves need a GPU pass that only runs on VIDEO/IMAGE clips; on a scene those parts are skipped and the result tells you. Undoable; every control is optional. Wheels take a HUE in degrees plus an AMOUNT for each tonal range (e.g. teal shadows: shadowsHue 180, shadowsAmount ~0.15). Curves shape tone for the master or a single R/G/B channel. Hue curves adjust one source hue's hue/saturation/lightness without a mask. A LUT adds a .cube look last. There is no way to read scopes back, so decide the look up front and set the controls to reach it.",
  input_schema: {
    type: 'object',
    properties: {
      clipIds: { type: 'array', items: { type: 'string' }, description: 'Clip ids from read_timeline.' },
      look: {
        type: 'string',
        enum: ['none', 'cinematic', 'warm', 'cool', 'noir', 'faded', 'vivid'],
        description:
          "Apply a NAMED look instead of hand-setting knobs — the fast path. Composed from the standard clip filters, so it shows in preview and exports identically; replaces any previous look and leaves manual blur/blend alone. 'none' clears it. Pass `look` alone; the colorist knobs below are the other path.",
      },
      lookIntensity: {
        type: 'number',
        description: 'Strength of `look`, 0-1 (default 1). 0.4 = subtle.',
      },
      reset: {
        type: 'boolean',
        description: 'Start from neutral instead of merging onto the current grade. Default false.',
      },
      exposure: { type: 'number', description: '-3…3 EV. Overall brightness.' },
      contrast: { type: 'number', description: '0.5…1.5 (1 = neutral).' },
      saturation: { type: 'number', description: '0…2 (1 = neutral; <1 mutes).' },
      vibrance: { type: 'number', description: '-1…1 (protects skin tones).' },
      temperature: { type: 'number', description: '2000…11000 K. HIGHER = WARMER (6500 = neutral).' },
      tint: { type: 'number', description: '-100…100. Positive = green, negative = magenta.' },
      highlights: { type: 'number', description: '-1…1. Recover (<0) or lift (>0) highlights.' },
      shadows: { type: 'number', description: '-1…1. Lift (>0) or deepen (<0) shadows.' },
      blacks: { type: 'number', description: '-1…1. Black point. Negative deepens, positive lifts (faded).' },
      whites: { type: 'number', description: '-1…1. White point.' },
      shadowsHue: {
        type: 'number',
        description: 'Shadow color-push hue 0–360° (0 red, 120 green, 180 cyan, 240 blue). Use with shadowsAmount.',
      },
      shadowsAmount: { type: 'number', description: '0…1 strength of the shadow color push.' },
      shadowsLum: { type: 'number', description: '-0.5…0.5 shadow lift (brightness).' },
      midsHue: { type: 'number', description: 'Midtone color-push hue 0–360°. Use with midsAmount.' },
      midsAmount: { type: 'number', description: '0…1 strength of the midtone color push.' },
      midsGamma: { type: 'number', description: '0.5…2 midtone brightness (gamma; 1 = neutral).' },
      highsHue: { type: 'number', description: 'Highlight color-push hue 0–360°. Use with highsAmount.' },
      highsAmount: { type: 'number', description: '0…1 strength of the highlight color push.' },
      highsGain: { type: 'number', description: '0.5…1.5 highlight brightness (gain; 1 = neutral).' },
      masterCurve: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        description:
          'Luma tone curve as [x,y] points in 0–1 (input→output). E.g. [[0,0.06],[1,0.95]] = faded film toe.',
      },
      redCurve: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        description: 'Red-channel tone curve, [x,y] points 0–1.',
      },
      greenCurve: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        description: 'Green-channel tone curve, [x,y] points 0–1.',
      },
      blueCurve: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        description: 'Blue-channel tone curve, [x,y] points 0–1 (e.g. pull blue in highlights to tame a sky).',
      },
      hueCurves: {
        type: 'object',
        description:
          'Hue-selective correction: pick a source hue and change its hue, saturation or lightness (affects hues within about ±22°). Passing targets replaces any hue curves already on the clip.',
        properties: {
          targets: {
            type: 'array',
            description: 'Source-hue regions to adjust (e.g. skin at 30, sky at 210).',
            items: {
              type: 'object',
              properties: {
                targetHue: {
                  type: 'number',
                  description: 'Source hue to act on, 0–360° (30 = skin/orange, 210 = sky-blue).',
                },
                hueShift: { type: 'number', description: 'Rotate that hue by -30…30°.' },
                satScale: { type: 'number', description: 'Saturation multiplier 0–2 (1 = neutral; 0 = desaturate).' },
                lumShift: { type: 'number', description: 'Lightness shift -0.5…0.5.' },
              },
              required: ['targetHue'],
            },
          },
        },
      },
      lut: {
        type: 'object',
        description: 'Apply a .cube 3D LUT on top of the primary grade; replaces any prior LUT. Pass a real file path.',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to a .cube file (~ expanded). Copied into project storage.',
          },
          strength: {
            type: 'number',
            description: '0–1 blend intensity. Default 1. Pass strength alone (no path) to re-blend the existing LUT.',
          },
        },
      },
      vignette: { type: 'number', description: '0…1 darkened-edge vignette.' },
    },
    required: ['clipIds'],
  },
}

// inspect_color was deleted: it could never measure anything. The handler only
// returns scopes when a `__rgba` pixel buffer rides in on the args, nothing in
// the repo ever writes that key, and the schema above exposed no parameter to
// pass one — so every call fell through to `needsCapture: true`, telling the
// model to "call inspect_color again with the RGBA pixel buffer" via an
// argument that does not exist. It sold a grading loop that could not close.
// Handler retained in timeline-tools.ts; apply_color still grades, blind as it
// always actually was. Re-add with a real capture path, not before.

// cut_by_transcript merged into auto_cut(mode:'transcript') — see AUTO_CUT.

export const MARKER: ClaudeToolDefinition = {
  name: 'marker',
  description: `Add or remove a timeline marker. action:'add' drops a marker on the ruler at a time (seconds) — markers are navigation aids and snap targets (flag section starts, beats to hit, spots needing attention); returns the new marker id. action:'remove' deletes a marker by id.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'remove'],
        description: "'add' drops a marker, 'remove' deletes one by id",
      },
      time: { type: 'number', description: "Marker time in seconds from timeline start (action:'add')" },
      label: { type: 'string', description: "Optional short label shown next to the marker (action:'add')" },
      color: { type: 'string', description: "Optional hex color, defaults to the accent (action:'add')" },
      markerId: { type: 'string', description: "Marker to remove (action:'remove')" },
    },
    required: ['action'],
  },
}

export const SET_MASTER_VOLUME: ClaudeToolDefinition = {
  name: 'set_master_volume',
  mutates: 'project',
  description:
    "Set the program MASTER volume (the mixer's Master fader) — scales the whole mix. LINEAR gain: 1 = unity (0 dB), 0 = silent, max 2 = +6 dB. Use for 'make the whole video quieter'.",
  input_schema: {
    type: 'object',
    properties: { volume: { type: 'number', description: 'Linear gain 0..2 (1 = unity / 0 dB)' } },
    required: ['volume'],
  },
}

export const ADD_CAPTIONS: ClaudeToolDefinition = {
  name: 'add_captions',
  description: `Transcribe a clip's audio and add SRT subtitles as text clips on a subtitles track. Uses the configured transcriber (Whisper API by default; whisper.cpp opt-in via Settings → Audio → Caption privacy mode).
The engine returns a deterministic plan: one track/add (when no subtitles track is supplied) + one clip/add per cue. Each cue is rebased onto the global timeline using the parent clip's startTime/trimStart/speed and clipped into the parent's range. Empty cues are dropped.
Use preview:true to inspect the plan before committing.`,
  input_schema: {
    type: 'object',
    properties: {
      clipId: { type: 'string', description: 'Clip whose audio to transcribe' },
      subtitlesTrackId: {
        type: 'string',
        description: 'Existing subtitles track id. Omit to create a new text track for the captions.',
      },
      language: {
        type: 'string',
        description: 'ISO 639-1 code (e.g. "en", "es"). Omit to auto-detect.',
      },
      prompt: {
        type: 'string',
        description: 'Optional prompt hint for the transcriber (domain terms, name spellings).',
      },
      preview: {
        type: 'boolean',
        description: 'When true, return the plan without dispatching. Default false.',
      },
    },
    required: ['clipId'],
  },
}

/**
 * auto_cut — the two automatic-cut tools, one tool, one `mode`.
 *
 * auto_cut_silence and cut_by_transcript are the same skeleton: analyse a clip's
 * audio, produce a deterministic split + ripple-delete plan, dispatch it through the
 * existing action layer (so undo / action_log work for free), and honour `preview`.
 * They differ only in WHAT they look for. Each mode runs its original handler case.
 */
export const AUTO_CUT: ClaudeToolDefinition = {
  name: 'auto_cut',
  mutates: 'scene',
  description: `Cut parts out of a clip automatically by analysing its audio, then splitting + ripple-deleting. Both modes return the plan (what would be cut, and how many seconds it saves) — run with preview:true first so the user can inspect it before you commit.

mode:'silence' (default) — remove dead air. Detects silent regions by RMS level. Default threshold -40 dBFS matches the CapCut convention; go lower (-50) for quiet podcasts, higher (-30) for music-bed mixes. Typical use: screen recordings and talking-head shots.
mode:'transcript' — remove the part where specific words are SPOKEN ("cut the bit where I say X"). Transcribes the clip, matches the text case/punctuation-insensitively (a match may span captions), and ripple-deletes the matched spans. Precision follows the transcriber: word-level when word timestamps exist (Whisper API), else cue-level (a match removes its whole caption span).`,
  input_schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['silence', 'transcript'],
        description: "What to cut. Default 'silence'.",
      },
      clipId: { type: 'string', description: 'Video/audio clip to analyse + cut.' },
      preview: {
        type: 'boolean',
        description: 'true = report what WOULD be cut without dispatching. Default false. Recommended first.',
      },
      threshold: {
        type: 'number',
        description: "mode:'silence' — dBFS below which audio counts as silent. Default -40.",
      },
      minSilenceMs: {
        type: 'number',
        description: "mode:'silence' — minimum silence length in ms before it gets cut. Default 250.",
      },
      text: { type: 'string', description: "mode:'transcript' — the spoken words to remove, as the user said them." },
      language: {
        type: 'string',
        description: "mode:'transcript' — optional source-language hint (en, es, ...).",
      },
      prompt: { type: 'string', description: "mode:'transcript' — optional domain-phrasing hint for the transcriber." },
      padSeconds: {
        type: 'number',
        description: "mode:'transcript' — padding around each cut span in seconds. Default 0.05.",
      },
    },
    required: ['clipId'],
  },
}

export const SYNC_AUDIO: ClaudeToolDefinition = {
  name: 'sync_audio',
  description: `Align one or more clips to a reference clip by cross-correlating their audio, then shift the targets on the timeline so the sound lines up. The reference clip stays put. Use for dual-system sound (camera + a separate audio recorder of the same take) or multicam (several cameras of one moment).
The configured PCM decoder reads each clip's audio, the engine builds short-time energy envelopes and finds the lag with the highest normalized cross-correlation, then converts that lag into a clip move on the target (so undo / action_log / linked-clip siblings work for free). Each target returns offsetSeconds + a confidence (0–1). Weak matches are REFUSED rather than guessed — if confidence is below minConfidence (default 0.5) the clip is left where it is and reported in failed[].
Tip: put the follower on its own track before syncing if it currently shares the reference's track.`,
  input_schema: {
    type: 'object',
    properties: {
      referenceClipId: { type: 'string', description: 'Clip the others align to. Stays put.' },
      targetClipId: { type: 'string', description: 'Single clip to align. Use targetClipIds for several.' },
      targetClipIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Clips to align with the reference.',
      },
      searchWindowSeconds: {
        type: 'number',
        description: 'Max ± offset to search, in seconds. Default 30.',
      },
      minConfidence: {
        type: 'number',
        description: 'Minimum correlation confidence 0–1. Default 0.5; below this a clip is refused.',
      },
      preview: {
        type: 'boolean',
        description: 'When true, compute + report offsets without moving any clip. Default false.',
      },
    },
    required: ['referenceClipId'],
  },
}

export const AUTO_REFRAME: ClaudeToolDefinition = {
  name: 'auto_reframe',
  description: `Track the dominant subject (face/body) across a video clip and emit a sequence of position keyframes that keep the subject roughly centered in the project canvas. Uses the configured FrameDetector (MediaPipe face+pose under the hood) to sample detections, EMA-smooths the centroid, downsamples to at most maxKeyframes (default 12), then materialises a plan of keyframe/add actions on the clip's x/y properties.
The compositor honours keyframed clip position directly — no extra effect node is required. The detector reads the same source URI as the PCM decoder (dreambyte:// or absolute path). Use preview:true to inspect the planned keyframes before dispatch.`,
  input_schema: {
    type: 'object',
    properties: {
      clipId: { type: 'string', description: 'Clip to reframe' },
      maxKeyframes: {
        type: 'number',
        description:
          'Maximum keyframes per axis. Default 12. Lower = simpler camera path; higher = more responsive tracking.',
      },
      smoothing: {
        type: 'number',
        description: 'EMA smoothing factor 0..1. Higher = more responsive, lower = smoother. Default 0.25.',
      },
      minConfidence: {
        type: 'number',
        description: 'Drop detections below this confidence (0..1). Default 0.5.',
      },
      fps: {
        type: 'number',
        description: 'Detection fps cap. Default 6.',
      },
      preview: {
        type: 'boolean',
        description: 'When true, return the plan without dispatching. Default false (dispatches immediately).',
      },
    },
    required: ['clipId'],
  },
}

export const TIMELINE_TOOLS: ClaudeToolDefinition[] = [
  INIT_TIMELINE,
  READ_TIMELINE,
  ADD_TRACK,
  REMOVE_TRACK,
  SET_TRACK_PROPS,
  APPLY_COLOR,
  MARKER,
  SET_MASTER_VOLUME,
  PLACE_CLIP,
  CLIP,
  KEYFRAME,
  AUTO_CUT,
  ADD_CAPTIONS,
  AUTO_REFRAME,
  SYNC_AUDIO,
]

export const EXPORT_TOOLS: ClaudeToolDefinition[] = [EXPORT, GET_STATUS]

// ── Physics Tools ──────────────────────────────────────────────────────────

// The PHYSICS tool family (generate_physics_scene / explain_physics_concept /
// annotate_simulation / set_simulation_params) was DELETED. It gated on a `physics`
// chip that is group:'auto', and only group:'panel' chips render in the UI — so no
// user action could ever turn it on. Dead weight, not a capability.

// world_scene was DELETED: zero calls across 1,051 recorded tool calls, and at
// 4,781 bytes it was one of the two largest schemas on the surface.

// ── SVG-to-3D Extrusion Tool ────────────────────────────────────────────────

// ── Three.js Post-FX + Stage Environment Tools ──────────────────────────────

// ── Style Skill Tools ────────────────────────────────────────────────────────
//
// search_skills / load_skill / list_skill_categories lived here. They were the
// model-elective door to `src/lib/skills/library/` — which selectSkillsForScene already
// injects into every builder, keyed on the scene's own type and visual form. Across
// 36 recorded runs / 1,039 tool calls they were called 5 times, and the only skill
// string in a 437 KB director transcript is the injected "do NOT call load_skill for
// it again". A door onto a room the agent is already standing in, billed every turn.

/**
 * style_skill — one tool for the saved-style lifecycle. distill_style /
 * apply_saved_style / delete_style_skill were three verbs over one noun, and each
 * re-stated the same context ("a distilled style, category 'style', id from
 * distill_style") in its own description. Zero calls across 1,051 recorded tool
 * calls, so nothing to regress; the required-arg rules that were in three separate
 * `required` blocks now live in the handler, which errors per action.
 */
export const STYLE_SKILL: ClaudeToolDefinition = {
  name: 'style_skill',
  description: `Save, reuse and remove a project's LOOK as a reusable "style" skill.
'distill' — turn the CURRENT project's finished scenes (palette, fonts, renderer, camera moves, motion, preset) into a named style. A learning step AFTER a build, not a build step; re-running overwrites the prior one. The result auto-applies to future builds it matches.
'apply' — apply one style WHOLESALE, via skillId (a distilled style) or presetId (a built-in). Style is otherwise composed fluidly per facet, so use this ONLY when the user asks for one look as-is ("use my Editorial Calm style", "use the kraft preset").
'delete' — remove a distilled style by id; curated/built-in skills are refused.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['distill', 'apply', 'delete'],
        description: 'Which operation to run.',
      },
      skillId: { type: 'string', description: 'apply/delete — id of a distilled style. apply: not with presetId.' },
      presetId: { type: 'string', description: 'apply — built-in preset id, e.g. "kraft"; "none" clears it.' },
      projectId: { type: 'string', description: 'distill — defaults to the current project.' },
      name: { type: 'string', description: 'distill — name for the style. Auto-named if omitted.' },
      notes: { type: 'string', description: 'distill — what makes it distinctive, to steer the description.' },
    },
    required: ['action'],
  },
}

export const SKILL_TOOLS: ClaudeToolDefinition[] = [STYLE_SKILL]

/**
 * Patch hardcoded 1920/1080 dimension references in tool descriptions
 * to match the project's actual dimensions.
 * Returns a shallow clone of the tools array with updated descriptions.
 */
export function patchToolDimensions(
  tools: ClaudeToolDefinition[],
  W: number = 1920,
  H: number = 1080,
): ClaudeToolDefinition[] {
  if (W === 1920 && H === 1080) return tools
  return tools.map((tool) => {
    // Server tools (Anthropic native) have no input_schema to patch.
    if (!tool.input_schema) return tool
    const json = JSON.stringify(tool.input_schema)
    if (!json.includes('1920') && !json.includes('1080')) return tool
    // Match both en-dash (\u2013) and hyphen-minus (-) variants
    const patched = json.replace(/0[\u2013\-]1920/g, `0\u2013${W}`).replace(/0[\u2013\-]1080/g, `0\u2013${H}`)
    return { ...tool, input_schema: JSON.parse(patched) }
  })
}

/**
 * Patch get_routed_craft's `pack` argument with the LIVE enum of loadable pack ids.
 *
 * What packs exist is data on disk, so a hand-typed list guarantees drift — and it had
 * drifted, leaving packs on disk that the model had no way to ask for. Applied at
 * context-build time, next to patchToolDimensions,
 * because reading the rules directory is server-side I/O that must not run at module
 * scope in this file.
 *
 * It used to write a PROSE menu — one `- "id" — <trigger>` line per pack, 1,824 bytes
 * on every turn of every agent — on the theory that the model needs the trigger text to
 * choose. Across 36 recorded runs / 1,039 tool calls the model called this tool ONCE, so
 * that budget bought nothing. An enum is ~a fifth the size, keeps every pack on disk
 * reachable BY CONSTRUCTION (an unlisted id is now a schema violation, not a silent
 * miss), and can name the three-* subtopics that three.md tells the model to ask for.
 */
export function patchRoutedCraftMenu(tools: ClaudeToolDefinition[], packIds: string[]): ClaudeToolDefinition[] {
  if (packIds.length === 0) return tools
  return tools.map((tool) => {
    if (tool.name !== 'get_routed_craft' || !tool.input_schema) return tool
    const schema = tool.input_schema as { properties?: Record<string, object> }
    if (!schema.properties?.pack) return tool
    return {
      ...tool,
      input_schema: {
        ...tool.input_schema,
        properties: { ...schema.properties, pack: { ...schema.properties.pack, enum: packIds } },
      },
    }
  })
}

/**
 * The manual door to a craft pack — the escape hatch, not the main road.
 *
 * A builder's own renderer craft is injected from PLAN STATE (see
 * selectSkillsForScene / renderDirectorSkillGuides), so nothing routine needs this
 * tool. It stays for the case state can't see: a deep-dive topic (`three`),
 * or an agent editing a scene the plan never typed. The routing arguments it used to
 * carry (videoType / aspectRatio / voiceDriver / mediaStrategy / …) are gone — the
 * handler already falls back to the project's stored brief, and no recorded run ever
 * passed one. Handler registered via OKF_TOOL_NAMES in tool-executor.ts.
 */
export const GET_ROUTED_CRAFT: ClaudeToolDefinition = {
  name: 'get_routed_craft',
  description:
    "Load one technical craft pack's full rules on demand (renderer API, audio mix, media sourcing). Your renderer's craft is already in this prompt — reach for this only for a topic you were NOT given. Omit `pack` to get every pack routed by the project's brief. How-to references only; aesthetic decisions are yours.",
  input_schema: {
    type: 'object',
    properties: {
      pack: { type: 'string', description: 'Pack id.' },
    },
  },
}

/**
 * Set the project's aspect ratio (e.g. 9:16 vertical for TikTok) so scenes render
 * and export at that shape. Persists to the project — call it BEFORE building scenes.
 * Handler registered via OKF_TOOL_NAMES in tool-executor.ts.
 */
export const SET_ASPECT_RATIO: ClaudeToolDefinition = {
  name: 'set_aspect_ratio',
  description:
    "Set the PROJECT's aspect ratio so every scene renders and exports at that shape. Call this BEFORE building scenes whenever the video isn't landscape 16:9 — e.g. a vertical TikTok/Reel/Short is 9:16. The routed craft / brief tells you the target format; apply it here so the project is actually vertical (not letterboxed).",
  input_schema: {
    type: 'object',
    properties: {
      aspectRatio: {
        type: 'string',
        enum: ['16:9', '9:16', '1:1', '4:5'],
        description: '16:9 landscape · 9:16 vertical (TikTok/Reels/Shorts) · 1:1 square · 4:5 portrait.',
      },
    },
    required: ['aspectRatio'],
  },
}

/** All tools combined */
export const ALL_TOOLS: ClaudeToolDefinition[] = [
  ...SCENE_TOOLS,
  ...LAYER_TOOLS,
  ...ELEMENT_TOOLS,
  ...ASSET_TOOLS,
  ...AUDIO_TOOLS,
  ...GLOBAL_TOOLS,
  ...TEMPLATE_TOOLS,
  ...INTERACTION_TOOLS,

  ...EXPORT_TOOLS,
  ...TIMELINE_TOOLS,
  CAPTURE_FRAME,
  REVIEW,
  VERIFY_SCENE,
  DISPATCH_SCENE_BUILDER,
  DISPATCH_SUBAGENT,
  DISPATCH_TO_BRANCHES,
  DISPATCH_TO_PROJECTS,
  WRITE_PLAN,
  UPDATE_TODOS,
  // design_brief is offered to scene-maker (AGENT_TOOLS) and the prompt mandates
  // it as the FIRST action — it MUST be canonical here or executeTool returns
  // "Unknown tool" and aborts the run's first call. Handler is registered via
  // DESIGN_SYSTEM_TOOL_NAMES in tool-executor.ts.
  DESIGN_BRIEF,
  // OKF intent-routing as a tool — knowledge parity for the MCP / Claude Code path.
  GET_ROUTED_CRAFT,
  // Make routed intent real: set the project to the brief's aspect ratio (vertical, etc).
  SET_ASPECT_RATIO,
  ...SKILL_TOOLS,
  ...RESEARCH_TOOLS,
  // Canonical so executeTool recognizes it; intentionally NOT in any AGENT_TOOLS list —
  // the context-builder injects it dynamically only when withholding web search for approval.
  REQUEST_WEB_SEARCH,
  // Tool-gap flywheel: agent self-reports missing/broken tools to the team.
  SEND_FEEDBACK,
]

/**
 * Deduplicate tools by name AND drop any tagged `deprecated: true`.
 *
 * Any future deprecated tool stays in `ALL_TOOLS` (so the dispatch registry
 * resolves it when older scripts / replaying conversations issue the old
 * name) but gets pruned out of every OFFERED list here — both the curated
 * per-agent subsets and the fallback below. Effect: schema-token cost paid
 * on every prompt drops, and agents stop being offered redundant tools that
 * compete for selection. (the previously tagged tools are gone —
 * animate_ai_layer, style_scene — outright; the mechanism stays for the
 * next deprecation cycle.)
 */
function dedup(tools: ClaudeToolDefinition[]): ClaudeToolDefinition[] {
  const seen = new Set<string>()
  return tools.filter((t) => {
    if (t.deprecated) return false
    if (seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
}

/**
 * Fallback offering for agent types WITHOUT a curated AGENT_TOOLS entry
 * (sub-agent personas, CLI agent types). Previously these fell back to the
 * raw ALL_TOOLS registry, which skips dedup's pruning — so deprecated tools
 * and name dupes leaked into their prompts. Every offered
 * surface now goes through dedup; raw ALL_TOOLS remains dispatch-only.
 */
export const FALLBACK_AGENT_TOOLS: ClaudeToolDefinition[] = dedup(ALL_TOOLS)

/**
 * Tools that only make sense for the PARENT run. Inside a
 * sub-agent these are dead weight or worse:
 *   - dispatch_subagent: hard-rejected MID-RUN (runner intercepts before
 *     executeTool → subagent-dispatch.ts recursion guard returns a clear
 *     {success:false}).
 *   - dispatch_scene_builder / dispatch_to_branches / dispatch_to_projects:
 *     their HANDLERS return false-success for a sub-agent — the real gates
 *     (runner.ts shouldHandoffToOrchestrator / shouldFanOutToBranches /
 *     shouldDispatchToProjects, all `!isSubAgent`) run POST-run, so a
 *     sub-agent calling one previously got a success result and then nothing
 *     happened.
 * Stripping them from sub-agent SCHEMAS (filterToolsForAgent) saves their
 * long descriptions on every sub-agent prompt AND — because a sub-agent's
 * enforcedToolNames set derives from the offered list (runner.ts) — turns a
 * stray call into a clear execution-time rejection instead of that silent
 * false-success. The sub-agent system prompt swaps its delegation section to
 * match (prompts.ts SUBAGENT_EFFORT_SECTION). Keep all three in lockstep.
 */
export const PARENT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'dispatch_subagent',
  'dispatch_scene_builder',
  'dispatch_to_branches',
  'dispatch_to_projects',
  // plan_scenes writes the whole-video build spec (world.scenePlan). Only the
  // top-level run plans; a scene-building sub-agent that RE-plans overwrites the
  // parent's spec mid-build (the "re-plans, ships 150s despite the 90s plan"
  // symptom). The sub-agent receives the plan via initialScenePlan instead.
  'plan_scenes',
  // ask_user pauses the run for a human answer, which only the TOP-LEVEL run can
  // surface + resume. A sub-agent has no resume path: its pause returns the
  // question text as a "successful" brief and the card is a dead end.
  // Strip it from every sub-agent's toolset; the parent does the asking.
  'ask_user',
])

/**
 * Tools that hand BUILD work to sub-agents. Dreambyte is single-agent by DEFAULT —
 * the parent builds every scene in its own loop and keeps its turn — so these are
 * offered only when the run resolves to orchestration: the Settings → Agents
 * "Use sub-agents" toggle, or an explicit ask in the message
 * (`userRequestedSubAgents`). On a single-agent run they are both dead schema weight
 * AND an invitation to burn an iteration on a call `world.orchestratorAvailable`
 * will honest-fail.
 *
 * NOT here: `dispatch_to_branches` / `dispatch_to_projects`. Those are terminal,
 * user-visible features ("give me 3 variations", "apply this to all my projects")
 * that already fire only on an explicit ask and never take the CURRENT build away
 * from the parent — gating them would kill a shipped feature, not a default.
 */
export const SUB_AGENT_BUILD_TOOL_NAMES: ReadonlySet<string> = new Set(['dispatch_subagent', 'dispatch_scene_builder'])

/**
 * Explicit user opt-in to sub-agents, matched against the latest user message.
 *
 * A literal phrase list, not a classifier — spending an LLM call to decide
 * whether to spend LLM calls is the wrong shape, and a miss is cheap (the run is
 * single-agent, which still builds the video). Upgrade path: add the phrase.
 * Known ceiling: "in parallel" can match prose about the SUBJECT ("two lines move in
 * parallel"). The cost of that false positive is one enabled capability the model
 * still has to choose to use, so it is deliberately not worth a classifier.
 */
const SUB_AGENT_REQUEST_RE =
  /\b(?:sub[-\s]?agents?|subagents?|multi[-\s]?agents?|paralleli[sz]e[ds]?|in parallel|fan[-\s]?out|orchestrat(?:e|ed|es|ion|or)|scene[-\s]builders?|dispatch (?:the )?(?:builders?|agents?|sub))\b/i

/** True when the message explicitly asks for sub-agents / parallel building. */
export function userRequestedSubAgents(message: string | null | undefined): boolean {
  return typeof message === 'string' && SUB_AGENT_REQUEST_RE.test(message)
}

/**
 * The NLE edit surface: clips, tracks, colour grade, captions, master volume.
 *
 * TWO consumers, one list:
 *  1. SUB-AGENTS — always stripped. A scene builder owns ONE scene; the master
 *     sequence is the parent's job (history below).
 *  2. THE PARENT — gated on the `timeline` tool chip, which is OFF by default
 *     (`src/lib/store/index.ts` activeTools). 18 tools / 20,656 B ≈ 5.2k tokens on
 *     EVERY parent turn, and across the 35 runs recorded in ~/.dreambyte/agent-runs/
 *     the agent called them ZERO times — every clip/track/keyframe entry in
 *     `action_log` is `source='user'`. The NLE is a human surface; the agent was
 *     paying rent on it every turn. Users who want agent-driven NLE flip the chip.
 *
 * So the parent was the outlier: sub-agents already had this exact set stripped.
 *
 * A scene builder owns ONE scene: it writes that scene's code and layers. The
 * timeline — tracks, clips, colour grade, captions, master volume — is the PARENT's
 * master sequence, assembled after the scenes exist. Every builder was nonetheless
 * being handed all 23 timeline tools: 24,784 bytes ≈ 6,196 tokens each, and builders
 * run one per scene, so a 6-scene video shipped ~37k tokens of colourist surface to
 * agents with no business touching it.
 *
 * NOT gated on "the timeline has a clip", which is the intuitive test but an unsafe
 * one: ctx.tools is computed once per run and deliberately never refreshed (see
 * runner.ts — "context refreshes update the prompt, not ctx.tools"), so a
 * clip-presence gate would permanently hide these from the very run that places the
 * first clip, breaking import → place → trim → grade. Sub-agent status is stable for
 * an agent's whole life, so it is a safe discriminator where clip count is not.
 *
 * The four bootstrap/read tools (init_timeline, read_timeline, add_track, place_clip)
 * deliberately stay: prompts.ts points the model at `add_track`+`place_clip` for
 * timeline audio, and stripping them would turn that line into a phantom instruction.
 *
 * Applied AFTER the toolAllowlist short-circuit, so a typed sub-agent that explicitly
 * allowlists a timeline tool still gets it — unlike PARENT_ONLY_TOOL_NAMES, which is
 * applied before precisely so an allowlist cannot re-admit those.
 */
export const NLE_EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'remove_track',
  'set_track_props',
  'apply_color',
  'marker',
  'set_master_volume',
  'clip',
  'keyframe',
  'auto_cut',
  'add_captions',
  'auto_reframe',
  'sync_audio',
])

/** Tools available to each agent type */
export const AGENT_TOOLS: Record<string, ClaudeToolDefinition[]> = {
  'scene-maker': dedup([
    // Scene Maker / Master Builder — flexible default with full toolkit + skill discovery
    DESIGN_BRIEF,
    ANALYZE_REFERENCE_MEDIA,
    // OKF craft is offered as a MENU, not as injected pack bodies: get_routed_craft's
    // `pack` argument carries one line per pack (id + its "read when" trigger),
    // generated from the rules directory by patchRoutedCraftMenu. The agent pulls a
    // pack's rules on demand. set_aspect_ratio makes a non-16:9 brief real. Both were
    // ALL_TOOLS-only (in-app relied on auto-injection), so scene-maker must carry them.
    // (An earlier version of this comment pointed at a `## Craft` block in
    // context-builder that has never existed — the menu lives in the tool schema.)
    GET_ROUTED_CRAFT,
    SET_ASPECT_RATIO,
    ...SKILL_TOOLS,
    ...SCENE_TOOLS,
    ...GLOBAL_TOOLS,
    ...LAYER_TOOLS,
    // Media-library generation + placement surface: the in-app agent can now generate,
    // place, reuse, and character-ify images. Gated at filter time by the 'assets' category +
    // image-provider availability (see filterToolsForAgent). PLACE_IMAGE lives in
    // ASSET_TOOLS; the rest (generate_image's reference/regenerate sources, generate_variation,
    // use_asset_in_scene, create_character, reuse_character, …) in MEDIA_LIBRARY_TOOLS.
    // Stock photo DISCOVERY is find_media(kind:'image') (research-tools) — cached, filtered,
    // and keyless-capable; the old search_images shortcut to Unsplash is gone.
    PLACE_IMAGE,
    // Video/audio layer placement — a scene can drop in a stock/generated clip or
    // an audio bed. These were MISSING from the scene-maker array entirely (the
    // 'scene-maker' key exists so filterToolsForAgent never fell back to ALL_TOOLS),
    // so set_video_layer was invisible on every run regardless of keys/categories.
    // Still filtered by the 'video'/'audio' category + provider availability.
    SET_MEDIA_LAYER,
    ...MEDIA_LIBRARY_TOOLS,
    ...ELEMENT_TOOLS,
    ...TEMPLATE_TOOLS,
    ...AUDIO_TOOLS,
    ...INTERACTION_TOOLS,

    ...RESEARCH_TOOLS,
    CAPTURE_FRAME,
    REVIEW,
    VERIFY_SCENE,
    DISPATCH_SCENE_BUILDER,
    DISPATCH_SUBAGENT,
    DISPATCH_TO_BRANCHES,
    DISPATCH_TO_PROJECTS,
    WRITE_PLAN,
    UPDATE_TODOS,
    ...TIMELINE_TOOLS,
    SEND_FEEDBACK,
    // Export. filterToolsForAgent lists these in ALWAYS_AVAILABLE_TOOL_NAMES, but that
    // list only lets tools THROUGH — it can't add them. They were absent here, so the
    // in-app agent could not export an MP4 at all (zero export calls across every
    // recorded run in ~/.dreambyte/agent-runs/). FCPXML interchange has no tool at
    // all any more — the app menu's "Export FCPXML…" (src/electron/main.ts) is the path.
    EXPORT,
    GET_STATUS,
  ]),
}

/** Tool filter map: active tool category ID → which tool names it enables */
export const TOOL_CATEGORY_MAP: Record<string, string[]> = {
  svg: ['add_layer'],
  canvas2d: ['add_layer'],
  d3: ['add_layer', 'chart', 'set_camera_motion'],
  three: ['add_layer', 'find_media'],
  lottie: ['add_layer', 'find_media'],
  zdog: ['add_layer', 'create_zdog_composed_scene', 'save_zdog_asset', 'list_zdog_person_assets'],
  assets: ['place_image', 'use_asset_in_scene', 'add_watermark', 'media_library', 'character'],
  audio: ['set_media_layer', 'add_narration', 'add_sfx', 'add_music', 'set_audio_mix', 'dub_video', 'clone_voice'],
  video: ['set_media_layer'],
  avatars: ['generate_avatar_narration', 'generate_avatar_scene', 'get_status'],
  interactions: ['interaction', 'edit_interaction', 'connect_scenes', 'define_scene_variable'],
  research: ['web_search', 'set_research_mode', 'fetch_url_content', 'find_media', 'fetch_video_from_url'],
}
