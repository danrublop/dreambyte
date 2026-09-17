// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createMarlinUnderstander } from './marlin-understander'

describe('createMarlinUnderstander', () => {
  it('maps a Marlin caption to VideoUnderstanding', async () => {
    const caption = vi.fn(async () => ({
      scene: 'a person walks across a room',
      events: [{ start: 1.2, end: 3.4, description: 'person enters' }],
    }))
    const u = createMarlinUnderstander({ caption })
    const result = await u.understand('dreambyte://uploads/v.mp4')
    expect(result.scene).toBe('a person walks across a room')
    expect(result.events).toHaveLength(1)
    expect(result.backend).toBe('marlin')
    expect(caption).toHaveBeenCalledWith('dreambyte://uploads/v.mp4', { abortSignal: undefined })
  })

  it('defaults events to [] when the sidecar omits them', async () => {
    const u = createMarlinUnderstander({ caption: async () => ({ scene: 'x' }) as never })
    const result = await u.understand('v.mp4')
    expect(result.events).toEqual([])
  })

  it('propagates sidecar failure (caller degrades)', async () => {
    const u = createMarlinUnderstander({
      caption: async () => {
        throw new Error('sidecar down')
      },
    })
    await expect(u.understand('v.mp4')).rejects.toThrow('sidecar down')
  })
})
