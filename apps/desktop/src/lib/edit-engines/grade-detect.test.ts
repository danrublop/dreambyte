// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { detectGrade, gradeManagedFilters, applyGradePreview, composeGradeFilters } from './grade-detect'
import { resolveGradeFilters, getColorGrade } from './color-grades'
import type { ClipFilter, Timeline } from '@/lib/types'

describe('detectGrade', () => {
  it('round-trips every preset at full intensity', () => {
    for (const id of ['cinematic', 'warm', 'cool', 'noir', 'faded', 'vivid']) {
      const d = detectGrade(resolveGradeFilters(id, 1)!)
      expect(d).toMatchObject({ gradeId: id, intensity: 1 })
    }
  })

  it('recovers intensity from scaled values', () => {
    const d = detectGrade(resolveGradeFilters('noir', 0.6)!)
    expect(d).toMatchObject({ gradeId: 'noir', intensity: 0.6 })
  })

  it('blur never affects detection (not grade-managed)', () => {
    const filters: ClipFilter[] = [{ type: 'blur', value: 2 }, ...resolveGradeFilters('warm', 1)!]
    expect(detectGrade(filters)).toMatchObject({ gradeId: 'warm' })
    expect(gradeManagedFilters(filters).some((f) => f.type === 'blur')).toBe(false)
  })

  it('hand-edited values read as custom; no grade-managed filters reads as null', () => {
    const tweaked = resolveGradeFilters('vivid', 1)!.map((f) => ({ ...f, value: f.value + 0.2 }))
    expect(detectGrade(tweaked)).toBe('custom')
    expect(detectGrade([{ type: 'blur', value: 1 }])).toBeNull()
    expect(detectGrade([])).toBeNull()
  })

  it('a partial preset (missing one filter) is custom, not a false match', () => {
    const partial = resolveGradeFilters('cinematic', 1)!.slice(1)
    expect(detectGrade(partial)).toBe('custom')
  })
})

describe('applyGradePreview', () => {
  const clip = (id: string, filters: ClipFilter[] = []) =>
    ({
      id,
      trackId: 'T',
      sourceType: 'scene',
      sourceId: 's',
      label: id,
      startTime: 0,
      duration: 5,
      trimStart: 0,
      trimEnd: null,
      speed: 1,
      opacity: 1,
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      filters,
      keyframes: [],
    }) as never
  const tl: Timeline = {
    tracks: [
      {
        id: 'T',
        name: 'Main',
        type: 'video',
        clips: [clip('c1', [{ type: 'blur', value: 2 }]), clip('c2')],
        muted: false,
        locked: false,
        position: 0,
      },
    ],
  }

  it('substitutes composed filters on the target clip, preserving blur', () => {
    const composed = composeGradeFilters(tl.tracks[0].clips[0].filters, getColorGrade('noir')!.filters)
    const out = applyGradePreview(tl, { clipId: 'c1', filters: composed })!
    const c1 = out!.tracks[0].clips[0]
    expect(c1.filters.some((f) => f.type === 'blur')).toBe(true)
    expect(c1.filters.some((f) => f.type === 'grayscale')).toBe(true)
    // c2 untouched; original timeline object untouched (pure)
    expect(out!.tracks[0].clips[1].filters).toHaveLength(0)
    expect(tl.tracks[0].clips[0].filters.some((f) => f.type === 'grayscale')).toBe(false)
  })

  it('composeGradeFilters preserves tone-curve entries (not grade-managed)', () => {
    const withCurve: ClipFilter[] = [
      {
        type: 'tone-curve',
        value: 1,
        curve: {
          rgb: [
            { x: 0, y: 0.2 },
            { x: 1, y: 1 },
          ],
        },
      },
      { type: 'sepia', value: 0.18 },
    ]
    const composed = composeGradeFilters(withCurve, getColorGrade('noir')!.filters)
    expect(composed.some((f) => f.type === 'tone-curve')).toBe(true)
    expect(composed.some((f) => f.type === 'sepia' && f.value === 0.18)).toBe(false)
  })

  it('no override / unknown clip → timeline passes through unchanged', () => {
    expect(applyGradePreview(tl, null)).toBe(tl)
    expect(applyGradePreview(tl, { clipId: 'nope', filters: [] })).toBe(tl)
  })
})
