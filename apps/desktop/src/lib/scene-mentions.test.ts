import { describe, it, expect } from 'vitest'
import { getMentionQuery, filterScenesForMention, insertMention, buildMentionNote } from './scene-mentions'

const SCENES = [
  { id: 'a1', name: 'Intro', sceneType: 'react', duration: 8 },
  { id: 'b2', name: 'Intro Detail', sceneType: 'react', duration: 12 },
  { id: 'c3', name: 'Outro', sceneType: 'canvas2d', duration: 5 },
  { id: 'd4', name: 'Chart scene' },
]

describe('getMentionQuery', () => {
  it('detects the active @token at the end of input', () => {
    expect(getMentionQuery('fix @In')).toBe('In')
    expect(getMentionQuery('@')).toBe('')
    expect(getMentionQuery('make it pop')).toBeNull()
  })

  it('requires @ at start or after whitespace (emails do not trigger)', () => {
    expect(getMentionQuery('mail me@example')).toBeNull()
    expect(getMentionQuery('see @Out')).toBe('Out')
  })

  it('dies at whitespace — a completed mention is no longer active', () => {
    expect(getMentionQuery('fix @Intro please')).toBeNull()
  })
})

describe('filterScenesForMention', () => {
  it('ranks prefix matches before substring matches, case-insensitive', () => {
    const out = filterScenesForMention(SCENES, 'in')
    expect(out.map((s) => s.name)).toEqual(['Intro', 'Intro Detail'])
  })

  it('substring matches included after prefixes', () => {
    const out = filterScenesForMention(SCENES, 'tro')
    expect(out.map((s) => s.name)).toEqual(['Intro', 'Intro Detail', 'Outro'])
  })

  it('empty query lists scenes (capped)', () => {
    expect(filterScenesForMention(SCENES, '').length).toBe(4)
  })
})

describe('insertMention', () => {
  it('replaces the trailing token with the full name + trailing space', () => {
    expect(insertMention('tighten @In', 'Intro Detail')).toBe('tighten @Intro Detail ')
    expect(insertMention('@', 'Outro')).toBe('@Outro ')
  })
})

describe('buildMentionNote', () => {
  it('resolves a mention to its scene id with metadata', () => {
    const note = buildMentionNote('speed up @Outro a bit', SCENES)
    expect(note).toContain('"Outro" (sceneId c3; canvas2d, 5s)')
    expect(note).toContain('Target scenes by sceneId and layers by layerId')
  })

  it('longest name wins — "@Intro Detail" never half-matches "Intro"', () => {
    const note = buildMentionNote('rework @Intro Detail now', SCENES)!
    expect(note).toContain('sceneId b2')
    expect(note).not.toContain('sceneId a1')
  })

  it('both scenes resolve when both are mentioned', () => {
    const note = buildMentionNote('@Intro then @Intro Detail', SCENES)!
    expect(note).toContain('sceneId a1')
    expect(note).toContain('sceneId b2')
  })

  it('duplicate names resolve to every match (ambiguity surfaced, not guessed)', () => {
    const dupes = [
      { id: 'x1', name: 'Scene' },
      { id: 'x2', name: 'Scene' },
    ]
    const note = buildMentionNote('fix @Scene', dupes)!
    expect(note).toContain('x1')
    expect(note).toContain('x2')
  })

  it('mention followed by punctuation still resolves', () => {
    expect(buildMentionNote('what about @Outro?', SCENES)).toContain('sceneId c3')
  })

  it('returns null when nothing resolves (plain @ or unknown name)', () => {
    expect(buildMentionNote('email me @ home', SCENES)).toBeNull()
    expect(buildMentionNote('fix @Nonexistent', SCENES)).toBeNull()
    expect(buildMentionNote('no mentions here', SCENES)).toBeNull()
  })

  it('regex metacharacters in scene names cannot break resolution', () => {
    const tricky = [{ id: 't1', name: 'A+B (final)' }]
    expect(buildMentionNote('tweak @A+B (final) now', tricky)).toContain('t1')
  })
})

// ── D6 v2: layer mentions (AI layers by label) ────────────────────────────────

import { collectMentionTargets, filterTargetsForMention } from './scene-mentions'

const LAYERED = [
  {
    id: 'a1',
    name: 'Intro',
    sceneType: 'react',
    duration: 8,
    aiLayers: [
      { id: 'L1', label: 'Host avatar' },
      { id: 'L2', label: '' }, // unlabeled — never mentionable
    ],
  },
  { id: 'b2', name: 'Outro', sceneType: 'react', duration: 5, aiLayers: [{ id: 'L3', label: 'Logo sting' }] },
]

describe('collectMentionTargets', () => {
  it('flattens scenes + labeled AI layers, skipping unlabeled ones', () => {
    const t = collectMentionTargets(LAYERED)
    expect(t.map((x) => `${x.kind}:${x.name}`)).toEqual([
      'scene:Intro',
      'layer:Host avatar',
      'scene:Outro',
      'layer:Logo sting',
    ])
    const layer = t.find((x) => x.id === 'L1')!
    expect(layer).toMatchObject({ sceneId: 'a1', sceneName: 'Intro', detail: 'layer · in Intro' })
  })
})

describe('filterTargetsForMention', () => {
  it('filters across kinds, prefix first', () => {
    const t = collectMentionTargets(LAYERED)
    expect(filterTargetsForMention(t, 'ho').map((x) => x.name)).toEqual(['Host avatar'])
    expect(filterTargetsForMention(t, 'o').map((x) => x.name)).toEqual(['Outro', 'Intro', 'Host avatar', 'Logo sting'])
  })
})

describe('buildMentionNote — layers', () => {
  it('resolves a layer mention to layerId + owning scene', () => {
    const note = buildMentionNote('swap @Host avatar for the new take', LAYERED)!
    expect(note).toContain('"Host avatar" (layerId L1 in scene "Intro" sceneId a1)')
    expect(note).toContain('layers by layerId')
  })

  it('a scene and a layer sharing a name BOTH resolve (ambiguity surfaced)', () => {
    const tricky = [
      { id: 's1', name: 'Logo', aiLayers: [] },
      { id: 's2', name: 'Outro', aiLayers: [{ id: 'L9', label: 'Logo' }] },
    ]
    const note = buildMentionNote('animate @Logo', tricky)!
    expect(note).toContain('sceneId s1')
    expect(note).toContain('layerId L9')
  })

  it('scene mentions keep their original shape', () => {
    const note = buildMentionNote('tighten @Intro', LAYERED)!
    expect(note).toContain('"Intro" (sceneId a1; react, 8s)')
  })
})
