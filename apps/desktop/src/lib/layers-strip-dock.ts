/** Layers left-strip tabs that can be torn off into the Electron center tab strip. */

export const LAYERS_STRIP_TAB_IDS = ['nodemap', 'studio', 'audio', 'text'] as const

export type LayersStripTabId = (typeof LAYERS_STRIP_TAB_IDS)[number]

const ID_SET = new Set<string>(LAYERS_STRIP_TAB_IDS)

export const LAYERS_TAB_DRAG_TYPE = 'application/x-dreambyte-layers-strip-tab'

export const LAYERS_STRIP_TAB_LABELS: Record<LayersStripTabId, string> = {
  nodemap: 'Layers',
  studio: 'Studio',
  audio: 'Audio',
  text: 'Text',
}

export function layersStripToCenterTabId(id: LayersStripTabId): `layers:${LayersStripTabId}` {
  return `layers:${id}`
}

export function parseLayersStripCenterTabId(tab: string): LayersStripTabId | null {
  if (!tab.startsWith('layers:')) return null
  const rest = tab.slice('layers:'.length)
  return ID_SET.has(rest) ? (rest as LayersStripTabId) : null
}

export function isLayersStripTabId(s: string): s is LayersStripTabId {
  return ID_SET.has(s)
}
