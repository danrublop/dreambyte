// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import {
  enqueueSteer,
  drainSteers,
  clearSteers,
  steerQueueDepth,
  validateSteerPayload,
  acceptSteer,
  STEER_QUEUE_MAX,
  STEER_TEXT_MAX,
  type Steer,
} from './pending-steers'

const steer = (id: string, text = 't'): Steer => ({ id, text })

// Isolate runs per test by using unique runIds (the Map lives on globalThis).
let n = 0
const freshRun = () => `run-${++n}-${Math.floor(performance.now())}`

describe('pending-steers inbox', () => {
  let run: string
  beforeEach(() => {
    run = freshRun()
    clearSteers(run)
  })

  it('enqueues the first steer under a new runId', () => {
    expect(enqueueSteer(run, steer('a'))).toBe(true)
    expect(steerQueueDepth(run)).toBe(1)
  })

  it('appends in FIFO order', () => {
    enqueueSteer(run, steer('a', 'first'))
    enqueueSteer(run, steer('b', 'second'))
    expect(drainSteers(run).map((s) => s.text)).toEqual(['first', 'second'])
  })

  it('drain returns the queue AND clears it', () => {
    enqueueSteer(run, steer('a'))
    expect(drainSteers(run)).toHaveLength(1)
    expect(steerQueueDepth(run)).toBe(0)
    expect(drainSteers(run)).toEqual([]) // second drain is empty
  })

  it('drain of an empty / unknown runId returns []', () => {
    expect(drainSteers(run)).toEqual([])
    expect(drainSteers('never-existed')).toEqual([])
  })

  it('clearSteers drops the inbox without draining', () => {
    enqueueSteer(run, steer('a'))
    clearSteers(run)
    expect(steerQueueDepth(run)).toBe(0)
  })

  it('rejects beyond the flood cap (returns false, queue stays at the cap)', () => {
    for (let i = 0; i < STEER_QUEUE_MAX; i++) {
      expect(enqueueSteer(run, steer(`a${i}`))).toBe(true)
    }
    expect(enqueueSteer(run, steer('overflow'))).toBe(false)
    expect(steerQueueDepth(run)).toBe(STEER_QUEUE_MAX)
  })

  it('rejects a steer with no runId or no id', () => {
    expect(enqueueSteer('', steer('a'))).toBe(false)
    expect(enqueueSteer(run, { id: '', text: 'x' })).toBe(false)
  })

  it('inboxes for different runs are independent (sub-agent isolation)', () => {
    const parent = freshRun()
    const sub = freshRun()
    enqueueSteer(parent, steer('p'))
    // a sub-agent draining its OWN runId finds nothing — parent's steer is untouched
    expect(drainSteers(sub)).toEqual([])
    expect(drainSteers(parent).map((s) => s.id)).toEqual(['p'])
  })
})

describe('validateSteerPayload (IPC trust boundary)', () => {
  it('accepts a valid payload and trims the text', () => {
    const v = validateSteerPayload({ runId: 'r', id: 'i', text: '  make it blue  ' })
    expect(v).toEqual({ ok: true, runId: 'r', steer: { id: 'i', text: 'make it blue' } })
  })

  it('rejects missing runId / id / non-string text', () => {
    expect(validateSteerPayload({ id: 'i', text: 't' })).toMatchObject({ ok: false, reason: 'missing-runid' })
    expect(validateSteerPayload({ runId: 'r', text: 't' })).toMatchObject({ ok: false, reason: 'missing-id' })
    expect(validateSteerPayload({ runId: 'r', id: 'i', text: 5 })).toMatchObject({ ok: false, reason: 'missing-text' })
  })

  it('rejects whitespace-only text', () => {
    expect(validateSteerPayload({ runId: 'r', id: 'i', text: '   ' })).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('rejects text over the length cap', () => {
    const v = validateSteerPayload({ runId: 'r', id: 'i', text: 'x'.repeat(STEER_TEXT_MAX + 1) })
    expect(v).toMatchObject({ ok: false, reason: 'too-long' })
  })

  it('accepts text EXACTLY at the cap (inclusive boundary)', () => {
    expect(validateSteerPayload({ runId: 'r', id: 'i', text: 'x'.repeat(STEER_TEXT_MAX) })).toMatchObject({ ok: true })
  })

  it('trims before measuring length (whitespace does not count toward the cap)', () => {
    const padded = '  ' + 'x'.repeat(STEER_TEXT_MAX) + '  '
    expect(validateSteerPayload({ runId: 'r', id: 'i', text: padded })).toMatchObject({
      ok: true,
      steer: { text: 'x'.repeat(STEER_TEXT_MAX) },
    })
  })
})

describe('acceptSteer (IPC trust-boundary decision)', () => {
  const active = (live: string) => (runId: string) => runId === live

  it('enqueues for an active run with a valid payload', () => {
    const run = freshRun()
    const r = acceptSteer({ runId: run, id: 'i', text: 'hi' }, active(run))
    expect(r).toEqual({ status: 'enqueued', ok: true })
    expect(steerQueueDepth(run)).toBe(1)
    drainSteers(run)
  })

  it('returns inactive (no enqueue) when the run is not active — run ended, client resends', () => {
    const run = freshRun()
    const r = acceptSteer({ runId: run, id: 'i', text: 'hi' }, () => false)
    expect(r).toEqual({ status: 'inactive' })
    expect(steerQueueDepth(run)).toBe(0)
  })

  it('returns invalid (no enqueue) on a bad payload — handler throws', () => {
    const run = freshRun()
    expect(acceptSteer({ id: 'i', text: 'hi' }, active(run))).toMatchObject({
      status: 'invalid',
      reason: 'missing-runid',
    })
    expect(acceptSteer({ runId: run, id: 'i', text: '  ' }, active(run))).toMatchObject({
      status: 'invalid',
      reason: 'empty',
    })
  })

  it('returns enqueued:false when the active run is at the flood cap', () => {
    const run = freshRun()
    for (let i = 0; i < STEER_QUEUE_MAX; i++) enqueueSteer(run, { id: `a${i}`, text: 't' })
    expect(acceptSteer({ runId: run, id: 'x', text: 'over' }, active(run))).toEqual({ status: 'enqueued', ok: false })
    drainSteers(run)
  })
})
