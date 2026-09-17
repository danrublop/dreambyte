'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  Box,
  Camera,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clapperboard,
  Code2,
  Eye,
  EyeOff,
  Film,
  Globe,
  Hash,
  Image as ImageIcon,
  Layers,
  LayoutTemplate,
  MousePointerClick,
  Music,
  Palette,
  Sparkles,
  SplitSquareHorizontal,
  Type,
  User,
  Volume2,
} from 'lucide-react'
import { BG_STAGE_STACK_KEY, type LayerStackKey, parseLayerStackKey, pinLayerStackTail } from '@/lib/layer-stack-keys'
import { useVideoStore } from '@/lib/store'
import type { AILayer, AudioLayer, D3ChartLayer, InteractionElement, Scene, SceneType } from '@/lib/types'
import { InteractionTextBulkForm } from '@/components/tabs/InteractTab'
import { extractElementsFromReactCode } from '@/lib/react-extract'
import { pickSceneCodeField } from '@/lib/code-text-slots'
import { deriveChartLayersFromScene } from '@/lib/charts/extract'
import {
  chartLayerTitleLine,
  layerHiddenIdForTextSlot,
  listSvgTextElementsInMarkup,
  MAIN_SCENE_SVG_LAYER_ID,
  svgMarkupLikelyHasTextElements,
} from '@/lib/text-slots'

const LAYER_STACK_BODY_H_KEY = 'dreambyte.layerStack.bodyHeight.v1'
const LAYER_STACK_H_MIN = 100
const LAYER_STACK_H_MAX = 560
const LAYER_STACK_H_DEFAULT = 280

function clampStackBodyHeight(px: number): number {
  return Math.max(LAYER_STACK_H_MIN, Math.min(LAYER_STACK_H_MAX, Math.round(px)))
}

function readStackBodyHeight(): number {
  if (typeof window === 'undefined') return LAYER_STACK_H_DEFAULT
  try {
    const raw = localStorage.getItem(LAYER_STACK_BODY_H_KEY)
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n)) return clampStackBodyHeight(n)
    }
  } catch {
    /* ignore */
  }
  return LAYER_STACK_H_DEFAULT
}

type StackKey = LayerStackKey
const parseKey = parseLayerStackKey

/** Timeline “base” renderers — one stack row each (plus canvas background when used as a separate lane). */
const SCENE_RENDERER_STACK_TYPES: readonly SceneType[] = [
  'canvas2d',
  'motion',
  'd3',
  'three',
  'lottie',
  'zdog',
  'avatar_scene',
  '3d_world',
] as const

function pushSceneRendererStackKeys(scene: Scene, keys: StackKey[]) {
  const st = (scene.sceneType ?? 'svg') as SceneType
  if ((SCENE_RENDERER_STACK_TYPES as readonly string[]).includes(st)) {
    keys.push(`scene:${st}` as StackKey)
  }
  if (scene.canvasBackgroundCode?.trim() && st !== 'canvas2d') {
    keys.push('scene:canvas_bg' as StackKey)
  }
}

function audioRowVisible(a: AudioLayer): boolean {
  return (
    a.enabled ||
    !!a.tts?.src ||
    !!a.tts?.text?.trim?.() ||
    a.tts?.status === 'ready' ||
    a.tts?.status === 'generating' ||
    a.tts?.status === 'pending' ||
    (a.sfx?.length ?? 0) > 0 ||
    !!a.music
  )
}

function isEditableExtractedKind(kind: string): boolean {
  return (
    kind === 'heading' ||
    kind === 'paragraph' ||
    kind === 'image' ||
    kind === 'button' ||
    kind === 'listItem' ||
    kind === 'text'
  )
}

/**
 * Media-asset scenes (a video/image dropped onto the timeline becomes its own
 * scene) read as plain media in the stack: just the asset layer, no Background
 * row, and a type-matched icon on the scene row. Any authored content — code,
 * overlays, svg objects, interactions — makes it a regular scene again.
 */
export function mediaSceneKind(scene: Scene): 'video' | 'image' | null {
  const hasAuthoredContent = !!(
    scene.reactCode?.trim() ||
    scene.sceneCode?.trim() ||
    scene.canvasCode?.trim() ||
    scene.svgContent?.trim() ||
    (scene.textOverlays?.length ?? 0) > 0 ||
    (scene.svgObjects?.length ?? 0) > 0 ||
    (scene.interactions?.length ?? 0) > 0 ||
    (scene.chartLayers?.length ?? 0) > 0
  )
  if (hasAuthoredContent) return null
  const ai = scene.aiLayers ?? []
  if (scene.videoLayer?.enabled && scene.videoLayer.src && ai.length === 0) return 'video'
  if (ai.length > 0 && ai.every((l) => l.type === 'image') && !scene.videoLayer?.enabled) return 'image'
  return null
}

function buildDefaultOrder(scene: Scene): StackKey[] {
  const keys: StackKey[] = []
  const ai = [...(scene.aiLayers ?? [])].sort((x, y) => y.zIndex - x.zIndex)
  ai.forEach((l) => keys.push(`ai:${l.id}` as StackKey))
  const svg = [...(scene.svgObjects ?? [])].sort((x, y) => y.zIndex - x.zIndex)
  svg.forEach((o) => keys.push(`svg:${o.id}` as StackKey))
  const mainSvg = scene.svgContent?.trim() ?? ''
  if (mainSvg && svgMarkupLikelyHasTextElements(mainSvg)) {
    keys.push(`svg:${MAIN_SCENE_SVG_LAYER_ID}` as StackKey)
  }
  ;(scene.textOverlays ?? []).forEach((t) => keys.push(`text:${t.id}` as StackKey))
  deriveChartLayersFromScene(scene).forEach((c) => keys.push(`chart:${c.id}` as StackKey))
  pushSceneRendererStackKeys(scene, keys)
  ;(scene.interactions ?? []).forEach((it) => keys.push(`interaction:${it.id}` as StackKey))
  // Code-extracted elements (React bridge components, Three.js objects, text, etc.)
  // Scan the same field the renderer reads, so the layer-stack rows and the
  // typography editor agree on what the user is seeing.
  const codeField = pickSceneCodeField(scene)
  const codeToScan = codeField ? ((scene as unknown as Record<string, string | undefined>)[codeField] ?? '').trim() : ''
  if (codeToScan) {
    const rxElements = extractElementsFromReactCode(codeToScan)
    const seen = new Set<string>()
    let rxIdx = 0
    for (const el of rxElements) {
      if (!isEditableExtractedKind(el.kind)) continue
      const dedupKey = `${el.kind}:${el.label}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      keys.push(`rx:${el.kind}:${rxIdx}` as StackKey)
      rxIdx++
    }
  }
  // Media-asset scenes show only the asset — no Background row.
  if (mediaSceneKind(scene) === null) keys.push(BG_STAGE_STACK_KEY)
  if (scene.videoLayer?.enabled && scene.videoLayer.src) keys.push('video')
  if (scene.audioLayer && audioRowVisible(scene.audioLayer)) keys.push('audio')
  return keys
}

function mergeOrder(custom: string[] | undefined, fallback: StackKey[]): StackKey[] {
  const valid = new Set(fallback)
  const out: StackKey[] = []
  if (custom?.length) {
    for (const k of custom) {
      if (valid.has(k as StackKey)) out.push(k as StackKey)
    }
  }
  for (const k of fallback) {
    if (!out.includes(k)) out.push(k)
  }
  return pinLayerStackTail(out)
}

function labelForKey(scene: Scene, key: StackKey): string {
  const { kind, id } = parseKey(key)
  if (kind === 'bg' && id === 'stage') return 'Background'
  if (kind === 'video') return 'Video'
  if (kind === 'audio') return 'Audio'
  if (kind === 'ai' && id) {
    const l = (scene.aiLayers ?? []).find((x) => x.id === id)
    return l?.label ?? 'AI layer'
  }
  if (kind === 'svg' && id) {
    if (id === MAIN_SCENE_SVG_LAYER_ID) return 'Scene SVG'
    const o = (scene.svgObjects ?? []).find((x) => x.id === id)
    const p = (o?.prompt ?? '').trim()
    return p ? p.slice(0, 28) + (p.length > 28 ? '…' : '') : 'SVG object'
  }
  if (kind === 'text' && id) {
    const t = (scene.textOverlays ?? []).find((x) => x.id === id)
    const c = (t?.content ?? '').trim()
    return c ? c.slice(0, 28) + (c.length > 28 ? '…' : '') : 'Text'
  }
  if (kind === 'chart' && id) {
    const c = deriveChartLayersFromScene(scene).find((x) => x.id === id)
    return c?.name ?? 'Chart'
  }
  if (kind === 'interaction' && id) {
    const ix = (scene.interactions ?? []).find((x) => x.id === id)
    if (!ix) return 'Interaction'
    const preview =
      ix.type === 'hotspot'
        ? (ix as InteractionElement & { type: 'hotspot' }).label
        : ix.type === 'gate'
          ? (ix as InteractionElement & { type: 'gate' }).buttonLabel
          : ix.type === 'tooltip'
            ? (ix as InteractionElement & { type: 'tooltip' }).tooltipTitle
            : ix.type === 'choice'
              ? ((ix as InteractionElement & { type: 'choice' }).question ?? '').slice(0, 24)
              : ix.type === 'quiz'
                ? (ix as InteractionElement & { type: 'quiz' }).question.slice(0, 24)
                : ix.type === 'form'
                  ? (ix as InteractionElement & { type: 'form' }).submitLabel
                  : ''
    const tail = preview ? ` · ${preview.slice(0, 22)}${preview.length > 22 ? '…' : ''}` : ''
    return `${ix.type}${tail}`
  }
  if (kind === 'scene' && id) {
    const labels: Record<string, string> = {
      canvas2d: 'Canvas 2D',
      motion: 'Motion',
      d3: 'D3 scene',
      three: 'Three.js',
      lottie: 'Lottie',
      zdog: 'Zdog',
      avatar_scene: 'Avatar scene',
      '3d_world': '3D world',
      canvas_bg: 'Canvas background',
    }
    return labels[id] ?? id
  }
  if (kind === 'rx') {
    // Code-extracted elements: id is "subkind:index", e.g. "heading:0".
    // The rxIdx in `id` is the position AFTER filtering by editable kinds
    // and deduping by `${kind}:${label}` — same walk buildDefaultOrder uses.
    // We MUST replay that walk here; raw indexing into rxElements drifts
    // whenever non-editable kinds (bridge components, three meshes, …)
    // precede the target or when duplicate text causes dedup skips.
    const codeField = pickSceneCodeField(scene)
    const codeToScan = codeField
      ? ((scene as unknown as Record<string, string | undefined>)[codeField] ?? '').trim()
      : ''
    if (codeToScan) {
      const rxElements = extractElementsFromReactCode(codeToScan)
      const parts = (id ?? '').split(':')
      const targetIdx = parseInt(parts[1] ?? '0', 10)
      const seen = new Set<string>()
      let walked = 0
      for (const el of rxElements) {
        if (!isEditableExtractedKind(el.kind)) continue
        const dedupKey = `${el.kind}:${el.label}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        if (walked === targetIdx) return el.label
        walked++
      }
    }
    return id ?? 'Element'
  }
  if (kind === 'camera') {
    const n = scene.cameraMotion?.length ?? 0
    return n > 0 ? `Camera (${n})` : 'Camera'
  }
  if (kind === 'transition')
    return scene.transition && scene.transition !== 'none' ? `Transition: ${scene.transition}` : 'Transition'
  if (kind === 'style') return 'Style Override'
  if (kind === 'variables') {
    const n = scene.variables?.length ?? 0
    return n > 0 ? `Variables (${n})` : 'Variables'
  }
  if (kind === 'tts') {
    const t = (scene.audioLayer?.tts?.text ?? '').trim()
    return t ? `TTS · ${t.slice(0, 28)}${t.length > 28 ? '…' : ''}` : 'Narration'
  }
  if (kind === 'music') {
    const name = (scene.audioLayer?.music?.name ?? '').trim()
    return name ? `Music · ${name.slice(0, 28)}${name.length > 28 ? '…' : ''}` : 'Music'
  }
  if (kind === 'sfx' && id) {
    const s = (scene.audioLayer?.sfx ?? []).find((x) => x.id === id)
    return s?.name ?? 'SFX'
  }
  if (kind === '3d' && id) {
    const parts = id.split(':')
    const sub = parts[0]
    const subIdx = parseInt(parts[1] ?? '0', 10)
    const wc = scene.worldConfig
    if (sub === 'env') return `Env: ${wc?.environment ?? '—'}`
    if (sub === 'obj') {
      const o = wc?.objects?.[subIdx]
      return o?.assetId
        ? `Object: ${o.assetId.slice(0, 22)}${o.assetId.length > 22 ? '…' : ''}`
        : `Object ${subIdx + 1}`
    }
    if (sub === 'panel') {
      const p = wc?.panels?.[subIdx]
      const preview = (p?.html ?? '').replace(/<[^>]+>/g, '').slice(0, 22)
      return preview ? `Panel: ${preview}${(p?.html ?? '').length > 22 ? '…' : ''}` : `Panel ${subIdx + 1}`
    }
    if (sub === 'avatar') {
      const a = wc?.avatars?.[subIdx]
      return a?.mood ? `Avatar: ${a.mood}` : `Avatar ${subIdx + 1}`
    }
    if (sub === 'camera') {
      const n = wc?.cameraPath?.length ?? 0
      return `Camera path (${n})`
    }
    if (sub === 'preset') return `Preset: ${scene.threeEnvironmentPresetId ?? '—'}`
  }
  return kind
}

function iconForSceneStackId(id: string) {
  switch (id) {
    case 'canvas2d':
      return Code2
    case 'motion':
      return Activity
    case 'd3':
      return BarChart3
    case 'three':
      return Box
    case 'lottie':
      return Clapperboard
    case 'zdog':
      return Sparkles
    case 'avatar_scene':
      return User
    case '3d_world':
      return Globe
    case 'canvas_bg':
      return LayoutTemplate
    default:
      return Layers
  }
}

function isAvatarLayer(l: AILayer | undefined): boolean {
  return l?.type === 'avatar'
}

/** Content to show under Video / first Avatar when scene has mixable audio tracks */
function sceneHasAudioStackDetails(scene: Scene): boolean {
  const a = scene.audioLayer
  if (!a) return false
  return !!(
    (a.tts?.text ?? '').trim() ||
    a.tts?.src ||
    a.tts?.status === 'ready' ||
    a.tts?.status === 'generating' ||
    a.tts?.status === 'pending' ||
    (a.src && String(a.src).length > 0) ||
    (a.music?.src && String(a.music.src).length > 0) ||
    (a.sfx?.length ?? 0) > 0
  )
}

function AudioStackSubRows({ scene, onOpenAudio }: { scene: Scene; onOpenAudio: () => void }) {
  const a = scene.audioLayer
  const rows: { id: string; Icon: typeof Volume2; label: string }[] = []
  if (
    (a.tts?.text ?? '').trim() ||
    a.tts?.src ||
    a.tts?.status === 'ready' ||
    a.tts?.status === 'generating' ||
    a.tts?.status === 'pending'
  ) {
    const t = (a.tts?.text ?? '').trim()
    const preview = t ? `${t.slice(0, 40)}${t.length > 40 ? '…' : ''}` : 'Voice / TTS'
    rows.push({ id: 'sub-tts', Icon: Volume2, label: `Narration · ${preview}` })
  }
  if (a.src && String(a.src).length > 0) {
    rows.push({ id: 'sub-src', Icon: Music, label: 'Audio file' })
  }
  if (a.music?.src && String(a.music.src).length > 0) {
    const name = (a.music.name ?? '').trim()
    rows.push({
      id: 'sub-music',
      Icon: Music,
      label: name ? `Music · ${name.slice(0, 32)}${name.length > 32 ? '…' : ''}` : 'Music',
    })
  }
  const nSfx = a.sfx?.length ?? 0
  if (nSfx > 0) {
    rows.push({ id: 'sub-sfx', Icon: Volume2, label: `Sound effects · ${nSfx}` })
  }
  if (rows.length === 0) return null
  return (
    <ul className="mt-0.5 space-y-0.5 border-l ml-2 pl-1" style={{ borderLeftColor: 'var(--color-hairline)' }}>
      {rows.map((r) => (
        <li key={r.id}>
          <div
            role="button"
            tabIndex={0}
            className="flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[11px] hover:bg-white/[0.04]"
            onClick={(e) => {
              e.stopPropagation()
              onOpenAudio()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpenAudio()
              }
            }}
            title="Open Audio in Layers"
          >
            <span className="inline-block h-6 w-6 shrink-0" aria-hidden />
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-text-muted)]"
              aria-hidden
            >
              <r.Icon size={11} strokeWidth={2.25} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{r.label}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function iconForKey(scene: Scene, key: StackKey) {
  const { kind, id } = parseKey(key)
  if (kind === 'bg' && id === 'stage') return Palette
  if (kind === 'ai' && id) {
    const l = (scene.aiLayers ?? []).find((x) => x.id === id)
    if (isAvatarLayer(l)) return User
    // Type-matched icons for media layers — an image layer is an image,
    // a video layer is a video; Sparkles stays for generative kinds.
    if (l?.type === 'image' || l?.type === 'sticker') return ImageIcon
    if (l?.type === 'veo3' || (l as { type?: string } | undefined)?.type === 'video') return Film
  }
  if (kind === 'scene' && id) return iconForSceneStackId(id)
  switch (kind) {
    case 'video':
      return Film
    case 'audio':
      return Music
    case 'ai':
      return Sparkles
    case 'svg':
      return Layers
    case 'text':
      return Type
    case 'chart':
      return BarChart3
    case 'interaction':
      return MousePointerClick
    case 'rx': {
      // Code-extracted: parse subkind from id "subkind:index"
      const sub = (id ?? '').split(':')[0]
      if (sub === 'three') return Box
      if (sub === 'canvas2d') return Code2
      if (sub === 'd3') return BarChart3
      if (sub === 'svg') return Layers
      if (sub === 'lottie') return Clapperboard
      if (sub === 'heading' || sub === 'paragraph' || sub === 'text') return Type
      if (sub === 'image') return ImageIcon
      return Sparkles
    }
    case 'camera':
      return Camera
    case 'transition':
      return SplitSquareHorizontal
    case 'style':
      return Palette
    case 'variables':
      return Hash
    case 'tts':
      return Volume2
    case 'music':
      return Music
    case 'sfx':
      return Volume2
    case '3d': {
      const sub = (id ?? '').split(':')[0]
      if (sub === 'env') return Globe
      if (sub === 'obj') return Box
      if (sub === 'panel') return LayoutTemplate
      if (sub === 'avatar') return User
      if (sub === 'camera') return Camera
      if (sub === 'preset') return Sparkles
      return Globe
    }
    default:
      return Layers
  }
}

interface Props {
  /** The current scene for scene-scoped affordances (e.g. the header "edit code"
   *  button). Optional: a scene-LESS project (only dropped media/audio clips) still
   *  renders the standalone-clip entries. */
  scene?: Scene
  /** When set, double-clicking a layer row calls this instead of opening the Properties tab */
  onLayerDoubleClick?: (key: LayerStackKey) => void
  /** When set, double-clicking a scene row in the scenes list calls this */
  onSceneDoubleClick?: (sceneId: string) => void
  /** When true, panel stretches to fill parent height (used when this is the primary view). */
  fillAvailableHeight?: boolean
  /** Optional controlled collapsed state. */
  collapsed?: boolean
  /** Fires whenever collapsed state changes. */
  onCollapsedChange?: (collapsed: boolean, meta?: { userAction?: boolean }) => void
}

type LayerStackRowsProps = {
  scene: Scene
  selectedKey: StackKey | null
  /** Toggle: same row again clears selection for this scene */
  onToggleRow: (key: StackKey) => void
  /** Double-click row → Layers → Properties tab */
  onOpenLayerProperties?: (key: StackKey) => void
}

function ChartTitleStackSubRow({
  rowId,
  chartLayer,
  hiddenSet,
  openTextTabForSlot,
  onToggleSlotHidden,
}: {
  rowId: string
  chartLayer: D3ChartLayer
  hiddenSet: Set<string>
  openTextTabForSlot: (slotKey: string) => void
  onToggleSlotHidden: (slotKey: string) => void
}) {
  const slotKey = `chart:${rowId}:title`
  const line = chartLayerTitleLine(chartLayer).slice(0, 48) || 'Title'
  const hid = layerHiddenIdForTextSlot(slotKey)
  const isTxHidden = hiddenSet.has(hid)
  return (
    <div
      role="button"
      tabIndex={0}
      className="flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[11px] hover:bg-white/[0.04]"
      onClick={() => {
        useVideoStore.getState().setTextEditorSlotKey(slotKey)
        useVideoStore.getState().openLayerStackProperties(slotKey)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          useVideoStore.getState().setTextEditorSlotKey(slotKey)
          useVideoStore.getState().openLayerStackProperties(slotKey)
        }
      }}
      title="Edit text"
    >
      <span className="inline-block h-6 w-6 shrink-0" aria-hidden />
      <button
        type="button"
        className="no-style flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        onClick={(e) => {
          e.stopPropagation()
          onToggleSlotHidden(slotKey)
        }}
        aria-label={isTxHidden ? 'Show layer' : 'Hide layer'}
      >
        {isTxHidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      <Type size={11} className="shrink-0 text-[var(--color-text-muted)]" strokeWidth={2.25} />
      <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">Title · {line}</span>
    </div>
  )
}

function LayerStackRows({ scene, selectedKey, onToggleRow, onOpenLayerProperties }: LayerStackRowsProps) {
  const { updateScene, openTextTabForSlot } = useVideoStore()
  const [expandedSvgText, setExpandedSvgText] = useState<Record<string, boolean>>({})
  const [expandedChartTitle, setExpandedChartTitle] = useState<Record<string, boolean>>({})
  const [expandedVideoAudio, setExpandedVideoAudio] = useState(false)
  const [expandedAvatarAudio, setExpandedAvatarAudio] = useState<Record<string, boolean>>({})
  const [expandedInteractionText, setExpandedInteractionText] = useState<Record<string, boolean>>({})

  const toggleSvgTextSlotHidden = useCallback(
    (slotKey: string) => {
      const k = layerHiddenIdForTextSlot(slotKey)
      const h = new Set(scene.layerHiddenIds ?? [])
      if (h.has(k)) h.delete(k)
      else h.add(k)
      updateScene(scene.id, { layerHiddenIds: Array.from(h) })
    },
    [scene.id, scene.layerHiddenIds, updateScene],
  )

  const toggleChartTitleSlotHidden = toggleSvgTextSlotHidden

  const fallbackOrder = useMemo(() => buildDefaultOrder(scene), [scene])
  const orderedKeys = useMemo(
    () => mergeOrder(scene.layerPanelOrder, fallbackOrder),
    [scene.layerPanelOrder, fallbackOrder],
  )

  const firstAvatarStackKey = useMemo(() => {
    for (const k of orderedKeys) {
      const { kind, id } = parseKey(k)
      if (kind !== 'ai' || !id) continue
      const l = (scene.aiLayers ?? []).find((x) => x.id === id)
      if (isAvatarLayer(l)) return k
    }
    return null
  }, [orderedKeys, scene.aiLayers])

  const hidden = useMemo(() => new Set(scene.layerHiddenIds ?? []), [scene.layerHiddenIds])

  const persistOrder = useCallback(
    (next: StackKey[]) => {
      updateScene(scene.id, { layerPanelOrder: [...next] })
    },
    [scene.id, updateScene],
  )

  const toggleHidden = useCallback(
    (key: StackKey) => {
      const h = new Set(scene.layerHiddenIds ?? [])
      if (h.has(key)) h.delete(key)
      else h.add(key)
      updateScene(scene.id, { layerHiddenIds: Array.from(h) })
    },
    [scene.id, scene.layerHiddenIds, updateScene],
  )

  const moveKey = useCallback(
    (index: number, dir: -1 | 1) => {
      const j = index + dir
      if (j < 0 || j >= orderedKeys.length) return
      if (orderedKeys[index] === 'audio' || orderedKeys[j] === 'audio') return
      if (orderedKeys[index] === BG_STAGE_STACK_KEY || orderedKeys[j] === BG_STAGE_STACK_KEY) return
      const next = [...orderedKeys]
      ;[next[index], next[j]] = [next[j], next[index]]
      persistOrder(pinLayerStackTail(next))
    },
    [orderedKeys, persistOrder],
  )

  return (
    <>
      {orderedKeys.length === 0 ? (
        <p className="px-2 py-3 text-center text-[11px] text-[var(--color-text-muted)]">No layers in this scene yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {orderedKeys.map((key, index) => {
            const Icon = iconForKey(scene, key)
            const label = labelForKey(scene, key)
            const isHidden = hidden.has(key)
            const isSel = selectedKey === key
            const { kind, id: rowId } = parseKey(key)
            const aiLayer = kind === 'ai' && rowId ? (scene.aiLayers ?? []).find((x) => x.id === rowId) : undefined
            const isAvatarAi = isAvatarLayer(aiLayer)
            const isVideo = kind === 'video'
            const isSceneRenderer = kind === 'scene' && !!rowId
            const prominentRow = isVideo || isAvatarAi || isSceneRenderer
            const showVideoAudioSubs =
              isVideo && !!scene.videoLayer?.enabled && !!scene.videoLayer.src && sceneHasAudioStackDetails(scene)
            const showAvatarAudioSubs =
              isAvatarAi && !!rowId && key === firstAvatarStackKey && sceneHasAudioStackDetails(scene)
            const videoAudioExpanded = expandedVideoAudio
            const avatarAudioExpanded = !!(rowId && expandedAvatarAudio[rowId])
            const isSvgStackRow = kind === 'svg' && rowId
            const svgTextChildren =
              isSvgStackRow && rowId
                ? rowId === MAIN_SCENE_SVG_LAYER_ID
                  ? listSvgTextElementsInMarkup(scene.svgContent ?? '')
                  : listSvgTextElementsInMarkup((scene.svgObjects ?? []).find((x) => x.id === rowId)?.svgContent ?? '')
                : []
            const svgTextExpanded = !!(rowId && expandedSvgText[rowId])

            const isChartStackRow = kind === 'chart' && rowId
            const chartLayerForStack =
              isChartStackRow && rowId ? deriveChartLayersFromScene(scene).find((c) => c.id === rowId) : undefined
            const chartTitleExpanded = !!(rowId && expandedChartTitle[rowId])
            const isBgStage = key === BG_STAGE_STACK_KEY
            const isInteraction = kind === 'interaction' && rowId
            const interactionEl =
              isInteraction && rowId ? (scene.interactions ?? []).find((x) => x.id === rowId) : undefined
            const interactionTextExpanded = !!(rowId && expandedInteractionText[rowId])

            return (
              <li key={key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    onToggleRow(key)
                    // Single-click on any layer row (avatars included) opens its
                    // property editor via the Layer-tab master-detail flow.
                    onOpenLayerProperties?.(key)
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    onOpenLayerProperties?.(key)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onToggleRow(key)
                      // Mirror the onClick flow: Enter/Space opens the property
                      // editor in master-detail (avatars included).
                      onOpenLayerProperties?.(key)
                    }
                  }}
                  title={
                    onOpenLayerProperties
                      ? 'Double-click for full properties (type, layout, style). Expand ▸ for text only. Avatar: single-click also opens Properties.'
                      : undefined
                  }
                  className={`flex cursor-pointer items-center gap-0.5 rounded px-1 text-[11px] ${
                    prominentRow ? 'py-1 min-h-[30px]' : 'py-0.5'
                  } ${isSel ? 'bg-[var(--color-accent)]/15 ring-1 ring-[var(--color-accent)]/40' : 'hover:bg-white/[0.04]'}`}
                >
                  <button
                    type="button"
                    className={`no-style flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] ${isBgStage ? 'cursor-default opacity-40 pointer-events-none' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!isBgStage) toggleHidden(key)
                    }}
                    aria-label={isHidden ? 'Show layer' : 'Hide layer'}
                    disabled={isBgStage}
                  >
                    {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  {isSvgStackRow && svgTextChildren.length > 0 ? (
                    <button
                      type="button"
                      className="no-style flex h-6 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedSvgText((p) => ({ ...p, [rowId!]: !p[rowId!] }))
                      }}
                      aria-expanded={svgTextExpanded}
                      aria-label={svgTextExpanded ? 'Collapse SVG text' : 'Expand SVG text'}
                    >
                      <ChevronRight
                        size={14}
                        className={`transition-transform duration-150 ${svgTextExpanded ? 'rotate-90' : ''}`}
                      />
                    </button>
                  ) : isChartStackRow && chartLayerForStack ? (
                    <button
                      type="button"
                      className="no-style flex h-6 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedChartTitle((p) => ({ ...p, [rowId!]: !p[rowId!] }))
                      }}
                      aria-expanded={chartTitleExpanded}
                      aria-label={chartTitleExpanded ? 'Collapse chart title' : 'Expand chart title'}
                    >
                      <ChevronRight
                        size={14}
                        className={`transition-transform duration-150 ${chartTitleExpanded ? 'rotate-90' : ''}`}
                      />
                    </button>
                  ) : showVideoAudioSubs ? (
                    <button
                      type="button"
                      className="no-style flex h-6 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedVideoAudio((v) => !v)
                      }}
                      aria-expanded={videoAudioExpanded}
                      aria-label={videoAudioExpanded ? 'Collapse video audio' : 'Expand video audio'}
                    >
                      <ChevronRight
                        size={14}
                        className={`transition-transform duration-150 ${videoAudioExpanded ? 'rotate-90' : ''}`}
                      />
                    </button>
                  ) : showAvatarAudioSubs && rowId ? (
                    <button
                      type="button"
                      className="no-style flex h-6 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedAvatarAudio((p) => ({ ...p, [rowId]: !p[rowId] }))
                      }}
                      aria-expanded={avatarAudioExpanded}
                      aria-label={avatarAudioExpanded ? 'Collapse avatar audio' : 'Expand avatar audio'}
                    >
                      <ChevronRight
                        size={14}
                        className={`transition-transform duration-150 ${avatarAudioExpanded ? 'rotate-90' : ''}`}
                      />
                    </button>
                  ) : isInteraction && interactionEl ? (
                    <button
                      type="button"
                      className="no-style flex h-6 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedInteractionText((p) => ({ ...p, [rowId!]: !p[rowId!] }))
                      }}
                      aria-expanded={interactionTextExpanded}
                      aria-label={interactionTextExpanded ? 'Collapse text' : 'Expand text'}
                    >
                      <ChevronRight
                        size={14}
                        className={`transition-transform duration-150 ${interactionTextExpanded ? 'rotate-90' : ''}`}
                      />
                    </button>
                  ) : null}
                  <Icon
                    size={prominentRow ? 14 : 12}
                    className="shrink-0 text-[var(--color-text-muted)]"
                    strokeWidth={2.25}
                  />
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{label}</span>
                  <div className="flex shrink-0 items-center gap-0">
                    {isSceneRenderer && (
                      // "Edit code" opens the rich code editor focused on this
                      // scene's renderer code (scene code is scene-level).
                      <button
                        type="button"
                        className="no-style flex h-6 w-5 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                        onClick={(e) => {
                          e.stopPropagation()
                          useVideoStore.getState().openCodeEditor(`scene:${scene.id}`)
                        }}
                        aria-label="Edit code"
                        title="Edit code"
                      >
                        <Code2 size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="no-style flex h-6 w-5 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-25"
                      disabled={key === 'audio' || key === BG_STAGE_STACK_KEY || index === 0}
                      onClick={(e) => {
                        e.stopPropagation()
                        moveKey(index, -1)
                      }}
                      aria-label="Move up"
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="no-style flex h-6 w-5 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-25"
                      disabled={key === 'audio' || key === BG_STAGE_STACK_KEY || index === orderedKeys.length - 1}
                      onClick={(e) => {
                        e.stopPropagation()
                        moveKey(index, 1)
                      }}
                      aria-label="Move down"
                    >
                      <ChevronDown size={14} />
                    </button>
                  </div>
                </div>

                {isSvgStackRow && rowId && svgTextExpanded && svgTextChildren.length > 0 && (
                  <ul
                    className="mt-0.5 space-y-0.5 border-l ml-2 pl-1"
                    style={{ borderLeftColor: 'var(--color-hairline)' }}
                  >
                    {svgTextChildren.map((tx) => {
                      const slotKey =
                        rowId === MAIN_SCENE_SVG_LAYER_ID ? `svg:main:${tx.ref}` : `svg:obj:${rowId}:${tx.ref}`
                      const line = (tx.preview || '').trim() || '(empty)'
                      const hid = layerHiddenIdForTextSlot(slotKey)
                      const isTxHidden = hidden.has(hid)
                      return (
                        <li key={`${rowId}-${tx.ref}`}>
                          <div
                            role="button"
                            tabIndex={0}
                            className="flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[11px] hover:bg-white/[0.04]"
                            onClick={() => {
                              // Route SVG text-slot clicks to the Layer-tab
                              // master-detail editor (Typography). Setting the
                              // textEditorSlotKey alongside the stack key lets
                              // the property panel know which slot to edit.
                              useVideoStore.getState().setTextEditorSlotKey(slotKey)
                              useVideoStore.getState().openLayerStackProperties(slotKey)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                useVideoStore.getState().setTextEditorSlotKey(slotKey)
                                useVideoStore.getState().openLayerStackProperties(slotKey)
                              }
                            }}
                            title="Edit text"
                          >
                            <span className="inline-block h-6 w-6 shrink-0" aria-hidden />
                            <button
                              type="button"
                              className="no-style flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleSvgTextSlotHidden(slotKey)
                              }}
                              aria-label={isTxHidden ? 'Show layer' : 'Hide layer'}
                            >
                              {isTxHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                            </button>
                            <Type size={11} className="shrink-0 text-[var(--color-text-muted)]" strokeWidth={2.25} />
                            <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{line}</span>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}

                {isChartStackRow && rowId && chartTitleExpanded && chartLayerForStack && (
                  <ul
                    className="mt-0.5 space-y-0.5 border-l ml-2 pl-1"
                    style={{ borderLeftColor: 'var(--color-hairline)' }}
                  >
                    <li key={`${rowId}-chart-title`}>
                      <ChartTitleStackSubRow
                        rowId={rowId}
                        chartLayer={chartLayerForStack}
                        hiddenSet={hidden}
                        openTextTabForSlot={openTextTabForSlot}
                        onToggleSlotHidden={toggleChartTitleSlotHidden}
                      />
                    </li>
                  </ul>
                )}

                {isVideo && videoAudioExpanded && showVideoAudioSubs && (
                  <AudioStackSubRows
                    scene={scene}
                    onOpenAudio={() => {
                      if (selectedKey !== 'audio') onToggleRow('audio')
                    }}
                  />
                )}

                {isAvatarAi && rowId && avatarAudioExpanded && showAvatarAudioSubs && (
                  <AudioStackSubRows
                    scene={scene}
                    onOpenAudio={() => {
                      if (selectedKey !== 'audio') onToggleRow('audio')
                    }}
                  />
                )}

                {isInteraction && rowId && interactionEl && interactionTextExpanded && (
                  <ul
                    className="mt-0.5 space-y-0.5 border-l ml-2 pl-1"
                    style={{ borderLeftColor: 'var(--color-hairline)' }}
                  >
                    <li>
                      <div className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px]">
                        <span className="inline-block h-6 w-6 shrink-0" aria-hidden />
                        <Type size={11} className="shrink-0 text-[var(--color-text-muted)]" strokeWidth={2.25} />
                        <span className="min-w-0 flex-1 font-semibold text-[var(--color-text-primary)]">
                          Text & labels
                        </span>
                      </div>
                      <div className="border-t border-[var(--color-hairline)]/60 pt-2 pb-1 pl-1 pr-0.5">
                        <InteractionTextBulkForm scene={scene} el={interactionEl} />
                      </div>
                    </li>
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

export default function SceneLayersStackPanel({
  scene,
  onLayerDoubleClick,
  onSceneDoubleClick,
  fillAvailableHeight = false,
  collapsed,
  onCollapsedChange,
}: Props) {
  const scenes = useVideoStore((s) => s.scenes)
  const selectedSceneId = useVideoStore((s) => s.selectedSceneId)
  const selectScene = useVideoStore((s) => s.selectScene)
  const timeline = useVideoStore((s) => s.project.timeline)
  const selectedClipIds = useVideoStore((s) => s.selectedClipIds)
  const setSelectedClipIds = useVideoStore((s) => s.setSelectedClipIds)
  const openLayerStackProperties = useVideoStore((s) => s.openLayerStackProperties)
  const handleOpenLayerProperties = useCallback(
    (key: StackKey) => {
      if (onLayerDoubleClick) {
        onLayerDoubleClick(key)
      } else {
        openLayerStackProperties(String(key))
      }
    },
    [openLayerStackProperties, onLayerDoubleClick],
  )

  const [selection, setSelection] = useState<{ sceneId: string; key: StackKey } | null>(null)
  const expandedScenes = useVideoStore((s) => s.layerTreeExpanded)
  const toggleLayerTreeExpanded = useVideoStore((s) => s.toggleLayerTreeExpanded)
  const [stackBodyHeight, setStackBodyHeight] = useState(LAYER_STACK_H_DEFAULT)
  const [stackResizeDrag, setStackResizeDrag] = useState(false)
  const [stackCollapsed, setStackCollapsed] = useState(false)
  const layerStackDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const allowHeightPersist = useRef(false)

  useEffect(() => {
    setStackBodyHeight(readStackBodyHeight())
    allowHeightPersist.current = true
  }, [])

  useEffect(() => {
    if (!allowHeightPersist.current) return
    try {
      localStorage.setItem(LAYER_STACK_BODY_H_KEY, String(stackBodyHeight))
    } catch {
      /* ignore */
    }
  }, [stackBodyHeight])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = layerStackDragRef.current
      if (!d) return
      e.preventDefault()
      setStackBodyHeight(clampStackBodyHeight(d.startH + (d.startY - e.clientY)))
    }
    const onUp = () => {
      if (!layerStackDragRef.current) return
      layerStackDragRef.current = null
      setStackResizeDrag(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const isCollapsed = collapsed ?? stackCollapsed
  const setCollapsedState = useCallback(
    (next: boolean, meta?: { userAction?: boolean }) => {
      if (collapsed === undefined) setStackCollapsed(next)
      onCollapsedChange?.(next, meta)
    },
    [collapsed, onCollapsedChange],
  )

  const onToggleRow = (sceneId: string) => (key: StackKey) => {
    setSelection((prev) => (prev?.sceneId === sceneId && prev.key === key ? null : { sceneId, key }))
  }

  // STANDALONE audio clips (dropped audio files) are peer entries in the
  // stack alongside scenes, ordered by timeline position. Audio has no scene to
  // appear under. Scene-mirrored audio (aud-/tts-/mus-) lives inside its scene's rows.
  const audioClipEntries = (timeline?.tracks ?? [])
    .flatMap((t) => t.clips)
    .filter((c) => c.sourceType === 'audio' && !/^(aud-|tts-|mus-)/.test(c.sourceId))
    .sort((a, b) => a.startTime - b.startTime)

  // STANDALONE video/image clips (a media file dropped on the timeline = a bare
  // clip, NOT a scene) are also peer entries — otherwise dropped footage is
  // invisible here. Selecting one opens the clip inspector (opacity + color grade).
  const mediaClipEntries = (timeline?.tracks ?? [])
    .flatMap((t) => t.clips)
    .filter((c) => c.sourceType === 'video' || c.sourceType === 'image')
    .sort((a, b) => a.startTime - b.startTime)

  return (
    <div
      className={`${fillAvailableHeight ? 'flex min-h-0 flex-1' : 'flex shrink-0 border-t'} flex-col bg-[var(--bg)]`}
      style={{ borderTopColor: 'var(--color-hairline)' }}
      data-scene-layers-stack
    >
      {stackResizeDrag && <div className="fixed inset-0 z-[9998]" style={{ cursor: 'row-resize' }} aria-hidden />}

      {/* Layer-tab header: a "Code" entry that opens the rich code editor for
          this scene (works for every scene type, including React where there's
          no single renderer row). Per-row "Edit code" buttons cover the rest. */}
      {fillAvailableHeight && (
        <div className="flex flex-shrink-0 items-center justify-between px-3 py-2">
          <span className="select-none text-[12px] font-medium text-[var(--color-text-muted)]">Layers</span>
          {scene && (
            <button
              type="button"
              onClick={() => useVideoStore.getState().openCodeEditor(`scene:${scene.id}`)}
              className="no-style flex items-center justify-center rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
              title="Edit scene code"
              aria-label="Edit scene code"
            >
              <Code2 size={14} />
            </button>
          )}
        </div>
      )}

      {/* The "Layers" title/chevron + resize bar is redundant when the stack fills
          the sidebar (it's already the "Scenes & layers" panel); show it only when
          the stack is a resizable docked section. */}
      {!fillAvailableHeight && (
        <div
          className="flex flex-shrink-0 items-center bg-[var(--bg)] px-2 py-1 cursor-row-resize"
          onMouseDown={(e) => {
            // Only start drag from the bar background, not from interactive children
            if ((e.target as HTMLElement).closest('[role="tab"], [role="button"], button')) return
            e.preventDefault()
            layerStackDragRef.current = { startY: e.clientY, startH: stackBodyHeight }
            setStackResizeDrag(true)
            if (isCollapsed) setCollapsedState(false, { userAction: false })
            document.body.style.cursor = 'row-resize'
            document.body.style.userSelect = 'none'
          }}
        >
          <span
            role="button"
            tabIndex={0}
            onClick={() => setCollapsedState(!isCollapsed, { userAction: true })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setCollapsedState(!isCollapsed, { userAction: true })
              }
            }}
            className="mr-1 flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--kbd-text)] transition-colors"
            aria-label={isCollapsed ? 'Expand layers' : 'Collapse layers'}
          >
            <ChevronDown size={12} className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
          </span>
          <span className="flex-1 select-none text-[12px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
            Layers
          </span>
        </div>
      )}

      <div
        className={`min-h-0 ${fillAvailableHeight ? 'flex-1' : 'flex-shrink-0'} overflow-y-auto overscroll-contain px-1 py-1`}
        style={{
          height: isCollapsed ? 0 : fillAvailableHeight ? undefined : stackBodyHeight,
          overflow: isCollapsed ? 'hidden' : undefined,
        }}
      >
        <div className="space-y-0.5">
          {scenes.map((s) => {
            // Collapsed unless the user opened it. Nothing auto-expands
            // — not selection, not playback, not returning from Properties.
            const open = expandedScenes[s.id] ?? false
            const isCurrent = s.id === selectedSceneId
            // Media-asset scenes get a type-matched icon (image/video);
            // authored scenes keep the film slate.
            const SceneIcon = mediaSceneKind(s) === 'image' ? ImageIcon : Film
            return (
              <div key={s.id} className="rounded bg-[var(--color-bg)]/30">
                <div className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] hover:bg-white/[0.04]">
                  <button
                    type="button"
                    className="no-style flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                    aria-expanded={open}
                    aria-label={open ? 'Collapse scene layers' : 'Expand scene layers'}
                    onClick={() => toggleLayerTreeExpanded(s.id)}
                  >
                    <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                  </button>
                  <button
                    type="button"
                    className="no-style flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded py-1 pl-0.5 pr-2 text-left"
                    onClick={() => {
                      selectScene(s.id)
                      // Single-click on a scene row drills into the scene's
                      // property editor (master-detail flow in the Layer tab).
                      openLayerStackProperties(`scene:${s.id}`)
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault()
                      selectScene(s.id)
                      onSceneDoubleClick?.(s.id)
                    }}
                  >
                    <SceneIcon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]">
                      {s.name?.trim() || 'Untitled scene'}
                    </span>
                    {isCurrent && <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-red-500/50" />}
                  </button>
                </div>
                {open && (
                  <div className="px-1 pb-1 pt-0.5">
                    <LayerStackRows
                      scene={s}
                      selectedKey={selection?.sceneId === s.id ? selection.key : null}
                      onToggleRow={onToggleRow(s.id)}
                      onOpenLayerProperties={handleOpenLayerProperties}
                    />
                  </div>
                )}
              </div>
            )
          })}
          {mediaClipEntries.map((c) => {
            const selected = selectedClipIds.includes(c.id)
            const Icon = c.sourceType === 'image' ? ImageIcon : Film
            return (
              <div key={`media-${c.id}`} className="rounded bg-[var(--color-bg)]/30">
                <div className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] hover:bg-white/[0.04]">
                  <span className="flex h-7 w-7 shrink-0" aria-hidden />
                  <button
                    type="button"
                    data-testid={`stack-media-clip-${c.id}`}
                    className="no-style flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded py-1 pl-0.5 pr-2 text-left"
                    onClick={() => {
                      setSelectedClipIds([c.id])
                      useVideoStore.getState().openLayerStackProperties(`clip:${c.id}`)
                    }}
                  >
                    <Icon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]">
                      {c.label?.trim() || (c.sourceType === 'image' ? 'Image' : 'Video')}
                    </span>
                    {selected && <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-[var(--accent)]/60" />}
                  </button>
                </div>
              </div>
            )
          })}
          {audioClipEntries.map((c) => {
            const selected = selectedClipIds.includes(c.id)
            return (
              <div key={`audio-${c.id}`} className="rounded bg-[var(--color-bg)]/30">
                <div className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] hover:bg-white/[0.04]">
                  {/* spacer aligns with the scene rows' expand chevron */}
                  <span className="flex h-7 w-7 shrink-0" aria-hidden />
                  <button
                    type="button"
                    data-testid={`stack-audio-clip-${c.id}`}
                    className="no-style flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded py-1 pl-0.5 pr-2 text-left"
                    onClick={() => {
                      setSelectedClipIds([c.id])
                      useVideoStore.getState().openLayerStackProperties(`clip:${c.id}`)
                    }}
                  >
                    <Music size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]">
                      {c.label?.trim() || 'Audio'}
                    </span>
                    {selected && <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-red-500/50" />}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
