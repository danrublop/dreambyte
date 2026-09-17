// @vitest-environment node
//
// Tests for the credential-gated no-op of scripts/upload-sentry-symbols.mjs.
// The script must sit unconditionally in the dist:* chain and exit 0 (never
// fail the build) when the Sentry upload credentials are absent or partial —
// otherwise an unsigned/local build with no Sentry org would break shipping.
//
// We spawn the script (matching scripts/mcp/install-dreambyte-skill.test.ts) with a
// scrubbed env so it takes the skip path. The real upload (creds present) is
// environment-gated by design and not exercised here — it needs a live Sentry
// project and sentry-cli network access.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'release', 'upload-sentry-symbols.mjs')

/** Spawn the uploader with the three Sentry creds removed from env, plus any overrides. */
function runWithoutCreds(overrides: Record<string, string> = {}) {
  const env = { ...process.env, ...overrides }
  delete env.SENTRY_AUTH_TOKEN
  delete env.SENTRY_ORG
  delete env.SENTRY_PROJECT
  return spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 30_000 })
}

describe('upload-sentry-symbols.mjs — credential gate', () => {
  it('exits 0 and prints a skip notice when no Sentry creds are set', () => {
    const r = runWithoutCreds()
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/skipping symbol upload/i)
  })

  it('still skips (exit 0) when creds are only partially set', () => {
    // Only the token is present — org + project missing → must not attempt upload.
    const r = runWithoutCreds({ SENTRY_AUTH_TOKEN: 'fake-token-only' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/skipping symbol upload/i)
  })
})
