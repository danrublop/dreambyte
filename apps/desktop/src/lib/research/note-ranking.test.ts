import { describe, it, expect } from 'vitest'
import { rankNotes, cosine, THIRTY_DAYS_MS, type RankableNote } from './note-ranking'

const NOW = 1_700_000_000_000
const MODEL = 'Xenova/all-MiniLM-L6-v2'
const DIM = 3 // small vectors for the test; rankNotes uses opts.embedDim, not the real 384

function note(p: Partial<RankableNote>): RankableNote {
  return {
    id: p.id ?? 'n',
    topic: p.topic ?? 't',
    brief: p.brief ?? 'b',
    embedding: p.embedding ?? null,
    embedModel: p.embedModel ?? MODEL,
    embedDim: p.embedDim ?? DIM,
    createdAt: p.createdAt ?? NOW,
  }
}
const base = { embedModel: MODEL, embedDim: DIM, nowMs: NOW }

describe('cosine', () => {
  it('is the dot product for unit vectors; -1 on shape mismatch', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBe(1)
    expect(cosine([1, 0, 0], [0, 1, 0])).toBe(0)
    expect(cosine([1, 0], [1, 0, 0])).toBe(-1)
  })
})

describe('rankNotes — semantic path', () => {
  it('returns notes at/above threshold, ranked by similarity', () => {
    const near = note({ id: 'near', embedding: [0.99, 0.14, 0] })
    const far = note({ id: 'far', embedding: [0, 1, 0] })
    const out = rankNotes([far, near], { ...base, queryEmbedding: [1, 0, 0], threshold: 0.75 })
    expect(out.map((n) => n.id)).toEqual(['near'])
  })

  it('returns EMPTY (no reuse) when nothing clears the threshold', () => {
    const far = note({ id: 'far', embedding: [0, 1, 0] })
    const out = rankNotes([far], { ...base, queryEmbedding: [1, 0, 0], threshold: 0.75 })
    expect(out).toEqual([])
  })

  it('excludes notes from a different embed model/dim (no cross-space poisoning)', () => {
    const wrongModel = note({ id: 'wm', embedding: [1, 0, 0], embedModel: 'other' })
    const wrongDim = note({ id: 'wd', embedding: [1, 0, 0, 0], embedDim: 4 })
    const out = rankNotes([wrongModel, wrongDim], { ...base, queryEmbedding: [1, 0, 0] })
    expect(out).toEqual([])
  })

  it('excludes stale notes beyond the freshness window', () => {
    const old = note({ id: 'old', embedding: [1, 0, 0], createdAt: NOW - THIRTY_DAYS_MS - 1 })
    const out = rankNotes([old], { ...base, queryEmbedding: [1, 0, 0] })
    expect(out).toEqual([])
  })

  it('respects topK', () => {
    const notes = [0, 1, 2, 3].map((i) => note({ id: `n${i}`, embedding: [1, 0, 0] }))
    const out = rankNotes(notes, { ...base, queryEmbedding: [1, 0, 0], topK: 2 })
    expect(out).toHaveLength(2)
  })
})

describe('rankNotes — embedder-unavailable fallback', () => {
  it('degrades to most-recent fresh notes when queryEmbedding is null', () => {
    const older = note({ id: 'older', createdAt: NOW - 1000 })
    const newer = note({ id: 'newer', createdAt: NOW - 10 })
    const out = rankNotes([older, newer], { ...base, queryEmbedding: null, topK: 5 })
    expect(out.map((n) => n.id)).toEqual(['newer', 'older'])
  })

  it('still applies the freshness window in fallback', () => {
    const stale = note({ id: 'stale', createdAt: NOW - THIRTY_DAYS_MS - 1 })
    const out = rankNotes([stale], { ...base, queryEmbedding: null })
    expect(out).toEqual([])
  })
})
