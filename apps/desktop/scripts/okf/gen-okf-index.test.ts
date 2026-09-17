// @vitest-environment node
//
// CI stale-gate for the OKF substrate.
//
// The skill registry (src/lib/skills/library/*.md) is the FILE OF RECORD. index.md and
// the .agents three.md mirror are the GENERATED VIEWS (design-principles.md and
// design-brief.md were deleted with the 22→4 corpus cut, along with their emitters).
// This suite is the gate that makes the substrate self-healing:
//   - the committed tree must match what the generator would produce (so a
//     hand-edit of any generated file, on ANY root, fails CI), and
//   - the lints (first-clause-unique, no-duplicate-concept, cross-links) hold.
//
// On failure the fix is `npm run gen:okf` (regenerate from the file of record).

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  checkStale,
  allLints,
  buildIndexMarkdown,
  buildThreeMirror,
  lintFirstClauseUnique,
  findFirstClauseCollisions,
  lintNoDuplicateConcept,
  lintCrossLinksResolve,
  plannedTargets,
  INDEX_PATH,
  THREE_SOURCE_PATH,
  THREE_MIRROR_PATH,
} from './gen-okf-index'
import { getUserStylesDir, reindexSkills } from '../../src/lib/skills/registry'

// Save/restore disk so the "hand-edit fails" tests don't leave the tree dirty.
const snapshots = new Map<string, string>()
function snapshot(p: string) {
  if (!snapshots.has(p)) snapshots.set(p, fs.readFileSync(p, 'utf-8'))
}
afterEach(() => {
  for (const [p, content] of snapshots) fs.writeFileSync(p, content, 'utf-8')
  snapshots.clear()
})

describe('OKF substrate — committed tree is in sync (CRITICAL CI gate)', () => {
  it('no generated file is stale and no lint fails', () => {
    const { stale, lints } = checkStale()
    expect(stale, `stale files (run \`npm run gen:okf\`): ${stale.join(', ')}`).toEqual([])
    expect(lints, `lint failures: ${lints.join('; ')}`).toEqual([])
  })

  it('generates EXACTLY index.md + the three.md mirror — nothing resurrects a deleted pack', () => {
    const paths = plannedTargets().map((t) => t.path)
    expect(paths.sort()).toEqual([INDEX_PATH, THREE_MIRROR_PATH].sort())
    // Guards against the generator re-creating deleted packs (design-principles.md,
    // design-brief.md) on the next `npm run gen:okf`.
    for (const p of paths) {
      expect(p).not.toMatch(/design-(principles|brief)\.md$/)
    }
  })
})

describe('stale-gate fails on a hand-edit of ANY generated file', () => {
  it('hand-editing index.md → stale', () => {
    snapshot(INDEX_PATH)
    fs.appendFileSync(INDEX_PATH, '\n- `evil-hand-edit` — sneaks in.\n')
    expect(checkStale().stale).toContain('src/lib/skills/library/index.md')
  })

  it('hand-editing the .agents three.md mirror → stale', () => {
    snapshot(THREE_MIRROR_PATH)
    fs.appendFileSync(THREE_MIRROR_PATH, '\n<!-- drifted mirror -->\n')
    const stale = checkStale().stale
    expect(stale.some((s) => s.endsWith('three.md'))).toBe(true)
  })
})

describe('FIX 2 — generator is CURATED-ONLY (distilled styles never leak into index.md)', () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    if (tmpHome) {
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
    reindexSkills() // restore the real-library-only index for other suites
  })

  it('a distilled skill in a temp $HOME styles dir is EXCLUDED from index.md and keeps --check green', () => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'db-gen-okf-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome

    // Plant a machine-local distilled style with a hash id.
    const dir = getUserStylesDir()
    fs.mkdirSync(dir, { recursive: true })
    const distilledId = 'editorial-calm-abc123'
    fs.writeFileSync(
      path.join(dir, `${distilledId}.md`),
      [
        '---',
        `id: ${distilledId}`,
        'name: Editorial Calm',
        'category: style',
        'tier: on-demand',
        'origin: distilled',
        'enrichment: llm',
        'sceneType: any',
        'tags: [editorial, calm]',
        'description: A distilled style fixture.',
        '---',
        'Evokes a calm, editorial feel.',
      ].join('\n'),
    )
    reindexSkills()

    // The generated index.md must NOT contain the machine-local distilled id.
    const md = buildIndexMarkdown()
    expect(md).not.toContain(distilledId)
    // The curated catalog is still present.
    expect(md).toMatch(/`threejs-3d-scene` —/)

    // The stale-gate stays green even with the distilled skill on disk.
    const { stale, lints } = checkStale()
    expect(stale, `stale: ${stale.join(', ')}`).toEqual([])
    expect(lints, `lints: ${lints.join('; ')}`).toEqual([])
  })
})

describe('content shape', () => {
  it('index.md is negative-framed: every skill line has does/when/risk', () => {
    const md = buildIndexMarkdown()
    const skillLines = md.split('\n').filter((l) => /^- `/.test(l))
    expect(skillLines.length).toBeGreaterThanOrEqual(6)
    for (const line of skillLines) {
      expect(line).toMatch(/reach for it when/)
      expect(line).toMatch(/skipping risks/)
    }
  })

  it('index.md carries OKF frontmatter', () => {
    const md = buildIndexMarkdown()
    expect(md).toMatch(/^---\ntype: index/)
    expect(md).toMatch(/title: Skill Catalog Index/)
    expect(md).toMatch(/timestamp: \d{4}-\d{2}-\d{2}/)
  })

  it('the .agents three.md mirror is byte-identical to the .claude source of record', () => {
    expect(buildThreeMirror()).toBe(fs.readFileSync(THREE_SOURCE_PATH, 'utf-8'))
  })
})

describe('lints', () => {
  it('first-clause-unique: clean on the real catalog', () => {
    expect(lintFirstClauseUnique()).toEqual([])
  })

  it('first-clause-unique: CATCHES a synthetic collision (case-insensitive)', () => {
    const errs = findFirstClauseCollisions([
      { id: 'a', firstClause: 'draws shapes' },
      { id: 'b', firstClause: 'animates text' },
      { id: 'c', firstClause: 'Draws Shapes' }, // collides with a
    ])
    expect(errs.length).toBe(1)
    expect(errs[0]).toMatch(/"c" and "a"/)
  })

  it('no-duplicate-concept: clean (three.md single source)', () => {
    expect(lintNoDuplicateConcept()).toEqual([])
  })

  it('cross-links resolve to real concept ids', () => {
    expect(lintCrossLinksResolve()).toEqual([])
  })

  it('allLints aggregates the three lints', () => {
    expect(allLints()).toEqual([])
  })
})
