/**
 * Reducer registry. Maps `Action.type` → reducer. The executor consults this
 * by `type` (a string) to dispatch — adding a new action type is just one
 * entry here plus the reducer file. No central switch grows over time.
 */

import type { Action, ActionResult, ProjectState } from '../types'
import { reduceSceneCreate, reduceSceneUpdate, reduceSceneDelete, reduceSceneReorder } from './scene-reducer'
import { reduceLayerAdd, reduceLayerUpdate, reduceLayerRemove } from './layer-reducer'
import { reduceProjectUpdate } from './project-reducer'
import { reduceTrackAdd, reduceTrackRemove } from './track-reducer'
import {
  reduceTrackLock,
  reduceTrackMute,
  reduceTrackSolo,
  reduceTrackHide,
  reduceTrackSetVolume,
  reduceTrackSetPan,
} from './track-flag-reducer'
import { reduceMarkerAdd, reduceMarkerRemove } from './marker-reducer'
import {
  reduceClipAdd,
  reduceClipMove,
  reduceClipBatchMove,
  reduceClipBatchEdit,
  reduceClipRoll,
  reduceClipSlide,
  reduceClipSlip,
  reduceClipTrim,
  reduceClipSplit,
  reduceClipRippleDelete,
  reduceClipRemove,
} from './clip-reducer'
import {
  reduceClipSetSpeed,
  reduceClipSetBlend,
  reduceClipSetColorGrade,
  reduceClipFade,
  reduceClipSetTransform,
} from './clip-flag-reducer'
import { reduceKeyframeAdd, reduceKeyframeUpdate, reduceKeyframeRemove } from './keyframe-reducer'
import { reduceEffectAdd, reduceEffectUpdate, reduceEffectRemove, reduceEffectSetGradeFilters } from './effect-reducer'
import { reduceInteractionAdd, reduceInteractionUpdate, reduceInteractionRemove } from './interaction-reducer'
import {
  reduceCameraSetMotion,
  reduceAudioSetLayer,
  reduceAudioSetMasterVolume,
  reduceStyleSetSceneOverride,
  reduceStyleSetGlobal,
} from './camera-audio-style-reducer'
import { reduceAgentApplyRun } from './agent-reducer'

type ReducerFn<A extends Action = Action> = (state: ProjectState, action: A) => ActionResult

// Each entry is narrow per type; consumers go through the discriminated
// `runReducer` below to keep the type-safety on action.type.
export const reducers: Record<Action['type'], ReducerFn> = {
  'scene/create': reduceSceneCreate as ReducerFn,
  'scene/update': reduceSceneUpdate as ReducerFn,
  'scene/delete': reduceSceneDelete as ReducerFn,
  'scene/reorder': reduceSceneReorder as ReducerFn,
  'layer/add': reduceLayerAdd as ReducerFn,
  'layer/update': reduceLayerUpdate as ReducerFn,
  'layer/remove': reduceLayerRemove as ReducerFn,
  'project/update': reduceProjectUpdate as ReducerFn,
  // Timeline primitives
  'track/add': reduceTrackAdd as ReducerFn,
  'track/remove': reduceTrackRemove as ReducerFn,
  'marker/add': reduceMarkerAdd as ReducerFn,
  'marker/remove': reduceMarkerRemove as ReducerFn,
  'track/lock': reduceTrackLock as ReducerFn,
  'track/mute': reduceTrackMute as ReducerFn,
  'track/solo': reduceTrackSolo as ReducerFn,
  'track/hide': reduceTrackHide as ReducerFn,
  'track/setVolume': reduceTrackSetVolume as ReducerFn,
  'track/setPan': reduceTrackSetPan as ReducerFn,
  'clip/add': reduceClipAdd as ReducerFn,
  'clip/move': reduceClipMove as ReducerFn,
  'clip/batchMove': reduceClipBatchMove as ReducerFn,
  'clip/batchEdit': reduceClipBatchEdit as ReducerFn,
  'clip/roll': reduceClipRoll as ReducerFn,
  'clip/slide': reduceClipSlide as ReducerFn,
  'clip/slip': reduceClipSlip as ReducerFn,
  'clip/trim': reduceClipTrim as ReducerFn,
  'clip/split': reduceClipSplit as ReducerFn,
  'clip/rippleDelete': reduceClipRippleDelete as ReducerFn,
  'clip/remove': reduceClipRemove as ReducerFn,
  'clip/setSpeed': reduceClipSetSpeed as ReducerFn,
  'clip/setBlend': reduceClipSetBlend as ReducerFn,
  'clip/setColorGrade': reduceClipSetColorGrade as ReducerFn,
  'clip/fade': reduceClipFade as ReducerFn,
  'clip/setTransform': reduceClipSetTransform as ReducerFn,
  'keyframe/add': reduceKeyframeAdd as ReducerFn,
  'keyframe/update': reduceKeyframeUpdate as ReducerFn,
  'keyframe/remove': reduceKeyframeRemove as ReducerFn,
  'effect/add': reduceEffectAdd as ReducerFn,
  'effect/update': reduceEffectUpdate as ReducerFn,
  'effect/remove': reduceEffectRemove as ReducerFn,
  'effect/setGradeFilters': reduceEffectSetGradeFilters as ReducerFn,
  // Interaction / camera / audio / style
  'interaction/add': reduceInteractionAdd as ReducerFn,
  'interaction/update': reduceInteractionUpdate as ReducerFn,
  'interaction/remove': reduceInteractionRemove as ReducerFn,
  'camera/setMotion': reduceCameraSetMotion as ReducerFn,
  'audio/setLayer': reduceAudioSetLayer as ReducerFn,
  'audio/setMasterVolume': reduceAudioSetMasterVolume as ReducerFn,
  'style/setSceneOverride': reduceStyleSetSceneOverride as ReducerFn,
  'style/setGlobal': reduceStyleSetGlobal as ReducerFn,
  // Agent runs (coarse-grained — one entry per whole multi-tool agent run)
  'agent/applyRun': reduceAgentApplyRun as ReducerFn,
}

export function runReducer(state: ProjectState, action: Action): ActionResult {
  const reducer = reducers[action.type]
  if (!reducer) {
    return {
      success: false,
      error: { code: 'UNKNOWN_ACTION', message: `No reducer registered for action type "${action.type}"` },
    }
  }
  return reducer(state, action)
}
