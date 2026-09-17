// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { resolveResumeSpentUsd } from './agent-runner'

/**
 * Checkpoint-hardening gate. A resumed run seeds its cost ledger from the
 * checkpoint's prior spend. A corrupt recorded cost (NaN / Infinity / negative
 * — DB truncation / poison) must NOT reset spend to $0, which would re-grant a
 * full budget and bypass the cost cap. It fails SAFE to the cap instead.
 */
describe('resolveResumeSpentUsd (#checkpoint-harden)', () => {
  const CAP = 25

  it('uses a valid prior spend', () => {
    expect(resolveResumeSpentUsd(15, CAP)).toBe(15)
    expect(resolveResumeSpentUsd(0, CAP)).toBe(0)
  })

  it('is 0 when no prior spend was recorded', () => {
    expect(resolveResumeSpentUsd(undefined, CAP)).toBe(0)
    expect(resolveResumeSpentUsd(null, CAP)).toBe(0)
  })

  it('fails SAFE to the cap on a corrupt cost (no $0 budget reset = no bypass)', () => {
    expect(resolveResumeSpentUsd(NaN, CAP)).toBe(CAP)
    expect(resolveResumeSpentUsd(Infinity, CAP)).toBe(CAP)
    expect(resolveResumeSpentUsd(-5, CAP)).toBe(CAP)
    expect(resolveResumeSpentUsd('15.00' as unknown, CAP)).toBe(CAP) // wrong type = corrupt
  })

  it('corrupt cost under an unlimited cap → 0 (no ceiling to protect)', () => {
    expect(resolveResumeSpentUsd(NaN, null)).toBe(0)
    expect(resolveResumeSpentUsd(NaN, undefined)).toBe(0)
    expect(resolveResumeSpentUsd(NaN, 0)).toBe(0)
  })
})
