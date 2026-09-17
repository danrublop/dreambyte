#!/usr/bin/env node
/**
 * Guard for `npm run dev:electron` (standalone mode).
 *
 * The standalone dev flow loads the renderer from the static export in `out/`
 * via the dreambyte:// protocol handler. If that bundle is missing or is the bare
 * ~2KB placeholder produced by a pre-migration build, the Electron window
 * opens to a blank page and there's no obvious signal why.
 *
 * This script checks for a real static export and, if absent, runs
 * `build:renderer` once before Electron boots. Idempotent: if `out/` already
 * has a populated `index.html` (> 8KB) and a `_next/` chunk dir, it exits fast.
 *
 * For an explicit full rebuild use `npm run build:renderer` directly.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

const indexHtml = path.join(repoRoot, 'out', 'index.html')
const nextChunks = path.join(repoRoot, 'out', '_next')

function isPopulated() {
  try {
    const stat = fs.statSync(indexHtml)
    if (!stat.isFile() || stat.size < 8 * 1024) return false
    return fs.statSync(nextChunks).isDirectory()
  } catch {
    return false
  }
}

if (isPopulated()) {
  console.log('[ensure-renderer] out/ already populated, skipping rebuild.')
  process.exit(0)
}

console.log('[ensure-renderer] out/ missing or stale — running `build:renderer`...')
const res = spawnSync('node', ['scripts/build/build-renderer.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
})
if (res.status !== 0) {
  console.error('[ensure-renderer] build:renderer failed. Fix the error and re-run.')
  process.exit(res.status ?? 1)
}
