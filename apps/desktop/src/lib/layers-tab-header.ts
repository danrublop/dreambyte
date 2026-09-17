/** Persisted Layers tab strip (second header) — mirrors Agent chat tab UX. */

export type LayersTabSectionId =
  | 'scenes'
  | 'studio'
  | 'properties'
  | 'audio'
  | 'elements'
  | 'text'
  | 'interact'
  | 'nodemap'

/** Old tab ids → Scene panel (Content + legacy Components tabs removed) */
const LEGACY_TAB_TO_SCENE = new Set(['media', 'ai', 'content', 'transitions', 'charts', 'avatar', 'three'])

/** Persisted `style` tab → Scene panel */
const LEGACY_STYLE_TO_SCENE = 'style'

/** Tabs shown in the strip config (⋯) — Elements is opened via preview only, not listed here */
export const LAYERS_TAB_META: { id: LayersTabSectionId; label: string }[] = [
  { id: 'scenes', label: 'Scenes' },
  { id: 'studio', label: 'Studio' },
  { id: 'audio', label: 'Audio' },
  { id: 'interact', label: 'Interact' },
  { id: 'nodemap', label: 'Layers' },
]

const EXTRA_TAB_LABELS: Partial<Record<LayersTabSectionId, string>> = {
  elements: 'Elements',
}

export function layersTabLabel(id: LayersTabSectionId): string {
  return LAYERS_TAB_META.find((m) => m.id === id)?.label ?? EXTRA_TAB_LABELS[id] ?? id
}

export const DEFAULT_LAYERS_VISIBLE_TABS: LayersTabSectionId[] = ['nodemap', 'studio', 'audio']

const STORAGE_KEY = 'dreambyte.layersTab.subheader.v1'

export type LayersTabHeaderPersisted = {
  visibleTabIds: LayersTabSectionId[]
  activeTabId: LayersTabSectionId
}

const DEFAULT_PERSISTED: LayersTabHeaderPersisted = {
  visibleTabIds: [...DEFAULT_LAYERS_VISIBLE_TABS],
  activeTabId: 'nodemap',
}

function migrateVisibleTabs(rawIds: unknown): LayersTabSectionId[] {
  const allowed = new Set(LAYERS_TAB_META.map((m) => m.id))
  const arr = Array.isArray(rawIds) ? rawIds : DEFAULT_LAYERS_VISIBLE_TABS
  const mapped = arr.map((id) => {
    if (typeof id !== 'string') return id as LayersTabSectionId
    if (id === LEGACY_STYLE_TO_SCENE) return 'studio'
    if (LEGACY_TAB_TO_SCENE.has(id)) return 'studio'
    if (id === 'scene') return 'studio'
    if (id === 'properties') return 'nodemap'
    return id as LayersTabSectionId
  })
  const deduped: LayersTabSectionId[] = []
  for (const id of mapped) {
    if (!allowed.has(id)) continue
    if (!deduped.includes(id)) deduped.push(id)
  }
  // Auto-add newly-introduced default tabs that weren't in the persisted set
  for (const id of DEFAULT_LAYERS_VISIBLE_TABS) {
    if (!deduped.includes(id)) deduped.push(id)
  }
  return deduped.length > 0 ? deduped : [...DEFAULT_LAYERS_VISIBLE_TABS]
}

export function loadLayersTabHeader(): LayersTabHeaderPersisted {
  if (typeof window === 'undefined') return { ...DEFAULT_PERSISTED, visibleTabIds: [...DEFAULT_LAYERS_VISIBLE_TABS] }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PERSISTED, visibleTabIds: [...DEFAULT_LAYERS_VISIBLE_TABS] }
    const p = JSON.parse(raw) as {
      visibleTabIds?: unknown
      activeTabId?: string
    }
    const allowed = new Set(LAYERS_TAB_META.map((m) => m.id))
    let visible = migrateVisibleTabs(p.visibleTabIds)
    let activeRaw: string | undefined = p.activeTabId
    if (typeof activeRaw === 'string') {
      if (activeRaw === LEGACY_STYLE_TO_SCENE) activeRaw = 'studio'
      else if (LEGACY_TAB_TO_SCENE.has(activeRaw)) activeRaw = 'studio'
      else if (activeRaw === 'scene') activeRaw = 'studio'
    }
    let active = (
      activeRaw && allowed.has(activeRaw as LayersTabSectionId) ? activeRaw : visible[0]
    ) as LayersTabSectionId
    if (!visible.includes(active)) active = visible[0]
    return {
      visibleTabIds: visible,
      activeTabId: active,
    }
  } catch {
    return { ...DEFAULT_PERSISTED, visibleTabIds: [...DEFAULT_LAYERS_VISIBLE_TABS] }
  }
}

export function saveLayersTabHeader(p: LayersTabHeaderPersisted): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}
