// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { COLOR_GRADES, GRADE_FILTER_TYPES, getColorGrade, resolveGradeFilters } from './color-grades'

describe('color grades', () => {
  it('every preset uses only grade-managed filter types with sane values', () => {
    for (const g of COLOR_GRADES) {
      expect(g.filters.length).toBeGreaterThan(0)
      for (const f of g.filters) {
        expect(GRADE_FILTER_TYPES).toContain(f.type)
        expect(Number.isFinite(f.value)).toBe(true)
        if (f.type === 'grayscale' || f.type === 'sepia') {
          expect(f.value).toBeGreaterThanOrEqual(0)
          expect(f.value).toBeLessThanOrEqual(1)
        }
      }
      // blur is never grade-managed — it would smear content silently.
      expect(g.filters.some((f) => (f.type as string) === 'blur')).toBe(false)
    }
  })

  it('intensity 1 returns the recipe; 0 returns empty (fully neutral)', () => {
    const full = resolveGradeFilters('noir', 1)!
    expect(full).toEqual(getColorGrade('noir')!.filters)
    expect(resolveGradeFilters('noir', 0)).toEqual([])
  })

  it('intensity 0.5 lerps toward the per-type neutral', () => {
    const half = resolveGradeFilters('noir', 0.5)!
    // contrast neutral=1: 1 + (1.22-1)*0.5 = 1.11; grayscale neutral=0: 0.5
    expect(half.find((f) => f.type === 'contrast')!.value).toBeCloseTo(1.11, 3)
    expect(half.find((f) => f.type === 'grayscale')!.value).toBeCloseTo(0.5, 3)
  })

  it('unknown grade → null; intensity clamped', () => {
    expect(resolveGradeFilters('vhs')).toBeNull()
    expect(resolveGradeFilters('vivid', 5)!).toEqual(getColorGrade('vivid')!.filters)
  })
})
