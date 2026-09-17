// @vitest-environment node
//
// Lean research prompt — a read-only research sub-agent (Explore/Plan) must get a
// SMALL system prompt, not the ~95K-char builder prompt. The big prompt both wastes
// tokens and swamps small local models (a 7B emits zero tool calls under it). Proven
// at the buildAgentContext level: what actually reaches the model's system prompt.
import { describe, it, expect } from 'vitest'
import { buildAgentContext } from './context-builder'
import type { ContextOpts } from './types'
import type { GlobalStyle } from '../types'

const GLOBAL_STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}

function promptFor(opts: Partial<ContextOpts> = {}): string {
  const ctx = buildAgentContext(
    'scene-maker',
    { agentType: 'scene-maker', activeTools: [], sceneContext: 'all', ...opts },
    [],
    GLOBAL_STYLE,
    'Lean Research Test',
    'mp4',
  )
  return ctx.systemPrompt
}

describe('lean research system prompt', () => {
  it('replaces the full builder prompt with a small research prompt', () => {
    const full = promptFor()
    const lean = promptFor({ leanResearchPrompt: true })

    // Full builder prompt is large; lean is a tiny fraction of it.
    expect(full.length).toBeGreaterThan(10_000)
    expect(lean.length).toBeLessThan(2_000)
    expect(lean.length * 5).toBeLessThan(full.length) // at least ~5x smaller

    // Lean prompt establishes the read-only researcher role + untrusted-data safety.
    expect(lean).toMatch(/read-only research/i)
    expect(lean).toMatch(/UNTRUSTED DATA/i)
    // …and drops the builder-only cascade (skill catalog / scene-building rules).
    expect(lean).not.toContain('Skill Catalog')
  })

  it('is off by default (parent build agents keep the full prompt)', () => {
    expect(promptFor().length).toBeGreaterThan(10_000)
  })
})
