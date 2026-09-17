// PR2 (context-correctness) — world-state serialization invariants.
//
// Covers three fixes:
//  - P1-3: react (the DEFAULT renderer) belongs in the SCENE TYPE MIX
//    vocabulary, so a react-only project doesn't serialize as "react absent /
//    every legacy type unused" (which steered the agent OFF react).
//  - P2: world-state ids are emitted as SHORT prefixes (matching the read tools),
//    never full 36-char UUIDs.
//  - P2: the focused-scene block gets its OWN sub-budget — a long scene-summary
//    list can no longer silently clip the focused scene's code from the tail.

import { describe, expect, it } from 'vitest'
import { buildWorldState, serializeWorldState } from './context-builder'
import type { Scene, GlobalStyle } from '../types'

function scene(id: string, over: Partial<Scene> = {}): Scene {
  return {
    id,
    name: id.toUpperCase(),
    prompt: 'a scene about something',
    sceneType: 'react',
    duration: 5,
    bgColor: '#000',
    transition: 'none',
    ...over,
  } as unknown as Scene
}

const STYLE: GlobalStyle = {
  presetId: null,
  palette: ['#000', '#111', '#222', '#333'],
  duration: 8,
  theme: 'light',
} as unknown as GlobalStyle

describe('serializeWorldState — SCENE TYPE MIX vocabulary (P1-3)', () => {
  it('counts react in the MIX for a react-only project (not "all unused")', () => {
    const scenes = [scene('s1'), scene('s2'), scene('s3')]
    const world = buildWorldState(scenes, STYLE, 'React Only', 'mp4', null)
    const out = serializeWorldState(world)

    // react appears with its real count — the old vocab omitted react entirely.
    expect(out).toContain('react(3)')
    // react must NOT be reported as an unused type when it's the only type used.
    expect(out).not.toMatch(/UNUSED TYPES:[^\n]*\breact\b/)
    // lottie is a first-class member of the vocabulary; zdog is retired
    // and no longer advertised in the MIX.
    expect(out).toContain('lottie(0)')
    expect(out).not.toContain('zdog(')
  })
})

describe('serializeWorldState — reuse STATUS gate (only on a parent first-turn prompt)', () => {
  const scenes = [scene('s1'), scene('s2')]

  it('emits the reuse imperative when reuseSignal is on', () => {
    const world = buildWorldState(scenes, STYLE, 'Existing', 'mp4', null)
    const out = serializeWorldState(world, { reuseSignal: true })
    expect(out).toMatch(/STATUS: existing project — 2 scene\(s\)/)
    expect(out).toContain('before generating anything new')
  })

  it('says build-from-scratch (not reuse) for an empty timeline with reuseSignal on', () => {
    const world = buildWorldState([], STYLE, 'Fresh', 'mp4', null)
    const out = serializeWorldState(world, { reuseSignal: true })
    expect(out).toContain('brand-new timeline')
    expect(out).not.toContain('before generating anything new')
  })

  it('OMITS the reuse STATUS entirely for a sub-agent / refresh (reuseSignal off or default)', () => {
    const world = buildWorldState(scenes, STYLE, 'Existing', 'mp4', null)
    expect(serializeWorldState(world)).not.toContain('STATUS:')
    expect(serializeWorldState(world, { reuseSignal: false })).not.toContain('STATUS:')
  })
})

describe('serializeWorldState — short id prefixes (P2)', () => {
  it('emits shortened id prefixes, not full UUIDs', () => {
    const A = '11111111-1111-1111-1111-111111111111'
    const B = '22222222-2222-2222-2222-222222222222'
    const scenes = [scene(A), scene(B)]
    const world = buildWorldState(scenes, STYLE, 'UUID Project', 'mp4', A)
    const out = serializeWorldState(world)

    // Full 36-char UUIDs must not leak into the world-state text.
    expect(out).not.toContain(A)
    expect(out).not.toContain(B)
    // The min-unique 8-char prefixes are what the read tools also emit.
    expect(out).toContain('11111111')
    expect(out).toContain('22222222')
  })
})

describe('serializeWorldState — focused-scene sub-budget (P2)', () => {
  it('keeps the focused-scene block even behind a very long scene-summary list', () => {
    // A long summary list used to eat the flat char cap and clip the focused
    // block (appended last) from the tail with no marker. Reserve its own budget.
    const many = Array.from({ length: 200 }, (_, i) =>
      scene(`s${i}`, { prompt: `scene number ${i} with a reasonably long descriptive prompt to bloat the head` }),
    )
    const focused = scene('s0', { reactCode: 'const Scene = () => <div>focused</div>; export default Scene;' })
    const scenes = [focused, ...many.slice(1)]
    const world = buildWorldState(scenes, STYLE, 'Big Project', 'mp4', 's0')
    const out = serializeWorldState(world)

    expect(out).toContain('FOCUSED SCENE')
    // The head is truncated, not the focused block.
    expect(out).toContain('scene list truncated')
  })

  it('emits an inspect(kind:code) pointer when the focused block itself overflows its sub-budget', () => {
    // Build an oversized focused block (many layers) so it exceeds the focused
    // sub-budget and the outer cap must trim it — with an actionable pointer.
    const textOverlays = Array.from({ length: 400 }, (_, i) => ({
      id: `ov-${i}`,
      content: `overlay ${i} with a fair amount of descriptive text to grow the block`,
      font: 'Inter',
      size: 40,
      color: '#fff',
      x: 10,
      y: 10,
      animation: 'fade',
      delay: 0,
      duration: 2,
    }))
    const focused = scene('big', { textOverlays } as Partial<Scene>)
    const world = buildWorldState([focused], STYLE, 'Overflow', 'mp4', 'big')
    const out = serializeWorldState(world)

    expect(out).toContain("inspect(kind:'code') for scene")
  })
})
