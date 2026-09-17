/**
 * Min-unique id-prefix compression.
 *
 * Pins the contract: shortest unique prefix (>= floor) on output, lossless
 * expansion back to the full id on input, a clear throw on an ambiguous prefix,
 * and verbatim passthrough of ids not in the universe — so the round trip the
 * agent relies on (read short → name short → tool runs on the full id) is safe.
 */

import { describe, it, expect } from 'vitest'
import type { Scene, SceneLayer } from '@/lib/types/scene'
import type { ContentPanel, AvatarLayer } from '@/lib/types/ai-layer'
import type { PublishedScene } from '@/lib/types/project'
import type { RevealElement } from '@/lib/types/interaction'
import {
  ID_PREFIX_FLOOR,
  shortIdMap,
  shortenIdsInText,
  shortenIdsDeep,
  expandIdPrefix,
  collectIdUniverse,
  CODE_BEARING_KEYS,
  AmbiguousIdError,
} from './short-id'

// Distinct UUIDs that diverge well before the floor.
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
// Two ids sharing a long common prefix (collide past the floor) — forces a
// prefix longer than the floor to stay unique.
const P1 = 'abcdef01-2345-4678-9abc-def012345678'
const P2 = 'abcdef01-2345-4678-9abc-def0FFFFFFFF'.toLowerCase()

describe('shortIdMap', () => {
  it('uses exactly the floor when ids diverge immediately', () => {
    const map = shortIdMap([A, B, C])
    for (const id of [A, B, C]) {
      expect(map.get(id)).toBe(id.slice(0, ID_PREFIX_FLOOR))
      expect(map.get(id)!.length).toBe(ID_PREFIX_FLOOR)
    }
  })

  it('grows past the floor only as far as needed for uniqueness', () => {
    const map = shortIdMap([P1, P2])
    const s1 = map.get(P1)!
    const s2 = map.get(P2)!
    // They share more than the floor, so prefixes must be longer than the floor…
    expect(s1.length).toBeGreaterThan(ID_PREFIX_FLOOR)
    // …and must differ (be unique).
    expect(s1).not.toBe(s2)
    // …but not longer than the first differing char + 1.
    let firstDiff = 0
    while (P1[firstDiff] === P2[firstDiff]) firstDiff++
    expect(s1.length).toBe(firstDiff + 1)
  })

  it('returns an empty map for an empty universe', () => {
    expect(shortIdMap([]).size).toBe(0)
  })

  it('only the ids in a long shared run grow; an unrelated id stays at the floor', () => {
    const map = shortIdMap([P1, A, P2])
    expect(map.get(A)).toBe(A.slice(0, ID_PREFIX_FLOOR))
    expect(map.get(P1)).toBe('abcdef01-2345-4678-9abc-def01')
    expect(map.get(P2)).toBe('abcdef01-2345-4678-9abc-def0f')
  })
})

describe('shorten → expand round-trip', () => {
  it('every shortened id expands back to its full id', () => {
    const universe = new Set([A, B, C, P1, P2])
    const map = shortIdMap(universe)
    for (const id of universe) {
      const short = map.get(id)!
      expect(expandIdPrefix(short, universe)).toBe(id)
    }
  })

  it('round-trips a large random universe with every prefix unique', () => {
    const hex = () => Math.floor(Math.random() * 16).toString(16)
    const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, hex)
    // Seed some ids that share long runs so the neighbour comparison matters.
    const ids = new Set<string>(Array.from({ length: 3000 }, uuid))
    for (let i = 0; i < 50; i++) ids.add(P1.slice(0, 20) + uuid().slice(20))
    const map = shortIdMap(ids)
    expect(new Set(map.values()).size).toBe(ids.size)
    for (const id of ids) expect(expandIdPrefix(map.get(id)!, ids)).toBe(id)
  })

  it('does not expand refs shorter than the floor', () => {
    expect(expandIdPrefix(A.slice(0, ID_PREFIX_FLOOR - 1), new Set([A]))).toBe(A.slice(0, ID_PREFIX_FLOOR - 1))
  })

  it('a full id expands to itself', () => {
    const universe = new Set([A, B])
    expect(expandIdPrefix(A, universe)).toBe(A)
  })
})

describe('expandIdPrefix edge cases', () => {
  it('throws AmbiguousIdError when a prefix matches more than one id', () => {
    const universe = new Set([P1, P2])
    // The shared run is unambiguously a prefix of BOTH.
    const sharedPrefix = 'abcdef01-2345-4678-9abc-def0'
    expect(() => expandIdPrefix(sharedPrefix, universe)).toThrow(AmbiguousIdError)
    try {
      expandIdPrefix(sharedPrefix, universe)
    } catch (e) {
      expect((e as AmbiguousIdError).matchCount).toBe(2)
      expect((e as Error).message).toMatch(/ambiguous/i)
    }
  })

  it('returns an unknown ref untouched (tool emits its own not-found)', () => {
    const universe = new Set([A, B])
    expect(expandIdPrefix('deadbeef', universe)).toBe('deadbeef')
  })
})

describe('shortenIdsInText', () => {
  it('shortens known ids and leaves unknown UUIDs intact', () => {
    const universe = new Set([A, B])
    const unknown = '99999999-9999-4999-8999-999999999999'
    const text = `track ${A} clip ${B} asset ${unknown}`
    const out = shortenIdsInText(text, universe)
    expect(out).toContain(A.slice(0, ID_PREFIX_FLOOR))
    expect(out).toContain(B.slice(0, ID_PREFIX_FLOOR))
    // Unknown UUID is not in the universe → passes through verbatim.
    expect(out).toContain(unknown)
  })

  it('is a no-op for an empty universe', () => {
    const text = `id ${A}`
    expect(shortenIdsInText(text, new Set())).toBe(text)
  })
})

describe('shortenIdsDeep', () => {
  it('shortens UUID string values recursively, leaving non-strings and unknown ids', () => {
    const universe = new Set([A, B])
    const data = {
      tracks: [
        { id: A, name: 'V1', clips: [{ id: B, startTime: 0 }] },
        { id: 'legacy-short', label: `unknown ${'77777777-7777-4777-8777-777777777777'}` },
      ],
      count: 2,
    }
    const out = shortenIdsDeep(data, universe) as any
    expect(out.tracks[0].id).toBe(A.slice(0, ID_PREFIX_FLOOR))
    expect(out.tracks[0].clips[0].id).toBe(B.slice(0, ID_PREFIX_FLOOR))
    expect(out.tracks[1].id).toBe('legacy-short')
    expect(out.tracks[1].label).toContain('77777777-7777-4777-8777-777777777777')
    expect(out.count).toBe(2)
    // Input is not mutated.
    expect(data.tracks[0].id).toBe(A)
  })
})

describe('mint-universe must equal expand-universe', () => {
  // P1 = a scene id, P2 = a layer id that shares P1's first 9+ hex chars. The
  // MCP read surface mints the scene prefix; a mutating tool expands it against
  // the FULL universe (scenes + layers + clips). The two must use ONE universe.
  const sceneId = P1
  const layerId = P2
  const full = new Set([sceneId, layerId])

  it('minting against a scenes-ONLY universe yields a prefix that is AMBIGUOUS at expand time (the bug)', () => {
    // Old behavior: mint the scene prefix knowing only scenes…
    const narrow = shortIdMap([sceneId]).get(sceneId)!
    expect(narrow.length).toBe(ID_PREFIX_FLOOR) // floor-length, unaware of the layer
    // …then the write path expands it against scenes + layers → collision.
    expect(() => expandIdPrefix(narrow, full)).toThrow(AmbiguousIdError)
  })

  it('minting against the FULL universe yields a prefix that expands back uniquely (the fix)', () => {
    const minted = shortIdMap(full).get(sceneId)!
    // Forced past the floor to clear the shared run with the layer id…
    expect(minted.length).toBeGreaterThan(ID_PREFIX_FLOOR)
    // …so expanding it against the same full universe round-trips, no throw.
    expect(expandIdPrefix(minted, full)).toBe(sceneId)
  })
})

describe('shortenIdsDeep key-scoped (skipKeys)', () => {
  // The load-bearing read_scene hazard: a scene's rendered code embeds its own
  // scene UUID verbatim (var SCENE_ID = '<uuid>', getElementById('<uuid>')). If
  // the dump shortener rewrote that UUID, a later patch_layer_code would copy
  // back broken code. Code-bearing fields must round-trip BYTE-IDENTICAL while
  // structural id fields still shrink.
  it('leaves a UUID embedded in code fields verbatim, but still shortens structural ids', () => {
    const universe = new Set([A, B])
    const scene = {
      id: A,
      primaryObjectId: B,
      summary: `scene ${A} verified`, // non-code string → shortened in place
      reactCode: `var SCENE_ID = '${A}'; document.getElementById('${B}')`,
      sceneCode: `// layer ${B}`,
      svgContent: `<g id="${A}">`,
      sceneHTML: `<div data-scene="${A}">`,
      sceneStyles: `#${A.replace(/-/g, '')} { color: red }`,
      lottieSource: `{"id":"${A}"}`,
      canvasCode: `ctx.fillText('${A}', 0, 0)`,
      html: `<span>${B}</span>`,
      aiLayers: [{ id: B, generatedCode: `el('${A}')` }],
    }
    const out = shortenIdsDeep(scene, universe, { skipKeys: CODE_BEARING_KEYS }) as any
    const shortA = A.slice(0, ID_PREFIX_FLOOR)
    const shortB = B.slice(0, ID_PREFIX_FLOOR)

    // Structural id fields shrink.
    expect(out.id).toBe(shortA)
    expect(out.primaryObjectId).toBe(shortB)
    expect(out.aiLayers[0].id).toBe(shortB)
    // Embedded ids in non-code strings still shrink.
    expect(out.summary).toBe(`scene ${shortA} verified`)

    // Every code/markup field is byte-identical to the input — no truncation.
    for (const key of [
      'reactCode',
      'sceneCode',
      'svgContent',
      'sceneHTML',
      'sceneStyles',
      'lottieSource',
      'canvasCode',
      'html',
    ] as const) {
      expect(out[key], `${key} must round-trip verbatim`).toBe((scene as any)[key])
    }
    expect(out.aiLayers[0].generatedCode).toBe(scene.aiLayers[0].generatedCode)
    // Fields that embedded a full UUID still carry it full-length (never shrunk).
    expect(out.reactCode).toContain(A)
    expect(out.reactCode).toContain(B)
    expect(out.aiLayers[0].generatedCode).toContain(A)
  })

  it('without skipKeys, the same code field WOULD be corrupted (proves the guard is load-bearing)', () => {
    const universe = new Set([A])
    const scene = { reactCode: `getElementById('${A}')` }
    const unguarded = shortenIdsDeep(scene, universe) as any
    // Demonstrates the bug the skipKeys guard prevents: the embedded id is
    // truncated, so this copied-back code would target a non-existent element.
    expect(unguarded.reactCode).not.toContain(A)
    expect(unguarded.reactCode).toContain(A.slice(0, ID_PREFIX_FLOOR))
  })
})

describe('CODE_BEARING_KEYS completeness guard', () => {
  // CODE_BEARING_KEYS is a fail-OPEN denylist on a corruption-critical path:
  // read_scene shortens UUIDs everywhere EXCEPT these keys, so a verbatim
  // code/markup field missing from the set would have its embedded ids silently
  // truncated (and a later patch_layer_code would copy back broken code). This
  // guard pins the set to the real types two ways:
  //   1. Compile time — each `satisfies (keyof X)[]` clause type-checks the
  //      field NAMES against their source interface, so renaming/removing a
  //      field in the type breaks THIS list (a visible prompt to re-sync).
  //   2. Run time — the assertion fails if any curated field is not in
  //      CODE_BEARING_KEYS. When you ADD a new verbatim code/markup field to any
  //      of these types, add it to BOTH the group below AND CODE_BEARING_KEYS
  //      (src/lib/agents/short-id.ts) or this test goes red.
  const sceneFields = [
    'svgContent',
    'canvasCode',
    'canvasBackgroundCode',
    'sceneCode',
    'reactCode',
    'sceneHTML',
    'sceneStyles',
    'lottieSource',
  ] as const satisfies readonly (keyof Scene)[]
  const layerFields = ['generatedCode'] as const satisfies readonly (keyof SceneLayer)[]
  const contentPanelFields = ['html'] as const satisfies readonly (keyof ContentPanel)[]
  const avatarFields = ['script'] as const satisfies readonly (keyof AvatarLayer)[]
  const publishedFields = ['htmlContent'] as const satisfies readonly (keyof PublishedScene)[]
  const revealFields = ['revealedContent'] as const satisfies readonly (keyof RevealElement)[]

  it('CODE_BEARING_KEYS is a superset of every known code/markup field', () => {
    const known: string[] = [
      ...sceneFields,
      ...layerFields,
      ...contentPanelFields,
      ...avatarFields,
      ...publishedFields,
      ...revealFields,
    ]
    const missing = known.filter((k) => !CODE_BEARING_KEYS.has(k))
    expect(missing, `these code/markup fields are NOT skipped: ${missing.join(', ')}`).toEqual([])
  })
})

describe('collectIdUniverse', () => {
  it('gathers scene, layer, timeline track/clip and checkpoint UUIDs (only well-formed ones)', () => {
    const world = {
      scenes: [
        {
          id: A,
          aiLayers: [{ id: B }],
          textOverlays: [{ id: 'not-a-uuid' }],
        },
      ],
      timeline: {
        tracks: [{ id: C, clips: [{ id: P1 }] }],
        markers: [{ id: P2 }],
      },
      checkpoints: [{ id: '88888888-8888-4888-8888-888888888888' }],
    }
    const u = collectIdUniverse(world)
    expect(u.has(A)).toBe(true)
    expect(u.has(B)).toBe(true)
    expect(u.has(C)).toBe(true)
    expect(u.has(P1)).toBe(true)
    expect(u.has(P2)).toBe(true)
    expect(u.has('88888888-8888-4888-8888-888888888888')).toBe(true)
    // Non-UUID id is rejected (legacy short ids stay full-length).
    expect(u.has('not-a-uuid')).toBe(false)
  })

  it('returns an empty set for an empty world', () => {
    expect(collectIdUniverse({}).size).toBe(0)
  })
})
