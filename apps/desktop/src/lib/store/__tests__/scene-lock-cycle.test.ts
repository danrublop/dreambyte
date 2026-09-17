import { describe, it, expect, vi } from 'vitest'
import { createActionDispatch } from '../action-dispatch'
import { createSceneActions } from '../scene-actions'
import { createDefaultScene, createDefaultProject } from '../helpers'

// Full-cycle integration of the cursor-model scene lock through the REAL store dispatch path:
// acquisition (dispatchAction → acquireSceneLock) + enforcement (executor guard) + release.
// Each piece is unit-tested elsewhere; this proves they compose. armIdleTimer is a no-op in
// node (no window), so an acquired lock never auto-releases here — staleness is deterministic.

function makeStore() {
  const sceneA = createDefaultScene()
  sceneA.id = 'scene-A'
  sceneA.name = 'A'
  const project = createDefaultProject([sceneA])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any = {
    scenes: [sceneA],
    globalStyle: { presetId: null, palette: ['#000', '#111', '#222', '#333'], duration: 8, theme: 'light' },
    project,
    selectedSceneId: 'scene-A',
    uiEditingLayerId: null,
    _actionUndoStack: [],
    _actionRedoStack: [],
    _redoStack: [],
    currentAgentRunId: null,
    projectActiveBranchId: null,
    scheduleSaveProjectToDb: vi.fn(),
    saveSceneHTML: vi.fn(),
    _pushUndoDebounced: vi.fn(),
    showTransientStatus: vi.fn(),
  }
  const get = () => state
  const set = vi.fn((arg: unknown) => {
    const next = typeof arg === 'function' ? (arg as (s: typeof state) => Partial<typeof state>)(state) : arg
    state = { ...state, ...(next as Partial<typeof state>) }
  })
  state = {
    ...state,
    ...createActionDispatch(set as never, get as never),
    ...createSceneActions(set as never, get as never),
  }
  // Return the GETTER, not the snapshot: `set` reassigns `state` to a fresh object, so reads
  // must go through get() to see the post-dispatch lock.
  return get
}

const sceneA = (get: ReturnType<typeof makeStore>) => get().scenes.find((s: { id: string }) => s.id === 'scene-A')
const editAs = (get: ReturnType<typeof makeStore>, source: 'user' | 'agent', name: string) =>
  get().dispatchAction({ type: 'scene/update', params: { sceneId: 'scene-A', patch: { name } } }, { source })

describe('scene-lock cursor model — full cycle through the store', () => {
  it('user edit → agent blocked → release → agent edits', () => {
    const get = makeStore()

    // 1. A user edit lands AND acquires a 'user' lock on the scene.
    const r1 = editAs(get, 'user', 'A (user)')
    expect(r1.success).toBe(true)
    expect(sceneA(get)?.lock?.owner).toBe('user')

    // 2. While the user holds it, an agent edit on the same scene is rejected.
    const r2 = editAs(get, 'agent', 'A (agent)')
    expect(r2.success).toBe(false)
    expect(r2.error?.code).toBe('SCENE_LOCKED')
    expect(sceneA(get)?.name).toBe('A (user)') // unchanged

    // 3. The lock releases (idle/takeover) → the agent can now edit, and takes the lock.
    get().releaseSceneLock('scene-A')
    const r3 = editAs(get, 'agent', 'A (agent)')
    expect(r3.success).toBe(true)
    expect(sceneA(get)?.name).toBe('A (agent)')
    expect(sceneA(get)?.lock?.owner).toBe('agent')

    // 4. Symmetric: now a user edit is blocked while the agent holds it.
    const r4 = editAs(get, 'user', 'A (user again)')
    expect(r4.success).toBe(false)
    expect(r4.error?.code).toBe('SCENE_LOCKED')
  })
})
