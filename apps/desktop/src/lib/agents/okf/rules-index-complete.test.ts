import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The bundle-root `.claude/skills/dreambyte/index.md` is the human/Claude-Code-facing
 * catalog of the craft packs; `loadRulePackIds` reads the DIRECTORY. Nothing connected
 * the two, so a pack could ship for weeks while absent from the index — it still ROUTED,
 * but nobody reading the index could see that it existed.
 *
 * The router derives itself from disk and so cannot name a missing pack; this is the
 * opposite direction — a pack on disk that the index forgot. Both directions asserted.
 *
 * (The per-directory rules/index.md this used to check was deleted with the 22→4 corpus
 * cut; with four packs the bundle-root index lists them directly.)
 */
const BUNDLE = path.join(process.cwd(), '.claude', 'skills', 'dreambyte')

describe('the bundle index lists every craft pack on disk', () => {
  it('.claude/skills/dreambyte/index.md', () => {
    const onDisk = readdirSync(path.join(BUNDLE, 'rules'))
      .filter((f) => f.endsWith('.md') && f !== 'index.md')
      .map((f) => f.replace(/\.md$/, ''))
      .sort()

    const index = readFileSync(path.join(BUNDLE, 'index.md'), 'utf8')
    const linked = [...index.matchAll(/\(\/rules\/([a-z0-9-]+)\.md\)/g)].map((m) => m[1]).sort()

    expect(
      onDisk.filter((n) => !linked.includes(n)),
      'pack files with no entry in index.md',
    ).toEqual([])
    expect(
      linked.filter((n) => !onDisk.includes(n)),
      'index.md links a pack that does not exist',
    ).toEqual([])
  })
})
