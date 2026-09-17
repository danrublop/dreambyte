import { describe, it, expect } from 'vitest'
import { seedLegStatuses, applyLegEvent } from './leg-status'

describe('seedLegStatuses', () => {
  it('seeds a started leg as running', () => {
    expect(seedLegStatuses([{ targetProjectId: 'B', status: 'started' }])).toEqual({ B: { status: 'running' } })
  })

  it('seeds fast-failed legs as error (they emit no further events)', () => {
    expect(
      seedLegStatuses([
        { targetProjectId: 'B', status: 'slot-busy' },
        { targetProjectId: 'C', status: 'unreadable' },
        { targetProjectId: 'D', status: 'aborted' },
      ]),
    ).toEqual({
      B: { status: 'error', error: 'slot-busy' },
      C: { status: 'error', error: 'unreadable' },
      D: { status: 'error', error: 'aborted' },
    })
  })
})

describe('applyLegEvent', () => {
  const base = { B: { status: 'running' as const } }

  it('__stream_end__ marks a running leg done', () => {
    expect(applyLegEvent(base, 'B', '__stream_end__')).toEqual({ B: { status: 'done' } })
  })

  it('error marks a leg error', () => {
    expect(applyLegEvent(base, 'B', 'error', 'boom')).toEqual({ B: { status: 'error', error: 'boom' } })
  })

  it('error then __stream_end__ stays error (error wins)', () => {
    const afterError = applyLegEvent(base, 'B', 'error', 'boom')
    expect(applyLegEvent(afterError, 'B', '__stream_end__')).toEqual({ B: { status: 'error', error: 'boom' } })
  })

  it('ignores non-terminal events and returns the same reference', () => {
    expect(applyLegEvent(base, 'B', 'thinking_token')).toBe(base)
    expect(applyLegEvent(base, 'B', undefined)).toBe(base)
  })

  it('handles a target not yet in the map (defaults to running, then applies)', () => {
    expect(applyLegEvent({}, 'X', '__stream_end__')).toEqual({ X: { status: 'done' } })
  })

  it('does not disturb sibling legs', () => {
    const two = { B: { status: 'running' as const }, C: { status: 'running' as const } }
    expect(applyLegEvent(two, 'B', '__stream_end__')).toEqual({ B: { status: 'done' }, C: { status: 'running' } })
  })
})
