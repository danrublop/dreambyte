import { describe, it, expect } from 'vitest'
import { preserveLocalTimelineMeta } from './timeline-actions'
import type { Timeline } from '@/lib/types'

const tl = (over: Partial<Timeline>): Timeline => ({ tracks: [], ...over }) as Timeline

describe('preserveLocalTimelineMeta (v6 review: mid-run marker survives the post-run refresh)', () => {
  it('unions a local-only marker (id the server lacks) into the server timeline', () => {
    const server = tl({ markers: [{ id: 'm1', time: 1 }] as any })
    const current = tl({
      markers: [
        { id: 'm1', time: 1 },
        { id: 'mid-run', time: 5 },
      ] as any,
    })
    const out = preserveLocalTimelineMeta(server, current)
    const ids = (out!.markers as Array<{ id: string }>).map((m) => m.id).sort()
    expect(ids).toEqual(['m1', 'mid-run'])
  })

  it("server's version wins on a SHARED id (agent-edited marker is authoritative)", () => {
    const server = tl({ markers: [{ id: 'm1', time: 9 }] as any }) // agent moved it
    const current = tl({ markers: [{ id: 'm1', time: 1 }] as any }) // stale local
    const out = preserveLocalTimelineMeta(server, current)
    const m1 = (out!.markers as Array<{ id: string; time: number }>).find((m) => m.id === 'm1')
    expect(m1!.time).toBe(9)
    expect((out!.markers as any[]).length).toBe(1)
  })

  it('REGRESSION: no local markers → returns the server markers unchanged (normal refresh byte-identical)', () => {
    const server = tl({ markers: [{ id: 'm1', time: 1 }] as any })
    const current = tl({ markers: [{ id: 'm1', time: 1 }] as any })
    const out = preserveLocalTimelineMeta(server, current)
    expect(out!.markers).toBe(server.markers) // same reference — no churn
  })

  it('preserves local inPoint/outPoint only when the server omits them', () => {
    const current = tl({ inPoint: 2, outPoint: 8 })
    expect(preserveLocalTimelineMeta(tl({}), current)).toMatchObject({ inPoint: 2, outPoint: 8 })
    // server provides its own → server wins
    expect(preserveLocalTimelineMeta(tl({ inPoint: 3, outPoint: 9 }), current)).toMatchObject({
      inPoint: 3,
      outPoint: 9,
    })
  })

  it('null/undefined inputs pass through (no local state, or no server timeline)', () => {
    expect(preserveLocalTimelineMeta(null, tl({ markers: [{ id: 'x' }] as any }))).toBeNull()
    const server = tl({ markers: [{ id: 'm1' }] as any })
    expect(preserveLocalTimelineMeta(server, null)).toBe(server)
    expect(preserveLocalTimelineMeta(server, undefined)).toBe(server)
  })
})
