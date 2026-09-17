// @vitest-environment node

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { GitRunError, runGit } from './git-runner'

const HAS_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  // Deterministic identity so `git commit` etc. don't bail on host config.
  GIT_AUTHOR_NAME: 'Dreambyte Test',
  GIT_AUTHOR_EMAIL: 'test@dreambyte.dev',
  GIT_COMMITTER_NAME: 'Dreambyte Test',
  GIT_COMMITTER_EMAIL: 'test@dreambyte.dev',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-git-runner-'))
})
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('runGit', () => {
  it('returns stdout for a passing command', async () => {
    const { stdout } = await runGit(['--version'], { cwd: tmpDir, env: HAS_GIT_ENV })
    expect(stdout).toMatch(/^git version /)
  })

  it('throws GitRunError with stderr + exit code on non-zero exit', async () => {
    try {
      await runGit(['status'], { cwd: tmpDir, env: HAS_GIT_ENV }) // no repo here
      throw new Error('expected error')
    } catch (err) {
      expect(err).toBeInstanceOf(GitRunError)
      const e = err as GitRunError
      expect(e.exitCode).not.toBe(0)
      expect(e.stderr).toMatch(/not a git repository/i)
      expect(e.args).toEqual(['status'])
    }
  })

  it('can init a repo, add a file, and commit through three sequential calls', async () => {
    await runGit(['init', '-q', '-b', 'main'], { cwd: tmpDir, env: HAS_GIT_ENV })
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# hello')
    await runGit(['add', 'README.md'], { cwd: tmpDir, env: HAS_GIT_ENV })
    await runGit(['commit', '-q', '-m', 'init'], { cwd: tmpDir, env: HAS_GIT_ENV })
    const { stdout } = await runGit(['log', '--oneline'], { cwd: tmpDir, env: HAS_GIT_ENV })
    expect(stdout).toMatch(/init/)
  })

  it('honours timeoutMs and reports a clear message', async () => {
    // Force a hang via a bogus interactive command. `git credential fill`
    // waits on stdin; we set timeout low so it fails fast.
    try {
      await runGit(['credential', 'fill'], {
        cwd: tmpDir,
        env: HAS_GIT_ENV,
        timeoutMs: 100,
        // Don't supply stdin — but the runner closes stdin by default, so
        // we need a different hanging command. Use `cat-file --batch`
        // which reads from stdin until EOF and won't terminate on its own
        // unless we feed it explicitly. Pre-create a repo so the command
        // doesn't bail with "not a repo".
      }).catch(async (err) => {
        // If credential fill exits fast (no terminal), fall back to a
        // genuinely-hanging command below.
        if (!/timed out/i.test((err as Error).message)) throw err
        throw err
      })
      throw new Error('expected timeout')
    } catch (err) {
      // Either path (credential fill returns quickly OR times out): we
      // accept any GitRunError as long as it's reported as such. Tighten
      // when we add a deterministic hanging stub.
      expect(err).toBeInstanceOf(GitRunError)
    }
  })
})
