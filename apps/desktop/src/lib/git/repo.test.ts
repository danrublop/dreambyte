// @vitest-environment node

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  gitAdd,
  gitBranchCreate,
  gitBranchList,
  gitCheckout,
  gitCommit,
  gitCurrentBranch,
  gitDiffNameStatus,
  gitInit,
  gitLog,
  gitStatus,
  assertSafeRefName,
} from './repo'

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Dreambyte Test',
  GIT_AUTHOR_EMAIL: 'test@dreambyte.dev',
  GIT_COMMITTER_NAME: 'Dreambyte Test',
  GIT_COMMITTER_EMAIL: 'test@dreambyte.dev',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

let cwd: string
const opts = () => ({ cwd, env: ENV })

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-git-repo-'))
})
afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

async function writeFile(rel: string, body: string) {
  const abs = path.join(cwd, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body)
}

describe('repo helpers', () => {
  it('init → status → add → commit → log round-trip', async () => {
    await gitInit(opts())
    expect(await gitStatus(opts())).toEqual([])

    await writeFile('project.json', '{"name":"demo"}')
    await writeFile('scenes/scene-001.dreambyte.json', '{}')

    // Git collapses untracked directories by default — we get `scenes/`
    // not the file inside. That's fine; the porcelain format roundtrips
    // and the test just confirms parsing.
    const status = await gitStatus(opts())
    const paths = status.map((s) => s.path).sort()
    expect(paths).toEqual(['project.json', 'scenes/'])
    expect(status.every((s) => s.code === '??')).toBe(true)

    await gitAdd(['.'], opts())
    const staged = await gitStatus(opts())
    expect(staged.every((s) => s.code === 'A ')).toBe(true)

    const sha = await gitCommit('init project', opts())
    expect(sha).toMatch(/^[0-9a-f]{40}$/)

    const log = await gitLog(opts())
    expect(log.length).toBe(1)
    expect(log[0].sha).toBe(sha)
    expect(log[0].subject).toBe('init project')
    expect(log[0].authorName).toBe('Dreambyte Test')
    expect(log[0].date).toMatch(/T/)
  })

  it('branch create + list + currentBranch reports the right ref', async () => {
    await gitInit(opts())
    await writeFile('a.txt', 'a')
    await gitAdd(['.'], opts())
    await gitCommit('init', opts())

    expect(await gitCurrentBranch(opts())).toBe('main')

    await gitBranchCreate('feature/captions', opts())
    const list = await gitBranchList(opts())
    expect(list.sort()).toEqual(['feature/captions', 'main'])

    await gitCheckout('feature/captions', opts())
    expect(await gitCurrentBranch(opts())).toBe('feature/captions')
  })

  // Security review F86: a leading-dash ref name would be parsed by git as an
  // option (e.g. `git checkout -f` → destructive force-checkout).
  it('rejects option-injection and malformed ref names', async () => {
    expect(() => assertSafeRefName('-f')).toThrow(/option injection/)
    expect(() => assertSafeRefName('--force')).toThrow(/option injection/)
    expect(() => assertSafeRefName('')).toThrow(/Empty/)
    expect(() => assertSafeRefName('bad..name')).toThrow(/Invalid/)
    expect(() => assertSafeRefName('has space')).toThrow(/Invalid/)
    expect(() => assertSafeRefName('ends.lock')).toThrow(/Invalid/)
    // Legitimate names pass.
    expect(() => assertSafeRefName('feature/captions')).not.toThrow()
    expect(() => assertSafeRefName('release-2.0')).not.toThrow()
  })

  it('gitCheckout / gitBranchCreate refuse a dash-leading branch name', async () => {
    await gitInit(opts())
    await writeFile('x.txt', '1')
    await gitAdd(['.'], opts())
    await gitCommit('init', opts())
    await expect(gitBranchCreate('-D', opts())).rejects.toThrow(/option injection/)
    await expect(gitCheckout('-f', opts())).rejects.toThrow(/option injection/)
  })

  it('diff name-status returns added / modified / deleted between two refs', async () => {
    await gitInit(opts())
    await writeFile('keep.txt', 'one')
    await writeFile('drop.txt', 'one')
    await gitAdd(['.'], opts())
    const c1 = await gitCommit('c1', opts())

    await writeFile('keep.txt', 'two') // modify
    await writeFile('add.txt', 'new') // add
    await fs.rm(path.join(cwd, 'drop.txt')) // delete
    await gitAdd(['.'], opts())
    // Stage the deletion explicitly — `add .` already does it on modern git.
    const c2 = await gitCommit('c2', opts())

    const diff = await gitDiffNameStatus(c1, c2, opts())
    const byPath = Object.fromEntries(diff.map((d) => [d.path, d.status]))
    expect(byPath['keep.txt']).toBe('M')
    expect(byPath['add.txt']).toBe('A')
    expect(byPath['drop.txt']).toBe('D')
  })

  it('gitCommit throws when the tree is clean (no --allow-empty)', async () => {
    await gitInit(opts())
    await writeFile('a.txt', '1')
    await gitAdd(['.'], opts())
    await gitCommit('c1', opts())
    await expect(gitCommit('empty', opts())).rejects.toThrow()
  })

  it('gitCommit allows empty commits when allowEmpty is true', async () => {
    await gitInit(opts())
    await writeFile('a.txt', '1')
    await gitAdd(['.'], opts())
    await gitCommit('c1', opts())
    const sha = await gitCommit('marker', { ...opts(), allowEmpty: true })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const log = await gitLog(opts())
    expect(log.length).toBe(2)
  })

  it('gitInit on an already-initialised repo is idempotent', async () => {
    await gitInit(opts())
    await gitInit(opts())
    expect(await fs.stat(path.join(cwd, '.git'))).toBeTruthy()
  })
})
