// @vitest-environment node
//
// CI-style guard: re-running the codegen script must produce a file
// byte-identical to what's checked in. Catches the "edited the .ts
// directly instead of the .mjs catalog" failure mode.

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

describe('motion preset codegen', () => {
  it('--check exits 0 (no drift)', () => {
    // Throws if the script exits non-zero.
    expect(() =>
      execFileSync('node', [path.join(REPO_ROOT, 'scripts/build/build-motion-presets.mjs'), '--check'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        timeout: 30_000,
      }),
    ).not.toThrow()
  })
})
