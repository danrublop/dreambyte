// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  serializeUndoStacks,
  parseUndoStacksPayload,
  scheduleDurableUndoPersist,
  flushDurableUndoPersist,
  hydrateUndoStacks,
  _resetDurableUndoPersist,
  UNDO_DB_DEBOUNCE_MS,
  type UndoStacksIpc,
  type UndoStacksInput,
} from '../undo-persistence'
import type { UndoableState } from '../types'

function legacyEntry(seq: number, code = ''): UndoableState {
  return {
    _seq: seq,
    scenes: [
      {
        id: `scene-${seq}`,
        name: `S${seq}`,
        sceneCode: code,
        aiLayers: [],
      } as never,
    ],
    globalStyle: {} as never,
    project: { id: 'p1' } as never,
  } as UndoableState
}

function stacks(overrides: Partial<UndoStacksInput> = {}): UndoStacksInput {
  return {
    undoStack: [legacyEntry(1)],
    redoStack: [],
    actionUndoStack: [{ type: 'scene/update', _seq: 2 } as never],
    actionRedoStack: [],
    ...overrides,
  }
}

class FakeIpc implements UndoStacksIpc {
  rows = new Map<string, string>()
  saveCalls = 0
  private key(k: { projectId: string; branchId: string | null }) {
    return `${k.projectId}::${k.branchId ?? 'NULL'}`
  }
  async save(args: { projectId: string; branchId: string | null; payload: string }) {
    this.saveCalls++
    this.rows.set(this.key(args), args.payload)
    return { success: true }
  }
  async load(args: { projectId: string; branchId: string | null }) {
    return { payload: this.rows.get(this.key(args)) ?? null }
  }
}

beforeEach(() => {
  _resetDurableUndoPersist()
  vi.useRealTimers()
})

describe('serialize / parse round-trip', () => {
  it('round-trips all four stacks', () => {
    const json = serializeUndoStacks(stacks())
    const parsed = parseUndoStacksPayload(json)
    expect(parsed?.undoStack).toHaveLength(1)
    expect(parsed?.actionUndoStack).toHaveLength(1)
    expect(parsed?.redoStack).toHaveLength(0)
  })

  it('strips heavy code fields from legacy entries', () => {
    const json = serializeUndoStacks(stacks({ undoStack: [legacyEntry(1, 'x'.repeat(10_000))] }))
    const parsed = parseUndoStacksPayload(json)
    expect((parsed?.undoStack[0]?.scenes[0] as { sceneCode?: string })?.sceneCode).toBe('')
  })

  it('rejects junk and unknown versions', () => {
    expect(parseUndoStacksPayload(null)).toBeNull()
    expect(parseUndoStacksPayload('not json')).toBeNull()
    expect(parseUndoStacksPayload(JSON.stringify({ v: 99 }))).toBeNull()
  })
})

describe('size cap', () => {
  it('drops redo first, then trims OLDEST undo entries until under the cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => legacyEntry(i))
    const json = serializeUndoStacks(
      stacks({ undoStack: many, redoStack: many.slice(0, 5) }),
      // Force trimming with a tiny cap.
      5_000,
    )
    const parsed = parseUndoStacksPayload(json)!
    expect(json.length).toBeLessThanOrEqual(5_000)
    expect(parsed.redoStack).toHaveLength(0)
    // Oldest trimmed: whatever survives must be the TAIL of the original stack.
    const seqs = parsed.undoStack.map((e) => e._seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)))
    if (seqs.length > 0) expect(seqs[seqs.length - 1]).toBe(39)
  })
})

describe('debounced durable writer', () => {
  it('coalesces rapid schedules into one save (latest wins)', async () => {
    vi.useFakeTimers()
    const ipc = new FakeIpc()
    const key = { projectId: 'p1', branchId: 'b1' }
    scheduleDurableUndoPersist(ipc, key, stacks({ undoStack: [legacyEntry(1)] }))
    scheduleDurableUndoPersist(ipc, key, stacks({ undoStack: [legacyEntry(1), legacyEntry(2)] }))
    await vi.advanceTimersByTimeAsync(UNDO_DB_DEBOUNCE_MS + 10)
    expect(ipc.saveCalls).toBe(1)
    const parsed = parseUndoStacksPayload(ipc.rows.get('p1::b1'))!
    expect(parsed.undoStack).toHaveLength(2)
  })

  it('flush writes the pending payload immediately', async () => {
    const ipc = new FakeIpc()
    scheduleDurableUndoPersist(ipc, { projectId: 'p1', branchId: null }, stacks())
    await flushDurableUndoPersist()
    expect(ipc.saveCalls).toBe(1)
    expect(ipc.rows.has('p1::NULL')).toBe(true)
  })

  it('a failed save never throws into the caller', async () => {
    const ipc = new FakeIpc()
    ipc.save = async () => {
      throw new Error('db down')
    }
    scheduleDurableUndoPersist(ipc, { projectId: 'p1', branchId: 'b1' }, stacks())
    await expect(flushDurableUndoPersist()).resolves.toBeUndefined()
  })
})

describe('per-branch keying (F11 safety)', () => {
  it('branch A and branch B stacks never mix; hydrate returns the right branch', async () => {
    const ipc = new FakeIpc()
    scheduleDurableUndoPersist(ipc, { projectId: 'p1', branchId: 'A' }, stacks({ undoStack: [legacyEntry(1)] }))
    await flushDurableUndoPersist()
    scheduleDurableUndoPersist(
      ipc,
      { projectId: 'p1', branchId: 'B' },
      stacks({ undoStack: [legacyEntry(1), legacyEntry(2)] }),
    )
    await flushDurableUndoPersist()

    const a = await hydrateUndoStacks(ipc, { projectId: 'p1', branchId: 'A' })
    const b = await hydrateUndoStacks(ipc, { projectId: 'p1', branchId: 'B' })
    expect(a?.undoStack).toHaveLength(1)
    expect(b?.undoStack).toHaveLength(2)
    // Unknown branch → no history.
    expect(await hydrateUndoStacks(ipc, { projectId: 'p1', branchId: 'C' })).toBeNull()
  })

  it('hydrate returns null on IPC failure (treated as no history)', async () => {
    const ipc = new FakeIpc()
    ipc.load = async () => {
      throw new Error('bridge down')
    }
    expect(await hydrateUndoStacks(ipc, { projectId: 'p1', branchId: null })).toBeNull()
  })
})
