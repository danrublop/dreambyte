// @vitest-environment jsdom
// jsdom, not node: zustand's persist middleware only attaches `store.persist`
// (and therefore the migrate fn) when a storage backend exists — under node there
// is no localStorage, it warns and skips, and the migration is untestable.

/**
 * LANE A — sub-agents are opt-in.
 *
 * Two halves of the same requirement ("only use sub agents upon request"):
 *   1. the persisted preference and its v17 migration, so a returning user does
 *      not silently keep orchestrating;
 *   2. the phrase check that lets a user ask for sub-agents in one message
 *      without touching Settings.
 */

import { describe, it, expect } from 'vitest'
import { useVideoStore } from './index'
import { userRequestedSubAgents } from '../agents/tools'

describe('subAgents store preference', () => {
  it('defaults to OFF — a fresh install is single-agent', () => {
    expect(useVideoStore.getState().subAgents).toBe(false)
  })

  it('the legacy directorLoop field is gone from state', () => {
    expect((useVideoStore.getState() as unknown as Record<string, unknown>).directorLoop).toBeUndefined()
  })

  it('the setter flips it', () => {
    useVideoStore.getState().setSubAgents(true)
    expect(useVideoStore.getState().subAgents).toBe(true)
    useVideoStore.getState().setSubAgents(false)
    expect(useVideoStore.getState().subAgents).toBe(false)
  })
})

describe('persist migration v17 (directorLoop → subAgents)', () => {
  const migrate = (persisted: Record<string, unknown>, version: number) =>
    (useVideoStore.persist.getOptions().migrate as (s: unknown, v: number) => Record<string, unknown>)(
      persisted,
      version,
    ) as Record<string, unknown>

  it('a user carrying v16\'s force-set directorLoop:true lands on single-agent', () => {
    // v16 set directorLoop=true for EVERY existing user without asking, so a
    // persisted `true` records that migration, not a choice — it must not survive
    // as a standing opt-in to sub-agents under the new default.
    const out = migrate({ directorLoop: true }, 16)
    expect(out.subAgents).toBe(false)
    expect(out.directorLoop).toBeUndefined()
  })

  it('a user who had deliberately turned it OFF also lands on single-agent', () => {
    const out = migrate({ directorLoop: false }, 16)
    expect(out.subAgents).toBe(false)
  })

  it('leaves an already-migrated (v17) state alone', () => {
    const out = migrate({ subAgents: true }, 17)
    expect(out.subAgents).toBe(true)
  })
})

describe('userRequestedSubAgents — the per-message opt-in', () => {
  it('matches the ways a user actually asks', () => {
    for (const msg of [
      'use sub-agents for this',
      'use subagents please',
      'build the scenes in parallel',
      'parallelise the build',
      'parallelize this',
      'dispatch the builders',
      'fan out the work',
      'orchestrate this build',
      'use a multi-agent build',
      'hand it to the scene builders',
    ]) {
      expect(userRequestedSubAgents(msg), `missed: "${msg}"`).toBe(true)
    }
  })

  it('does NOT fire on an ordinary build request', () => {
    for (const msg of [
      'make a 6-scene video explaining WebGPU',
      'add a title card',
      'make it faster and change the palette',
      'build an explainer about agents', // "agent" alone is not a request for sub-agents
      '',
    ]) {
      expect(userRequestedSubAgents(msg), `false positive: "${msg}"`).toBe(false)
    }
  })

  it('handles a missing message', () => {
    expect(userRequestedSubAgents(undefined)).toBe(false)
    expect(userRequestedSubAgents(null)).toBe(false)
  })
})
