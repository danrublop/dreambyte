// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { postAgentSteer } from './agent-transport'

const setAgent = (agent: unknown) => {
  ;(globalThis as Record<string, unknown>).window = { dreambyteApi: { agent } }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('postAgentSteer', () => {
  it('forwards the payload and returns true when main accepts', async () => {
    const steer = vi.fn(async () => ({ ok: true }))
    setAgent({ steer })
    const ok = await postAgentSteer({ runId: 'r1', id: 'i1', text: 'make it blue' })
    expect(ok).toBe(true)
    expect(steer).toHaveBeenCalledWith({ runId: 'r1', id: 'i1', text: 'make it blue' })
  })

  it('returns false when main rejects (run ended / over cap)', async () => {
    setAgent({ steer: vi.fn(async () => ({ ok: false })) })
    expect(await postAgentSteer({ runId: 'r1', id: 'i1', text: 't' })).toBe(false)
  })

  it('returns false (no throw) when the IPC call throws', async () => {
    setAgent({
      steer: vi.fn(async () => {
        throw new Error('ipc down')
      }),
    })
    expect(await postAgentSteer({ runId: 'r1', id: 'i1', text: 't' })).toBe(false)
  })

  it('returns false when the desktop runtime is unavailable', async () => {
    // no window.dreambyteApi
    expect(await postAgentSteer({ runId: 'r1', id: 'i1', text: 't' })).toBe(false)
  })
})
