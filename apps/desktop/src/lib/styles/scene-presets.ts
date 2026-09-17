/**
 * Named scene-level style presets and style resolution.
 * These can be applied per-scene to override the project's global style.
 */

import type { SceneStyleOverride, SceneStylePresetName } from '../types'
import type { GlobalStyle } from '../types'
import { resolveStyle, type StylePresetId, type ResolvedStyle } from './presets'

/** Named scene style presets for narrative contrast */
export const SCENE_STYLE_PRESETS: Record<SceneStylePresetName, SceneStyleOverride> = {
  before: {
    palette: ['#6b7280', '#9ca3af', '#d1d5db', '#f3f4f6'],
    bgColor: '#f8f9fa',
  },
  after: {
    palette: ['#16a34a', '#22c55e', '#86efac', '#1a1a2e'],
    bgColor: '#f0fdf4',
  },
  warning: {
    palette: ['#dc2626', '#f59e0b', '#1a1a2e', '#f3f4f6'],
    bgColor: '#fff7ed',
  },
  highlight: {
    palette: ['#7c3aed', '#a855f7', '#f0ece0', '#1a1a2e'],
    bgColor: '#faf5ff',
  },
  chalkboard: {
    palette: ['#fffef9', '#86efac', '#fbbf24', '#f87171'],
    bgColor: '#2d4a3e',
    defaultTool: 'chalk',
    textureStyle: 'chalk',
  },
  blueprint: {
    palette: ['#fffef9', '#93c5fd', '#60a5fa', '#bfdbfe'],
    bgColor: '#1e3a5f',
    defaultTool: 'pen',
  },
  newspaper: {
    palette: ['#1a1a1a', '#404040', '#737373', '#d4d4d4'],
    bgColor: '#f5f0e0',
    font: 'Georgia',
    defaultTool: 'pen',
  },
  neon: {
    palette: ['#f0ece0', '#00ff88', '#ff0080', '#00cfff'],
    bgColor: '#0a0a0f',
  },
}

/**
 * Resolve the effective style for a scene by merging
 * scene-level overrides on top of the global style.
 */
export function resolveSceneStyle(sceneOverride: SceneStyleOverride, globalStyle: GlobalStyle): ResolvedStyle {
  const base = resolveStyle(globalStyle.presetId, globalStyle)

  return {
    ...base,
    palette: sceneOverride.palette ?? base.palette,
    bgColor: sceneOverride.bgColor ?? base.bgColor,
    font: sceneOverride.font ?? base.font,
    bodyFont: sceneOverride.bodyFont ?? base.bodyFont,
    roughnessLevel: sceneOverride.roughnessLevel ?? base.roughnessLevel,
    defaultTool: (sceneOverride.defaultTool as ResolvedStyle['defaultTool']) ?? base.defaultTool,
    textureStyle: (sceneOverride.textureStyle as ResolvedStyle['textureStyle']) ?? base.textureStyle,
    textureIntensity: sceneOverride.textureIntensity ?? base.textureIntensity,
    textureBlendMode: (sceneOverride.textureBlendMode as ResolvedStyle['textureBlendMode']) ?? base.textureBlendMode,
    bgStyle: (sceneOverride.bgStyle as ResolvedStyle['bgStyle']) ?? base.bgStyle,
    axisColor: sceneOverride.axisColor ?? base.axisColor,
    gridColor: sceneOverride.gridColor ?? base.gridColor,
    strokeColor: sceneOverride.strokeColorOverride ?? base.strokeColor,
  }
}
