import { describe, it, expect } from 'vitest'
import { embedText, _resetEmbedderForTest } from './embed'
import { cosine, DEFAULT_THRESHOLD } from './note-ranking'

/**
 * Calibration for DEFAULT_THRESHOLD against the REAL all-MiniLM-L6-v2 embedder.
 * Turns the 0.6 gate from a guess into a measurement: genuine paraphrases/adjacent
 * topics must clear it, unrelated pairs must fall below it.
 *
 * Unlike the pure note-ranking.test.ts (synthetic vectors), this loads the ONNX
 * model — slow + network-dependent on first run. Per the embed.test.ts convention
 * we do NOT hard-require the model in CI: if it can't load (offline / not cached)
 * the test SOFT-SKIPS rather than flaking. It's a real check when the model is
 * present, a no-op when it isn't.
 */
describe('DEFAULT_THRESHOLD calibration (real embedder)', () => {
  const PARAPHRASES: [string, string][] = [
    ['history of the Eiffel Tower', 'Eiffel Tower construction timeline'],
    ['how photosynthesis works in plants', 'the process of photosynthesis in plant cells'],
  ]
  const UNRELATED: [string, string][] = [
    ['history of the Eiffel Tower', 'best pizza recipes in Naples'],
    ['how photosynthesis works in plants', 'stock market volatility in 2008'],
  ]

  it(
    'paraphrases clear 0.6 and unrelated pairs fall below it',
    async () => {
      _resetEmbedderForTest()
      const probe = await embedText('calibration probe').catch(() => null)
      if (!probe) {
        console.warn('[note-ranking calibration] embedder unavailable (offline / uncached) — soft-skip')
        return
      }
      const emb = async (t: string) => {
        const v = await embedText(t)
        if (!v) throw new Error(`embedText returned null for "${t}"`)
        return v
      }
      for (const [a, b] of PARAPHRASES) {
        const s = cosine(await emb(a), await emb(b))
        expect(s, `paraphrase "${a}" ~ "${b}" = ${s.toFixed(3)} should be ≥ ${DEFAULT_THRESHOLD}`).toBeGreaterThanOrEqual(
          DEFAULT_THRESHOLD,
        )
      }
      for (const [a, b] of UNRELATED) {
        const s = cosine(await emb(a), await emb(b))
        expect(s, `unrelated "${a}" ~ "${b}" = ${s.toFixed(3)} should be < ${DEFAULT_THRESHOLD}`).toBeLessThan(
          DEFAULT_THRESHOLD,
        )
      }
    },
    120_000,
  )
})
