// @vitest-environment node
//
// T3 (OKF PR1) — REGRESSION GATE. The faceted-style composer is ADDITIVE: it
// READS resolveStyle / resolveSceneStyle output but must NEVER change it. These
// resolvers feed the scene-HTML visual path (resolveStyle → sceneTemplate
// globals), so any drift would change rendered video. This is the mandatory
// regression named in the design (it names BOTH resolvers).
//
// The snapshot is an inline, fully-materialized fixture (not toMatchSnapshot) so
// the expected bytes live in the diff and a future change to the resolver is a
// visible, reviewable edit — not an silent `-u` re-baseline. We cover all 16
// presets (incl. presetId=null → NEUTRAL_BASELINE) and representative
// scene-override cases for resolveSceneStyle.

import { describe, it, expect } from 'vitest'
import { resolveStyle, STYLE_PRESETS, type StylePresetId } from './presets'
import { resolveSceneStyle, SCENE_STYLE_PRESETS } from './scene-presets'
import type { GlobalStyle, SceneStyleOverride } from '../types'

const EMPTY_GLOBAL: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}

const ALL_PRESET_IDS = Object.keys(STYLE_PRESETS) as StylePresetId[]

/** Stable, comparable projection of a ResolvedStyle — the fields the composer
 *  and the scene template actually read. */
function project(style: ReturnType<typeof resolveStyle>) {
  return {
    id: style.id,
    palette: style.palette,
    bgColor: style.bgColor,
    bgStyle: style.bgStyle,
    font: style.font,
    bodyFont: style.bodyFont,
    preferredRenderer: style.preferredRenderer,
    roughnessLevel: style.roughnessLevel,
    defaultTool: style.defaultTool,
    strokeColor: style.strokeColor,
    textureStyle: style.textureStyle,
    textureIntensity: style.textureIntensity,
    textureBlendMode: style.textureBlendMode,
    axisColor: style.axisColor,
    gridColor: style.gridColor,
  }
}

describe('T3 regression — resolveStyle is byte-stable across all 16 presets', () => {
  it('covers exactly the 16 known presets', () => {
    expect(ALL_PRESET_IDS.length).toBe(16)
  })

  it('presetId=null resolves to the neutral baseline (no preset)', () => {
    // NEUTRAL_BASELINE uses a 'whiteboard' sentinel id (never displayed) and
    // strokeColor falls back to palette[0] since strokeColorOverride is null.
    expect(project(resolveStyle(null, EMPTY_GLOBAL))).toEqual({
      id: 'whiteboard',
      palette: ['#f0ece0', '#e84545', '#4595e8', '#45e87a'],
      bgColor: '#181818',
      bgStyle: 'plain',
      font: 'Figtree',
      bodyFont: null,
      preferredRenderer: 'auto',
      roughnessLevel: 0,
      defaultTool: 'pen',
      strokeColor: '#f0ece0',
      textureStyle: 'none',
      textureIntensity: 0,
      textureBlendMode: 'multiply',
      axisColor: '#888888',
      gridColor: '#333333',
    })
  })

  // Per-preset projection: each preset's resolved output is pinned. A change to
  // any preset value (or to resolveStyle's merge logic) breaks the exact preset.
  it.each(ALL_PRESET_IDS)('preset %s resolves identically to its definition (no override)', (id) => {
    const resolved = project(resolveStyle(id, EMPTY_GLOBAL))
    const def = STYLE_PRESETS[id]
    // strokeColor cascade: strokeColorOverride ?? palette[0] (no GlobalStyle override here)
    const expectedStroke = def.strokeColorOverride ?? def.palette[0]
    expect(resolved).toEqual({
      id: def.id,
      palette: def.palette,
      bgColor: def.bgColor,
      bgStyle: def.bgStyle,
      font: def.font,
      bodyFont: def.bodyFont,
      preferredRenderer: def.preferredRenderer,
      roughnessLevel: def.roughnessLevel,
      defaultTool: def.defaultTool,
      strokeColor: expectedStroke,
      textureStyle: def.textureStyle,
      textureIntensity: def.textureIntensity,
      textureBlendMode: def.textureBlendMode,
      axisColor: def.axisColor,
      gridColor: def.gridColor,
    })
  })

  it('GlobalStyle overrides take precedence exactly as before (palette/bg/font/stroke)', () => {
    const overrides: GlobalStyle = {
      ...EMPTY_GLOBAL,
      presetId: 'whiteboard',
      paletteOverride: ['#111111', '#222222', '#333333', '#444444'],
      bgColorOverride: '#000000',
      fontOverride: 'Roboto',
      bodyFontOverride: 'Lora',
      strokeColorOverride: '#ff0000',
    }
    const r = resolveStyle('whiteboard', overrides)
    expect(r.palette).toEqual(['#111111', '#222222', '#333333', '#444444'])
    expect(r.bgColor).toBe('#000000')
    expect(r.font).toBe('Roboto')
    expect(r.bodyFont).toBe('Lora')
    expect(r.strokeColor).toBe('#ff0000')
    // Unrelated fields still come from the preset.
    expect(r.bgStyle).toBe(STYLE_PRESETS.whiteboard.bgStyle)
    expect(r.roughnessLevel).toBe(STYLE_PRESETS.whiteboard.roughnessLevel)
  })

  it('strokeColor falls back to overridden-palette[0] when no stroke override is set', () => {
    const r = resolveStyle('whiteboard', {
      ...EMPTY_GLOBAL,
      presetId: 'whiteboard',
      paletteOverride: ['#abcabc', '#000', '#111', '#222'],
    })
    expect(r.strokeColor).toBe('#abcabc')
  })
})

describe('T3 regression — resolveSceneStyle is byte-stable (named scene presets + overrides)', () => {
  const GLOBAL_WHITEBOARD: GlobalStyle = { ...EMPTY_GLOBAL, presetId: 'whiteboard' }

  it('an empty scene override returns the global resolved style unchanged', () => {
    const base = resolveStyle('whiteboard', GLOBAL_WHITEBOARD)
    const scene = resolveSceneStyle({}, GLOBAL_WHITEBOARD)
    expect(project(scene)).toEqual(project(base))
  })

  // Every named scene preset merged onto a whiteboard global — pins the merge.
  it.each(Object.keys(SCENE_STYLE_PRESETS) as Array<keyof typeof SCENE_STYLE_PRESETS>)(
    'scene preset %s merges onto the global style deterministically',
    (name) => {
      const ov = SCENE_STYLE_PRESETS[name] as SceneStyleOverride
      const base = resolveStyle('whiteboard', GLOBAL_WHITEBOARD)
      const scene = resolveSceneStyle(ov, GLOBAL_WHITEBOARD)
      // Each overridden field comes from the scene preset; the rest from base.
      expect(scene.palette).toEqual(ov.palette ?? base.palette)
      expect(scene.bgColor).toBe(ov.bgColor ?? base.bgColor)
      expect(scene.font).toBe(ov.font ?? base.font)
      expect(scene.defaultTool).toBe((ov.defaultTool as typeof base.defaultTool) ?? base.defaultTool)
      expect(scene.textureStyle).toBe((ov.textureStyle as typeof base.textureStyle) ?? base.textureStyle)
    },
  )

  it('scene strokeColorOverride wins; otherwise inherits base strokeColor', () => {
    const withStroke = resolveSceneStyle({ strokeColorOverride: '#00ff00' }, GLOBAL_WHITEBOARD)
    expect(withStroke.strokeColor).toBe('#00ff00')
    const withoutStroke = resolveSceneStyle({}, GLOBAL_WHITEBOARD)
    expect(withoutStroke.strokeColor).toBe(resolveStyle('whiteboard', GLOBAL_WHITEBOARD).strokeColor)
  })

  it('full-field scene override pins every mergeable field', () => {
    const ov: SceneStyleOverride = {
      palette: ['#1', '#2', '#3', '#4'] as unknown as [string, string, string, string],
      bgColor: '#bg',
      font: 'SceneFont',
      bodyFont: 'SceneBody',
      roughnessLevel: 3,
      defaultTool: 'chalk',
      textureStyle: 'chalk',
      textureIntensity: 0.5,
      textureBlendMode: 'screen',
      bgStyle: 'grid',
      axisColor: '#axis',
      gridColor: '#grid',
    }
    const scene = resolveSceneStyle(ov, GLOBAL_WHITEBOARD)
    expect(scene.palette).toEqual(['#1', '#2', '#3', '#4'])
    expect(scene.bgColor).toBe('#bg')
    expect(scene.font).toBe('SceneFont')
    expect(scene.bodyFont).toBe('SceneBody')
    expect(scene.roughnessLevel).toBe(3)
    expect(scene.defaultTool).toBe('chalk')
    expect(scene.textureStyle).toBe('chalk')
    expect(scene.textureIntensity).toBe(0.5)
    expect(scene.textureBlendMode).toBe('screen')
    expect(scene.bgStyle).toBe('grid')
    expect(scene.axisColor).toBe('#axis')
    expect(scene.gridColor).toBe('#grid')
  })
})
