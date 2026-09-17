/**
 * Showcase fixture completeness — keyed to STATES, not components (eng review
 * outside-voice finding 9). If a card state exists in production but not in
 * the fixture, the showcase silently stops representing reality — these
 * assertions make that loud instead.
 */
import { describe, expect, it } from 'vitest'
import { buildShowcaseFixture } from './chat-ui-fixtures'
import type { SamplePermissionKind } from './sample-payloads'

describe('chat-ui-fixtures completeness', () => {
  const fixture = buildShowcaseFixture()
  const { messages } = fixture
  const assistants = messages.filter((m) => m.role === 'assistant')
  const allPermissions = assistants.flatMap((m) => m.pendingPermissions ?? [])
  const allToolCalls = assistants.flatMap((m) => m.toolCalls ?? [])

  it('is deterministic — two builds are deep-equal', () => {
    expect(buildShowcaseFixture()).toEqual(buildShowcaseFixture())
  })

  it('uses fixed timestamps (no Date.now leakage)', () => {
    const again = buildShowcaseFixture()
    for (const [i, msg] of messages.entries()) {
      expect(msg.timestamp).toBe(again.messages[i].timestamp)
    }
  })

  it('covers both user message shapes: plain text and image attachment', () => {
    const users = messages.filter((m) => m.role === 'user')
    expect(users.some((m) => typeof m.content === 'string')).toBe(true)
    expect(
      users.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image')),
    ).toBe(true)
  })

  it('covers all 4 permission kinds', () => {
    const kinds: SamplePermissionKind[] = ['paid_api', 'mutation_preview', 'web_search', 'biometric_consent']
    for (const kind of kinds) {
      expect(allPermissions.some((p) => p.kind === kind), `missing permission kind: ${kind}`).toBe(true)
    }
  })

  it('covers all 3 permission resolution states', () => {
    expect(allPermissions.some((p) => p.resolved === undefined)).toBe(true)
    expect(allPermissions.some((p) => p.resolved === 'allow')).toBe(true)
    expect(allPermissions.some((p) => p.resolved === 'deny')).toBe(true)
  })

  it('covers all 3 tool-call lifecycle states', () => {
    expect(allToolCalls.some((t) => !t.output), 'missing running tool call').toBe(true)
    expect(allToolCalls.some((t) => t.output?.success === true), 'missing successful tool call').toBe(true)
    expect(allToolCalls.some((t) => t.output?.success === false), 'missing errored tool call').toBe(true)
  })

  it('includes a multi-call burst for the ToolCallSummary collapse', () => {
    expect(assistants.some((m) => (m.toolCalls?.length ?? 0) >= 3)).toBe(true)
  })

  it('includes interleaved text/tool contentSegments', () => {
    const interleaved = assistants.find(
      (m) =>
        m.contentSegments &&
        m.contentSegments.some((s) => s.type === 'text') &&
        m.contentSegments.some((s) => s.type === 'tool'),
    )
    expect(interleaved).toBeDefined()
  })

  it('covers the banner flags: incomplete, rateLimited, checkpoint', () => {
    expect(assistants.some((m) => m.incomplete === true)).toBe(true)
    expect(assistants.some((m) => m.rateLimited === true)).toBe(true)
    const cp = assistants.find((m) => m.hasCheckpoint)
    expect(cp?.checkpointReason).toBeDefined()
    expect(cp?.checkpointScenesBuilt).toBeGreaterThan(0)
  })

  it('covers thinking, sources, and usage stats', () => {
    expect(assistants.some((m) => !!m.thinking)).toBe(true)
    expect(assistants.some((m) => (m.sources?.length ?? 0) > 0)).toBe(true)
    expect(assistants.some((m) => !!m.usage)).toBe(true)
  })

  it('injects all separate-atom card payloads (D9; storyboard removed by T9)', () => {
    expect(fixture.pendingPlan.body.length).toBeGreaterThan(0)
    expect(fixture.planAwaitingApproval).toBe(true)
    expect(fixture.structuralCutsProposed.length).toBeGreaterThan(0)
  })

  it('plan todos cover all 4 lifecycle states', () => {
    const statuses = new Set(fixture.planTodos.map((t) => t.status))
    for (const s of ['pending', 'in_progress', 'completed', 'failed']) {
      expect(statuses.has(s as never), `missing todo status: ${s}`).toBe(true)
    }
  })

  it('uses only showcase-prefixed ids (collision-proof against real data)', () => {
    for (const m of messages) expect(m.id).toMatch(/^showcase-/)
    for (const t of allToolCalls) expect(t.id).toMatch(/^showcase-/)
  })
})
