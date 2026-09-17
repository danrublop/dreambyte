// @vitest-environment node
//
// PR-C (filmmaking grounding) — proves an explicitly-named video type takes
// precedence in the assembled system prompt (C.3). End-to-end at the
// buildAgentContext level: what reaches the model's system prompt, not just the
// helper return.

import { describe, it, expect, vi, afterEach } from 'vitest'
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
    'Filmmaking Grounding Test',
    'mp4',
  )
  return ctx.systemPrompt
}

// C.1 (the plan phase consumes src/lib/skills/library/index.md) was DELETED in H3.
// The block ordered the planner to "route each planned scene to the skill", but
// plan_scenes has no skill field and selectSkillsForScene() derives the skill
// deterministically from sceneType + visualForm. Guarded below so it can't return
// without a routing field to land in.
describe('C.1 — the unroutable Skill Catalog stays out of the prompt', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not inject a skill catalog the planner cannot act on', () => {
    const prompt = promptFor()
    expect(prompt).not.toContain('Skill Catalog')
    expect(prompt).not.toMatch(/skipping risks/)
  })
})

describe('C.3 — explicit video-type precedence in the prompt', () => {
  it('states the precedence rule above the renderer decision map', () => {
    const prompt = promptFor()
    expect(prompt).toContain('VIDEO-TYPE PRECEDENCE')
    // The precedence section appears before the renderer decision map.
    expect(prompt.indexOf('VIDEO-TYPE PRECEDENCE')).toBeLessThan(prompt.indexOf('RENDERER INTENT'))
  })

  // The two tests that lived here asserted the EXPLICIT-playbook pacing facet
  // (a "how-to" ask and a "podcast clip" ask each matched a per-type template, plus a
  // capability-gap warning). Both pipelines are deleted, so the assertion below is
  // the surviving contract: naming a video type must not conjure a per-type template.
  it('naming a video type injects NO playbook — the pipelines are deleted', () => {
    for (const msg of ['turn this into a how-to about our app', 'turn this into a podcast clip']) {
      const prompt = promptFor({ latestUserMessage: msg })
      expect(prompt).not.toContain('Pacing / structure')
      expect(prompt).not.toContain('Playbook pattern')
      expect(prompt).not.toContain('How-To / Step-by-Step Guide')
      expect(prompt).not.toMatch(/playbook "/)
    }
  })
})
