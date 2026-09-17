import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import PreviewMediaLayer from './PreviewMediaLayer'

/**
 * Guards the idle-rAF parking (PR2): a paused editor with media must STOP its rAF
 * when nothing changes, and RE-ARM the instant the playhead/transport/timeline
 * changes. The failure mode this prevents is the worst kind — "preview frozen
 * after scrub" — so the park-then-wake handshake is worth pinning explicitly.
 */
describe('PreviewMediaLayer — idle-rAF parking', () => {
  let queue: Array<() => void>
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    queue = []
    // Controllable rAF: callbacks queue instead of running; `flush()` steps one.
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      queue.push(() => cb(0))
      return queue.length // non-zero id
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  const flush = () => {
    const cb = queue.shift()
    if (cb) cb()
  }

  it('parks when idle (paused + playhead unmoved) and re-arms on scrub', () => {
    const { rerender } = render(<PreviewMediaLayer timeline={null} globalTime={0} isPlaying={false} />)
    expect(queue.length).toBe(1) // mount scheduled the loop
    flush() // tick 1: first run is dirty → processes, reschedules
    expect(queue.length).toBe(1)
    flush() // tick 2: paused + unchanged → PARK (no reschedule)
    expect(queue.length).toBe(0)

    // Scrub while paused: the wake effect must re-arm the parked loop.
    rerender(<PreviewMediaLayer timeline={null} globalTime={5} isPlaying={false} />)
    expect(queue.length).toBe(1) // re-armed
    flush() // playhead moved → dirty → processes, reschedules
    expect(queue.length).toBe(1)
    flush() // unchanged again → parks
    expect(queue.length).toBe(0)
  })

  it('re-arms on a play/pause flip', () => {
    const { rerender } = render(<PreviewMediaLayer timeline={null} globalTime={0} isPlaying={false} />)
    flush() // dirty
    flush() // park
    expect(queue.length).toBe(0)
    rerender(<PreviewMediaLayer timeline={null} globalTime={0} isPlaying={true} />)
    expect(queue.length).toBe(1) // play re-armed the loop
  })

  it('re-arms on a timeline-identity change while paused (edit / live grade-preview)', () => {
    // The store updates the timeline immutably; an edit-while-paused (or a live
    // grade-preview swapping in a new timeline object) must wake the parked loop
    // even though globalTime and isPlaying are unchanged.
    const tlA = { tracks: [] } as never
    const { rerender } = render(<PreviewMediaLayer timeline={tlA} globalTime={2} isPlaying={false} />)
    flush() // dirty (first run)
    flush() // park
    expect(queue.length).toBe(0)
    const tlB = { tracks: [] } as never // new object, same content — identity changed
    rerender(<PreviewMediaLayer timeline={tlB} globalTime={2} isPlaying={false} />)
    expect(queue.length).toBe(1) // re-armed by the timeline dep
    flush() // tl !== lastTimeline → dirty → processes
    expect(queue.length).toBe(1)
    flush() // unchanged → parks
    expect(queue.length).toBe(0)
  })

  it('never parks while playing', () => {
    render(<PreviewMediaLayer timeline={null} globalTime={0} isPlaying={true} />)
    expect(queue.length).toBe(1)
    flush()
    expect(queue.length).toBe(1) // playing → keeps rescheduling
    flush()
    expect(queue.length).toBe(1)
  })
})
