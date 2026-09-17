import { describe, expect, it } from 'vitest'
import { deriveStoryboard, renderStoryboardBlock, type StoryboardBeat } from './storyboard'
import { buildTaskPacket, renderTaskPacket } from './orchestrator'
import type { SceneSpec } from './types'

describe('deriveStoryboard — a storyboard is always present by construction', () => {
  it('returns author-provided beats verbatim', () => {
    const authored: StoryboardBeat[] = [
      { kind: 'text', copy: 'A' },
      { kind: 'animation', copy: 'B' },
    ]
    expect(deriveStoryboard({ storyboard: authored })).toEqual(authored)
  })

  it('NEVER truncates an over-long author list — a hand-authored shot list is intentional (③.6)', () => {
    const many: StoryboardBeat[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'text', copy: `${i}` }))
    const warns: string[] = []
    const beats = deriveStoryboard({ storyboard: many }, (m) => warns.push(m))
    // All 10 kept (was silently dropped to 6 — the "dropped story beats" defect).
    expect(beats).toEqual(many)
    // Author beats are never truncated, so no truncation warning fires.
    expect(warns).toEqual([])
  })

  it('warns (never silently) when a DERIVED narration split is truncated at the cap', () => {
    const narrationDraft = Array.from({ length: 9 }, (_, i) => `Beat ${i + 1} happens.`).join(' ')
    const warns: string[] = []
    const beats = deriveStoryboard({ narrationDraft }, (m) => warns.push(m))
    expect(beats).toHaveLength(6) // derived split still capped (mechanical, bounded)
    expect(warns.some((w) => /truncated to 6 beats/.test(w))).toBe(true)
  })

  it('pads a single authored beat to >= 2 (no self-contradicting one-station plan)', () => {
    const beats = deriveStoryboard({ storyboard: [{ kind: 'text', copy: 'Only one' }] })
    expect(beats.length).toBe(2)
    expect(beats[0].copy).toBe('Only one')
  })

  it('accepts visualElements as an array without corrupting comma-bearing elements', () => {
    const beats = deriveStoryboard({ visualElements: ['a red, glowing coin', 'a ledger'] })
    expect(beats).toHaveLength(2)
    expect(beats.map((b) => b.copy)).toEqual(['a red, glowing coin', 'a ledger'])
  })

  it('derives alternating TEXT/ANIMATION beats from narration', () => {
    const beats = deriveStoryboard({
      narrationDraft: 'Solana is fast. It uses proof of history. That orders transactions before consensus.',
    })
    expect(beats.length).toBeGreaterThanOrEqual(3)
    expect(beats[0].kind).toBe('text')
    expect(beats[1].kind).toBe('animation')
    expect(beats[0].copy).toMatch(/Solana is fast/)
    expect(beats.every((b) => b.station)).toBe(true)
  })

  it('pads a single-sentence narration to at least two stations (FLOW needs travel)', () => {
    const beats = deriveStoryboard({ narrationDraft: 'One idea, no punctuation split here' })
    expect(beats.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to visualElements when there is no narration', () => {
    const beats = deriveStoryboard({ visualElements: 'a coin, a ledger, a clock' })
    expect(beats).toHaveLength(3)
    expect(beats.every((b) => b.kind === 'animation')).toBe(true)
    expect(beats.map((b) => b.copy)).toEqual(['a coin', 'a ledger', 'a clock'])
  })

  it('falls back to a two-beat skeleton from purpose when nothing else is given', () => {
    const beats = deriveStoryboard({ purpose: 'Explain hashing' })
    expect(beats).toHaveLength(2)
    expect(beats[0].copy).toMatch(/Explain hashing/)
  })

  it('caps derived narration at 6 beats', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence ${i}.`).join(' ')
    expect(deriveStoryboard({ narrationDraft: long })).toHaveLength(6)
  })
})

describe('renderStoryboardBlock', () => {
  it('renders a mandatory, numbered shot list with kinds and stations', () => {
    const block = renderStoryboardBlock([
      { kind: 'text', copy: 'Hook line', station: 'station 1' },
      { kind: 'animation', copy: 'Reveal', station: 'station 2' },
    ])
    expect(block).toContain('## Storyboard')
    expect(block).toContain('1. [TEXT] Hook line — station 1')
    expect(block).toContain('2. [ANIMATION] Reveal — station 2')
    expect(block).toMatch(/camera/i)
  })

  it('returns empty string for no beats', () => {
    expect(renderStoryboardBlock([])).toBe('')
    expect(renderStoryboardBlock(undefined)).toBe('')
  })
})

describe('storyboard reaches the sub-agent prompt (wire)', () => {
  const spec: SceneSpec = {
    name: 'Hook',
    purpose: 'Explain why Solana is fast',
    sceneType: 'react',
    duration: 8,
    narrationDraft: 'Solana is fast. It uses proof of history. Transactions are ordered before consensus.',
  }

  it('buildTaskPacket derives + attaches a storyboard even for a spec built outside plan_scenes', () => {
    const packet = buildTaskPacket(spec)
    expect(packet.storyboard && packet.storyboard.length).toBeGreaterThanOrEqual(2)
    expect(packet.acceptanceCriteria.some((c) => /storyboard/i.test(c))).toBe(true)
  })

  it('renderTaskPacket emits the mandatory shot-list block into the prompt', () => {
    const prompt = renderTaskPacket(buildTaskPacket(spec))
    expect(prompt).toContain('## Storyboard')
    expect(prompt).toMatch(/\[TEXT\]|\[ANIMATION\]/)
  })

  it('honours an author-provided storyboard over the derived one', () => {
    const authored: StoryboardBeat[] = [
      { kind: 'text', copy: 'Custom hook', station: 'A' },
      { kind: 'animation', copy: 'Custom reveal', station: 'B' },
    ]
    const prompt = renderTaskPacket(buildTaskPacket({ ...spec, storyboard: authored }))
    expect(prompt).toContain('Custom hook')
    expect(prompt).toContain('Custom reveal')
  })
})
