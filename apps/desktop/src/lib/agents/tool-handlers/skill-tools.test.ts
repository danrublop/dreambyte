// @vitest-environment node
//
// Handler tests for the E2 style_skill tool (T5/T7) — the distill / apply / delete
// actions that used to be distill_style / apply_saved_style / delete_style_skill.
// $0: the enrichment model is mocked; $HOME is overridden to a tmp dir so the
// writable styles dir is isolated.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Scene } from '@/lib/types'
import type { GlobalStyle } from '@/lib/types/project'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { createSkillToolHandler } from './skill-tools'
import { STYLE_SKILL } from '../tools'
import {
  __setEnrichTransportForTesting,
  renderStyleSkill,
  stubProse,
  writeStyleSkill,
  type StyleObservation,
} from '@/lib/skills/distill'
import { getUserStylesDir, getAllSkillIds, reindexSkills } from '@/lib/skills/registry'
import { composeFacetedStyleSpec } from '@/lib/agents/faceted-style-composer'

const handle = createSkillToolHandler()

function makeScene(over: Partial<Scene> = {}): Scene {
  return {
    id: over.id ?? 'sc1',
    name: over.name ?? 'Scene',
    bgColor: over.bgColor ?? '#101418',
    sceneType: (over.sceneType as Scene['sceneType']) ?? 'react',
    cameraMotion: over.cameraMotion ?? null,
    duration: 5,
  } as unknown as Scene
}

function makeWorld(over: Partial<WorldStateMutable> = {}): WorldStateMutable {
  const globalStyle = {
    presetId: null,
    paletteOverride: ['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'],
    bgColorOverride: null,
    fontOverride: 'Söhne',
    bodyFontOverride: null,
    strokeColorOverride: null,
  } as unknown as GlobalStyle
  return {
    scenes: [makeScene({ id: 'a' }), makeScene({ id: 'b', sceneType: 'three' })],
    globalStyle,
    projectName: 'Test Project',
    projectId: 'proj-handler-1',
    outputMode: 'mp4',
    sceneGraph: {} as never,
    ...over,
  } as WorldStateMutable
}

describe("style_skill action:'distill' / action:'delete' (T5/T7)", () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'db-skill-handler-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    reindexSkills()
  })

  afterEach(() => {
    __setEnrichTransportForTesting(null)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    reindexSkills()
  })

  it('happy path: distills the current project → returns a skill id', async () => {
    __setEnrichTransportForTesting(async () =>
      JSON.stringify({
        name: 'Handler Style',
        evokes: 'e',
        reachForWhen: 'r',
        skipRisks: 's',
        tags: ['handler'],
      }),
    )
    const res = await handle('style_skill', { action: 'distill' }, makeWorld())
    expect(res.success).toBe(true)
    const data = res.data as { skillId: string; enrichment: string }
    expect(data.skillId).toMatch(/^handler-style-/)
    expect(data.enrichment).toBe('llm')
    expect(fs.existsSync(path.join(getUserStylesDir(), `${data.skillId}.md`))).toBe(true)
  })

  it('honest-empty: a project with no scenes returns an error (no lie)', async () => {
    const res = await handle('style_skill', { action: 'distill' }, makeWorld({ scenes: [] }))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Nothing to distil/i)
  })

  it('requires a world context', async () => {
    const res = await handle('style_skill', { action: 'distill' }, undefined)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/active project context/i)
  })

  it("action:'delete' removes a distilled skill", async () => {
    __setEnrichTransportForTesting(async () => null) // stub is fine
    const created = await handle('style_skill', { action: 'distill', name: 'To Delete' }, makeWorld())
    const id = (created.data as { skillId: string }).skillId
    expect(getAllSkillIds()).toContain(id)

    const del = await handle('style_skill', { action: 'delete', skillId: id }, makeWorld())
    expect(del.success).toBe(true)
    expect(getAllSkillIds()).not.toContain(id)
  })

  it("action:'delete' refuses a curated/built-in skill", async () => {
    const res = await handle('style_skill', { action: 'delete', skillId: 'threejs-3d-scene' }, makeWorld())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/built-in.*cannot be deleted/i)
    // the curated skill is still present
    expect(getAllSkillIds()).toContain('threejs-3d-scene')
  })

  it("action:'delete' on an unknown id → honest not-found", async () => {
    const res = await handle('style_skill', { action: 'delete', skillId: 'no-such-style-9999' }, makeWorld())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/No distilled style skill/i)
  })

  // A4 — curated-delete edge: an orphaned distilled file in the USER dir whose id
  // collides with a curated library id is shadowed by the curated file (loadSkill
  // resolves library first), so the old refuse-when-curated guard made it
  // permanently unremovable (it still counted toward the cap-25 + mtime
  // signature). The handler must now ALSO attempt the user-dir-scoped delete (which
  // only touches the styles dir → can never reach the real curated library file).
  it('removes an orphaned distilled file shadowed by a curated id (and keeps the curated lib file)', async () => {
    // Seed a user-styles file named after a curated library skill id.
    const curatedId = 'threejs-3d-scene'
    const dir = getUserStylesDir()
    fs.mkdirSync(dir, { recursive: true })
    const shadowPath = path.join(dir, `${curatedId}.md`)
    const md = [
      '---',
      `id: ${curatedId}`,
      'name: Orphaned Shadow',
      'type: skill',
      'category: style',
      'tier: on-demand',
      'origin: distilled',
      'enrichment: stub',
      'sceneType: any',
      'complexity: medium',
      'tags: [distilled]',
      'description: An orphaned distilled file shadowed by a curated id.',
      `timestamp: ${new Date().toISOString()}`,
      '---',
      '# Orphaned Shadow',
      '',
      'body',
    ].join('\n')
    fs.writeFileSync(shadowPath, md, 'utf-8')
    reindexSkills()
    expect(fs.existsSync(shadowPath)).toBe(true)

    const del = await handle('style_skill', { action: 'delete', skillId: curatedId }, makeWorld())
    expect(del.success).toBe(true)
    expect((del.data as { shadowedCurated: boolean }).shadowedCurated).toBe(true)
    // The shadowed distilled file is gone...
    expect(fs.existsSync(shadowPath)).toBe(false)
    // ...but the real curated library skill is untouched and still loadable.
    expect(getAllSkillIds()).toContain(curatedId)
  })

  describe('style_skill discriminator', () => {
    // The merge's contract: every old capability is still reachable through `action`,
    // and an invalid one errors honestly instead of silently no-opping.
    it('every advertised action reaches its own branch', async () => {
      const actions = (STYLE_SKILL.input_schema as unknown as { properties: { action: { enum: string[] } } }).properties
        .action.enum
      expect(actions).toEqual(['distill', 'apply', 'delete'])
      for (const action of actions) {
        const res = await handle('style_skill', { action }, makeWorld())
        expect(res.error ?? '', `action "${action}" fell through to the unknown-action branch`).not.toMatch(
          /unknown action/i,
        )
      }
    })

    it('an unknown action errors honestly', async () => {
      const res = await handle('style_skill', { action: 'vibe' }, makeWorld())
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/unknown action "vibe"/i)
    })

    it('a missing action errors honestly rather than defaulting to one', async () => {
      const res = await handle('style_skill', {}, makeWorld())
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/unknown action/i)
    })
  })
})

// ── T5 (PR2): the whole-style escape hatch ────────────────────────────────────
describe("style_skill action:'apply' (T5 — whole-style escape hatch)", () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'db-apply-style-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    reindexSkills()
  })

  afterEach(() => {
    __setEnrichTransportForTesting(null)
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    reindexSkills()
  })

  /** Distil a rich project → a saved style; return its skill id. */
  async function seedSavedStyle(): Promise<string> {
    __setEnrichTransportForTesting(async () => null) // deterministic stub
    const world = makeWorld({
      scenes: [
        makeScene({ id: 'a', sceneType: 'react', bgColor: '#0b1d2a', cameraMotion: [{ type: 'dollyIn' } as never] }),
        makeScene({ id: 'b', sceneType: 'react', bgColor: '#0b1d2a' }),
      ],
      globalStyle: {
        presetId: null,
        paletteOverride: ['#0b1d2a', '#f5f0e6', '#d4763a', '#3a7ca5'],
        bgColorOverride: '#0b1d2a',
        fontOverride: 'Söhne',
        bodyFontOverride: 'Inter',
        strokeColorOverride: null,
        motionPersonality: 'premium',
      } as unknown as GlobalStyle,
    })
    const res = await handle('style_skill', { action: 'distill', name: 'Deep Ocean' }, world)
    return (res.data as { skillId: string }).skillId
  }

  it('applies a SAVED style WHOLESALE: writes its visual/motion values into GlobalStyle', async () => {
    const id = await seedSavedStyle()
    // Apply onto a fresh, empty project style.
    const world = makeWorld({
      globalStyle: {
        presetId: null,
        paletteOverride: null,
        bgColorOverride: null,
        fontOverride: null,
        bodyFontOverride: null,
        strokeColorOverride: null,
      } as unknown as GlobalStyle,
    })
    const res = await handle('style_skill', { action: 'apply', skillId: id }, world)
    expect(res.success).toBe(true)
    expect(world.globalStyle.paletteOverride).toEqual(['#0b1d2a', '#f5f0e6', '#d4763a', '#3a7ca5'])
    expect(world.globalStyle.fontOverride).toBe('Söhne')
    expect(world.globalStyle.bodyFontOverride).toBe('Inter')
    expect(world.globalStyle.bgColorOverride).toBe('#0b1d2a')
    expect(world.globalStyle.motionPersonality).toBe('premium')
  })

  it('applies a PRESET wholesale: pins presetId and clears per-project overrides', async () => {
    const world = makeWorld({
      globalStyle: {
        presetId: null,
        paletteOverride: ['#111', '#222', '#333', '#444'],
        bgColorOverride: '#000',
        fontOverride: 'Old Font',
        bodyFontOverride: null,
        strokeColorOverride: null,
      } as unknown as GlobalStyle,
    })
    const res = await handle('style_skill', { action: 'apply', presetId: 'kraft' }, world)
    expect(res.success).toBe(true)
    expect(world.globalStyle.presetId).toBe('kraft')
    // stale overrides cleared so the preset's exact look applies
    expect(world.globalStyle.paletteOverride).toBeNull()
    expect(world.globalStyle.bgColorOverride).toBeNull()
    expect(world.globalStyle.fontOverride).toBeNull()
  })

  it('honest error on an unknown saved-style id', async () => {
    const res = await handle('style_skill', { action: 'apply', skillId: 'no-such-style-xyz' }, makeWorld())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('honest error on an unknown preset id', async () => {
    const res = await handle('style_skill', { action: 'apply', presetId: 'not-a-real-preset' }, makeWorld())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/does not exist/i)
  })

  it('honest error when neither skillId nor presetId is given', async () => {
    const res = await handle('style_skill', { action: 'apply' }, makeWorld())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/either skillId.*or presetId/i)
  })

  it('refuses to apply a non-style skill via skillId', async () => {
    const res = await handle('style_skill', { action: 'apply', skillId: 'threejs-3d-scene' }, makeWorld())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not a saved style/i)
  })

  it('after a wholesale apply, an EXPLICIT per-turn user signal still overrides the applied facet', async () => {
    const id = await seedSavedStyle()
    const world = makeWorld({
      globalStyle: {
        presetId: null,
        paletteOverride: null,
        bgColorOverride: null,
        fontOverride: null,
        bodyFontOverride: null,
        strokeColorOverride: null,
      } as unknown as GlobalStyle,
    })
    await handle('style_skill', { action: 'apply', skillId: id }, world)
    // Now the user explicitly asks for a teal palette THIS turn — the composer must
    // still flag the explicit signal as winning the palette facet over the applied
    // override (whole-style apply is the default, the user's turn signal wins).
    const spec = composeFacetedStyleSpec({
      globalStyle: world.globalStyle,
      latestUserMessage: 'use a teal palette',
    })!
    expect(spec).toMatch(/\*\*Palette\*\*.*your request this turn/)
    expect(spec).toMatch(/honor it over the inherited palette/)
  })

  /** Seed a saved style whose ONLY facets are non-mappable (renderer / camera /
   *  roughness) so facetsToGlobalStylePatch yields an EMPTY patch. */
  async function seedNonMappableStyle(): Promise<string> {
    const obs: StyleObservation = {
      projectId: 'proj-nonmappable',
      palette: [], // < 4 colors → not mapped
      background: null,
      fonts: [], // none → not mapped
      sceneTypeHistogram: { three: 2 },
      dominantSceneType: 'three', // renderer → hasAnyFacet true, but NOT a GlobalStyle field
      cameraMoves: ['dollyIn', 'pan'], // camera → per-scene, NOT GlobalStyle
      motionPersonality: null, // none → no motion field
      presetId: null, // none → no preset
      roughness: 1, // roughness → not a GlobalStyle field
      sceneCount: 2,
      designBriefExcerpt: null,
    }
    const prose = stubProse(obs, 'Bare Renderer')
    const { id, markdown } = renderStyleSkill(obs, prose)
    await writeStyleSkill(id, markdown)
    return id
  }

  it('FIX 1: honest error when a saved style has ONLY non-mappable facets (empty patch is NOT reported as applied)', async () => {
    const id = await seedNonMappableStyle()
    const world = makeWorld({
      globalStyle: {
        presetId: null,
        paletteOverride: null,
        bgColorOverride: null,
        fontOverride: null,
        bodyFontOverride: null,
        strokeColorOverride: null,
      } as unknown as GlobalStyle,
    })
    const res = await handle('style_skill', { action: 'apply', skillId: id }, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no globally-applicable facets/i)
    // and it did NOT silently mutate GlobalStyle
    expect(world.globalStyle.paletteOverride).toBeNull()
    expect(world.globalStyle.presetId).toBeNull()
  })

  it('FIX 3: a successful saved-style apply carries the existing-scene-HTML caveat', async () => {
    const id = await seedSavedStyle()
    const res = await handle('style_skill', { action: 'apply', skillId: id }, makeWorld())
    expect(res.success).toBe(true)
    expect(res.changes?.[0]?.description).toMatch(/existing scene HTML is unchanged until regenerated/i)
  })

  it('FIX 3: a successful preset apply carries the existing-scene-HTML caveat', async () => {
    const res = await handle('style_skill', { action: 'apply', presetId: 'kraft' }, makeWorld())
    expect(res.success).toBe(true)
    expect(res.changes?.[0]?.description).toMatch(/existing scene HTML is unchanged until regenerated/i)
  })
})
