// @vitest-environment node

// loadRulePacks reads the OKF craft rule-pack markdown the intent-router selects.
// These run against the REAL files on disk (.claude/skills/dreambyte/rules/), so
// they double as a guard that the authored packs exist and stay loadable.
//
// NOTE: the corpus is four packs — audio, three,
// research, generation — mirrored in OKF_RULE_PACKS.

import { describe, expect, it } from 'vitest'
import { loadRulePacks, loadRulePackIndex, loadRulePackIds } from './load-rule-packs'
import { OKF_RULE_PACKS, routeOKF } from './intent-router'
import type { ProjectBrief } from '../../types/project'

describe('loadRulePacks', () => {
  it('loads a real rule pack and returns its markdown', () => {
    const md = loadRulePacks([OKF_RULE_PACKS.audio])
    expect(md.length).toBeGreaterThan(100)
    expect(md.toLowerCase()).toMatch(/audio|sound|mix|music/)
  })

  it('loads multiple packs joined by a separator, in order', () => {
    const md = loadRulePacks([OKF_RULE_PACKS.audio, OKF_RULE_PACKS.three])
    expect(md).toContain('\n---\n')
    expect(md.search(/audio|three|anim/i)).toBeGreaterThanOrEqual(0)
  })

  it('all authored craft packs load (none missing)', () => {
    for (const id of Object.values(OKF_RULE_PACKS)) {
      expect(loadRulePacks([id]).length, `${id}.md should load`).toBeGreaterThan(50)
    }
  })

  it('the 7 three-* subpacks are GONE — three.md absorbed them', () => {
    // They were split out of three.md and merged back in the 22→4 cut. three.md must
    // no longer send the model after ids that would load empty.
    for (const id of [
      'three-studio',
      'three-text',
      'three-camera',
      'three-materials',
      'three-particles',
      'three-avatars',
      'three-postfx',
    ]) {
      expect(loadRulePacks([id]), `${id}.md must not exist`).toBe('')
      expect(loadRulePacks([OKF_RULE_PACKS.three]), `three.md must not reference ${id}`).not.toContain(id)
    }
  })

  it('skips a missing pack without throwing, keeps the rest', () => {
    const md = loadRulePacks(['this-pack-does-not-exist', OKF_RULE_PACKS.three])
    expect(md.length).toBeGreaterThan(50) // three still loaded
  })

  it('refuses unsafe ids (path-traversal defense)', () => {
    expect(loadRulePacks(['../../../etc/passwd'])).toBe('')
    expect(loadRulePacks(['foo/bar'])).toBe('')
  })

  it('returns empty string when nothing loads', () => {
    expect(loadRulePacks([])).toBe('')
    expect(loadRulePacks(['nope-nope'])).toBe('')
  })

  it('strips OKF frontmatter — never leaks YAML into the injected text', () => {
    const md = loadRulePacks([OKF_RULE_PACKS.three, OKF_RULE_PACKS.audio])
    expect(md.length).toBeGreaterThan(100) // body still present
    expect(md.startsWith('---')).toBe(false) // no leading frontmatter delimiter
    expect(md).not.toContain('timestamp: 2026-06-19T00:00:00Z') // no frontmatter field leaked
    expect(md).not.toMatch(/^type:\s*rule$/m) // no bare frontmatter type line
  })
})

describe('loadRulePackIds (the advertised craft enum)', () => {
  it('names EXACTLY the four packs on disk', () => {
    expect(loadRulePackIds()).toEqual(['audio', 'generation', 'research', 'three'])
  })

  it('is far smaller than the bodies it points at (the whole point)', () => {
    const ids = loadRulePackIds()
    expect(JSON.stringify(ids).length).toBeLessThan(loadRulePacks(ids).length / 100)
  })

  it('never advertises a pack deleted in the 22→4 cut', () => {
    const ids = loadRulePackIds()
    for (const gone of [
      'design-principles',
      'design-brief',
      'core',
      'react',
      'motion',
      'canvas2d',
      'd3',
      'svg',
      'upload',
      'avatar',
      'media-sourcing',
      '3d-texture-research',
    ]) {
      expect(ids, `${gone} was deleted`).not.toContain(gone)
    }
  })

  it('never advertises an id whose body cannot load', () => {
    // Every advertised id must round-trip through the loader, or the escape hatch
    // hands the model an empty string (exactly what the one recorded call got).
    for (const id of loadRulePackIds()) {
      expect(loadRulePacks([id]).length, `advertised pack "${id}" loaded empty`).toBeGreaterThan(0)
    }
  })
})

// ── Disk-level routing tags + end-to-end (guards real-file tag drift) ────────
function minimalBrief(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return {
    aspectRatio: '16:9',
    lengthClass: 'longform',
    runtimeTargetSec: null,
    videoType: 'explainer',
    logLine: 'x',
    intent: null,
    audience: 'general',
    voiceDriver: 'narration-led',
    hasUploadedFootage: false,
    footageHasSpeech: false,
    isAvatarCentric: false,
    mediaStrategy: {
      research: false,
      stock: false,
      generate: false,
      userAssets: false,
      branding: false,
      overlays: { captions: false, stickers: false, svgs: false, lowerThirds: false },
    },
    source: 'agent-inferred',
    confidence: 0.8,
    version: 1,
    ...overrides,
  }
}

describe('loadRulePackIndex (real on-disk tags)', () => {
  it('indexes the craft packs with their expected routing tags (catches tag drift)', () => {
    const byId = new Map(loadRulePackIndex().map((e) => [e.id, e.tags]))
    expect(byId.get('audio')).toContain('core')
    expect(byId.get('research')).toContain('lane:media')
    expect(byId.get('generation')).toContain('lane:avatar')
    expect(byId.get('three')).toContain('renderer')
  })

  it('excludes reserved index.md/log.md/README.md', () => {
    const ids = loadRulePackIndex().map((e) => e.id)
    expect(ids).not.toContain('index')
    expect(ids).not.toContain('log')
    expect(ids).not.toContain('README')
  })
})

describe('end-to-end: brief → route (live index) → load bodies', () => {
  it('a shortform explainer routes core and loads real, frontmatter-free bodies', () => {
    const plan = routeOKF(minimalBrief({ lengthClass: 'shortform' }), { ruleIndex: loadRulePackIndex() })
    expect(plan.rulePacks).toContain('audio')
    const md = loadRulePacks(plan.rulePacks)
    expect(md.length).toBeGreaterThan(500) // real craft loaded
    expect(md.startsWith('---')).toBe(false) // no frontmatter leak
    expect(md).not.toContain('timestamp: 2026-06-19T00:00:00Z')
  })

  it('an avatar-centric brief pulls the generation pack end-to-end', () => {
    const plan = routeOKF(minimalBrief({ isAvatarCentric: true }), {
      ruleIndex: loadRulePackIndex(),
    })
    expect(plan.rulePacks).toContain('generation')
    expect(loadRulePacks(['generation']).toLowerCase()).toMatch(/avatar|presenter|talking/)
  })
})
