// Capture-flow images arrive NESTED inside a tool_result's content array, not as
// a top-level image block — so flattenMessagesToTranscript's `type === 'image'`
// check never saw them and raw base64 went into the checkpoint digest (measured:
// 74% of it). The digest is tail-kept at 24k, so the frames evicted the actual
// conversation, then got injected as <prior_run_transcript> and billed on resume.
//
// abort-checkpoint-resume.test.ts already asserted `not.toMatch(/base64/)` — it
// passed because its fixture has no captured image. This pins the real shape.

import { describe, expect, it } from 'vitest'
import { flattenMessagesToTranscript, trimHistory } from './context-builder'

const B64 = 'A'.repeat(4000)

/** The shape buildToolResultContent returns for a capture-flow frame. */
function toolResultWithImage() {
  return [
    {
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: [
        { type: 'text', text: 'captured frame 1' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
      ],
    },
  ]
}

describe('flattenMessagesToTranscript — nested images', () => {
  it('strips base64 out of a tool_result, keeping the text beside it', () => {
    const out = flattenMessagesToTranscript([{ role: 'user', content: toolResultWithImage() as never }])

    expect(out).not.toContain(B64)
    expect(out).not.toMatch(/base64/)
    expect(out).toContain('captured frame 1') // the useful part survives
    expect(out).toContain('[image]')
  })

  it('leaves the conversation room instead of being eaten by one frame', () => {
    const messages = [
      { role: 'user', content: 'build me a scene about otters' },
      { role: 'assistant', content: toolResultWithImage() as never },
      { role: 'user', content: 'now make it shorter' },
    ]
    // Tail-kept at a small cap: the frame must not evict both user turns.
    const out = flattenMessagesToTranscript(messages as never, 600)

    // The real damage isn't that base64 appears — at a small cap the tail-keeping
    // drops it anyway. It's that one frame's bytes push the EARLIER conversation
    // out of the window. Unfixed, 1000 chars of payload evict the opening ask.
    expect(out).toContain('build me a scene about otters')
    expect(out).toContain('now make it shorter')
  })

  it('still strips a top-level image block (the case that already worked)', () => {
    const out = flattenMessagesToTranscript([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: B64 } }] as never },
    ])

    expect(out).not.toContain(B64)
    expect(out).toContain('[image]')
  })
})

// Same nested-image blind spot, second caller: trimHistory → stripImages.
// stripImages rewrote `b.type === 'image'`, but the block it sees is the
// tool_result wrapper, so its "keep images on the last 2 user messages only"
// rule stripped ZERO. Only RECENT_WINDOW falling off the end removed frames.
describe('trimHistory — nested images on older turns', () => {
  const imageCount = (msgs: Array<{ content: unknown }>) =>
    msgs.filter((m) =>
      (Array.isArray(m.content) ? m.content : []).some(
        (b: { type?: string; content?: Array<{ type?: string }> }) =>
          b?.type === 'image' || (Array.isArray(b?.content) && b.content.some((i) => i?.type === 'image')),
      ),
    ).length

  it('keeps nested capture frames on the last 2 user messages only', () => {
    const history = Array.from({ length: 6 }, () => ({
      role: 'user',
      content: toolResultWithImage() as never,
    }))

    expect(imageCount(history)).toBe(6) // in
    const out = trimHistory(history)
    expect(imageCount(out)).toBe(2) // out — was 6 before the fix
  })

  it('drops the base64 payload from the stripped turns, keeping the text beside it', () => {
    const history = Array.from({ length: 4 }, () => ({
      role: 'user',
      content: toolResultWithImage() as never,
    }))

    const out = trimHistory(history)
    expect(JSON.stringify(out[0])).not.toContain(B64)
    expect(JSON.stringify(out[0])).toContain('captured frame 1') // the useful part survives
    expect(JSON.stringify(out[out.length - 1])).toContain(B64) // recent turn keeps its pixels
  })
})
