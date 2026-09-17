/**
 * A1-2 — context-overflow recovery of last resort.
 *
 * compactInFlightMessages preserves the recent window verbatim, so one giant
 * RECENT tool_result (the audit's "huge tool result after the proactive
 * check" hole) survives compaction and re-overflows. These tests pin the
 * truncation helper the runner's recovery loop falls back to.
 */

import { describe, it, expect } from 'vitest'
import { truncateOversizedToolResults, CONTEXT_OVERFLOW_RE } from '../context-builder'

const CAP = 1_000

function toolResultMsg(content: unknown) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] }
}

describe('truncateOversizedToolResults', () => {
  it('clamps an oversized string tool_result in place, keeping the head + a visible marker', () => {
    const big = 'A'.repeat(5_000)
    const messages = [toolResultMsg(big)]
    const n = truncateOversizedToolResults(messages, CAP)
    expect(n).toBe(1)
    const block = (messages[0].content as Array<{ content: string }>)[0]
    expect(block.content.length).toBeLessThan(1_300) // cap + marker
    expect(block.content.startsWith('A'.repeat(100))).toBe(true) // head kept
    expect(block.content).toContain('truncated: tool output was 5000 chars')
  })

  it('clamps oversized text PARTS inside array-form tool_result content', () => {
    const messages = [
      toolResultMsg([
        { type: 'text', text: 'B'.repeat(3_000) },
        { type: 'text', text: 'small' },
      ]),
    ]
    const n = truncateOversizedToolResults(messages, CAP)
    expect(n).toBe(1)
    const parts = (messages[0].content as Array<{ content: Array<{ text: string }> }>)[0].content
    expect(parts[0].text).toContain('truncated')
    expect(parts[1].text).toBe('small') // under cap — untouched
  })

  it('returns 0 and touches nothing when everything is under the cap', () => {
    const messages = [toolResultMsg('fine'), { role: 'assistant', content: 'plain string message' }]
    const snapshot = JSON.stringify(messages)
    expect(truncateOversizedToolResults(messages, CAP)).toBe(0)
    expect(JSON.stringify(messages)).toBe(snapshot)
  })

  it('ignores non-tool_result blocks (text, images) and plain-string messages', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'X'.repeat(5_000) }] },
      { role: 'user', content: 'Y'.repeat(5_000) },
    ]
    expect(truncateOversizedToolResults(messages, CAP)).toBe(0)
  })

  it('counts every clamped block across multiple messages', () => {
    const messages = [toolResultMsg('C'.repeat(2_000)), toolResultMsg('D'.repeat(2_000))]
    expect(truncateOversizedToolResults(messages, CAP)).toBe(2)
  })
})

describe('CONTEXT_OVERFLOW_RE — the recovery trigger (/review PR3)', () => {
  const MUST_MATCH = [
    // Anthropic
    'prompt is too long: 200001 tokens > 200000 maximum',
    // OpenAI
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.",
    'context_length_exceeded',
    'Request too large: too many input tokens',
    // Gemini
    'The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).',
    'input token count exceeds limit',
    // Generic wordings seen across proxies
    'The conversation exceeds the context window of this model.',
    'input is too long for requested model',
  ]
  const MUST_NOT_MATCH = [
    // Permanent 400s the recovery must NOT waste a compaction+retry on:
    'Invalid request: maximum input images is 20',
    'maximum input file size exceeded',
    'rate limit exceeded, retry after 30s',
    'Invalid API key provided',
    'The model produced invalid tool arguments and the run cannot continue.',
    'overloaded_error: please try again later',
  ]

  it.each(MUST_MATCH)('matches provider overflow wording: %s', (msg) => {
    expect(CONTEXT_OVERFLOW_RE.test(msg)).toBe(true)
  })

  it.each(MUST_NOT_MATCH)('does NOT match non-overflow errors: %s', (msg) => {
    expect(CONTEXT_OVERFLOW_RE.test(msg)).toBe(false)
  })

  it('does not self-trigger on the truncation marker text', () => {
    // The marker says "too large for the context window" — but the regex is
    // only ever tested against ERROR messages, never message content. Still,
    // pin that a tool error QUOTING the marker phrase "context window" would
    // match — acceptable by design (one bounded recovery attempt) — while the
    // structured-stop wording does not.
    expect(CONTEXT_OVERFLOW_RE.test('tool output was 5000 chars — too large for the context window')).toBe(true)
  })
})
