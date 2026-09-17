// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isCacheable, createDbMediaAnalysisCache, ANALYSIS_SCHEMA_VERSION } from './media-analysis-cache'
import type { MediaAnalysis } from '../types'

const base = (over: Partial<MediaAnalysis>): MediaAnalysis => ({
  mediaId: 'm',
  kind: 'image',
  backend: 'cloud:qwen',
  ...over,
})

describe('isCacheable (never-cache-failures invariant)', () => {
  it('rejects errored analyses', () => {
    expect(isCacheable(base({ error: 'boom', caption: 'x' }))).toBe(false)
  })
  it('rejects the "no engine" placeholder', () => {
    expect(isCacheable(base({ backend: 'none' }))).toBe(false)
  })
  it('rejects an empty shell (no content fields)', () => {
    expect(isCacheable(base({}))).toBe(false)
  })
  it('accepts a real result with any content field', () => {
    expect(isCacheable(base({ caption: 'a cat' }))).toBe(true)
    expect(isCacheable(base({ kind: 'audio', transcript: 'hi' }))).toBe(true)
    expect(isCacheable(base({ kind: 'video', events: [{ start: 0, end: 1, description: 'x' }] }))).toBe(true)
    expect(isCacheable(base({ kind: 'doc', ocrText: 'lorem' }))).toBe(true)
  })
})

describe('createDbMediaAnalysisCache degradation', () => {
  it('exposes the cache key version', () => {
    expect(ANALYSIS_SCHEMA_VERSION).toBeTruthy()
  })
  it('get/put never throw even if the DB is unavailable (best-effort)', async () => {
    // No DATABASE_URL / table here — both calls must degrade silently.
    const cache = createDbMediaAnalysisCache()
    await expect(cache.get('h', 'cloud:qwen', '1')).resolves.toBeNull()
    await expect(cache.put('h', 'cloud:qwen', '1', base({ caption: 'x' }))).resolves.toBeUndefined()
  })
})
