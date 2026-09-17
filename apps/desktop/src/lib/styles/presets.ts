import type { GlobalStyle } from '../types'
import type { ThinkingMode } from '../agents/types'
import type { StylePresetId } from '../types/project'

export type { StylePresetId } from '../types/project'

export interface PresetExportConfig {
  resolution: '720p' | '1080p' | '4k'
  fps: 24 | 30 | 60
  format: 'mp4' | 'webm'
}

export interface PresetAgentConfig {
  thinkingMode: ThinkingMode
  planFirst: boolean
  confirmBeforeBigChanges: boolean
  preferredSceneCount: { min: number; max: number }
}

export interface PresetDensityConfig {
  elementsPerScene: { min: number; max: number }
  labelEverything: boolean
  breathingRoom: boolean
  annotationStyle: 'minimal' | 'detailed' | 'none'
}

export interface PresetInteractiveConfig {
  autoAddGates: boolean
  autoAddQuizzes: boolean
  showProgressBar: boolean
  playerTheme: 'dark' | 'light' | 'transparent'
}

export interface StylePreset {
  id: StylePresetId
  name: string
  description: string
  emoji: string

  // Visual output config
  palette: [string, string, string, string]
  bgColor: string
  bgStyle: 'plain' | 'paper' | 'grid' | 'dots' | 'chalkboard' | 'kraft'
  font: string
  bodyFont: string | null

  // Renderer preferences (motion = HTML/CSS + anime.js timeline — default for most explainers)
  preferredRenderer: 'canvas2d' | 'svg' | 'motion' | 'auto'

  // Drawing character
  roughnessLevel: number
  defaultTool: 'marker' | 'pen' | 'chalk' | 'brush' | 'highlighter'
  strokeColorOverride: string | null

  // Texture overlay
  textureStyle: 'none' | 'grain' | 'paper' | 'chalk' | 'lines'
  textureIntensity: number
  textureBlendMode: 'multiply' | 'screen' | 'overlay'

  // D3/data scenes
  axisColor: string
  gridColor: string

  // Agent instruction
  agentGuidance: string

  // Style cascade — downstream settings derived from preset
  export: PresetExportConfig
  agent: PresetAgentConfig
  density: PresetDensityConfig
  interactive: PresetInteractiveConfig
}

export interface ResolvedStyle extends StylePreset {
  strokeColor: string
}

export const STYLE_PRESETS: Record<StylePresetId, StylePreset> = {
  whiteboard: {
    id: 'whiteboard',
    name: 'Whiteboard',
    description: 'Hand-drawn marker on white board. Natural, educational feel.',
    emoji: '📋',
    palette: ['#1a1a2e', '#e84545', '#16a34a', '#2563eb'],
    bgColor: '#fffef9',
    bgStyle: 'paper',
    font: 'Caveat',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 1.5,
    defaultTool: 'marker',
    strokeColorOverride: null,
    textureStyle: 'grain',
    textureIntensity: 0.04,
    textureBlendMode: 'multiply',
    axisColor: '#4a4a52',
    gridColor: '#e5e5e8',
    agentGuidance: `Use canvas2d with animateRough* functions.
Prefer organic, hand-drawn shapes over geometric precision.
Use wait() between elements for natural drawing pacing.
Text is Caveat font, always instant (never animated).
Arrows and labels are the primary annotation tools.`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 6 },
    },
    density: {
      elementsPerScene: { min: 4, max: 8 },
      labelEverything: true,
      breathingRoom: true,
      annotationStyle: 'detailed',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'light' },
  },

  chalkboard: {
    id: 'chalkboard',
    name: 'Chalkboard',
    description: 'White chalk on dark green board. Classroom aesthetic.',
    emoji: '🖊️',
    palette: ['#fffef9', '#86efac', '#fbbf24', '#f87171'],
    bgColor: '#2d4a3e',
    bgStyle: 'chalkboard',
    font: 'Caveat',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 2.5,
    defaultTool: 'chalk',
    strokeColorOverride: '#fffef9',
    textureStyle: 'chalk',
    textureIntensity: 0.12,
    textureBlendMode: 'screen',
    axisColor: '#fffef988',
    gridColor: '#fffef922',
    agentGuidance: `Use canvas2d with chalk tool.
Background is dark green — all strokes default to white (#fffef9).
Use PALETTE[0] (#fffef9) as the primary stroke color.
Use PALETTE[1-3] sparingly for emphasis only.
Rough, textured strokes are correct — this is chalk on a board.
Large text, generous spacing. Think classroom lecture.`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 5 },
    },
    density: {
      elementsPerScene: { min: 3, max: 6 },
      labelEverything: true,
      breathingRoom: true,
      annotationStyle: 'detailed',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: true, showProgressBar: true, playerTheme: 'dark' },
  },

  blueprint: {
    id: 'blueprint',
    name: 'Blueprint',
    description: 'Technical diagram on dark blue. Precise, engineering feel.',
    emoji: '📐',
    palette: ['#93c5fd', '#60a5fa', '#fffef9', '#fbbf24'],
    bgColor: '#1e3a5f',
    bgStyle: 'grid',
    font: 'DM Mono',
    bodyFont: null,
    preferredRenderer: 'motion',
    roughnessLevel: 0,
    defaultTool: 'pen',
    strokeColorOverride: '#93c5fd',
    textureStyle: 'none',
    textureIntensity: 0,
    textureBlendMode: 'multiply',
    axisColor: '#93c5fd88',
    gridColor: '#93c5fd22',
    agentGuidance: `Default to Motion (HTML/CSS + anime.js timeline): clean diagrams, cards, arrows, monospace labels — blueprint look without SVG.
Reserve canvas2d for chalky/organic or heavily procedural frames only.
SVG is rare — only when you need a single self-contained vector graphic with template stroke classes and nothing else fits.
Monospace font (DM Mono) for measurements. Light lines on dark blue grid.
Content type always wins — data is D3, 3D is Three.js.`,
    export: { resolution: '1080p', fps: 24, format: 'mp4' },
    agent: {
      thinkingMode: 'deep',
      planFirst: true,
      confirmBeforeBigChanges: true,
      preferredSceneCount: { min: 2, max: 4 },
    },
    density: {
      elementsPerScene: { min: 6, max: 12 },
      labelEverything: true,
      breathingRoom: false,
      annotationStyle: 'detailed',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: false, playerTheme: 'dark' },
  },

  clean: {
    id: 'clean',
    name: 'Clean',
    description: 'Minimal, polished presentation style. Professional.',
    emoji: '✨',
    palette: ['#1a1a2e', '#e84545', '#16a34a', '#2563eb'],
    bgColor: '#ffffff',
    bgStyle: 'plain',
    font: 'Georgia',
    bodyFont: null,
    preferredRenderer: 'motion',
    roughnessLevel: 0,
    defaultTool: 'pen',
    strokeColorOverride: null,
    textureStyle: 'none',
    textureIntensity: 0,
    textureBlendMode: 'multiply',
    axisColor: '#6b7280',
    gridColor: '#f3f4f6',
    agentGuidance: `Default to Motion: polished layouts, typography, cards, step lists, and UI-like explainers (Georgia, minimal chrome).
Use canvas2d only for expressive hand-drawn or generative visuals — not for default explainers.
SVG is rare (edge cases). Professional, minimal; light fills on shapes via CSS.
Content type always wins — data is D3, 3D is Three.js.`,
    export: { resolution: '1080p', fps: 60, format: 'mp4' },
    agent: {
      thinkingMode: 'off',
      planFirst: false,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 8 },
    },
    density: {
      elementsPerScene: { min: 2, max: 5 },
      labelEverything: false,
      breathingRoom: true,
      annotationStyle: 'minimal',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'light' },
  },

  'data-story': {
    id: 'data-story',
    name: 'Data Story',
    description: 'Dark background, optimized for charts and data visualization.',
    emoji: '📊',
    palette: ['#60a5fa', '#34d399', '#f59e0b', '#f87171'],
    bgColor: '#0f0f13',
    bgStyle: 'plain',
    font: 'DM Mono',
    bodyFont: null,
    preferredRenderer: 'auto',
    roughnessLevel: 0.3,
    defaultTool: 'pen',
    strokeColorOverride: null,
    textureStyle: 'grain',
    textureIntensity: 0.03,
    textureBlendMode: 'screen',
    axisColor: '#4a4a5a',
    gridColor: '#2a2a3a',
    agentGuidance: `Prefer D3 for data scenes.
For non-data explainer frames: default to Motion (layouts, callouts, transitions). Canvas2d for expressive or procedural visuals only. SVG rarely.
Dark background — elements light/bright. Monospace for numbers.
Chart animations: bars grow, lines draw L→R. PALETTE for series only.
Content type always wins — data is D3, 3D is Three.js.`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 7 },
    },
    density: {
      elementsPerScene: { min: 1, max: 3 },
      labelEverything: true,
      breathingRoom: true,
      annotationStyle: 'minimal',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'dark' },
  },

  newspaper: {
    id: 'newspaper',
    name: 'Newspaper',
    description: 'Editorial, monochrome. Text-heavy, journalistic.',
    emoji: '📰',
    palette: ['#1a1a1a', '#404040', '#737373', '#d4d4d4'],
    bgColor: '#f5f0e0',
    bgStyle: 'paper',
    font: 'Georgia',
    bodyFont: null,
    preferredRenderer: 'motion',
    roughnessLevel: 0.5,
    defaultTool: 'pen',
    strokeColorOverride: null,
    textureStyle: 'paper',
    textureIntensity: 0.08,
    textureBlendMode: 'multiply',
    axisColor: '#404040',
    gridColor: '#d4d4d4',
    agentGuidance: `Default to Motion for editorial layouts: headlines, columns, pull quotes, and supporting diagram-like blocks in HTML/CSS.
Text-first; Georgia serif; monochrome grays.
Canvas2d only if you need hand-drawn illustration energy. SVG rarely.
Paper texture is automatic — do not fight it in scene code.`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 6 },
    },
    density: {
      elementsPerScene: { min: 3, max: 6 },
      labelEverything: false,
      breathingRoom: true,
      annotationStyle: 'minimal',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'light' },
  },

  neon: {
    id: 'neon',
    name: 'Neon',
    description: 'Dark background, glowing neon colors. Futuristic, tech.',
    emoji: '⚡',
    palette: ['#f0ece0', '#00ff88', '#ff0080', '#00cfff'],
    bgColor: '#0a0a0f',
    bgStyle: 'plain',
    font: 'DM Mono',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 0.8,
    defaultTool: 'brush',
    strokeColorOverride: null,
    textureStyle: 'grain',
    textureIntensity: 0.05,
    textureBlendMode: 'screen',
    axisColor: '#00ff8844',
    gridColor: '#00ff8811',
    agentGuidance: `Dark background — use bright PALETTE colors for all strokes.
Brush tool for expressive, glowing stroke feel.
Use glow effect: draw each stroke twice — once thick at low opacity,
once thin at full opacity — to simulate neon glow.
Monospace font. Tech/futuristic tone.
Use PALETTE[1] (green) for primary content.
Use PALETTE[2] (pink) and PALETTE[3] (cyan) for accents.
WHEN TO OVERRIDE: If the project already has 2+ Canvas2D scenes, use SVG or Motion for the next scene. Content type always wins — data is always D3, 3D is always Three.js.`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: false,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 6 },
    },
    density: {
      elementsPerScene: { min: 3, max: 6 },
      labelEverything: false,
      breathingRoom: true,
      annotationStyle: 'minimal',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'dark' },
  },

  kraft: {
    id: 'kraft',
    name: 'Kraft Paper',
    description: 'Brown paper, warm and tactile. Artisan, hand-made feel.',
    emoji: '📦',
    palette: ['#1c0a00', '#92400e', '#b45309', '#d97706'],
    bgColor: '#c4a882',
    bgStyle: 'kraft',
    font: 'Caveat',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 2.0,
    defaultTool: 'marker',
    strokeColorOverride: '#1c0a00',
    textureStyle: 'paper',
    textureIntensity: 0.15,
    textureBlendMode: 'multiply',
    axisColor: '#92400e88',
    gridColor: '#92400e22',
    agentGuidance: `Warm brown palette on kraft paper background.
Caveat font — handwritten, artisan feel.
Dark ink strokes on warm paper. No bright colors.
Heavy texture. This should look like something drawn with a
marker on brown packaging paper.
WHEN TO OVERRIDE: If the project already has 2+ Canvas2D scenes, use SVG for the next visual scene. Content type always wins — data is always D3, 3D is always Three.js.`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 5 },
    },
    density: {
      elementsPerScene: { min: 3, max: 6 },
      labelEverything: false,
      breathingRoom: true,
      annotationStyle: 'minimal',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'dark' },
  },

  threeblueonebrown: {
    id: 'threeblueonebrown',
    name: '3B1B',
    emoji: '🔵',
    description: '3Blue1Brown — mathematical precision on deep navy.',
    bgColor: '#0d1117',
    palette: ['#6495ED', '#9B59B6', '#F39C12', '#AAAAAA'],
    font: 'Sora',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 0,
    defaultTool: 'pen',
    strokeColorOverride: null,
    textureStyle: 'none',
    textureIntensity: 0,
    textureBlendMode: 'multiply',
    bgStyle: 'plain',
    axisColor: '#444444',
    gridColor: '#1E2A3A',
    agentGuidance: `COLORS — color encodes meaning, always
- Background: deep navy (#0d1117) — this specific shade, not pure black
- Blue (#6495ED): the PRIMARY concept being explained. The thing itself.
- Purple (#9B59B6): extensions, related concepts, transformations of the primary
- Gold (#F39C12): the KEY RESULT or KEY INSIGHT. Use once per scene maximum.
- Grey (#AAAAAA): supporting elements, axis labels, annotations that aren't the focus
- White (#FFFFFF): text only, never shapes

TYPOGRAPHY
- Title: 52px / 500 / white / -0.01em tracking
- Equation: 36px / 400 / white / center-aligned / generous vertical padding
- Annotation: 24px / 400 / #AAAAAA / left-aligned near the element it describes
- Label: 24px / 500 / color-matched to element / never more than 4 words

ANIMATION — DRAWING IS THE ANIMATION
- Elements do not fade in. They draw themselves.
- Shapes: stroke traces first (0.8s, 'inOutCubic'), then fill fades in (0.3s)
- Lines and arrows: draw left to right or start to end, 0.6-1.2s depending on length
- Text: fade up 16px, 0.4s, 'outQuart' — text is secondary to the drawings
- Equations: appear character group by character group, 0.06s stagger per term
- Never bounce. Never spring. Mathematical precision in motion.

CHARTS AND GRAPHS
- Axes draw themselves first, then data appears
- Grid: subtle, #1E2A3A, both axes at 0.5px
- Primary data series: blue. Secondary: purple. Key value: gold dot or annotation.
- Axes: no border box — open frame. Labels in grey (#AAAAAA), 24px.
- Prefer showing the mathematical relationship visually over chart labels

SPATIAL RHYTHM
- Generous — math needs to breathe
- 80px margins minimum
- Equation gets its own visual zone — don't crowd it with other elements
- One concept per scene. If two concepts, show their relationship explicitly.

PROHIBITIONS
- No drop shadows
- No gradients on shapes (flat fills only, or stroke-only)
- No decorative elements that don't encode meaning
- No more than 4 colors in a single scene
- No rounded UI-style corners on mathematical shapes — use geometric precision
- Never use red (looks like an error/warning, breaks mathematical color semantics)`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'deep',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 6 },
    },
    density: {
      elementsPerScene: { min: 2, max: 5 },
      labelEverything: true,
      breathingRoom: true,
      annotationStyle: 'detailed',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'dark' },
  },

  feynman: {
    id: 'feynman',
    name: 'Feynman',
    emoji: '✏️',
    description: 'Feynman lecture notes — cream paper, hand-drawn diagrams.',
    bgColor: '#f5f0e8',
    palette: ['#1a1a1a', '#8B4513', '#1a4a2e', '#8B0000'],
    font: 'Caveat',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 2.2,
    defaultTool: 'pen',
    strokeColorOverride: '#1a1a1a',
    textureStyle: 'paper',
    textureIntensity: 0.1,
    textureBlendMode: 'multiply',
    bgStyle: 'paper',
    axisColor: '#4a4a4a',
    gridColor: '#d4c9b0',
    agentGuidance: `COLORS
- Background: aged cream (#f5f0e8) — like worn lecture paper
- Ink black (#1a1a1a): all primary content — diagrams, equations, main text
- Brown (#8B4513): secondary annotations, arrows pointing to things, "see also" notes
- Dark green (#1a4a2e): corrections, alternative paths, "or equivalently" annotations
- Deep red (#8B0000): critical warnings, key results circled, "IMPORTANT" markers — use sparingly

TYPOGRAPHY — HANDWRITTEN FEEL IS EVERYTHING
- Caveat is loaded — use it everywhere
- Title: 44px / Caveat / #1a1a1a — looks like written on the board
- Body: 32px / Caveat / #1a1a1a / 1.9 leading (handwriting needs air)
- Equation: 28px / Caveat / centered on the page — equations are big and clear
- Annotation: 24px / Caveat / brown — smaller, squeezed in the margin

ANIMATION — THINGS ARE BEING WRITTEN IN REAL TIME
- Diagrams draw with stroke animation: 1.0-1.5s, 'inOutQuad' (human writing pace)
- Arrows appear after the thing they point to (0.3s delay after target)
- Circles/boxes drawn around things: quick (0.4s) — like circling for emphasis
- Underlines draw left to right: 0.3s after the text they underline
- Nothing appears instantly — everything takes the time a human hand would take

DIAGRAMS
- Roughness level 2.2 means shapes look hand-drawn — lean into this
- Lines have natural variation — this is correct, not a bug
- Arrows: slightly curved, not perfectly straight
- Force diagrams: label every force, every vector, every angle — Feynman labeled everything

CHARTS
- Graphs are sketched, not rendered
- Axes drawn as arrows (not just lines) — Feynman style
- Grid: light pencil (#d4c9b0, dashed)
- Data as dots connected by a curve drawn by hand, not pixel-perfect
- Label axes with units always, in Caveat font

SPATIAL RHYTHM
- Organic, not grid-aligned — like actual lecture notes
- Things are where they make sense, not on a rigid layout
- Margin notes are valid — annotations can be outside the main flow
- 60px margins minimum but content can drift

PROHIBITIONS
- No pixel-perfect circles or lines (roughness handles this — don't fight it)
- No flat digital fills — use stroke-only or very light fills
- No sans-serif fonts (Caveat everywhere, always)
- No dark backgrounds — this is paper
- No clean modern UI elements (buttons, cards with borders, etc.)`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 6 },
    },
    density: {
      elementsPerScene: { min: 4, max: 8 },
      labelEverything: true,
      breathingRoom: true,
      annotationStyle: 'detailed',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'light' },
  },

  cinematic: {
    id: 'cinematic',
    name: 'Cinematic',
    emoji: '🎞️',
    description: 'BBC documentary / premium production — dark, restrained.',
    bgColor: '#080808',
    palette: ['#FFFFFF', '#00D4FF', '#FF6B35', '#333333'],
    font: 'Manrope',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 0,
    defaultTool: 'pen',
    strokeColorOverride: null,
    textureStyle: 'grain',
    textureIntensity: 0.04,
    textureBlendMode: 'overlay',
    bgStyle: 'plain',
    axisColor: '#444444',
    gridColor: '#1A1A1A',
    agentGuidance: `COLORS
- Background: near-black (#080808) — NOT pure black, the grain needs something to work against
- White (#FFFFFF): primary text and primary visual elements
- Cyan (#00D4FF): THE single accent color. One accent element per scene. One highlight. One key number.
- Orange (#FF6B35): contrast moments only — a second data series, a warning, a counter-element. Never alongside cyan in the same scene.
- Dark grey (#333333): secondary elements, supporting text, subtle dividers

ONE ACCENT RULE
Each scene uses either cyan OR orange, never both. The accent is the single thing that matters most in that scene. Everything else is white or grey.

TYPOGRAPHY
- Titles: 56px / 300 weight (LIGHT — cinematic titles are never bold) / white / -0.02em tracking
- Subhead: 28px / 300 / #AAAAAA / 0 tracking
- Body: 32px / 400 / #CCCCCC / 1.8 leading
- Data callout: 72px / 200 weight / white / tabular-nums (huge, confident, minimal)
- Caption: 24px / 400 / #666666 / letter-spacing 0.04em

ANIMATION — RESTRAINT IS THE AESTHETIC
- Elements emerge from darkness: fade from opacity 0, scale from 0.98 to 1 (barely perceptible scale)
- Duration: 0.7s, 'outCubic' — unhurried
- Stagger between elements: 0.4s (long gaps — each element breathes)
- The accent color element: arrives LAST, after everything else has settled
- Charts: lines draw left to right at 1.0s, no fill animation — just the line
- Exit: faster than entrance, 0.3s fade to opacity 0

GRAIN TEXTURE
- The grain texture (0.04 intensity, overlay) gives film quality
- Do NOT add additional texture effects in the scene code — the template handles this

CHARTS
- Ultra-minimal — cinematic doesn't do dashboards
- Single line charts preferred: 1.5px white or accent-colored line, no fill
- No chart borders, no grid lines (or barely-visible at 0.05 opacity)
- Data labels on the line, not in a legend
- One data series per chart — if you need two, reconsider whether a chart is the right choice

SPATIAL RHYTHM
- Asymmetric — key element off-center feels more cinematic than centered
- Large type paired with lots of empty dark space
- 80px margins, but content often lives in one half of the frame
- Text bottom-third placement for key moments (documentary lower-third convention)

PROHIBITIONS
- No bounce, spring, or elastic easing (ever, in any form)
- No rounded UI elements
- No emoji
- No more than 2 elements in motion at the same time
- No white backgrounds on any element (cards, panels, etc.)
- No gradients`,
    export: { resolution: '1080p', fps: 24, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 6 },
    },
    density: {
      elementsPerScene: { min: 1, max: 3 },
      labelEverything: false,
      breathingRoom: true,
      annotationStyle: 'minimal',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'dark' },
  },

  pencil: {
    id: 'pencil',
    name: 'Pencil',
    emoji: '✏️',
    description: 'Graphite sketchbook — thinking in progress.',
    bgColor: '#f8f7f4',
    palette: ['#2b2b2b', '#555555', '#888888', '#c8c8c8'],
    font: 'Caveat',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 2.8,
    defaultTool: 'pen',
    strokeColorOverride: '#2b2b2b',
    textureStyle: 'paper',
    textureIntensity: 0.08,
    textureBlendMode: 'multiply',
    bgStyle: 'paper',
    axisColor: '#555555',
    gridColor: '#d8d8d8',
    agentGuidance: `COLORS — GREYSCALE ONLY, NO EXCEPTIONS
- Background: off-white paper (#f8f7f4)
- Dark (#2b2b2b): primary lines, text, key shapes — the 2B pencil
- Mid-dark (#555555): secondary elements, annotations, supporting lines — the HB pencil
- Mid (#888888): light construction lines, guide marks, underdrawn elements
- Light (#c8c8c8): barely-there guide lines, erased marks, very secondary elements
No color. Ever. This is greyscale by principle.

PENCIL WEIGHT CONVENTION (professional illustrators use this)
- Heavy (2b color, strokeWidth 2.5): final lines, key shapes, text
- Medium (555, strokeWidth 1.5): secondary elements, labels
- Light (888, strokeWidth 0.8): construction lines, guides, background grid
- Ghost (c8c, strokeWidth 0.5): barely visible — used for scale, reference

HATCHING AND SHADING
- For fills, use hatching: parallel lines drawn close together, not solid fills
- Cross-hatching for darker areas: two layers of parallel lines at 45° to each other
- Never use solid dark fills — always hatch
- Roughness 2.8 means the hatching lines wobble naturally — this is correct

TYPOGRAPHY
- Caveat at all sizes: 40px title, 32px body, 24px annotation
- All text in dark (#2b2b2b), as if written by hand

ANIMATION — SKETCHING IN REAL TIME
- Everything draws as if a hand is holding the pencil
- Lines: stroke animation, 0.8-1.5s depending on length, 'inOutQuad'
- Hatching: lines appear one by one with 0.05s stagger
- The experience: watching someone work through a problem on paper

CHARTS
- Drawn on graph paper — use grid bgStyle, light grey grid lines (#d8d8d8)
- Axes: drawn as lines with arrowheads at ends (not just borders)
- Data: plotted as × marks or dots, connected by a hand-drawn line
- Bar chart: bars outlined with pencil, filled with hatching

PROHIBITIONS
- No color (greyscale only — this is the defining rule)
- No solid fills (always hatch)
- No digital-looking precision (the roughness is intentional)
- No clean sans-serif fonts`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 5 },
    },
    density: {
      elementsPerScene: { min: 3, max: 6 },
      labelEverything: true,
      breathingRoom: true,
      annotationStyle: 'detailed',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'light' },
  },

  risograph: {
    id: 'risograph',
    name: 'Risograph',
    emoji: '🖨️',
    description: 'Limited color print — analog grain, deliberate misregister.',
    bgColor: '#f2ede4',
    palette: ['#e84855', '#0067A5', '#1a1a1a', '#f2ede4'],
    font: 'Space Mono',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 0.5,
    defaultTool: 'marker',
    strokeColorOverride: null,
    textureStyle: 'grain',
    textureIntensity: 0.12,
    textureBlendMode: 'multiply',
    bgStyle: 'paper',
    axisColor: '#1a1a1a',
    gridColor: '#d4c9b0',
    agentGuidance: `COLORS — TWO INK COLORS ONLY, EXACTLY LIKE REAL RISOGRAPH
- Paper: cream (#f2ede4) — this IS a color, it shows through where inks don't print
- Red ink (#e84855): first color pass
- Blue ink (#0067A5): second color pass
- Overlap: where red and blue overlap, they mix to create a brownish-purple — achieve with globalCompositeOperation 'multiply' or layer at 0.85 opacity
- Black (#1a1a1a): use ONLY for text — risograph black is a third ink, use sparingly

MISREGISTER — THE SIGNATURE EFFECT
Real risograph prints have slight misalignment between color passes. Simulate this:
- The blue layer should be offset 2-3px in x and y from where you'd expect
- Consistent offset within a scene — pick a direction and stick with it
- Applies to both shapes AND text that has a colored outline or shadow

HALFTONE FOR TINTS
Instead of opacity, simulate tints with dot patterns:
- Full ink: solid fill
- 50% tint: dots at 6px spacing
- 25% tint: dots at 10px spacing
- No CSS opacity for ink simulation (use dot pattern instead)

TYPOGRAPHY
- Space Mono everywhere — looks like a typewriter, fitting for print aesthetic
- Title: 48px / 700 / black (#1a1a1a) — set in black ink
- Body: 32px / 400 / black
- Pulled quote or callout: 32px / 700 / red or blue (one ink color, not black)
- Labels: 24px / 400 / ALL CAPS / 0.08em tracking

ANIMATION
- Ink appears: elements stamp in with a very slight scale (1.05 → 1, 0.15s, 'outCubic')
- The two color layers appear separately: red first (0.3s), then blue with 0.2s offset
- Misregister is applied on the blue layer's entrance
- Text typesets in: characters appear left to right, 0.04s stagger

CHARTS
- Bold, graphic, poster-style — not data-dashboard style
- Large areas of solid color, not thin lines
- Bar charts: thick bars, red or blue, halftone for secondary bars
- Prefer visual metaphor over precise chart when possible

SPATIAL RHYTHM
- Bold and graphic — fill the space
- Large type, large shapes
- 40px margins (tighter than minimal presets — risograph is bold)

PROHIBITIONS
- No gradients (risograph doesn't do gradients — use halftone dots instead)
- No more than 2 ink colors per scene (plus black for text)
- No smooth opacity transitions — only solid or halftone
- No thin delicate lines — risograph is bold`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 5 },
    },
    density: {
      elementsPerScene: { min: 2, max: 5 },
      labelEverything: false,
      breathingRoom: false,
      annotationStyle: 'minimal',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'light' },
  },

  retro_terminal: {
    id: 'retro_terminal',
    name: 'Terminal',
    emoji: '⌨️',
    description: 'Amber phosphor CRT — 1970s oscilloscope aesthetic.',
    bgColor: '#0a0800',
    palette: ['#FFB000', '#FF8C00', '#CC7000', '#1a1400'],
    font: 'Space Mono',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 0,
    defaultTool: 'pen',
    strokeColorOverride: '#FFB000',
    textureStyle: 'lines',
    textureIntensity: 0.07,
    textureBlendMode: 'overlay',
    bgStyle: 'plain',
    axisColor: '#CC7000',
    gridColor: '#1a1000',
    agentGuidance: `COLORS — AMBER MONOCHROME ONLY
- Void black (#0a0800): background — not pure black, has a warm undertone
- Bright amber (#FFB000): primary — text, active elements, key data (phosphor at full brightness)
- Medium amber (#FF8C00): secondary elements, supporting text, axis labels
- Dim amber (#CC7000): inactive elements, grid lines, ghost elements (phosphor fading)
- Near-black (#1a1400): panel backgrounds, subtle dividers — almost invisible
No other colors. This is a monochrome phosphor display.

PHOSPHOR GLOW
Amber phosphor CRTs have a characteristic soft glow:
- Primary elements: text-shadow or box-shadow '#FFB000' at 0.35 opacity, 0 offset, 6px blur
- Keep glow subtle — you're suggesting phosphor, not neon
- Only ONE glow effect per scene — the most important element

SCANLINES
The texture (lines, 0.07 intensity) simulates CRT scanlines — do NOT add more texture effects.
Horizontal lines at regular intervals are already handled.

TYPOGRAPHY — MONOSPACE EVERYTHING
- Space Mono at all sizes — this is non-negotiable
- Title: 40px / 700 / bright amber — uppercase always
- Body: 28px / 400 / medium amber
- Data readout: 56px / 400 / bright amber / tabular-nums — big phosphor numbers
- Label: 24px / 400 / dim amber / ALL CAPS / 0.1em tracking
- Prompt character (>_ style): use before title text

ANIMATION — TERMINAL BEHAVIOR
- Text prints character by character: 0.05s per character (fast but visible)
- Cursor blinks at end of typed text: blinking underscore or block, 500ms interval
- Elements don't slide or scale — they APPEAR (snap in) like a terminal drawing
- Exceptions: waveforms and oscilloscope traces draw left-to-right (0.8s)
- Screen flicker on major transitions: brief opacity dip (0.7) then back to 1, 0.08s

CHARTS — OSCILLOSCOPE STYLE
- Line charts are the native chart type (waveforms)
- Grid: subtle (#1a1000), both axes — like graph paper on a CRT screen
- Line: 1.5px bright amber, draw left to right
- No bar charts — use numerical readouts instead
- Data labels as terminal-style readouts: "FREQ: 440Hz" format
- Axes labeled in monospace, ALL CAPS

SPATIAL RHYTHM
- Terminal-style left alignment — everything starts from the left
- No centered elements (terminals don't center-align)
- 60px left margin, 40px top margin
- Line structure — content builds downward like terminal output

PROHIBITIONS
- No color other than amber shades
- No rounded corners on anything
- No smooth animations (snap-in only, except waveform draws)
- No serif fonts, no sans-serif (monospace only)
- No gradients`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: false,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 5 },
    },
    density: {
      elementsPerScene: { min: 2, max: 4 },
      labelEverything: true,
      breathingRoom: false,
      annotationStyle: 'minimal',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: false, playerTheme: 'dark' },
  },

  science_journal: {
    id: 'science_journal',
    name: 'Journal',
    emoji: '🔬',
    description: 'Nature / Science magazine — publication-quality figures.',
    bgColor: '#FFFFFF',
    palette: ['#1a1a2e', '#e94560', '#16213e', '#888888'],
    font: 'Georgia',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 0,
    defaultTool: 'pen',
    strokeColorOverride: null,
    textureStyle: 'none',
    textureIntensity: 0,
    textureBlendMode: 'multiply',
    bgStyle: 'plain',
    axisColor: '#333333',
    gridColor: '#e0e0e0',
    agentGuidance: `COLORS
- Background: pure white (#FFFFFF)
- Navy (#1a1a2e): primary data series, headlines, key elements
- Red (#e94560): accent — the one highlighted data point, the significant result, p<0.05 marker
- Dark navy (#16213e): secondary data series, body text
- Grey (#888888): axis labels, figure captions, supporting text, grid lines

TYPOGRAPHY — PUBLICATION STANDARD
- Figure title: 28px / Georgia / 700 / navy — always present, always top-left
- Axis label: 24px / Sora / 400 / #333333 — sans-serif for chart labels (readability)
- Axis value: 24px / Sora / 400 / #666666
- Body text: 32px / Georgia / 400 / #1a1a2e / 1.7 leading
- Figure caption: 24px / Georgia / italic / #444444 — always below the figure
- Source/credit: 24px / Sora / 400 / #888888 / bottom-right always

FIGURE NUMBERING — MANDATORY
Every scene that contains a chart or diagram has:
- "Fig. N" label: 24px / Sora / 500 / #888888 / top-left or bottom-left
- Caption below: 24px / Georgia / italic — one sentence explaining what is shown
- Source line: 24px / Sora / #888888 — where this data/concept comes from

CHARTS — PUBLICATION QUALITY
- No chart junk (Tufte principle): remove every element that doesn't carry information
- Axes: bottom and left only (no top/right border — open chart frame)
- Axis lines: 1px #333333
- Grid lines: horizontal only, 0.5px #e0e0e0 (barely visible)
- Primary series: navy (#1a1a2e), 2px line or solid bar
- Secondary series: #16213e at 0.6 opacity
- Significance marker: red (#e94560) — asterisk, bracket, or highlighted point
- Error bars: thin (0.8px) lines with horizontal caps — always show uncertainty
- Legend: inside the chart area, not outside (saves space)

ANIMATION
- Conservative — scientific figures don't perform
- Charts draw axes first (0.4s), then data appears (0.6s), then labels (0.3s)
- All easing: 'outQuad' — gentle, not showy
- No bounce, no spring

SPATIAL RHYTHM
- Publication column width: figures are typically 80-90% of page width
- 48px margins
- Figure + caption treated as a unit — they always travel together
- White space between figure and caption: 12px exactly

PROHIBITIONS
- No 3D charts (ever — they distort data)
- No pie charts (use bar chart instead)
- No decorative chart elements (backgrounds, shadows, gradients on bars)
- No animation that lasts over 0.8s per element
- No emoji
- No rounded corners on chart elements`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'deep',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 6 },
    },
    density: {
      elementsPerScene: { min: 1, max: 3 },
      labelEverything: true,
      breathingRoom: true,
      annotationStyle: 'detailed',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'light' },
  },

  pastel_edu: {
    id: 'pastel_edu',
    name: 'Classroom',
    emoji: '🍎',
    description: 'Friendly educational — Khan Academy warmth.',
    bgColor: '#FAFAFA',
    palette: ['#E74C3C', '#1ABC9C', '#3498DB', '#F39C12'],
    font: 'Nunito',
    bodyFont: null,
    preferredRenderer: 'canvas2d',
    roughnessLevel: 1.0,
    defaultTool: 'marker',
    strokeColorOverride: null,
    textureStyle: 'none',
    textureIntensity: 0,
    textureBlendMode: 'multiply',
    bgStyle: 'plain',
    axisColor: '#AAAAAA',
    gridColor: '#F0F0F0',
    agentGuidance: `COLORS — EACH COLOR HAS A ROLE, KEEP IT CONSISTENT
- Background: near-white (#FAFAFA) — warm, not clinical white
- Red (#E74C3C): primary concept, the main thing being learned
- Teal (#1ABC9C): correct answers, positive outcomes, "this works"
- Blue (#3498DB): information, context, explanations, secondary concepts
- Orange (#F39C12): emphasis, "pay attention", callouts, numbers to remember
All four colors are friendly and distinct — no dark or threatening colors.

FRIENDLY COLOR RULES
- Every major concept gets its own color and keeps it throughout the scene
- If "force" is red in scene 1, it's red in every scene
- Color = memory hook — the student associates color with concept

TYPOGRAPHY — ROUNDED AND APPROACHABLE
- Nunito is loaded — use it everywhere (rounded letterforms feel friendly)
- Title: 48px / 700 / #333333 — confident but not intimidating
- Body: 32px / 400 / #555555 / 1.8 leading — generous line height
- Highlighted word: inline color matching its concept color
- Callout box: 28px / 600 / white text on concept-color background / 12px border-radius
- Equation: 28px / 600 / #333333 — equations should be big enough to read easily

ANIMATION — PLAYFUL BUT NOT DISTRACTING
- Elements bounce in: scale 0 → 1.1 → 1, duration 0.5s, 'outBack(1.5)' easing
- Text fades up 24px, 0.4s — livelier than serious presets
- Stagger between list items: 0.1s (noticeable, feels lively)
- Correct answer reveal: scale 1 → 1.15 → 1 with teal color flash, 0.3s
- Charts: bars grow from baseline with bounce — each bar bounces individually

CHARTS
- Bright, clear, labeled
- Grid: light grey (#F0F0F0) horizontal only
- Bars: full concept color, 8px border-radius (rounded bars feel friendly)
- Labels on top of bars, 24px / 600 / matching color
- Axes: thin grey (#AAAAAA), with clear unit labels
- Always include a chart title above: 26px / 600 / #333333

CALLOUT BOXES — USE GENEROUSLY
- Key term: colored background, white text, 8px radius, 12px 16px padding
- Remember box: orange background, white text
- Example box: blue background
- Warning: red background

SPATIAL RHYTHM
- Friendly density — not sparse but not overwhelming
- 64px margins
- Space between sections: 40px
- Content often slightly left-of-center (like a teacher at a whiteboard)

PROHIBITIONS
- No dark backgrounds on any element
- No thin lines — minimum 2px strokes, prefer 3px
- No tiny text — minimum 24px even for captions
- No long paragraphs — max 2 lines of body text per scene
- No complex charts — if it needs a legend, simplify it`,
    export: { resolution: '1080p', fps: 30, format: 'mp4' },
    agent: {
      thinkingMode: 'adaptive',
      planFirst: true,
      confirmBeforeBigChanges: false,
      preferredSceneCount: { min: 3, max: 6 },
    },
    density: {
      elementsPerScene: { min: 3, max: 6 },
      labelEverything: true,
      breathingRoom: true,
      annotationStyle: 'detailed',
    },
    interactive: { autoAddGates: false, autoAddQuizzes: true, showProgressBar: true, playerTheme: 'light' },
  },
}

const NEUTRAL_BASELINE: StylePreset = {
  id: 'whiteboard' as StylePresetId, // sentinel — never displayed
  name: 'Custom',
  description: 'No preset. Full style autonomy — the generator decides.',
  emoji: '🎨',
  palette: ['#f0ece0', '#e84545', '#4595e8', '#45e87a'],
  bgColor: '#181818',
  bgStyle: 'plain',
  font: 'Figtree',
  bodyFont: null,
  preferredRenderer: 'auto',
  roughnessLevel: 0,
  defaultTool: 'pen',
  strokeColorOverride: null,
  textureStyle: 'none',
  textureIntensity: 0,
  textureBlendMode: 'multiply',
  axisColor: '#888888',
  gridColor: '#333333',
  agentGuidance:
    'No style preset is active. You have full creative control over colors, fonts, backgrounds, layout, and rendering approach. Choose what best fits the content. Do not default to whiteboard or chalkboard aesthetics unless the user asks for them.',
  export: { resolution: '1080p', fps: 30, format: 'mp4' },
  agent: {
    thinkingMode: 'adaptive',
    planFirst: true,
    confirmBeforeBigChanges: false,
    preferredSceneCount: { min: 3, max: 8 },
  },
  density: {
    elementsPerScene: { min: 3, max: 8 },
    labelEverything: false,
    breathingRoom: true,
    annotationStyle: 'minimal',
  },
  interactive: { autoAddGates: false, autoAddQuizzes: false, showProgressBar: true, playerTheme: 'dark' },
}

export function getPreset(id: StylePresetId | null): StylePreset {
  if (!id) return NEUTRAL_BASELINE
  return STYLE_PRESETS[id] ?? NEUTRAL_BASELINE
}

export function resolveStyle(presetId: StylePresetId | null, overrides: Partial<GlobalStyle> = {}): ResolvedStyle {
  const preset = getPreset(presetId)
  const effectivePalette = overrides.paletteOverride ?? preset.palette
  return {
    ...preset,
    palette: effectivePalette,
    bgColor: overrides.bgColorOverride ?? preset.bgColor,
    font: overrides.fontOverride ?? preset.font,
    bodyFont: overrides.bodyFontOverride ?? preset.bodyFont,
    strokeColor: overrides.strokeColorOverride ?? preset.strokeColorOverride ?? effectivePalette[0],
  }
}
