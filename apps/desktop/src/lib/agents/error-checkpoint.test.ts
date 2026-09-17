// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

/**
 * A2 (v6 T2) — the runner's ERROR checkpoint snapshots the LIVE world.
 *
 * Before T2 the error checkpoint:
 *   - gated on `opts.initialScenePlan` (empty on a first build → a first-build
 *     error saved NOTHING), and
 *   - snapshotted `opts.scenes` — a deep clone the tools never mutate — so its
 *     "scenes preserved" count was the PRE-RUN set, and `completedSceneIds`
 *     mapped EVERY pre-existing scene as "built".
 *
 * After T2 it gates on `world.scenePlan ?? opts.initialScenePlan`, snapshots
 * `world.scenes`, and takes `completedSceneIds` from `runProgress.scenesCreated`
 * (what was actually built THIS run).
 *
 * Mechanism: the model creates Scene 1, then the next provider turn throws (the
 * mock client's queue is empty → `stream()` raises). The adapter path wraps the
 * thrown error and, because the failing turn produced no content, takes ONE
 * runner-level empty-turn retry (EMPTY_TURN_RETRY_DELAY_MS = 20s) before going
 * terminal — hence the generous per-test timeout below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../db', async () => {
  const actual = await vi.importActual<typeof import('../db')>('../db')
  return { ...actual, logSpend: vi.fn(async () => undefined), logAgentUsage: vi.fn(async () => undefined) }
})

vi.mock('../db/queries/branch-proposals', () => ({
  persistRunCheckpoint: vi.fn().mockResolvedValue(undefined),
  getRunCheckpoint: vi.fn().mockResolvedValue(null),
  clearRunCheckpoint: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../db/queries/action-log', () => ({ appendActionRow: vi.fn(async () => undefined) }))
vi.mock('../logger', () => {
  const noop = () => {}
  const stub = { debug: noop, log: noop, info: noop, warn: noop, error: noop }
  return { createLogger: () => stub }
})
vi.mock('./logger', async () => {
  const actual = await vi.importActual<typeof import('./logger')>('./logger')
  class SilentLogger {
    runId = 'test-run'
    log() {}
    warn() {}
    error() {}
    debug() {}
    startPhase() {}
    endPhase() {
      return 0
    }
    getEvents() {
      return []
    }
    getTrace() {
      return []
    }
    summary() {
      return ''
    }
  }
  return { ...actual, AgentLogger: SilentLogger }
})

import { runAgent } from './runner'
import {
  __setProviderClientsForTesting as __setProvidersStoreForTesting,
  resetProviderClients as resetProvidersStore,
} from './providers'
import { MockAnthropicClient } from './mock-anthropic'
import {
  messageStart,
  toolUseBlockStart,
  toolUseInputDelta,
  blockStop,
  messageDelta,
  messageStop,
  finalToolUseMessage,
} from './runner.fixtures'
import { persistRunCheckpoint } from '../db/queries/branch-proposals'
import type { RunCheckpoint, ScenePlan, SSEEvent } from './types'
import type { GlobalStyle } from '../types'

const mockedPersist = persistRunCheckpoint as ReturnType<typeof vi.fn>

function makeGlobalStyle(): GlobalStyle {
  return {
    presetId: null,
    paletteOverride: null,
    bgColorOverride: null,
    fontOverride: null,
    bodyFontOverride: null,
    strokeColorOverride: null,
  }
}

const SCENE_PLAN: ScenePlan = {
  title: 'Two-scene build',
  scenes: [
    { name: 'Scene 1', purpose: 'Opening', sceneType: 'react', duration: 8 },
    { name: 'Scene 2', purpose: 'Closing', sceneType: 'react', duration: 8 },
  ],
  totalDuration: 16,
}

function createSceneTurn(n: number) {
  const input = JSON.stringify({ name: `Scene ${n}`, prompt: `Scene ${n} content`, duration: 8 })
  return {
    events: [
      messageStart({ id: `msg_cs_${n}` }),
      toolUseBlockStart({ id: `toolu_cs_${n}`, name: 'create_scene', index: 0 }),
      toolUseInputDelta(input, 0),
      blockStop(0),
      messageDelta({ stopReason: 'tool_use' }),
      messageStop(),
    ],
    finalMessage: finalToolUseMessage({
      id: `msg_cs_${n}`,
      toolUses: [{ id: `toolu_cs_${n}`, name: 'create_scene', input: JSON.parse(input) }],
    }),
  }
}

beforeEach(() => mockedPersist.mockClear())
afterEach(() => resetProvidersStore())

describe('A2 (T2) — error checkpoint snapshots the live world', () => {
  async function runUntilError() {
    // ONE create_scene turn; the next turn finds an empty queue and the mock
    // client throws → the runner's catch path fires.
    const client = new MockAnthropicClient([createSceneTurn(1)])
    __setProvidersStoreForTesting({ anthropic: client })

    let thrown: unknown
    try {
      await runAgent({
        message: 'Build the two scenes',
        scenes: [],
        globalStyle: makeGlobalStyle(),
        projectName: 'err-project',
        outputMode: 'mp4',
        modelOverride: 'claude-sonnet-4-6',
        projectId: 'proj-err',
        branchId: null,
        initialScenePlan: SCENE_PLAN,
        maxIterations: 5,
        emit: (_e: SSEEvent) => {},
      })
    } catch (e) {
      thrown = e
    }
    return thrown
  }

  it('persists an error checkpoint holding the live world scene built this run', async () => {
    const thrown = await runUntilError()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as any)._stopReason).toBe('error')

    expect(mockedPersist).toHaveBeenCalledTimes(1)
    const [projectId, branchId, checkpoint] = mockedPersist.mock.calls[0] as [string, string | null, RunCheckpoint]
    expect(projectId).toBe('proj-err')
    expect(branchId).toBeNull()
    expect(checkpoint.reason).toBe('error')

    // worldSnapshot is the LIVE world (Scene 1 built this run), NOT opts.scenes ([]).
    expect(checkpoint.worldSnapshot.scenes).toHaveLength(1)
    expect(checkpoint.worldSnapshot.scenes[0].name).toBe('Scene 1')

    // completedSceneIds == runProgress.scenesCreated (the one scene built),
    // and equals the world snapshot's scene id — not every pre-existing scene.
    expect(checkpoint.completedSceneIds).toEqual([checkpoint.worldSnapshot.scenes[0].id])
    expect(checkpoint.scenePlan?.scenes).toHaveLength(2)
    expect(checkpoint.remainingSceneIndexes).toEqual([1]) // Scene 2 still to build
  }, 30_000)

  it('attaches the live world to the rejection so the service can persist it (A1)', async () => {
    const thrown = (await runUntilError()) as any
    expect(Array.isArray(thrown._worldScenes)).toBe(true)
    expect(thrown._worldScenes).toHaveLength(1)
    expect(thrown._worldScenes[0].name).toBe('Scene 1')
    expect(thrown._world).toBeTruthy()
    expect(thrown._world.sceneGraph).toBeTruthy()
  }, 30_000)
})
