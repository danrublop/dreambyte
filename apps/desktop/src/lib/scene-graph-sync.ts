import type { Scene, SceneEdge, SceneGraph, SceneNode } from '@/lib/types'

/** Ensure every scene has a graph node; drop orphan nodes/edges; fix start when invalid. */
export function syncSceneGraphWithScenes(scenes: Scene[], graph: SceneGraph | null | undefined): SceneGraph {
  const base: SceneGraph = graph ?? { nodes: [], edges: [], startSceneId: '' }
  const sceneIds = new Set(scenes.map((s) => s.id))

  const nodes: SceneNode[] = base.nodes.filter((n) => sceneIds.has(n.id))
  const seen = new Set(nodes.map((n) => n.id))

  for (let i = 0; i < scenes.length; i++) {
    const id = scenes[i].id
    if (!seen.has(id)) {
      nodes.push({ id, position: { x: (i + 1) * 220, y: 100 } })
      seen.add(id)
    }
  }

  const edges: SceneEdge[] = base.edges.filter((e) => sceneIds.has(e.fromSceneId) && sceneIds.has(e.toSceneId))

  let startSceneId = base.startSceneId
  if (!startSceneId || !sceneIds.has(startSceneId)) {
    startSceneId = scenes[0]?.id ?? ''
  }

  return { nodes, edges, startSceneId }
}
