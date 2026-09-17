// @vitest-environment node
/**
 * Review-after-build eval (Gap 2) — does the Builder review the FINISHED CUT as a
 * whole after a multi-scene build, rather than calling it done?
 *
 * The Builder prompt instructs: after the scenes are built, call review_video once
 * to check pacing/redundancy/continuity across the cut (per-scene correctness is
 * already covered by each sub-agent's verify_scene). This LIVE eval seeds an
 * already-built multi-scene project and checks that a "review the finished cut"
 * prompt routes to review_video — and that a trivial single-scene edit does NOT.
 *
 * Cost control: aborts the instant review_video (or a decisive edit tool) appears,
 * so each case is ~one model turn. The abort also short-circuits review_video's
 * capture loop (no client to answer capture_request here), so no real captures or
 * VLM spend occur. Tight cost cap as a backstop.
 *
 * OPT-IN — skipped unless both are set:
 *     RUN_AGENT_EVALS=1  ANTHROPIC_API_KEY=sk-...  npx vitest run src/lib/agents/review-after-build.eval.test.ts
 */

import { describe, it, expect } from 'vitest'

import { runAgent } from './runner'
import { AgentLogger } from './logger'
import type { SSEEvent } from './types'
import type { Scene } from '../types'

const ENABLED = process.env.RUN_AGENT_EVALS === '1' && !!process.env.ANTHROPIC_API_KEY

const REVIEW_TOOL = 'review_video'
// Going to edit instead of reviewing the whole cut.
const EDIT_DECISIVE = new Set(['create_scene', 'write_scene_code', 'add_layer', 'patch_layer_code', 'regenerate_layer'])

/** A small already-built 3-scene cut. */
function builtCut(): Scene[] {
  return [0, 1, 2].map(
    (i) =>
      ({
        id: `scene-${i}`,
        name: ['Hook', 'How it works', 'Call to action'][i],
        duration: 8,
        bgColor: '#101020',
        sceneType: 'react',
        sceneCode: `export default function S(){return <div>Scene ${i}</div>}`,
      }) as unknown as Scene,
  )
}

async function observe(message: string, scenes: Scene[]): Promise<{ reviewed: boolean; firstDecisive?: string }> {
  const tools: string[] = []
  const abort = new AbortController()
  let firstDecisive: string | undefined

  const emit = (e: SSEEvent) => {
    if (e.type !== 'tool_start' || !e.toolName) return
    tools.push(e.toolName)
    if (firstDecisive) return
    if (e.toolName === REVIEW_TOOL || EDIT_DECISIVE.has(e.toolName)) {
      firstDecisive = e.toolName
      abort.abort()
    }
  }

  await runAgent({
    message,
    scenes,
    globalStyle: { presetId: null } as never,
    projectName: 'review-eval',
    outputMode: 'mp4',
    emit,
    logger: new AgentLogger(),
    abortSignal: abort.signal,
    maxIterations: 5,
    runConfig: { maxRunCostUsd: 1 },
  }).catch((err) => {
    if (!firstDecisive) throw err
  })

  return { reviewed: tools.includes(REVIEW_TOOL), firstDecisive }
}

describe.skipIf(!ENABLED)('Builder reviews the finished cut (live eval)', () => {
  it('calls review_video when asked to assess the finished multi-scene cut', async () => {
    const { reviewed } = await observe(
      'The 3 scenes are built. Review the finished cut as a whole — how is the pacing, is anything redundant, does it flow scene to scene?',
      builtCut(),
    )
    expect(reviewed).toBe(true)
  }, 120_000)

  it('does NOT review the whole cut for a trivial single-scene edit', async () => {
    const { reviewed, firstDecisive } = await observe('Change the title on the Hook scene to "Welcome".', builtCut())
    expect(reviewed).toBe(false)
    expect(firstDecisive).not.toBe(REVIEW_TOOL)
  }, 120_000)
})
