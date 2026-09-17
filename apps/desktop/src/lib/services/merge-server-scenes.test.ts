import { describe, it, expect } from 'vitest'
import { filterScenesToBranch, mergeBranchScopedScenes } from './merge-server-scenes'

describe('filterScenesToBranch', () => {
  const scenes = [
    { id: 'a', branchId: 'main' },
    { id: 'b', branchId: 'feature' },
    { id: 'c', branchId: null },
  ]

  it('does NOT filter when there is no branch context (legacy single-branch)', () => {
    expect(filterScenesToBranch(scenes, null, null)).toEqual(scenes)
  })

  it('keeps only the effective branch, dropping other branches', () => {
    expect(filterScenesToBranch(scenes, 'feature', 'main')).toEqual([{ id: 'b', branchId: 'feature' }])
  })

  it('treats a null-branchId scene as the DEFAULT branch (kept when effective is default)', () => {
    expect(filterScenesToBranch(scenes, 'main', 'main')).toEqual([
      { id: 'a', branchId: 'main' },
      { id: 'c', branchId: null }, // unstamped (pre-0002-backfill) → default
    ])
  })

  it('does NOT leak a null-branchId scene into a NON-default branch run', () => {
    expect(filterScenesToBranch(scenes, 'feature', 'main')).toEqual([{ id: 'b', branchId: 'feature' }])
  })
})

describe('mergeBranchScopedScenes', () => {
  it('never appends another branch’s scenes into a single-branch run', () => {
    const client = [{ id: 'a', branchId: 'main', sceneCode: 'client-a' }]
    const server = [
      { id: 'a', branchId: 'main', sceneCode: 'server-a' },
      { id: 'x', branchId: 'feature', sceneCode: 'server-x' }, // other branch — must NOT appear
    ]
    const out = mergeBranchScopedScenes(client, server, { branchId: 'main', defaultBranchId: 'main' })
    expect(out.map((s) => s.id)).toEqual(['a']) // 'x' (feature) excluded
  })

  it('fills empty client code fields from the same-branch server scene (client value wins)', () => {
    const client = [{ id: 'a', branchId: 'main', sceneCode: '', canvasCode: 'client-canvas' }]
    const server = [{ id: 'a', branchId: 'main', sceneCode: 'server-scene', canvasCode: 'server-canvas' }]
    const out = mergeBranchScopedScenes(client, server, { branchId: 'main', defaultBranchId: 'main' })
    expect(out[0].sceneCode).toBe('server-scene') // empty client → server fills
    expect(out[0].canvasCode).toBe('client-canvas') // present client wins
  })

  it('appends a same-branch server scene the client body dropped', () => {
    const client = [{ id: 'a', branchId: 'main' }]
    const server = [
      { id: 'a', branchId: 'main' },
      { id: 'b', branchId: 'main', sceneCode: 'server-b' }, // client didn't send it
    ]
    const out = mergeBranchScopedScenes(client, server, { branchId: 'main', defaultBranchId: 'main' })
    expect(out.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('falls back to merging ALL server scenes when there is no branch context (no regression)', () => {
    const client = [{ id: 'a' }]
    const server = [
      { id: 'a', branchId: null },
      { id: 'b', branchId: null },
    ]
    const out = mergeBranchScopedScenes(client, server, { branchId: null, defaultBranchId: null })
    expect(out.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('resolves the effective branch from defaultBranchId when the body carried no branchId', () => {
    const client = [{ id: 'a' }]
    const server = [
      { id: 'a', branchId: 'main' },
      { id: 'x', branchId: 'feature' },
    ]
    const out = mergeBranchScopedScenes(client, server, { branchId: null, defaultBranchId: 'main' })
    expect(out.map((s) => s.id)).toEqual(['a']) // scoped to default 'main', 'feature' excluded
  })

  it('code-fills a client scene from its same-id server row even when that row is on a DIFFERENT branch than the run', () => {
    // Variant runs legitimately carry source-branch client scenes (code stripped)
    // against a variant branchId. The matching server row lives on the SOURCE
    // branch; fill must still recover its code. Ids are globally unique (clones
    // get fresh ids), so this is not a cross-branch leak — and scoping the fill
    // would wrongly blank these scenes.
    const client = [{ id: 's1', branchId: 'source', sceneCode: '' }]
    const server = [
      { id: 's1', branchId: 'source', sceneCode: 'real-source-code' },
      { id: 'v1', branchId: 'variant', sceneCode: 'variant-code' },
    ]
    const out = mergeBranchScopedScenes(client, server, { branchId: 'variant', defaultBranchId: 'main' })
    expect(out.find((s) => s.id === 's1')?.sceneCode).toBe('real-source-code') // filled, not blanked
    expect(out.map((s) => s.id)).toEqual(['s1', 'v1']) // only the effective (variant) branch is appended
  })

  it('A0/T1: a placeholder client code value loses to the server’s real code (not treated as truthy)', () => {
    // The renderer strips non-selected scenes' code to `[<n> chars]`. That
    // placeholder must NOT defeat the server's real code in the code-fill.
    const client = [{ id: 'a', branchId: 'main', sceneCode: '[8243 chars]', reactCode: '[120 chars]' }]
    const server = [{ id: 'a', branchId: 'main', sceneCode: 'server-real-code', reactCode: 'server-react' }]
    const out = mergeBranchScopedScenes(client, server, { branchId: 'main', defaultBranchId: 'main' })
    // Note: reactCode is NOT in CODE_FIELDS (the renderer never strips it), so
    // it is carried opaquely from the client — only the stripped fields are filled.
    expect(out[0].sceneCode).toBe('server-real-code')
  })

  it('A0/T1 name-collision: real client code containing "[12 chars]" still wins (not mistaken for a placeholder)', () => {
    const client = [{ id: 'a', branchId: 'main', sceneCode: 'const n = "[12 chars]"' }]
    const server = [{ id: 'a', branchId: 'main', sceneCode: 'server-real-code' }]
    const out = mergeBranchScopedScenes(client, server, { branchId: 'main', defaultBranchId: 'main' })
    expect(out[0].sceneCode).toBe('const n = "[12 chars]"') // real client wins
  })

  it('does NOT append a null-branch server scene into a NON-default run (end-to-end, not just the filter)', () => {
    // A null-branch row is treated as the default branch; a non-default run must
    // never inherit it via the append. End-to-end assertion through the merge.
    const client = [{ id: 'a', branchId: 'feature' }]
    const server = [
      { id: 'a', branchId: 'feature' },
      { id: 'orphan', branchId: null }, // unstamped → default; must NOT land in a feature run
    ]
    const out = mergeBranchScopedScenes(client, server, { branchId: 'feature', defaultBranchId: 'main' })
    expect(out.map((s) => s.id)).toEqual(['a']) // 'orphan' (null→default) excluded
  })

  it('returns the client scenes unchanged when no server scene matches the branch', () => {
    const client = [{ id: 'a', branchId: 'feature' }]
    const server = [{ id: 'z', branchId: 'main' }]
    const out = mergeBranchScopedScenes(client, server, { branchId: 'feature', defaultBranchId: 'main' })
    expect(out).toEqual(client)
  })

  it('empty client (variant run) → populates ONLY the run branch’s own scenes, never the source branch’s', () => {
    // A variant run sends scenes:[] (the fix for #16). The variant branch is a
    // clone of the source with FRESH ids; the merge must hand the run only the
    // variant branch's own clones, NOT the source-branch rows (whose ids would
    // get stolen onto the variant branch on persist).
    const out = mergeBranchScopedScenes(
      [],
      [
        { id: 's1', branchId: 'source' }, // source-branch row — must NOT appear
        { id: 'v1', branchId: 'variant' }, // the variant's own clone
      ],
      { branchId: 'variant', defaultBranchId: 'source' },
    )
    expect(out.map((s) => s.id)).toEqual(['v1'])
  })
})
