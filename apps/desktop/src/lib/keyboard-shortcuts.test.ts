// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { KEYBOARD_SHORTCUTS } from './keyboard-shortcuts'

describe('KEYBOARD_SHORTCUTS', () => {
  it('has at least one group', () => {
    expect(KEYBOARD_SHORTCUTS.length).toBeGreaterThan(0)
  })

  it('every group has a non-empty area and at least one shortcut', () => {
    for (const group of KEYBOARD_SHORTCUTS) {
      expect(group.area.trim().length).toBeGreaterThan(0)
      expect(group.shortcuts.length).toBeGreaterThan(0)
    }
  })

  it('every shortcut has non-empty keys and a non-empty label', () => {
    for (const group of KEYBOARD_SHORTCUTS) {
      for (const sc of group.shortcuts) {
        expect(Array.isArray(sc.keys)).toBe(true)
        expect(sc.keys.length).toBeGreaterThan(0)
        for (const k of sc.keys) {
          expect(typeof k).toBe('string')
          expect(k.length).toBeGreaterThan(0)
        }
        expect(sc.label.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('includes the help-sheet trigger itself (?)', () => {
    const all = KEYBOARD_SHORTCUTS.flatMap((g) => g.shortcuts)
    expect(all.some((s) => s.keys.length === 1 && s.keys[0] === '?')).toBe(true)
  })
})
