import { describe, it, expect } from 'vitest'
import { parseCommand } from './commands'

// One-agent model: slash commands never select a persona. /plan toggles
// plan-first mode; /style, /batch, /redo all run as the single agent.
describe('slash commands — one-agent model', () => {
  it('/plan triggers plan-first mode, not a planner persona', () => {
    const r = parseCommand('/plan how photosynthesis works')
    expect(r?.type).toBe('agent')
    if (r?.type === 'agent') {
      expect(r.planFirstMode).toBe(true)
    }
  })

  it('/style runs as the single agent (not plan-first)', () => {
    const r = parseCommand('/style whiteboard')
    expect(r?.type).toBe('agent')
    if (r?.type === 'agent') {
      expect(r.planFirstMode).toBeUndefined()
    }
  })

  it('/batch runs as the single agent', () => {
    const r = parseCommand('/batch make all text bigger')
    expect(r?.type).toBe('agent')
  })

  it('/redo runs as the single agent', () => {
    const r = parseCommand('/redo')
    expect(r?.type).toBe('agent')
  })

  it('a non-command message returns null', () => {
    expect(parseCommand('just build a scene about cells')).toBeNull()
  })
})
