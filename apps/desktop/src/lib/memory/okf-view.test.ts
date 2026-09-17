// @vitest-environment node
//
// D3 — memory/ OKF export view (T10). Proves the bundle is a valid, READ-ONLY
// OKF view of user_memory:
//  - a memory row → a concept file whose frontmatter parses via the SAME parser
//    the skill registry uses (__parseFrontmatterForTesting), with type:preference
//  - the body carries value + confidence + scope
//  - empty memory → a valid empty bundle (index.md, no concept files), no throw
//  - project-scoped vs user-global scopes are both represented
//  - regenerate overwrites (no duplicate; a removed key leaves no stale file)
//  - path traversal in a crafted category/key can't escape the bundle dir
//
// $HOME is overridden to a tmp dir so writes never touch the real ~/.dreambyte.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderMemoryConcept,
  buildMemoryIndex,
  writeMemoryBundle,
  getMemoryBundleDir,
  memoryConceptId,
  type MemoryConcept,
} from './okf-view'
import { __parseFrontmatterForTesting } from '../skills/registry'

const FM_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

/** Split a rendered concept into { frontmatterSrc, body }. */
function splitMd(markdown: string): { fm: string; body: string } | null {
  const m = markdown.match(FM_RE)
  if (!m) return null
  return { fm: m[1], body: m[2] }
}

// ── $HOME isolation ────────────────────────────────────────────────────────

let tmpHome = ''
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dreambyte-memory-okf-test-'))
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome // Windows parity
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true })
})

// ── Pure render ──────────────────────────────────────────────────────────────

describe('renderMemoryConcept (pure)', () => {
  it('produces frontmatter that parses via the registry parser, with type:preference', () => {
    const c: MemoryConcept = {
      category: 'style',
      key: 'bg',
      value: 'dark backgrounds',
      confidence: 0.82,
      scope: 'user',
    }
    const { id, markdown } = renderMemoryConcept(c)
    const split = splitMd(markdown)
    expect(split).not.toBeNull()

    // Parse with the SAME parser the skill registry uses.
    const meta = __parseFrontmatterForTesting(split!.fm, id)
    expect(meta).not.toBeNull()
    expect(meta!.type).toBe('preference')
    expect(meta!.id).toBe(id)
    expect(meta!.title).toBe('style / bg')
    expect(meta!.tags).toContain('memory')
    expect(meta!.tags).toContain('preference')
    expect(meta!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('body carries value, confidence, and scope', () => {
    const c: MemoryConcept = {
      category: 'workflow',
      key: 'tempo',
      value: 'fast cuts',
      confidence: 0.45,
      scope: 'project',
    }
    const { markdown } = renderMemoryConcept(c)
    const body = splitMd(markdown)!.body
    expect(body).toContain('fast cuts') // value
    expect(body).toContain('0.45') // confidence
    expect(body).toContain('project-scoped') // scope
  })

  it('a value with frontmatter-hostile chars stays in the body, not the frontmatter', () => {
    const c: MemoryConcept = {
      category: 'content',
      key: 'note',
      // colons, brackets, hashes — would corrupt a naive frontmatter parser.
      value: 'use ratio 16:9; tags: [a, b]; #hero shots\nmulti-line too',
      confidence: 1,
      scope: 'user',
    }
    const { id, markdown } = renderMemoryConcept(c)
    const split = splitMd(markdown)!
    // Frontmatter still parses cleanly (value is NOT in frontmatter).
    const meta = __parseFrontmatterForTesting(split.fm, id)
    expect(meta).not.toBeNull()
    expect(meta!.type).toBe('preference')
    // The raw value lives in the body.
    expect(split.body).toContain('use ratio 16:9')
    expect(split.body).toContain('multi-line too')
  })

  it('clamps out-of-range / non-finite confidence', () => {
    const hi = renderMemoryConcept({ category: 'a', key: 'b', value: 'v', confidence: 5, scope: 'user' })
    expect(hi.markdown).toContain('confidence: 1.00')
    const nan = renderMemoryConcept({ category: 'a', key: 'b', value: 'v', confidence: NaN, scope: 'user' })
    expect(nan.markdown).toContain('confidence: 0.00')
  })

  it('memoryConceptId is filesystem-safe and deterministic', () => {
    expect(memoryConceptId('style', 'bg color')).toBe('style__bg-color')
    expect(memoryConceptId('style', 'bg color')).toBe(memoryConceptId('style', 'bg color'))
  })
})

describe('buildMemoryIndex (pure)', () => {
  it('empty concept list → valid index with the no-entries marker', () => {
    const idx = buildMemoryIndex([])
    const split = splitMd(idx)
    expect(split).not.toBeNull()
    const meta = __parseFrontmatterForTesting(split!.fm, 'index')
    expect(meta).not.toBeNull()
    expect(meta!.type).toBe('index')
    expect(idx).toContain('No learned preferences yet')
  })

  it('lists each concept with scope + confidence', () => {
    const rendered = [
      renderMemoryConcept({ category: 'style', key: 'bg', value: 'dark', confidence: 0.8, scope: 'user' }),
      renderMemoryConcept({ category: 'workflow', key: 'tempo', value: 'fast', confidence: 0.5, scope: 'project' }),
    ]
    const idx = buildMemoryIndex(rendered)
    expect(idx).toContain('style__bg.md')
    expect(idx).toContain('workflow__tempo.md')
    expect(idx).toContain('(project, confidence 0.50)')
  })
})

// ── Write (path-guarded, overwrite) ──────────────────────────────────────────

describe('writeMemoryBundle', () => {
  it('writes one concept file per memory + an index.md under ~/.dreambyte/memory', async () => {
    const concepts: MemoryConcept[] = [
      { category: 'style', key: 'bg', value: 'dark', confidence: 0.8, scope: 'user' },
      { category: 'workflow', key: 'tempo', value: 'fast', confidence: 0.5, scope: 'project' },
    ]
    const res = await writeMemoryBundle(concepts)
    expect(res.dir).toBe(getMemoryBundleDir())
    expect(res.dir.startsWith(tmpHome)).toBe(true) // $HOME override honoured
    expect(res.conceptCount).toBe(2)

    const files = fs.readdirSync(res.dir).sort()
    expect(files).toContain('index.md')
    expect(files).toContain('style__bg.md')
    expect(files).toContain('workflow__tempo.md')

    // Every concept file parses via the registry parser.
    for (const f of files) {
      if (f === 'index.md') continue
      const raw = fs.readFileSync(path.join(res.dir, f), 'utf-8')
      const meta = __parseFrontmatterForTesting(splitMd(raw)!.fm, f.replace(/\.md$/, ''))
      expect(meta, f).not.toBeNull()
      expect(meta!.type).toBe('preference')
    }
  })

  it('empty memory → valid empty bundle (only index.md, no throw)', async () => {
    const res = await writeMemoryBundle([])
    expect(res.conceptCount).toBe(0)
    const files = fs.readdirSync(res.dir)
    expect(files).toEqual(['index.md'])
    const idx = fs.readFileSync(path.join(res.dir, 'index.md'), 'utf-8')
    expect(idx).toContain('No learned preferences yet')
  })

  it('project-scoped and user-global are both represented with distinct scopes', async () => {
    const res = await writeMemoryBundle([
      { category: 'style', key: 'palette', value: 'warm', confidence: 0.7, scope: 'user' },
      { category: 'style', key: 'pacing', value: 'snappy', confidence: 0.6, scope: 'project' },
    ])
    const userFile = fs.readFileSync(path.join(res.dir, 'style__palette.md'), 'utf-8')
    const projFile = fs.readFileSync(path.join(res.dir, 'style__pacing.md'), 'utf-8')
    expect(userFile).toContain('scope: user')
    expect(userFile).toContain('user-global')
    expect(projFile).toContain('scope: project')
    expect(projFile).toContain('project-scoped')
  })

  it('regenerate overwrites (no dup) and sweeps a key that no longer exists', async () => {
    await writeMemoryBundle([
      { category: 'style', key: 'bg', value: 'dark', confidence: 0.8, scope: 'user' },
      { category: 'workflow', key: 'tempo', value: 'fast', confidence: 0.5, scope: 'user' },
    ])
    const dir = getMemoryBundleDir()
    expect(fs.existsSync(path.join(dir, 'workflow__tempo.md'))).toBe(true)

    // Re-run with the tempo key dropped and bg's value changed.
    const res = await writeMemoryBundle([
      { category: 'style', key: 'bg', value: 'light', confidence: 0.9, scope: 'user' },
    ])
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(['index.md', 'style__bg.md']) // tempo swept, no dup
    expect(res.removed).toContain('workflow__tempo.md')
    // bg overwritten in place (single file, new value).
    const bg = fs.readFileSync(path.join(dir, 'style__bg.md'), 'utf-8')
    expect(bg).toContain('light')
    expect(bg).not.toContain('dark')
  })

  it('leaves a foreign (non-generator-owned) .md untouched across a regenerate', async () => {
    const dir = getMemoryBundleDir()
    fs.mkdirSync(dir, { recursive: true })
    // A user-/tool-authored note + README that do NOT match the concept-id shape.
    fs.writeFileSync(path.join(dir, 'notes.md'), '# my notes\nhand-written', 'utf-8')
    fs.writeFileSync(path.join(dir, 'README.md'), '# readme', 'utf-8')

    // Seed a generator-owned concept, then regenerate with it dropped.
    await writeMemoryBundle([{ category: 'style', key: 'bg', value: 'dark', confidence: 0.8, scope: 'user' }])
    const res = await writeMemoryBundle([])

    // The stale generator-owned concept is swept...
    expect(res.removed).toContain('style__bg.md')
    expect(fs.existsSync(path.join(dir, 'style__bg.md'))).toBe(false)
    // ...but the foreign files survive untouched (content intact).
    expect(res.removed).not.toContain('notes.md')
    expect(res.removed).not.toContain('README.md')
    expect(fs.existsSync(path.join(dir, 'notes.md'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'notes.md'), 'utf-8')).toContain('hand-written')
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true)
  })

  it('two rows whose keys slugify to the same id both produce distinct files (no drop)', async () => {
    // 'bg color', 'bg-color', 'bg_color' all slug to 'bg-color' → same base id.
    const concepts: MemoryConcept[] = [
      { category: 'style', key: 'bg color', value: 'first', confidence: 0.8, scope: 'user' },
      { category: 'style', key: 'bg-color', value: 'second', confidence: 0.7, scope: 'user' },
      { category: 'style', key: 'bg_color', value: 'third', confidence: 0.6, scope: 'user' },
    ]
    const res = await writeMemoryBundle(concepts)
    expect(res.conceptCount).toBe(3)

    const dir = getMemoryBundleDir()
    const conceptFiles = fs.readdirSync(dir).filter((f) => f !== 'index.md')
    // No silent drop: three distinct files for three distinct rows.
    expect(conceptFiles).toHaveLength(3)
    expect(new Set(conceptFiles).size).toBe(3)

    // The collision is surfaced (the first claims the bare id; the other two are
    // disambiguated).
    expect(res.collisions).toHaveLength(2)
    expect(res.collisions.every((c) => c.baseId === 'style__bg-color')).toBe(true)
    expect(res.collisions.every((c) => c.id !== c.baseId)).toBe(true)
    // The bare id went to the first row; disambiguated ids are distinct.
    expect(conceptFiles).toContain('style__bg-color.md')
    const disambIds = new Set(res.collisions.map((c) => c.id))
    expect(disambIds.size).toBe(2)

    // Each row's value is preserved (nothing clobbered).
    const allContent = conceptFiles.map((f) => fs.readFileSync(path.join(dir, f), 'utf-8')).join('\n')
    expect(allContent).toContain('first')
    expect(allContent).toContain('second')
    expect(allContent).toContain('third')

    // Disambiguation is deterministic across runs.
    const res2 = await writeMemoryBundle(concepts)
    expect(res2.collisions.map((c) => c.id).sort()).toEqual(res.collisions.map((c) => c.id).sort())
  })

  it('single-row (no collision) behaviour is unchanged: bare id, empty collisions', async () => {
    const res = await writeMemoryBundle([
      { category: 'style', key: 'bg', value: 'dark', confidence: 0.8, scope: 'user' },
    ])
    expect(res.collisions).toEqual([])
    const files = fs.readdirSync(getMemoryBundleDir()).sort()
    expect(files).toEqual(['index.md', 'style__bg.md'])
  })

  it('a crafted category/key with traversal cannot escape the bundle dir', async () => {
    // memoryConceptId slugifies `../` to hyphens, so the file stays a direct
    // child — assert the escape attempt did NOT write outside the bundle dir.
    await writeMemoryBundle([
      { category: '../../etc', key: 'passwd', value: 'x', confidence: 1, scope: 'user' },
    ])
    const dir = getMemoryBundleDir()
    // Nothing written outside the bundle dir.
    expect(fs.existsSync(path.join(tmpHome, 'etc'))).toBe(false)
    expect(fs.existsSync(path.join(tmpHome, '.dreambyte', 'etc'))).toBe(false)
    // The concept landed as a direct, slugified child.
    const files = fs.readdirSync(dir).filter((f) => f !== 'index.md')
    expect(files).toHaveLength(1)
    expect(fs.realpathSync(path.dirname(path.join(dir, files[0])))).toBe(fs.realpathSync(dir))
  })
})
