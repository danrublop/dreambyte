// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createDesignToolHandler } from './design-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { GlobalStyle, SceneGraph } from '@/lib/types'

/**
 * Regression gate: create_design_brief must not flag two LEGITIMATE fontFamily values as
 * "Unknown font", which made EVERY token-driven brief fail on the first
 * attempt and forced the agent to redo it:
 *   1. design-token references  →  fontFamily: "{typography.label.fontFamily}"
 *   2. CSS font stacks          →  fontFamily: "JetBrains Mono, monospace"
 *
 * Both are valid. A genuinely hallucinated font must STILL be rejected.
 */

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

/** Build a complete, valid DESIGN.md with a swappable typography block. */
function brief(typographyBlock: string): string {
  return `---
title: Token Ref Test
---

## Overview
A complete brief exercising design-token references and CSS font stacks in the
typography section, used to lock in the create_design_brief validator contract.

\`\`\`yaml
colors:
  bg: '#0c0c0e'
${typographyBlock}
spacing:
  safe-area: '80px'
rounded:
  sm: '4px'
\`\`\`

## Colors
Dark ground with a single accent.

## Typography
Monospace headings, humanist body.

## Layout
Diagram-first, asymmetric.

## Elevation
Soft shadows, no text-shadow.

## Shapes
Sharp radii.

## Components
Cards and annotations.

## Do's and Don'ts
Do use the curated catalog. Don't invent fonts.
`
}

describe('create_design_brief — token-ref + font-stack false-positives (#3)', () => {
  it('accepts a {token} design-token reference as a fontFamily value', async () => {
    const world = makeWorld()
    const content = brief(`typography:
  label:
    fontFamily: 'JetBrains Mono'
  annotation:
    fontFamily: '{typography.label.fontFamily}'`)
    const result = await handler('create_design_brief', { content }, world)
    expect(result.success).toBe(true)
    expect(JSON.stringify(result)).not.toContain('Unknown font')
  })

  it('accepts a CSS font stack by validating the primary family only', async () => {
    const world = makeWorld()
    const content = brief(`typography:
  body:
    fontFamily: 'JetBrains Mono, monospace'`)
    const result = await handler('create_design_brief', { content }, world)
    expect(result.success).toBe(true)
    expect(JSON.stringify(result)).not.toContain('Unknown font')
  })

  it('STILL rejects a genuinely hallucinated font (guard not weakened)', async () => {
    const world = makeWorld()
    const content = brief(`typography:
  display:
    fontFamily: 'Totally Made Up Font 9000'`)
    const result = await handler('create_design_brief', { content }, world)
    expect(result.success).toBe(false)
    expect(String((result as { error?: string }).error)).toContain('Unknown font')
  })
})
