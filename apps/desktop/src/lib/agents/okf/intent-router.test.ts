// @vitest-environment node

// OKF intent-router. Pure function: ProjectBrief → OKFLoadPlan. These
// table-driven tests lock the routing contract across video types, formats, and
// drivers so the deterministic intent→knowledge mapping can't silently drift.
//
// NOTE: the corpus is four technical packs — audio (core),
// research (lane:media), generation (lane:avatar), and three (renderer, on-demand
// only). Renderer craft is NOT routed here; it reaches a builder from plan state
// (prompts.ts SCENE_TYPE_GUIDANCE). There are no pipelines/playbooks.

import { describe, expect, it } from 'vitest'
import type { ProjectBrief } from '../../types/project'
import {
  routeOKF,
  derivePacingProfile,
  deriveRequiredTags,
  selectRulePacksByTags,
  OKF_RULE_PACKS,
} from './intent-router'

/** Minimal valid ProjectBrief; override per case. */
function brief(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return {
    aspectRatio: '16:9',
    lengthClass: 'longform',
    runtimeTargetSec: null,
    videoType: 'explainer',
    logLine: 'test',
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

describe('routeOKF — always-on craft rule packs', () => {
  it('always injects audio (core), and nothing else for a bare brief', () => {
    expect(routeOKF(brief()).rulePacks).toEqual([OKF_RULE_PACKS.audio])
  })

  it('never routes `three` — it is on-demand only via get_routed_craft', () => {
    expect(routeOKF(brief({ videoType: 'film' })).rulePacks).not.toContain(OKF_RULE_PACKS.three)
  })
})

describe('routeOKF — lane gating', () => {
  it('avatarSequencing lane tracks isAvatarCentric', () => {
    expect(routeOKF(brief({ isAvatarCentric: true })).lanes.avatarSequencing).toBe(true)
    expect(routeOKF(brief({ isAvatarCentric: false })).lanes.avatarSequencing).toBe(false)
  })

  it('avatarSequencing lane pulls the generation rule pack', () => {
    expect(routeOKF(brief({ isAvatarCentric: true })).rulePacks).toContain(OKF_RULE_PACKS.generation)
    expect(routeOKF(brief()).rulePacks).not.toContain(OKF_RULE_PACKS.generation)
  })

  it('mediaSourcing lane + rule pack when research/stock/generate', () => {
    const ms = {
      research: false,
      stock: true,
      generate: false,
      userAssets: false,
      branding: false,
      overlays: { captions: false, stickers: false, svgs: false, lowerThirds: false },
    }
    const plan = routeOKF(brief({ mediaStrategy: ms }))
    expect(plan.lanes.mediaSourcing).toBe(true)
    expect(plan.rulePacks).toContain(OKF_RULE_PACKS.research)
  })
})

describe('routeOKF — format no longer swaps packs', () => {
  it('shortform and longform route the same set (the upload pack was deleted)', () => {
    expect(routeOKF(brief({ lengthClass: 'shortform' })).rulePacks).toEqual(
      routeOKF(brief({ lengthClass: 'longform' })).rulePacks,
    )
  })
})

describe('derivePacingProfile', () => {
  it('shortform → single-act-fast, tight, ~2s hook', () => {
    const p = derivePacingProfile(brief({ lengthClass: 'shortform' }))
    expect(p.shape).toBe('single-act-fast')
    expect(p.beatDensity).toBe('tight')
    expect(p.hookWindowSec).toBe(2)
    expect(p.acts).toEqual([])
  })

  it('longform → 3-act with impact ≤7s and budgets summing to total', () => {
    const p = derivePacingProfile(brief({ lengthClass: 'longform', runtimeTargetSec: 90 }))
    expect(p.shape).toBe('3-act')
    expect(p.totalTargetSec).toBe(90)
    const impact = p.acts.find((a) => a.role === 'impact')!
    expect(impact.targetSec).toBeLessThanOrEqual(7)
    expect(impact.targetSec).toBeGreaterThanOrEqual(5)
    const sum = p.acts.reduce((n, a) => n + a.targetSec, 0)
    expect(sum).toBe(90)
  })

  it('uses a per-type default runtime when runtimeTargetSec is null', () => {
    expect(derivePacingProfile(brief({ videoType: 'explainer', runtimeTargetSec: null })).totalTargetSec).toBe(90)
    expect(derivePacingProfile(brief({ videoType: 'marketing', runtimeTargetSec: null })).totalTargetSec).toBe(60)
    expect(derivePacingProfile(brief({ videoType: 'podcast', runtimeTargetSec: null })).totalTargetSec).toBe(120)
    expect(derivePacingProfile(brief({ lengthClass: 'shortform', runtimeTargetSec: null })).totalTargetSec).toBe(30)
  })

  it('podcast/film get relaxed beat density', () => {
    expect(derivePacingProfile(brief({ videoType: 'podcast' })).beatDensity).toBe('relaxed')
    expect(derivePacingProfile(brief({ videoType: 'film' })).beatDensity).toBe('relaxed')
    expect(derivePacingProfile(brief({ videoType: 'explainer' })).beatDensity).toBe('standard')
  })
})

describe('routeOKF — determinism', () => {
  it('same brief → identical plan', () => {
    const b = brief({ videoType: 'marketing', lengthClass: 'shortform', isAvatarCentric: true })
    expect(routeOKF(b)).toEqual(routeOKF(b))
  })
})

// ── P3: tag-routing ─────────────────────────────────────────────────────────
// The bundle's real frontmatter tags after the 22→4 cut: audio (core) + the two
// production lanes + a PURE renderer pack (three) that MUST never be selected as
// craft. Mirrors loadRulePackIndex().
const BUNDLE_INDEX = [
  { id: 'audio', tags: ['core', 'audio'] },
  { id: 'research', tags: ['lane:media'] },
  { id: 'generation', tags: ['lane:avatar'] },
  { id: 'three', tags: ['renderer'] }, // pure renderer, no routing tag — never selected
]

const ms = (o: Partial<ReturnType<typeof brief>['mediaStrategy']> = {}) => ({
  research: false,
  stock: false,
  generate: false,
  userAssets: false,
  branding: false,
  overlays: { captions: false, stickers: false, svgs: false, lowerThirds: false },
  ...o,
})

describe('routeOKF — tag-routing PARITY with hardcoded fallback', () => {
  const cases = [
    brief(),
    brief({ lengthClass: 'shortform' }),
    brief({ videoType: 'film' }),
    brief({ videoType: 'marketing' }),
    brief({ videoType: 'professional' }),
    brief({ videoType: 'podcast' }),
    brief({ hasUploadedFootage: true, footageHasSpeech: true }),
    brief({ isAvatarCentric: true }),
    brief({ mediaStrategy: ms({ stock: true }) }),
    brief({ mediaStrategy: ms({ stock: true, generate: true }) }),
    brief({ mediaStrategy: ms({ branding: true }) }),
    brief({ mediaStrategy: ms({ overlays: { captions: true, stickers: false, svgs: false, lowerThirds: false } }) }),
    brief({
      videoType: 'marketing',
      lengthClass: 'shortform',
      mediaStrategy: ms({ stock: true, generate: true, branding: true }),
    }),
  ]
  it.each(cases.map((b, i) => [i, b] as const))('case %i — tag-routed set === hardcoded set', (_i, b) => {
    const tagged = routeOKF(b, { ruleIndex: BUNDLE_INDEX }).rulePacks
    const hardcoded = routeOKF(b).rulePacks // no index → fallback
    expect([...tagged].sort()).toEqual([...hardcoded].sort())
  })
})

describe('routeOKF — tag-routing extensibility + safety', () => {
  it('a NEW file tagged "core" auto-routes with no code change', () => {
    const idx = [...BUNDLE_INDEX, { id: 'new-core-pack', tags: ['core'] }]
    expect(routeOKF(brief(), { ruleIndex: idx }).rulePacks).toContain('new-core-pack')
  })

  it('PURE renderer-tagged files (no routing tag) are never selected — even maximally', () => {
    const packs = routeOKF(
      brief({
        videoType: 'film',
        lengthClass: 'shortform',
        hasUploadedFootage: true,
        footageHasSpeech: true,
        isAvatarCentric: true,
        mediaStrategy: ms({ stock: true, generate: true, branding: true }),
      }),
      { ruleIndex: BUNDLE_INDEX },
    ).rulePacks
    expect(packs).not.toContain('three') // pure renderer — on-demand only
  })

  it('selected packs are ordered core-first then by priority', () => {
    const packs = routeOKF(brief({ isAvatarCentric: true, mediaStrategy: ms({ stock: true }) }), {
      ruleIndex: BUNDLE_INDEX,
    }).rulePacks
    expect(packs).toEqual(['audio', 'research', 'generation']) // core → lane:media → lane:avatar
  })

  it('empty index → falls back to hardcoded (never empty for a valid brief)', () => {
    expect(routeOKF(brief(), { ruleIndex: [] }).rulePacks.length).toBeGreaterThan(0)
  })
})

describe('deriveRequiredTags', () => {
  it('always requires core', () => {
    expect(deriveRequiredTags(brief())).toContain('core')
  })
  it('never requires the deleted lane:motion / format:shortform tags', () => {
    const maximal = deriveRequiredTags(
      brief({ videoType: 'film', lengthClass: 'shortform', hasUploadedFootage: true, isAvatarCentric: true }),
    )
    expect(maximal).not.toContain('lane:motion')
    expect(maximal).not.toContain('format:shortform')
  })
  it('adds lane tags off the brief drivers', () => {
    expect(deriveRequiredTags(brief({ mediaStrategy: ms({ stock: true }) }))).toContain('lane:media')
    expect(deriveRequiredTags(brief({ isAvatarCentric: true }))).toContain('lane:avatar')
    expect(deriveRequiredTags(brief())).not.toContain('lane:avatar')
  })
  it('does NOT route the deleted design lanes (footage/branding/grade)', () => {
    const tags = deriveRequiredTags(
      brief({
        videoType: 'film',
        hasUploadedFootage: true,
        footageHasSpeech: true,
        mediaStrategy: ms({ branding: true }),
      }),
    )
    expect(tags).not.toContain('lane:footage')
    expect(tags).not.toContain('lane:branding')
    expect(tags).not.toContain('lane:grade')
  })
})

describe('selectRulePacksByTags', () => {
  it('selects by tag intersection only', () => {
    expect(selectRulePacksByTags(['core'], BUNDLE_INDEX).sort()).toEqual(['audio'])
    expect(selectRulePacksByTags(['lane:media'], BUNDLE_INDEX)).toEqual(['research'])
    expect(selectRulePacksByTags(['nonexistent-tag'], BUNDLE_INDEX)).toEqual([])
  })
})
