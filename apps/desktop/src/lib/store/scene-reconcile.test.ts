// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { buildSceneBaseline, hashScene, reconcileScenesForRetry } from './scene-reconcile'

type S = { id: string; code: string }
const s = (id: string, code: string): S => ({ id, code })

describe('reconcileScenesForRetry — the 3-way merge rules', () => {
  it('local dirty edit WINS its slot; untouched scenes take the remote (agent) version', () => {
    const saved = [s('a', 'A0'), s('b', 'B0')]
    const baseline = buildSceneBaseline(saved)
    const local = [s('a', 'A-user-edit'), s('b', 'B0')] // user edited a, left b alone
    const remote = [s('a', 'A0'), s('b', 'B-agent-edit')] // agent edited b
    const { merged, keptLocalIds } = reconcileScenesForRetry(local, remote, baseline)
    expect(merged).toEqual([s('a', 'A-user-edit'), s('b', 'B-agent-edit')]) // BOTH sides kept
    expect(keptLocalIds).toEqual(['a'])
  })

  it('both edited the SAME scene → local (the edit that triggered this save) wins', () => {
    const baseline = buildSceneBaseline([s('a', 'A0')])
    const { merged } = reconcileScenesForRetry([s('a', 'A-user')], [s('a', 'A-agent')], baseline)
    expect(merged).toEqual([s('a', 'A-user')])
  })

  it('remote-added scenes are kept; locally-added scenes are kept at their local index', () => {
    const baseline = buildSceneBaseline([s('a', 'A0')])
    const local = [s('new-local', 'L'), s('a', 'A0')]
    const remote = [s('a', 'A0'), s('new-remote', 'R')]
    const { merged } = reconcileScenesForRetry(local, remote, baseline)
    expect(merged.map((x) => x.id)).toEqual(['new-local', 'a', 'new-remote'])
  })

  it('user delete of an agent-untouched scene is honored; agent-retouched deletes resurrect', () => {
    const saved = [s('del-clean', 'D0'), s('del-retouched', 'E0'), s('a', 'A0')]
    const baseline = buildSceneBaseline(saved)
    const local = [s('a', 'A0')] // user deleted both
    const remote = [s('del-clean', 'D0'), s('del-retouched', 'E-agent'), s('a', 'A0')]
    const { merged, droppedIds } = reconcileScenesForRetry(local, remote, baseline)
    expect(merged.map((x) => x.id)).toEqual(['del-retouched', 'a']) // clean delete honored
    expect(merged[0].code).toBe('E-agent') // agent's newer content survives the stale delete
    expect(droppedIds).toEqual(['del-clean'])
  })

  it('remote delete of a DIRTY local scene keeps the local (unsaved work beats a concurrent delete)', () => {
    const baseline = buildSceneBaseline([s('x', 'X0'), s('a', 'A0')])
    const local = [s('x', 'X-user-edit'), s('a', 'A0')]
    const remote = [s('a', 'A0')] // agent deleted x
    const { merged, keptLocalIds } = reconcileScenesForRetry(local, remote, baseline)
    expect(merged.map((x) => x.id)).toEqual(['x', 'a'])
    expect(keptLocalIds).toEqual(['x'])
  })

  it('remote delete of a CLEAN local scene is honored', () => {
    const baseline = buildSceneBaseline([s('x', 'X0'), s('a', 'A0')])
    const local = [s('x', 'X0'), s('a', 'A0')]
    const remote = [s('a', 'A0')]
    const { merged } = reconcileScenesForRetry(local, remote, baseline)
    expect(merged.map((x) => x.id)).toEqual(['a'])
  })

  it('remote order is the base ordering for shared scenes (newest persisted ordering wins)', () => {
    const saved = [s('a', 'A0'), s('b', 'B0'), s('c', 'C0')]
    const baseline = buildSceneBaseline(saved)
    const local = [s('a', 'A0'), s('b', 'B-user'), s('c', 'C0')]
    const remote = [s('c', 'C0'), s('a', 'A0'), s('b', 'B0')] // agent reordered
    const { merged } = reconcileScenesForRetry(local, remote, baseline)
    expect(merged.map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(merged[2].code).toBe('B-user') // dirty overlay rides in remote's slot
  })

  it('no baseline entry (scene added since last save) counts as dirty', () => {
    const baseline = buildSceneBaseline([])
    const { merged } = reconcileScenesForRetry([s('a', 'A-local')], [s('a', 'A-remote')], baseline)
    expect(merged).toEqual([s('a', 'A-local')])
  })

  it('hashScene is stable and content-sensitive', () => {
    expect(hashScene(s('a', 'X'))).toBe(hashScene(s('a', 'X')))
    expect(hashScene(s('a', 'X'))).not.toBe(hashScene(s('a', 'Y')))
  })
})

describe('review #156 hardening', () => {
  it('multiple local-only scenes insert deterministically at their clamped local indices', () => {
    const baseline = buildSceneBaseline([s('a', 'A0')])
    const local = [s('L1', 'x'), s('a', 'A0'), s('L2', 'y')]
    const remote = [s('a', 'A0')]
    const r1 = reconcileScenesForRetry(local, remote, baseline)
    expect(r1.merged.map((x) => x.id)).toEqual(['L1', 'a', 'L2'])
    // Out-of-range local indices clamp-append in original relative order.
    const farLocal = [s('a', 'A0'), s('L1', 'x'), s('L2', 'y')]
    const r2 = reconcileScenesForRetry(farLocal, [s('a', 'A0')], baseline)
    expect(r2.merged.map((x) => x.id)).toEqual(['a', 'L1', 'L2'])
  })

  it('hashScene is stable across a JSON round-trip (the DB sceneBlob lineage)', () => {
    // The delete-honor rule compares a DB-round-tripped remote scene against a
    // renderer-built baseline — JSON round-tripping must not change the hash.
    const scene = { id: 'x', name: 'n', reactCode: 'code', nested: { a: 1, b: [1, 2, 3] } }
    expect(hashScene(JSON.parse(JSON.stringify(scene)))).toBe(hashScene(scene))
  })

  it('length-changing edits can never hash-collide (length is folded into the hash)', () => {
    const a = hashScene(s('a', 'short'))
    const b = hashScene(s('a', 'a-much-longer-piece-of-code'))
    expect(a).not.toBe(b)
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]) // the length component differs
  })
})
