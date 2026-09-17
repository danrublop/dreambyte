// @vitest-environment node

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createWalWriter, readWal } from './wal'
import { fillBaseFields } from './executor'
import { replayProjectWal, replayAllProjectWals, type ReplayDeps } from './wal-replay'
import type { Action } from './types'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-wal-replay-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeAction(seedId: string): Action {
  return fillBaseFields(
    {
      id: seedId,
      type: 'scene/update',
      params: { sceneId: 'x', patch: { name: seedId } },
    },
    'user',
  )
}

function makeDeps(captured: Map<string, Action[]>, opts: { existingProjects?: Set<string> } = {}): ReplayDeps {
  return {
    resolveProjectDir: (projectId) => path.join(root, projectId),
    appendActionRows: async (projectId, actions) => {
      const have = captured.get(projectId) ?? []
      const knownIds = new Set(have.map((a) => a.id))
      for (const a of actions) if (!knownIds.has(a.id)) have.push(a)
      captured.set(projectId, have)
    },
    // Default: every project exists. Tests that exercise the orphan guard pass
    // an `existingProjects` allowlist; anything outside it is treated as orphan.
    projectExists: async (projectId) => (opts.existingProjects ? opts.existingProjects.has(projectId) : true),
  }
}

describe('replayProjectWal', () => {
  it('returns replayed=0 when no WAL exists', async () => {
    const captured = new Map<string, Action[]>()
    const result = await replayProjectWal('p1', makeDeps(captured))
    expect(result.replayed).toBe(0)
    expect(captured.size).toBe(0)
  })

  it('replays WAL actions to the DB and truncates the file on success', async () => {
    const projectDir = path.join(root, 'p1')
    await fs.mkdir(projectDir, { recursive: true })
    const writer = createWalWriter({ projectDir })
    const a = makeAction('a-1')
    const b = makeAction('a-2')
    writer.append(a)
    writer.append(b)

    const captured = new Map<string, Action[]>()
    const result = await replayProjectWal('p1', makeDeps(captured))

    expect(result.replayed).toBe(2)
    expect(captured.get('p1')?.map((x) => x.id)).toEqual(['a-1', 'a-2'])

    // WAL truncated → second replay is a no-op.
    const reread = await readWal({ projectDir })
    expect(reread.actions).toEqual([])

    const second = await replayProjectWal('p1', makeDeps(captured))
    expect(second.replayed).toBe(0)
  })

  it('leaves the WAL intact when the DB write throws', async () => {
    const projectDir = path.join(root, 'p1')
    await fs.mkdir(projectDir, { recursive: true })
    const writer = createWalWriter({ projectDir })
    writer.append(makeAction('a-1'))

    const deps: ReplayDeps = {
      resolveProjectDir: (id) => path.join(root, id),
      appendActionRows: vi.fn(async () => {
        throw new Error('db boom')
      }),
    }
    const result = await replayProjectWal('p1', deps)
    expect(result.replayed).toBe(0)
    expect(result.error).toMatch(/db boom/)

    // WAL still has the line — we can try again next boot.
    const reread = await readWal({ projectDir })
    expect(reread.actions.length).toBe(1)
  })

  it('skips + quarantines an orphan project whose DB row is gone (no FK-failing insert)', async () => {
    const projectDir = path.join(root, 'gone')
    await fs.mkdir(projectDir, { recursive: true })
    const writer = createWalWriter({ projectDir })
    writer.append(makeAction('a-1'))
    writer.append(makeAction('a-2'))

    const captured = new Map<string, Action[]>()
    // existingProjects is empty → 'gone' is treated as orphan.
    const result = await replayProjectWal('gone', makeDeps(captured, { existingProjects: new Set() }))

    expect(result.skippedOrphan).toBe(true)
    expect(result.replayed).toBe(0)
    // Nothing was inserted — the FK-failing path is never reached.
    expect(captured.size).toBe(0)
    // Original WAL moved aside; readWal now finds nothing (no re-spam next boot).
    const reread = await readWal({ projectDir })
    expect(reread.actions).toEqual([])
    const entries = await fs.readdir(projectDir)
    expect(entries.some((f) => f.endsWith('.orphaned.jsonl'))).toBe(true)
    expect(result.quarantinePath).toBeDefined()
  })

  it('still replays normally when projectExists returns true', async () => {
    const projectDir = path.join(root, 'live')
    await fs.mkdir(projectDir, { recursive: true })
    const writer = createWalWriter({ projectDir })
    writer.append(makeAction('a-1'))

    const captured = new Map<string, Action[]>()
    const result = await replayProjectWal('live', makeDeps(captured, { existingProjects: new Set(['live']) }))
    expect(result.skippedOrphan).toBeUndefined()
    expect(result.replayed).toBe(1)
    expect(captured.get('live')?.map((x) => x.id)).toEqual(['a-1'])
  })

  it('quarantines a corrupted WAL while still flushing the parseable lines', async () => {
    const projectDir = path.join(root, 'p1')
    await fs.mkdir(projectDir, { recursive: true })
    const writer = createWalWriter({ projectDir })
    writer.append(makeAction('a-1'))
    // Append a malformed line by hand.
    await fs.appendFile(path.join(projectDir, 'wal.jsonl'), '{not valid json\n', 'utf-8')
    writer.append(makeAction('a-2'))

    const captured = new Map<string, Action[]>()
    const result = await replayProjectWal('p1', makeDeps(captured))
    expect(result.replayed).toBe(2)
    expect(result.corruptedLines).toBe(1)
    expect(result.quarantinePath).toBeDefined()
    // The quarantined file should exist.
    await expect(fs.stat(result.quarantinePath!)).resolves.toBeTruthy()
  })
})

describe('replayAllProjectWals', () => {
  it('returns [] when the projects root does not exist', async () => {
    const captured = new Map<string, Action[]>()
    const result = await replayAllProjectWals(path.join(root, 'nope'), makeDeps(captured))
    expect(result).toEqual([])
  })

  it('replays multiple projects, returns only those with actual content', async () => {
    const captured = new Map<string, Action[]>()
    const projectsRoot = path.join(root, 'projects')
    await fs.mkdir(path.join(projectsRoot, 'p1'), { recursive: true })
    await fs.mkdir(path.join(projectsRoot, 'p2'), { recursive: true })
    await fs.mkdir(path.join(projectsRoot, 'empty'), { recursive: true })

    const w1 = createWalWriter({ projectDir: path.join(projectsRoot, 'p1') })
    w1.append(makeAction('p1-1'))
    const w2 = createWalWriter({ projectDir: path.join(projectsRoot, 'p2') })
    w2.append(makeAction('p2-1'))
    w2.append(makeAction('p2-2'))

    const deps = {
      ...makeDeps(captured),
      resolveProjectDir: (id: string) => path.join(projectsRoot, id),
    }
    const results = await replayAllProjectWals(projectsRoot, deps)
    expect(results.map((r) => r.projectId).sort()).toEqual(['p1', 'p2'])
    const p1 = results.find((r) => r.projectId === 'p1')!
    const p2 = results.find((r) => r.projectId === 'p2')!
    expect(p1.replayed).toBe(1)
    expect(p2.replayed).toBe(2)
    expect(captured.get('p1')?.length).toBe(1)
    expect(captured.get('p2')?.length).toBe(2)
  })

  it('replays live projects and skips orphans in one pass', async () => {
    const captured = new Map<string, Action[]>()
    const projectsRoot = path.join(root, 'projects')
    await fs.mkdir(path.join(projectsRoot, 'live'), { recursive: true })
    await fs.mkdir(path.join(projectsRoot, 'orphan'), { recursive: true })

    createWalWriter({ projectDir: path.join(projectsRoot, 'live') }).append(makeAction('live-1'))
    createWalWriter({ projectDir: path.join(projectsRoot, 'orphan') }).append(makeAction('orphan-1'))

    const deps = {
      ...makeDeps(captured, { existingProjects: new Set(['live']) }),
      resolveProjectDir: (id: string) => path.join(projectsRoot, id),
    }
    const results = await replayAllProjectWals(projectsRoot, deps)

    const live = results.find((r) => r.projectId === 'live')!
    const orphan = results.find((r) => r.projectId === 'orphan')!
    expect(live.replayed).toBe(1)
    expect(orphan.skippedOrphan).toBe(true)
    expect(orphan.replayed).toBe(0)
    // Only the live project's actions made it to the DB.
    expect(captured.get('live')?.length).toBe(1)
    expect(captured.has('orphan')).toBe(false)
  })

  it('skips non-directory entries silently', async () => {
    const captured = new Map<string, Action[]>()
    const projectsRoot = path.join(root, 'projects')
    await fs.mkdir(projectsRoot, { recursive: true })
    await fs.writeFile(path.join(projectsRoot, 'stray.txt'), 'oops')
    const results = await replayAllProjectWals(projectsRoot, makeDeps(captured))
    expect(results).toEqual([])
  })
})
