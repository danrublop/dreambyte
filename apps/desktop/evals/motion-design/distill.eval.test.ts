// @vitest-environment node
/**
 * GOLDEN eval — distill → load → carry-through.
 *
 * The first signal that distillation + auto-load actually CLOSE THE LOOP (not
 * just round-trip a file). It takes a KNOWN finished project, distils its style
 * to a skill, then — simulating a FRESH BUILD — auto-selects that style and
 * asserts the project's load-bearing identity (palette, font, dominant
 * sceneType/renderer) CARRIES THROUGH into what a scene sub-agent would receive.
 *
 * $0: the enrichment model is mocked via __setEnrichTransportForTesting, so this
 * exercises the deterministic observe → render → write → select → inject spine
 * without a paid call. The LIVE quality bar (does the prose read well, does the
 * model honour it) is an in-app check — out of scope here by design.
 *
 * Isolated under a tmp $HOME so the writable styles dir never touches the real
 * ~/.dreambyte.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Scene } from '../../src/lib/types'
import type { GlobalStyle } from '../../src/lib/types/project'
import {
  distillStyle,
  selectProjectStyle,
  buildStyleIntent,
  __setEnrichTransportForTesting,
} from '../../src/lib/skills/distill'
import { loadSkill, reindexSkills } from '../../src/lib/skills/registry'

// ── The KNOWN finished project (the golden input) ─────────────────────────────
const GOLDEN_PALETTE = ['#0f1b2d', '#f5f0e6', '#d96c4a', '#3a7ca5']
const GOLDEN_HEADING_FONT = 'Söhne'
const GOLDEN_BODY_FONT = 'Inter'
const GOLDEN_RENDERER = 'react'

function goldenProject(): { id: string; scenes: Scene[]; globalStyle: GlobalStyle } {
  const scene = (id: string, sceneType: string): Scene =>
    ({
      id,
      name: id,
      bgColor: '#0f1b2d',
      sceneType,
      cameraMotion: [{ type: 'dollyIn' }, { type: 'pan' }],
      duration: 6,
    }) as unknown as Scene
  return {
    id: 'golden-editorial-data-2026',
    scenes: [scene('intro', GOLDEN_RENDERER), scene('chart', GOLDEN_RENDERER), scene('outro', 'three')],
    globalStyle: {
      presetId: null,
      paletteOverride: GOLDEN_PALETTE as [string, string, string, string],
      bgColorOverride: null,
      fontOverride: GOLDEN_HEADING_FONT,
      bodyFontOverride: GOLDEN_BODY_FONT,
      strokeColorOverride: null,
      motionPersonality: 'premium',
      designBrief: 'A calm, editorial data narrative — muted navy ground, warm accent, confident type.',
    } as unknown as GlobalStyle,
  }
}

describe('E2 golden — distill → load → carry-through', () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = mkdtempSync(join(tmpdir(), 'db-e2-golden-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    reindexSkills()
    // Deterministic, $0 enrichment with strong, matchable intent tags.
    __setEnrichTransportForTesting(async () =>
      JSON.stringify({
        name: 'Editorial Data',
        evokes: 'Calm, editorial, data-led.',
        reachForWhen: 'Use it on data narratives and explainers.',
        skipRisks: 'Skipping risks a louder, inconsistent look.',
        tags: ['editorial', 'data-story', 'calm', 'premium'],
      }),
    )
  })

  afterEach(() => {
    __setEnrichTransportForTesting(null)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    try {
      rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    reindexSkills()
  })

  it('distils the golden project into a loadable style skill', async () => {
    const out = await distillStyle(goldenProject())
    expect(out).not.toBeNull()
    expect(out!.enrichment).toBe('llm')
    const skill = loadSkill(out!.id)
    expect(skill).not.toBeNull()
    expect(skill!.metadata.category).toBe('style')
    expect(skill!.metadata.origin).toBe('distilled')
  })

  it('CARRY-THROUGH: palette + fonts + dominant renderer survive into a fresh build', async () => {
    // 1. Distil the finished project.
    const out = await distillStyle(goldenProject())
    expect(out).not.toBeNull()

    // 2. Simulate a FRESH BUILD: classify a new project's intent, auto-select the style.
    const intent = buildStyleIntent({
      title: 'New editorial data explainer',
      styleNotes: 'calm, premium, data-story feel',
      scenes: [{ name: 'Hook', purpose: 'a calm data-led intro' }],
    })
    const selected = selectProjectStyle(intent)
    expect(selected, 'fresh build should auto-load the distilled style').not.toBeNull()
    expect(selected!.metadata.id).toBe(out!.id)

    // 3. The load-bearing identity must CARRY THROUGH into the guide the scene
    //    sub-agent receives (the body records the observed facts to honour).
    const guide = selected!.guide
    for (const colour of GOLDEN_PALETTE) {
      expect(guide, `palette colour ${colour} should carry through`).toContain(colour)
    }
    expect(guide, 'heading font should carry through').toContain(GOLDEN_HEADING_FONT)
    expect(guide, 'body font should carry through').toContain(GOLDEN_BODY_FONT)
    expect(guide, 'dominant renderer should carry through').toContain(GOLDEN_RENDERER)
    // The negative-framed routing prose is present (reach-for / skip-risk).
    expect(guide).toContain('Reach for it when')
    expect(guide).toContain('Skipping it risks')
  })

  it('an UNRELATED build does not pull the editorial style (no false carry-through)', async () => {
    await distillStyle(goldenProject())
    const intent = buildStyleIntent({
      title: 'Explosive 3d physics asteroid sim',
      styleNotes: 'chaotic particle collisions',
      scenes: [{ name: 'Boom', purpose: 'asteroids smashing in zero gravity' }],
    })
    expect(selectProjectStyle(intent)).toBeNull()
  })
})
