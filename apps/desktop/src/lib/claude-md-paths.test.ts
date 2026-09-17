// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * CLAUDE.md loads into EVERY session in this repo, so a stale line there is not a
 * stale doc — it is a false instruction to whichever agent reads it next.
 *
 * It had rotted badly: a 12-row table of `/api/*` routes, an `src/app/api/` directory
 * tree, and "Scene API details" documenting GET/POST/PATCH semantics — for a
 * codebase with ZERO `route.ts` files. Three audits' worth of agents were told to
 * call endpoints that do not exist.
 *
 * This is the cheapest guard that would have caught it: every repo path CLAUDE.md
 * names must exist on disk. It does not check prose, endpoints, or counts — a full
 * doc-linter is not wanted. It catches the class that actually bit: a whole subtree
 * documented after it was deleted.
 */

const REPO = join(__dirname, '..', '..')

/**
 * Paths that legitimately exist for a developer but not in a fresh checkout, so
 * asserting them turns a correct doc into a red build. `node_modules` is the whole
 * category: CLAUDE.md discusses `packages/render-server/node_modules` at length (it carries
 * the export stitcher's modules, and the worktree script APFS-clones it),
 * but it is gitignored, and CI installs only the root tree — so this guard failed
 * on CI while passing locally, which is the exact failure mode it exists to prevent.
 * `out/` (the renderer's static export) is build output and absent in a fresh clone.
 */
const IGNORED_ON_CI = /(^|\/)node_modules(\/|$)|^out(\/|$)/

/** Repo-relative paths CLAUDE.md claims exist. */
function claimedPaths(md: string): string[] {
  const out = new Set<string>()

  const consider = (raw: string) => {
    const t = raw.trim().replace(/[),.:;]+$/, '')
    if (!t || t.includes(' ')) return
    // Not a repo path: URLs, absolute/home paths, placeholders, globs, env vars,
    // scoped npm packages, and bare words with no separator or extension.
    if (/^(~|\/|<|https?:|dreambyte:|file:|@)/.test(t)) return
    if (/[<>*?|]/.test(t)) return
    if (!t.includes('/') && !/\.[a-z]{2,4}$/i.test(t)) return
    // Path-ish, but a dotted identifier / channel name / code expression, not a file.
    if (/[(){}=]/.test(t)) return
    if (!/^[\w.@\-]+(\/[\w.@\-]+)*\/?$/.test(t)) return
    // Bare `foo.bar` with no slash is a channel or a property access, not a path.
    if (!t.includes('/') && !existsSync(join(REPO, t))) return
    out.add(t.replace(/\/$/, ''))
  }

  // 1. Inline code spans: `src/lib/agents/runner.ts`, `scripts/release/release.mjs`, …
  for (const m of md.matchAll(/`([^`\n]+)`/g)) consider(m[1])

  // 2. The "Key directories" tree — leading token of each line inside the fence.
  const tree = md.match(/## Key directories[\s\S]*?```\n([\s\S]*?)```/)
  if (tree) {
    for (const line of tree[1].split('\n')) {
      const tok = line.trim().split(/\s+/)[0]
      if (!tok || tok === '—') continue
      // Tree lines are indented CHILDREN of the last unindented parent.
      const indent = line.match(/^\s*/)![0].length
      consider(indent === 0 ? tok : joinToParent(tree[1], line, tok))
    }
  }

  return [...out]
}

/** Resolve an indented tree entry against its nearest less-indented ancestor. */
function joinToParent(block: string, line: string, tok: string): string {
  const lines = block.split('\n')
  const i = lines.indexOf(line)
  const indent = line.match(/^\s*/)![0].length
  for (let j = i - 1; j >= 0; j--) {
    const p = lines[j]
    if (!p.trim()) continue
    const pIndent = p.match(/^\s*/)![0].length
    if (pIndent < indent) {
      const parent = p.trim().split(/\s+/)[0].replace(/\/$/, '')
      return `${joinToParent(block, p, parent)}/${tok}`
    }
  }
  return tok
}

describe('CLAUDE.md describes a repo that exists', () => {
  const md = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8')

  it('names at least a few paths (the extractor still works)', () => {
    expect(claimedPaths(md).length).toBeGreaterThan(20)
  })

  it('every path it claims exists on disk', () => {
    const missing = claimedPaths(md)
      .filter((p) => !IGNORED_ON_CI.test(p))
      .filter((p) => !existsSync(join(REPO, p)))
    expect(missing, `CLAUDE.md points agents at paths that do not exist: ${missing.join(', ')}`).toEqual([])
  })

  it('does not resurrect the src/app/api fiction', () => {
    // The specific rot this guard was written for. `src/app/api/` and every `/api/*`
    // route it documented were deleted in the desktop migration; the doc kept
    // telling agents to call them for months.
    expect(existsSync(join(REPO, 'src', 'app', 'api'))).toBe(false)
    // A METHOD + /api/ path — i.e. an HTTP route documented as callable. Prose that
    // names the deleted routes to say they're GONE is fine; a route table is not.
    expect(md).not.toMatch(/\b(GET|POST|PATCH|PUT|DELETE)\s+`?\/api\//)
  })
})
