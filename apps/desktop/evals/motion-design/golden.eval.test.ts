import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanForFlow } from '../../src/lib/generation/flow-scan'
import { scanForSlop } from '../../src/lib/generation/slop-scan'

/**
 * STRUCTURAL FLOOR eval — NOT a quality judge.
 *
 * This checks only that a scene clears the obvious-slop floor: no slop (emoji/kicker/loop)
 * AND the FLOW structure is present (camera move + big text + >1 beat). That is the
 * difference between "wrote camera-travel code" and "wrote a static slideshow". It does
 * NOT, and cannot, judge whether the video is GOOD — pacing, composition, taste, whether
 * the beat lands. That judgment is the human's, recorded in RUBRIC.md. The scanner exists
 * to fail the floors fast so a human isn't wasting a taste pass on a slideshow.
 *
 * `.good.txt` fixtures MUST clear the floor; `.bad.txt` (anti-patterns) MUST be flagged.
 * "Clears floor" != "good video". The only quality signal is the human RUBRIC rating.
 */

const GOLDEN_DIR = join(__dirname, 'golden')

interface Result {
  file: string
  expectGood: boolean
  slop: string[]
  flow: string[]
  structuralFloorPass: boolean
}

function evaluate(): Result[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((file) => {
      const code = readFileSync(join(GOLDEN_DIR, file), 'utf8')
      const slop = scanForSlop(code)
      const flow = scanForFlow(code).warnings
      return {
        file,
        expectGood: file.includes('.good.'),
        slop,
        flow,
        structuralFloorPass: slop.length === 0 && flow.length === 0,
      }
    })
}

describe('motion-design structural-floor eval (NOT a quality judge)', () => {
  const results = evaluate()

  it('has golden fixtures to evaluate', () => {
    expect(results.length).toBeGreaterThan(0)
  })

  for (const r of results) {
    it(`${r.file} — ${r.expectGood ? 'should clear the structural floor' : 'should be flagged (anti-pattern)'}`, () => {
      if (r.expectGood) {
        expect(r.slop, `slop in ${r.file}`).toEqual([])
        expect(r.flow, `flow gaps in ${r.file}`).toEqual([])
      } else {
        expect(r.slop.length + r.flow.length, `${r.file} should be flagged`).toBeGreaterThan(0)
      }
    })
  }

  it('reports the structural-floor pass-rate (a floor, not a grade)', () => {
    const good = results.filter((r) => r.expectGood)
    const passing = good.filter((r) => r.structuralFloorPass).length
    const rate = good.length ? Math.round((passing / good.length) * 100) : 0
    // eslint-disable-next-line no-console
    console.log(
      `\n[motion-design eval] structural floor: ${passing}/${good.length} good fixtures cleared (${rate}%)` +
        ` — this is NOT a quality score; the video grade is the human RUBRIC pass.` +
        `\n  ${results.map((r) => `${r.structuralFloorPass ? 'FLOOR-OK' : 'FLAGGED '} ${r.file}`).join('\n  ')}\n`,
    )
    // Regression gate: every .good fixture must keep clearing the floor.
    expect(passing).toBe(good.length)
  })
})
