/**
 * Scene-id remapping helpers — pure (no DB / no Electron deps), so the
 * branch-promote flow (src/lib/store/project-actions.ts) can share them.
 *
 * When scenes are cloned with fresh ids, EVERY cross-reference to a scene id
 * must be repointed or the clone is incoherent: interaction jump targets, the
 * scene graph (nodes/edges/start), and timeline scene-clip sourceIds. These
 * funcs do exactly that, driven by an old-id -> new-id map. Ids absent from the
 * map pass through unchanged (so a partial map only touches what it knows).
 */

import { v4 as uuidv4 } from 'uuid'
import type { Scene, SceneGraph } from '@/lib/types'

/** Clone a scene with its mapped id and its interaction jump targets remapped. */
export function remapSceneIds(scene: Scene, idMap: Map<string, string>): Scene {
  const newId = idMap.get(scene.id) ?? scene.id
  return {
    ...scene,
    id: newId,
    interactions: scene.interactions.map((ix) => remapInteractionIds(ix, idMap)),
  }
}

/** Remap every scene-id jump target an interaction can carry (hotspot/choice/quiz/form). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function remapInteractionIds(ix: any, idMap: Map<string, string>): any {
  const remapped = { ...ix }

  // Hotspot: jumpsToSceneId
  if (remapped.jumpsToSceneId && idMap.has(remapped.jumpsToSceneId)) {
    remapped.jumpsToSceneId = idMap.get(remapped.jumpsToSceneId)
  }

  // Choice: options[].jumpsToSceneId
  if (remapped.options && Array.isArray(remapped.options)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    remapped.options = remapped.options.map((opt: any) => ({
      ...opt,
      jumpsToSceneId:
        opt.jumpsToSceneId && idMap.has(opt.jumpsToSceneId) ? idMap.get(opt.jumpsToSceneId) : opt.jumpsToSceneId,
    }))
  }

  // Quiz: onCorrectSceneId, onWrongSceneId
  if (remapped.onCorrectSceneId && idMap.has(remapped.onCorrectSceneId)) {
    remapped.onCorrectSceneId = idMap.get(remapped.onCorrectSceneId)
  }
  if (remapped.onWrongSceneId && idMap.has(remapped.onWrongSceneId)) {
    remapped.onWrongSceneId = idMap.get(remapped.onWrongSceneId)
  }

  // Form: jumpsToSceneId
  if (remapped.type === 'form' && remapped.jumpsToSceneId && idMap.has(remapped.jumpsToSceneId)) {
    remapped.jumpsToSceneId = idMap.get(remapped.jumpsToSceneId)
  }

  return remapped
}

/**
 * Remap the scene graph: node ids and edge endpoints repoint through the map;
 * edge ids are REGENERATED (sceneEdges are project-scoped and keyed by edge id,
 * so reusing the source edge ids would clobber another branch's rows). The
 * start scene repoints too.
 */
export function remapSceneGraphIds(graph: SceneGraph, idMap: Map<string, string>): SceneGraph {
  return {
    nodes: graph.nodes.map((n) => ({ ...n, id: idMap.get(n.id) ?? n.id })),
    edges: graph.edges.map((e) => ({
      ...e,
      id: uuidv4(), // fresh edge ids — project-scoped table, avoid cross-branch clobber
      fromSceneId: idMap.get(e.fromSceneId) ?? e.fromSceneId,
      toSceneId: idMap.get(e.toSceneId) ?? e.toSceneId,
    })),
    startSceneId: idMap.get(graph.startSceneId) ?? graph.startSceneId,
  }
}

/** Remap scene-clip sourceIds in a timeline (scene-type clips key on sourceId === sceneId). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function remapTimelineIds(timeline: any, idMap: Map<string, string>): any {
  if (!timeline || !timeline.tracks) return timeline
  return {
    ...timeline,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracks: timeline.tracks.map((track: any) => ({
      ...track,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clips: (track.clips ?? []).map((clip: any) => ({
        ...clip,
        sourceId: clip.sourceType === 'scene' && idMap.has(clip.sourceId) ? idMap.get(clip.sourceId) : clip.sourceId,
      })),
    })),
  }
}
