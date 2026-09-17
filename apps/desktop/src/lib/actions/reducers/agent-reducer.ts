/**
 * Agent reducer.
 *
 * `agent/applyRun` is the coarse-grained action that captures one whole
 * agent run (potentially dozens of tool calls in the main process) as a
 * single inverseable entry on the renderer-side action log.
 *
 * Why coarse and not per-tool: the agent run already runs in main, mutates
 * a `world` object by reference, and emits a final state_change to the
 * renderer. Going per-tool would require refactoring 183 tool handlers to
 * dispatch typed actions through IPC. Coarse-grained matches the user's
 * mental model — "I ran the agent" is one event — and is forward-compatible
 * with per-tool granularity arriving later.
 *
 * Forward inverse: capture current scenes + globalStyle + sceneGraph + the
 * id of whatever is selected. Reverse (undo) inverse: capture the post-
 * state passed in params so redo works symmetrically.
 *
 * selectedSceneId reconciliation: on either direction, if the currently
 * selected scene id isn't in the new scenes array, we fall through to the
 * first scene's id (or null when there are none). Without this, undo can
 * land with a selectedSceneId that points to a scene the new state doesn't
 * contain — dangling ref → preview crashes / blank.
 *
 * Undoing an agent run. Two corrections live here:
 *
 * 1. INVERSE SOURCE. The forward `agent/applyRun` is dispatched AFTER the stream
 *    already merged incremental scenes into the live store, so `state.scenes` at
 *    dispatch time is POST-stream — capturing the inverse from it would make
 *    Cmd+Z "undo" to where the run already ended. When the caller threads the
 *    run-start snapshot via `params.preRunSnapshot`, the forward reduction builds
 *    the undo inverse from THAT (the true pre-run state). Without it, we fall back
 *    to `state.scenes` (legacy behavior — still correct for replay-applied inverses
 *    which already carry the right post-state).
 *
 * 2. REGEN + SAVE ON UNDO. On the forward path, `syncScenesFromAgent` already
 *    wrote scene HTML via IPC, so no regen there. But the UNDO direction restores
 *    pre-run scenes whose on-disk HTML cache the run may have overwritten — so the
 *    undo inverse is tagged `regenerateOnApply`, and applying it (a) schedules a
 *    project save (else the undo is memory-only and a reload resurrects the run)
 *    and (b) regenerates scene HTML (else previews stay stale). The redo direction
 *    is NOT tagged: post-run HTML is already correct on disk.
 *
 * `schedule-project-save` also stays conditional on `timeline` for the legacy
 * clip/remove inverse path (a source-mutating delete undo that must persist).
 */

import type { ProjectState, ActionResult, AgentApplyRunAction } from '../types'
import { preserveUserHeldScenes } from '../../store/scene-lock'

export function reduceAgentApplyRun(state: ProjectState, action: AgentApplyRunAction): ActionResult {
  const { scenes: incomingScenes, globalStyle, sceneGraph } = action.params

  // Scene-lock enforcement, agent side (cursor model). The agent's apply is a bulk scene-array
  // replacement with no per-scene id, so the executor guard (which keys on params.sceneId) can't
  // gate it. Instead, here: for a forward AGENT apply, preserve the USER's version of any scene
  // the user currently holds (live store lock — the agent's own snapshot is stale) so an agent
  // run can't clobber a scene the user is actively editing. Replay/undo (source !== 'agent')
  // applies verbatim. Overwrite-protection only; a user-held scene the agent's array omits is a
  // rarer edge left to the badge/takeover UX (re-adding it could desync the scene graph). Shared
  // with the store's raw-set fallback (agent-actions.ts) via preserveUserHeldScenes.
  const scenes =
    action.source === 'agent' && Array.isArray(incomingScenes)
      ? preserveUserHeldScenes(state.scenes, incomingScenes)
      : incomingScenes

  if (!Array.isArray(scenes)) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'agent/applyRun: params.scenes must be an array' },
    }
  }
  if (!globalStyle || typeof globalStyle !== 'object') {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'agent/applyRun: params.globalStyle is required' },
    }
  }

  // The "from" state the inverse restores. For a FORWARD agent apply
  // (source === 'agent'), prefer the run-start snapshot threaded in
  // params.preRunSnapshot — `state.scenes` here is POST-stream. Replay
  // applies (undo/redo) already carry the correct from-state in their own
  // params and pass no preRunSnapshot, so they capture live state as before.
  const preRun = action.source === 'agent' ? action.params.preRunSnapshot : undefined
  const inverseScenes = preRun?.scenes ?? state.scenes
  const inverseGlobalStyle = preRun?.globalStyle ?? state.globalStyle
  const inverseSceneGraph = preRun?.sceneGraph ?? state.project.sceneGraph

  // Inverse captures the from-state so undo restores it. When this action
  // carried a `timeline` field (used as clip/remove inverse), the undo-of-undo
  // (redo) also needs to re-restore the post-clip-remove timeline, so we
  // always mirror the timeline field in the inverse.
  const inverse: AgentApplyRunAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'agent/applyRun',
    params: {
      scenes: inverseScenes,
      globalStyle: inverseGlobalStyle,
      sceneGraph: inverseSceneGraph,
      // Always mirror timeline in the inverse when the forward action carried
      // it — this makes redo of a clip/remove undo work correctly. Prefer the
      // pre-run snapshot's timeline (true pre-run state) over live state.
      timeline:
        action.params.timeline !== undefined
          ? (preRun?.timeline ?? state.project.timeline ?? null)
          : preRun?.timeline !== undefined
            ? (preRun.timeline ?? null)
            : undefined,
      agentType: action.params.agentType,
      // Tag every inverse in an agent-run undo/redo CHAIN so applying it (Cmd+Z
      // OR Cmd+Shift+Z) regenerates HTML and schedules a save. It
      // is NOT enough to tag only the forward apply's undo inverse — each
      // direction overwrites the on-disk HTML the other wrote, so a redo that
      // restored the run's scenes while disk still held the undo's pre-run HTML
      // left the preview stale and resurrected pre-run on reload. Propagate the
      // flag (source 'agent' is the forward apply; an already-tagged replay is a
      // later link in the same chain) so the redo direction regens + saves too.
      regenerateOnApply: action.source === 'agent' || action.params.regenerateOnApply ? true : undefined,
    },
  }

  // Reconcile selectedSceneId against the new scenes. If the current
  // selection still exists in the new state, keep it. Otherwise pick the
  // first scene's id (or null if scenes is empty). Same convention as
  // reduceSceneDelete.
  const nextSelectedSceneId =
    state.selectedSceneId && scenes.some((s) => s.id === state.selectedSceneId)
      ? state.selectedSceneId
      : (scenes[0]?.id ?? null)

  const { timeline } = action.params

  // sceneGraph: if the caller passed it (agent runs that create/remove
  // scenes MUST), apply it. Otherwise preserve. Bump project.updatedAt
  // either way so UI freshness indicators reflect the change.
  // timeline: same opt-in pattern — passed only by clip/remove and similar
  // source-mutating delete inverses that need full timeline restoration.
  const nextProject = {
    ...state.project,
    ...(sceneGraph ? { sceneGraph } : {}),
    ...(timeline !== undefined ? { timeline: timeline ?? null } : {}),
    updatedAt: new Date(action.timestamp).toISOString(),
  }

  // Persistence + regen effects:
  //  - A plain forward agent-run apply already persisted in main, so it emits
  //    NO renderer save (avoids racing the optimistic-version check — header).
  //  - The clip/remove-class inverse (carries `timeline`) MUST schedule a save
  //    or the restored scenes/timeline/graph live only in memory (reload reverts).
  //  - Any agent-run undo/redo inverse (regenerateOnApply) MUST schedule a
  //    save AND regenerate every restored scene's HTML — each direction overwrote
  //    the other's on-disk cache, so without regen the preview stays stale and a
  //    reload resurrects the wrong side. We regen the restored set (the scenes now
  //    in state); a scene the apply DROPS is handled by absence (nothing to regen).
  const effects: Array<{ kind: 'schedule-project-save' } | { kind: 'regenerate-scene-html'; sceneId: string }> = []
  if (action.params.regenerateOnApply) {
    effects.push({ kind: 'schedule-project-save' })
    for (const s of scenes) effects.push({ kind: 'regenerate-scene-html', sceneId: s.id })
  } else if (timeline !== undefined) {
    effects.push({ kind: 'schedule-project-save' })
  }

  return {
    success: true,
    state: {
      ...state,
      scenes,
      globalStyle,
      project: nextProject,
      selectedSceneId: nextSelectedSceneId,
    },
    inverseAction: inverse,
    ...(effects.length > 0 ? { effects } : {}),
  }
}
