import { describe, it, expect } from 'vitest'

import { isValidUuid } from './uuid'

describe('isValidUuid', () => {
  it('accepts canonical v4 UUIDs', () => {
    expect(isValidUuid('1204bc53-6132-4036-a211-5e76b12e8697')).toBe(true)
    expect(isValidUuid('FFD73F77-C2D8-4607-9782-2299D1F55A09')).toBe(true) // case-insensitive
  })

  it('rejects the empty string (the boot-hydration case that spammed IPC errors)', () => {
    expect(isValidUuid('')).toBe(false)
  })

  it('rejects malformed / legacy / non-string ids', () => {
    expect(isValidUuid('claude-code-cli')).toBe(false)
    expect(isValidUuid('1204bc53-6132-4036-a211')).toBe(false) // too short
    expect(isValidUuid('1204bc53_6132_4036_a211_5e76b12e8697')).toBe(false) // wrong separators
    expect(isValidUuid(undefined)).toBe(false)
    expect(isValidUuid(null)).toBe(false)
    expect(isValidUuid(123)).toBe(false)
  })
})
