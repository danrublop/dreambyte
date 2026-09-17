import { describe, it, expect } from 'vitest'
import { formatDate } from './format-date'

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

describe('formatDate', () => {
  it('returns "just now" for < 1 min ago', () => {
    expect(formatDate(minutesAgo(0))).toBe('just now')
  })

  it('returns minutes for 1–59 min ago', () => {
    expect(formatDate(minutesAgo(5))).toBe('5m ago')
    expect(formatDate(minutesAgo(59))).toBe('59m ago')
  })

  it('returns hours for 1–23 h ago', () => {
    expect(formatDate(hoursAgo(1))).toBe('1h ago')
    expect(formatDate(hoursAgo(23))).toBe('23h ago')
  })

  it('returns days for 1–6 d ago', () => {
    expect(formatDate(daysAgo(1))).toBe('1d ago')
    expect(formatDate(daysAgo(6))).toBe('6d ago')
  })

  it('returns locale date for >= 7 d ago', () => {
    const result = formatDate(daysAgo(8))
    // e.g. "Apr 18" — just check it's not a relative string
    expect(result).not.toMatch(/ago$/)
    expect(result).not.toBe('just now')
  })
})
