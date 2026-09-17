import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ACTIVE_TOOLS, filterToolsForAgent } from './context-builder'

/**
 * `activeTools: []` used to short-circuit the filter and return the whole registry
 * with every provider gate bypassed — so "the user turned every chip off" produced a
 * BIGGER surface (103 tools / 132,935 B) than a realistic chip set (71 / 93,031), and
 * advertised paid generation on installs with no keys.
 *
 * Removing that early return gives `[]` its honest meaning, which in turn means every
 * caller that used `?? []` to mean "no preference" now has to say so with a real list.
 * DEFAULT_ACTIVE_TOOLS is that list, and it has to keep matching the store's seed or
 * an omitted-activeTools run silently diverges from what the chips show.
 */
describe('DEFAULT_ACTIVE_TOOLS', () => {
  it('matches the activeTools the store seeds (read from source — the store is a client module)', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/store/index.ts'), 'utf8')
    const m = src.match(/^\s*activeTools:\s*\[([^\]]*)\]/m)
    expect(m, 'could not find the activeTools seed in src/lib/store/index.ts — did it move?').toBeTruthy()
    const storeSeed = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    expect(storeSeed).toEqual([...DEFAULT_ACTIVE_TOOLS])
  })

  it('does not include the opt-in chips', () => {
    // Each of these is deliberately off until its chip is switched on; shipping one
    // here would undo the gate that made it opt-in (zdog ~976 tok, timeline ~20.6 kB).
    for (const optIn of ['zdog', 'timeline', 'interactions', 'avatars']) {
      expect(DEFAULT_ACTIVE_TOOLS).not.toContain(optIn)
    }
  })
})

describe('use_template rides the output mode it advertises', () => {
  const names = (outputMode?: 'mp4' | 'interactive') =>
    new Set(
      filterToolsForAgent(
        'scene-maker',
        [...DEFAULT_ACTIVE_TOOLS],
        {},
        {},
        undefined,
        false,
        false,
        undefined,
        false,
        outputMode,
      ).map((t) => t.name),
    )

  it('is absent from an mp4 build', () => {
    // Its own description says "Interactive output mode only" (tools.ts USE_TEMPLATE),
    // but TEMPLATE_TOOLS had no branch in the filter, so it fell through to `return true`.
    expect(names('mp4').has('use_template')).toBe(false)
  })

  it('is offered on an interactive build', () => {
    expect(names('interactive').has('use_template')).toBe(true)
  })

  it('is kept when the caller does not state a mode', () => {
    // Losing a tool because a call site forgot an argument is a worse failure than
    // offering one too many, so undefined keeps it.
    expect(names(undefined).has('use_template')).toBe(true)
  })
})
