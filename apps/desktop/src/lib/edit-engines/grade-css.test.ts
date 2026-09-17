// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { filtersToCss, parseCssFilters } from './grade-css'
import { resolveGradeFilters } from './color-grades'
import { detectGrade } from './grade-detect'

describe('grade-css', () => {
  it('round-trips every grade through CSS and back to detection', () => {
    for (const id of ['cinematic', 'warm', 'cool', 'noir', 'faded', 'vivid']) {
      const css = filtersToCss(resolveGradeFilters(id, 1)!)
      const { filters, hasUnknown } = parseCssFilters(css)
      expect(hasUnknown).toBe(false)
      expect(detectGrade(filters)).toMatchObject({ gradeId: id, intensity: 1 })
    }
  })

  it('round-trips intensity', () => {
    const css = filtersToCss(resolveGradeFilters('noir', 0.6)!)
    expect(detectGrade(parseCssFilters(css).filters)).toMatchObject({ gradeId: 'noir', intensity: 0.6 })
  })

  it('formats units correctly', () => {
    expect(
      filtersToCss([
        { type: 'hue-rotate', value: 12 },
        { type: 'blur', value: 3 },
        { type: 'sepia', value: 0.18 },
      ]),
    ).toBe('hue-rotate(12deg) blur(3px) sepia(0.18)')
  })

  it('parses percentage forms and flags unknown functions', () => {
    const { filters } = parseCssFilters('brightness(112%) sepia(18%)')
    expect(filters).toEqual([
      { type: 'brightness', value: 1.12 },
      { type: 'sepia', value: 0.18 },
    ])
    expect(parseCssFilters('drop-shadow(0 0 4px red) sepia(0.1)').hasUnknown).toBe(true)
    expect(parseCssFilters('url(#tone) brightness(1)').hasUnknown).toBe(true)
    expect(parseCssFilters('').filters).toHaveLength(0)
  })
})
