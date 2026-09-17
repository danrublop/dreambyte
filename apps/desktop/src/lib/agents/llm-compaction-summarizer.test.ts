/**
 * Tests for the model-backed compaction summarizer.
 *
 * The provider adapter is MOCKED — no real network calls. We script a
 * `streamChat` async-iterable per case to drive the happy path, throwing path,
 * timeout (fake timers), abort, and ledger commit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NormalizedStreamEvent, StreamChatOptions, ProviderAdapter } from './providers/adapter'
import { makeRunCostLedger } from './run-cost-ledger'

// Mock the provider barrel so `getAdapter` returns whatever each test scripts.
let scriptedAdapter: ProviderAdapter | undefined
vi.mock('./providers/index', () => ({
  getAdapter: () => scriptedAdapter,
}))

import { makeLlmSummarizer, COMPACTION_SUMMARY_TIMEOUT_MS } from './llm-compaction-summarizer'

const TEST_MODEL = 'claude-haiku-4-5-20251001' // budget-tier, priced $1/$5 per 1M

/** Build an adapter whose streamChat yields the given events. */
function adapterYielding(events: NormalizedStreamEvent[]): ProviderAdapter {
  return {
    id: 'anthropic',
    async *streamChat(_opts: StreamChatOptions) {
      for (const ev of events) yield ev
    },
  }
}

beforeEach(() => {
  scriptedAdapter = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

describe('makeLlmSummarizer — success', () => {
  it('returns the model summary text', async () => {
    scriptedAdapter = adapterYielding([
      { type: 'text_delta', text: 'User wants ' },
      { type: 'text_delta', text: 'a 3-scene demo. ' },
      { type: 'text_delta', text: 'Scene abc created.' },
      { type: 'usage_update', usage: { inputTokens: 500, outputTokens: 40 } },
      { type: 'message_stop', stopReason: 'end_turn' },
    ])
    const summarize = makeLlmSummarizer({ model: TEST_MODEL })
    const out = await summarize('...transcript...')
    expect(out).toBe('User wants a 3-scene demo. Scene abc created.')
  })

  it('returns null on an empty/whitespace transcript without calling the model', async () => {
    const streamChat = vi.fn()
    scriptedAdapter = { id: 'anthropic', streamChat: streamChat as never }
    const summarize = makeLlmSummarizer({ model: TEST_MODEL })
    expect(await summarize('   ')).toBeNull()
    expect(streamChat).not.toHaveBeenCalled()
  })

  it('returns null when the model produces no text', async () => {
    scriptedAdapter = adapterYielding([
      { type: 'usage_update', usage: { inputTokens: 100, outputTokens: 0 } },
      { type: 'message_stop', stopReason: 'end_turn' },
    ])
    const summarize = makeLlmSummarizer({ model: TEST_MODEL })
    expect(await summarize('transcript')).toBeNull()
  })
})

describe('makeLlmSummarizer — failure → null (regex fallback)', () => {
  it('returns null when the model call throws', async () => {
    scriptedAdapter = {
      id: 'anthropic',
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('provider 500')
      },
    }
    const summarize = makeLlmSummarizer({ model: TEST_MODEL })
    expect(await summarize('transcript')).toBeNull()
  })

  it('returns null when the stream emits an error event', async () => {
    scriptedAdapter = adapterYielding([
      { type: 'error', message: 'overloaded', retriable: true },
      { type: 'message_stop', stopReason: 'error' },
    ])
    const summarize = makeLlmSummarizer({ model: TEST_MODEL })
    expect(await summarize('transcript')).toBeNull()
  })

  it('returns null when no adapter is registered for the provider', async () => {
    scriptedAdapter = undefined
    const summarize = makeLlmSummarizer({ model: TEST_MODEL })
    expect(await summarize('transcript')).toBeNull()
  })
})

describe('makeLlmSummarizer — timeout', () => {
  it('returns null when the model call exceeds the timeout', async () => {
    vi.useFakeTimers()
    // An adapter that never resolves its first event → forces the timeout to win.
    scriptedAdapter = {
      id: 'anthropic',
      async *streamChat() {
        await new Promise<void>(() => {}) // hangs forever
        yield { type: 'message_stop', stopReason: 'end_turn' } as NormalizedStreamEvent
      },
    }
    const summarize = makeLlmSummarizer({ model: TEST_MODEL, timeoutMs: 1000 })
    const promise = summarize('transcript')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await promise).toBeNull()
  })

  it('uses the default timeout constant when none is supplied', () => {
    expect(COMPACTION_SUMMARY_TIMEOUT_MS).toBe(15_000)
  })
})

describe('makeLlmSummarizer — abort', () => {
  it('returns null immediately when the signal is already aborted', async () => {
    const streamChat = vi.fn()
    scriptedAdapter = { id: 'anthropic', streamChat: streamChat as never }
    const controller = new AbortController()
    controller.abort()
    const summarize = makeLlmSummarizer({ model: TEST_MODEL, abortSignal: controller.signal })
    expect(await summarize('transcript')).toBeNull()
    expect(streamChat).not.toHaveBeenCalled()
  })
})

describe('makeLlmSummarizer — cost ledger', () => {
  it('commits the call usage to the ledger on success as its own line item', async () => {
    scriptedAdapter = adapterYielding([
      { type: 'text_delta', text: 'summary' },
      // 1,000,000 input + 1,000,000 output @ $1/$5 per 1M = $6.00
      { type: 'usage_update', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      { type: 'message_stop', stopReason: 'end_turn' },
    ])
    const ledger = makeRunCostLedger(100)
    const summarize = makeLlmSummarizer({ model: TEST_MODEL, costLedger: ledger })
    const out = await summarize('transcript')
    expect(out).toBe('summary')
    expect(ledger.spentUsd).toBeCloseTo(6.0, 5)
  })

  it('does NOT commit cost when the call throws', async () => {
    scriptedAdapter = {
      id: 'anthropic',
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('boom')
      },
    }
    const ledger = makeRunCostLedger(100)
    const summarize = makeLlmSummarizer({ model: TEST_MODEL, costLedger: ledger })
    expect(await summarize('transcript')).toBeNull()
    expect(ledger.spentUsd).toBe(0)
  })
})
