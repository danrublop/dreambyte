import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The whole mechanism is that a bare snake_case identifier appears in TWO places —
 * a `flag({ code: ... })` call in verify-tools.ts and a rule pack under
 * `.claude/skills/dreambyte/rules/` — and the model joins them because it has seen
 * both. There is no import between them, so nothing but this test stops a rename in
 * one place from silently orphaning the other. That is the cost of the design; this
 * is the whole price paid.
 *
 * Note what is deliberately NOT asserted: that every code is cited. Most codes should
 * NOT be — an uncited code costs zero prompt tokens until it fires, which is the
 * entire reason the mechanism is cheap. Citing all of them would rebuild a prose
 * doctrine wall.
 */
const SOURCE = path.join(process.cwd(), 'src/lib/agents/tool-handlers/verify-tools.ts')
const RULES = path.join(process.cwd(), '.claude/skills/dreambyte/rules')

/** Codes as the source defines them — read from the `code:` literals, not a registry. */
function definedCodes(): Set<string> {
  const src = readFileSync(SOURCE, 'utf8')
  return new Set([...src.matchAll(/\bcode:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]))
}

/** Codes prose cites — a bare snake_case identifier in backticks. */
function citedCodes(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  if (!existsSync(RULES)) return found
  for (const f of readdirSync(RULES).filter((n) => n.endsWith('.md'))) {
    const body = readFileSync(path.join(RULES, f), 'utf8')
    for (const m of body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+){2,})`/g)) {
      found.set(m[1], [...(found.get(m[1]) ?? []), f])
    }
  }
  return found
}

describe('verify_scene lint codes', () => {
  it('defines codes at the push site (no registry to drift from)', () => {
    const codes = definedCodes()
    expect(codes.size).toBeGreaterThan(0)
    for (const c of codes) expect(c, `"${c}" is not snake_case`).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('every code a rule pack cites still exists in the source', () => {
    const defined = definedCodes()
    const orphans: string[] = []
    for (const [code, files] of citedCodes()) {
      // Only judge identifiers that LOOK like our codes and were once real — a rule
      // pack mentioning some other snake_case thing is not this test's business.
      if (!defined.has(code) && /^(scene|text|expected)_/.test(code)) {
        orphans.push(`${code} (cited in ${files.join(', ')})`)
      }
    }
    expect(orphans, 'rule packs cite verify codes that no longer exist').toEqual([])
  })

  it('every fixHint names a replacement rather than restating the violation', () => {
    const src = readFileSync(SOURCE, 'utf8')
    const hints = [...src.matchAll(/fixHint:\s*\n?\s*'([^']+)'/g)].map((m) => m[1])
    expect(hints.length).toBeGreaterThan(0)
    for (const h of hints) {
      // A hint that only says something is wrong is the message again, in a slot that
      // is supposed to tell the agent what to DO.
      expect(h.length, `fixHint too short to be actionable: "${h}"`).toBeGreaterThan(25)
      expect(h, `fixHint restates the violation instead of the fix: "${h}"`).not.toMatch(
        /^(invalid|not allowed|forbidden|this is wrong)/i,
      )
    }
  })

  it('an error-severity code blocks and a warn does not', () => {
    // The blocking switch is severity on the finding — one boolean, no config. If this
    // ever needs a flag, that is the moment the mechanism stopped being cheap.
    const src = readFileSync(SOURCE, 'utf8')
    expect(src).toMatch(/const hardFail = findings\.some\(\(f\) => f\.severity === 'error'\)/)
  })
})
