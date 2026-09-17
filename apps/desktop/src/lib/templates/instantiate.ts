/**
 * Template instantiation — creates a Scene from a template
 * by cloning layers, generating new IDs, and filling placeholders.
 */

import { v4 as uuidv4 } from 'uuid'
import type { Scene, SceneLayer, InteractionElement } from '../types'
import type { SceneTemplate } from './types'

/**
 * Replace ${PLACEHOLDER} tokens in a string with values.
 */
export function replacePlaceholders(code: string, values: Record<string, string>): string {
  let result = code
  for (const [key, val] of Object.entries(values)) {
    result = result.replaceAll(`\${${key}}`, val)
  }
  return result
}

/**
 * Deep-replace placeholder tokens in an interaction element's text fields.
 */
function fillInteractionPlaceholders(el: InteractionElement, values: Record<string, string>): InteractionElement {
  const fill = (s: string | null | undefined) => (s ? replacePlaceholders(s, values) : s)

  const base = { ...el }
  switch (base.type) {
    case 'hotspot':
      return { ...base, label: fill(base.label) ?? base.label } as InteractionElement
    case 'choice':
      return {
        ...base,
        question: fill(base.question) ?? base.question,
        options: base.options.map((o) => ({ ...o, label: fill(o.label) ?? o.label })),
      } as InteractionElement
    case 'quiz':
      return {
        ...base,
        question: fill(base.question) ?? base.question,
        explanation: fill(base.explanation) ?? base.explanation,
        options: base.options.map((o) => ({ ...o, label: fill(o.label) ?? o.label })),
      } as InteractionElement
    case 'gate':
      return { ...base, buttonLabel: fill(base.buttonLabel) ?? base.buttonLabel } as InteractionElement
    case 'tooltip':
      return {
        ...base,
        triggerLabel: fill(base.triggerLabel) ?? base.triggerLabel,
        tooltipTitle: fill(base.tooltipTitle) ?? base.tooltipTitle,
        tooltipBody: fill(base.tooltipBody) ?? base.tooltipBody,
      } as InteractionElement
    case 'form':
      return {
        ...base,
        submitLabel: fill(base.submitLabel) ?? base.submitLabel,
        fields: base.fields.map((f) => ({ ...f, label: fill(f.label) ?? f.label })),
      } as InteractionElement
    default:
      return base
  }
}

/**
 * Create a new Scene from a template and placeholder values.
 */
export function instantiateTemplate(
  template: SceneTemplate,
  placeholderValues: Record<string, string>,
  sceneName?: string,
): Scene {
  // NOTE: template.layers is intentionally not read here. It used to be cloned
  // into a local `layers` that was then never referenced — the returned Scene
  // has no `layers` field to put it in (Scene carries aiLayers / svgObjects /
  // reactCode instead), so the template layer model predates the current Scene
  // shape. The clone was dead work that made this function look like it carried
  // layers across when it silently dropped them. Interactions are the only
  // content a template actually contributes; see templateHasContent.

  // Clone and fill interactions from template
  const interactions: InteractionElement[] = (template.interactions ?? []).map((tmplEl) => {
    const el = { ...(tmplEl as any), id: uuidv4() } as InteractionElement
    return fillInteractionPlaceholders(el, placeholderValues)
  })

  return {
    id: uuidv4(),
    name: sceneName ?? template.name,
    prompt: '',
    summary: template.description,
    svgContent: '',
    duration: template.duration,
    bgColor: template.styleOverride.bgColor ?? '#fffef9',
    thumbnail: null,
    videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: { enabled: false, src: null, volume: 1, fadeIn: false, fadeOut: false, startOffset: 0 },
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: 'none',
    usage: null,
    sceneType: 'canvas2d',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: '',
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    interactions,
    variables: [],
    aiLayers: [],
    messages: [],
    styleOverride: template.styleOverride,
    cameraMotion: null,
    worldConfig: null,
  }
}
