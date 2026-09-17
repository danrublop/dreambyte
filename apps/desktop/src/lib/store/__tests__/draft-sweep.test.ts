// @vitest-environment node
//
// Unit tests for the pure draft-sweep classifier (T2 / D7 + D17). DB-free —
// proves the "provably untouched empty" predicate and the soft-hide/hard-purge
// plan. The real-DB application is covered separately.

import { describe, it, expect } from 'vitest'
import { planDraftSweep, isUntouchedEmptyDraft, DRAFT_PURGE_AFTER_MS, type DraftSweepRow } from '../draft-sweep'

const NOW = 1_800_000_000_000

function draft(over: Partial<DraftSweepRow> = {}): DraftSweepRow {
  return {
    id: over.id ?? 'd1',
    status: 'draft',
    name: 'Untitled Project 1',
    sceneCount: 0,
    messageCount: 0,
    createdAt: NOW,
    lastOpenedAt: NOW,
    hiddenAt: null,
    ...over,
  }
}

describe('isUntouchedEmptyDraft', () => {
  it('true for a fresh empty default-named draft', () => {
    expect(isUntouchedEmptyDraft(draft())).toBe(true)
  })

  it('false when it has any scene', () => {
    expect(isUntouchedEmptyDraft(draft({ sceneCount: 1 }))).toBe(false)
  })

  it('false when it has any message', () => {
    expect(isUntouchedEmptyDraft(draft({ messageCount: 1 }))).toBe(false)
  })

  it('false when renamed away from the default', () => {
    expect(isUntouchedEmptyDraft(draft({ name: 'My Cool Video' }))).toBe(false)
  })

  it('false when reopened well after creation', () => {
    expect(isUntouchedEmptyDraft(draft({ lastOpenedAt: NOW + 60_000 }))).toBe(false)
  })

  it('true within the create-open reopen grace window', () => {
    expect(isUntouchedEmptyDraft(draft({ lastOpenedAt: NOW + 1_000 }))).toBe(true)
  })

  it('false for a non-draft status (ready/forking/hidden)', () => {
    expect(isUntouchedEmptyDraft(draft({ status: 'ready' }))).toBe(false)
    expect(isUntouchedEmptyDraft(draft({ status: 'hidden' }))).toBe(false)
  })
})

describe('planDraftSweep', () => {
  it('hides only the provably-untouched empties', () => {
    const rows = [
      draft({ id: 'empty' }),
      draft({ id: 'named', name: 'Real Project' }),
      draft({ id: 'scened', sceneCount: 2 }),
      draft({ id: 'messaged', messageCount: 1 }),
      draft({ id: 'reopened', lastOpenedAt: NOW + 100_000 }),
    ]
    const plan = planDraftSweep(rows, NOW)
    expect(plan.toHide).toEqual(['empty'])
    expect(plan.toPurge).toEqual([])
  })

  it('purges only hidden rows older than 7 days; never a fresh hidden row', () => {
    const rows = [
      draft({ id: 'old', status: 'hidden', hiddenAt: NOW - DRAFT_PURGE_AFTER_MS - 1 }),
      draft({ id: 'fresh', status: 'hidden', hiddenAt: NOW - 1_000 }),
      draft({ id: 'exactly7d', status: 'hidden', hiddenAt: NOW - DRAFT_PURGE_AFTER_MS }), // boundary: NOT yet
    ]
    const plan = planDraftSweep(rows, NOW)
    expect(plan.toPurge).toEqual(['old'])
    expect(plan.toHide).toEqual([])
  })

  it('a hidden row never gets re-hidden', () => {
    const plan = planDraftSweep([draft({ id: 'h', status: 'hidden', hiddenAt: NOW - 1000 })], NOW)
    expect(plan.toHide).toEqual([])
  })
})
