'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Plus, Type } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import type { Scene, TextOverlay } from '@/lib/types'
import { compileD3SceneFromLayers } from '@/lib/charts/compile'
import { deriveChartLayersFromScene } from '@/lib/charts/extract'
import {
  applyTextSlotValue,
  collectTextSlots,
  getTextSlotValue,
  layerHiddenIdForTextSlot,
  parseChartTitleSlotKey,
  type TextSlot,
} from '@/lib/text-slots'
import { SettingsButton } from '@/components/settings/GeneralSettingsTab'

interface Props {
  scene: Scene
}

function sceneHeading(scene: Scene): string {
  const n = scene.name?.trim()
  if (n) return n
  const p = scene.prompt?.trim()
  if (p) return p.length > 48 ? `${p.slice(0, 48)}…` : p
  return 'Untitled scene'
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  backgroundColor: 'var(--color-input-bg)',
  borderColor: 'var(--color-border)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: '6px',
  padding: '6px 8px',
  fontSize: '12px',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '10px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--color-text-muted)',
  marginBottom: '4px',
}

function AllTextStackPanel({
  scene,
  slots,
  selectedKey,
  addOverlayOpen,
  onAddOverlayClick,
  onSelectKey,
  onActivateKey,
  updateScene,
}: {
  scene: Scene
  slots: TextSlot[]
  selectedKey: string | null
  addOverlayOpen: boolean
  onAddOverlayClick: () => void
  onSelectKey: (key: string | null) => void
  onActivateKey: (key: string) => void
  updateScene: (sceneId: string, patch: Partial<Scene>) => void
}) {
  const sceneTitle = sceneHeading(scene)
  const hidden = new Set(scene.layerHiddenIds ?? [])

  const toggleTextSlotVisibility = (slotKey: string) => {
    const k = layerHiddenIdForTextSlot(slotKey)
    const h = new Set(scene.layerHiddenIds ?? [])
    if (h.has(k)) h.delete(k)
    else h.add(k)
    updateScene(scene.id, { layerHiddenIds: Array.from(h) })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-panel)',
      }}
      data-text-all-stack
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          borderBottom: '1px solid var(--color-border)',
          padding: '6px 8px',
          flexShrink: 0,
        }}
      >
        <span
          style={{ flexShrink: 0, color: 'var(--color-text-muted)' }}
          data-tooltip={`Text · ${slots.length} item${slots.length === 1 ? '' : 's'}`}
          data-tooltip-pos="bottom-left"
        >
          <Type size={12} strokeWidth={2.25} aria-hidden />
        </span>
        <span
          title={sceneTitle}
          style={{
            position: 'relative',
            minWidth: 0,
            maxWidth: 'min(240px, calc(100% - 3.25rem))',
            overflow: 'hidden',
            borderRadius: '6px',
            border: '1px solid var(--color-border)',
            background: 'var(--color-panel)',
            padding: '3px 8px',
            fontSize: '11px',
            color: 'var(--color-text-muted)',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            display: 'block',
          }}
        >
          {sceneTitle}
        </span>
        <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
          <button
            type="button"
            aria-expanded={addOverlayOpen}
            aria-label={addOverlayOpen ? 'Close new text overlay' : 'New text overlay'}
            onClick={onAddOverlayClick}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '28px',
              height: '28px',
              borderRadius: '6px',
              border: '1px solid var(--color-border)',
              background: 'var(--color-panel)',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            <Plus size={14} strokeWidth={2.25} />
          </button>
        </div>
      </div>

      {/* Slot list */}
      <div style={{ maxHeight: 'min(45vh, 360px)', minHeight: 0, overflowY: 'auto', padding: '4px' }}>
        {slots.length === 0 ? (
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', padding: '8px 4px' }}>
            No text in this scene yet.
          </p>
        ) : (
          <ul
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}
          >
            {slots.map((s) => {
              const isSel = selectedKey === s.key
              const line = (s.preview || '').trim() || (s.label || '').trim() || '(empty)'
              const hid = layerHiddenIdForTextSlot(s.key)
              const isHidden = hidden.has(hid)
              return (
                <li key={s.key}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectKey(isSel ? null : s.key)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      onActivateKey(s.key)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelectKey(isSel ? null : s.key)
                      }
                    }}
                    title={`${s.badge} — click to edit · double-click focuses`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '2px',
                      borderRadius: '6px',
                      padding: '2px 4px',
                      cursor: 'pointer',
                      background: isSel ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : 'transparent',
                      outline: isSel ? '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)' : 'none',
                    }}
                  >
                    <button
                      type="button"
                      aria-label={isHidden ? 'Show layer' : 'Hide layer'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleTextSlotVisibility(s.key)
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '24px',
                        height: '24px',
                        flexShrink: 0,
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-text-muted)',
                        cursor: 'pointer',
                        borderRadius: '4px',
                        padding: 0,
                      }}
                    >
                      {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <Type size={12} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} strokeWidth={2.25} />
                    <span
                      style={{
                        minWidth: 0,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '11px',
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {line}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

export default function TextTab({ scene }: Props) {
  const updateScene = useVideoStore((s) => s.updateScene)
  const saveSceneHTML = useVideoStore((s) => s.saveSceneHTML)
  const textEditorSlotKey = useVideoStore((s) => s.textEditorSlotKey)
  const setTextEditorSlotKey = useVideoStore((s) => s.setTextEditorSlotKey)
  const openTextTabForSlot = useVideoStore((s) => s.openTextTabForSlot)
  const addTextOverlay = useVideoStore((s) => s.addTextOverlay)
  const updateTextOverlay = useVideoStore((s) => s.updateTextOverlay)
  const inspectorElements = useVideoStore((s) => s.inspectorElements)
  const patchInspectorElement = useVideoStore((s) => s.patchInspectorElement)
  const selectedSceneId = useVideoStore((s) => s.selectedSceneId)

  const [slots, setSlots] = useState<TextSlot[]>([])
  useEffect(() => {
    setSlots(collectTextSlots(scene, { inspectorElements }))
  }, [scene, inspectorElements])

  const activeSlot = useMemo(
    () => (textEditorSlotKey ? slots.find((s) => s.key === textEditorSlotKey) : null),
    [slots, textEditorSlotKey],
  )

  const [draft, setDraft] = useState('')
  useEffect(() => {
    if (!textEditorSlotKey) {
      setDraft('')
      return
    }
    setDraft(getTextSlotValue(scene, textEditorSlotKey, inspectorElements))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textEditorSlotKey])

  useEffect(() => {
    if (textEditorSlotKey && slots.length > 0 && !slots.some((s) => s.key === textEditorSlotKey)) {
      setTextEditorSlotKey(null)
    }
  }, [textEditorSlotKey, slots, setTextEditorSlotKey])

  const commitDraft = useCallback(() => {
    if (!textEditorSlotKey) return
    const { patch, saveHtml, domElementId } = applyTextSlotValue(scene, textEditorSlotKey, draft)
    if (Object.keys(patch).length === 0) return
    updateScene(scene.id, patch)
    if (domElementId) {
      patchInspectorElement(domElementId, 'text', draft)
      const iframe = document.querySelector(`iframe[data-scene-id="${selectedSceneId}"]`) as HTMLIFrameElement | null
      if (iframe) {
        import('@/lib/scene-patcher').then(({ patchElementInIframe }) => {
          patchElementInIframe(iframe, domElementId, 'text', draft)
        })
      }
    }
    if (saveHtml) void saveSceneHTML(scene.id)
  }, [textEditorSlotKey, draft, scene, updateScene, saveSceneHTML, patchInspectorElement, selectedSceneId])

  const overlay =
    textEditorSlotKey?.startsWith('overlay:') === true
      ? scene.textOverlays?.find((t) => t.id === textEditorSlotKey!.slice('overlay:'.length))
      : undefined

  const chartTitleLayerId = useMemo(
    () => (textEditorSlotKey ? (parseChartTitleSlotKey(textEditorSlotKey)?.layerId ?? null) : null),
    [textEditorSlotKey],
  )

  const chartTitleLayer = useMemo(() => {
    if (!chartTitleLayerId) return null
    return deriveChartLayersFromScene(scene).find((c) => c.id === chartTitleLayerId) ?? null
  }, [scene, chartTitleLayerId])

  const patchOverlay = useCallback(
    (updates: Partial<TextOverlay>) => {
      if (!overlay) return
      const next = (scene.textOverlays ?? []).map((t) => (t.id === overlay.id ? { ...t, ...updates } : t))
      updateScene(scene.id, { textOverlays: next })
      void saveSceneHTML(scene.id)
    },
    [overlay, scene.id, scene.textOverlays, updateScene, saveSceneHTML],
  )

  const patchChartTitleConfig = useCallback(
    (configUpdates: Record<string, unknown>) => {
      const id = parseChartTitleSlotKey(textEditorSlotKey ?? '')?.layerId
      if (!id) return
      const layers = deriveChartLayersFromScene(scene)
      const next = layers.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...configUpdates } } : c))
      const compiled = compileD3SceneFromLayers(next)
      updateScene(scene.id, {
        chartLayers: next,
        sceneCode: compiled.sceneCode,
        d3Data: compiled.d3Data as Scene['d3Data'],
        sceneType: 'd3',
      })
      void saveSceneHTML(scene.id)
    },
    [textEditorSlotKey, scene, updateScene, saveSceneHTML],
  )

  const onSelectKey = useCallback(
    (key: string | null) => {
      setTextEditorSlotKey(key)
    },
    [setTextEditorSlotKey],
  )

  const onActivateKey = useCallback(
    (key: string) => {
      openTextTabForSlot(key)
    },
    [openTextTabForSlot],
  )

  const handleCreateTextOverlay = useCallback(
    (content: string) => {
      addTextOverlay(scene.id)
      const s = useVideoStore.getState().scenes.find((x) => x.id === scene.id)
      const last = s?.textOverlays?.slice(-1)[0]
      if (last) {
        const trimmed = content.trim()
        if (trimmed) updateTextOverlay(scene.id, last.id, { content: trimmed })
        void saveSceneHTML(scene.id)
        setTextEditorSlotKey(`overlay:${last.id}`)
      }
    },
    [scene.id, addTextOverlay, updateTextOverlay, saveSceneHTML, setTextEditorSlotKey],
  )

  const [addingOverlay, setAddingOverlay] = useState(false)
  const [newOverlayDraft, setNewOverlayDraft] = useState('')

  const toggleAddOverlay = useCallback(() => {
    setAddingOverlay((open) => {
      if (open) {
        setNewOverlayDraft('')
        return false
      }
      setTextEditorSlotKey(null)
      return true
    })
  }, [setTextEditorSlotKey])

  const cancelAddOverlay = useCallback(() => {
    setNewOverlayDraft('')
    setAddingOverlay(false)
  }, [])

  const submitNewOverlay = useCallback(() => {
    handleCreateTextOverlay(newOverlayDraft)
    setNewOverlayDraft('')
    setAddingOverlay(false)
  }, [handleCreateTextOverlay, newOverlayDraft])

  return (
    <div style={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column' }}>
      {/* Editor / hints — scrolls above the fixed bottom list */}
      <div style={{ minHeight: 0, flex: 1, overflowY: 'auto', padding: '12px 16px 8px' }}>
        {addingOverlay ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '10px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  Text overlay
                </div>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: 500,
                    color: 'var(--color-text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  New overlay
                </div>
              </div>
              <SettingsButton onClick={cancelAddOverlay}>Cancel</SettingsButton>
            </div>

            <div>
              <label style={labelStyle}>Content</label>
              <textarea
                value={newOverlayDraft}
                onChange={(e) => setNewOverlayDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelAddOverlay()
                  }
                }}
                rows={4}
                placeholder="What should it say?"
                autoFocus
                style={{
                  ...inputStyle,
                  resize: 'vertical',
                  minHeight: '72px',
                  fontSize: '14px',
                  lineHeight: 1.5,
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '4px',
                borderTop: '1px solid var(--color-border)',
                paddingTop: '8px',
              }}
            >
              <SettingsButton onClick={cancelAddOverlay}>Cancel</SettingsButton>
              <SettingsButton onClick={submitNewOverlay} variant="active">
                Add overlay
              </SettingsButton>
            </div>
          </div>
        ) : slots.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '8px',
              padding: '24px 0',
              textAlign: 'center',
              fontSize: '12px',
              color: 'var(--color-text-muted)',
            }}
          >
            <Type size={28} style={{ opacity: 0.4 }} strokeWidth={1.5} />
            <p style={{ margin: 0 }}>Add overlays, SVG &lt;text&gt;, chart titles, or interactions.</p>
            <p style={{ margin: 0, fontSize: '11px' }}>
              Use <span style={{ color: 'var(--color-text-primary)' }}>+</span> below to add a text overlay.
            </p>
          </div>
        ) : !textEditorSlotKey || !activeSlot ? (
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', margin: 0 }}>
            Select a row in <span style={{ color: 'var(--color-text-primary)' }}>Text</span> below, or double-click
            under <span style={{ color: 'var(--color-text-primary)' }}>Layer stack → Text in scene</span>.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '10px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {activeSlot.badge}
                </div>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: 500,
                    color: 'var(--color-text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {activeSlot.label}
                </div>
              </div>
              <SettingsButton onClick={() => setTextEditorSlotKey(null)}>Clear</SettingsButton>
            </div>

            <div>
              <label style={labelStyle}>{activeSlot.kind === 'chart' ? 'Title' : 'Content'}</label>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitDraft}
                rows={overlay || activeSlot.kind === 'chart' ? 3 : 6}
                style={{
                  ...inputStyle,
                  resize: 'vertical',
                  minHeight: '72px',
                  fontSize: '14px',
                  lineHeight: 1.5,
                }}
              />
            </div>

            {overlay && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '8px',
                  borderTop: '1px solid var(--color-border)',
                  paddingTop: '12px',
                }}
              >
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={labelStyle}>Font</label>
                  <input
                    type="text"
                    value={overlay.font}
                    onChange={(e) => patchOverlay({ font: e.target.value })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Size</label>
                  <input
                    type="number"
                    min={8}
                    max={200}
                    value={overlay.size}
                    onChange={(e) => patchOverlay({ size: parseInt(e.target.value, 10) || 48 })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Color</label>
                  <input
                    type="color"
                    value={overlay.color}
                    onChange={(e) => patchOverlay({ color: e.target.value })}
                    style={{ ...inputStyle, height: '32px', cursor: 'pointer', padding: '2px 4px' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>X %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={overlay.x}
                    onChange={(e) => patchOverlay({ x: parseFloat(e.target.value) || 0 })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Y %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={overlay.y}
                    onChange={(e) => patchOverlay({ y: parseFloat(e.target.value) || 0 })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Delay (s)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={overlay.delay}
                    onChange={(e) => patchOverlay({ delay: parseFloat(e.target.value) || 0 })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Duration (s)</label>
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={overlay.duration}
                    onChange={(e) => patchOverlay({ duration: parseFloat(e.target.value) || 0.6 })}
                    style={inputStyle}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={labelStyle}>Animation</label>
                  <select
                    value={overlay.animation}
                    onChange={(e) => patchOverlay({ animation: e.target.value as TextOverlay['animation'] })}
                    style={inputStyle}
                  >
                    <option value="fade-in">Fade in</option>
                    <option value="slide-up">Slide up</option>
                    <option value="typewriter">Typewriter</option>
                  </select>
                </div>
              </div>
            )}

            {activeSlot.kind === 'chart' && chartTitleLayer && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '8px',
                  borderTop: '1px solid var(--color-border)',
                  paddingTop: '12px',
                }}
              >
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={labelStyle}>Font family</label>
                  <input
                    type="text"
                    value={String((chartTitleLayer.config as Record<string, unknown>).fontFamily ?? '')}
                    onChange={(e) => patchChartTitleConfig({ fontFamily: e.target.value })}
                    placeholder="e.g. Inter, system-ui"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Chart font size</label>
                  <input
                    type="number"
                    min={10}
                    max={48}
                    value={
                      Number.isFinite(Number((chartTitleLayer.config as Record<string, unknown>).fontSize))
                        ? Number((chartTitleLayer.config as Record<string, unknown>).fontSize)
                        : 18
                    }
                    onChange={(e) => patchChartTitleConfig({ fontSize: parseInt(e.target.value, 10) || 18 })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Title size</label>
                  <input
                    type="number"
                    min={24}
                    max={120}
                    value={
                      Number.isFinite(Number((chartTitleLayer.config as Record<string, unknown>).titleSize))
                        ? Number((chartTitleLayer.config as Record<string, unknown>).titleSize)
                        : 64
                    }
                    onChange={(e) => patchChartTitleConfig({ titleSize: parseInt(e.target.value, 10) || 64 })}
                    style={inputStyle}
                  />
                </div>
                <p style={{ gridColumn: '1 / -1', fontSize: '10px', color: 'var(--color-text-muted)', margin: 0 }}>
                  Title size controls the chart heading; chart font size affects axis and data labels.
                </p>
              </div>
            )}

            {activeSlot.kind === 'svg_text' && (
              <p style={{ fontSize: '10px', color: 'var(--color-text-muted)', margin: 0 }}>
                SVG &lt;text&gt; — font and position stay in the SVG; edit wording here.
              </p>
            )}
          </div>
        )}
      </div>

      <AllTextStackPanel
        scene={scene}
        slots={slots}
        selectedKey={textEditorSlotKey}
        addOverlayOpen={addingOverlay}
        onAddOverlayClick={toggleAddOverlay}
        onSelectKey={(key) => {
          if (key) setAddingOverlay(false)
          onSelectKey(key)
        }}
        onActivateKey={(key) => {
          setAddingOverlay(false)
          onActivateKey(key)
        }}
        updateScene={updateScene}
      />
    </div>
  )
}
