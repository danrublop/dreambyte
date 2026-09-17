// ── Element types for the property inspector ──────────────────────────────────
// Every drawable element in a scene gets a structured definition so the
// inspector can display and edit its properties, and the iframe can do
// hit-testing for click-to-select.

export type ElementType =
  | 'rough-line'
  | 'rough-circle'
  | 'rough-rect'
  | 'rough-arrow'
  | 'rough-polygon'
  | 'text'
  | 'svg-path'
  | 'svg-text'
  | 'svg-shape'
  | 'three-object'
  | 'zdog-shape'
  | 'd3-chart'
  | 'image'
  | 'group'
  | 'dom-text'
  | 'dom-container'
  | 'dom-image'

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export interface BaseElement {
  id: string // unique within scene e.g. 'line-01'
  type: ElementType
  label: string // human readable e.g. 'Arrow pointing right'
  visible: boolean
  opacity: number // 0-1
  animStartTime: number // seconds on the scene master timeline (window.__tl)
  animDuration: number // seconds
  bbox: BBox // bounding box for hit detection in 1920x1080 space
}

export interface RoughLineElement extends BaseElement {
  type: 'rough-line'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  strokeWidth: number
  tool: 'marker' | 'pen' | 'chalk' | 'brush' | 'highlighter'
  seed: number
}

export interface RoughCircleElement extends BaseElement {
  type: 'rough-circle'
  cx: number
  cy: number
  radius: number
  color: string
  fill: string | null
  fillAlpha: number
  strokeWidth: number
  tool: string
  seed: number
}

export interface RoughRectElement extends BaseElement {
  type: 'rough-rect'
  x: number
  y: number
  width: number
  height: number
  color: string
  fill: string | null
  fillAlpha: number
  cornerRadius: number
  strokeWidth: number
  tool: string
  seed: number
}

export interface RoughArrowElement extends BaseElement {
  type: 'rough-arrow'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  strokeWidth: number
  arrowheadSize: number
  tool: string
  seed: number
}

export interface RoughPolygonElement extends BaseElement {
  type: 'rough-polygon'
  points: [number, number][]
  color: string
  fill: string | null
  fillAlpha: number
  strokeWidth: number
  tool: string
  seed: number
}

export interface TextElement extends BaseElement {
  type: 'text'
  text: string
  x: number
  y: number
  fontSize: number
  fontFamily: string
  color: string
  fontWeight: '400' | '600' | '700'
  textAlign: 'left' | 'center' | 'right'
}

export interface SVGPathSceneElement extends BaseElement {
  type: 'svg-path'
  d: string
  stroke: string
  strokeWidth: number
  fill: string
  fillOpacity: number
}

export interface SVGTextSceneElement extends BaseElement {
  type: 'svg-text'
  text: string
  x: number
  y: number
  fontSize: number
  fontFamily: string
  fill: string
  textAnchor: 'start' | 'middle' | 'end'
}

export interface SVGShapeSceneElement extends BaseElement {
  type: 'svg-shape'
  stroke: string
  strokeWidth: number
  fill: string
  fillOpacity: number
}

export interface ThreeObjectElement extends BaseElement {
  type: 'three-object'
  // Three.js elements are complex — only agent editing makes sense
  // bbox covers the full scene by default
}

export interface ZdogShapeElement extends BaseElement {
  type: 'zdog-shape'
}

export interface D3ChartElement extends BaseElement {
  type: 'd3-chart'
}

export interface ImageElement extends BaseElement {
  type: 'image'
  src: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export interface GroupElement extends BaseElement {
  type: 'group'
  children: string[] // child element ids
}

// ── DOM element types (React scene inspector) ──────────────────────────────

export interface DomTextElement extends BaseElement {
  type: 'dom-text'
  text: string
  color: string
  backgroundColor: string
  fontSize: number
  fontFamily: string
  fontWeight: string
  textAlign: string
  padding: string
  borderRadius: number
}

export interface DomContainerElement extends BaseElement {
  type: 'dom-container'
  backgroundColor: string
  borderRadius: number
  padding: string
  gap: string
  display: string
  flexDirection: string
  alignItems: string
  justifyContent: string
}

export interface DomImageElement extends BaseElement {
  type: 'dom-image'
  src: string
  width: number
  height: number
  borderRadius: number
  objectFit: string
}

// Union type
export type SceneElement =
  | RoughLineElement
  | RoughCircleElement
  | RoughRectElement
  | RoughArrowElement
  | RoughPolygonElement
  | TextElement
  | SVGPathSceneElement
  | SVGTextSceneElement
  | SVGShapeSceneElement
  | ThreeObjectElement
  | ZdogShapeElement
  | D3ChartElement
  | ImageElement
  | GroupElement
  | DomTextElement
  | DomContainerElement
  | DomImageElement

// ── Property metadata for the inspector UI ──────────────────────────────────

export type PropertyControlType = 'color' | 'number' | 'slider' | 'text' | 'textarea' | 'select' | 'toggle'

export interface PropertyMeta {
  key: string
  label: string
  control: PropertyControlType
  min?: number
  max?: number
  step?: number
  suffix?: string
  options?: string[]
  optionLabels?: string[]
  allowNone?: boolean
  group?: string // UI grouping: 'Content', 'Typography', 'Appearance', 'Layout', etc.
}

// Defines which properties each element type exposes in the inspector
export function getElementPropertyMap(W = 1920, H = 1080): Record<string, PropertyMeta[]> {
  return {
    'rough-line': [
      { key: 'color', label: 'Color', control: 'color' },
      { key: 'strokeWidth', label: 'Stroke width', control: 'slider', min: 0.5, max: 20, step: 0.5 },
      { key: 'tool', label: 'Tool', control: 'select', options: ['marker', 'pen', 'chalk', 'brush', 'highlighter'] },
      { key: 'x1', label: 'X1', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y1', label: 'Y1', control: 'slider', min: 0, max: H, step: 1 },
      { key: 'x2', label: 'X2', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y2', label: 'Y2', control: 'slider', min: 0, max: H, step: 1 },
    ],
    'rough-arrow': [
      { key: 'color', label: 'Color', control: 'color' },
      { key: 'strokeWidth', label: 'Stroke width', control: 'slider', min: 0.5, max: 20, step: 0.5 },
      { key: 'arrowheadSize', label: 'Arrowhead', control: 'slider', min: 5, max: 60, step: 1 },
      { key: 'tool', label: 'Tool', control: 'select', options: ['marker', 'pen', 'chalk', 'brush', 'highlighter'] },
      { key: 'x1', label: 'X1', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y1', label: 'Y1', control: 'slider', min: 0, max: H, step: 1 },
      { key: 'x2', label: 'X2', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y2', label: 'Y2', control: 'slider', min: 0, max: H, step: 1 },
    ],
    'rough-circle': [
      { key: 'color', label: 'Stroke', control: 'color' },
      { key: 'fill', label: 'Fill', control: 'color', allowNone: true },
      { key: 'fillAlpha', label: 'Fill opacity', control: 'slider', min: 0, max: 1, step: 0.05 },
      { key: 'strokeWidth', label: 'Stroke width', control: 'slider', min: 0.5, max: 20, step: 0.5 },
      { key: 'cx', label: 'Center X', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'cy', label: 'Center Y', control: 'slider', min: 0, max: H, step: 1 },
      { key: 'radius', label: 'Radius', control: 'slider', min: 1, max: Math.round(W / 2), step: 1 },
    ],
    'rough-rect': [
      { key: 'color', label: 'Stroke', control: 'color' },
      { key: 'fill', label: 'Fill', control: 'color', allowNone: true },
      { key: 'fillAlpha', label: 'Fill opacity', control: 'slider', min: 0, max: 1, step: 0.05 },
      { key: 'strokeWidth', label: 'Stroke width', control: 'slider', min: 0.5, max: 20, step: 0.5 },
      { key: 'cornerRadius', label: 'Corner radius', control: 'slider', min: 0, max: 100, step: 1 },
      { key: 'x', label: 'X', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y', label: 'Y', control: 'slider', min: 0, max: H, step: 1 },
      { key: 'width', label: 'Width', control: 'slider', min: 1, max: W, step: 1 },
      { key: 'height', label: 'Height', control: 'slider', min: 1, max: H, step: 1 },
    ],
    text: [
      { key: 'text', label: 'Text', control: 'textarea' },
      { key: 'color', label: 'Color', control: 'color' },
      { key: 'fontSize', label: 'Font size', control: 'slider', min: 8, max: 200, step: 1 },
      {
        key: 'fontWeight',
        label: 'Weight',
        control: 'select',
        options: ['400', '600', '700'],
        optionLabels: ['Regular', 'Semibold', 'Bold'],
      },
      { key: 'textAlign', label: 'Align', control: 'select', options: ['left', 'center', 'right'] },
      { key: 'x', label: 'X', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y', label: 'Y', control: 'slider', min: 0, max: H, step: 1 },
    ],
    'svg-path': [
      { key: 'stroke', label: 'Stroke', control: 'color', allowNone: true },
      { key: 'fill', label: 'Fill', control: 'color', allowNone: true },
      { key: 'strokeWidth', label: 'Stroke width', control: 'slider', min: 0, max: 20, step: 0.5 },
      { key: 'fillOpacity', label: 'Fill opacity', control: 'slider', min: 0, max: 1, step: 0.05 },
    ],
    'svg-text': [
      { key: 'text', label: 'Text', control: 'textarea' },
      { key: 'fill', label: 'Color', control: 'color' },
      { key: 'fontSize', label: 'Font size', control: 'slider', min: 8, max: 200, step: 1 },
      { key: 'textAnchor', label: 'Anchor', control: 'select', options: ['start', 'middle', 'end'] },
      { key: 'x', label: 'X', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y', label: 'Y', control: 'slider', min: 0, max: H, step: 1 },
    ],
    'svg-shape': [
      { key: 'stroke', label: 'Stroke', control: 'color', allowNone: true },
      { key: 'fill', label: 'Fill', control: 'color', allowNone: true },
      { key: 'strokeWidth', label: 'Stroke width', control: 'slider', min: 0, max: 20, step: 0.5 },
      { key: 'fillOpacity', label: 'Fill opacity', control: 'slider', min: 0, max: 1, step: 0.05 },
      { key: 'x', label: 'X', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y', label: 'Y', control: 'slider', min: 0, max: H, step: 1 },
      { key: 'width', label: 'Width', control: 'slider', min: 1, max: W, step: 1 },
      { key: 'height', label: 'Height', control: 'slider', min: 1, max: H, step: 1 },
    ],
    image: [
      { key: 'x', label: 'X', control: 'slider', min: 0, max: W, step: 1 },
      { key: 'y', label: 'Y', control: 'slider', min: 0, max: H, step: 1 },
      { key: 'width', label: 'Width', control: 'slider', min: 1, max: W, step: 1 },
      { key: 'height', label: 'Height', control: 'slider', min: 1, max: H, step: 1 },
      { key: 'rotation', label: 'Rotation', control: 'slider', min: -360, max: 360, step: 1, suffix: 'deg' },
    ],
    'dom-text': [
      { key: 'text', label: 'Content', control: 'textarea', group: 'Content' },
      { key: 'color', label: 'Color', control: 'color', group: 'Typography' },
      {
        key: 'fontSize',
        label: 'Size',
        control: 'slider',
        min: 8,
        max: 200,
        step: 1,
        suffix: 'px',
        group: 'Typography',
      },
      {
        key: 'fontWeight',
        label: 'Weight',
        control: 'select',
        options: ['300', '400', '500', '600', '700', '800', '900'],
        optionLabels: ['Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Extra Bold', 'Black'],
        group: 'Typography',
      },
      {
        key: 'textAlign',
        label: 'Align',
        control: 'select',
        options: ['left', 'center', 'right'],
        group: 'Typography',
      },
      { key: 'backgroundColor', label: 'Background', control: 'color', allowNone: true, group: 'Appearance' },
      { key: 'opacity', label: 'Opacity', control: 'slider', min: 0, max: 1, step: 0.05, group: 'Appearance' },
      {
        key: 'borderRadius',
        label: 'Radius',
        control: 'slider',
        min: 0,
        max: 50,
        step: 1,
        suffix: 'px',
        group: 'Appearance',
      },
    ],
    'dom-container': [
      { key: 'backgroundColor', label: 'Background', control: 'color', allowNone: true, group: 'Appearance' },
      { key: 'opacity', label: 'Opacity', control: 'slider', min: 0, max: 1, step: 0.05, group: 'Appearance' },
      {
        key: 'borderRadius',
        label: 'Radius',
        control: 'slider',
        min: 0,
        max: 50,
        step: 1,
        suffix: 'px',
        group: 'Appearance',
      },
      { key: 'padding', label: 'Padding', control: 'number', min: 0, max: 200, suffix: 'px', group: 'Layout' },
      { key: 'gap', label: 'Gap', control: 'number', min: 0, max: 100, suffix: 'px', group: 'Layout' },
      {
        key: 'flexDirection',
        label: 'Direction',
        control: 'select',
        options: ['row', 'column', 'row-reverse', 'column-reverse'],
        group: 'Layout',
      },
      {
        key: 'alignItems',
        label: 'Align',
        control: 'select',
        options: ['flex-start', 'center', 'flex-end', 'stretch'],
        optionLabels: ['Start', 'Center', 'End', 'Stretch'],
        group: 'Layout',
      },
      {
        key: 'justifyContent',
        label: 'Justify',
        control: 'select',
        options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
        optionLabels: ['Start', 'Center', 'End', 'Between', 'Around', 'Evenly'],
        group: 'Layout',
      },
    ],
    'dom-image': [
      { key: 'opacity', label: 'Opacity', control: 'slider', min: 0, max: 1, step: 0.05, group: 'Appearance' },
      {
        key: 'borderRadius',
        label: 'Radius',
        control: 'slider',
        min: 0,
        max: 50,
        step: 1,
        suffix: 'px',
        group: 'Appearance',
      },
      {
        key: 'objectFit',
        label: 'Fit',
        control: 'select',
        options: ['cover', 'contain', 'fill', 'none', 'scale-down'],
        group: 'Appearance',
      },
      { key: 'width', label: 'Width', control: 'slider', min: 10, max: W, step: 1, suffix: 'px', group: 'Size' },
      { key: 'height', label: 'Height', control: 'slider', min: 10, max: H, step: 1, suffix: 'px', group: 'Size' },
    ],
  }
}

/** @deprecated Use getElementPropertyMap(W, H) for aspect-ratio-aware constraints */
export const ELEMENT_PROPERTY_MAP = getElementPropertyMap()
