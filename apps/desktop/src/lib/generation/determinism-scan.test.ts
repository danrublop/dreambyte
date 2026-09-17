import { describe, expect, it } from 'vitest'
import { scanForNondeterminism } from './determinism-scan'

const constructs = (code: string) =>
  scanForNondeterminism(code).map((v) => v.construct)

describe('scanForNondeterminism', () => {
  it('flags Math.random with a seeded-PRNG hint', () => {
    const v = scanForNondeterminism('const r = Math.random() * 10')
    expect(v).toHaveLength(1)
    expect(v[0].construct).toBe('Math.random(')
    expect(v[0].hint).toContain('mulberry32')
    expect(v[0].line).toBe(1)
  })

  it('flags whitespace-padded Math . random ( )', () => {
    expect(constructs('Math . random ()')).toContain('Math.random(')
  })

  it('flags Date.now()', () => {
    const v = scanForNondeterminism('const t = Date.now()')
    expect(v.map((x) => x.construct)).toContain('Date.now(')
    expect(v[0].hint).toContain('frame')
  })

  it('flags performance.now()', () => {
    expect(constructs('const t = performance.now()')).toContain('performance.now(')
  })

  it('flags the zero-arg new Date() form', () => {
    expect(constructs('const d = new Date()')).toContain('new Date()')
  })

  it('does NOT flag new Date(<fixedTimestamp>) — it is deterministic', () => {
    expect(constructs('const d = new Date(1700000000000)')).not.toContain('new Date()')
    expect(scanForNondeterminism('const d = new Date(1700000000000)')).toHaveLength(0)
  })

  it('does NOT flag new Date("2020-01-01")', () => {
    expect(scanForNondeterminism('const d = new Date("2020-01-01")')).toHaveLength(0)
  })

  it('flags timers as lower-severity but still surfaces them', () => {
    expect(constructs('setTimeout(fn, 100)')).toContain('setTimeout(')
    expect(constructs('setInterval(fn, 100)')).toContain('setInterval(')
    expect(constructs('requestAnimationFrame(loop)')).toContain('requestAnimationFrame(')
  })

  it('returns [] for deterministic code using mulberry32 and the frame clock', () => {
    const code = `
      const rand = mulberry32(SEED)
      function Scene({ t }) {
        const x = rand() * WIDTH
        return draw(x, t)
      }
    `
    expect(scanForNondeterminism(code)).toEqual([])
  })

  it('does NOT flag a match inside a line comment', () => {
    expect(scanForNondeterminism('// avoid Math.random() here\nconst x = rand()')).toEqual([])
  })

  it('does NOT flag a match inside a block comment', () => {
    expect(scanForNondeterminism('/* never call Date.now() */\nconst x = t')).toEqual([])
  })

  it('does NOT flag a match inside a string literal', () => {
    expect(scanForNondeterminism('const msg = "do not use Math.random() ever"')).toEqual([])
    expect(scanForNondeterminism("const msg = 'Date.now() is banned'")).toEqual([])
    expect(scanForNondeterminism('const msg = `requestAnimationFrame(x)`')).toEqual([])
  })

  it('still flags real code on lines after a comment mentioning the construct', () => {
    const code = '// Math.random is banned\nconst r = Math.random()'
    const v = scanForNondeterminism(code)
    expect(v.map((x) => x.construct)).toEqual(['Math.random('])
    // First (only) real match is on line 2, not the comment on line 1.
    expect(v[0].line).toBe(2)
  })

  it('reports one entry per distinct construct, not per occurrence', () => {
    const code = 'Math.random(); Math.random(); Date.now()'
    const v = scanForNondeterminism(code)
    expect(v.map((x) => x.construct).sort()).toEqual(['Date.now(', 'Math.random('])
  })

  it('handles empty / non-string input', () => {
    expect(scanForNondeterminism('')).toEqual([])
    // @ts-expect-error — defensive runtime guard
    expect(scanForNondeterminism(undefined)).toEqual([])
  })
})
