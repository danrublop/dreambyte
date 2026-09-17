'use client'

import { v4 as uuidv4 } from 'uuid'
import type { Scene, GlobalStyle, Project, AILayer } from '../types'
import { DEFAULT_AUDIO_SETTINGS } from '../types'
import { DEFAULT_AUDIO_PROVIDER_ENABLED } from '../audio/provider-registry'
import { DEFAULT_MEDIA_PROVIDER_ENABLED } from '../media/provider-registry'
import { createDefaultAPIPermissions } from '../permissions'
import { isValidUuid } from '../utils/uuid'
import { usesRemovedLocalAvatar } from '../avatar/removed-local-avatar'
import { resolveStyle, type ResolvedStyle } from '../styles/presets'
import { deriveChartLayersFromScene } from '../charts/extract'
import { normalizeTransition } from '../transitions'
import type { UndoableState } from './types'

// ── Module-level variables ───────────────────────────────────────────────────

export const MAX_UNDO = 50

/**
 * Monotonic counter stamped onto every undo/redo entry as it is pushed onto a
 * stack. Undo/redo route between the legacy snapshot stack and the typed
 * action stack by popping whichever candidate top has the LARGER `_seq` —
 * i.e. true LIFO across both stacks, instead of always preferring the action
 * stack (which undid the wrong, older op when the two interleaved).
 * Re-stamped on every transfer (undo↔redo), so the same "largest seq
 * wins" rule serves both directions. In-memory only: the action stack isn't
 * persisted, so cross-session ordering never arises (legacy entries restored
 * without a seq sort oldest, which is correct).
 */
let _undoSeqCounter = 0
export function nextUndoSeq(): number {
  return ++_undoSeqCounter
}

export let _debouncedPushTimer: ReturnType<typeof setTimeout> | null = null
export let _hasPendingSnapshot = false
export let _inspectorSaveTimer: ReturnType<typeof setTimeout> | null = null
export let _inspectorUndoPushed = false

export function setDebouncedPushTimer(v: ReturnType<typeof setTimeout> | null) {
  _debouncedPushTimer = v
}

export function setHasPendingSnapshot(v: boolean) {
  _hasPendingSnapshot = v
}

export function setInspectorSaveTimer(v: ReturnType<typeof setTimeout> | null) {
  _inspectorSaveTimer = v
}

export function setInspectorUndoPushed(v: boolean) {
  _inspectorUndoPushed = v
}

// ── Helper functions ─────────────────────────────────────────────────────────

/** Resolve the globalStyle into concrete values for API calls */
export function getResolvedStyle(gs: GlobalStyle): ResolvedStyle {
  return resolveStyle(gs.presetId, gs)
}

export function aiLayerHasRenderableOrPending(layer: AILayer): boolean {
  if (
    layer.status === 'pending' ||
    layer.status === 'generating' ||
    layer.status === 'processing' ||
    layer.status === 'removing-bg'
  )
    return true
  switch (layer.type) {
    case 'veo3':
      return !!(layer.videoUrl || layer.operationName)
    case 'avatar':
      return !!(layer.videoUrl || layer.heygenVideoId || usesRemovedLocalAvatar(layer))
    case 'image':
      return !!layer.imageUrl
    case 'sticker':
      return !!(layer.imageUrl || layer.stickerUrl)
    default:
      return false
  }
}

/** Code, HTML, video layer, or AI media (including in-flight generation). */
export function sceneHasRenderableContent(s: Scene): boolean {
  if (s.svgContent || s.canvasCode || s.sceneCode || s.reactCode || s.lottieSource) return true
  if (s.canvasBackgroundCode?.trim()) return true
  if (s.sceneHTML && s.sceneHTML.trim().length > 0) return true
  if (s.videoLayer?.enabled && s.videoLayer.src) return true
  const layers = s.aiLayers ?? []
  if (layers.length > 0 && layers.some(aiLayerHasRenderableOrPending)) return true
  return false
}

/**
 * A truly empty agent shell (#5): a scene with NOTHING a user would miss — no
 * renderable code, no audio bed, no text/SVG overlays, no prompt, no chat
 * messages. This is a `create_scene` placeholder that never received content.
 *
 * Used at the PERSIST boundary to drop NEW shells (a codeless scene otherwise
 * persists and serves a dreambyte:// 404 "Not found" on reload). It is
 * deliberately CONSERVATIVE — stricter than `sceneHasRenderableContent` alone
 * (which ignores audio/overlays/svgObjects) so an audio-bed-only or overlay-
 * only scene is NEVER mistaken for empty. Combined with the persist-side
 * `hasContentScene` guard, the set this drops is a strict SUBSET of what the
 * renderer drops on sync (src/lib/store/agent-actions.ts), so persist can never
 * drop a scene the renderer keeps. (Not literally the renderer's predicate —
 * the renderer's keep-logic carries extra merge structure — but a guaranteed
 * subset, which is what avoids divergence + data loss.)
 */
export function isEmptyAgentShell(s: Scene): boolean {
  if (sceneHasRenderableContent(s)) return false
  if (s.audioLayer?.enabled && s.audioLayer.src) return false
  if (s.textOverlays && s.textOverlays.length > 0) return false
  if (s.svgObjects && s.svgObjects.length > 0) return false
  if (s.prompt && s.prompt.trim().length > 0) return false
  if (s.messages && s.messages.length > 0) return false
  return true
}

export function normalizeScene(scene: Scene): Scene {
  const derivedChartLayers = deriveChartLayersFromScene(scene)
  // Strip transient build flags — they're runtime-only UI hints set by the
  // agent runner during incremental scene generation. Typed as optional on
  // the Scene interface (see src/lib/types/scene.ts) so we can destructure
  // without `as any`; the destructured names are referenced (`void`) to
  // keep eslint quiet about unused locals.
  const { _building, _buildPhase, ...cleanScene } = scene
  void _building
  void _buildPhase
  return {
    ...cleanScene,
    canvasBackgroundCode: cleanScene.canvasBackgroundCode ?? '',
    chartLayers: derivedChartLayers,
    transition: normalizeTransition(cleanScene.transition),
  }
}

/** Read the persisted editor theme from its dedicated localStorage key. */
export function getPersistedTheme(): 'dark' | 'light' | 'blue' {
  if (typeof window === 'undefined') return 'dark'
  const v = localStorage.getItem('dreambyte-editor-theme')
  if (v === 'light' || v === 'blue') return v
  return 'dark'
}

/** Write the editor theme to its dedicated localStorage key. */
export function setPersistedTheme(theme: 'dark' | 'light' | 'blue') {
  if (typeof window !== 'undefined') localStorage.setItem('dreambyte-editor-theme', theme)
}

export const DEFAULT_GLOBAL_STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
  theme: typeof window !== 'undefined' ? getPersistedTheme() : 'dark',
  uiTypography: 'app',
  uiFontFamily: null,
}

/**
 * Reconcile the persisted `project.id` with the persisted `activeProjectId` at
 * hydration. The store persists both separately and they drift: older builds
 * left `project.id: ''`, and an earlier heal then wrote a fresh default uuid —
 * either way `project.id` ends up pointing at something that isn't the project
 * `loadProject(activeProjectId)` will actually hydrate on boot. The persist
 * `merge` ({ ...current, ...persisted }) makes whatever is in localStorage
 * sticky, so the drift re-persists and trips project IPCs (getVersion → invalid
 * UUID; branches.list → NotFound) every boot.
 *
 * `activeProjectId` is the authoritative pointer, so make `project.id` track it:
 * when activeProjectId is a valid uuid, the project object carries that id
 * (already-matching projects pass through untouched). With no usable
 * activeProjectId, keep a valid persisted project, else fall back to the fresh
 * default (which has its own real uuid).
 */
export function ensureValidProjectId(
  project: Project | null | undefined,
  fallback: Project,
  activeProjectId?: string | null,
): Project {
  if (isValidUuid(activeProjectId)) {
    if (project && project.id === activeProjectId) return project
    return { ...(project ?? fallback), id: activeProjectId }
  }
  return isValidUuid(project?.id) ? (project as Project) : fallback
}

export function createDefaultProject(scenes: Scene[] = []): Project {
  const now = new Date().toISOString()
  const startSceneId = scenes[0]?.id ?? ''
  return {
    id: uuidv4(),
    name: 'Untitled Project',
    outputMode: 'mp4',
    createdAt: now,
    updatedAt: now,
    mp4Settings: { resolution: '1080p', fps: 30, format: 'mp4', aspectRatio: '16:9' as const },
    interactiveSettings: {
      playerTheme: 'dark',
      showProgressBar: true,
      showSceneNav: true,
      allowFullscreen: true,
      brandColor: '#e84545',
      customDomain: null,
      password: null,
    },
    sceneGraph: {
      nodes: scenes.map((s, i) => ({ id: s.id, position: { x: i * 220, y: 100 } })),
      edges: scenes.slice(0, -1).map((s, i) => ({
        id: uuidv4(),
        fromSceneId: s.id,
        toSceneId: scenes[i + 1].id,
        condition: { type: 'auto', interactionId: null, variableName: null, variableValue: null },
      })),
      startSceneId,
    },
    apiPermissions: createDefaultAPIPermissions(),
    audioSettings: DEFAULT_AUDIO_SETTINGS,
    audioProviderEnabled: { ...DEFAULT_AUDIO_PROVIDER_ENABLED },
    mediaGenEnabled: { ...DEFAULT_MEDIA_PROVIDER_ENABLED },
    watermark: null,
    brandKit: null,
    pausedAgentRun: null,
  }
}

export function createDefaultScene(prompt = ''): Scene {
  return {
    id: uuidv4(),
    name: '',
    prompt,
    summary: '',
    svgContent: '',
    duration: 8,
    bgColor: '#ffffff',
    thumbnail: null,
    videoLayer: {
      enabled: false,
      src: null,
      opacity: 1,
      trimStart: 0,
      trimEnd: null,
    },
    audioLayer: {
      enabled: false,
      src: null,
      volume: 1,
      fadeIn: false,
      fadeOut: false,
      startOffset: 0,
    },
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: 'none',
    usage: null,
    sceneType: 'react',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: '',
    threeEnvironmentPresetId: null,
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    chartLayers: [],
    interactions: [],
    variables: [],
    aiLayers: [],
    messages: [],
    styleOverride: {},
    cameraMotion: null,
    elementOverrides: {},
    worldConfig: null,
    layerHiddenIds: [],
    layerPanelOrder: undefined,
  }
}
