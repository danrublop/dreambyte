/**
 * Scene-to-scene transitions for MP4 export (FFmpeg xfade) and editor metadata.
 * `xfade` is the FFmpeg filter name; `null` means a hard cut (handled in stitcher).
 */
export const TRANSITION_CATALOG = [
  { id: 'none' as const, label: 'Cut', category: 'Basics', xfade: null },
  { id: 'crossfade' as const, label: 'Crossfade', category: 'Basics', xfade: 'fade' },
  { id: 'dissolve' as const, label: 'Dissolve', category: 'Basics', xfade: 'dissolve' },
  { id: 'fade-black' as const, label: 'Fade through black', category: 'Basics', xfade: 'fadeblack' },
  { id: 'fade-white' as const, label: 'Fade through white', category: 'Basics', xfade: 'fadewhite' },

  { id: 'wipe-left' as const, label: 'Wipe left', category: 'Wipe', xfade: 'wipeleft' },
  { id: 'wipe-right' as const, label: 'Wipe right', category: 'Wipe', xfade: 'wiperight' },
  { id: 'wipe-up' as const, label: 'Wipe up', category: 'Wipe', xfade: 'wipeup' },
  { id: 'wipe-down' as const, label: 'Wipe down', category: 'Wipe', xfade: 'wipedown' },
  { id: 'wipe-tl' as const, label: 'Wipe corner TL', category: 'Wipe', xfade: 'wipetl' },
  { id: 'wipe-tr' as const, label: 'Wipe corner TR', category: 'Wipe', xfade: 'wipetr' },
  { id: 'wipe-bl' as const, label: 'Wipe corner BL', category: 'Wipe', xfade: 'wipebl' },
  { id: 'wipe-br' as const, label: 'Wipe corner BR', category: 'Wipe', xfade: 'wipebr' },

  { id: 'slide-left' as const, label: 'Slide left', category: 'Slide', xfade: 'slideleft' },
  { id: 'slide-right' as const, label: 'Slide right', category: 'Slide', xfade: 'slideright' },
  { id: 'slide-up' as const, label: 'Slide up', category: 'Slide', xfade: 'slideup' },
  { id: 'slide-down' as const, label: 'Slide down', category: 'Slide', xfade: 'slidedown' },

  { id: 'smooth-left' as const, label: 'Smooth left', category: 'Smooth', xfade: 'smoothleft' },
  { id: 'smooth-right' as const, label: 'Smooth right', category: 'Smooth', xfade: 'smoothright' },
  { id: 'smooth-up' as const, label: 'Smooth up', category: 'Smooth', xfade: 'smoothup' },
  { id: 'smooth-down' as const, label: 'Smooth down', category: 'Smooth', xfade: 'smoothdown' },

  { id: 'circle-open' as const, label: 'Iris open', category: 'Shape', xfade: 'circleopen' },
  { id: 'circle-close' as const, label: 'Iris close', category: 'Shape', xfade: 'circleclose' },
  { id: 'radial' as const, label: 'Radial', category: 'Shape', xfade: 'radial' },
  { id: 'vert-open' as const, label: 'Vertical open', category: 'Shape', xfade: 'vertopen' },
  { id: 'horz-open' as const, label: 'Horizontal open', category: 'Shape', xfade: 'horzopen' },

  { id: 'cover-left' as const, label: 'Cover left', category: 'Cover / reveal', xfade: 'coverleft' },
  { id: 'cover-right' as const, label: 'Cover right', category: 'Cover / reveal', xfade: 'coverright' },
  { id: 'reveal-left' as const, label: 'Reveal left', category: 'Cover / reveal', xfade: 'revealleft' },
  { id: 'reveal-right' as const, label: 'Reveal right', category: 'Cover / reveal', xfade: 'revealright' },

  { id: 'diag-tl' as const, label: 'Diagonal TL', category: 'Diagonal', xfade: 'diagtl' },
  { id: 'diag-tr' as const, label: 'Diagonal TR', category: 'Diagonal', xfade: 'diagtr' },
  { id: 'diag-bl' as const, label: 'Diagonal BL', category: 'Diagonal', xfade: 'diagbl' },
  { id: 'diag-br' as const, label: 'Diagonal BR', category: 'Diagonal', xfade: 'diagbr' },

  { id: 'zoom-in' as const, label: 'Zoom in', category: 'Depth', xfade: 'zoomin' },
  { id: 'distance' as const, label: 'Distance', category: 'Depth', xfade: 'distance' },
] as const

export type TransitionType = (typeof TRANSITION_CATALOG)[number]['id']

export type TransitionCatalogEntry = (typeof TRANSITION_CATALOG)[number]

/** Ordered groups for the Layers tab UI */
export const TRANSITION_UI_GROUPS: { category: string; items: { id: TransitionType; label: string }[] }[] = (() => {
  const order: string[] = []
  const map = new Map<string, { id: TransitionType; label: string }[]>()
  for (const row of TRANSITION_CATALOG) {
    if (!map.has(row.category)) {
      order.push(row.category)
      map.set(row.category, [])
    }
    map.get(row.category)!.push({ id: row.id, label: row.label })
  }
  return order.map((category) => ({ category, items: map.get(category)! }))
})()

export const ALL_TRANSITION_IDS: TransitionType[] = TRANSITION_CATALOG.map((r) => r.id)

const VALID = new Set<string>(ALL_TRANSITION_IDS)

export function isValidTransition(s: string): s is TransitionType {
  return VALID.has(s)
}

/** Coerce stored/API strings to a known transition (unknown → none). */
export function normalizeTransition(raw: unknown): TransitionType {
  if (typeof raw === 'string' && isValidTransition(raw)) return raw

  // Legacy / DB shape: { type: 'crossfade', duration: 0.5 }
  if (raw && typeof raw === 'object' && 'type' in raw) {
    const t = (raw as any).type
    if (typeof t === 'string' && isValidTransition(t)) return t
  }

  return 'none'
}

export function getTransitionXfadeName(t: TransitionType): string | null {
  const row = TRANSITION_CATALOG.find((r) => r.id === t)
  return row?.xfade ?? null
}

/** True when the interactive / preview player should run a short fade-in between scenes. */
export function transitionUsesBlendInPlayer(t: TransitionType): boolean {
  return t !== 'none'
}
