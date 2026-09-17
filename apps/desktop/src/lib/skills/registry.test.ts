// @vitest-environment node
//
// Unit tests for the skill registry.
//
// Two suites, unioned across PR1 (deterministic renderer→skill map) and the
// OKF-substrate parser work (T4):
//  - loadSkillForSceneType (PR1): renderer sceneType → its single library skill
//  - OKF frontmatter parsing: every OKF field (type/title/description/timestamp/
//    tier), tier normalisation, pre-OKF fallback, nested-parameters regression,
//    and the public-API behaviour-neutral invariants.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  __parseFrontmatterForTesting as parseFM,
  loadSkillForSceneType,
  getAllSkillIds,
  getSkillMetadata,
  loadSkill,
  searchSkills,
  getSkillCount,
  reindexSkills,
  getUserStylesDir,
} from './registry'

describe('loadSkillForSceneType (PR1 deterministic renderer→skill map)', () => {
  it('maps a dedicated renderer sceneType to its skill guide', () => {
    const three = loadSkillForSceneType('three')
    expect(three).not.toBeNull()
    expect(three!.metadata.sceneType).toBe('three')
    expect(three!.guide.length).toBeGreaterThan(100)

    const d3 = loadSkillForSceneType('d3')
    expect(d3?.metadata.id).toBe('d3-data-visualization')
  })

  it("returns null for 'react' (composed default carries its own guidance)", () => {
    expect(loadSkillForSceneType('react')).toBeNull()
  })

  it('the three skill guide pins the scene contract (raw script, frame clock)', () => {
    const g = loadSkillForSceneType('three')!.guide
    expect(g).toMatch(/NOT a React component|raw vanilla-JS/i)
    expect(g).toMatch(/__updateScene|window\.__tl/)
    expect(g).toMatch(/requestAnimationFrame|performance\.now/) // names them as banned
  })

  it('returns null for empty/unknown sceneType', () => {
    expect(loadSkillForSceneType('')).toBeNull()
    expect(loadSkillForSceneType('not-a-real-renderer')).toBeNull()
  })

  it('every library skill is reachable by its sceneType', () => {
    // for each registered skill, its sceneType resolves back to a loadable guide
    const ids = getAllSkillIds()
    expect(ids.length).toBeGreaterThanOrEqual(6)
  })
})

describe('parseFrontmatter — OKF fields', () => {
  it('parses every OKF field alongside registry-native fields', () => {
    const fm = [
      'id: demo-skill',
      'type: skill',
      'title: Demo Title',
      'timestamp: 2026-06-17',
      'tier: always',
      'name: Demo Skill',
      'category: renderer',
      'tags: [a, b, c]',
      'sceneType: react',
      'complexity: complex',
      'requires: []',
      'description: A demo description.',
    ].join('\n')

    const md = parseFM(fm, 'fallback')
    expect(md).not.toBeNull()
    // OKF surface
    expect(md!.type).toBe('skill')
    expect(md!.title).toBe('Demo Title')
    expect(md!.timestamp).toBe('2026-06-17')
    expect(md!.tier).toBe('always')
    // registry-native still intact
    expect(md!.id).toBe('demo-skill')
    expect(md!.name).toBe('Demo Skill')
    expect(md!.category).toBe('renderer')
    expect(md!.tags).toEqual(['a', 'b', 'c'])
    expect(md!.sceneType).toBe('react')
    expect(md!.complexity).toBe('complex')
    expect(md!.requires).toEqual([])
    expect(md!.description).toBe('A demo description.')
  })

  it('defaults type→skill, title→name, timestamp→"", tier→on-demand when OKF fields absent (pre-OKF compat)', () => {
    const fm = [
      'id: legacy',
      'name: Legacy Skill',
      'category: effect',
      'tags: [x]',
      'sceneType: any',
      'complexity: simple',
      'description: legacy file with no OKF surface',
    ].join('\n')

    const md = parseFM(fm, 'fallback')!
    expect(md.type).toBe('skill')
    expect(md.title).toBe('Legacy Skill') // falls back to name
    expect(md.timestamp).toBe('')
    expect(md.tier).toBe('on-demand')
  })

  it('normalises tier: unknown/garbage → on-demand, exact "always" → always', () => {
    expect(parseFM('id: a\nname: A\ntier: always', 'a')!.tier).toBe('always')
    expect(parseFM('id: a\nname: A\ntier:  always  ', 'a')!.tier).toBe('always')
    expect(parseFM('id: a\nname: A\ntier: ON-DEMAND', 'a')!.tier).toBe('on-demand')
    expect(parseFM('id: a\nname: A\ntier: bogus', 'a')!.tier).toBe('on-demand')
    expect(parseFM('id: a\nname: A', 'a')!.tier).toBe('on-demand')
  })

  it('still parses nested parameters arrays (no OKF regression)', () => {
    const fm = [
      'id: p',
      'name: P',
      'parameters:',
      '  - name: tool',
      '    type: string',
      '    default: pen',
      '    description: Drawing tool',
      '    enum: [pen, marker]',
    ].join('\n')
    const md = parseFM(fm, 'p')!
    expect(md.parameters).toHaveLength(1)
    expect(md.parameters[0]).toMatchObject({
      name: 'tool',
      type: 'string',
      default: 'pen',
      description: 'Drawing tool',
      enum: ['pen', 'marker'],
    })
  })

  it('falls back id to the filename when frontmatter omits id', () => {
    const md = parseFM('name: No Id\ncategory: technique', 'from-filename')!
    expect(md.id).toBe('from-filename')
  })
})

describe('registry public API over the real library (behaviour-neutral)', () => {
  it('indexes every library skill and gives each an OKF surface', () => {
    const ids = getAllSkillIds()
    expect(ids.length).toBeGreaterThanOrEqual(6)
    const metas = getSkillMetadata(ids)
    for (const m of metas) {
      expect(m.type).toBeTruthy()
      expect(m.title).toBeTruthy() // title aliases name, never empty
      expect(['always', 'on-demand']).toContain(m.tier)
    }
  })

  it('loads a real skill with both schemas populated', () => {
    const c = loadSkill('threejs-3d-scene')
    expect(c).not.toBeNull()
    expect(c!.metadata.id).toBe('threejs-3d-scene')
    expect(c!.metadata.title).toBe('Three.js 3D Scene')
    expect(c!.metadata.type).toBe('skill')
    expect(c!.metadata.timestamp).toBe('2026-06-17')
    expect(c!.guide.length).toBeGreaterThan(0)
  })

  // REGRESSION (mandatory per plan): missing-id must degrade gracefully.
  it('loadSkill(missing) → null without throwing', () => {
    expect(loadSkill('does-not-exist-xyz')).toBeNull()
  })

  it('searchSkills still scores against tokens', () => {
    const r = searchSkills('three.js webgl 3d scene')
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].metadata.id).toBe('threejs-3d-scene')
  })

  it('getSkillCount matches getAllSkillIds length', () => {
    expect(getSkillCount()).toBe(getAllSkillIds().length)
  })
})

// ── T1: dual-scan + writable user dir + mtime cache coherence ────────────────
describe('registry dual-scan (E2 — writable distilled style dir)', () => {
  // Isolate the filesystem: point $HOME at a fresh tmp dir per test so the
  // user styles dir resolves there and never touches the real ~/.dreambyte.
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  /** Write a distilled-style fixture into the (HOME-overridden) user dir. */
  function writeStyleFixture(
    id: string,
    opts: { name?: string; tags?: string[]; body?: string; mtimeMs?: number } = {},
  ) {
    const dir = getUserStylesDir()
    fs.mkdirSync(dir, { recursive: true })
    const fm = [
      '---',
      `id: ${id}`,
      `name: ${opts.name ?? id}`,
      'category: style',
      'tier: on-demand',
      'origin: distilled',
      'enrichment: llm',
      'sceneType: any',
      `tags: [${(opts.tags ?? ['fixture']).join(', ')}]`,
      'description: A distilled style fixture.',
      '---',
      opts.body ?? 'Evokes a calm, editorial feel. Reach for it on data-driven explainers.',
    ].join('\n')
    const file = path.join(dir, `${id}.md`)
    fs.writeFileSync(file, fm)
    if (opts.mtimeMs != null) fs.utimesSync(file, opts.mtimeMs / 1000, opts.mtimeMs / 1000)
    return file
  }

  beforeEach(() => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'db-styles-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    reindexSkills() // rebuild against the empty user dir
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
    reindexSkills() // restore the real-library-only index for other suites
  })

  it('resolves the user styles dir under $HOME/.dreambyte/skills/styles', () => {
    expect(getUserStylesDir()).toBe(path.join(tmpHome, '.dreambyte', 'skills', 'styles'))
  })

  it('indexes a fixture style skill from the user dir (searchable + loadable)', () => {
    writeStyleFixture('editorial-calm-ab12', { tags: ['editorial', 'calm'] })
    reindexSkills()

    // loadable by id, marked distilled
    const c = loadSkill('editorial-calm-ab12')
    expect(c).not.toBeNull()
    expect(c!.metadata.origin).toBe('distilled')
    expect(c!.metadata.enrichment).toBe('llm')
    expect(c!.metadata.category).toBe('style')
    expect(c!.guide).toMatch(/Evokes/)

    // searchable ONLY via category:'style' (growth governance #4)
    const styleHits = searchSkills('editorial calm', { category: 'style' })
    expect(styleHits.some((r) => r.metadata.id === 'editorial-calm-ab12')).toBe(true)
  })

  it('EXCLUDES distilled styles from default (non-style) searches (#4 governance)', () => {
    writeStyleFixture('noise-style-xx99', { tags: ['three', 'webgl', '3d'] })
    reindexSkills()
    // A search that would match the fixture's tags must NOT surface it without category:'style'.
    const r = searchSkills('three webgl 3d')
    expect(r.some((x) => x.metadata.id === 'noise-style-xx99')).toBe(false)
    // The curated renderer skill still wins.
    expect(r[0].metadata.id).toBe('threejs-3d-scene')
  })

  it('leaves the curated library UNCHANGED (regression): all remaining ids, no distilled origin', () => {
    writeStyleFixture('extra-style-zz00')
    reindexSkills()
    const curated = getSkillMetadata(getAllSkillIds()).filter((m) => m.origin === 'curated')
    expect(curated.length).toBeGreaterThanOrEqual(6)
    // every library skill keeps origin curated; threejs-3d-scene still loads identically
    const three = loadSkill('threejs-3d-scene')!
    expect(three.metadata.origin).toBe('curated')
    expect(three.metadata.enrichment).toBe('')
  })

  it('mtime coherence (#1): a SECOND searchSkills sees a file written WITHOUT an explicit reindex', () => {
    // First read builds the index against the empty user dir.
    expect(searchSkills('crossproc', { category: 'style' }).length).toBe(0)
    // Simulate another process (the MCP daemon) writing a distilled skill —
    // future-date its mtime so the dir signature is guaranteed to differ.
    writeStyleFixture('crossproc-style-7777', {
      tags: ['crossproc'],
      mtimeMs: Date.now() + 60_000,
    })
    // NO reindexSkills() here — the lazy mtime check must pick it up.
    const hits = searchSkills('crossproc', { category: 'style' })
    expect(hits.some((r) => r.metadata.id === 'crossproc-style-7777')).toBe(true)
  })

  it('graceful when the user dir is absent (never throws, never auto-creates on read)', () => {
    // Fresh tmp HOME with no styles dir written.
    expect(fs.existsSync(getUserStylesDir())).toBe(false)
    expect(() => searchSkills('anything')).not.toThrow()
    expect(() => loadSkill('nope')).not.toThrow()
    // A read must NOT create the dir (only writeStyleSkill does).
    expect(fs.existsSync(getUserStylesDir())).toBe(false)
  })

  it('curated id is authoritative — a distilled file cannot shadow a library skill', () => {
    // Write a distilled file masquerading as the curated threejs id.
    writeStyleFixture('threejs-3d-scene', { name: 'IMPOSTER', body: 'malicious shadow' })
    reindexSkills()
    const three = loadSkill('threejs-3d-scene')!
    expect(three.metadata.origin).toBe('curated') // library wins
    expect(three.metadata.name).not.toBe('IMPOSTER')
  })
})
