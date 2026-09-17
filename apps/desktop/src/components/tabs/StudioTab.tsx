'use client'

import { useCallback, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import type { Scene } from '@/lib/types'
import type { SceneStylePresetName } from '@/lib/types'
import { ASPECT_RATIO_OPTIONS, resolveProjectDimensions } from '@/lib/dimensions'
import { SettingsButton } from '@/components/settings/GeneralSettingsTab'
import FontPicker from '@/components/FontPicker'
import { STYLE_PRESETS, type StylePresetId } from '@/lib/styles/presets'
import { SCENE_STYLE_PRESETS } from '@/lib/styles/scene-presets'
import StylePresetPicker from '@/components/StylePresetPicker'
import BrandKitPanel from '@/components/brand/BrandKitPanel'

// ── Primitives ─────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: '11px',
        fontWeight: 500,
        color: 'var(--color-text-muted)',
        letterSpacing: '0.048px',
        textTransform: 'uppercase',
        margin: '20px 0 4px',
      }}
    >
      {children}
    </p>
  )
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '24px',
        padding: '10px 0',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{label}</p>
        {description && (
          <p
            style={{
              fontSize: '11px',
              fontWeight: 500,
              color: 'var(--color-text-muted)',
              margin: '2px 0 0',
              lineHeight: 1.3,
              letterSpacing: '0.048px',
            }}
          >
            {description}
          </p>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  scene: Scene
}

export default function StudioTab({ scene }: Props) {
  const {
    project,
    updateScene,
    saveSceneHTML,
    updateProject,
    globalStyle,
    updateGlobalStyle,
    gridConfig,
    updateGridConfig,
  } = useVideoStore()

  const [advancedOpen, setAdvancedOpen] = useState(false)

  const commit = useCallback(() => void saveSceneHTML(scene.id), [scene.id, saveSceneHTML])

  const dims = resolveProjectDimensions(project.mp4Settings?.aspectRatio, project.mp4Settings?.resolution)
  const aspectRatio = project.mp4Settings?.aspectRatio ?? '16:9'
  const duration = scene.duration ?? 8

  const hasSceneOverride = Object.keys(scene.styleOverride ?? {}).length > 0

  return (
    <div style={{ padding: '0 12px 24px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {/* ── Scene ── */}
      <SectionHeader>Scene</SectionHeader>

      <SettingRow label="Name">
        <input
          type="text"
          placeholder="Untitled scene"
          value={scene.name}
          onChange={(e) => updateScene(scene.id, { name: e.target.value })}
          onBlur={commit}
          style={{
            padding: '4px 8px',
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            background: 'var(--color-input-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            outline: 'none',
            width: '140px',
          }}
        />
      </SettingRow>

      <SettingRow label="Duration" description={`${duration}s`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="range"
            min={2}
            max={30}
            step={1}
            value={duration}
            onChange={(e) => updateScene(scene.id, { duration: parseInt(e.target.value) })}
            onMouseUp={commit}
            style={{ width: '96px', accentColor: 'var(--color-accent)' }}
          />
          <span
            style={{
              fontSize: '12px',
              fontFamily: 'monospace',
              color: 'var(--color-text-muted)',
              width: '28px',
              textAlign: 'right',
            }}
          >
            {duration}s
          </span>
        </div>
      </SettingRow>

      <SettingRow label="Background">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
            <div
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                background: scene.bgColor,
                overflow: 'hidden',
              }}
            />
            <input
              type="color"
              value={scene.bgColor}
              onChange={(e) => updateScene(scene.id, { bgColor: e.target.value })}
              onBlur={commit}
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
            />
          </label>
          <input
            type="text"
            value={scene.bgColor}
            onChange={(e) => {
              if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) updateScene(scene.id, { bgColor: e.target.value })
            }}
            onBlur={commit}
            style={{
              padding: '4px 8px',
              fontSize: '12px',
              fontFamily: 'monospace',
              color: 'var(--color-text-primary)',
              background: 'var(--color-input-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              outline: 'none',
              width: '80px',
            }}
          />
        </div>
      </SettingRow>

      {/* ── Canvas ── */}
      <SectionHeader>Canvas</SectionHeader>

      <SettingRow label="Aspect ratio" description={`${dims.width} × ${dims.height}`}>
        <div style={{ display: 'flex', gap: '4px' }}>
          {ASPECT_RATIO_OPTIONS.map((opt) => (
            <SettingsButton
              key={opt.value}
              onClick={() => updateProject({ mp4Settings: { ...project.mp4Settings, aspectRatio: opt.value } })}
              variant={aspectRatio === opt.value ? 'active' : 'default'}
            >
              {opt.label}
            </SettingsButton>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="Snapping" description="Snap layers to grid and elements">
        <SettingsButton
          onClick={() => updateGridConfig({ enabled: !gridConfig.enabled })}
          variant={gridConfig.enabled ? 'active' : 'default'}
        >
          {gridConfig.enabled ? 'On' : 'Off'}
        </SettingsButton>
      </SettingRow>

      {gridConfig.enabled && (
        <SettingRow label="Grid size">
          <div style={{ display: 'flex', gap: '4px' }}>
            {([20, 40, 80] as const).map((size) => (
              <SettingsButton
                key={size}
                onClick={() => updateGridConfig({ size })}
                variant={gridConfig.size === size ? 'active' : 'default'}
              >
                {size}
              </SettingsButton>
            ))}
          </div>
        </SettingRow>
      )}

      {gridConfig.enabled && (
        <SettingRow label="Show grid overlay" description="Toggle with G">
          <SettingsButton
            onClick={() => updateGridConfig({ showGrid: !gridConfig.showGrid })}
            variant={gridConfig.showGrid ? 'active' : 'default'}
          >
            {gridConfig.showGrid ? 'On' : 'Off'}
          </SettingsButton>
        </SettingRow>
      )}

      {gridConfig.enabled && (
        <SettingRow label="Snap to elements">
          <SettingsButton
            onClick={() => updateGridConfig({ snapToElements: !gridConfig.snapToElements })}
            variant={gridConfig.snapToElements ? 'active' : 'default'}
          >
            {gridConfig.snapToElements ? 'On' : 'Off'}
          </SettingsButton>
        </SettingRow>
      )}

      {/* ── Style ── */}
      <SectionHeader>Style</SectionHeader>

      <SettingRow label="Font">
        <FontPicker
          value={globalStyle.fontOverride ?? null}
          presetFont={
            globalStyle.presetId && STYLE_PRESETS[globalStyle.presetId as StylePresetId]
              ? STYLE_PRESETS[globalStyle.presetId as StylePresetId].font
              : null
          }
          onChange={(family) => updateGlobalStyle({ fontOverride: family })}
          hidePresetOption
          hideOverrideHint
        />
      </SettingRow>

      <div style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
        <StylePresetPicker
          currentPresetId={globalStyle.presetId}
          onChange={(id) =>
            updateGlobalStyle({
              presetId: id,
              paletteOverride: null,
              bgColorOverride: null,
              fontOverride: null,
              strokeColorOverride: null,
            })
          }
        />
      </div>

      {/* Advanced toggle row */}
      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '10px 0',
          borderBottom: advancedOpen ? 'none' : '1px solid var(--color-border)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-text-muted)',
        }}
      >
        <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)' }}>Advanced</span>
        <ChevronRight
          size={14}
          style={{
            color: 'var(--color-text-muted)',
            transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
          }}
        />
      </button>

      {advancedOpen && (
        <div style={{ paddingBottom: '8px', borderBottom: '1px solid var(--color-border)' }}>
          {/* Palette override */}
          <div style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>
                Palette override
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {[0, 1, 2, 3].map((i) => {
                  const presetPalette = globalStyle.presetId
                    ? STYLE_PRESETS[globalStyle.presetId as StylePresetId]?.palette
                    : (['#374151', '#6b7280', '#9ca3af', '#d1d5db'] as [string, string, string, string])
                  return (
                    <label key={i} style={{ position: 'relative', cursor: 'pointer' }}>
                      <div
                        style={{
                          width: '22px',
                          height: '22px',
                          borderRadius: '4px',
                          border: '1px solid var(--color-border)',
                          background: globalStyle.paletteOverride?.[i] ?? presetPalette?.[i] ?? '#000',
                          overflow: 'hidden',
                        }}
                      />
                      <input
                        type="color"
                        aria-label={`Palette color ${i + 1}`}
                        value={globalStyle.paletteOverride?.[i] ?? presetPalette?.[i] ?? '#000000'}
                        onChange={(e) => {
                          const current =
                            globalStyle.paletteOverride ??
                            ([...(presetPalette ?? ['#000000', '#000000', '#000000', '#000000'])] as [
                              string,
                              string,
                              string,
                              string,
                            ])
                          const updated = [...current] as [string, string, string, string]
                          updated[i] = e.target.value
                          updateGlobalStyle({ paletteOverride: updated })
                        }}
                        style={{
                          position: 'absolute',
                          inset: 0,
                          opacity: 0,
                          cursor: 'pointer',
                          width: '100%',
                          height: '100%',
                        }}
                      />
                    </label>
                  )
                })}
                {globalStyle.paletteOverride && (
                  <button
                    type="button"
                    onClick={() => updateGlobalStyle({ paletteOverride: null })}
                    style={{
                      fontSize: '11px',
                      color: 'var(--color-accent)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '0 4px',
                    }}
                  >
                    reset
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Background override */}
          <div style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>
                Bg override
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <label style={{ position: 'relative', cursor: 'pointer' }}>
                  <div
                    style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '4px',
                      border: '1px solid var(--color-border)',
                      background: globalStyle.bgColorOverride ?? 'transparent',
                      overflow: 'hidden',
                    }}
                  />
                  <input
                    type="color"
                    aria-label="Background color override"
                    value={globalStyle.bgColorOverride ?? '#ffffff'}
                    onChange={(e) => updateGlobalStyle({ bgColorOverride: e.target.value })}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      opacity: 0,
                      cursor: 'pointer',
                      width: '100%',
                      height: '100%',
                    }}
                  />
                </label>
                {globalStyle.bgColorOverride && (
                  <button
                    type="button"
                    onClick={() => updateGlobalStyle({ bgColorOverride: null })}
                    style={{
                      fontSize: '11px',
                      color: 'var(--color-accent)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '0 4px',
                    }}
                  >
                    reset
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Scene-level style override */}
          <div style={{ padding: '10px 0' }}>
            <p
              style={{
                fontSize: '11px',
                fontWeight: 500,
                color: 'var(--color-text-muted)',
                letterSpacing: '0.048px',
                textTransform: 'uppercase',
                margin: '0 0 8px',
              }}
            >
              This scene
            </p>
            {!hasSceneOverride ? (
              <div>
                <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', margin: '0 0 8px' }}>
                  Inheriting from project style
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                  {(Object.keys(SCENE_STYLE_PRESETS) as SceneStylePresetName[]).map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        updateScene(scene.id, { styleOverride: SCENE_STYLE_PRESETS[name] })
                        commit()
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 8px',
                        fontSize: '11px',
                        fontWeight: 500,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        border: '1px solid var(--color-border)',
                        background: 'var(--color-panel)',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      <div style={{ display: 'flex', gap: '2px' }}>
                        {SCENE_STYLE_PRESETS[name].palette?.map((c, i) => (
                          <div key={i} style={{ width: '8px', height: '8px', borderRadius: '50%', background: c }} />
                        ))}
                      </div>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {(scene.styleOverride?.palette ?? []).map((c, i) => (
                      <div
                        key={i}
                        style={{
                          width: '16px',
                          height: '16px',
                          borderRadius: '3px',
                          border: '1px solid var(--color-border)',
                          background: c,
                        }}
                      />
                    ))}
                  </div>
                  {scene.styleOverride?.bgColor && (
                    <div
                      style={{
                        width: '16px',
                        height: '16px',
                        borderRadius: '3px',
                        border: '1px solid var(--color-border)',
                        background: scene.styleOverride.bgColor,
                      }}
                      title="Background"
                    />
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '8px' }}>
                  {(Object.keys(SCENE_STYLE_PRESETS) as SceneStylePresetName[]).map((name) => {
                    const isActive =
                      JSON.stringify(scene.styleOverride?.palette) === JSON.stringify(SCENE_STYLE_PRESETS[name].palette)
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => {
                          updateScene(scene.id, { styleOverride: SCENE_STYLE_PRESETS[name] })
                          commit()
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 8px',
                          fontSize: '11px',
                          fontWeight: 500,
                          borderRadius: '8px',
                          cursor: 'pointer',
                          border: '1px solid',
                          borderColor: isActive
                            ? 'color-mix(in srgb, var(--color-accent) 45%, transparent)'
                            : 'var(--color-border)',
                          background: isActive
                            ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
                            : 'var(--color-panel)',
                          color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)',
                        }}
                      >
                        <div style={{ display: 'flex', gap: '2px' }}>
                          {SCENE_STYLE_PRESETS[name].palette?.map((c, i) => (
                            <div key={i} style={{ width: '8px', height: '8px', borderRadius: '50%', background: c }} />
                          ))}
                        </div>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {name}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    updateScene(scene.id, { styleOverride: {} })
                    commit()
                  }}
                  style={{
                    fontSize: '11px',
                    color: 'var(--color-accent)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  Clear — inherit from project
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Brand Kit ── */}
      <SectionHeader>Brand Kit</SectionHeader>
      <div style={{ paddingTop: '4px' }}>
        <BrandKitPanel />
      </div>
    </div>
  )
}
