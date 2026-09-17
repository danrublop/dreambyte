// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { formatProjectBriefBlock } from './context-builder'
import type { ProjectBrief } from '../types'

/**
 * Drift guard for the OKF Layer-0 brief → prompt formatter. The formatter is
 * hand-coded per field, so a NEW ProjectBrief field can be silently dropped from
 * the prompt (exactly what hid `title`/`thumbnailConcept`). Two protections:
 *   1. `makeFullBrief()` is typed ProjectBrief — a new REQUIRED field won't
 *      compile here until it's added (tsc-level).
 *   2. The classification test below fails until every field is listed as
 *      FORMATTED (injected) or OMITTED (intentionally not), forcing a decision.
 */

// Fields the formatter injects into the prompt block.
const FORMATTED = new Set<keyof ProjectBrief>([
  'aspectRatio',
  'lengthClass',
  'runtimeTargetSec',
  'videoType',
  'title',
  'logLine',
  'audience',
  'voiceDriver',
  'intent',
  'hasUploadedFootage',
  'footageHasSpeech',
  'isAvatarCentric',
  'thumbnailConcept',
  'mediaStrategy',
  'confidence', // shown only when low; `source` gates that note
])
// Provenance — deliberately NOT shown to the model.
const OMITTED = new Set<keyof ProjectBrief>(['source', 'version'])

function makeFullBrief(over: Partial<ProjectBrief> = {}): ProjectBrief {
  return {
    aspectRatio: '16:9',
    lengthClass: 'longform',
    runtimeTargetSec: 90,
    videoType: 'explainer',
    logLine: 'LOGLINE_SENTINEL',
    intent: { problem: 'p', intention: 'i', obstacle: 'o', solution: 's' },
    audience: 'AUDIENCE_SENTINEL',
    title: 'TITLE_SENTINEL',
    thumbnailConcept: 'THUMB_SENTINEL',
    voiceDriver: 'narration-led',
    hasUploadedFootage: false,
    footageHasSpeech: false,
    isAvatarCentric: false,
    mediaStrategy: {
      research: true,
      stock: false,
      generate: true,
      userAssets: false,
      branding: false,
      overlays: { captions: true, stickers: false, svgs: false, lowerThirds: false },
    },
    source: 'user-explicit',
    confidence: 1,
    version: 1,
    ...over,
  }
}

describe('formatProjectBriefBlock — drift guard (#okf-gap-3)', () => {
  it('every ProjectBrief field is classified FORMATTED or OMITTED (a new field fails until decided)', () => {
    const keys = Object.keys(makeFullBrief()) as Array<keyof ProjectBrief>
    const unclassified = keys.filter((k) => !FORMATTED.has(k) && !OMITTED.has(k))
    expect(unclassified).toEqual([])
  })

  it('formatted scalar fields actually reach the prompt block — incl. the once-dropped title/thumbnail', () => {
    const out = formatProjectBriefBlock(makeFullBrief())
    expect(out).toContain('TITLE_SENTINEL')
    expect(out).toContain('THUMB_SENTINEL')
    expect(out).toContain('LOGLINE_SENTINEL')
    expect(out).toContain('AUDIENCE_SENTINEL')
    expect(out).toContain('explainer')
    expect(out).toContain('16:9')
    expect(out).toContain('narration-led')
    expect(out).toContain('research') // mediaStrategy flag
  })

  it('omitted provenance fields never leak into the prompt', () => {
    const out = formatProjectBriefBlock(makeFullBrief({ source: 'user-explicit', version: 7 }))
    expect(out).not.toContain('user-explicit')
    expect(out).not.toMatch(/version/i)
  })
})

describe('low-confidence confirm directive (#okf-gap-1)', () => {
  it('an inferred low-confidence brief gets an imperative confirm directive', () => {
    const out = formatProjectBriefBlock(makeFullBrief({ source: 'agent-inferred', confidence: 0.3 }))
    expect(out).toMatch(/LOW CONFIDENCE/)
    expect(out).toMatch(/ask_user/) // names the tool that actually pauses, not just prose
  })

  it('a high-confidence brief does NOT get the directive', () => {
    const out = formatProjectBriefBlock(makeFullBrief({ source: 'agent-inferred', confidence: 0.9 }))
    expect(out).not.toMatch(/LOW CONFIDENCE/)
  })

  it('a user-explicit brief is never second-guessed, even at low confidence', () => {
    const out = formatProjectBriefBlock(makeFullBrief({ source: 'user-explicit', confidence: 0.1 }))
    expect(out).not.toMatch(/LOW CONFIDENCE/)
  })
})
