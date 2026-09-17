// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, expect, it, beforeEach } from 'vitest'
import { cleanScenesForAgentPersistence, reserveRunSlot, releaseRunSlot } from './agent-runner'

describe('cleanScenesForAgentPersistence', () => {
  it('restores original scene content when updated scenes contain light-scene placeholders', () => {
    const cleaned = cleanScenesForAgentPersistence(
      [
        {
          id: 'scene-1',
          svgContent: '[123 chars]',
          canvasCode: '[456 chars]',
          sceneCode: '[789 chars]',
          lottieSource: '[12 chars]',
          sceneHTML: '<html>fresh</html>',
        },
      ],
      [
        {
          id: 'scene-1',
          svgContent: '<svg>real</svg>',
          canvasCode: 'drawRealCanvas()',
          sceneCode: 'realSceneCode()',
          lottieSource: '{"real":true}',
          sceneHTML: '<html>old</html>',
        },
      ],
    )

    expect(cleaned[0]).toMatchObject({
      svgContent: '<svg>real</svg>',
      canvasCode: 'drawRealCanvas()',
      sceneCode: 'realSceneCode()',
      lottieSource: '{"real":true}',
      sceneHTML: '<html>fresh</html>',
    })
  })

  it('keeps real updated content instead of reverting non-placeholder fields', () => {
    const cleaned = cleanScenesForAgentPersistence(
      [{ id: 'scene-1', reactCode: 'export default function Scene() {}', sceneCode: 'newCode()' }],
      [{ id: 'scene-1', sceneCode: 'oldCode()' }],
    )

    expect(cleaned[0]).toMatchObject({ sceneCode: 'newCode()' })
  })

  it('restores reactCode when it is a light-scene placeholder', () => {
    const cleaned = cleanScenesForAgentPersistence(
      [{ id: 'scene-1', reactCode: '[456 chars]', sceneHTML: '<html>fresh</html>' }],
      [{ id: 'scene-1', reactCode: 'export default function Scene() { return <div>real</div> }' }],
    )

    expect(cleaned[0]).toMatchObject({
      reactCode: 'export default function Scene() { return <div>real</div> }',
      sceneHTML: '<html>fresh</html>',
    })
  })
})

describe('reserveRunSlot / releaseRunSlot — per-branch lock (v0.3.8)', () => {
  // Use unique project ids per test so the in-memory Map state from prior
  // tests doesn't bleed (no reset hook is exported by design — keeps the
  // contract simple).
  let testId = 0
  beforeEach(() => {
    testId++
  })
  function pid() {
    return `test-project-${testId}`
  }

  it('rejects a second reservation on the same project+branch', () => {
    const first = reserveRunSlot(pid(), 'branch-A')
    expect(first.ok).toBe(true)
    const second = reserveRunSlot(pid(), 'branch-A')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('IN_PROGRESS')
    releaseRunSlot(pid(), 'branch-A')
  })

  it('ALLOWS concurrent reservations on different branches of the same project', () => {
    // The whole point of v0.3.8: multiple variants on different branches
    // can run in parallel.
    const a = reserveRunSlot(pid(), 'branch-A')
    const b = reserveRunSlot(pid(), 'branch-B')
    const c = reserveRunSlot(pid(), 'branch-C')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(c.ok).toBe(true)
    releaseRunSlot(pid(), 'branch-A')
    releaseRunSlot(pid(), 'branch-B')
    releaseRunSlot(pid(), 'branch-C')
  })

  it('releases the right branch slot without affecting siblings', () => {
    reserveRunSlot(pid(), 'branch-A')
    reserveRunSlot(pid(), 'branch-B')
    releaseRunSlot(pid(), 'branch-A')
    // branch-A free, branch-B still held
    expect(reserveRunSlot(pid(), 'branch-A').ok).toBe(true)
    expect(reserveRunSlot(pid(), 'branch-B').ok).toBe(false)
    releaseRunSlot(pid(), 'branch-A')
    releaseRunSlot(pid(), 'branch-B')
  })

  it('back-compat: missing branchId uses a project-level default slot', () => {
    expect(reserveRunSlot(pid()).ok).toBe(true)
    expect(reserveRunSlot(pid()).ok).toBe(false) // same default key — blocked
    releaseRunSlot(pid())
    expect(reserveRunSlot(pid()).ok).toBe(true)
    releaseRunSlot(pid())
  })

  it('treats undefined and null branchId as the same default slot', () => {
    expect(reserveRunSlot(pid(), undefined).ok).toBe(true)
    expect(reserveRunSlot(pid(), null).ok).toBe(false) // collides with the undefined reservation
    releaseRunSlot(pid())
  })

  it('a default-slot reservation does NOT block a named-branch reservation (different keys)', () => {
    // Edge case the back-compat fallback creates: a v0.3.7-style call
    // (no branchId) reserves the default slot, but a v0.3.8 call with
    // an explicit branchId targets a different key. They coexist.
    expect(reserveRunSlot(pid()).ok).toBe(true)
    expect(reserveRunSlot(pid(), 'main').ok).toBe(true)
    releaseRunSlot(pid())
    releaseRunSlot(pid(), 'main')
  })

  it('returns ok:true when projectId is undefined (no lock acquired)', () => {
    expect(reserveRunSlot(undefined).ok).toBe(true)
    expect(reserveRunSlot(undefined, 'branch-A').ok).toBe(true)
    // No-op release also fine.
    releaseRunSlot(undefined)
    releaseRunSlot(undefined, 'branch-A')
  })

  // F87: a LIVE signal holds the slot (never stolen on the wall-clock TTL while
  // the run is alive). Abort alone does NOT free it — the run still unwinds and
  // flushes; freeing instantly would let a concurrent same-branch run interleave
  // the action_log. releaseRunSlot (transport .finally) is the real free path.
  it('live signal holds the slot; release frees it, not the abort', () => {
    const ctrl = new AbortController()
    expect(reserveRunSlot(pid(), 'branch-A', ctrl.signal).ok).toBe(true)
    // Still live → a second request is rejected regardless of elapsed time.
    expect(reserveRunSlot(pid(), 'branch-A', new AbortController().signal).ok).toBe(false)
    // Aborted but not yet released → still held (within the TTL), so a
    // mid-unwind concurrent run can't start.
    ctrl.abort()
    expect(reserveRunSlot(pid(), 'branch-A', new AbortController().signal).ok).toBe(false)
    // The transport's .finally() releases the slot once the run finishes.
    releaseRunSlot(pid(), 'branch-A')
    expect(reserveRunSlot(pid(), 'branch-A', new AbortController().signal).ok).toBe(true)
    releaseRunSlot(pid(), 'branch-A')
  })
})
