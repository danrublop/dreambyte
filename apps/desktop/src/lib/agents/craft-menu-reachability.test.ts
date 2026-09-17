import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filterToolsForAgent } from './context-builder'
import { loadRulePacks } from './okf/load-rule-packs'

/**
 * Every craft pack the model could need must be REACHABLE, and everything advertised
 * must resolve.
 *
 * THE RECURRING FAILURE: a pack is only usable if the model is told it exists, and an
 * id the model IS told about must resolve. The advertised list used to be typed by hand
 * in two places (get_routed_craft's `pack` description and ROUTER.md) and both drifted
 * from the directory — in both directions: packs on disk nobody could ask for, and ids
 * in a pack's own prose that the schema never named.
 *
 * The advertised list is now an ENUM generated from the directory, so both directions
 * are closed by construction. After the 22→4 corpus cut the enum is exactly four ids.
 */
const RULES_DIR = join(__dirname, '..', '..', '..', '.claude', 'skills', 'dreambyte', 'rules')
const RESERVED = new Set(['index.md', 'log.md', 'README.md'])
const STORE_DEFAULT = ['react', 'svg', 'canvas2d', 'd3', 'three', 'lottie', 'assets', 'audio', 'video']

const packEnum = (): string[] => {
  const tools = filterToolsForAgent(
    'scene-maker',
    STORE_DEFAULT,
    undefined,
    undefined,
    undefined,
    true,
    true,
    undefined,
    false,
  )
  const t = tools.find((x) => x.name === 'get_routed_craft')!
  const schema = t.input_schema as unknown as { properties: { pack: { enum?: string[] } } }
  return schema.properties.pack.enum ?? []
}

const onDisk = () =>
  readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.md') && !RESERVED.has(f))
    .map((f) => f.slice(0, -3))

describe('craft menu reachability', () => {
  it('advertises every pack that exists on disk', () => {
    const advertised = new Set(packEnum())
    expect(
      onDisk().filter((id) => !advertised.has(id)),
      'packs on disk the model is never told about',
    ).toEqual([])
  })

  it('advertises EXACTLY the four surviving packs', () => {
    expect(packEnum().slice().sort()).toEqual(['audio', 'generation', 'research', 'three'])
  })

  it('no surviving pack sends the model after a `pack:` id that no longer exists', () => {
    // The reverse direction, and the one that made this task recur: three.md used to be
    // a ROUTER whose body named seven three-* subtopic ids. They are merged in now, so a
    // `pack:` reference anywhere in the corpus must resolve to an advertised id.
    const advertised = new Set(packEnum())
    for (const id of advertised) {
      const named = [
        ...readFileSync(join(RULES_DIR, `${id}.md`), 'utf8').matchAll(/`?pack: ?'?(three-[a-z]+|[a-z0-9-]+)'?`?/g),
      ]
        .map((m) => m[1])
        .filter((n) => n.includes('-') || advertised.has(n))
      expect(
        named.filter((n) => !advertised.has(n)),
        `${id}.md names a pack id that does not exist`,
      ).toEqual([])
    }
  })

  it('every advertised id actually loads', () => {
    const advertised = packEnum()
    expect(advertised.length).toBe(4)
    for (const id of advertised) {
      expect(loadRulePacks([id]).length, `advertised pack "${id}" loaded empty`).toBeGreaterThan(0)
    }
  })

  it('costs a fraction of the prose menu it replaced', () => {
    // The menu was 1,824b of `- "id" — <trigger>` lines on every turn of every agent,
    // bought for a tool called ONCE in 36 recorded runs. Keep the enum cheap or the
    // escape hatch starts paying rent again.
    expect(JSON.stringify(packEnum()).length).toBeLessThan(500)
  })

  it('ROUTER.md no longer keeps a competing hand-written pack list', () => {
    // Two sources of truth is what caused the drift that hid core.md.
    const body = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'agent', 'ROUTER.md'), 'utf8')
    expect(body).not.toMatch(/Surviving packs:/)
  })
})
