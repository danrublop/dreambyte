import 'server-only'
import { createLogger } from '@/lib/logger'

/**
 * Bundled in-process text embedder for research-memory semantic reuse.
 *
 * Runs all-MiniLM-L6-v2 via transformers.js on the WASM backend — no native
 * module (nothing to electron-rebuild/sign), works in EVERY config (cloud-default
 * DeepSeek or local Ollama) at $0, offline after the first model fetch. This is
 * why reuse is NOT gated on Ollama: the default research config is DeepSeek cloud,
 * which runs no Ollama, so an Ollama-based embedder would be dead exactly where the
 * feature ships.
 *
 *        embedText("history of the Eiffel Tower")  ──►  Float32Array(384), unit-norm
 *        cosine(a, b) = a·b   (vectors are normalized, so dot product == cosine)
 *
 * Fail-LOUD, never silently pretend: if the model can't load, log once and return
 * null. The caller degrades to inject-most-recent — it does not block the run.
 */

const log = createLogger('research.embed')

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBED_DIM = 384

type Extractor = (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array | number[] }>

let extractorPromise: Promise<Extractor | null> | null = null
let warnedUnavailable = false

/** Lazy singleton. Concurrent callers share one init; a failed init returns null. */
async function getExtractor(): Promise<Extractor | null> {
  if (extractorPromise) return extractorPromise
  extractorPromise = (async () => {
    try {
      const { pipeline, env } = await import('@xenova/transformers')
      // Cache the model under the app data dir when provided, else the package
      // default. Bundling/vendoring the model file swaps this path; downloads
      // are cached so it is a one-time ~23MB fetch.
      if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE
      const pipe = await pipeline('feature-extraction', EMBED_MODEL)
      return pipe as unknown as Extractor
    } catch (e) {
      // Reset so a later call can retry (e.g. network came back).
      extractorPromise = null
      if (!warnedUnavailable) {
        warnedUnavailable = true
        log.warn(
          `Text embedder unavailable (${(e as Error)?.message ?? e}). Semantic research reuse ` +
            `is disabled — falling back to most-recent notes. Vendor ${EMBED_MODEL} or restore network.`,
        )
      }
      return null
    }
  })()
  return extractorPromise
}

/**
 * Embed a short text into a unit-normalized 384-d vector, or null if the embedder
 * is unavailable. Empty/whitespace input returns null (nothing to match on).
 */
export async function embedText(text: string): Promise<number[] | null> {
  const clean = (text ?? '').trim()
  if (!clean) return null
  const extractor = await getExtractor()
  if (!extractor) return null
  try {
    // Cap length — MiniLM truncates at 256 tokens anyway; guard against a giant brief.
    const out = await extractor(clean.slice(0, 2000), { pooling: 'mean', normalize: true })
    const vec = Array.from(out.data as ArrayLike<number>)
    return vec.length === EMBED_DIM ? vec : null
  } catch (e) {
    log.warn(`embedText failed: ${(e as Error)?.message ?? e}`)
    return null
  }
}

/** Test seam: drop the cached pipeline so a test can re-init. */
export function _resetEmbedderForTest(): void {
  extractorPromise = null
  warnedUnavailable = false
}
