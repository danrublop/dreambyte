import { describe, it, expect } from 'vitest'
import {
  resolveLegBody,
  CrossProjectLegAbort,
  FIELD_CLASS,
  type TargetProjectRow,
  type LoadTargetRow,
} from './resolve-leg-body'
import type { AgentAPIRequest } from './agent-runner'

// Minimal valid body. Fields not set default to undefined (the realistic shape
// — most AgentAPIRequest fields are optional).
function makeBody(overrides: Partial<AgentAPIRequest> = {}): AgentAPIRequest {
  return {
    message: 'do the thing',
    scenes: [{ id: 'a-scene' }] as AgentAPIRequest['scenes'],
    globalStyle: { presetId: null } as AgentAPIRequest['globalStyle'],
    projectName: 'Project A',
    outputMode: 'mp4',
    projectId: 'proj-A',
    branchId: 'branch-A',
    ...overrides,
  }
}

function makeRow(overrides: Partial<TargetProjectRow> = {}): TargetProjectRow {
  return {
    apiPermissions: { elevenLabs: 'deny' } as unknown as TargetProjectRow['apiPermissions'],
    audioProviderEnabled: { elevenLabs: false },
    mediaGenEnabled: { fal: true },
    globalStyle: { presetId: 'neon' } as TargetProjectRow['globalStyle'],
    projectName: 'Project B',
    outputMode: 'interactive',
    mp4Settings: { fps: 60 } as TargetProjectRow['mp4Settings'],
    sceneGraph: { nodes: [], edges: [], startSceneId: 'b-start' } as TargetProjectRow['sceneGraph'],
    scenes: [{ id: 'b-scene' }] as TargetProjectRow['scenes'],
    defaultBranchId: 'branch-B-default',
    ...overrides,
  }
}

const loaderFor =
  (row: TargetProjectRow | null): LoadTargetRow =>
  async () =>
    row

describe('resolveLegBody — identity (single-project)', () => {
  it('returns the SAME body reference when target === origin (byte-identical, no transform)', async () => {
    const body = makeBody()
    const leg = await resolveLegBody(body, 'proj-A', 'proj-A', loaderFor(makeRow()))
    expect(leg).toBe(body) // REGRESSION (IRON RULE): identical reference, zero overhead
  })

  it('returns the SAME body when targetProjectId is undefined', async () => {
    const body = makeBody()
    const leg = await resolveLegBody(body, undefined, 'proj-A')
    expect(leg).toBe(body)
  })

  it('does not call the loader on the identity path', async () => {
    let called = false
    const loader: LoadTargetRow = async () => {
      called = true
      return makeRow()
    }
    await resolveLegBody(makeBody(), 'proj-A', 'proj-A', loader)
    expect(called).toBe(false)
  })
})

// Independent ground-truth list of every AgentAPIRequest field. The tsc
// `Record<keyof AgentAPIRequest, FieldClass>` type is the real compile-time
// exhaustiveness gate; this list is a SECOND check so a rename/removal in the
// interface forces a deliberate update here too (a build-only gate can be
// silently loosened by widening the Record key type).
const EXPECTED_KEYS: (keyof typeof FIELD_CLASS)[] = [
  'projectId',
  'scenes',
  'globalStyle',
  'projectName',
  'outputMode',
  'sceneGraph',
  'timeline',
  'mp4Settings',
  'apiPermissions',
  'audioProviderEnabled',
  'audioSettings',
  'mediaGenEnabled',
  'branchId',
  'enabledModelIds',
  'modelConfigs',
  'ytDlpConsentedProjectIds',
  'mediaUnderstandingEngines',
  'modelOverride',
  'modelTier',
  'researchModelId',
  'thinkingMode',
  'activeTools',
  'directorTemplate',
  'planFirstMode',
  'localMode',
  'mockMode',
  'previewMode',
  'sandboxMode',
  'permissionPosture',
  'disableFanout',
  'runBudgetUsd',
  'message',
  'referenceMedia',
  'history',
  'conversationId',
  'selectedSceneId',
  'sceneContext',
  'sessionPermissions',
  'subAgents',
  'generationOverrides',
  'autoChooseDefaults',
  'webSearchEnabled',
  'aiQualityReview',
  'webFetchEnabled',
  'autoAcceptWebSearch',
  'researchProviderEnabled',
  'initialScenePlan',
  'resumeToolCall',
  'resumeCheckpoint',
  'resumeSpentUsd',
  'editorState',
  'userId',
]

describe('FIELD_CLASS exhaustiveness', () => {
  it('classifies every field with no undefined entries', () => {
    for (const v of Object.values(FIELD_CLASS)) {
      expect(['load-from-target', 'user-global', 'producer-supplied', 'drop']).toContain(v)
    }
  })

  it('covers exactly the expected key set (catches a rename/removal at test time too)', () => {
    expect(Object.keys(FIELD_CLASS).sort()).toEqual([...EXPECTED_KEYS].sort())
  })

  it('keeps the known leak-prone fields as drop', () => {
    expect(FIELD_CLASS.sessionPermissions).toBe('drop')
    expect(FIELD_CLASS.history).toBe('drop')
    expect(FIELD_CLASS.referenceMedia).toBe('drop')
    expect(FIELD_CLASS.editorState).toBe('drop')
    expect(FIELD_CLASS.generationOverrides).toBe('drop')
  })
})

describe('resolveLegBody — cross-project isolation', () => {
  it('produces a leg whose keys are all non-drop (no DROP field leaks)', async () => {
    const body = makeBody({
      sessionPermissions: { elevenLabs: 'allow' },
      history: [{ role: 'user', content: 'secret A context' }] as AgentAPIRequest['history'],
      referenceMedia: [{ kind: 'image' }] as AgentAPIRequest['referenceMedia'],
      generationOverrides: { fal: { provider: 'fal' } },
    })
    const leg = await resolveLegBody(body, 'proj-B', 'proj-A', loaderFor(makeRow()))
    for (const key of Object.keys(leg) as (keyof AgentAPIRequest)[]) {
      expect(FIELD_CLASS[key], `field ${key} must not be a drop field`).not.toBe('drop')
    }
  })

  it("uses B's apiPermissions/providers, NOT A's", async () => {
    const body = makeBody({
      apiPermissions: { elevenLabs: 'allow' } as unknown as AgentAPIRequest['apiPermissions'],
      audioProviderEnabled: { elevenLabs: true },
    })
    const leg = await resolveLegBody(body, 'proj-B', 'proj-A', loaderFor(makeRow()))
    expect(leg.apiPermissions).toEqual({ elevenLabs: 'deny' }) // B's value
    expect(leg.audioProviderEnabled).toEqual({ elevenLabs: false })
  })

  it("preserves B's empty {} apiPermissions (real allow-all, not over-denied)", async () => {
    const leg = await resolveLegBody(
      makeBody(),
      'proj-B',
      'proj-A',
      loaderFor(makeRow({ apiPermissions: {} as TargetProjectRow['apiPermissions'] })),
    )
    expect(leg.apiPermissions).toEqual({})
  })

  it('throws CrossProjectLegAbort when the target row is missing (no body fallback)', async () => {
    await expect(resolveLegBody(makeBody(), 'proj-B', 'proj-A', loaderFor(null))).rejects.toBeInstanceOf(
      CrossProjectLegAbort,
    )
  })

  it('throws CrossProjectLegAbort when the loader throws (no error-swallow)', async () => {
    const loader: LoadTargetRow = async () => {
      throw new Error('db down')
    }
    await expect(resolveLegBody(makeBody(), 'proj-B', 'proj-A', loader)).rejects.toBeInstanceOf(CrossProjectLegAbort)
  })

  it('throws CrossProjectLegAbort when no loader is provided for a cross-project leg', async () => {
    await expect(resolveLegBody(makeBody(), 'proj-B', 'proj-A')).rejects.toBeInstanceOf(CrossProjectLegAbort)
  })

  it("sets branchId to B's default branch, never A's", async () => {
    const leg = await resolveLegBody(makeBody({ branchId: 'branch-A' }), 'proj-B', 'proj-A', loaderFor(makeRow()))
    expect(leg.branchId).toBe('branch-B-default')
    expect(leg.branchId).not.toBe('branch-A')
  })

  it("drops A's sessionPermissions (no always_ask gate bypass in B)", async () => {
    const leg = await resolveLegBody(
      makeBody({ sessionPermissions: { elevenLabs: 'allow' } }),
      'proj-B',
      'proj-A',
      loaderFor(makeRow()),
    )
    expect(leg.sessionPermissions).toBeUndefined()
  })

  it("drops A's history / referenceMedia / editorState (no A-context leak)", async () => {
    const leg = await resolveLegBody(
      makeBody({
        history: [{ role: 'user', content: 'A context' }] as AgentAPIRequest['history'],
        referenceMedia: [{ kind: 'image' }] as AgentAPIRequest['referenceMedia'],
        editorState: { foo: 1 } as unknown as AgentAPIRequest['editorState'],
      }),
      'proj-B',
      'proj-A',
      loaderFor(makeRow()),
    )
    expect(leg.history).toBeUndefined()
    expect(leg.referenceMedia).toBeUndefined()
    expect(leg.editorState).toBeUndefined()
  })

  it("loads B's globalStyle / mp4Settings / outputMode / sceneGraph (correct render for B)", async () => {
    const leg = await resolveLegBody(makeBody(), 'proj-B', 'proj-A', loaderFor(makeRow()))
    expect(leg.globalStyle).toEqual({ presetId: 'neon' })
    expect(leg.mp4Settings).toEqual({ fps: 60 })
    expect(leg.outputMode).toBe('interactive')
    expect(leg.sceneGraph).toEqual({ nodes: [], edges: [], startSceneId: 'b-start' })
    expect(leg.projectName).toBe('Project B')
    expect(leg.projectId).toBe('proj-B')
    expect(leg.scenes).toEqual([{ id: 'b-scene' }]) // B's own branch-scoped scenes, not A's, not []
  })

  it('preserves USER_GLOBAL fields (B keeps legit model access)', async () => {
    const body = makeBody({
      enabledModelIds: ['claude-opus-4-7'],
      modelConfigs: [{ id: 'claude-opus-4-7', enabled: true }] as AgentAPIRequest['modelConfigs'],
      ytDlpConsentedProjectIds: ['proj-B'],
    })
    const leg = await resolveLegBody(body, 'proj-B', 'proj-A', loaderFor(makeRow()))
    expect(leg.enabledModelIds).toEqual(['claude-opus-4-7'])
    expect(leg.modelConfigs).toEqual([{ id: 'claude-opus-4-7', enabled: true }])
    expect(leg.ytDlpConsentedProjectIds).toEqual(['proj-B'])
  })

  it('shallow-clones USER_GLOBAL arrays/objects so legs do not alias the source body', async () => {
    const body = makeBody({
      enabledModelIds: ['m1'],
      modelConfigs: [{ id: 'm1', enabled: true }] as AgentAPIRequest['modelConfigs'],
    })
    const leg = await resolveLegBody(body, 'proj-B', 'proj-A', loaderFor(makeRow()))
    expect(leg.enabledModelIds).not.toBe(body.enabledModelIds) // different reference
    expect(leg.modelConfigs).not.toBe(body.modelConfigs)
    ;(leg.enabledModelIds as string[]).push('mutated')
    expect(body.enabledModelIds).toEqual(['m1']) // source body untouched
  })

  it('fails closed when the target row has malformed (null) apiPermissions', async () => {
    const row = makeRow({ apiPermissions: null as unknown as TargetProjectRow['apiPermissions'] })
    await expect(resolveLegBody(makeBody(), 'proj-B', 'proj-A', loaderFor(row))).rejects.toBeInstanceOf(
      CrossProjectLegAbort,
    )
  })

  it('rejects caller misuse: body.projectId must equal originProjectId (no pre-repointed body)', async () => {
    // Producer wrongly pre-repointed body.projectId to the target before calling.
    const preRepointed = makeBody({ projectId: 'proj-B' })
    await expect(resolveLegBody(preRepointed, 'proj-B', 'proj-A', loaderFor(makeRow()))).rejects.toThrow(
      /must equal originProjectId/,
    )
  })

  it('rejects a pre-repointed body even when originProjectId is omitted (closes the identity bypass)', async () => {
    // body.projectId set to the target, origin omitted → must NOT fall through to
    // identity and run A's body under B; the invariant fires.
    const preRepointed = makeBody({ projectId: 'proj-B' })
    await expect(resolveLegBody(preRepointed, 'proj-B', undefined, loaderFor(makeRow()))).rejects.toThrow(
      /must equal originProjectId/,
    )
  })

  it('fails closed when a cross-project leg would have no message', async () => {
    const body = makeBody({ message: undefined as unknown as AgentAPIRequest['message'] })
    await expect(resolveLegBody(body, 'proj-B', 'proj-A', loaderFor(makeRow()))).rejects.toBeInstanceOf(
      CrossProjectLegAbort,
    )
  })
})
