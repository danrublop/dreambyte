/**
 * Camera / Audio / Style reducers.
 *
 * Three small reducer families sharing one file because they all do the
 * same shape — patch a single scene-level (or project-level) field with
 * an explicit prior-snapshot inverse.
 */

import type {
  ActionResult,
  ProjectState,
  CameraSetMotionAction,
  AudioSetLayerAction,
  AudioSetMasterVolumeAction,
  StyleSetSceneOverrideAction,
  StyleSetGlobalAction,
} from '../types'
import type { Scene } from '@/lib/types'
import { DEFAULT_AUDIO_SETTINGS } from '@/lib/types/audio'
import { MAX_STAGE_GAIN } from '@/lib/audio/mix-math'
import { validateId, validateExists } from '../validators/_shared'

function applyToScene(state: ProjectState, sceneId: string, fn: (scene: Scene) => Scene): ProjectState {
  return {
    ...state,
    scenes: state.scenes.map((s) => (s.id === sceneId ? { ...fn(s), updatedAt: Date.now() } : s)),
    project: { ...state.project, updatedAt: new Date().toISOString() },
  }
}

// ── camera/setMotion ───────────────────────────────────────────────────────

export function reduceCameraSetMotion(state: ProjectState, action: CameraSetMotionAction): ActionResult {
  const { sceneId, motion } = action.params
  const idErr = validateId(sceneId, 'sceneId')
  if (idErr) return { success: false, error: idErr }
  const existsErr = validateExists(state, sceneId, 'scene')
  if (existsErr) return { success: false, error: existsErr }

  const scene = state.scenes.find((s) => s.id === sceneId)!
  const priorMotion = scene.cameraMotion

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, cameraMotion: motion })),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'camera/setMotion',
      params: { sceneId, motion: priorMotion, prior: motion },
    },
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}

// ── audio/setLayer ─────────────────────────────────────────────────────────

export function reduceAudioSetLayer(state: ProjectState, action: AudioSetLayerAction): ActionResult {
  const { sceneId, patch } = action.params
  const idErr = validateId(sceneId, 'sceneId')
  if (idErr) return { success: false, error: idErr }
  const existsErr = validateExists(state, sceneId, 'scene')
  if (existsErr) return { success: false, error: existsErr }

  const scene = state.scenes.find((s) => s.id === sceneId)!
  // Capture prior values for the keys this patch will touch — only those.
  const prior: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) {
    prior[k] = (scene.audioLayer as unknown as Record<string, unknown>)[k]
  }

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, audioLayer: { ...s.audioLayer, ...patch } })),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'audio/setLayer',
      params: { sceneId, patch: prior as typeof action.params.patch, prior: patch },
    },
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}

// ── audio/setMasterVolume ──────────────────────────────────────────────────

/**
 * Program master gain. Surgically merges `masterVolume` into
 * `project.audioSettings` (other settings preserved), clamped to the 0..2 stage
 * range. The mixer's Master fader and the agent's set_master_volume both go
 * through here so they can't drift.
 */
export function reduceAudioSetMasterVolume(state: ProjectState, action: AudioSetMasterVolumeAction): ActionResult {
  const v = action.params.volume
  const masterVolume = !Number.isFinite(v) ? 1 : Math.max(0, Math.min(MAX_STAGE_GAIN, v))
  const priorVolume = state.project.audioSettings?.masterVolume ?? 1
  return {
    success: true,
    state: {
      ...state,
      project: {
        ...state.project,
        audioSettings: { ...(state.project.audioSettings ?? DEFAULT_AUDIO_SETTINGS), masterVolume },
        updatedAt: new Date().toISOString(),
      },
    },
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'audio/setMasterVolume',
      params: { volume: priorVolume, prior: { volume: masterVolume } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

// ── style/setSceneOverride ─────────────────────────────────────────────────

export function reduceStyleSetSceneOverride(state: ProjectState, action: StyleSetSceneOverrideAction): ActionResult {
  const { sceneId, patch } = action.params
  const idErr = validateId(sceneId, 'sceneId')
  if (idErr) return { success: false, error: idErr }
  const existsErr = validateExists(state, sceneId, 'scene')
  if (existsErr) return { success: false, error: existsErr }

  const scene = state.scenes.find((s) => s.id === sceneId)!
  const prior: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) {
    prior[k] = (scene.styleOverride as unknown as Record<string, unknown>)[k]
  }

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, styleOverride: { ...s.styleOverride, ...patch } })),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'style/setSceneOverride',
      params: { sceneId, patch: prior as typeof action.params.patch, prior: patch },
    },
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}

// ── style/setGlobal ────────────────────────────────────────────────────────

export function reduceStyleSetGlobal(state: ProjectState, action: StyleSetGlobalAction): ActionResult {
  const { patch } = action.params
  // Capture prior values for round-trip.
  const prior: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) {
    prior[k] = (state.globalStyle as unknown as Record<string, unknown>)[k]
  }

  return {
    success: true,
    state: {
      ...state,
      globalStyle: { ...state.globalStyle, ...patch },
      project: { ...state.project, updatedAt: new Date().toISOString() },
    },
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'style/setGlobal',
      params: { patch: prior as typeof action.params.patch, prior: patch },
    },
    // Global style change repaints every scene; flag the project-save and
    // let the runtime decide whether to flush HTML for affected scenes.
    effects: [{ kind: 'schedule-project-save' }],
  }
}
