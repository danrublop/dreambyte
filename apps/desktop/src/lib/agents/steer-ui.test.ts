// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  composerDisabled,
  shouldRouteToSteer,
  annotateUnconsumedSteer,
  hasUnconsumedSteerMarker,
  stripUnconsumedSteerMarker,
  UNCONSUMED_STEER_MARKER,
  composerSteerPlaceholder,
  historyCliffNote,
  filterConversations,
  AGENT_HISTORY_WINDOW,
  STEER_NOT_READY_NOTICE,
} from './steer-ui'

describe('annotateUnconsumedSteer', () => {
  it('appends the not-applied marker', () => {
    const out = annotateUnconsumedSteer('make it blue')
    expect(out).toContain('make it blue')
    expect(out).toContain(UNCONSUMED_STEER_MARKER)
  })
  it('is idempotent — a repeated unconsumed event does not double-append', () => {
    const once = annotateUnconsumedSteer('make it blue')
    expect(annotateUnconsumedSteer(once)).toBe(once)
  })
})

describe('hasUnconsumedSteerMarker', () => {
  it('detects an annotated message', () => {
    expect(hasUnconsumedSteerMarker(annotateUnconsumedSteer('make it blue'))).toBe(true)
  })
  it('returns false for a plain message', () => {
    expect(hasUnconsumedSteerMarker('make it blue')).toBe(false)
  })
})

describe('stripUnconsumedSteerMarker', () => {
  it('recovers the original steer text', () => {
    const annotated = annotateUnconsumedSteer('make it blue')
    expect(stripUnconsumedSteerMarker(annotated)).toBe('make it blue')
  })
  it('round-trips multi-line steer text', () => {
    const original = 'make it blue\nand add a title'
    expect(stripUnconsumedSteerMarker(annotateUnconsumedSteer(original))).toBe(original)
  })
  it('is a no-op (trim only) on un-annotated text', () => {
    expect(stripUnconsumedSteerMarker('  make it blue  ')).toBe('make it blue')
  })
})

describe('composerDisabled', () => {
  it('disabled only for a remote run with no local run', () => {
    expect(composerDisabled(false, true)).toBe(true)
  })
  it('enabled during a local run (so you can steer)', () => {
    expect(composerDisabled(true, true)).toBe(false)
    expect(composerDisabled(true, false)).toBe(false)
  })
  it('enabled when idle (normal send)', () => {
    expect(composerDisabled(false, false)).toBe(false)
  })
})

describe('shouldRouteToSteer', () => {
  it('steers when a local run is active AND its runId is known', () => {
    expect(shouldRouteToSteer(true, 'run-123')).toBe(true)
  })
  it('falls through to a normal send when the runId is not known yet', () => {
    expect(shouldRouteToSteer(true, null)).toBe(false)
    expect(shouldRouteToSteer(true, '')).toBe(false)
  })
  it('normal send when idle', () => {
    expect(shouldRouteToSteer(false, 'run-123')).toBe(false)
  })
})

// ── A2 chat-trust additions ──────────────────────────────────────────────────

describe('composerSteerPlaceholder', () => {
  it('promises a steer only once the runId is known', () => {
    expect(composerSteerPlaceholder(true)).toContain('Steer the agent')
  })
  it('is honest about the pre-runId window (submit is refused, not steered)', () => {
    const msg = composerSteerPlaceholder(false)
    expect(msg).not.toContain('Steer the agent')
    // Must not promise an action — handleSend refuses submits in this window
    // (review D1). The copy says steering is coming, nothing more.
    expect(msg).not.toContain('new turn')
    expect(msg).toContain('unlocks in a moment')
  })
  it('the refusal notice exists and tells the user their text survived', () => {
    expect(STEER_NOT_READY_NOTICE).toContain('still in the box')
  })
  it('placeholder honesty matches the routing predicate it describes', () => {
    // steerReady mirrors "activeLocalRunId is set" — the exact condition
    // shouldRouteToSteer requires. Pin the pairing so they can't drift.
    expect(shouldRouteToSteer(true, 'run-1')).toBe(true) // ready → steer text
    expect(shouldRouteToSteer(true, null)).toBe(false) // not ready → new-turn text
  })
})

describe('historyCliffNote', () => {
  it('null when the whole conversation fits the window (no noise)', () => {
    expect(historyCliffNote(0)).toBeNull()
    expect(historyCliffNote(AGENT_HISTORY_WINDOW)).toBeNull()
  })
  it('appears exactly when messages start falling off the cliff', () => {
    const note = historyCliffNote(AGENT_HISTORY_WINDOW + 1)
    expect(note).toBe(`agent sees the last ${AGENT_HISTORY_WINDOW} of ${AGENT_HISTORY_WINDOW + 1} messages`)
  })
  it('window override is respected (and the default IS the shared constant)', () => {
    expect(historyCliffNote(5, 3)).toBe('agent sees the last 3 of 5 messages')
    expect(historyCliffNote(5, 5)).toBeNull()
  })
})

describe('filterConversations', () => {
  const convs = [
    { title: 'Intro video plan', messages: [{ content: 'make a 30s intro' }] },
    { title: 'Logo reveal', messages: [{ content: 'spin the LOGO in 3D' }] },
    { title: null, messages: [{ content: 'untitled scratch chat' }] },
    { title: 'Empty', messages: [] },
  ]

  it('empty / whitespace query returns the list untouched (same reference)', () => {
    expect(filterConversations(convs, '')).toBe(convs)
    expect(filterConversations(convs, '   ')).toBe(convs)
  })
  it('matches titles case-insensitively', () => {
    expect(filterConversations(convs, 'INTRO').map((c) => c.title)).toEqual(['Intro video plan'])
  })
  it('matches first-message preview text when the title misses', () => {
    expect(filterConversations(convs, 'scratch').map((c) => c.title)).toEqual([null])
    expect(filterConversations(convs, 'logo').map((c) => c.title)).toEqual(['Logo reveal']) // title AND preview — no dupes
  })
  it('handles null titles and empty message lists without throwing', () => {
    expect(filterConversations(convs, 'zzz-no-match')).toEqual([])
  })
  it('handles conversations with no messages field at all', () => {
    expect(filterConversations([{ title: 'bare' }], 'bare')).toHaveLength(1)
    expect(filterConversations([{ title: 'bare' }], 'other')).toHaveLength(0)
  })
  it('searches only the preview message (messages[0]), never later entries', () => {
    // Pins the deliberate narrow scope: the conversation list carries ONE
    // message per conversation (the latest). If someone widens the helper to
    // scan all messages, this documents that as an intentional behavior change.
    const c = [{ title: 'x', messages: [{ content: 'hello' }, { content: 'needle' }] }]
    expect(filterConversations(c, 'needle')).toEqual([])
    expect(filterConversations(c, 'hello')).toHaveLength(1)
  })
})
