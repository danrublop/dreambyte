// PR2 (context-correctness) — trimHistory invariants under token pressure.
//
// The token-budget eviction used to front-shift() index 0, which after the
// two-tier split is the just-prepended summary — so it could (a) evict the
// summary and (b) leave history starting on an assistant turn. Both are rejected
// downstream (Anthropic + the canonical-message mapping require a user-first
// history). The fix drops from the oldest NON-summary entry and re-asserts the
// first-user invariant.

import { describe, expect, it } from 'vitest'
import { trimHistory } from './context-builder'

type Msg = { role: string; content: string }

const big = (n: number) => 'x'.repeat(n)

function firstText(m: { content: unknown }): string {
  return typeof m.content === 'string' ? m.content : ''
}

describe('trimHistory — summary + user-first under token pressure', () => {
  it('never evicts the prepended summary and keeps history user-first', () => {
    // 12 alternating messages (> RECENT_WINDOW=8) → a summary is prepended.
    // Recent messages are large enough that the token budget must evict some.
    const history: Msg[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: big(8000), // ~2000 tokens each
    }))

    const out = trimHistory(history)

    // Summary survived at the head as a user turn (old shift() evicted it first).
    expect(out[0].role).toBe('user')
    expect(firstText(out[0])).toContain('CONVERSATION SUMMARY')
    // Eviction actually ran (some recent turns were dropped).
    expect(out.length).toBeLessThan(13)
    // History still begins on a user turn.
    expect(out[0].role).toBe('user')
  })

  it('re-asserts user-first when eviction (no summary) leaves a leading assistant', () => {
    // 5 messages (<= RECENT_WINDOW) → no summary prepended. The huge first user
    // turn forces its eviction; without the re-assertion the result would start
    // on the assistant turn that follows it.
    const history: Msg[] = [
      { role: 'user', content: big(52000) }, // ~13000 tokens — over the whole budget alone
      { role: 'assistant', content: big(400) },
      { role: 'user', content: big(400) },
      { role: 'assistant', content: big(400) },
      { role: 'user', content: big(400) },
    ]

    const out = trimHistory(history)

    expect(out.length).toBeGreaterThan(0)
    expect(out[0].role).toBe('user') // would be 'assistant' without the fix
    // The oversized opening turn was evicted.
    expect(firstText(out[0]).length).toBeLessThan(52000)
  })
})
