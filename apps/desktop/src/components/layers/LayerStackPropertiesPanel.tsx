'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { ChevronLeft, Droplet, Grid3x3, RotateCw } from 'lucide-react'
import {
  Section,
  FieldLabel,
  HRow,
  NumberCell,
  TextCell,
  ColorCell,
  SelectCell,
  SliderCell,
  LinkedPair,
} from '@/components/layers/property-panel-primitives'
import { useLayerCommit } from '@/lib/hooks/use-layer-commit'
import { LayerGradeControl } from './LayerGradeControl'
import { ColorGradePanel } from '@/components/inspector/ColorGradePanel'
import { mediaSceneKind } from '@/components/layers/SceneLayersStackPanel'
import { useVideoStore } from '@/lib/store'
import type { Scene, TextOverlay, Clip, CameraMove } from '@/lib/types'
import { parseLayerStackKey } from '@/lib/layer-stack-keys'
import { deriveChartLayersFromScene } from '@/lib/charts/extract'
import { MAIN_SCENE_SVG_LAYER_ID } from '@/lib/text-slots'
import ChartLayerPropertiesForm from '@/components/layers/ChartLayerPropertiesForm'
import AvatarLayerPropertiesForm from '@/components/layers/AvatarLayerPropertiesForm'
import { InteractionFormBody } from '@/components/tabs/InteractTab'
import { normalizeAudioLayer } from '@/lib/audio/normalize'
import { TRANSITION_CATALOG } from '@/lib/transitions'
import { CAMERA_EFFECT_CATALOG, cameraEffectIdFromScene, defaultCameraMoveParams } from '@/lib/camera-effects'
import { getTextSlotValue, applyTextSlotValue, getSvgSlotAttr, setSvgSlotAttr } from '@/lib/text-slots'
import { extractElementsFromReactCode } from '@/lib/react-extract'
import {
  extractCodeTextSlots,
  pickSceneCodeField,
  updateSlotText as updateCodeSlotText,
  updateSlotStyleProp as updateCodeSlotStyle,
  TYPOGRAPHY_PROPS,
  type CodeTextSlot,
  type CodeTextSlotKind,
  type TextSlotStyle,
} from '@/lib/code-text-slots'
import {
  postLiveApply,
  isLivePreviewable,
  postEnableSelectMode,
  postDisableSelectMode,
  postSelectSlot,
  subscribeSlotClicked,
  subscribeSlotTextInput,
  subscribeSlotTextCommitted,
} from '@/lib/preview-bridge'
import { useSceneTextSlots, findRemoteSlotForCode } from '@/lib/hooks/use-scene-text-slots'

interface Props {
  /** Optional: a scene-LESS project (only dropped media/audio clips) still opens the
   *  clip inspector (clip:<id> → ClipMediaBody / ClipAudioBody), which needs no scene. */
  scene?: Scene
}

// Inspired by OpenCut (apps/web/src/components/editor/panels/properties) — same
// section split (Transform / Blending / Time / etc) and keyframe-toggle diamond
// in front of each label. Adapted to Dreambyte: collapsible sections in one panel
// rather than OpenCut's per-element tab strip.

// compact primitives (Section, NumberCell, TextCell, etc) live in
// src/components/layers/property-panel-primitives.tsx so individual layer
// forms (avatar, chart, …) share the same look-and-feel as this panel.

function PanelHeader({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-3">
      <button
        type="button"
        onClick={onBack}
        className="no-style electron-titlebar-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
        data-tooltip="Back to layers"
      >
        <ChevronLeft size={13} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">{title}</p>
        {subtitle && <p className="truncate font-mono text-[10px] text-[var(--color-text-muted)]">{subtitle}</p>}
      </div>
    </div>
  )
}

// ── Helper: find the timeline clip representing a scene ─────────────────────

function useSceneClip(sceneId: string): Clip | null {
  return useVideoStore((s) => {
    const tl = s.project.timeline
    if (!tl) return null
    for (const t of tl.tracks) {
      for (const c of t.clips) {
        if (c.sourceType === 'scene' && c.sourceId === sceneId) return c
      }
    }
    return null
  })
}

// ── Property bodies ──────────────────────────────────────────────────────────

const BLEND_MODES = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
] as const

function SceneBody({
  scene,
  commit,
  commitDebounced,
}: {
  scene: Scene
  commit: () => void
  commitDebounced: () => void
}) {
  const updateScene = useVideoStore((s) => s.updateScene)
  const updateClip = useVideoStore((s) => s.updateClip)
  const clip = useSceneClip(scene.id)
  const [linkScale, setLinkScale] = useState(true)

  const patchClip = useCallback(
    (p: Partial<Clip>) => {
      if (!clip) return
      updateClip(clip.id, p)
    },
    [clip, updateClip],
  )

  return (
    <>
      <Section title="Scene">
        <div>
          <FieldLabel keyframable={false}>Name</FieldLabel>
          <TextCell
            value={scene.name ?? ''}
            onChange={(v) => {
              updateScene(scene.id, { name: v })
              commitDebounced()
            }}
            onCommit={commit}
            placeholder="Untitled"
          />
        </div>
        <div>
          <FieldLabel keyframable={false}>Background</FieldLabel>
          <ColorCell
            value={scene.bgColor}
            onChange={(v) => {
              updateScene(scene.id, { bgColor: v })
              commitDebounced()
            }}
            onCommit={commit}
          />
        </div>
      </Section>

      <Section title="Time">
        <div>
          <FieldLabel keyframable={false}>Duration</FieldLabel>
          <NumberCell
            value={scene.duration}
            onChange={(v) => {
              updateScene(scene.id, { duration: Math.max(0.5, v) })
              commitDebounced()
            }}
            onCommit={commit}
            step={0.5}
            min={0.5}
            suffix="s"
          />
        </div>
        {clip && (
          <div>
            <FieldLabel>Speed</FieldLabel>
            <NumberCell
              value={clip.speed * 100}
              onChange={(v) => patchClip({ speed: Math.max(0.01, v / 100) })}
              step={5}
              min={1}
              suffix="%"
            />
          </div>
        )}
      </Section>

      {clip && (
        <Section title="Transform">
          <div>
            <FieldLabel>Position</FieldLabel>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberCell
                prefix="X"
                value={clip.position.x}
                onChange={(v) => patchClip({ position: { ...clip.position, x: v } })}
              />
              <NumberCell
                prefix="Y"
                value={clip.position.y}
                onChange={(v) => patchClip({ position: { ...clip.position, y: v } })}
              />
            </div>
          </div>
          <div>
            <FieldLabel>Scale</FieldLabel>
            <LinkedPair
              linked={linkScale}
              onToggleLink={() => setLinkScale((l) => !l)}
              left={
                <NumberCell
                  prefix="W"
                  value={Math.round(clip.scale.x * 100)}
                  onChange={(v) => {
                    const nx = Math.max(0, v / 100)
                    patchClip(linkScale ? { scale: { x: nx, y: nx } } : { scale: { ...clip.scale, x: nx } })
                  }}
                  suffix="%"
                  step={5}
                />
              }
              right={
                <NumberCell
                  prefix="H"
                  value={Math.round(clip.scale.y * 100)}
                  onChange={(v) => {
                    const ny = Math.max(0, v / 100)
                    patchClip(linkScale ? { scale: { x: ny, y: ny } } : { scale: { ...clip.scale, y: ny } })
                  }}
                  suffix="%"
                  step={5}
                />
              }
            />
          </div>
          <div>
            <FieldLabel>Rotation</FieldLabel>
            <NumberCell
              prefixIcon={<RotateCw size={12} />}
              value={clip.rotation}
              onChange={(v) => patchClip({ rotation: v })}
              suffix="°"
            />
          </div>
        </Section>
      )}

      {clip && (
        <Section title="Blending">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>Opacity</FieldLabel>
              <NumberCell
                prefixIcon={<Grid3x3 size={11} />}
                value={Math.round(clip.opacity * 100)}
                onChange={(v) => patchClip({ opacity: Math.max(0, Math.min(1, v / 100)) })}
                step={5}
                min={0}
                max={100}
              />
            </div>
            <div>
              <FieldLabel keyframable={false}>Blend mode</FieldLabel>
              <SelectCell
                value={(clip.blendMode ?? 'normal') as string}
                options={BLEND_MODES.map((b) => ({ value: b.value, label: b.label }))}
                onChange={(v) => patchClip({ blendMode: v })}
                prefixIcon={<Droplet size={11} />}
              />
            </div>
          </div>
        </Section>
      )}

      <Section title="Transitions" defaultOpen={false}>
        <div>
          <FieldLabel keyframable={false}>Out transition</FieldLabel>
          <SelectCell
            value={(scene.transition ?? 'cut') as string}
            options={TRANSITION_CATALOG.map((t) => ({ value: t.id, label: t.label }))}
            onChange={(v) => {
              updateScene(scene.id, { transition: v as Parameters<typeof updateScene>[1]['transition'] })
              commit()
            }}
          />
        </div>
      </Section>

      <Section title="Effects" defaultOpen={false}>
        <div>
          <FieldLabel keyframable={false}>Camera effect</FieldLabel>
          <SelectCell
            value={cameraEffectIdFromScene(scene.cameraMotion)}
            options={CAMERA_EFFECT_CATALOG.map((e) => ({ value: e.id, label: e.label }))}
            onChange={(v) => {
              if (v === 'none') {
                updateScene(scene.id, { cameraMotion: null })
              } else {
                updateScene(scene.id, {
                  cameraMotion: [
                    {
                      type: v as CameraMove['type'],
                      params: defaultCameraMoveParams(scene.duration, scene.cameraMotion?.[0]),
                    },
                  ],
                })
              }
              commit()
            }}
          />
        </div>
      </Section>

      {clip && (
        <Section title="Fades" defaultOpen={false}>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>Fade in</FieldLabel>
              <NumberCell
                value={clip.fadeIn ?? 0}
                onChange={(v) => patchClip({ fadeIn: Math.max(0, v) })}
                step={0.1}
                min={0}
                suffix="s"
              />
            </div>
            <div>
              <FieldLabel>Fade out</FieldLabel>
              <NumberCell
                value={clip.fadeOut ?? 0}
                onChange={(v) => patchClip({ fadeOut: Math.max(0, v) })}
                step={0.1}
                min={0}
                suffix="s"
              />
            </div>
          </div>
        </Section>
      )}

      {/* Clip color grade — a media-asset scene (a video/image dropped on
          the timeline) is graded via the CSS+SVG tier on its iframe (preview ==
          export). LUT/hue curves are media-only, so the panel flags that. */}
      {clip && mediaSceneKind(scene) !== null && (
        <ColorGradePanel
          grade={clip.grade}
          lutTierAvailable={false}
          onChange={(next) => patchClip({ grade: next })}
          onCommit={commit}
        />
      )}
    </>
  )
}

function BgStageBody({ scene, commit }: { scene: Scene; commit: () => void }) {
  const updateScene = useVideoStore((s) => s.updateScene)
  return (
    <Section title="Background">
      <div>
        <FieldLabel keyframable={false}>Color</FieldLabel>
        <ColorCell value={scene.bgColor} onChange={(v) => updateScene(scene.id, { bgColor: v })} onCommit={commit} />
      </div>
    </Section>
  )
}

function AILayerBody({ scene, layerId, commit }: { scene: Scene; layerId: string; commit: () => void }) {
  const updateAILayer = useVideoStore((s) => s.updateAILayer)
  const layer = (scene.aiLayers ?? []).find((l) => l.id === layerId)
  const [linkSize, setLinkSize] = useState(true)
  // Compute aspect ratio for linked W/H. Must run before any early return so
  // the hook order stays stable when the layer briefly disappears mid-edit.
  const aspect = useMemo(() => {
    if (!layer || !('width' in layer) || !('height' in layer)) return 1
    const w = (layer as { width: number }).width
    const h = (layer as { height: number }).height
    return w > 0 && h > 0 ? w / h : 1
  }, [layer])
  if (!layer) return null

  return (
    <>
      <Section title="Transform">
        <div>
          <FieldLabel>Position</FieldLabel>
          <div className="grid grid-cols-2 gap-1.5">
            <NumberCell
              prefix="X"
              value={layer.x}
              onChange={(v) => updateAILayer(scene.id, layerId, { x: v })}
              onCommit={commit}
            />
            <NumberCell
              prefix="Y"
              value={layer.y}
              onChange={(v) => updateAILayer(scene.id, layerId, { y: v })}
              onCommit={commit}
            />
          </div>
        </div>
        <div>
          <FieldLabel>Size</FieldLabel>
          <LinkedPair
            linked={linkSize}
            onToggleLink={() => setLinkSize((l) => !l)}
            left={
              <NumberCell
                prefix="W"
                value={layer.width}
                onChange={(v) => {
                  const nw = Math.max(1, v)
                  updateAILayer(
                    scene.id,
                    layerId,
                    linkSize ? { width: nw, height: Math.max(1, Math.round(nw / aspect)) } : { width: nw },
                  )
                }}
                onCommit={commit}
                min={1}
              />
            }
            right={
              <NumberCell
                prefix="H"
                value={layer.height}
                onChange={(v) => {
                  const nh = Math.max(1, v)
                  updateAILayer(
                    scene.id,
                    layerId,
                    linkSize ? { width: Math.max(1, Math.round(nh * aspect)), height: nh } : { height: nh },
                  )
                }}
                onCommit={commit}
                min={1}
              />
            }
          />
        </div>
        {'rotation' in layer && (
          <div>
            <FieldLabel>Rotation</FieldLabel>
            <NumberCell
              prefixIcon={<RotateCw size={12} />}
              value={(layer as { rotation: number }).rotation}
              onChange={(v) => updateAILayer(scene.id, layerId, { rotation: v } as Parameters<typeof updateAILayer>[2])}
              onCommit={commit}
              suffix="°"
            />
          </div>
        )}
      </Section>
      <Section title="Blending">
        <div>
          <FieldLabel>Opacity</FieldLabel>
          <NumberCell
            prefixIcon={<Grid3x3 size={11} />}
            value={Math.round(layer.opacity * 100)}
            onChange={(v) => updateAILayer(scene.id, layerId, { opacity: Math.max(0, Math.min(1, v / 100)) })}
            onCommit={commit}
            step={5}
            min={0}
            max={100}
          />
        </div>
        <div>
          <FieldLabel keyframable={false}>Z-index</FieldLabel>
          <NumberCell
            value={layer.zIndex}
            onChange={(v) => updateAILayer(scene.id, layerId, { zIndex: Math.round(v) })}
            onCommit={commit}
          />
        </div>
      </Section>
      {layer.type === 'image' && (
        <LayerGradeControl
          sceneId={scene.id}
          value={{
            lookCss: (layer as { filter?: string }).filter,
            grade: (layer as { colorGrade?: import('@/lib/edit-engines/layer-grade').LayerColorGrade }).colorGrade,
          }}
          onApply={(next) => {
            updateAILayer(scene.id, layerId, { filter: next.lookCss, colorGrade: next.grade } as Parameters<
              typeof updateAILayer
            >[2])
            commit()
          }}
        />
      )}
      {'startAt' in layer && (
        <Section title="Time" defaultOpen={false}>
          <div>
            <FieldLabel>Start</FieldLabel>
            <NumberCell
              value={(layer as { startAt?: number }).startAt ?? 0}
              onChange={(v) =>
                updateAILayer(scene.id, layerId, { startAt: Math.max(0, v) } as Parameters<typeof updateAILayer>[2])
              }
              onCommit={commit}
              step={0.1}
              min={0}
              suffix="s"
            />
          </div>
        </Section>
      )}
    </>
  )
}

const FONT_OPTIONS = [
  { value: 'Inter, sans-serif', label: 'Inter' },
  { value: 'system-ui, sans-serif', label: 'System' },
  { value: 'Helvetica, Arial, sans-serif', label: 'Helvetica' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Times New Roman, serif', label: 'Times' },
  { value: 'Courier New, monospace', label: 'Courier' },
  { value: 'Geist, Inter, sans-serif', label: 'Geist' },
]

const TEXT_ANIMATIONS = [
  { value: 'fade-in', label: 'Fade in' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'typewriter', label: 'Typewriter' },
] as const

const TEXT_WEIGHTS = [
  { value: '100', label: 'Thin' },
  { value: '300', label: 'Light' },
  { value: '400', label: 'Normal' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Extra bold' },
  { value: '900', label: 'Black' },
] as const

function TextOverlayBody({
  scene,
  overlayId,
  commit,
  commitDebounced,
}: {
  scene: Scene
  overlayId: string
  commit: () => void
  commitDebounced: () => void
}) {
  const updateTextOverlay = useVideoStore((s) => s.updateTextOverlay)
  const overlay = (scene.textOverlays ?? []).find((t) => t.id === overlayId)
  if (!overlay) return null
  const patch = (p: Partial<TextOverlay>) => {
    updateTextOverlay(scene.id, overlayId, p)
    commitDebounced()
  }

  // Pick the closest matching preset for the dropdown display, otherwise
  // surface the user's actual stored font as a synthetic option so it stays
  // selected (rather than showing a misleading "Inter").
  const matchedPreset = FONT_OPTIONS.find((f) => overlay.font.toLowerCase().includes(f.label.toLowerCase()))
  const fontOptions = matchedPreset
    ? FONT_OPTIONS
    : [{ value: overlay.font, label: overlay.font || '(default)' }, ...FONT_OPTIONS]
  const selectedFontValue = matchedPreset?.value ?? overlay.font

  return (
    <>
      <Section title="Typography">
        <HRow label="Content">
          <TextCell value={overlay.content} onChange={(v) => patch({ content: v })} onCommit={commit} />
        </HRow>
        <HRow label="Font">
          <SelectCell
            value={selectedFontValue}
            options={fontOptions}
            onChange={(v) => {
              patch({ font: v })
              commit()
            }}
          />
        </HRow>
        <HRow label="Sizing">
          <div className="grid grid-cols-2 gap-2">
            <SelectCell
              value={String(overlay.weight ?? 400)}
              options={TEXT_WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
              onChange={(v) => {
                patch({ weight: parseInt(v, 10) })
                commit()
              }}
            />
            <NumberCell
              value={overlay.size}
              onChange={(v) => patch({ size: Math.max(1, v) })}
              onCommit={commit}
              min={1}
              suffix="px"
            />
          </div>
        </HRow>
        <HRow label="">
          <div className="grid grid-cols-2 gap-2">
            <NumberCell
              prefix="LH"
              value={Math.round((overlay.lineHeight ?? 1.2) * 100)}
              onChange={(v) => patch({ lineHeight: Math.max(0, v / 100) })}
              onCommit={commit}
              step={5}
              min={0}
              suffix="%"
            />
            <NumberCell
              prefix="LS"
              value={Math.round((overlay.letterSpacing ?? 0) * 100)}
              onChange={(v) => patch({ letterSpacing: v / 100 })}
              onCommit={commit}
              step={1}
              suffix="%"
            />
          </div>
        </HRow>
        <HRow label="Color">
          <ColorCell value={overlay.color} onChange={(v) => patch({ color: v })} onCommit={commit} />
        </HRow>
        <HRow label="Animation">
          <SelectCell
            value={overlay.animation}
            options={TEXT_ANIMATIONS.map((a) => ({ value: a.value, label: a.label }))}
            onChange={(v) => {
              patch({ animation: v as TextOverlay['animation'] })
              commit()
            }}
          />
        </HRow>
      </Section>
      <Section title="Position">
        <HRow label="X">
          <NumberCell
            prefix="X"
            value={overlay.x}
            onChange={(v) => patch({ x: v })}
            onCommit={commit}
            suffix="%"
            step={0.5}
          />
        </HRow>
        <HRow label="Y">
          <NumberCell
            prefix="Y"
            value={overlay.y}
            onChange={(v) => patch({ y: v })}
            onCommit={commit}
            suffix="%"
            step={0.5}
          />
        </HRow>
      </Section>
      <Section title="Time" defaultOpen={false}>
        <HRow label="Delay">
          <NumberCell
            value={overlay.delay}
            onChange={(v) => patch({ delay: Math.max(0, v) })}
            onCommit={commit}
            step={0.1}
            min={0}
            suffix="s"
          />
        </HRow>
        <HRow label="Duration">
          <NumberCell
            value={overlay.duration}
            onChange={(v) => patch({ duration: Math.max(0.1, v) })}
            onCommit={commit}
            step={0.1}
            min={0.1}
            suffix="s"
          />
        </HRow>
      </Section>
    </>
  )
}

// ── Generic text-slot editor (SVG text, DOM text, chart titles, interaction
// labels, ...) — routed here when the user clicks a text node under SVG /
// chart in the layer stack. Uses the same slot machinery the legacy Text tab
// uses (applyTextSlotValue) so the edit reaches the right destination.
function TextSlotBody({
  scene,
  slotKey,
  commit,
  commitDebounced,
}: {
  scene: Scene
  slotKey: string
  commit: () => void
  commitDebounced: () => void
}) {
  const updateScene = useVideoStore((s) => s.updateScene)
  const patchInspectorElement = useVideoStore((s) => s.patchInspectorElement)
  const inspectorElements = useVideoStore((s) => s.inspectorElements)
  const isSvgSlot = slotKey.startsWith('svg:main:') || slotKey.startsWith('svg:obj:')
  const [draft, setDraft] = useState(() => getTextSlotValue(scene, slotKey, inspectorElements))
  // Reset draft when the slot key changes (different slot selected)
  useEffect(() => {
    setDraft(getTextSlotValue(scene, slotKey, inspectorElements))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey])

  // Read scene fresh from the store on each call so consecutive edits before
  // React re-renders don't clobber each other. The `scene` prop is only used
  // for the initial draft / dropdown reads.
  const sceneId = scene.id
  const apply = useCallback(
    (value: string) => {
      const fresh = useVideoStore.getState().scenes.find((s) => s.id === sceneId)
      if (!fresh) return
      const { patch, saveHtml, domElementId } = applyTextSlotValue(fresh, slotKey, value)
      if (Object.keys(patch).length === 0) return
      updateScene(sceneId, patch)
      if (domElementId) {
        patchInspectorElement(domElementId, 'text', value)
      }
      if (saveHtml) commitDebounced()
    },
    [sceneId, slotKey, updateScene, patchInspectorElement, commitDebounced],
  )

  const applyAttr = useCallback(
    (attr: string, value: string) => {
      const fresh = useVideoStore.getState().scenes.find((s) => s.id === sceneId)
      if (!fresh) return
      const patch = setSvgSlotAttr(fresh, slotKey, attr, value)
      if (Object.keys(patch).length === 0) return
      updateScene(sceneId, patch)
      commitDebounced()
    },
    [sceneId, slotKey, updateScene, commitDebounced],
  )

  // Read current SVG attributes (only meaningful for SVG slots)
  const svgFont = isSvgSlot ? getSvgSlotAttr(scene, slotKey, 'font-family') : ''
  const svgSize = isSvgSlot ? getSvgSlotAttr(scene, slotKey, 'font-size') : ''
  const svgFill = isSvgSlot ? getSvgSlotAttr(scene, slotKey, 'fill') : ''
  const svgWeight = isSvgSlot ? getSvgSlotAttr(scene, slotKey, 'font-weight') : ''
  const svgSpacing = isSvgSlot ? getSvgSlotAttr(scene, slotKey, 'letter-spacing') : ''

  // Parse `font-size` value (could be "48", "48px", or unitless). Strip
  // trailing units for the input; preserve any unit suffix on write.
  const sizeNum = parseFloat(svgSize) || 0
  const sizeUnit = (svgSize.match(/[a-z%]+$/i)?.[0] ?? 'px') as string
  const spacingNum = parseFloat(svgSpacing) || 0
  const spacingUnit = (svgSpacing.match(/[a-z%]+$/i)?.[0] ?? 'em') as string

  return (
    <Section title="Typography">
      <HRow label="Content">
        <TextCell
          value={draft}
          onChange={(v) => {
            setDraft(v)
            apply(v)
          }}
          onCommit={commit}
        />
      </HRow>

      {isSvgSlot && (
        <>
          <HRow label="Font">
            <TextCell
              value={svgFont}
              onChange={(v) => applyAttr('font-family', v)}
              onCommit={commit}
              placeholder="(inherit)"
            />
          </HRow>
          <HRow label="Sizing">
            <div className="grid grid-cols-2 gap-2">
              <SelectCell
                value={svgWeight || '400'}
                options={TEXT_WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
                onChange={(v) => {
                  applyAttr('font-weight', v === '400' ? '' : v)
                  commit()
                }}
              />
              <NumberCell
                value={sizeNum}
                onChange={(v) => applyAttr('font-size', v > 0 ? `${v}${sizeUnit}` : '')}
                onCommit={commit}
                min={0}
                suffix={sizeUnit}
              />
            </div>
          </HRow>
          <HRow label="">
            <NumberCell
              prefix="LS"
              value={spacingNum}
              onChange={(v) => applyAttr('letter-spacing', v !== 0 ? `${v}${spacingUnit}` : '')}
              onCommit={commit}
              step={0.01}
              suffix={spacingUnit}
            />
          </HRow>
          <HRow label="Color">
            <ColorCell value={svgFill || '#000000'} onChange={(v) => applyAttr('fill', v)} onCommit={commit} />
          </HRow>
        </>
      )}
    </Section>
  )
}

/**
 * Standalone timeline audio clip (a dropped file — not scene-owned). Controls
 * map to what the audio pipeline actually honors: clipVolumeAt reads
 * `opacity` as the clip gain (audio clips have no visual opacity), `speed`
 * drives playbackRate/atempo, `audioMuted` gates the voice. Clip `fadeIn`/
 * `fadeOut` are video-only ramps, so they are intentionally absent here —
 * gain envelopes come from the timeline rubber band.
 */
function ClipAudioBody({ clipId }: { clipId: string }) {
  const timeline = useVideoStore((s) => s.project.timeline)
  const updateClip = useVideoStore((s) => s.updateClip)
  const track = timeline?.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!clip) {
    return (
      <div className="px-3 py-4 text-[11px] text-[var(--color-text-muted)]">Clip is no longer on the timeline.</div>
    )
  }
  const srcName = clip.sourceId.split('/').pop() || clip.sourceId
  return (
    <Section title="Audio clip">
      <div className="truncate text-[11px] text-[var(--color-text-muted)]">
        {track?.name ?? '—'} · {clip.duration.toFixed(1)}s · {srcName}
      </div>
      <div>
        <FieldLabel>Volume</FieldLabel>
        <SliderCell value={clip.opacity ?? 1} max={2} onChange={(v) => updateClip(clipId, { opacity: v })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <FieldLabel keyframable={false}>Start</FieldLabel>
          <NumberCell
            value={clip.startTime}
            onChange={(v) => updateClip(clipId, { startTime: Math.max(0, v) })}
            step={0.1}
            min={0}
            suffix="s"
          />
        </div>
        <div>
          <FieldLabel keyframable={false}>Mute</FieldLabel>
          <SelectCell
            value={clip.audioMuted ? 'on' : 'off'}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
            onChange={(v) => updateClip(clipId, { audioMuted: v === 'on' })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <FieldLabel keyframable={false}>Speed</FieldLabel>
          <NumberCell
            value={clip.speed || 1}
            onChange={(v) => updateClip(clipId, { speed: Math.min(4, Math.max(0.25, v)) })}
            step={0.05}
            min={0.25}
            max={4}
            suffix="x"
          />
        </div>
        <div>
          <FieldLabel keyframable={false}>Lock pitch</FieldLabel>
          <SelectCell
            value={clip.lockAudioPitch === false ? 'off' : 'on'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => updateClip(clipId, { lockAudioPitch: v === 'on' })}
          />
        </div>
      </div>
    </Section>
  )
}

/**
 * Inspector body for a STANDALONE video/image clip (a media file dropped on the
 * timeline = a bare clip with sourceType video/image, NOT a scene). It has no scene
 * to host its properties, so it gets its own clip-level inspector — opacity + the
 * clip color grade (full CSS + WebGL LUT/hue tier, since this is real media).
 */
function ClipMediaBody({ clipId }: { clipId: string }) {
  const timeline = useVideoStore((s) => s.project.timeline)
  const updateClip = useVideoStore((s) => s.updateClip)
  const track = timeline?.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!clip) {
    return (
      <div className="px-3 py-4 text-[11px] text-[var(--color-text-muted)]">Clip is no longer on the timeline.</div>
    )
  }
  const srcName = clip.sourceId.split('/').pop() || clip.sourceId
  const isMedia = clip.sourceType === 'video' || clip.sourceType === 'image'
  return (
    <>
      <Section title={clip.sourceType === 'image' ? 'Image clip' : 'Video clip'}>
        <div className="truncate text-[11px] text-[var(--color-text-muted)]">
          {track?.name ?? '—'} · {clip.duration.toFixed(1)}s · {srcName}
        </div>
        <div>
          <FieldLabel keyframable={false}>Opacity</FieldLabel>
          <SliderCell value={clip.opacity ?? 1} onChange={(v) => updateClip(clipId, { opacity: v })} />
        </div>
      </Section>
      {/* Real media clip → the full grade tier (LUT/hue render via WebGL). */}
      <ColorGradePanel
        grade={clip.grade}
        lutTierAvailable={isMedia}
        defaultOpen
        onChange={(next) => updateClip(clipId, { grade: next })}
        onCommit={() => {
          /* updateClip already persists + debounces an undo entry */
        }}
      />
    </>
  )
}

function AudioBody({ scene, commit }: { scene: Scene; commit: () => void }) {
  const updateScene = useVideoStore((s) => s.updateScene)
  const audio = normalizeAudioLayer(scene.audioLayer)
  const patch = (p: Partial<typeof audio>) => updateScene(scene.id, { audioLayer: { ...audio, ...p } })
  const patchMusic = (p: Partial<NonNullable<typeof audio.music>>) => {
    if (audio.music) patch({ music: { ...audio.music, ...p } })
  }
  const patchSfx = (sfxId: string, p: Partial<(typeof sfx)[number]>) =>
    patch({ sfx: (audio.sfx ?? []).map((f) => (f.id === sfxId ? { ...f, ...p } : f)) })

  const tts = audio.tts && (audio.tts.src || audio.tts.text?.trim()) ? audio.tts : null
  const music = audio.music?.src ? audio.music : null
  const sfx = audio.sfx ?? []

  return (
    <>
      <Section title="Audio">
        <div>
          <FieldLabel>Volume</FieldLabel>
          <SliderCell value={audio.volume} onChange={(v) => patch({ volume: v })} onCommit={commit} />
        </div>
        <div>
          <FieldLabel keyframable={false}>Offset</FieldLabel>
          <NumberCell
            value={audio.startOffset ?? 0}
            onChange={(v) => patch({ startOffset: Math.max(0, v) })}
            onCommit={commit}
            step={0.1}
            min={0}
            suffix="s"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel keyframable={false}>Fade in</FieldLabel>
            <SelectCell
              value={audio.fadeIn ? 'on' : 'off'}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ]}
              onChange={(v) => {
                patch({ fadeIn: v === 'on' })
                commit()
              }}
            />
          </div>
          <div>
            <FieldLabel keyframable={false}>Fade out</FieldLabel>
            <SelectCell
              value={audio.fadeOut ? 'on' : 'off'}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ]}
              onChange={(v) => {
                patch({ fadeOut: v === 'on' })
                commit()
              }}
            />
          </div>
        </div>
      </Section>

      {tts && (
        <Section title="Narration">
          <div className="text-[11px] text-[var(--color-text-muted)]">
            {tts.provider}
            {tts.voiceId ? ` · ${tts.voiceId}` : ''}
            {tts.duration ? ` · ${tts.duration.toFixed(1)}s` : ''}
          </div>
          {tts.text?.trim() && (
            <div className="line-clamp-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--color-text-primary)]">
              {tts.text}
            </div>
          )}
        </Section>
      )}

      {music && (
        <Section title="Music">
          {music.name?.trim() && <div className="text-[11px] text-[var(--color-text-muted)]">{music.name}</div>}
          <div>
            <FieldLabel>Volume</FieldLabel>
            <SliderCell value={music.volume} onChange={(v) => patchMusic({ volume: v })} onCommit={commit} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel keyframable={false}>Loop</FieldLabel>
              <SelectCell
                value={music.loop ? 'on' : 'off'}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'on', label: 'On' },
                ]}
                onChange={(v) => {
                  patchMusic({ loop: v === 'on' })
                  commit()
                }}
              />
            </div>
            <div>
              <FieldLabel keyframable={false}>Duck under voice</FieldLabel>
              <SelectCell
                value={music.duckDuringTTS ? 'on' : 'off'}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'on', label: 'On' },
                ]}
                onChange={(v) => {
                  patchMusic({ duckDuringTTS: v === 'on' })
                  commit()
                }}
              />
            </div>
          </div>
          {music.duckDuringTTS && (
            <div>
              <FieldLabel keyframable={false}>Duck to</FieldLabel>
              <SliderCell value={music.duckLevel} onChange={(v) => patchMusic({ duckLevel: v })} onCommit={commit} />
            </div>
          )}
        </Section>
      )}

      {sfx.length > 0 && (
        <Section title="Sound effects">
          {sfx.map((f) => (
            <div key={f.id} className="space-y-1.5">
              <FieldLabel keyframable={false}>{f.name?.trim() || 'Effect'}</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                <NumberCell
                  prefix="At"
                  value={f.triggerAt}
                  onChange={(v) => patchSfx(f.id, { triggerAt: Math.max(0, v) })}
                  onCommit={commit}
                  step={0.1}
                  min={0}
                  suffix="s"
                />
                <SliderCell value={f.volume} onChange={(v) => patchSfx(f.id, { volume: v })} onCommit={commit} />
              </div>
            </div>
          ))}
        </Section>
      )}
    </>
  )
}

function VideoBody({ scene, commit }: { scene: Scene; commit: () => void }) {
  const updateScene = useVideoStore((s) => s.updateScene)
  const vl = scene.videoLayer
  if (!vl) return <Section title="Video">No video layer.</Section>
  const patch = (p: Partial<NonNullable<typeof scene.videoLayer>>) =>
    updateScene(scene.id, { videoLayer: { ...vl, ...p } })
  return (
    <>
      <Section title="Source">
        <div>
          <FieldLabel keyframable={false}>URL</FieldLabel>
          <TextCell value={vl.src ?? ''} onChange={(v) => patch({ src: v || null })} onCommit={commit} />
        </div>
      </Section>
      <Section title="Time">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Trim in</FieldLabel>
            <NumberCell
              value={vl.trimStart}
              onChange={(v) => patch({ trimStart: Math.max(0, v) })}
              onCommit={commit}
              step={0.1}
              min={0}
              suffix="s"
            />
          </div>
          <div>
            <FieldLabel>Trim out</FieldLabel>
            <NumberCell
              value={vl.trimEnd ?? 0}
              onChange={(v) => patch({ trimEnd: v <= 0 ? null : v })}
              onCommit={commit}
              step={0.1}
              min={0}
              suffix="s"
            />
          </div>
        </div>
      </Section>
      <Section title="Blending">
        <div>
          <FieldLabel>Opacity</FieldLabel>
          <NumberCell
            prefixIcon={<Grid3x3 size={11} />}
            value={Math.round(vl.opacity * 100)}
            onChange={(v) => patch({ opacity: Math.max(0, Math.min(1, v / 100)) })}
            onCommit={commit}
            step={5}
            min={0}
            max={100}
          />
        </div>
      </Section>
      <LayerGradeControl
        sceneId={scene.id}
        value={{ lookCss: vl.filter, grade: vl.colorGrade }}
        onApply={(next) => {
          patch({ filter: next.lookCss, colorGrade: next.grade })
          commit()
        }}
      />
    </>
  )
}

// ── Code-extracted text editor (rx:* rows in the layer stack) ──────────────
// React / Motion / Canvas2D / Three.js scenes don't have first-class text
// slots — their text lives inside source code (reactCode / sceneCode /
// canvasCode). The layer stack surfaces each text-bearing literal as an
// `rx:{kind}:{idx}` row; this editor lets the user retype that literal,
// change its typography (font, size, weight, color, line-height,
// letter-spacing), and rewrites the source code in place.

// Code field picker lives in src/lib/code-text-slots.ts so the layer-stack
// scanner and this editor stay in sync.

/**
 * Convert a global rx index (the one the layer stack assigns) to a new-style
 * `CodeTextSlot`. The layer stack walks `extractElementsFromReactCode`,
 * filters by editable kinds, dedupes by `${kind}:${label}`, then assigns
 * sequential indices. We must replay that exact walk to keep indices aligned.
 * Then locate the matching slot in the new extractor by (kind, text).
 * Returns null if no match.
 */
function resolveRxSlot(code: string, rxIndex: number): CodeTextSlot | null {
  const elements = extractElementsFromReactCode(code)
  const seen = new Set<string>()
  let legacyTarget: (typeof elements)[number] | null = null
  let i = 0
  for (const el of elements) {
    const editable =
      el.kind === 'heading' ||
      el.kind === 'paragraph' ||
      el.kind === 'image' ||
      el.kind === 'button' ||
      el.kind === 'listItem' ||
      el.kind === 'text'
    if (!editable) continue
    const dedupKey = `${el.kind}:${el.label}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    if (i === rxIndex) {
      legacyTarget = el
      break
    }
    i++
  }
  if (!legacyTarget) return null
  const targetKinds = legacyToNewKinds(legacyTarget.kind)
  const slots = extractCodeTextSlots(code).filter((s) => targetKinds.includes(s.kind))
  if (!slots.length) return null
  // Match on raw text first; if legacy didn't capture raw, fall back to
  // the first slot of that kind (the layer stack only shows the first
  // occurrence anyway thanks to its dedup).
  if (legacyTarget.raw) {
    const exact = slots.find((s) => s.text === legacyTarget.raw)
    if (exact) return exact
  }
  return slots[0] ?? null
}

/** Map a clicked DOM tag to the legacy extractor's kind name. */
function tagNameToLegacyKind(tagName: string): string | null {
  const t = tagName.toLowerCase()
  if (/^h[1-6]$/.test(t)) return 'heading'
  if (t === 'p') return 'paragraph'
  if (t === 'button') return 'button'
  if (t === 'li') return 'listItem'
  if (t === 'div' || t === 'span' || t === 'text') return 'text'
  return null
}

/**
 * Find the layer-stack `rx:{kind}:{idx}` index for a DOM-clicked slot.
 * Replays the same dedup walk SceneLayersStackPanel uses, then matches
 * by (legacyKind, raw textContent). Returns null if the click can't be
 * mapped to a source element (e.g. text dynamically generated at runtime).
 */
function rxIndexForClickedSlot(
  code: string,
  tagName: string,
  textContent: string,
): { kind: string; idx: number } | null {
  const legacy = tagNameToLegacyKind(tagName)
  if (!legacy) return null
  const targetText = textContent.trim()
  // For legacy 'text' kind, the extractor collapses div/span/svg-text/
  // canvas-text/three-text into one bucket. The clicked DOM tag tells us
  // which sub-source the user actually meant, so prefer extractor entries
  // whose new-kind matches. We use extractCodeTextSlots solely as a
  // sub-source disambiguator — the rx index still comes from the
  // legacy-walk dedup order.
  const preferredNewKinds: CodeTextSlotKind[] =
    legacy === 'text'
      ? tagName === 'div'
        ? ['jsx-div']
        : tagName === 'span'
          ? ['jsx-span']
          : tagName === 'text'
            ? ['svg-text']
            : ['jsx-div', 'jsx-span', 'svg-text', 'canvas-text', 'three-text']
      : []
  const newSlotsForKind = preferredNewKinds.length
    ? extractCodeTextSlots(code).filter((s) => preferredNewKinds.includes(s.kind) && s.text === targetText)
    : []
  const preferredText = newSlotsForKind[0]?.text ?? targetText

  const els = extractElementsFromReactCode(code)
  const seen = new Set<string>()
  let rxIdx = 0
  for (const el of els) {
    const editable =
      el.kind === 'heading' ||
      el.kind === 'paragraph' ||
      el.kind === 'image' ||
      el.kind === 'button' ||
      el.kind === 'listItem' ||
      el.kind === 'text'
    if (!editable) continue
    const dedupKey = `${el.kind}:${el.label}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    if (el.kind === legacy && (el.raw ?? '').trim() === preferredText) {
      return { kind: el.kind, idx: rxIdx }
    }
    rxIdx++
  }
  return null
}

function legacyToNewKinds(kind: string): CodeTextSlotKind[] {
  if (kind === 'heading') return ['jsx-heading']
  if (kind === 'paragraph') return ['jsx-paragraph']
  if (kind === 'button') return ['jsx-button']
  if (kind === 'listItem') return ['jsx-li']
  if (kind === 'text') return ['jsx-div', 'jsx-span', 'svg-text', 'canvas-text', 'three-text']
  return []
}

/**
 * Merge live iframe computedStyle (strings like "168px", "rgb(255, 255, 255)")
 * into the source-parsed style shape. Numbers parse out of "168px" etc.
 * Colors normalize to hex when possible so the ColorCell picker can render.
 */
function mergeRemoteIntoStyle(
  fromSource: TextSlotStyle,
  remote: {
    fontFamily?: string
    fontSize?: string
    fontWeight?: string
    fontStyle?: string
    color?: string
    lineHeight?: string
    letterSpacing?: string
    textAlign?: string
  },
): TextSlotStyle {
  const out: TextSlotStyle = { ...fromSource }
  if (remote.fontFamily) out.fontFamily = remote.fontFamily
  const px = (v: string | undefined) => {
    if (!v || v === 'normal') return undefined
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : undefined
  }
  const fs = px(remote.fontSize)
  if (fs !== undefined) out.fontSize = fs
  if (remote.fontWeight) {
    const w = parseInt(remote.fontWeight, 10)
    if (Number.isFinite(w)) out.fontWeight = w
  }
  if (remote.fontStyle) out.fontStyle = remote.fontStyle
  if (remote.color) out.color = cssColorToHex(remote.color) ?? remote.color
  const lh = px(remote.lineHeight)
  if (lh !== undefined && fs && fs > 0) out.lineHeight = lh / fs
  else if (remote.lineHeight && remote.lineHeight !== 'normal') out.lineHeight = remote.lineHeight
  const ls = px(remote.letterSpacing)
  if (ls !== undefined) out.letterSpacing = ls
  if (remote.textAlign) out.textAlign = remote.textAlign
  return out
}

function cssColorToHex(c: string): string | null {
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (!m) return null
  const r = parseInt(m[1], 10)
  const g = parseInt(m[2], 10)
  const b = parseInt(m[3], 10)
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const FONT_WEIGHTS = [
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Extrabold' },
  { value: '900', label: 'Black' },
] as const

function RxTextBody({
  scene,
  rxIndex,
  commit,
  commitDebounced,
}: {
  scene: Scene
  rxIndex: number
  commit: () => void
  commitDebounced: () => void
}) {
  const updateScene = useVideoStore((s) => s.updateScene)
  const codeField = pickSceneCodeField(scene)
  const code = codeField ? ((scene as unknown as Record<string, string | undefined>)[codeField as string] ?? '') : ''
  const baseSlot = useMemo(() => (codeField ? resolveRxSlot(code, rxIndex) : null), [codeField, code, rxIndex])

  // Layer 2: pull live computedStyle + stable slot ID from the iframe.
  const { slots: remoteSlots } = useSceneTextSlots(scene.id)

  // Snapshot of typography props at first view of each slot, used by the
  // "Reset" button. Map persists per panel instance — navigating away and
  // back returns the original snapshot (not the post-edit state). Captured
  // from the merged style (source + iframe computedStyle), so Tailwind /
  // CSS-file values are preserved correctly.
  const snapshotsRef = useRef<Map<string, TextSlotStyle>>(new Map())

  // Layer 3 fix: track the actually-clicked DOM slot. The layer-stack key
  // dedups same-text duplicates into one row, so rxIndex alone can't tell
  // us which of the three identical <h1>HELLO</h1>s the user clicked.
  // The override holds the iframe's slot ID for the clicked element; when
  // present and same-kind as baseSlot, it overrides codeOrdinal so both
  // the highlight ring AND the source rewrite target the right one.
  const [domOverrideSlotId, setDomOverrideSlotId] = useState<string | null>(null)

  // Codepath A: layer-stack click → baseSlot from rxIndex → ordinal 0
  // Codepath B: canvas click → also sets override → ordinal from DOM index
  const codeOrdinal = useMemo(() => {
    if (!baseSlot || !codeField) return 0
    const all = extractCodeTextSlots(code).filter((s) => s.kind === baseSlot.kind)
    const ix = all.findIndex((s) => s.index === baseSlot.index)
    return ix >= 0 ? ix : 0
  }, [baseSlot, code, codeField])

  const tagsForKind: Record<CodeTextSlotKind, string[]> = useMemo(
    () => ({
      'jsx-heading': ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      'jsx-paragraph': ['p'],
      'jsx-button': ['button'],
      'jsx-li': ['li'],
      'jsx-div': ['div'],
      'jsx-span': ['span'],
      'svg-text': ['text'],
      'canvas-text': [],
      'three-text': [],
    }),
    [],
  )

  // Effective ordinal: prefer override when valid (matches baseSlot kind +
  // exists in remoteSlots). Silently falls back to codeOrdinal otherwise.
  const effectiveOrdinal = useMemo(() => {
    if (!domOverrideSlotId || !remoteSlots || !baseSlot) return codeOrdinal
    const tags = tagsForKind[baseSlot.kind]
    if (!tags?.length) return codeOrdinal
    const matches = remoteSlots.filter((s) => tags.includes(s.tagName))
    const idx = matches.findIndex((s) => s.id === domOverrideSlotId)
    return idx >= 0 ? idx : codeOrdinal
  }, [domOverrideSlotId, remoteSlots, baseSlot, tagsForKind, codeOrdinal])

  // Source slot for editing: when an override is active and shifts the
  // ordinal, pick the same-kind slot at that ordinal from the live source.
  const slot = useMemo<CodeTextSlot | null>(() => {
    if (!baseSlot) return baseSlot
    if (effectiveOrdinal === codeOrdinal) return baseSlot
    const sameKind = extractCodeTextSlots(code).filter((s) => s.kind === baseSlot.kind)
    return sameKind[effectiveOrdinal] ?? baseSlot
  }, [baseSlot, effectiveOrdinal, codeOrdinal, code])

  const remoteSlot = useMemo(
    () => (slot && remoteSlots ? findRemoteSlotForCode(remoteSlots, slot.kind, effectiveOrdinal) : null),
    [slot, remoteSlots, effectiveOrdinal],
  )

  const [draftText, setDraftText] = useState(slot?.text ?? '')
  useEffect(() => {
    setDraftText(slot?.text ?? '')
  }, [slot?.text])

  const snapshotKey = slot ? `${slot.kind}:${effectiveOrdinal}` : ''

  // Capture the snapshot once per slot key — when both source slot and
  // (ideally) remote computed style are resolved. Re-runs are no-ops:
  // the Map only sets if the key isn't already present, so navigating
  // away and back returns the original pristine values.
  useEffect(() => {
    if (!snapshotKey || !slot) return
    if (snapshotsRef.current.has(snapshotKey)) return
    const merged: TextSlotStyle = remoteSlot ? mergeRemoteIntoStyle(slot.style, remoteSlot.style) : { ...slot.style }
    snapshotsRef.current.set(snapshotKey, merged)
  }, [snapshotKey, slot, remoteSlot])

  // Fallback for live-apply when the iframe slot tagger hasn't run yet
  // (first render, before MutationObserver fires): match by textContent.
  const liveTextRef = useRef(slot?.text ?? '')
  useEffect(() => {
    liveTextRef.current = slot?.text ?? ''
  }, [slot?.text])

  // Layer 3: while this panel is mounted, enable click-to-select in the
  // canvas. Disable on unmount so interactive scenes aren't intercepted.
  const setLayerStackPropertiesKey = useVideoStore((s) => s.setLayerStackPropertiesKey)
  useEffect(() => {
    postEnableSelectMode(scene.id)
    const unsub = subscribeSlotClicked((ev) => {
      if (ev.sceneId !== scene.id) return
      const fresh = useVideoStore.getState().scenes.find((s) => s.id === scene.id)
      if (!fresh) return
      const cf = pickSceneCodeField(fresh)
      if (!cf) return
      const freshCode = (fresh as unknown as Record<string, string | undefined>)[cf as string] ?? ''
      const rx = rxIndexForClickedSlot(freshCode, ev.tagName, ev.textContent)
      if (!rx) return
      // Set BOTH: the rx key (may be a no-op for deduped duplicates) plus
      // the DOM-slot override so the panel targets the actually-clicked
      // element rather than always the first source occurrence.
      setDomOverrideSlotId(ev.slotId)
      setLayerStackPropertiesKey(`rx:${rx.kind}:${rx.idx}`)
    })
    return () => {
      unsub()
      postDisableSelectMode(scene.id)
      postSelectSlot(scene.id, null)
    }
  }, [scene.id, setLayerStackPropertiesKey])

  // Highlight the currently-edited slot in the canvas. Reacts to
  // remoteSlot resolving (which depends on iframe response + rxIndex).
  useEffect(() => {
    if (remoteSlot?.id) postSelectSlot(scene.id, remoteSlot.id)
    else postSelectSlot(scene.id, null)
  }, [scene.id, remoteSlot?.id])

  // Layer 4: receive inline contentEditable updates from the iframe.
  // While the user types directly in the canvas, sync source + draft.
  // Ref-indirection so this effect can run before applyTextFromIframe is
  // defined further down (the underlying applyEdit closes over `slot`
  // which the early returns guard against).
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])
  const applyTextFromIframeRef = useRef<(t: string) => void>(() => {})
  useEffect(() => {
    const activeSlotId = remoteSlot?.id
    if (!activeSlotId) return
    const unsubInput = subscribeSlotTextInput((ev) => {
      if (ev.sceneId !== scene.id || ev.slotId !== activeSlotId) return
      setDraftText(ev.text)
      applyTextFromIframeRef.current(ev.text)
    })
    const unsubCommit = subscribeSlotTextCommitted((ev) => {
      if (ev.sceneId !== scene.id || ev.slotId !== activeSlotId) return
      if (ev.committed) {
        setDraftText(ev.text)
        applyTextFromIframeRef.current(ev.text)
        commitRef.current()
      } else {
        // Revert — bring draft + source back to original. The iframe
        // already restored its DOM; mirror that into source.
        const original = liveTextRef.current
        setDraftText(original)
        applyTextFromIframeRef.current(original)
      }
    })
    return () => {
      unsubInput()
      unsubCommit()
    }
  }, [scene.id, remoteSlot?.id])

  if (!codeField) {
    return (
      <Section title="Text">
        <p className="text-[11px] text-[var(--color-text-muted)]">This scene has no editable source code.</p>
      </Section>
    )
  }

  if (!slot) {
    return (
      <Section title="Text">
        <p className="text-[11px] text-[var(--color-text-muted)]">
          This text row no longer matches an element in the scene code.
        </p>
      </Section>
    )
  }

  const canEditStyle = slot.kind !== 'canvas-text' && slot.kind !== 'three-text'
  // Prefer the iframe's computedStyle (Tailwind + CSS files + inheritance)
  // and fall back to the source-parsed style for the brief window before
  // the iframe responds with text slots.
  const style: TextSlotStyle = remoteSlot ? mergeRemoteIntoStyle(slot.style, remoteSlot.style) : slot.style
  const livePreview = isLivePreviewable(slot.kind)

  /** Occurrence among slots with the same kind AND text in the live source.
   * Used only when the iframe hasn't tagged elements yet (slot ID fallback). */
  const computeOccurrence = (
    freshCode: string,
    freshSlotIndex: number,
    kind: CodeTextSlotKind,
    text: string,
  ): number => {
    const slots = extractCodeTextSlots(freshCode).filter((s) => s.kind === kind && s.text === text)
    const idx = slots.findIndex((s) => s.index === freshSlotIndex)
    return idx >= 0 ? idx : 0
  }

  // Resolve a fresh slot at edit time so concurrent edits don't shift things.
  // `skipLivePreview` is set when the iframe is the *source* of the change
  // (inline contentEditable typing) — the DOM already shows the new value,
  // so re-applying via postMessage would just create a loop.
  const applyEdit = (
    mutate: (freshCode: string, freshSlot: CodeTextSlot) => string | null,
    live?: { newText?: string; style?: TextSlotStyle; skipLivePreview?: boolean },
  ) => {
    if (!codeField) return
    const fresh = useVideoStore.getState().scenes.find((s) => s.id === scene.id)
    if (!fresh) return
    const freshCode = (fresh as unknown as Record<string, string | undefined>)[codeField as string] ?? ''
    const freshBase = resolveRxSlot(freshCode, rxIndex)
    if (!freshBase) return
    // Resolve the SAME duplicate the panel/live-preview is editing. resolveRxSlot
    // only knows rxIndex (codeOrdinal's slot); when a DOM override shifted
    // effectiveOrdinal across same-kind duplicates, re-pick the same-kind slot
    // at that ordinal from the fresh source — otherwise the source rewrite hits
    // whichever duplicate rxIndex maps to, not the one the user clicked. Mirrors
    // the `slot` resolution above so highlight, live preview, and rewrite agree.
    const freshSlot =
      effectiveOrdinal === codeOrdinal
        ? freshBase
        : (extractCodeTextSlots(freshCode).filter((s) => s.kind === freshBase.kind)[effectiveOrdinal] ?? freshBase)

    if (livePreview && live && !live.skipLivePreview) {
      const slotId = remoteSlot?.id
      const matchText = slotId ? undefined : liveTextRef.current || freshSlot.text
      const occurrence = slotId
        ? undefined
        : computeOccurrence(freshCode, freshSlot.index, freshSlot.kind, freshSlot.text)
      postLiveApply({
        sceneId: scene.id,
        kind: freshSlot.kind,
        slotId,
        matchText,
        occurrence,
        newText: live.newText,
        style: live.style,
      })
      if (typeof live.newText === 'string') liveTextRef.current = live.newText
    } else if (live && typeof live.newText === 'string') {
      liveTextRef.current = live.newText
    }

    const updated = mutate(freshCode, freshSlot)
    if (updated === null || updated === freshCode) return
    updateScene(scene.id, { [codeField]: updated } as Partial<Scene>)
    commitDebounced()
  }

  const applyText = (next: string) => applyEdit((c, s) => updateCodeSlotText(c, s, next), { newText: next })

  // Iframe-originated text edits (inline contentEditable). The DOM is
  // already updated; just sync source + draft state.
  // Bind through the ref so the subscription effect (declared earlier in
  // the function, before the early returns) sees this implementation.
  applyTextFromIframeRef.current = (next: string) => {
    applyEdit((c, s) => updateCodeSlotText(c, s, next), { newText: next, skipLivePreview: true })
  }

  const applyStyle = (prop: keyof TextSlotStyle, value: string | number | null) =>
    applyEdit((c, s) => updateCodeSlotStyle(c, s, prop, value), {
      style: { [prop]: value == null ? '' : value } as TextSlotStyle,
    })

  // Reset every typography prop to its snapshot value. Snapshot may not
  // exist yet on the very first render (capture happens in a useEffect
  // after style resolves) — in that case Reset is a no-op.
  const resetTypography = () => {
    const snap = snapshotsRef.current.get(snapshotKey)
    if (!snap) return
    for (const d of TYPOGRAPHY_PROPS) {
      const original = (snap as Record<string, string | number | undefined>)[d.key]
      applyStyle(d.key, original == null ? null : (original as string | number))
    }
    commit()
  }

  // True when at least one prop has diverged from the snapshot. Compares
  // against the same merged style the panel renders, so the button reflects
  // what the user sees. Returns false until the snapshot exists.
  const hasChanges = (() => {
    const snap = snapshotsRef.current.get(snapshotKey)
    if (!snap) return false
    for (const d of TYPOGRAPHY_PROPS) {
      const a = (snap as Record<string, string | number | undefined>)[d.key]
      const b = (style as Record<string, string | number | undefined>)[d.key]
      if ((a ?? null) !== (b ?? null)) return true
    }
    return false
  })()

  return (
    <>
      <Section title="Typography">
        <HRow label="Content">
          <TextCell
            value={draftText}
            onChange={(v) => {
              setDraftText(v)
              applyText(v)
            }}
            onCommit={commit}
          />
        </HRow>
        {canEditStyle && (
          <>
            <HRow label="Weight">
              <SelectCell
                value={String(style.fontWeight ?? '400')}
                options={FONT_WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
                onChange={(v) => applyStyle('fontWeight', parseInt(v, 10))}
              />
            </HRow>
            <HRow label="Size">
              <NumberCell
                value={
                  typeof style.fontSize === 'number' ? style.fontSize : parseFloat(String(style.fontSize ?? 16)) || 16
                }
                onChange={(v) => applyStyle('fontSize', v)}
                onCommit={commit}
                step={1}
                min={1}
                suffix="px"
              />
            </HRow>
            <HRow label="Line height">
              <NumberCell
                value={
                  typeof style.lineHeight === 'number'
                    ? style.lineHeight
                    : parseFloat(String(style.lineHeight ?? 1.2)) || 1.2
                }
                onChange={(v) => applyStyle('lineHeight', v)}
                onCommit={commit}
                step={0.05}
                min={0}
              />
            </HRow>
            <HRow label="Letter spacing">
              <NumberCell
                value={
                  typeof style.letterSpacing === 'number'
                    ? style.letterSpacing
                    : parseFloat(String(style.letterSpacing ?? 0)) || 0
                }
                onChange={(v) => applyStyle('letterSpacing', v)}
                onCommit={commit}
                step={0.5}
                suffix="px"
              />
            </HRow>
            <HRow label="Color">
              <ColorCell
                value={typeof style.color === 'string' ? style.color : '#ffffff'}
                onChange={(v) => applyStyle('color', v)}
                onCommit={commit}
              />
            </HRow>
            <div className="pt-1">
              <button
                type="button"
                onClick={resetTypography}
                disabled={!hasChanges}
                className="no-style h-7 w-full rounded-md border border-[var(--color-border)] bg-transparent text-[11px] font-medium text-[var(--color-text-muted)] transition-colors enabled:hover:border-[var(--color-accent)] enabled:hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
                data-tooltip={hasChanges ? 'Restore original values' : 'No changes to reset'}
              >
                Reset to original
              </button>
            </div>
          </>
        )}
        {!canEditStyle && (
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {slot.kind === 'canvas-text'
              ? 'Canvas 2D text styles are set globally via ctx.font — edit in the Code tab.'
              : 'Three.js TextGeometry styles are set on the material/geometry — edit in the Code tab.'}
          </p>
        )}
      </Section>
    </>
  )
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function LayerStackPropertiesPanel({ scene }: Props) {
  const layerStackPropertiesKey = useVideoStore((s) => s.layerStackPropertiesKey)
  const setLayerStackPropertiesKey = useVideoStore((s) => s.setLayerStackPropertiesKey)
  const { commit, commitDebounced } = useLayerCommit(scene?.id ?? '')
  // sourceType of the clip a `clip:<id>` key points at (audio vs video/image),
  // so the title + body route correctly. Computed unconditionally (hook rules).
  const clipKindForKey = useVideoStore((s) => {
    const k = layerStackPropertiesKey
    if (!k) return null
    const parsed = parseLayerStackKey(k)
    if (parsed.kind !== 'clip' || !parsed.id) return null
    return s.project.timeline?.tracks.flatMap((t) => t.clips).find((c) => c.id === parsed.id)?.sourceType ?? null
  })
  const key = layerStackPropertiesKey
  if (!key) return null
  const { kind, id } = parseLayerStackKey(key)
  const clipIsMedia = clipKindForKey === 'video' || clipKindForKey === 'image'

  // Detect text-slot keys (multi-segment): svg:main:foo, svg:obj:abc:foo,
  // chart:abc:title, etc. These route to the generic TextSlotBody rather
  // than the kind-specific body.
  const isTextSlot =
    key.startsWith('svg:main:') ||
    (key.startsWith('svg:obj:') && (id ?? '').indexOf(':') >= 0) ||
    (key.startsWith('chart:') && (id ?? '').indexOf(':') >= 0) ||
    key.startsWith('dom:') ||
    (key.startsWith('ix:') && (id ?? '').indexOf(':') >= 0)

  const title = isTextSlot
    ? 'Text'
    : kind === 'bg'
      ? 'Background'
      : kind === 'video'
        ? 'Video'
        : kind === 'audio'
          ? 'Audio'
          : kind === 'clip'
            ? clipKindForKey === 'image'
              ? 'Image clip'
              : clipKindForKey === 'video'
                ? 'Video clip'
                : 'Audio clip'
            : !scene
              ? 'Layer'
              : kind === 'scene' && id
                ? scene.name?.trim() || 'Scene'
                : kind === 'ai' && id
                  ? ((scene.aiLayers ?? []).find((l) => l.id === id)?.label ?? 'AI layer')
                  : kind === 'chart' && id
                    ? (deriveChartLayersFromScene(scene).find((c) => c.id === id)?.name ?? 'Chart')
                    : kind === 'svg' && id
                      ? id === MAIN_SCENE_SVG_LAYER_ID
                        ? 'Scene SVG'
                        : 'SVG object'
                      : kind === 'text' && id
                        ? 'Text overlay'
                        : kind === 'interaction' && id
                          ? (() => {
                              const ix = (scene.interactions ?? []).find((x) => x.id === id)
                              return ix ? `Interaction · ${ix.type}` : 'Interaction'
                            })()
                          : kind === 'rx' && id
                            ? (() => {
                                const idx = parseInt(id.split(':')[1] ?? '', 10)
                                if (Number.isNaN(idx)) return 'Element'
                                // Replay buildDefaultOrder's filter + dedup walk so
                                // the title matches the layer-stack row label.
                                const cf = pickSceneCodeField(scene)
                                const code = cf
                                  ? ((scene as unknown as Record<string, string | undefined>)[cf] ?? '').trim()
                                  : ''
                                if (!code) return 'Element'
                                const elements = extractElementsFromReactCode(code)
                                const seen = new Set<string>()
                                let walked = 0
                                for (const el of elements) {
                                  const editable =
                                    el.kind === 'heading' ||
                                    el.kind === 'paragraph' ||
                                    el.kind === 'image' ||
                                    el.kind === 'button' ||
                                    el.kind === 'listItem' ||
                                    el.kind === 'text'
                                  if (!editable) continue
                                  const dedupKey = `${el.kind}:${el.label}`
                                  if (seen.has(dedupKey)) continue
                                  seen.add(dedupKey)
                                  if (walked === idx) return el.label
                                  walked++
                                }
                                return 'Element'
                              })()
                            : 'Layer'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={title} subtitle={key} onBack={() => setLayerStackPropertiesKey(null)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Standalone clip inspector (audio OR video/image media) — needs no scene,
            so it works in a scene-less project too. */}
        {kind === 'clip' && id && (clipIsMedia ? <ClipMediaBody clipId={id} /> : <ClipAudioBody clipId={id} />)}
        {scene && (
          <>
            {isTextSlot && (
              <TextSlotBody scene={scene} slotKey={key} commit={commit} commitDebounced={commitDebounced} />
            )}
            {!isTextSlot && kind === 'scene' && id && id !== 'canvas_bg' && (
              <SceneBody scene={scene} commit={commit} commitDebounced={commitDebounced} />
            )}
            {kind === 'bg' && id === 'stage' && <BgStageBody scene={scene} commit={commit} />}
            {kind === 'ai' && id ? (
              (scene.aiLayers ?? []).find((l) => l.id === id)?.type === 'avatar' ? (
                <Section title="Avatar">
                  <AvatarLayerPropertiesForm
                    scene={scene}
                    layerId={id}
                    onCommit={commit}
                    openLayersSection={() => {
                      /* stay in master-detail */
                    }}
                  />
                </Section>
              ) : (
                <AILayerBody scene={scene} layerId={id} commit={commit} />
              )
            ) : null}
            {kind === 'text' && id && (
              <TextOverlayBody scene={scene} overlayId={id} commit={commit} commitDebounced={commitDebounced} />
            )}
            {kind === 'audio' && <AudioBody scene={scene} commit={commit} />}
            {kind === 'video' && <VideoBody scene={scene} commit={commit} />}
            {!isTextSlot && kind === 'chart' && id && (
              <Section title="Chart">
                <ChartLayerPropertiesForm scene={scene} chartId={id} />
              </Section>
            )}
            {kind === 'interaction' &&
              id &&
              (() => {
                const el = (scene.interactions ?? []).find((x) => x.id === id)
                if (!el) {
                  return (
                    <Section title="Interaction">
                      <p className="text-[11px] text-[var(--color-text-muted)]">This interaction was removed.</p>
                    </Section>
                  )
                }
                return (
                  <Section title="Interaction">
                    <InteractionFormBody scene={scene} el={el} showTypeSwitcher />
                  </Section>
                )
              })()}
            {!isTextSlot && kind === 'svg' && id && (
              <Section title="SVG object">
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  SVG object editing happens via the layer stack — expand the layer for text and shape controls.
                </p>
              </Section>
            )}
            {kind === 'rx' &&
              id &&
              (() => {
                // Key format: rx:{subkind}:{idx} — id holds "subkind:idx"
                const parts = id.split(':')
                const subkind = parts[0]
                const idx = parseInt(parts[1] ?? '', 10)
                if (Number.isNaN(idx)) return null
                if (
                  subkind === 'text' ||
                  subkind === 'heading' ||
                  subkind === 'paragraph' ||
                  subkind === 'button' ||
                  subkind === 'listItem'
                ) {
                  return <RxTextBody scene={scene} rxIndex={idx} commit={commit} commitDebounced={commitDebounced} />
                }
                return (
                  <Section title="Element">
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      Code-extracted {subkind} element — editing happens in the Code tab.
                    </p>
                  </Section>
                )
              })()}
          </>
        )}
      </div>
    </div>
  )
}
