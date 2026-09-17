import { describe, it, expect } from 'vitest'
import { shouldApplyRunEvent } from '../run-event-gate'

describe('shouldApplyRunEvent', () => {
  it('applies when the run branch matches the active branch', () => {
    expect(shouldApplyRunEvent('branch-a', 'branch-a')).toBe(true)
  })

  it('drops when the run branch differs from the active branch (late event after switch)', () => {
    expect(shouldApplyRunEvent('branch-a', 'branch-b')).toBe(false)
  })

  it('treats a null runBranchId as ungated (no branch to mismatch)', () => {
    expect(shouldApplyRunEvent(null, 'branch-b')).toBe(true)
    expect(shouldApplyRunEvent(undefined, 'branch-b')).toBe(true)
    expect(shouldApplyRunEvent(null, null)).toBe(true)
  })

  it('normalizes undefined active branch to null when comparing', () => {
    // A run scoped to a branch must NOT apply when no branch is active.
    expect(shouldApplyRunEvent('branch-a', undefined)).toBe(false)
    expect(shouldApplyRunEvent('branch-a', null)).toBe(false)
  })
})
