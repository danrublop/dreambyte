/**
 * Element serializer — converts element JSON back to canvas2d / SVG code.
 *
 * When the inspector modifies element properties, the updated element data
 * must be serialized back to scene code for persistence.
 */

import type { SceneElement } from '@/lib/types/elements'

export function serializeElementsToCode(elements: SceneElement[], sceneType: string): string {
  if (sceneType === 'canvas2d') {
    return serializeToCanvas2D(elements)
  }
  if (sceneType === 'svg') {
    return serializeToSVG(elements)
  }
  return ''
}

function serializeToCanvas2D(elements: SceneElement[]): string {
  const safeVarName = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_')

  const registrations = elements.map((el) => `window.__register(${JSON.stringify(el)});`).join('\n  ')

  const proxyDecls = elements.map((el) => `const proxy_${safeVarName(el.id)} = { p: 0 };`).join('\n  ')

  const proxyMap = elements.map((el) => `proxies['${el.id}'] = proxy_${safeVarName(el.id)};`).join('\n    ')

  const timeline = elements
    .map((el) => {
      return `
    tl.add(proxy_${safeVarName(el.id)}, {
      p: [0, 1],
      duration: ${el.animDuration},
      ease: 'outCubic',
      onUpdate: redrawAll,
    }, ${el.animStartTime});`
    })
    .join('')

  const drawCases = `
      switch (el.type) {
        case 'rough-line':
          drawRoughLineAtProgress(ctx, el.x1, el.y1, el.x2, el.y2,
            proxies[el.id]?.p ?? 1,
            { color: el.color, tool: el.tool, seed: el.seed, strokeWidth: el.strokeWidth });
          break;
        case 'rough-arrow':
          drawRoughArrowAtProgress(ctx, el.x1, el.y1, el.x2, el.y2,
            proxies[el.id]?.p ?? 1,
            { color: el.color, tool: el.tool, seed: el.seed, strokeWidth: el.strokeWidth, arrowheadSize: el.arrowheadSize });
          break;
        case 'rough-circle':
          drawRoughCircleAtProgress(ctx, el.cx, el.cy, el.radius,
            proxies[el.id]?.p ?? 1,
            { color: el.color, fill: el.fill, fillAlpha: el.fillAlpha, tool: el.tool, seed: el.seed, strokeWidth: el.strokeWidth });
          break;
        case 'rough-rect':
          drawRoughRectAtProgress(ctx, el.x, el.y, el.width, el.height,
            proxies[el.id]?.p ?? 1,
            { color: el.color, fill: el.fill, fillAlpha: el.fillAlpha, tool: el.tool, seed: el.seed, strokeWidth: el.strokeWidth, cornerRadius: el.cornerRadius });
          break;
        case 'text':
          drawTextAtProgress(ctx, el.text, el.x, el.y,
            proxies[el.id]?.p ?? 1,
            { fontSize: el.fontSize, fontFamily: el.fontFamily, color: el.color, fontWeight: el.fontWeight, textAlign: el.textAlign });
          break;
        default:
          break;
      }`

  return `
document.fonts.ready.then(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const tl = window.__tl;
  const proxies = {};

  ${proxyDecls}
  ${registrations}
  ${proxyMap}

  function redrawAll() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    Object.values(window.__elements)
      .filter(el => el.visible)
      .forEach(el => {
        ctx.globalAlpha = el.opacity;
${drawCases}
        ctx.globalAlpha = 1;
      });
  }

  window.__redrawAll = redrawAll;
  ${timeline}

  redrawAll();
});`
}

function serializeToSVG(elements: SceneElement[]): string {
  // SVG elements are DOM nodes — we generate an SVG string from element data
  const svgElements = elements
    .map((el) => {
      switch (el.type) {
        case 'svg-path':
          return `<path id="${el.id}" data-label="${el.label}"
  d="${(el as any).d}"
  stroke="${(el as any).stroke || 'none'}"
  stroke-width="${(el as any).strokeWidth || 0}"
  fill="${(el as any).fill || 'none'}"
  fill-opacity="${(el as any).fillOpacity ?? 1}"
  opacity="${el.opacity}" />`

        case 'svg-text':
          return `<text id="${el.id}" data-label="${el.label}"
  x="${(el as any).x}" y="${(el as any).y}"
  font-size="${(el as any).fontSize}"
  font-family="${(el as any).fontFamily || ''}"
  fill="${(el as any).fill || '#000'}"
  text-anchor="${(el as any).textAnchor || 'start'}"
  opacity="${el.opacity}">${(el as any).text || ''}</text>`

        case 'svg-shape':
          return `<!-- svg-shape ${el.id}: edit via agent -->`

        default:
          return `<!-- ${el.type} ${el.id} -->`
      }
    })
    .join('\n  ')

  return `<svg viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
  ${svgElements}
</svg>`
}

// ── SVG attribute-level patcher ──────────────────────────────
// Instead of regenerating the entire SVG, patch a single attribute
// on a specific element. Preserves all other SVG structure.

const PROP_TO_SVG_ATTR: Record<string, string> = {
  strokeWidth: 'stroke-width',
  fontSize: 'font-size',
  fontFamily: 'font-family',
  fillOpacity: 'fill-opacity',
  textAnchor: 'text-anchor',
  // These map 1:1
  fill: 'fill',
  stroke: 'stroke',
  opacity: 'opacity',
  x: 'x',
  y: 'y',
  cx: 'cx',
  cy: 'cy',
  r: 'r',
  rx: 'rx',
  ry: 'ry',
  width: 'width',
  height: 'height',
}

export function patchSVGAttribute(svgContent: string, elementId: string, property: string, value: unknown): string {
  if (!svgContent || !elementId) return svgContent

  // Special case: text content
  if (property === 'text') {
    // Match element by id and replace its text content
    // Handles <text id="...">old text</text> and <tspan>
    const textPattern = new RegExp(
      `(<(?:text|tspan)[^>]*\\bid="${escapeRegex(elementId)}"[^>]*>)([^<]*)(</(?:text|tspan)>)`,
      'i',
    )
    if (textPattern.test(svgContent)) {
      return svgContent.replace(textPattern, `$1${escapeXml(String(value))}$3`)
    }
    return svgContent
  }

  // Special case: visible → display attribute
  if (property === 'visible') {
    const displayVal = value ? 'inline' : 'none'
    return patchOrAddAttribute(svgContent, elementId, 'display', displayVal)
  }

  const attrName = PROP_TO_SVG_ATTR[property]
  if (!attrName) return svgContent // Unknown property, skip

  return patchOrAddAttribute(svgContent, elementId, attrName, String(value))
}

function patchOrAddAttribute(svgContent: string, elementId: string, attrName: string, attrValue: string): string {
  // Find the element's opening tag by id
  const idPattern = new RegExp(`(<[^>]*\\bid="${escapeRegex(elementId)}"[^>]*?)(/?>)`, 'i')
  const match = svgContent.match(idPattern)
  if (!match) return svgContent

  const openTag = match[1]
  const closeSlash = match[2]

  // Check if the attribute already exists in the tag
  const attrPattern = new RegExp(`\\b${escapeRegex(attrName)}="[^"]*"`)
  if (attrPattern.test(openTag)) {
    // Replace existing attribute value
    const updatedTag = openTag.replace(attrPattern, `${attrName}="${escapeXml(attrValue)}"`)
    return svgContent.replace(idPattern, updatedTag + closeSlash)
  } else {
    // Add the attribute before the closing > or />
    const updatedTag = openTag + ` ${attrName}="${escapeXml(attrValue)}"`
    return svgContent.replace(idPattern, updatedTag + closeSlash)
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
