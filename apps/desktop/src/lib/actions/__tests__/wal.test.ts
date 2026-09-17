// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createWalWriter, readWal, truncateWal, walPath, createMemoryWalWriter } from '../wal'
import { fillBaseFields } from '../executor'
import type { Action, ActionInput } from '../types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-wal-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function makeAction(input: ActionInput, source: 'user' | 'agent' = 'user'): Action {
  return fillBaseFields(input, source)
}

describe('WAL writer', () => {
  it('appends one JSONL line per action and readWal reconstructs them in order', async () => {
    const writer = createWalWriter({ projectDir: dir })
    const a = makeAction({
      type: 'scene/create',
      params: { sceneId: 's1', scene: { id: 's1' } as never },
    })
    const b = makeAction({
      type: 'scene/update',
      params: { sceneId: 's1', patch: { name: 'x' } },
    })
    writer.append(a)
    writer.append(b)

    const result = await readWal({ projectDir: dir })
    expect(result.corruptedLines).toBe(0)
    expect(result.actions.length).toBe(2)
    expect(result.actions[0].id).toBe(a.id)
    expect(result.actions[1].id).toBe(b.id)
  })

  it('skips corrupted lines and quarantines the file', async () => {
    const writer = createWalWriter({ projectDir: dir })
    const a = makeAction({ type: 'scene/create', params: { sceneId: 's1', scene: { id: 's1' } as never } })
    writer.append(a)
    // Inject a bad line
    fsSync.appendFileSync(walPath({ projectDir: dir }), 'not json{\n')
    const b = makeAction({ type: 'scene/update', params: { sceneId: 's1', patch: { name: 'x' } } })
    writer.append(b)

    const result = await readWal({ projectDir: dir })
    expect(result.corruptedLines).toBe(1)
    expect(result.actions.length).toBe(2)
    expect(result.actions.map((x) => x.id)).toEqual([a.id, b.id])
    expect(result.quarantinePath).toBeDefined()
    // Original wal.jsonl was renamed; new one will be created on next append.
    expect(fsSync.existsSync(result.quarantinePath!)).toBe(true)
  })

  it('truncateWal empties the file', async () => {
    const writer = createWalWriter({ projectDir: dir })
    writer.append(makeAction({ type: 'scene/create', params: { sceneId: 's1', scene: { id: 's1' } as never } }))
    await truncateWal({ projectDir: dir })
    const result = await readWal({ projectDir: dir })
    expect(result.actions).toEqual([])
  })

  it('readWal returns empty when the file does not exist', async () => {
    const result = await readWal({ projectDir: dir })
    expect(result.actions).toEqual([])
    expect(result.corruptedLines).toBe(0)
  })

  it('memory WAL writer captures every appended action without disk', () => {
    const mem = createMemoryWalWriter()
    const a = makeAction({ type: 'scene/create', params: { sceneId: 's1', scene: { id: 's1' } as never } })
    mem.append(a)
    expect(mem.actions[0].id).toBe(a.id)
  })
})
