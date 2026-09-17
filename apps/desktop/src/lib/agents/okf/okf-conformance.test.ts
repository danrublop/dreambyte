// @vitest-environment node

// OKF (Google Open Knowledge Format) v0.1 CONFORMANCE GATE for the canonical
// knowledge bundle. The hard floor: every non-reserved .md has a parseable YAML
// frontmatter block whose `type` is non-empty. Reserved files (index.md, log.md,
// README.md) are exempt. This is the CI guard that keeps the bundle conformant
// as knowledge is added/refined — a new rule pack without frontmatter fails here.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { parseFrontmatter, frontmatterType } from './frontmatter'

const ROOT = process.cwd()
const RESERVED = new Set(['index.md', 'log.md', 'README.md'])

function mdFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !RESERVED.has(f))
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

const BUNDLE_DIRS = [
  path.join(ROOT, '.claude', 'skills', 'dreambyte', 'rules'),
  path.join(ROOT, 'src', 'lib', 'skills', 'library'),
]

const FILES = (() => {
  const files = BUNDLE_DIRS.flatMap(mdFiles)
  const skill = path.join(ROOT, '.claude', 'skills', 'dreambyte', 'SKILL.md')
  if (fs.existsSync(skill)) files.push(skill)
  return files
})()

describe('OKF conformance floor — canonical bundle', () => {
  it('discovers a non-trivial set of knowledge files', () => {
    expect(FILES.length).toBeGreaterThan(10)
  })

  it('every non-reserved .md has a parseable frontmatter block', () => {
    const missing = FILES.filter((f) => !parseFrontmatter(fs.readFileSync(f, 'utf8')).hasFrontmatter).map((f) =>
      path.relative(ROOT, f),
    )
    expect(missing, `files WITHOUT frontmatter:\n${missing.join('\n')}`).toEqual([])
  })

  it('every non-reserved .md declares a non-empty `type`', () => {
    const bad = FILES.filter((f) => !frontmatterType(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f))
    expect(bad, `files missing a non-empty type:\n${bad.join('\n')}`).toEqual([])
  })

  it('every `type` is a well-formed slug (OKF tolerates ANY type — we only forbid malformed)', () => {
    // The OKF spec says consumers MUST tolerate unknown types, so we do NOT
    // whitelist a fixed vocabulary (that would block legitimate extension like
    // `template`/`case-study` without a code change). We only catch the failure
    // mode that actually breaks routing/tooling: empty or non-slug types
    // (uppercase, spaces, typos like "rule ").
    const SLUG = /^[a-z][a-z0-9-]*$/
    const offenders = FILES.map((f) => ({ f: path.relative(ROOT, f), t: frontmatterType(fs.readFileSync(f, 'utf8')) }))
      .filter((x) => !x.t || !SLUG.test(x.t))
      .map((x) => `${x.f} → type:${x.t}`)
    expect(offenders, `malformed type values:\n${offenders.join('\n')}`).toEqual([])
  })
})
