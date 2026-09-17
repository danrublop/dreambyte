import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the notes query the grounding helper reads.
const findRelevantNotes = vi.fn()
vi.mock('@/lib/db/queries/research-notes', () => ({
  findRelevantNotes: (...a: unknown[]) => findRelevantNotes(...a),
  insertResearchNote: vi.fn(),
}))

import { renderResearchGrounding } from './research-memory'

afterEach(() => vi.clearAllMocks())

describe('renderResearchGrounding', () => {
  it('returns the most-recent note brief wrapped as a grounding block', async () => {
    findRelevantNotes.mockResolvedValue([
      { brief: 'Morocco reached the 2022 semi-final. Coach: Walid Regragui.\n\n## Staged assets\n- `a1` — hero' },
    ])
    const out = await renderResearchGrounding('proj-1')
    expect(out).toContain('## Researched facts — GROUND every scene in these')
    expect(out).toContain('Walid Regragui')
    expect(out).toContain('`a1` — hero') // staged assets carried through
    expect(findRelevantNotes).toHaveBeenCalledWith('proj-1', null, expect.any(Number))
  })

  it('returns empty for no project id, no notes, or a blank brief (never blocks the build)', async () => {
    expect(await renderResearchGrounding(undefined)).toBe('')
    findRelevantNotes.mockResolvedValue([])
    expect(await renderResearchGrounding('p')).toBe('')
    findRelevantNotes.mockResolvedValue([{ brief: '   ' }])
    expect(await renderResearchGrounding('p')).toBe('')
  })

  it('swallows a query failure and returns empty', async () => {
    findRelevantNotes.mockRejectedValue(new Error('db down'))
    expect(await renderResearchGrounding('p')).toBe('')
  })
})
