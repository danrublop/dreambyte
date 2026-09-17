import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useThrottledStream } from './use-throttled-stream'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useThrottledStream', () => {
  it('flushes the first push immediately (no prior flush)', () => {
    const { result } = renderHook(() => useThrottledStream(33))
    act(() => result.current.push('a'))
    expect(result.current.value).toBe('a')
  })

  it('coalesces rapid pushes within the interval into one flush of the latest value', () => {
    const { result } = renderHook(() => useThrottledStream(33))
    act(() => result.current.push('a')) // immediate -> 'a', starts interval clock
    act(() => {
      result.current.push('ab') // within interval -> schedules a single flush
      result.current.push('abc') // timer already pending -> coalesced, no new timer
    })
    expect(result.current.value).toBe('a') // not flushed yet
    act(() => vi.advanceTimersByTime(33)) // timer fires
    expect(result.current.value).toBe('abc') // latest full value, intermediate skipped
  })

  it('flush() forces the pending value now and cancels the timer (no dropped tail)', () => {
    const { result } = renderHook(() => useThrottledStream(33))
    act(() => result.current.push('a')) // immediate
    act(() => result.current.push('final')) // schedules timer
    expect(result.current.value).toBe('a')
    act(() => result.current.flush()) // force
    expect(result.current.value).toBe('final')
    // Timer was cancelled by flush: advancing produces no further change.
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.value).toBe('final')
  })

  it('reset() clears the value and a stale timer cannot flush afterwards (identity guard)', () => {
    const { result } = renderHook(() => useThrottledStream(33))
    act(() => result.current.push('a')) // immediate
    act(() => result.current.push('a-run1')) // schedules timer for old run
    act(() => result.current.reset()) // new run starts: clear + cancel timer
    expect(result.current.value).toBe('')
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.value).toBe('') // stale 'a-run1' never landed
  })

  it('push always carries the full string, so a coalesced push never loses text', () => {
    const { result } = renderHook(() => useThrottledStream(33))
    act(() => result.current.push('1')) // immediate
    act(() => {
      result.current.push('12')
      result.current.push('123')
      result.current.push('1234') // only the last survives the coalesce
    })
    act(() => vi.advanceTimersByTime(33))
    expect(result.current.value).toBe('1234')
  })

  it('cancels the pending flush on unmount (no setState-after-unmount)', () => {
    const { result, unmount } = renderHook(() => useThrottledStream(33))
    act(() => result.current.push('a'))
    act(() => result.current.push('b')) // schedules timer
    unmount()
    expect(() => act(() => vi.advanceTimersByTime(200))).not.toThrow()
  })

  it('500 rapid pushes coalesce into bounded re-renders (storm guard) without losing the tail', () => {
    const renders: string[] = []
    const { result } = renderHook(() => {
      const s = useThrottledStream(33)
      renders.push(s.value) // one entry per render commit
      return s
    })
    // Simulate 500 tokens arriving ~1ms apart, each in its own commit (as the
    // SSE onEvent handler delivers them — separate macrotasks, not batched).
    for (let i = 1; i <= 500; i++) {
      act(() => {
        result.current.push('t'.repeat(i))
        vi.advanceTimersByTime(1)
      })
    }
    act(() => vi.advanceTimersByTime(40)) // drain the final pending flush

    // 500 tokens over ~500ms at a 33ms cap => ~16 flushes, NOT ~500.
    expect(renders.length).toBeLessThan(50)
    // And nothing was dropped: the final value is the full accumulated text.
    expect(result.current.value).toBe('t'.repeat(500))
  })
})
