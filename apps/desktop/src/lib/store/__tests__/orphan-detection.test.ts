// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isStreamingRowOrphaned, ORPHAN_GRACE_MS } from '../orphan-detection'

const NOW = 1_780_000_000_000

function ctx(overrides: Partial<Parameters<typeof isStreamingRowOrphaned>[1]> = {}) {
  return {
    activeRunIds: new Set<string>(),
    hasAnyActiveRun: false,
    nowMs: NOW,
    ...overrides,
  }
}

describe('isStreamingRowOrphaned (S6 — precise orphan classification)', () => {
  it('never orphans non-streaming rows', () => {
    expect(isStreamingRowOrphaned({ status: 'complete', runId: 'r1' }, ctx())).toBe(false)
    expect(isStreamingRowOrphaned({ status: 'aborted', runId: null }, ctx())).toBe(false)
    expect(isStreamingRowOrphaned({ status: null }, ctx())).toBe(false)
  })

  describe('precise path (row carries a runId)', () => {
    it('keeps a streaming row whose run is live', () => {
      const c = ctx({ activeRunIds: new Set(['r1']), hasAnyActiveRun: true })
      expect(isStreamingRowOrphaned({ status: 'streaming', runId: 'r1' }, c)).toBe(false)
    })

    it('orphans a streaming row whose run is gone — even when OTHER runs are live', () => {
      // The exact imprecision the legacy fallback had: any-active-run used to
      // shield stale rows from unrelated runs.
      const c = ctx({ activeRunIds: new Set(['other-run']), hasAnyActiveRun: true })
      expect(isStreamingRowOrphaned({ status: 'streaming', runId: 'r1' }, c)).toBe(true)
    })

    it('orphans immediately regardless of recency (no grace on the precise path)', () => {
      const c = ctx({ activeRunIds: new Set<string>(), hasAnyActiveRun: false })
      expect(isStreamingRowOrphaned({ status: 'streaming', runId: 'r1', createdAtMs: NOW - 1_000 }, c)).toBe(true)
    })
  })

  describe('legacy path (NULL runId rows)', () => {
    it('orphans when no run is active', () => {
      expect(isStreamingRowOrphaned({ status: 'streaming', runId: null, createdAtMs: NOW - 1_000 }, ctx())).toBe(true)
    })

    it('keeps a recent row while any run is active (conservative grace)', () => {
      const c = ctx({ hasAnyActiveRun: true })
      expect(isStreamingRowOrphaned({ status: 'streaming', runId: null, createdAtMs: NOW - 1_000 }, c)).toBe(false)
    })

    it('orphans a stale row even while a run is active (past the grace)', () => {
      const c = ctx({ hasAnyActiveRun: true })
      expect(
        isStreamingRowOrphaned({ status: 'streaming', runId: null, createdAtMs: NOW - ORPHAN_GRACE_MS - 1 }, c),
      ).toBe(true)
    })

    it('treats unknown createdAt as not-recent (orphan when run state allows)', () => {
      const c = ctx({ hasAnyActiveRun: true })
      expect(isStreamingRowOrphaned({ status: 'streaming', runId: null }, c)).toBe(true)
    })
  })
})
