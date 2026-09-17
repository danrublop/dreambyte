/** Serialized keys for the scene layer stack (Layers panel). */

export type LayerStackKey =
  | `ai:${string}`
  | `svg:${string}`
  | `text:${string}`
  | `chart:${string}`
  | `scene:${string}`
  | `interaction:${string}`
  | `bg:${string}`
  | `rx:${string}`
  /** Standalone timeline audio clip (dropped file — not scene-owned). */
  | `clip:${string}`
  | 'video'
  | 'audio'

export const BG_STAGE_STACK_KEY = 'bg:stage' as LayerStackKey

export function parseLayerStackKey(k: string): { kind: string; id: string | null } {
  const i = k.indexOf(':')
  if (i < 0) return { kind: k, id: null }
  return { kind: k.slice(0, i), id: k.slice(i + 1) }
}

/** Keep stack tail stable: … | background | video | audio */
export function pinLayerStackTail(keys: LayerStackKey[]): LayerStackKey[] {
  const bg = keys.filter((k) => k === BG_STAGE_STACK_KEY)
  const vid = keys.filter((k) => k === 'video')
  const aud = keys.filter((k) => k === 'audio')
  const mid = keys.filter((k) => k !== BG_STAGE_STACK_KEY && k !== 'video' && k !== 'audio')
  return [...mid, ...bg, ...vid, ...aud]
}
