/**
 * Action layer.
 *
 * One typed `Action` is the only mutation surface for the project state.
 * Every UI handler, every agent tool, every scripted replay funnels through
 * `dispatch(action)` → executor → reducer → state' + inverseAction.
 *
 * The action is the deepest truth. The DB rows under
 * `scenes` / `layers` / `projects` and the `.dreambyte/` file mirror are
 * projections that can always be rebuilt from `action_log` + WAL.
 *
 * Action types are grouped by category (scene, layer, project, track, clip,
 * keyframe, effect, interaction, camera, audio, style, agent) below.
 */

import type {
  Scene,
  GlobalStyle,
  Project,
  AILayer,
  SceneVerifyErrorPayload,
  Timeline,
  Track,
  TrackType,
  Clip,
  Keyframe,
  ClipFilter,
  InteractionElement,
  CameraMove,
  AudioLayer,
  SceneStyleOverride,
} from '@/lib/types'

// ── Common ─────────────────────────────────────────────────────────────────

/**
 * Bumped only when a reducer's *interpretation* of its params changes in a
 * non-back-compat way. Old logs replay forever via per-version reducers.
 */
export const ACTION_VERSION = 1

export type ActionSource = 'user' | 'agent' | 'replay' | 'migration'

export interface BaseAction<TParams = Record<string, unknown>> {
  /** uuid; lets us reference + undo by id */
  readonly id: string
  /** ms since epoch */
  readonly timestamp: number
  /** Set by the dispatcher, never trusted from caller (architecture finding 1). */
  readonly source: ActionSource
  /** Groups agent-run actions for ranged undo; null for user-driven actions. */
  readonly runId: string | null
  /** Action-schema version. Bumped on params shape changes. */
  readonly version: number
  /** Discriminator. */
  readonly type: string
  /** Per-type params. */
  readonly params: TParams
  /**
   * For non-deterministic actions (e.g., `layer/regenerate` calls an LLM)
   * the result is captured here so replay reproduces the same state without
   * re-firing the generator. Reducers stay pure.
   */
  readonly resultBlobHash?: string | null
  readonly nondeterministic?: boolean
}

export type ActionErrorCode =
  | 'INVALID_PARAMS'
  | 'SCENE_NOT_FOUND'
  | 'LAYER_NOT_FOUND'
  | 'PROJECT_NOT_LOADED'
  | 'CLIP_NOT_FOUND'
  | 'TRACK_NOT_FOUND'
  | 'TRACK_LOCKED'
  | 'INCOMPATIBLE_TYPE'
  | 'OVERLAP_DETECTED'
  | 'INSUFFICIENT_HANDLES'
  | 'INVALID_TIME_RANGE'
  | 'OUT_OF_BOUNDS'
  | 'KEYFRAME_CONFLICT'
  | 'CIRCULAR_REFERENCE'
  | 'MEDIA_NOT_FOUND'
  | 'STORAGE_FULL'
  | 'VERIFY_FAILED'
  | 'LAYER_EDITING'
  | 'SCENE_LOCKED'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_ACTION'

export interface ActionError {
  code: ActionErrorCode
  message: string
  /** Human-friendly hint shown in tool results / inspector toasts. */
  suggestion?: string
  /** Structured detail (e.g., the conflicting clip id). */
  details?: Record<string, unknown>
}

/**
 * The minimal slice of store state reducers operate on. Keeping this narrow
 * means a reducer is a pure `(state, action) → state'` function that can be
 * unit-tested without spinning up the whole Zustand store.
 */
export interface ProjectState {
  scenes: Scene[]
  globalStyle: GlobalStyle
  project: Project
  selectedSceneId: string | null
  /**
   * Cursor model. When the user is hand-editing a
   * specific layer's code in the inspector and this id matches, the
   * executor rejects agent-source dispatches that target the same layer
   * with `LAYER_EDITING`. Null = no field-level lock active.
   */
  uiEditingLayerId: string | null
}

/**
 * Reducer return value. `state` is a NEW object (Object.freeze enforced in
 * dev / test). `inverseAction` is the action that, when dispatched, undoes
 * this one.
 */
export interface ActionResult {
  success: boolean
  state?: ProjectState
  inverseAction?: Action
  error?: ActionError
  warnings?: string[]
  /**
   * If a downstream side-effect is required (HTML regen, scene verify, etc.)
   * the reducer flags it here and the runtime's effect-runner picks it up.
   * Reducers themselves stay synchronous + pure.
   */
  effects?: ActionEffect[]
}

export type ActionEffect = { kind: 'regenerate-scene-html'; sceneId: string } | { kind: 'schedule-project-save' }

// ── Scene / layer / project action params ──────────────────────────────────────────────────────

export interface SceneCreateParams {
  /**
   * If supplied, used as the new scene id; otherwise generated. Allowing the
   * caller to choose makes inverse-action (which needs the id we just made)
   * trivial without needing the reducer to round-trip the id back.
   */
  sceneId: string
  /** Insert position (0-based); appends if undefined. */
  position?: number
  /** Initial fields — partial Scene; remaining fields filled from defaults. */
  scene: Partial<Scene> & { id: string }
}

export interface SceneUpdateParams {
  sceneId: string
  /** Patch applied with object spread. Reducer rejects if id is patched. */
  patch: Partial<Scene>
  /** Captured by the dispatcher for inverse generation; do not set manually. */
  prior?: Partial<Scene>
}

export interface SceneDeleteParams {
  sceneId: string
  /** Snapshot of the deleted scene + its index, captured for inverse. */
  prior?: { scene: Scene; index: number }
}

export interface SceneReorderParams {
  fromIndex: number
  toIndex: number
}

export interface LayerAddParams {
  sceneId: string
  /** Caller-chosen layer id so inverse can target it without re-querying. */
  layerId: string
  layer: AILayer
  /** Insert position in `aiLayers`; appends if undefined. */
  position?: number
}

export interface LayerUpdateParams {
  sceneId: string
  layerId: string
  patch: Partial<AILayer>
  /** Set by dispatcher for inverse. */
  prior?: Partial<AILayer>
}

export interface LayerRemoveParams {
  sceneId: string
  layerId: string
  /** Captured for inverse: the layer + its position in aiLayers. */
  prior?: { layer: AILayer; index: number }
}

export interface ProjectUpdateParams {
  patch: Partial<Project>
  /** Captured by dispatcher for inverse. */
  prior?: Partial<Project>
}

// ── Timeline params ─────────────────────────────────────────────────────

export interface TrackAddParams {
  trackId: string
  type: TrackType
  name?: string
  /** Insert position in the track list; appends if undefined. */
  position?: number
}

export interface TrackRemoveParams {
  trackId: string
  /** Captured for inverse: the removed track + its index. */
  prior?: { track: Track; index: number }
}

export interface ClipAddParams {
  trackId: string
  clipId: string
  clip: Clip
  /** Insert position within the track's clips; appends if undefined. */
  position?: number
}

export interface ClipMoveParams {
  clipId: string
  /** New start position (seconds on global timeline). */
  startTime: number
  /** Optional move to a different track; same track if undefined. */
  newTrackId?: string
  /** Captured by dispatcher for inverse. */
  prior?: { startTime: number; trackId: string }
}

/**
 * clip/batchMove — move N clips atomically (multi-select drag, Alt-arrow nudge,
 * linked/grouped co-movement). All moves are validated against the final state
 * together (all-or-nothing): if any moved clip would overlap on a `reject` track,
 * the whole batch is refused, so the timeline never lands in a half-applied state.
 * The single combined inverse restores every clip's prior start + track in one undo.
 */
export interface ClipBatchMoveParams {
  moves: Array<{
    clipId: string
    /** New start position (seconds on global timeline). */
    startTime: number
    /** Optional move to a different track; same track if undefined. */
    newTrackId?: string
  }>
}

/**
 * A single in-place clip patch for clip/batchEdit (and the inverse of
 * slip/slide/roll). Any omitted field keeps the clip's current value. No
 * `newTrackId` — these are same-track property edits; cross-track repositioning
 * goes through clip/move or clip/batchMove.
 */
export interface ClipEditPatch {
  clipId: string
  startTime?: number
  duration?: number
  trimStart?: number
  trimEnd?: number | null
}

/** clip/batchEdit — apply N in-place patches atomically (overlap-safe). */
export interface ClipBatchEditParams {
  edits: ClipEditPatch[]
}

/**
 * clip/roll — roll the shared edit point between two butt-jointed clips.
 * `clipId` + `edge` identify which boundary; `delta` > 0 moves it later.
 */
export interface ClipRollParams {
  clipId: string
  edge: 'left' | 'right'
  delta: number
}

/** clip/slide — shift a clip by `delta`; its neighbors trim to absorb it. */
export interface ClipSlideParams {
  clipId: string
  delta: number
}

/**
 * clip/slip — shift a clip's source window by `sourceDelta` (source-seconds),
 * keeping position + duration fixed. `linked` slips all linkGroup siblings too.
 */
export interface ClipSlipParams {
  clipId: string
  sourceDelta: number
  linked?: boolean
}

export interface ClipTrimParams {
  clipId: string
  /** New trim-start (source in-point, seconds). */
  trimStart?: number
  /** New trim-end (source out-point, seconds; null = source end). */
  trimEnd?: number | null
  /** New duration (seconds on global timeline). */
  duration?: number
  /** Captured for inverse: prior trimStart / trimEnd / duration. */
  prior?: { trimStart: number; trimEnd: number | null; duration: number }
}

export interface ClipSplitParams {
  clipId: string
  /**
   * Split time on the global timeline (seconds). Reducer rejects when the
   * time is outside the clip's [startTime, startTime+duration] range.
   */
  time: number
  /** Caller-chosen id for the second half so inverse can re-merge it. */
  rightClipId: string
}

export interface ClipRippleDeleteParams {
  clipId: string
  /** Captured for inverse: the removed clip, its index, prior gap behavior. */
  prior?: { clip: Clip; index: number; shifts: Array<{ id: string; prevStartTime: number }> }
}

/**
 * clip/remove — non-ripple gap-leaving delete. Unlike rippleDelete, downstream
 * clips don't shift. Unlike the legacy `removeClip` store action, this is fully
 * action-log-coherent: the reducer handles all source mutations (audioLayer,
 * aiLayers, scene deletion, sceneGraph cleanup) so undo/WAL/replay stay correct.
 */
export interface ClipRemoveParams {
  clipId: string
  // No `prior` field — the reducer computes the inverse from the full state at
  // dispatch time, capturing it as an `agent/applyRun` snapshot so a single
  // Cmd+Z restores the clip + all source mutations atomically.
}

// ── Timeline markers ──────────────────────────────────────────────────

export interface MarkerAddParams {
  markerId: string
  time: number
  label?: string
  color?: string
}

export interface MarkerRemoveParams {
  markerId: string
  /** Set on the inverse so undo can restore the marker verbatim. */
  prior?: { time: number; label?: string; color?: string }
}

// ── Track flags ───────────────────────────────────────────────────

export interface TrackLockParams {
  trackId: string
  locked: boolean
  prior?: { locked: boolean }
}

export interface TrackMuteParams {
  trackId: string
  muted: boolean
  prior?: { muted: boolean }
}

export interface TrackSoloParams {
  trackId: string
  solo: boolean
  prior?: { solo: boolean }
}

export interface TrackHideParams {
  trackId: string
  hidden: boolean
  prior?: { hidden: boolean }
}

export interface TrackSetVolumeParams {
  trackId: string
  /** Linear gain, clamped 0..2 (+6 dB) by the reducer. */
  volume: number
  prior?: { volume: number }
}

export interface TrackSetPanParams {
  trackId: string
  /** Stereo pan, clamped -1..+1 by the reducer. */
  pan: number
  prior?: { pan: number }
}

// ── Clip flags ────────────────────────────────────────────────────

export interface ClipSetSpeedParams {
  clipId: string
  /** Playback rate. Clamped to [0.25, 4.0] by the reducer. */
  speed: number
  /** If true on an audio clip, pitch is preserved (varispeed off). */
  lockAudioPitch?: boolean
  prior?: { speed: number; lockAudioPitch?: boolean; duration: number }
}

export interface ClipSetBlendParams {
  clipId: string
  blendMode: string
  /** 0..1 alpha layered onto the blend mode. Falls back to clip.opacity when unset. */
  blendOpacity?: number
  prior?: { blendMode?: string; blendOpacity?: number }
}

export interface ClipSetColorGradeParams {
  clipId: string
  /** The full new grade (the handler merges before dispatch; [] / {} clears). */
  grade: import('@/lib/edit-engines/clip-grade').ClipColorGrade
  prior?: { grade?: import('@/lib/edit-engines/clip-grade').ClipColorGrade }
}

export interface ClipFadeParams {
  clipId: string
  /** Fade-in seconds; >=0, <= clip duration. */
  fadeIn?: number
  /** Fade-out seconds; >=0, <= clip duration. */
  fadeOut?: number
  prior?: { fadeIn?: number; fadeOut?: number }
}

export interface ClipSetTransformParams {
  clipId: string
  /** Each field is optional — pass only what you want to patch. */
  position?: { x?: number; y?: number }
  scale?: { x?: number; y?: number }
  rotation?: number
  opacity?: number
  prior?: {
    position?: { x: number; y: number }
    scale?: { x: number; y: number }
    rotation?: number
    opacity?: number
  }
}

// ── Keyframes ─────────────────────────────────────────────────────

export interface KeyframeAddParams {
  clipId: string
  keyframe: Keyframe
}

export interface KeyframeUpdateParams {
  clipId: string
  property: Keyframe['property']
  /** Time of the keyframe to update (seconds relative to clip start). */
  time: number
  patch: Partial<Keyframe>
  prior?: Partial<Keyframe>
}

export interface KeyframeRemoveParams {
  clipId: string
  property: Keyframe['property']
  time: number
  prior?: { keyframe: Keyframe }
}

// ── Clip effects (filters) ────────────────────────────────────────

export interface EffectAddParams {
  clipId: string
  filter: ClipFilter
}

export interface EffectUpdateParams {
  clipId: string
  /** Filter type acts as a unique key per clip (one blur, one brightness, etc.). */
  filterType: ClipFilter['type']
  value: number
  /** tone-curve only: replace the curve payload alongside the value. */
  curve?: ClipFilter['curve']
  prior?: { value: number; curve?: ClipFilter['curve'] }
}

export interface EffectRemoveParams {
  clipId: string
  filterType: ClipFilter['type']
  prior?: { filter: ClipFilter; index: number }
}

/**
 * Grading UI: replace ALL grade-managed filters (brightness/contrast/saturate/
 * grayscale/sepia/hue-rotate) on a clip in one action — one undo step for a
 * grade swap or intensity drag, vs N effect/add+remove steps. `gradeFilters`
 * is the complete new managed set ([] clears the grade); blur/blend untouched.
 */
export interface EffectSetGradeFiltersParams {
  clipId: string
  gradeFilters: ClipFilter[]
  prior?: { gradeFilters: ClipFilter[] }
}

// ── Interaction / camera / audio / style ────────────────────────────

export interface InteractionAddParams {
  sceneId: string
  interactionId: string
  interaction: InteractionElement
  /** Insert position in `scene.interactions`; appends if undefined. */
  position?: number
}

export interface InteractionUpdateParams {
  sceneId: string
  interactionId: string
  patch: Partial<InteractionElement>
  prior?: Partial<InteractionElement>
}

export interface InteractionRemoveParams {
  sceneId: string
  interactionId: string
  prior?: { interaction: InteractionElement; index: number }
}

export interface CameraSetMotionParams {
  sceneId: string
  /** `null` removes the camera motion; an array replaces it. */
  motion: CameraMove[] | null
  prior?: CameraMove[] | null
}

export interface AudioSetLayerParams {
  sceneId: string
  /** Partial patch onto the scene's audioLayer; missing fields preserved. */
  patch: Partial<AudioLayer>
  prior?: Partial<AudioLayer>
}

export interface AudioSetMasterVolumeParams {
  /** Program master gain (linear, 0..2 = +6 dB), surgically merged into
   *  project.audioSettings so other settings are preserved. */
  volume: number
  prior?: { volume: number }
}

export interface StyleSetSceneOverrideParams {
  sceneId: string
  patch: Partial<SceneStyleOverride>
  prior?: Partial<SceneStyleOverride>
}

export interface StyleSetGlobalParams {
  patch: Partial<GlobalStyle>
  prior?: Partial<GlobalStyle>
}

// ── Agent run (coarse-grained, captures a whole multi-tool agent run) ──────
//
// `agent/applyRun` bridges the agent → action-log gap. Agent runs happen
// in the main process and produce a complete post-state (scenes +
// globalStyle) rather than a stream of typed actions. This type routes them
// through the action layer (action_log row + undo-stack inverse): every agent
// run shows up as one entry tagged
// `source: 'agent'` with the runId already produced by the agent runner,
// and Cmd+Z reverts the whole run as a unit.
//
// Granularity is intentionally coarse. The agent run IS the user's atomic
// event ("I ran the agent" = one thing, not 30 tool calls). Future per-
// tool migration to typed actions can refine this without changing the
// contract.
export interface AgentApplyRunParams {
  /** Post-state scenes to apply (already merged by the caller). */
  scenes: Scene[]
  /** Post-state global style to apply (already merged by the caller). */
  globalStyle: GlobalStyle
  /**
   * Post-state scene graph. Optional for back-compat (callers that don't
   * pass it preserve the current graph), but agent runs that create or
   * remove scenes MUST pass it or undo will leave dangling edge refs.
   */
  sceneGraph?: import('../types/project').SceneGraph
  /**
   * Post-state timeline. Optional for back-compat. When present, the reducer
   * replaces `project.timeline` with this value — used as the inverse of
   * `clip/remove` (and future track/scene-delete inverses) so Cmd+Z restores
   * the full timeline state atomically alongside the scene sources.
   */
  timeline?: import('@/lib/types').Timeline | null
  /** Optional descriptor for audit (Master Builder / Director / Editor / etc). */
  agentType?: string
  /**
   * PRE-RUN snapshot. The forward `agent/applyRun` is dispatched AFTER the
   * stream already merged incremental scenes into the live store, so capturing
   * the inverse from `state.scenes` at dispatch time records POST-stream state —
   * Cmd+Z would then "undo" to where the run already ended. When the caller has
   * the run-start snapshot (keyed in `_runSnapshots`), it threads it here so the
   * reducer builds the undo inverse from the TRUE pre-run state.
   */
  preRunSnapshot?: {
    scenes: Scene[]
    globalStyle: GlobalStyle
    sceneGraph?: import('../types/project').SceneGraph
    timeline?: import('@/lib/types').Timeline | null
  }
  /**
   * Set on the INVERSE (undo) action only. Tells the reducer this apply
   * restores pre-run scenes whose on-disk HTML cache may have been overwritten
   * by the run, so it must schedule a project save AND regenerate scene HTML —
   * otherwise the undo lives only in memory (a reload resurrects the run) and
   * previews stay stale. The redo direction does NOT set it (post-run HTML is
   * already correct on disk).
   */
  regenerateOnApply?: boolean
}

// ── Discriminated Action union (cont'd) ─────────────────────────────────────

// ── Discriminated Action union ─────────────────────────────────────────────

export type SceneCreateAction = BaseAction<SceneCreateParams> & { type: 'scene/create' }
export type SceneUpdateAction = BaseAction<SceneUpdateParams> & { type: 'scene/update' }
export type SceneDeleteAction = BaseAction<SceneDeleteParams> & { type: 'scene/delete' }
export type SceneReorderAction = BaseAction<SceneReorderParams> & { type: 'scene/reorder' }
export type LayerAddAction = BaseAction<LayerAddParams> & { type: 'layer/add' }
export type LayerUpdateAction = BaseAction<LayerUpdateParams> & { type: 'layer/update' }
export type LayerRemoveAction = BaseAction<LayerRemoveParams> & { type: 'layer/remove' }
export type ProjectUpdateAction = BaseAction<ProjectUpdateParams> & { type: 'project/update' }

export type MarkerAddAction = BaseAction<MarkerAddParams> & { type: 'marker/add' }
export type MarkerRemoveAction = BaseAction<MarkerRemoveParams> & { type: 'marker/remove' }

export type TrackAddAction = BaseAction<TrackAddParams> & { type: 'track/add' }
export type TrackRemoveAction = BaseAction<TrackRemoveParams> & { type: 'track/remove' }
export type TrackLockAction = BaseAction<TrackLockParams> & { type: 'track/lock' }
export type TrackMuteAction = BaseAction<TrackMuteParams> & { type: 'track/mute' }
export type TrackSoloAction = BaseAction<TrackSoloParams> & { type: 'track/solo' }
export type TrackHideAction = BaseAction<TrackHideParams> & { type: 'track/hide' }
export type TrackSetVolumeAction = BaseAction<TrackSetVolumeParams> & { type: 'track/setVolume' }
export type TrackSetPanAction = BaseAction<TrackSetPanParams> & { type: 'track/setPan' }

export type ClipAddAction = BaseAction<ClipAddParams> & { type: 'clip/add' }
export type ClipMoveAction = BaseAction<ClipMoveParams> & { type: 'clip/move' }
export type ClipBatchMoveAction = BaseAction<ClipBatchMoveParams> & { type: 'clip/batchMove' }
export type ClipBatchEditAction = BaseAction<ClipBatchEditParams> & { type: 'clip/batchEdit' }
export type ClipRollAction = BaseAction<ClipRollParams> & { type: 'clip/roll' }
export type ClipSlideAction = BaseAction<ClipSlideParams> & { type: 'clip/slide' }
export type ClipSlipAction = BaseAction<ClipSlipParams> & { type: 'clip/slip' }
export type ClipTrimAction = BaseAction<ClipTrimParams> & { type: 'clip/trim' }
export type ClipSplitAction = BaseAction<ClipSplitParams> & { type: 'clip/split' }
export type ClipRippleDeleteAction = BaseAction<ClipRippleDeleteParams> & { type: 'clip/rippleDelete' }
export type ClipRemoveAction = BaseAction<ClipRemoveParams> & { type: 'clip/remove' }
export type ClipSetSpeedAction = BaseAction<ClipSetSpeedParams> & { type: 'clip/setSpeed' }
export type ClipSetBlendAction = BaseAction<ClipSetBlendParams> & { type: 'clip/setBlend' }
export type ClipSetColorGradeAction = BaseAction<ClipSetColorGradeParams> & { type: 'clip/setColorGrade' }
export type ClipFadeAction = BaseAction<ClipFadeParams> & { type: 'clip/fade' }
export type ClipSetTransformAction = BaseAction<ClipSetTransformParams> & { type: 'clip/setTransform' }

export type KeyframeAddAction = BaseAction<KeyframeAddParams> & { type: 'keyframe/add' }
export type KeyframeUpdateAction = BaseAction<KeyframeUpdateParams> & { type: 'keyframe/update' }
export type KeyframeRemoveAction = BaseAction<KeyframeRemoveParams> & { type: 'keyframe/remove' }

export type EffectAddAction = BaseAction<EffectAddParams> & { type: 'effect/add' }
export type EffectUpdateAction = BaseAction<EffectUpdateParams> & { type: 'effect/update' }
export type EffectRemoveAction = BaseAction<EffectRemoveParams> & { type: 'effect/remove' }
export type EffectSetGradeFiltersAction = BaseAction<EffectSetGradeFiltersParams> & { type: 'effect/setGradeFilters' }

export type InteractionAddAction = BaseAction<InteractionAddParams> & { type: 'interaction/add' }
export type InteractionUpdateAction = BaseAction<InteractionUpdateParams> & { type: 'interaction/update' }
export type InteractionRemoveAction = BaseAction<InteractionRemoveParams> & { type: 'interaction/remove' }
export type CameraSetMotionAction = BaseAction<CameraSetMotionParams> & { type: 'camera/setMotion' }
export type AudioSetLayerAction = BaseAction<AudioSetLayerParams> & { type: 'audio/setLayer' }
export type AudioSetMasterVolumeAction = BaseAction<AudioSetMasterVolumeParams> & { type: 'audio/setMasterVolume' }
export type StyleSetSceneOverrideAction = BaseAction<StyleSetSceneOverrideParams> & { type: 'style/setSceneOverride' }
export type StyleSetGlobalAction = BaseAction<StyleSetGlobalParams> & { type: 'style/setGlobal' }

export type AgentApplyRunAction = BaseAction<AgentApplyRunParams> & { type: 'agent/applyRun' }

export type Action =
  | SceneCreateAction
  | SceneUpdateAction
  | SceneDeleteAction
  | SceneReorderAction
  | LayerAddAction
  | LayerUpdateAction
  | LayerRemoveAction
  | ProjectUpdateAction
  | MarkerAddAction
  | MarkerRemoveAction
  | TrackAddAction
  | TrackRemoveAction
  | TrackLockAction
  | TrackMuteAction
  | TrackSoloAction
  | TrackHideAction
  | TrackSetVolumeAction
  | TrackSetPanAction
  | ClipAddAction
  | ClipMoveAction
  | ClipBatchMoveAction
  | ClipBatchEditAction
  | ClipRollAction
  | ClipSlideAction
  | ClipSlipAction
  | ClipTrimAction
  | ClipSplitAction
  | ClipRippleDeleteAction
  | ClipRemoveAction
  | ClipSetSpeedAction
  | ClipSetBlendAction
  | ClipSetColorGradeAction
  | ClipFadeAction
  | ClipSetTransformAction
  | KeyframeAddAction
  | KeyframeUpdateAction
  | KeyframeRemoveAction
  | EffectAddAction
  | EffectUpdateAction
  | EffectRemoveAction
  | EffectSetGradeFiltersAction
  | InteractionAddAction
  | InteractionUpdateAction
  | InteractionRemoveAction
  | CameraSetMotionAction
  | AudioSetLayerAction
  | AudioSetMasterVolumeAction
  | StyleSetSceneOverrideAction
  | StyleSetGlobalAction
  | AgentApplyRunAction

// ── Input shape for callers ────────────────────────────────────────────────

/**
 * What a caller passes to `dispatch()`. The dispatcher fills in id, timestamp,
 * source, runId, version. Source is dispatcher-stamped to prevent agent
 * tools from spoofing `{source:'user'}`.
 */
export type ActionInput<A extends Action = Action> = Omit<A, 'id' | 'timestamp' | 'source' | 'runId' | 'version'> & {
  /** Optional pre-supplied id (for replay). Otherwise generated. */
  id?: string
  /** Set when grouping multiple actions under one agent run. */
  runId?: string | null
  /** Override timestamp (for replay only). */
  timestamp?: number
}

// ── Re-exports for consumers ───────────────────────────────────────────────

export type { Scene, AILayer, GlobalStyle, Project, SceneVerifyErrorPayload }
