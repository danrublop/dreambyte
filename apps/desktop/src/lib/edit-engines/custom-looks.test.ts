// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { listCustomLooks, saveCustomLook, deleteCustomLook } from './custom-looks'

beforeEach(() => window.localStorage.clear())

describe('custom-looks', () => {
  it('round-trips a saved look with its full grade', () => {
    const looks = saveCustomLook('My teal & orange', {
      lookCss: 'sepia(0.1)',
      grade: {
        temperature: 0.4,
        curves: {
          rgb: [
            { x: 0, y: 0.05 },
            { x: 1, y: 1 },
          ],
        },
      },
    })
    expect(looks).toHaveLength(1)
    const loaded = listCustomLooks()[0]
    expect(loaded.name).toBe('My teal & orange')
    expect(loaded.grade?.temperature).toBe(0.4)
    expect(loaded.lookCss).toBe('sepia(0.1)')
  })

  it('saving the same name overwrites; delete removes', () => {
    saveCustomLook('A', { lookCss: 'sepia(0.1)' })
    const looks = saveCustomLook('A', { lookCss: 'sepia(0.9)' })
    expect(looks).toHaveLength(1)
    expect(looks[0].lookCss).toBe('sepia(0.9)')
    expect(deleteCustomLook(looks[0].id)).toHaveLength(0)
  })

  it('blank names are ignored; corrupt storage degrades to empty', () => {
    expect(saveCustomLook('   ', {})).toHaveLength(0)
    window.localStorage.setItem('dreambyte.customLooks.v1', '{not json')
    expect(listCustomLooks()).toEqual([])
  })
})
