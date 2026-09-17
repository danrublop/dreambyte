// @vitest-environment node
//
// T3 — the SINGLE memory prompt-injection path (PR-B decision 4). Proves:
//   - a silent user inherits a learned preference (it reaches the system prompt
//     as an active default)
//   - the contract that an EXPLICIT current request overrides a conflicting
//     learned preference is stated in the prompt (the user-wins HARD RULE)
//   - low-confidence memories are filtered; injection is ordered by confidence
//   - no memories → no memory section (no empty block leaks)

import { describe, it, expect } from 'vitest'
import { buildAgentContext } from './context-builder'
import type { GlobalStyle } from '../types'

const GLOBAL_STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}

type Mem = { category: string; key: string; value: string; confidence: number }

function promptFor(userMemories?: Mem[]): string {
  const ctx = buildAgentContext(
    'scene-maker',
    { agentType: 'scene-maker', activeTools: [], sceneContext: 'all' },
    [],
    GLOBAL_STYLE,
    'Memory Path Test',
    'mp4',
    undefined,
    undefined,
    'off',
    undefined,
    undefined,
    userMemories,
  )
  return ctx.systemPrompt
}

describe('buildAgentContext — memory prompt path (T3)', () => {
  it('a silent user inherits the learned preference as an active default', () => {
    const prompt = promptFor([{ category: 'style', key: 'bg', value: 'dark backgrounds', confidence: 0.7 }])
    expect(prompt).toContain('Learned User Preferences')
    expect(prompt).toContain('dark backgrounds')
    expect(prompt).toContain('ACTIVE DEFAULT')
  })

  it('states the contract that an explicit current request overrides a conflicting preference', () => {
    const prompt = promptFor([{ category: 'style', key: 'bg', value: 'dark backgrounds', confidence: 0.7 }])
    // The user-wins rule is what stops a learned dark-bg from beating an
    // explicit "light background" request this session.
    expect(prompt).toMatch(/explicit request[\s\S]*always wins/i)
    expect(prompt).toMatch(/obey the user/i)
  })

  it('filters low-confidence memories (< 0.3)', () => {
    const prompt = promptFor([
      { category: 'style', key: 'kept', value: 'reinforced taste', confidence: 0.6 },
      { category: 'style', key: 'weak', value: 'barely seen guess', confidence: 0.2 },
    ])
    expect(prompt).toContain('reinforced taste')
    expect(prompt).not.toContain('barely seen guess')
  })

  it('orders injected memories by confidence (most-reinforced first)', () => {
    const prompt = promptFor([
      { category: 'style', key: 'low', value: 'lower_pref_value', confidence: 0.35 },
      { category: 'style', key: 'high', value: 'higher_pref_value', confidence: 0.9 },
    ])
    expect(prompt.indexOf('higher_pref_value')).toBeLessThan(prompt.indexOf('lower_pref_value'))
  })

  it('emits no memory section when there are no memories', () => {
    expect(promptFor()).not.toContain('Learned User Preferences')
    expect(promptFor([])).not.toContain('Learned User Preferences')
  })
})
