#!/usr/bin/env node
// Sync source files from src/lib/motion-dsl/ into packages/motion-dsl/src/.
//
// The Dreambyte monorepo keeps src/lib/motion-dsl/ as the single source of truth so
// in-app imports stay first-class. This script mirrors the source files into
// the package's src/ tree (excluding test files) so `tsc` can produce a
// publishable dist/. The mirror is deterministic and idempotent — re-running
// overwrites without diff.
//
// Run via: npm run motion-dsl:sync (root) or npm run sync (in this package).

import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PACKAGE_DIR = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..')
const SRC_OF_TRUTH = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'lib', 'motion-dsl')
const PACKAGE_SRC = path.join(PACKAGE_DIR, 'src')

const SKIP_PATTERNS = [/\.test\.ts$/, /\/__tests__\//]

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full
    }
  }
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!(await exists(SRC_OF_TRUTH))) {
    throw new Error(`Source of truth missing: ${SRC_OF_TRUTH}`)
  }
  if (await exists(PACKAGE_SRC)) {
    await rm(PACKAGE_SRC, { recursive: true })
  }
  await mkdir(PACKAGE_SRC, { recursive: true })

  let copied = 0
  for await (const file of walk(SRC_OF_TRUTH)) {
    const rel = path.relative(SRC_OF_TRUTH, file)
    if (SKIP_PATTERNS.some((p) => p.test(rel))) continue
    const dest = path.join(PACKAGE_SRC, rel)
    await mkdir(path.dirname(dest), { recursive: true })
    const original = await readFile(file, 'utf-8')
    // Rewrite relative imports to use explicit .js extensions so the
    // emitted ESM works under Node's strict ESM resolver. Dreambyte's
    // source-of-truth is kept extension-free for ergonomic in-app
    // imports; this transform applies only to the package mirror.
    const rewritten = rewriteRelativeImports(original)
    await writeFile(dest, rewritten)
    copied++
  }
  console.log(`@dreambyte/motion-dsl sync: ${copied} file(s) → ${path.relative(REPO_ROOT, PACKAGE_SRC)}`)
}

function rewriteRelativeImports(src) {
  // Match `from '../foo'` or `from './foo'` — relative imports without an
  // extension. Append `.js` so Node ESM can resolve them after tsc emit.
  // Skip: imports that already end in `.js`, `.json`, or `.css`.
  const RE = /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g
  return src.replace(RE, (match, before, target, after) => {
    if (/\.(js|jsx|ts|tsx|json|css|mjs|cjs)$/.test(target)) return match
    return `${before}${target}.js${after}`
  })
}

main().catch((err) => {
  console.error('motion-dsl sync failed:', err)
  process.exit(1)
})
