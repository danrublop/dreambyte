// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'

import { ALL_TOOLS } from './tools'
import { ALL_TRANSITION_IDS } from '@/lib/transitions'
import { createElementToolHandler } from './tool-handlers/element-tools'
import { createSceneToolHandler } from './tool-handlers/scene-tools'
import { createStyleToolHandler } from './tool-handlers/style-tools'
import { createResearchToolHandler } from './tool-handlers/research-tools'
import type { WorldStateMutable } from './world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

/** Each find_media kind must reach its OWN provider entry point — that is the whole
 *  point of a discriminated result (three different response shapes). Stub the router
 *  so this asserts the routing, not the network. */
const routed: string[] = []
vi.mock('@/lib/research/router', () => ({
  runStockVideoSearch: async () => (routed.push('video'), { results: [], provider: 'pexels' }),
  runStockImageSearch: async () => (routed.push('image'), { results: [], provider: 'unsplash' }),
  runArchivalSearch: async () => (routed.push('archival'), { results: [], provider: 'archive.org' }),
}))

/**
 * L5 — the four verb-split families L4 skipped.
 *
 *   element        op:     add | edit | delete
 *   scene_props    op:     duration | background | transition | transition_all
 *   generate_image source: prompt | reference | regenerate
 *   find_media     kind:   video | image | archival
 *
 * The thing that can silently break a merge is a discriminator value that is ADVERTISED
 * in the schema enum but reaches no branch — the model calls it, the handler falls
 * through, and nothing happens. So every case below derives its list from the live
 * schema enum rather than a hand-typed copy: adding a value to the schema without
 * wiring it reddens this file.
 *
 * Reachability + one honest error per family, not a per-op behaviour suite —
 * each op still runs the SAME handler body it did before the merge, and those bodies
 * keep their own existing tests.
 */

function schemaProps(tool: string): Record<string, { enum?: string[] } | undefined> {
  const t = ALL_TOOLS.find((x) => x.name === tool)
  if (!t) throw new Error(`${tool} is not registered`)
  return (t.input_schema?.properties ?? {}) as Record<string, { enum?: string[] } | undefined>
}

function enumOf(tool: string, prop: string): string[] {
  const e = schemaProps(tool)[prop]?.enum
  if (!e) throw new Error(`${tool}.${prop} has no enum`)
  return e
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    name: 'Scene 1',
    sceneType: 'react',
    duration: 5,
    durationSeconds: 5,
    bgColor: '#000',
    transition: 'none',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    textOverlays: [],
    ...overrides,
  } as unknown as Scene
}

function makeWorld(scenes: Scene[]): WorldStateMutable {
  return {
    scenes,
    globalStyle: {} as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: scenes[0].id } as SceneGraph,
  } as unknown as WorldStateMutable
}

const regenerateHTML = async () => ({ htmlWritten: true })
const elementHandler = createElementToolHandler({ regenerateHTML })
const sceneHandler = createSceneToolHandler({ regenerateHTML })
const styleHandler = createStyleToolHandler({ regenerateHTML })
const researchHandler = createResearchToolHandler()

/** The executor's routing for scene_props, mirrored (tool-executor.ts): the
 *  transition_all op is served by the STYLE handler because that branch owns the
 *  plan-fidelity guard. */
function callSceneProps(args: Record<string, unknown>, world: WorldStateMutable) {
  return args.op === 'transition_all'
    ? styleHandler('set_all_transitions', args, world)
    : sceneHandler('scene_props', args, world)
}

describe('element(op)', () => {
  it('every advertised op reaches its own branch', async () => {
    const world = makeWorld([makeScene()])
    const added = await elementHandler('element', { op: 'add', sceneId: 'scene-1', content: 'Hi', x: 10, y: 20 }, world)
    expect(added.success, JSON.stringify(added)).toBe(true)
    const elementId = (added.data as { elementId: string }).elementId

    const edited = await elementHandler('element', { op: 'edit', sceneId: 'scene-1', elementId, size: 96 }, world)
    expect(edited.success).toBe(true)
    expect(world.scenes[0].textOverlays[0].size).toBe(96)
    // The discriminator must not be spread onto the overlay by the edit branch.
    expect((world.scenes[0].textOverlays[0] as unknown as { op?: string }).op).toBeUndefined()

    const deleted = await elementHandler('element', { op: 'delete', sceneId: 'scene-1', elementId }, world)
    expect(deleted.success).toBe(true)
    expect(world.scenes[0].textOverlays).toHaveLength(0)

    expect(enumOf('element', 'op').sort()).toEqual(['add', 'delete', 'edit'])
  })

  it('errors honestly on an invalid op and on missing per-op args', async () => {
    const world = makeWorld([makeScene()])
    const bad = await elementHandler('element', { op: 'move', sceneId: 'scene-1' }, world)
    expect(bad.success).toBe(false)
    expect(bad.error).toMatch(/unknown op/i)
    // add's required args were a `required` block on the old schema; the merged schema
    // can only require what every op needs, so the handler must still refuse.
    const noContent = await elementHandler('element', { op: 'add', sceneId: 'scene-1' }, world)
    expect(noContent.success).toBe(false)
    const noId = await elementHandler('element', { op: 'edit', sceneId: 'scene-1' }, world)
    expect(noId.success).toBe(false)
  })
})

describe('scene_props(op)', () => {
  it('every advertised op reaches its own branch', async () => {
    const world = makeWorld([makeScene(), makeScene({ id: 'scene-2' })])

    expect((await callSceneProps({ op: 'duration', sceneId: 'scene-1', duration: 9 }, world)).success).toBe(true)
    expect(world.scenes[0].duration).toBe(9)

    expect((await callSceneProps({ op: 'background', sceneId: 'scene-1', bgColor: '#123456' }, world)).success).toBe(
      true,
    )
    expect(world.scenes[0].bgColor).toBe('#123456')

    expect(
      (await callSceneProps({ op: 'transition', sceneId: 'scene-1', transition: 'crossfade' }, world)).success,
    ).toBe(true)
    expect(world.scenes[0].transition).toBe('crossfade')

    expect((await callSceneProps({ op: 'transition_all', transition: 'dissolve' }, world)).success).toBe(true)
    expect(world.scenes.map((s) => s.transition)).toEqual(['dissolve', 'dissolve'])

    expect(enumOf('scene_props', 'op').sort()).toEqual(['background', 'duration', 'transition', 'transition_all'])
  })

  it('keeps the whole transition catalog — this is what stops every cut going hard', async () => {
    // normalizeTransition degrades anything outside the catalog to 'none', so an enum
    // that lost values (or was hand-typed and drifted) silently reintroduces the
    // all-hard-cuts defect. Assert the schema enum IS the catalog.
    const advertised = enumOf('scene_props', 'transition')
    expect(advertised).toEqual([...ALL_TRANSITION_IDS])
    expect(advertised.length).toBeGreaterThanOrEqual(36)
    expect(advertised).toContain('none')
    expect(advertised).toContain('crossfade')

    // …and every advertised id survives a real write, rather than degrading to 'none'.
    const world = makeWorld([makeScene()])
    const degraded: string[] = []
    for (const id of advertised) {
      await callSceneProps({ op: 'transition', sceneId: 'scene-1', transition: id }, world)
      if (world.scenes[0].transition !== id) degraded.push(id)
    }
    expect(degraded, 'transition ids advertised but not written through').toEqual([])
  })

  it('errors honestly on an invalid op, and never flattens transitions by accident', async () => {
    const world = makeWorld([makeScene(), makeScene({ id: 'scene-2' })])
    const bad = await callSceneProps({ op: 'colour', sceneId: 'scene-1' }, world)
    expect(bad.success).toBe(false)
    expect(bad.error).toMatch(/unknown op/i)

    // A transition_all with no transition would normalize to 'none' — i.e. flatten the
    // whole video to hard cuts. Refuse instead.
    const noTransition = await callSceneProps({ op: 'transition_all' }, world)
    expect(noTransition.success).toBe(false)

    // The plan-fidelity guard must survive the merge: a plan that deliberately
    // varies transitions per scene is not flattened.
    const planned = makeWorld([makeScene(), makeScene({ id: 'scene-2' })])
    ;(planned as unknown as { scenePlan: unknown }).scenePlan = {
      scenes: [{ transition: 'crossfade' }, { transition: 'wipe-left' }],
    }
    const skipped = await callSceneProps({ op: 'transition_all', transition: 'dissolve' }, planned)
    expect(skipped.success).toBe(true)
    expect(String(skipped.changes?.[0]?.description ?? '')).toMatch(/skipped/i)
    expect(planned.scenes.every((s) => s.transition !== 'dissolve')).toBe(true)
  })
})

describe('generate_image(source)', () => {
  it('advertises exactly the three sources the executor routes', () => {
    // source:'prompt' runs the image-video handler; 'reference' and 'regenerate' are
    // routed to the media-library handler (tool-executor.ts). A fourth value here with
    // no route would be a phantom.
    expect(enumOf('generate_image', 'source').sort()).toEqual(['prompt', 'reference', 'regenerate'])
  })

  it('carries the union of all three members inputs', () => {
    const props = Object.keys(schemaProps('generate_image'))
    // One per absorbed member's identifying arg — dropping any of these would delete
    // the capability rather than merge it.
    for (const p of ['sceneId', 'referenceAssetId', 'assetId', 'promptOverride', 'enhanceTags'])
      expect(props, `generate_image lost ${p}`).toContain(p)
  })
})

describe('find_media(kind)', () => {
  it('every advertised kind reaches its own provider branch', async () => {
    const world = makeWorld([makeScene()])
    world.webSearchEnabled = false // media discovery must NOT ride the Web Search switch
    // '3d' and 'lottie' were absorbed from search_3d_models / search_lottie. They live
    // in the three/world handler, so tool-executor — not this handler — routes them;
    // exercise only the three provider kinds researchHandler itself owns.
    const kinds = enumOf('find_media', 'kind')
    expect(kinds.sort()).toEqual(['3d', 'archival', 'image', 'lottie', 'video'])
    const providerKinds = kinds.filter((k) => k !== '3d' && k !== 'lottie')

    routed.length = 0
    for (const kind of providerKinds) {
      const r = await researchHandler('find_media', { kind, query: 'apollo 11' }, world)
      expect(r.success, `kind:${kind} — ${r.error}`).toBe(true)
      // …and the result still carries its discriminator, which is how harvest.ts and
      // the chat UI tell the three provider shapes apart.
      expect((r.data as { kind?: string }).kind).toBe(kind)
    }
    // Each kind hit a DIFFERENT provider entry point — not one shared one.
    expect(routed.sort()).toEqual(['archival', 'image', 'video'])
  })

  it('errors honestly on an invalid kind', async () => {
    const world = makeWorld([makeScene()])
    const bad = await researchHandler('find_media', { kind: 'audio', query: 'x' }, world)
    expect(bad.success).toBe(false)
    expect(bad.error).toMatch(/unknown kind/i)
  })
})
