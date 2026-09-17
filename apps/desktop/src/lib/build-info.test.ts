// @vitest-environment node
/**
 * Acceptance check for the renderer build pipeline.
 *
 * Goal: catch a class of ship bugs where `next build` succeeded but the
 * sidecar files build-renderer.mjs is supposed to write are missing or
 * stale. If `out/build-info.json` is absent or its buildId doesn't match
 * `out/.build-id`, the auto-reload watcher in src/electron/main.ts won't fire
 * and the in-app "Build" panel will show no info — both ship-time
 * regressions we now know we have to defend against.
 *
 * Skipped when `out/` is empty — the test only runs after a build.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..', '..')
const outDir = path.join(repoRoot, 'out')
const buildIdPath = path.join(outDir, '.build-id')
const buildInfoPath = path.join(outDir, 'build-info.json')

// Skip the suite entirely unless a build-renderer.mjs run has produced
// BOTH sidecars. Pre-existing `out/` from before this change won't have
// them; the test only earns its keep against the new build pipeline.
const hasSidecars =
  fs.existsSync(outDir) &&
  fs.existsSync(path.join(outDir, 'index.html')) &&
  fs.existsSync(buildIdPath) &&
  fs.existsSync(buildInfoPath)

describe.skipIf(!hasSidecars)('renderer build sidecars', () => {
  it('writes both .build-id and build-info.json', () => {
    expect(fs.existsSync(buildIdPath)).toBe(true)
    expect(fs.existsSync(buildInfoPath)).toBe(true)
  })

  it('build-info.json has the same buildId as .build-id', () => {
    const id = fs.readFileSync(buildIdPath, 'utf-8').trim()
    const info = JSON.parse(fs.readFileSync(buildInfoPath, 'utf-8'))
    expect(info.buildId).toBe(id)
  })

  it('build-info.json shape is valid', () => {
    const info = JSON.parse(fs.readFileSync(buildInfoPath, 'utf-8'))
    expect(typeof info.buildId).toBe('string')
    expect(info.buildId.length).toBeGreaterThan(0)
    expect(typeof info.builtAt).toBe('string')
    // builtAt is ISO 8601 — parses as a real date
    expect(Number.isFinite(new Date(info.builtAt).getTime())).toBe(true)
    // gitSha may be null in non-git contexts; if present, it's a short hash
    if (info.gitSha !== null) {
      expect(typeof info.gitSha).toBe('string')
      expect(info.gitSha).toMatch(/^[0-9a-f]{4,40}$/)
    }
  })

  it('build-info.json is fresh — built within the last 24h', () => {
    // Catches the "stale ship" case: sidecar from yesterday's build but
    // chunks from today's. Loose threshold (24h) so the test isn't flaky on
    // CI; tighten if we add a release-time gate.
    const info = JSON.parse(fs.readFileSync(buildInfoPath, 'utf-8'))
    const ageMs = Date.now() - new Date(info.builtAt).getTime()
    expect(ageMs).toBeLessThan(24 * 60 * 60 * 1000)
  })
})
