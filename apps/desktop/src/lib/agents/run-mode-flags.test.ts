// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { runModeSpendFlags, type AgentRunMode } from './types'

describe('runModeSpendFlags — picker → request spend flags (D2)', () => {
  it('auto → auto-approve posture, no sandbox', () => {
    expect(runModeSpendFlags('auto')).toEqual({ sandboxMode: false, permissionPosture: 'auto' })
  })

  it('ask → confirm-card posture, no sandbox', () => {
    expect(runModeSpendFlags('ask')).toEqual({ sandboxMode: false, permissionPosture: 'ask' })
  })

  it('sandbox → sandbox on, neutral posture (never reaches the paid path)', () => {
    expect(runModeSpendFlags('sandbox')).toEqual({ sandboxMode: true, permissionPosture: 'default' })
  })

  it('plan → neutral posture, no sandbox (planFirstMode is derived separately)', () => {
    expect(runModeSpendFlags('plan')).toEqual({ sandboxMode: false, permissionPosture: 'default' })
  })

  it('only sandbox mode ever sets sandboxMode true', () => {
    const modes: AgentRunMode[] = ['auto', 'ask', 'plan', 'sandbox']
    expect(modes.filter((m) => runModeSpendFlags(m).sandboxMode)).toEqual(['sandbox'])
  })

  it('only ask forces the confirm card', () => {
    const modes: AgentRunMode[] = ['auto', 'ask', 'plan', 'sandbox']
    expect(modes.filter((m) => runModeSpendFlags(m).permissionPosture === 'ask')).toEqual(['ask'])
  })
})
