import { v4 as uuidv4 } from 'uuid'
import type { Scene } from '@/lib/types'

/**
 * The fields a caller may seed onto a fresh scene shell. Everything else on the
 * `Scene` is defaulted to an empty/neutral value. A "shell" is a valid, codeless
 * scene: it renders as "Building…" (the ChatScenePreview content-guard) until a
 * write_scene_code / patch_layer_code lands real content on its `id`.
 */
export interface SceneShellSpec {
  /** Pin the id (orchestration pre-creates shells with a known id so the built
   *  scene reconciles back by id, never by a fragile name/purpose guess). */
  id?: string
  name?: string
  prompt?: string
  duration?: number
  bgColor?: string
  sceneType?: Scene['sceneType']
  /** Seed the plan's transition deterministically so a multi-scene build starts
   *  with the planned crossfade instead of the `none` default the agent then
   *  forgets to set (or `set_all_transitions` flattens). */
  transition?: Scene['transition']
}

/**
 * Build a fresh, valid, codeless `Scene`. Single source of truth for the empty-
 * scene shape shared by the `create_scene` tool and the orchestrator's
 * deterministic scene pre-creation — so the two can never drift (a missing field
 * on one path was a latent source of "scene exists but half-initialized" bugs).
 *
 * Duration is clamped to the same [6, 30] range `create_scene` has always used.
 */
export function createSceneShell(spec: SceneShellSpec = {}): Scene {
  return {
    id: spec.id ?? uuidv4(),
    name: spec.name ?? '',
    prompt: spec.prompt ?? '',
    summary: '',
    svgContent: '',
    duration: Math.max(6, Math.min(30, spec.duration || 8)),
    bgColor: spec.bgColor || '#181818',
    thumbnail: null,
    videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: { enabled: false, src: null, volume: 1, fadeIn: false, fadeOut: false, startOffset: 0 },
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: spec.transition ?? 'none',
    usage: null,
    sceneType: spec.sceneType ?? 'react',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: '',
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
    worldConfig: null,
  }
}
