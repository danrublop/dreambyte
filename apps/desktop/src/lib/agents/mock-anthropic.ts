/**
 * Mock Anthropic client for vitest fixtures.
 *
 * Implements the slice of the Anthropic SDK that runner.ts actually consumes:
 *   - client.messages.stream(params) → async-iterable + .finalMessage()
 *   - client.messages.create(params) → Promise<Message>  (used by router.ts)
 *
 * Each call dequeues the next ScriptedResponse from the queue. The queue is
 * built from a Fixture's `responses` array — one entry per LLM iteration.
 *
 * Tests inject this via __setProviderClientsForTesting() in runner.ts.
 */

import type Anthropic from '@anthropic-ai/sdk'

// ── Public types ─────────────────────────────────────────────────────────────

/** Anything the SDK might yield during a stream. We keep this loose because
 *  runner.ts switches on event.type strings; full SDK typings aren't worth it
 *  for fixtures we control. */
export type ScriptedStreamEvent = Record<string, unknown> & { type: string }

/** A single LLM iteration: the events streamed back, plus the assembled message
 *  that .finalMessage() resolves to. */
export interface ScriptedResponse {
  events: ScriptedStreamEvent[]
  finalMessage: Anthropic.Message
}

/** A captured request — tests assert against this to verify the runner sent
 *  what we expect (correct messages, tools, system prompt, etc.). */
export interface CapturedRequest {
  method: 'stream' | 'create'
  params: Record<string, unknown>
  /** Wall-clock when the request was made, for ordering assertions. */
  ts: number
}

// ── Mock stream ──────────────────────────────────────────────────────────────

class MockAnthropicStream {
  private finalMsg: Anthropic.Message
  private events: ScriptedStreamEvent[]

  constructor(events: ScriptedStreamEvent[], finalMsg: Anthropic.Message) {
    this.events = events
    this.finalMsg = finalMsg
  }

  // Async-iterable contract that matches what `for await (const event of stream)`
  // expects in runner.ts:2687.
  [Symbol.asyncIterator](): AsyncIterator<ScriptedStreamEvent> {
    const events = this.events
    let i = 0
    return {
      async next(): Promise<IteratorResult<ScriptedStreamEvent>> {
        if (i >= events.length) return { done: true, value: undefined }
        // microtask yield so consumers see a real async boundary; mirrors how
        // the real SDK delivers events one at a time off the network.
        await Promise.resolve()
        return { done: false, value: events[i++] }
      },
    }
  }

  async finalMessage(): Promise<Anthropic.Message> {
    return this.finalMsg
  }
}

// ── Mock client ──────────────────────────────────────────────────────────────

export class MockAnthropicClient {
  /** Requests captured in order. Tests read this to assert what runAgent sent. */
  public readonly requests: CapturedRequest[] = []

  private queue: ScriptedResponse[]

  /** Wired to look like `client.messages.stream(...)` and `client.messages.create(...)` */
  public messages: {
    stream: (params: Record<string, unknown>) => MockAnthropicStream
    create: (params: Record<string, unknown>) => Promise<Anthropic.Message>
  }

  constructor(responses: ScriptedResponse[]) {
    this.queue = [...responses]
    this.messages = {
      stream: (params) => {
        this.requests.push({ method: 'stream', params, ts: Date.now() })
        const r = this.queue.shift()
        if (!r) {
          // status 400 so classifyStreamError treats an exhausted script as a
          // CLIENT error — a statusless throw is classified retriable and the
          // adapter would back off (15s/45s/90s) before the test ever sees it.
          throw Object.assign(
            new Error(
              `MockAnthropicClient: stream() called but no fixture left in queue. ` +
                `Captured ${this.requests.length} request(s). ` +
                `Add another ScriptedResponse to the fixture, or check the runner isn't looping.`,
            ),
            { status: 400 },
          )
        }
        return new MockAnthropicStream(r.events, r.finalMessage)
      },
      create: async (params) => {
        this.requests.push({ method: 'create', params, ts: Date.now() })
        const r = this.queue.shift()
        if (!r) {
          throw new Error('MockAnthropicClient: create() called but no fixture left in queue.')
        }
        return r.finalMessage
      },
    }
  }

  /** True when every scripted response has been consumed. Useful in afterEach
   *  to assert the runner used exactly as many iterations as the fixture
   *  predicted — over- or under-shooting both signal real bugs. */
  isEmpty(): boolean {
    return this.queue.length === 0
  }

  /** How many iterations of the agent loop did the runner perform. */
  get iterationCount(): number {
    return this.requests.filter((r) => r.method === 'stream').length
  }
}
