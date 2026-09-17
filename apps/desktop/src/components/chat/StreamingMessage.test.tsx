import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { act, render } from '@testing-library/react'
import type { ToolCallRecord } from '@/lib/agents/types'
import type { StreamingHandle } from '@/lib/hooks/use-agent-run'
import { StreamingMessage, type StreamingSegment } from './StreamingMessage'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const call: ToolCallRecord = {
  id: 'c1',
  toolName: 'write_scene_code',
  input: {},
  output: { success: true },
} as ToolCallRecord

function baseProps(over: Partial<React.ComponentProps<typeof StreamingMessage>> = {}) {
  return {
    segments: [] as StreamingSegment[],
    snapshotLen: 0,
    activeToolName: null,
    isThinkingStreaming: false,
    ...over,
  }
}

describe('StreamingMessage', () => {
  it('interleaves committed segments with trailing live text IN ORDER (regression)', () => {
    const ref = createRef<StreamingHandle>()
    // A tool call committed after the text "before"; snapshotLen marks how much
    // accumulated text is already captured in segments (len of "before" = 6).
    const segments: StreamingSegment[] = [
      { type: 'text', text: 'before' },
      { type: 'tool', call },
    ]
    const { container } = render(<StreamingMessage ref={ref} {...baseProps({ segments, snapshotLen: 6 })} />)

    // More text streams in after the tool call. Full accumulated = "beforeafter".
    act(() => ref.current!.pushText('beforeafter'))
    act(() => vi.advanceTimersByTime(40))

    const txt = container.textContent ?? ''
    expect(txt).toContain('before')
    expect(txt).toContain('after')
    // Chronological order preserved: committed "before" -> tool -> trailing "after".
    expect(txt.indexOf('before')).toBeLessThan(txt.indexOf('after'))
  })

  it('collapses trailing text to nothing once it is captured by a snapshot (no duplicate)', () => {
    const ref = createRef<StreamingHandle>()
    const segments: StreamingSegment[] = [{ type: 'text', text: 'hello world' }]
    const { container } = render(<StreamingMessage ref={ref} {...baseProps({ segments, snapshotLen: 11 })} />)
    // Accumulated text equals what's already in the segment -> no trailing dup.
    act(() => ref.current!.pushText('hello world'))
    act(() => vi.advanceTimersByTime(40))
    const occurrences = (container.textContent ?? '').split('hello world').length - 1
    expect(occurrences).toBe(1)
  })

  it('renders a committed thinking SEGMENT inline, interleaved between tool calls', () => {
    const ref = createRef<StreamingHandle>()
    // A completed reasoning block is committed as a `thinking` segment BETWEEN
    // the tool calls it happened between — the whole point of the interleave. It
    // renders as a collapsed "Reasoning (N words)" ThinkingBlock in order.
    const segments: StreamingSegment[] = [
      { type: 'thinking', text: 'reasoning about scene layout' }, // 4 words
      { type: 'tool', call },
    ]
    const { container } = render(<StreamingMessage ref={ref} {...baseProps({ segments })} />)
    expect(container.textContent ?? '').toContain('Reasoning (4 words)')
  })

  it('resetThinking clears the LIVE thinking buffer (past reasoning lives in segments now)', () => {
    const ref = createRef<StreamingHandle>()
    // isStreaming=false so ThinkingBlock renders its collapsed "Reasoning (N words)"
    // summary, whose word count proves the thinking value reached the block.
    const { container } = render(<StreamingMessage ref={ref} {...baseProps({ isThinkingStreaming: false })} />)
    act(() => ref.current!.pushThinking('reasoning about scene layout')) // 4 words
    act(() => vi.advanceTimersByTime(40))
    expect(container.textContent ?? '').toContain('Reasoning (4 words)')
    // resetThinking now CLEARS the live buffer — AgentChat commits the finished
    // block as a `thinking` segment (see prior test), so the leaf no longer keeps
    // its own history. With no segment carrying it, the block is gone from here.
    act(() => ref.current!.resetThinking())
    act(() => vi.advanceTimersByTime(40))
    expect(container.textContent ?? '').not.toContain('Reasoning')
  })

  it('flushThinking surfaces the final thinking immediately (no timer advance)', () => {
    const ref = createRef<StreamingHandle>()
    const { container } = render(<StreamingMessage ref={ref} {...baseProps({ isThinkingStreaming: false })} />)
    act(() => ref.current!.flushThinking('final reasoning')) // 2 words, flushed now
    expect(container.textContent ?? '').toContain('Reasoning (2 words)')
  })

  it('drives onContentGrow from INTERNAL state, with no parent prop change (isolation)', () => {
    const onGrow = vi.fn()
    const ref = createRef<StreamingHandle>()
    render(<StreamingMessage ref={ref} {...baseProps({ onContentGrow: onGrow })} />)
    const before = onGrow.mock.calls.length
    // Pushing text re-renders the leaf via its own state — the parent never
    // re-rendered or changed a prop. This is the whole point of the isolation.
    act(() => ref.current!.pushText('streaming in'))
    act(() => vi.advanceTimersByTime(40))
    expect(onGrow.mock.calls.length).toBeGreaterThan(before)
  })

  it('resetAll clears both text and thinking', () => {
    const ref = createRef<StreamingHandle>()
    const { container } = render(<StreamingMessage ref={ref} {...baseProps({ isThinkingStreaming: true })} />)
    act(() => {
      ref.current!.pushText('some text')
      ref.current!.pushThinking('some thinking')
    })
    act(() => vi.advanceTimersByTime(40))
    expect(container.textContent ?? '').toContain('some text')
    act(() => ref.current!.resetAll())
    act(() => vi.advanceTimersByTime(40))
    const txt = container.textContent ?? ''
    expect(txt).not.toContain('some text')
    expect(txt).not.toContain('some thinking')
  })
})
