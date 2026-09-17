// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createDesignToolHandler } from './design-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { GlobalStyle, SceneGraph } from '@/lib/types'

/** Direct coverage for design-tools (design_brief read/write). */

function makeWorld(): WorldStateMutable {
  return {
    scenes: [],
    globalStyle: {
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    } as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: null } as unknown as SceneGraph,
  } as unknown as WorldStateMutable
}

const handler = createDesignToolHandler()

/**
 * Minimal-valid DESIGN.md content for `create_design_brief`. Must include
 * YAML frontmatter (---), 8 required sections, and 4 token categories.
 * Kept here so the test is self-contained.
 */
const VALID_BRIEF = `---
title: Test Brief
---

## Overview
A test brief used by vitest to validate the create_design_brief shape check.

\`\`\`yaml
colors:
  primary: '#ffffff'
typography:
  fontFamily: 'Satoshi'
spacing:
  base: 8
rounded:
  base: 4
\`\`\`

## Colors
Primary white.

## Typography
fontFamily: 'Satoshi'

## Layout
Single column.

## Elevation
Flat.

## Shapes
Rounded 4px.

## Components
Card, button, input.

## Do's and Don'ts
Do use spacing tokens. Don't hard-code values.
`

describe('design-tools', () => {
  it('create_design_brief rejects content under 100 characters', async () => {
    const world = makeWorld()
    const result = await handler('create_design_brief', { content: 'too short' }, world)
    expect(result.success).toBe(false)
  })

  it('create_design_brief rejects missing sections + missing tokens', async () => {
    const world = makeWorld()
    const longButInvalid = 'a'.repeat(500) // 500 chars, no sections, no tokens
    const result = await handler('create_design_brief', { content: longButInvalid }, world)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing section')
  })

  it('create_design_brief saves a complete brief into globalStyle.designBrief', async () => {
    const world = makeWorld()
    const result = await handler('create_design_brief', { content: VALID_BRIEF }, world)
    expect(result.success).toBe(true)
    expect(world.globalStyle.designBrief).toBe(VALID_BRIEF.trim())
  })

  it('create_design_brief flags forbidden neon colors', async () => {
    const world = makeWorld()
    const withNeon = VALID_BRIEF + '\nNeon: #00e5ff\n'
    const result = await handler('create_design_brief', { content: withNeon }, world)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Forbidden color')
  })

  it('read_design_brief returns the saved brief', async () => {
    const world = makeWorld()
    await handler('create_design_brief', { content: VALID_BRIEF }, world)
    const result = await handler('read_design_brief', {}, world)
    expect(result.success).toBe(true)
    expect((result.data as { content: string }).content).toBe(VALID_BRIEF.trim())
  })

  it('read_design_brief errors when no brief has been set', async () => {
    const world = makeWorld()
    const result = await handler('read_design_brief', {}, world)
    expect(result.success).toBe(false)
  })

  // ── A2 — Reference Match appendix: hex + descriptor match precision ──
  it('appends a reference hex token even when only an unrelated longer hex is in the brief', async () => {
    const world = makeWorld()
    // Brief mentions #abcdef (unrelated); reference palette is #abc (→ #aabbcc) —
    // must NOT be suppressed as a substring of #abcdef.
    const brief = VALID_BRIEF + '\nAccent: #abcdef\n'
    const result = await handler(
      'create_design_brief',
      {
        content: brief,
        referenceTokens: { palette: ['#abc'] },
      },
      world,
    )
    expect(result.success).toBe(true)
    expect((result.data as { referenceApplied: boolean }).referenceApplied).toBe(true)
    expect(world.globalStyle.designBrief).toContain('## Reference Match')
    expect(world.globalStyle.designBrief).toContain('#abc')
  })

  it('does NOT append a reference hex already named in the brief in a different case-shape', async () => {
    const world = makeWorld()
    // Brief declares #ffffff (in VALID_BRIEF colors); reference says #fff → same color
    // canonically → must be suppressed (no appendix).
    const result = await handler(
      'create_design_brief',
      {
        content: VALID_BRIEF,
        referenceTokens: { palette: ['#fff'] },
      },
      world,
    )
    expect(result.success).toBe(true)
    // Only-token was a duplicate → no appendix added.
    expect((result.data as { referenceApplied: boolean }).referenceApplied).toBe(false)
    expect(world.globalStyle.designBrief).not.toContain('## Reference Match')
  })

  it('appends "soft light" lighting when the brief only mentions "soft lightbox"', async () => {
    const world = makeWorld()
    const brief = VALID_BRIEF + '\nLighting: a soft lightbox rig.\n'
    const result = await handler(
      'create_design_brief',
      {
        content: brief,
        referenceTokens: { lighting: 'soft light' },
      },
      world,
    )
    expect(result.success).toBe(true)
    expect((result.data as { referenceApplied: boolean }).referenceApplied).toBe(true)
    expect(world.globalStyle.designBrief).toContain('Lighting: soft light')
  })

  // ── B1 — referenceStyleTokens consume-once lifecycle ──
  it('clears world.referenceStyleTokens after a brief consumes it (no stale bleed)', async () => {
    const world = makeWorld()
    world.referenceStyleTokens = { mood: 'warm archival', palette: ['#abcdef'] }
    const result = await handler('create_design_brief', { content: VALID_BRIEF }, world)
    expect(result.success).toBe(true)
    // Applied once on this brief...
    expect((result.data as { referenceApplied: boolean }).referenceApplied).toBe(true)
    // ...then cleared so a LATER unrelated brief can't silently reuse it.
    expect(world.referenceStyleTokens).toBeUndefined()

    // A second, unrelated brief must NOT carry the prior reference's appendix.
    const second = await handler('create_design_brief', { content: VALID_BRIEF }, world)
    expect(second.success).toBe(true)
    expect((second.data as { referenceApplied: boolean }).referenceApplied).toBe(false)
    expect(world.globalStyle.designBrief).not.toContain('## Reference Match')
  })
})
