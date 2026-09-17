// @vitest-environment node
//
// Unit tests for video→style-skill distillation (E2 / PR-E):
//  T2  observeStyle (each axis, incl. zero-brief) + renderStyleSkill (body/frontmatter, id-stable)
//  T3  writeStyleSkill (indexed; traversal; upsert; cap/evict)
//  T4  enrichStyle (mocked llm → enrichment:'llm'; failure → stub, enrichment:'stub')
//  T8  producer-output drift — every written skill parseFrontmatter-parses + has body + loadSkill≠null
//
// All $0: the enrichment model is MOCKED via __setEnrichTransportForTesting.
// $HOME is overridden to a tmp dir so writes never touch the real ~/.dreambyte.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parse as parseYaml } from 'yaml'
import type { Scene } from '../types'
import type { GlobalStyle } from '../types/project'
import {
  observeStyle,
  observationHasSignal,
  renderStyleSkill,
  styleSkillId,
  slug,
  sanitizeTags,
  enrichStyle,
  stubProse,
  writeStyleSkill,
  deleteStyleSkill,
  distillStyle,
  selectProjectStyle,
  selectProjectStyleFacets,
  observationToFacets,
  facetsFromSkillGuide,
  hasAnyFacet,
  __setEnrichTransportForTesting,
  MAX_DISTILLED_STYLES,
} from './distill'
import { getUserStylesDir, loadSkill, searchSkills, getAllSkillIds, reindexSkills } from './registry'

/** Parse a rendered skill's frontmatter the same way the registry loader does. */
function parseFrontmatterMd(markdown: string): Record<string, unknown> | null {
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return null
  try {
    const parsed = parseYaml(m[1])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeScene(over: Partial<Scene> = {}): Scene {
  return {
    id: over.id ?? 'sc1',
    name: over.name ?? 'Scene',
    bgColor: over.bgColor ?? '#0b0b0b',
    sceneType: (over.sceneType as Scene['sceneType']) ?? 'react',
    cameraMotion: over.cameraMotion ?? null,
    duration: 5,
    // The rest are not read by observeStyle; cast keeps the fixture terse.
  } as unknown as Scene
}

function makeGlobalStyle(over: Partial<GlobalStyle> = {}): GlobalStyle {
  return {
    presetId: null,
    paletteOverride: null,
    bgColorOverride: null,
    fontOverride: null,
    bodyFontOverride: null,
    strokeColorOverride: null,
    ...over,
  } as GlobalStyle
}

function richProject() {
  return {
    id: 'proj-rich',
    scenes: [
      makeScene({ id: 'a', sceneType: 'react', bgColor: '#101418', cameraMotion: [{ type: 'dollyIn' } as never] }),
      makeScene({ id: 'b', sceneType: 'react', bgColor: '#101418', cameraMotion: [{ type: 'pan' } as never] }),
      makeScene({ id: 'c', sceneType: 'three', bgColor: '#202020' }),
    ],
    globalStyle: makeGlobalStyle({
      paletteOverride: ['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'],
      fontOverride: 'Söhne',
      bodyFontOverride: 'Inter',
      motionPersonality: 'premium',
      presetId: 'data-story' as never,
      designBrief: 'A calm, editorial data narrative with muted tones and confident typography.',
    }),
  }
}

// ── T2: observeStyle ──────────────────────────────────────────────────────────

describe('observeStyle (T2 — pure, $0)', () => {
  it('gathers every axis from a rich project', () => {
    const obs = observeStyle(richProject())
    expect(obs.projectId).toBe('proj-rich')
    expect(obs.palette).toEqual(['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'])
    expect(obs.background).toBe('#101418') // most common scene bg
    expect(obs.fonts).toEqual(['Söhne', 'Inter'])
    expect(obs.sceneTypeHistogram).toEqual({ react: 2, three: 1 })
    expect(obs.dominantSceneType).toBe('react')
    expect(obs.cameraMoves).toEqual(['dollyIn', 'pan'])
    expect(obs.motionPersonality).toBe('premium')
    expect(obs.presetId).toBe('data-story')
    expect(obs.sceneCount).toBe(3)
    expect(obs.designBriefExcerpt).toMatch(/editorial data narrative/)
  })

  it('works with ZERO designBrief and a sparse project (#2)', () => {
    const obs = observeStyle({
      id: 'proj-sparse',
      scenes: [makeScene({ id: 'only', sceneType: 'react', bgColor: '#fff' })],
      globalStyle: makeGlobalStyle(), // no preset, no brief, no overrides
    })
    expect(obs.designBriefExcerpt).toBeNull()
    expect(obs.palette).toEqual([])
    expect(obs.fonts).toEqual([])
    expect(obs.background).toBe('#fff')
    expect(obs.dominantSceneType).toBe('react')
    expect(obs.sceneCount).toBe(1)
    // sparse-but-present scene → still has signal (has a bg + renderer)
    expect(observationHasSignal(obs)).toBe(true)
  })

  it('an empty project has no signal (honest-empty floor for the handler)', () => {
    const obs = observeStyle({ id: 'p', scenes: [], globalStyle: makeGlobalStyle() })
    expect(obs.sceneCount).toBe(0)
    expect(observationHasSignal(obs)).toBe(false)
  })

  it('never throws on a missing globalStyle', () => {
    expect(() => observeStyle({ id: 'p', scenes: [makeScene()] })).not.toThrow()
  })
})

// ── T4 (PR2): saved-style → composer facet sources ────────────────────────────

describe('observationToFacets (T4 — flat fact-bag → facet taxonomy)', () => {
  it('maps each VISUAL/MOTION fact onto the composer facet taxonomy', () => {
    const facets = observationToFacets(observeStyle(richProject()))
    // palette → palette facet
    expect(facets.palette).toEqual(['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'])
    // background → background facet
    expect(facets.background).toBe('#101418')
    // fonts → typography facet
    expect(facets.fonts).toEqual(['Söhne', 'Inter'])
    // presetId (+ roughness) → visual character facet
    expect(facets.visualCharacter?.presetId).toBe('data-story')
    // cameraMoves + motionPersonality → motion facet
    expect(facets.motion?.motionPersonality).toBe('premium')
    expect(facets.motion?.cameraMoves).toEqual(['dollyIn', 'pan'])
    // dominantSceneType → renderer hint
    expect(facets.renderer).toBe('react')
  })

  it('audio / avatar / data-viz facets are ABSENT (documented-empty, not fabricated)', () => {
    const facets = observationToFacets(observeStyle(richProject())) as Record<string, unknown>
    // The taxonomy has no audio/avatar/dataViz keys — observeStyle mines none.
    expect(facets.audio).toBeUndefined()
    expect(facets.avatar).toBeUndefined()
    expect(facets.dataViz).toBeUndefined()
  })

  it('omits a facet with no underlying fact (no empty palette/font/motion)', () => {
    const sparse = observeStyle({
      id: 'sparse',
      scenes: [makeScene({ id: 's', sceneType: 'react', bgColor: '#fff' })],
      globalStyle: makeGlobalStyle(), // no palette/fonts/preset/motion
    })
    const facets = observationToFacets(sparse)
    expect(facets.palette).toBeUndefined()
    expect(facets.fonts).toBeUndefined()
    expect(facets.motion).toBeUndefined()
    expect(facets.visualCharacter).toBeUndefined()
    // background + renderer are the only facts a bare scene yields
    expect(facets.background).toBe('#fff')
    expect(facets.renderer).toBe('react')
    expect(hasAnyFacet(facets)).toBe(true)
  })
})

describe('facetsFromSkillGuide (T4 — round-trip facets from the on-disk body)', () => {
  it('recovers facets the rendered body wrote (observe → render → recover)', () => {
    const obs = observeStyle(richProject())
    const prose = stubProse(obs, 'Editorial Calm')
    const { markdown } = renderStyleSkill(obs, prose)
    // The body after the frontmatter is what loadSkill exposes as `guide`.
    const guide = markdown.split(/\n---\n/)[1] ?? markdown
    const facets = facetsFromSkillGuide(guide)
    expect(facets.palette).toEqual(['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'])
    expect(facets.background).toBe('#101418')
    expect(facets.fonts).toEqual(['Söhne', 'Inter'])
    expect(facets.renderer).toBe('react')
    expect(facets.motion?.cameraMoves).toEqual(['dollyIn', 'pan'])
    expect(facets.motion?.motionPersonality).toBe('premium')
    expect(facets.visualCharacter?.presetId).toBe('data-story')
  })

  it('returns {} on a sparse body with no fact list', () => {
    expect(hasAnyFacet(facetsFromSkillGuide('# Style\n\nno facts here'))).toBe(false)
  })
})

describe('selectProjectStyleFacets (T4 — top-1 select → per-facet source)', () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(async () => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dreambyte-facets-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    reindexSkills()
    const obs = observeStyle(richProject())
    const prose = stubProse(obs, 'Editorial Calm')
    prose.tags = ['editorial', 'calm', 'data-story']
    const { id, markdown } = renderStyleSkill(obs, prose)
    await writeStyleSkill(id, markdown)
  })

  afterEach(() => {
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

  it('a matching intent returns the saved style decomposed into per-facet sources', () => {
    const src = selectProjectStyleFacets('an editorial calm explainer')
    expect(src).not.toBeNull()
    expect(src!.name).toBe('Editorial Calm')
    // It is PER-FACET, not a wholesale prose guide
    expect(src!.facets.palette).toEqual(['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'])
    expect(src!.facets.fonts).toEqual(['Söhne', 'Inter'])
    expect(src!.facets.motion?.motionPersonality).toBe('premium')
  })

  it('an unrelated intent below the ≥2-token floor → null (no spurious source)', () => {
    expect(selectProjectStyleFacets('a heavy 3d asteroid collision sim')).toBeNull()
  })
})

// ── FIX 4 (INFO-5): facet-injecting path needs a STRICTER floor than the prose
//    guide. PR2 made a match LEAD palette/font/motion project-wide, so an
//    incidental 2-description-word overlap must NOT front-run the look: require
//    ≥1 tag/name hit OR ≥3 distinct token hits. ──────────────────────────────
describe('selectProjectStyleFacets floor (FIX 4 — tag-weighted, ≥3-token or ≥1-tag)', () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(async () => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dreambyte-facets-fix4-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    reindexSkills()
    // A saved style whose TAGS are unrelated to the intent below, but whose
    // description (= prose.evokes) shares two incidental common words ("animated
    // explainer") with that intent. Under the old ≥2 prose-guide floor this would
    // have led the look; FIX 4 must reject it (no tag hit, only 2 description hits).
    const obs = observeStyle(richProject())
    const prose = stubProse(obs, 'Neon Arcade')
    prose.tags = ['neon', 'arcade', 'retro']
    prose.evokes = 'A bold animated explainer with glowing edges.'
    const { id, markdown } = renderStyleSkill(obs, prose)
    await writeStyleSkill(id, markdown)
  })

  afterEach(() => {
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

  it('NEGATIVE: 2 incidental description words (no tag hit) does NOT lead the look', () => {
    // "animated" + "explainer" land in the description but NOT in name/tags, and
    // no other intent token hits. 2 description hits cleared the old ≥2 prose-guide
    // floor but is below the ≥3 facet floor and has zero tag hits → rejected.
    expect(selectProjectStyleFacets('this animated explainer covers product onboarding')).toBeNull()
  })

  it('POSITIVE control: a genuine tag hit still selects (≥1 tag overrides the token floor)', () => {
    // "neon" is a curated TAG → qualifies even with a single intent token.
    const src = selectProjectStyleFacets('a neon product launch')
    expect(src).not.toBeNull()
    expect(src!.name).toBe('Neon Arcade')
  })

  it('POSITIVE control: ≥3 distinct description tokens (no tag) still selects', () => {
    // "bold" + "animated" + "explainer" all land in the description → ≥3 hits.
    const src = selectProjectStyleFacets('a bold animated explainer')
    expect(src).not.toBeNull()
    expect(src!.name).toBe('Neon Arcade')
  })
})

// ── T2: renderStyleSkill + id stability ────────────────────────────────────────

describe('renderStyleSkill + styleSkillId (T2 — body-prose, id-stable)', () => {
  const obs = observeStyle(richProject())
  const prose = {
    name: 'Editorial Calm',
    evokes: 'A measured, confident editorial mood.',
    reachForWhen: 'Use it for data narratives and explainers.',
    skipRisks: 'Skipping it risks a louder, less coherent look.',
    tags: ['editorial', 'data-story', 'calm'],
    enrichment: 'llm' as const,
  }

  it('id = slug(name)+hash(projectId); stable across two observations of the same project', () => {
    const a = styleSkillId('Editorial Calm', 'proj-rich')
    const b = styleSkillId('Editorial Calm', 'proj-rich')
    expect(a).toBe(b)
    expect(a).toMatch(/^editorial-calm-[0-9a-f]{6}$/)
    // different project → different suffix (cross-project name collision disambiguation #3)
    expect(styleSkillId('Editorial Calm', 'other-proj')).not.toBe(a)
  })

  it('renders parseable frontmatter (primitives only) AND prose in the BODY (D2)', () => {
    const { id, markdown } = renderStyleSkill(obs, prose)
    expect(id).toMatch(/^editorial-calm-/)
    // frontmatter carries only primitives
    expect(markdown).toContain('category: style')
    expect(markdown).toContain('origin: distilled')
    expect(markdown).toContain('enrichment: llm')
    expect(markdown).toContain('tags: [editorial, data-story, calm]')
    // prose lives in the BODY, not the frontmatter
    const body = markdown.split('---').slice(2).join('---')
    expect(body).toContain('A measured, confident editorial mood.')
    expect(body).toContain('## Reach for it when')
    expect(body).toContain('## Observed style facts')
    expect(body).toContain('#101418') // palette fact carried into body
  })

  it('sanitizes a prose name containing frontmatter-hostile characters (D2 corruption guard)', () => {
    const hostile = { ...prose, name: 'Bold: Loud [v2]' }
    const { markdown } = renderStyleSkill(obs, hostile)
    // The name line must remain a single parseable scalar — quoted because risky.
    const fmName = markdown.split('\n').find((l) => l.startsWith('name:'))!
    expect(fmName).toContain('"Bold: Loud [v2]"')
  })

  it('FIX 1: sanitizes frontmatter-hostile TAGS so the tags array stays parseable', () => {
    const hostile = { ...prose, tags: ['a: b', 'ev]il', '#x', '', 'has,comma', 'OK-Tag'] }
    const { markdown } = renderStyleSkill(obs, hostile)
    const tagsLine = markdown.split('\n').find((l) => l.startsWith('tags:'))!
    const inner = tagsLine.replace(/^tags:\s*\[/, '').replace(/\]\s*$/, '')
    // No frontmatter-array-hostile chars survive INSIDE the bracket array.
    expect(inner).not.toMatch(/[:#[\]{}"']/)
    // The hostile chars are stripped/collapsed to bare tokens, empties dropped.
    expect(tagsLine).toContain('a-b')
    expect(tagsLine).toContain('ev-il')
    expect(tagsLine).toContain('has-comma')
    expect(tagsLine).toContain('ok-tag')
    // It re-parses through the real loader yaml (invariant guard didn't trip).
    expect(parseFrontmatterMd(markdown)).not.toBeNull()
  })
})

// ── T4: enrichStyle (mocked) + stub fallback ───────────────────────────────────

describe('enrichStyle (T4 — mocked LLM + visible stub fallback #7)', () => {
  const obs = observeStyle(richProject())

  afterEach(() => __setEnrichTransportForTesting(null))

  it('a well-formed model response → enrichment:"llm"', async () => {
    __setEnrichTransportForTesting(async () =>
      JSON.stringify({
        name: 'Quiet Data',
        evokes: 'Composed and analytical.',
        reachForWhen: 'Use it on dashboards and reports.',
        skipRisks: 'Skipping risks visual noise.',
        tags: ['data', 'minimal'],
      }),
    )
    const p = await enrichStyle(obs)
    expect(p.enrichment).toBe('llm')
    expect(p.name).toBe('Quiet Data')
    expect(p.tags).toEqual(['data', 'minimal'])
  })

  it('tolerates ```json fences and surrounding chatter', async () => {
    __setEnrichTransportForTesting(
      async () => 'Sure!\n```json\n{"name":"Fenced","evokes":"e","reachForWhen":"r","skipRisks":"s","tags":["x"]}\n```',
    )
    const p = await enrichStyle(obs)
    expect(p.enrichment).toBe('llm')
    expect(p.name).toBe('Fenced')
  })

  it('model returns null (timeout / no key) → deterministic stub, enrichment:"stub"', async () => {
    __setEnrichTransportForTesting(async () => null)
    const p = await enrichStyle(obs)
    expect(p.enrichment).toBe('stub')
    expect(p.name).toBeTruthy()
    expect(p.tags.length).toBeGreaterThan(0)
  })

  it('malformed JSON → stub fallback', async () => {
    __setEnrichTransportForTesting(async () => '{ not json at all')
    const p = await enrichStyle(obs)
    expect(p.enrichment).toBe('stub')
  })

  it('incomplete JSON (missing required field) → stub fallback', async () => {
    __setEnrichTransportForTesting(async () => JSON.stringify({ name: 'X', tags: ['a'] }))
    const p = await enrichStyle(obs)
    expect(p.enrichment).toBe('stub')
  })

  it('stubProse honours a name hint and produces valid prose from facts alone', () => {
    const p = stubProse(obs, 'My Named Style')
    expect(p.name).toBe('My Named Style')
    expect(p.enrichment).toBe('stub')
    expect(p.evokes.length).toBeGreaterThan(0)
  })
})

// ── T3 + T8: writeStyleSkill (fs-isolated) ──────────────────────────────────────

describe('writeStyleSkill + drift (T3/T8 — fs-isolated under tmp $HOME)', () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'db-distill-'))
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

  function render(name: string, projectId = 'proj-rich') {
    const obs = { ...observeStyle(richProject()), projectId }
    return renderStyleSkill(obs, stubProse(obs, name))
  }

  it('writes → indexed → loadable + searchable (category:style)', async () => {
    const { id, markdown } = render('Indexed Style')
    const res = await writeStyleSkill(id, markdown)
    expect(fs.existsSync(res.path)).toBe(true)

    const loaded = loadSkill(id)
    expect(loaded).not.toBeNull()
    expect(loaded!.metadata.origin).toBe('distilled')

    const hits = searchSkills(loaded!.metadata.tags.join(' '), { category: 'style' })
    expect(hits.some((h) => h.metadata.id === id)).toBe(true)
  })

  it('rejects a path-traversal id (../)', async () => {
    await expect(writeStyleSkill('../../etc/evil', '---\nid: x\n---\nbody')).rejects.toThrow(/outside the styles dir/)
  })

  it('UPSERT: re-distilling the same project overwrites (no duplicate file)', async () => {
    const first = render('Upsert Style')
    await writeStyleSkill(first.id, first.markdown)
    // Same name + same projectId → same id → overwrite.
    const second = render('Upsert Style')
    expect(second.id).toBe(first.id)
    const res = await writeStyleSkill(second.id, second.markdown)
    expect(res.evicted).toEqual([])
    const files = fs.readdirSync(getUserStylesDir()).filter((f) => f.endsWith('.md'))
    expect(files.length).toBe(1)
  })

  it('cap 25: the 26th distinct write evicts the OLDEST by mtime', async () => {
    const dir = getUserStylesDir()
    fs.mkdirSync(dir, { recursive: true })
    // Seed MAX distinct style files with increasing mtimes (older first).
    const seeded: string[] = []
    for (let i = 0; i < MAX_DISTILLED_STYLES; i++) {
      const { id, markdown } = render(`Seeded ${i}`, `proj-${i}`)
      const p = path.join(dir, `${id}.md`)
      fs.writeFileSync(p, markdown)
      // oldest = i 0; bump mtime forward per i so #0 is strictly the oldest
      const t = (Date.now() + i * 1000) / 1000
      fs.utimesSync(p, t, t)
      seeded.push(id)
    }
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length).toBe(MAX_DISTILLED_STYLES)

    // The 26th write must evict exactly one (the oldest seeded, #0).
    const { id, markdown } = render('The Overflow One', 'proj-overflow')
    const res = await writeStyleSkill(id, markdown)
    expect(res.evicted).toEqual([seeded[0]])
    const after = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    expect(after.length).toBe(MAX_DISTILLED_STYLES)
    expect(after).toContain(`${id}.md`)
    expect(after).not.toContain(`${seeded[0]}.md`)
  })

  it('deleteStyleSkill removes the file + de-indexes; absent id → false', async () => {
    const { id, markdown } = render('Deletable')
    await writeStyleSkill(id, markdown)
    expect(getAllSkillIds()).toContain(id)
    expect(await deleteStyleSkill(id)).toBe(true)
    expect(getAllSkillIds()).not.toContain(id)
    expect(await deleteStyleSkill('never-existed')).toBe(false)
  })

  // A3 — symlink-realpath parity: when the styles dir is itself a SYMLINK to a
  // real directory, the realpath-based guard must collapse it and still write the
  // file (the dirname check compares against the REAL dir, not the symlink path).
  // The lexical resolve+isWithin this replaced compared the symlink path's own
  // dirname and could mis-handle a symlinked dir.
  it('A3: writes through a SYMLINKED styles dir (realpath-collapsed, contained)', async () => {
    const stylesDir = getUserStylesDir() // ~/.dreambyte/skills/styles (under tmp HOME)
    // Make the styles dir a symlink to a real sibling target.
    fs.mkdirSync(path.dirname(stylesDir), { recursive: true })
    const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'db-styles-real-'))
    try {
      // Ensure no real dir is occupying the path, then symlink it.
      if (fs.existsSync(stylesDir)) fs.rmSync(stylesDir, { recursive: true, force: true })
      fs.symlinkSync(realTarget, stylesDir, 'dir')
      reindexSkills()

      const { id, markdown } = render('Symlinked Dir Style', 'proj-symlink')
      const res = await writeStyleSkill(id, markdown)
      expect(res.path.startsWith(fs.realpathSync(realTarget))).toBe(true)
      // File physically lands inside the symlink target.
      expect(fs.existsSync(path.join(realTarget, `${id}.md`))).toBe(true)
      // ...and deleteStyleSkill routes through the same guard.
      expect(await deleteStyleSkill(id)).toBe(true)
      expect(fs.existsSync(path.join(realTarget, `${id}.md`))).toBe(false)
    } finally {
      try {
        fs.unlinkSync(stylesDir)
      } catch {
        /* ignore */
      }
      fs.rmSync(realTarget, { recursive: true, force: true })
    }
  })

  it('A3: rejects a path-traversal id on DELETE too (../)', async () => {
    // The styles dir must exist for delete to reach the guard.
    fs.mkdirSync(getUserStylesDir(), { recursive: true })
    await expect(deleteStyleSkill('../../etc/evil')).rejects.toThrow(/outside the styles dir/)
  })

  // T8 — producer-output drift invariant: anything distillStyle WRITES must
  // parse, have body prose, and round-trip through loadSkill with content fidelity.
  it('T8 drift: distillStyle output parses, has body prose, and loadSkill≠null', async () => {
    __setEnrichTransportForTesting(async () =>
      JSON.stringify({
        name: 'Drift Check',
        evokes: 'A distinct evocative line.',
        reachForWhen: 'A distinct reach-for line.',
        skipRisks: 'A distinct skip-risk line.',
        tags: ['drift'],
      }),
    )
    const out = await distillStyle(richProject())
    expect(out).not.toBeNull()
    const loaded = loadSkill(out!.id)
    expect(loaded).not.toBeNull()
    // frontmatter parsed into valid primitive metadata
    expect(loaded!.metadata.category).toBe('style')
    expect(loaded!.metadata.tier).toBe('on-demand')
    expect(loaded!.metadata.origin).toBe('distilled')
    expect(loaded!.metadata.enrichment).toBe('llm')
    expect(Array.isArray(loaded!.metadata.tags)).toBe(true)
    // body carries the actual prose (content fidelity, not just non-null)
    expect(loaded!.guide).toContain('A distinct evocative line.')
    expect(loaded!.guide).toContain('A distinct reach-for line.')
  })

  it('T8 drift + FIX 1: ADVERSARIAL tags still produce a loadable, parseable skill', async () => {
    __setEnrichTransportForTesting(async () =>
      JSON.stringify({
        name: 'Hostile Tags',
        evokes: 'A distinct evocative line.',
        reachForWhen: 'A distinct reach-for line.',
        skipRisks: 'A distinct skip-risk line.',
        // Every adversarial char the corruption note calls out.
        tags: ['a: b', 'ev]il', '#x', '{nested}', 'with,comma', '"quoted"'],
      }),
    )
    const out = await distillStyle(richProject())
    expect(out).not.toBeNull()
    // The on-disk file's frontmatter re-parses through the loader yaml.
    const onDisk = fs.readFileSync(out!.path, 'utf-8')
    expect(parseFrontmatterMd(onDisk)).not.toBeNull()
    // And the loader actually resolves it — SUCCESS ⇒ loadable.
    const loaded = loadSkill(out!.id)
    expect(loaded).not.toBeNull()
    expect(loaded!.metadata.id).toBe(out!.id)
    expect(loaded!.metadata.category).toBe('style')
    // Tags survived as bare tokens (array shape intact).
    expect(Array.isArray(loaded!.metadata.tags)).toBe(true)
    expect(loaded!.metadata.tags.length).toBeGreaterThan(0)
  })

  it('FIX 1: invariant guard — a hostile prose NAME never yields an unloadable skill', async () => {
    __setEnrichTransportForTesting(async () =>
      JSON.stringify({
        // A name engineered to be a YAML hazard even after scalar quoting attempts.
        name: 'X\n---\ninjected: true',
        evokes: 'e1.',
        reachForWhen: 'r1.',
        skipRisks: 's1.',
        tags: ['x'],
      }),
    )
    const out = await distillStyle(richProject())
    expect(out).not.toBeNull()
    expect(parseFrontmatterMd(fs.readFileSync(out!.path, 'utf-8'))).not.toBeNull()
    expect(loadSkill(out!.id)).not.toBeNull()
  })

  it('T8 drift: a STUB-enriched skill is equally well-formed and loadable', async () => {
    __setEnrichTransportForTesting(async () => null) // force stub
    const out = await distillStyle(richProject())
    expect(out!.enrichment).toBe('stub')
    const loaded = loadSkill(out!.id)
    expect(loaded).not.toBeNull()
    expect(loaded!.metadata.enrichment).toBe('stub')
    expect(loaded!.guide.length).toBeGreaterThan(50)
  })

  it('distillStyle returns null for an empty project (honest-empty)', async () => {
    const out = await distillStyle({ id: 'empty', scenes: [], globalStyle: makeGlobalStyle() })
    expect(out).toBeNull()
  })
})

describe('slug', () => {
  it('lowercases, hyphenates, trims, and floors to a default', () => {
    expect(slug('Editorial Calm!')).toBe('editorial-calm')
    expect(slug('   ')).toBe('style')
    expect(slug('A'.repeat(80)).length).toBeLessThanOrEqual(48)
  })
})

describe('sanitizeTags (FIX 1 — frontmatter-array safety)', () => {
  it('strips every array-hostile char to bare tokens, dedupes, drops empties', () => {
    const out = sanitizeTags(['a: b', 'ev]il', '#x', '', 'A B', 'a-b', '  '])
    // a: b → a-b ; A B → a-b (dup of first) → deduped ; ev]il → ev-il
    expect(out).toContain('a-b')
    expect(out).toContain('ev-il')
    expect(out).toContain('x')
    // no hostile chars survive
    for (const t of out) expect(t).toMatch(/^[a-z0-9-]+$/)
  })
  it('caps count and length, falls back to ["distilled"] when all empty', () => {
    expect(sanitizeTags([':', '#', '[]', '{}'])).toEqual(['distilled'])
    expect(sanitizeTags([])).toEqual(['distilled'])
    expect(sanitizeTags(Array.from({ length: 20 }, (_, i) => `tag${i}`)).length).toBeLessThanOrEqual(8)
    expect(sanitizeTags(['x'.repeat(100)])[0].length).toBeLessThanOrEqual(32)
  })
})

// ── FIX 3: selectProjectStyle spurious-injection floor (fs-isolated) ───────────
describe('selectProjectStyle floor (FIX 3 — no spurious style injection)', () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined
  let styleId: string

  beforeEach(async () => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'db-style-select-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    reindexSkills()
    const obs = { ...observeStyle(richProject()), projectId: 'sel-proj' }
    const prose = stubProse(obs, 'Editorial Calm')
    prose.tags = ['editorial', 'calm', 'data-story']
    const { id, markdown } = renderStyleSkill(obs, prose)
    styleId = id
    await writeStyleSkill(id, markdown)
  })

  afterEach(() => {
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

  it('intent that merely contains "style" / "any" does NOT inject a saved style', () => {
    // 'style' and 'any' are category/sceneType words common in styleNotes — must not match.
    expect(selectProjectStyle('Build any video in a clean style with bold motion')).toBeNull()
  })

  it('one incidental shared common word is below the floor → no injection', () => {
    // 'data' is in the style's tag 'data-story' — a single hit must not be enough.
    expect(selectProjectStyle('a video about data')).toBeNull()
  })

  it('a genuinely matching intent (≥2 distinct tokens) still injects the style', () => {
    const s = selectProjectStyle('an editorial calm explainer')
    expect(s).not.toBeNull()
    expect(s!.metadata.id).toBe(styleId)
  })

  it('unrelated build → null even though the style is the only one on disk', () => {
    expect(selectProjectStyle('a heavy 3d simulation of colliding asteroids')).toBeNull()
  })
})
