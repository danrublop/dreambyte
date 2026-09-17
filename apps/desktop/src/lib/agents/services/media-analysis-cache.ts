/**
 * Media-analysis cache.
 *
 * Persists per-file vision/audio/doc analysis so repeat runs skip the expensive
 * ffmpeg + VLM + Whisper work. Content-addressed: keyed by
 * (contentHash, engineId, modelVersion) — an ALTERED file gets a new
 * `contentHash` (computed at upload, see upload-asset.ts) and therefore misses,
 * and the same clip re-uploaded across projects is analyzed once.
 *
 * INVARIANTS (mandatory, see PHASE-2.5 plan):
 *   - Never cache a failed/timed-out/empty analysis (a transient error must not
 *     stick forever). The orchestrator enforces this before calling `put`.
 *   - `modelVersion` is in the key, so a prompt/schema change (bump
 *     ANALYSIS_SCHEMA_VERSION) or an engine switch re-analyzes instead of
 *     serving a stale result.
 *
 * The cache is an injectable interface so the intake orchestrator stays
 * unit-testable without a database; `createDbMediaAnalysisCache()` is the
 * production SQLite-backed implementation.
 */

import type { MediaAnalysis } from '../types'

/** Bump when the analysis shape or engine prompts change → forces re-analysis. */
export const ANALYSIS_SCHEMA_VERSION = '1'

export interface MediaAnalysisCache {
  get(contentHash: string, engineId: string, modelVersion: string): Promise<MediaAnalysis | null>
  put(contentHash: string, engineId: string, modelVersion: string, analysis: MediaAnalysis): Promise<void>
}

/** True when an analysis is worth caching (succeeded and carries some content). */
export function isCacheable(a: MediaAnalysis): boolean {
  if (a.error) return false
  if (a.backend === 'none') return false
  // Must carry at least one understanding field — don't cache an empty shell.
  // (doc text lands in ocrText; there is no separate docText field.)
  return Boolean(a.caption || a.ocrText || a.transcript || (a.events && a.events.length) || a.palette?.length)
}

/** SQLite-backed cache (production). Best-effort: any DB error degrades to a miss/no-op. */
export function createDbMediaAnalysisCache(): MediaAnalysisCache {
  return {
    async get(contentHash, engineId, modelVersion) {
      try {
        const { db } = await import('../../db')
        const { mediaAnalysis } = await import('../../db/schema')
        const { and, eq } = await import('drizzle-orm')
        const rows = await db
          .select()
          .from(mediaAnalysis)
          .where(
            and(
              eq(mediaAnalysis.contentHash, contentHash),
              eq(mediaAnalysis.engineId, engineId),
              eq(mediaAnalysis.modelVersion, modelVersion),
            ),
          )
          .limit(1)
        const row = rows[0]
        return row ? (row.analysis as unknown as MediaAnalysis) : null
      } catch {
        return null // unreachable DB → treat as miss, analyze fresh
      }
    },
    async put(contentHash, engineId, modelVersion, analysis) {
      try {
        const { db } = await import('../../db')
        const { mediaAnalysis } = await import('../../db/schema')
        await db
          .insert(mediaAnalysis)
          .values({
            contentHash,
            engineId,
            modelVersion,
            kind: analysis.kind,
            analysis: analysis as unknown as Record<string, unknown>,
          })
          .onConflictDoNothing()
      } catch {
        // Non-fatal: a write failure just means the next run re-analyzes.
      }
    },
  }
}
