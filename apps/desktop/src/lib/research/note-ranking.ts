/**
 * Pure ranking for research-memory reuse. No db, no `server-only`, no model — so
 * the threshold / staleness / model-guard logic is unit-testable in isolation.
 *
 *   embedder UP   → return notes with cosine ≥ threshold (may be empty → no reuse)
 *   embedder DOWN → degrade to the most-recent K fresh notes (outside-voice #1 fallback)
 *
 * Cross-space poisoning (outside-voice #2): only notes whose embedModel + embedDim
 * match the CURRENT embedder are eligible for cosine; others are ignored.
 * Staleness (outside-voice #9): notes older than maxAgeMs are never injected — a
 * months-old "latest X" is not "prior research."
 */

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
// all-MiniLM-L6-v2 puts genuine paraphrases/adjacent topics around 0.55–0.72 and
// unrelated pairs well below (~0.1–0.35), so 0.75 missed the exact adjacent-topic
// reuse this feature exists for ("history of the Eiffel Tower" vs "Eiffel Tower
// construction timeline" ≈ 0.68). 0.6 catches those while staying above unrelated.
// Calibrated against the real embedder in note-ranking.embed.test.ts.
export const DEFAULT_THRESHOLD = 0.6
export const DEFAULT_TOP_K = 3

export interface RankableNote {
  id: string
  topic: string
  brief: string
  embedding: number[] | null
  embedModel: string | null
  embedDim: number | null
  createdAt: Date | number
}

export interface RankOpts {
  /** Embedding of the incoming task, or null when the embedder is unavailable. */
  queryEmbedding: number[] | null
  embedModel: string
  embedDim: number
  nowMs: number
  threshold?: number
  topK?: number
  maxAgeMs?: number
}

/** Cosine of two unit-normalized vectors == dot product. -1 on shape mismatch. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

function toMs(t: Date | number): number {
  return t instanceof Date ? t.getTime() : t
}

export function rankNotes(notes: RankableNote[], opts: RankOpts): RankableNote[] {
  const {
    queryEmbedding,
    embedModel,
    embedDim,
    nowMs,
    threshold = DEFAULT_THRESHOLD,
    topK = DEFAULT_TOP_K,
    maxAgeMs = THIRTY_DAYS_MS,
  } = opts

  const fresh = notes.filter((n) => nowMs - toMs(n.createdAt) <= maxAgeMs)

  // Semantic path: embedder produced a usable vector.
  if (queryEmbedding && queryEmbedding.length === embedDim) {
    const matches = fresh
      .filter((n) => n.embedding != null && n.embedModel === embedModel && n.embedDim === embedDim)
      .map((n) => ({ n, score: cosine(queryEmbedding, n.embedding as number[]) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.n)
    // A real semantic run: return matches even when empty (empty → no reuse, by design).
    return matches
  }

  // Embedder unavailable → degrade to most-recent K fresh notes.
  return [...fresh].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt)).slice(0, topK)
}
