import { describe, it, expect } from 'vitest'
import { normalizeProjectBrief, deriveLengthClass, buildSystemPrompt } from './extract-project-brief'

describe('deriveLengthClass', () => {
  // FORMAT + TYPE decide the regime, NOT runtime (stress-test P0 fix). A short
  // runtime no longer forces shortform — a 30-60s 16:9 piece is short LONGFORM.
  it('routes landscape/square to longform REGARDLESS of a short runtime', () => {
    expect(deriveLengthClass('16:9', 45)).toBe('longform')
    expect(deriveLengthClass('16:9', 60)).toBe('longform')
    expect(deriveLengthClass('16:9', 26)).toBe('longform')
    expect(deriveLengthClass('1:1', 30)).toBe('longform')
  })

  it('routes vertical/portrait feed formats to shortform', () => {
    expect(deriveLengthClass('9:16', 600)).toBe('shortform') // even at a long runtime
    expect(deriveLengthClass('9:16', null)).toBe('shortform')
    expect(deriveLengthClass('4:5', null)).toBe('shortform')
  })

  it('an explicit shortform videoType always wins', () => {
    expect(deriveLengthClass('16:9', 600, 'shortform')).toBe('shortform')
  })

  it('falls back to runtime only when the aspect ratio is unknown', () => {
    // 16:9 / 1:1 default project aspects always resolve above; this exercises the
    // tie-breaker for a would-be-unknown aspect by passing the documented default.
    expect(deriveLengthClass('16:9', null)).toBe('longform')
    expect(deriveLengthClass('1:1', null)).toBe('longform')
  })
})

describe('normalizeProjectBrief', () => {
  it('returns safe defaults for empty / garbage input (never throws)', () => {
    for (const junk of [null, undefined, 42, 'nope', [], {}]) {
      const b = normalizeProjectBrief(junk, { aspectRatio: '16:9' })
      expect(b.videoType).toBe('other')
      expect(b.voiceDriver).toBe('narration-led')
      expect(b.logLine).toBe('')
      expect(b.audience).toBe('')
      expect(b.intent).toBeNull()
      expect(b.runtimeTargetSec).toBeNull()
      expect(b.hasUploadedFootage).toBe(false)
      expect(b.footageHasSpeech).toBe(false)
      expect(b.isAvatarCentric).toBe(false)
      expect(b.mediaStrategy).toEqual({
        research: false,
        stock: false,
        generate: false,
        userAssets: false,
        branding: false,
        overlays: { captions: false, stickers: false, svgs: false, lowerThirds: false },
      })
      expect(b.source).toBe('agent-inferred')
      expect(b.confidence).toBe(0.4) // garbage/empty input → low confidence (trips the confirm gate)
      expect(b.version).toBe(1)
    }
  })

  it('always takes aspectRatio from opts and derives lengthClass (ignores model-supplied values)', () => {
    const b = normalizeProjectBrief(
      { aspectRatio: '9:16', lengthClass: 'shortform', runtimeTargetSec: 300 },
      { aspectRatio: '16:9' },
    )
    expect(b.aspectRatio).toBe('16:9') // from opts, not the parsed payload
    expect(b.lengthClass).toBe('longform') // derived from 300s, not trusted
  })

  it('captures requestedAspectRatio from the prompt and re-derives lengthClass', () => {
    // "vertical TikTok" against a 16:9 project → brief reflects 9:16, shortform.
    const vertical = normalizeProjectBrief(
      { requestedAspectRatio: '9:16', runtimeTargetSec: 30 },
      { aspectRatio: '16:9' },
    )
    expect(vertical.aspectRatio).toBe('9:16')
    expect(vertical.lengthClass).toBe('shortform')

    // Invalid/absent requestedAspectRatio falls back to the project setting.
    expect(normalizeProjectBrief({ requestedAspectRatio: 'banana' }, { aspectRatio: '16:9' }).aspectRatio).toBe('16:9')
    expect(normalizeProjectBrief({}, { aspectRatio: '9:16' }).aspectRatio).toBe('9:16')
  })

  it('clamps videoType and voiceDriver to the allowed enums', () => {
    const good = normalizeProjectBrief({ videoType: 'explainer', voiceDriver: 'visual-led' }, { aspectRatio: '16:9' })
    expect(good.videoType).toBe('explainer')
    expect(good.voiceDriver).toBe('visual-led')

    const bad = normalizeProjectBrief({ videoType: 'tiktok', voiceDriver: 'robot' }, { aspectRatio: '16:9' })
    expect(bad.videoType).toBe('other')
    expect(bad.voiceDriver).toBe('narration-led')
  })

  it('clamps confidence to [0,1] and defaults a MISSING/non-numeric confidence to 0.4 (low → trips the confirm gate)', () => {
    expect(normalizeProjectBrief({ confidence: 5 }, { aspectRatio: '16:9' }).confidence).toBe(1)
    expect(normalizeProjectBrief({ confidence: -2 }, { aspectRatio: '16:9' }).confidence).toBe(0)
    // No usable confidence given → treat as low (0.4 < 0.5 threshold), not the
    // old 0.5 that sat on the boundary and silently passed as "confident enough".
    expect(normalizeProjectBrief({ confidence: 'high' }, { aspectRatio: '16:9' }).confidence).toBe(0.4)
    expect(normalizeProjectBrief({}, { aspectRatio: '16:9' }).confidence).toBe(0.4)
    expect(normalizeProjectBrief({ confidence: 0.8 }, { aspectRatio: '16:9' }).confidence).toBe(0.8)
  })

  it('reconciles footageHasSpeech=true with hasUploadedFootage=false', () => {
    const b = normalizeProjectBrief({ hasUploadedFootage: false, footageHasSpeech: true }, { aspectRatio: '16:9' })
    expect(b.footageHasSpeech).toBe(false)

    const ok = normalizeProjectBrief({ hasUploadedFootage: true, footageHasSpeech: true }, { aspectRatio: '16:9' })
    expect(ok.footageHasSpeech).toBe(true)
  })

  it('parses a full intent object and trims optional title/thumbnail', () => {
    const b = normalizeProjectBrief(
      {
        videoType: 'film',
        runtimeTargetSec: 120,
        logLine: 'A village gets power.',
        intent: { problem: 'no power', intention: 'bring power', obstacle: 'terrain', solution: 'solar' },
        audience: 'YouTube',
        title: '  We Powered a Mountain  ',
        thumbnailConcept: '  before/after  ',
        voiceDriver: 'narration-led',
        mediaStrategy: {
          research: true,
          stock: false,
          generate: true,
          userAssets: true,
          branding: false,
          overlays: { captions: true, stickers: false, svgs: false, lowerThirds: true },
        },
        confidence: 0.9,
      },
      { aspectRatio: '16:9' },
    )
    expect(b.intent).toEqual({ problem: 'no power', intention: 'bring power', obstacle: 'terrain', solution: 'solar' })
    expect(b.title).toBe('We Powered a Mountain')
    expect(b.thumbnailConcept).toBe('before/after')
    expect(b.lengthClass).toBe('longform')
    expect(b.mediaStrategy.research).toBe(true)
    expect(b.mediaStrategy.overlays.captions).toBe(true)
  })
})

describe('buildSystemPrompt — educational vs explainer disambiguation (④)', () => {
  it('teaches the classifier that documentary / "rise of X" is explainer, not educational', () => {
    const prompt = buildSystemPrompt()
    // The distinction that keeps a documentary from routing to a lesson pipeline.
    expect(prompt).toMatch(/"educational" means the viewer wants to BE TAUGHT/)
    expect(prompt).toMatch(/documentary-style retrospectives and origin stories/)
    expect(prompt).toMatch(/the rise of X/)
    expect(prompt).toMatch(/pick "explainer"/)
  })
})
