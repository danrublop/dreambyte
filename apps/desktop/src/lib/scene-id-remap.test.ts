// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { remapSceneGraphIds, remapSceneIds } from './scene-id-remap'
import type { Scene, SceneGraph } from './types'

// When promoteBranch (and the bundle importer) clone scenes with fresh ids,
// every scene-id cross-reference must repoint or the clone is incoherent.
describe('remapSceneGraphIds (graph integrity on clone)', () => {
  const graph: SceneGraph = {
    nodes: [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 10, y: 0 } },
    ],
    edges: [
      {
        id: 'e1',
        fromSceneId: 'a',
        toSceneId: 'b',
        condition: { type: 'auto', interactionId: null, variableName: null, variableValue: null },
      },
    ],
    startSceneId: 'a',
  }

  it('remaps node ids, edge endpoints, and the start scene', () => {
    const idMap = new Map([
      ['a', 'a-new'],
      ['b', 'b-new'],
    ])
    const out = remapSceneGraphIds(graph, idMap)
    expect(out.nodes.map((n) => n.id)).toEqual(['a-new', 'b-new'])
    expect(out.edges[0].fromSceneId).toBe('a-new')
    expect(out.edges[0].toSceneId).toBe('b-new')
    expect(out.startSceneId).toBe('a-new')
  })

  it('regenerates edge ids (project-scoped sceneEdges keyed by edge id — avoid cross-branch clobber)', () => {
    const out = remapSceneGraphIds(graph, new Map([['a', 'a-new']]))
    expect(out.edges[0].id).not.toBe('e1')
    expect(out.edges[0].id).toMatch(/^[0-9a-f-]{36}$/) // uuid
  })

  it('passes through ids absent from the map', () => {
    const out = remapSceneGraphIds(graph, new Map([['a', 'a-new']]))
    expect(out.nodes.map((n) => n.id)).toEqual(['a-new', 'b']) // b unmapped → kept
    expect(out.edges[0].toSceneId).toBe('b')
  })

  it('does not mutate the input graph', () => {
    remapSceneGraphIds(graph, new Map([['a', 'a-new']]))
    expect(graph.nodes[0].id).toBe('a')
    expect(graph.edges[0].id).toBe('e1')
  })
})

describe('remapSceneIds (interaction jump targets on clone)', () => {
  it('remaps the scene id and hotspot/choice/quiz jump targets', () => {
    const scene = {
      id: 's1',
      interactions: [
        { type: 'hotspot', jumpsToSceneId: 's2' },
        { type: 'choice', options: [{ jumpsToSceneId: 's2' }, { jumpsToSceneId: 'sX' }] },
        { type: 'quiz', onCorrectSceneId: 's2', onWrongSceneId: 's1' },
      ],
    } as unknown as Scene
    const idMap = new Map([
      ['s1', 's1-new'],
      ['s2', 's2-new'],
    ])
    const out = remapSceneIds(scene, idMap)
    expect(out.id).toBe('s1-new')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ix = out.interactions as any[]
    expect(ix[0].jumpsToSceneId).toBe('s2-new')
    expect(ix[1].options[0].jumpsToSceneId).toBe('s2-new')
    expect(ix[1].options[1].jumpsToSceneId).toBe('sX') // unmapped → kept
    expect(ix[2].onCorrectSceneId).toBe('s2-new')
    expect(ix[2].onWrongSceneId).toBe('s1-new')
  })

  it('does not mutate the input scene', () => {
    const scene = { id: 's1', interactions: [{ type: 'hotspot', jumpsToSceneId: 's2' }] } as unknown as Scene
    remapSceneIds(scene, new Map([['s2', 's2-new']]))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((scene.interactions as any[])[0].jumpsToSceneId).toBe('s2')
  })
})
