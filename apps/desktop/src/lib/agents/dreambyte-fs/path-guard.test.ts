// @vitest-environment node
//
// Tests for the path-containment boundary. These are load-bearing —
// "MCP fs server escapes scope" is on the plan's critical-gap list.
// Every escape vector we can think of belongs in this file; if the
// boundary regresses, external agents could read /etc/passwd via a
// crafted subpath and the whole external-agent story is unsafe.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { assertContained, isWithin, safeResolve, PathEscapeError } from './path-guard'

let scopeRoot: string
let outsideDir: string

beforeEach(async () => {
  scopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-fs-scope-'))
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-fs-outside-'))
  await fs.mkdir(path.join(scopeRoot, 'scenes'), { recursive: true })
  await fs.writeFile(path.join(scopeRoot, 'project.json'), '{}')
  await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'top-secret')
})

afterEach(async () => {
  await fs.rm(scopeRoot, { recursive: true, force: true })
  await fs.rm(outsideDir, { recursive: true, force: true })
})

describe('isWithin', () => {
  it('returns true when child equals parent', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
  })

  it('returns true when child is descendant', () => {
    expect(isWithin('/a/b', '/a/b/c')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true)
  })

  it('returns false on prefix-without-sep collisions', () => {
    expect(isWithin('/a/foo', '/a/foobar')).toBe(false)
    expect(isWithin('/a/foo', '/a/foo-other/x')).toBe(false)
  })

  it('returns false for siblings', () => {
    expect(isWithin('/a/b', '/a/c')).toBe(false)
  })
})

describe('safeResolve — happy path', () => {
  it('resolves a simple subpath under scope', async () => {
    const r = await safeResolve(scopeRoot, 'project.json')
    expect(r).toBe(await fs.realpath(path.join(scopeRoot, 'project.json')))
  })

  it('resolves a nested subpath', async () => {
    await fs.writeFile(path.join(scopeRoot, 'scenes', 's1.dreambyte.json'), '{}')
    const r = await safeResolve(scopeRoot, 'scenes/s1.dreambyte.json')
    expect(r).toContain('s1.dreambyte.json')
  })
})

describe('safeResolve — escape vectors', () => {
  it('rejects ../ traversal even when shallow', async () => {
    await expect(safeResolve(scopeRoot, '../../../etc/passwd')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects ../ traversal that lands one above scope', async () => {
    await expect(safeResolve(scopeRoot, '..')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects an absolute subpath', async () => {
    await expect(safeResolve(scopeRoot, '/etc/passwd')).rejects.toThrow(/Absolute/)
  })

  it('rejects null-byte truncation tricks', async () => {
    await expect(safeResolve(scopeRoot, 'project.json\0../../etc/passwd')).rejects.toThrow(/Null byte/)
  })

  it('rejects symlinks that point outside scope', async () => {
    // Drop a symlink inside scopeRoot pointing to a file outside it.
    const linkPath = path.join(scopeRoot, 'leak.txt')
    await fs.symlink(path.join(outsideDir, 'secret.txt'), linkPath)
    await expect(safeResolve(scopeRoot, 'leak.txt')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects symlinked directories that point outside scope', async () => {
    const linkDir = path.join(scopeRoot, 'leak-dir')
    await fs.symlink(outsideDir, linkDir, 'dir')
    await expect(safeResolve(scopeRoot, 'leak-dir/secret.txt')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects non-string subpath', async () => {
    // Cast to bypass the compile-time check — the runtime guard must
    // still reject non-strings since args come from JSON over IPC.
    await expect(safeResolve(scopeRoot, 123 as unknown as string)).rejects.toBeInstanceOf(PathEscapeError)
  })
})

describe('assertContained — mustExist:false', () => {
  it('allows a not-yet-created file under scope', async () => {
    const target = path.join(scopeRoot, 'new-thing.json')
    const { realCandidate } = await assertContained(scopeRoot, target, { mustExist: false })
    expect(realCandidate).toContain('new-thing.json')
  })

  it('still rejects an escape via parent-resolve', async () => {
    const target = path.join(scopeRoot, '..', 'new-thing.json')
    await expect(assertContained(scopeRoot, target, { mustExist: false })).rejects.toBeInstanceOf(PathEscapeError)
  })
})
