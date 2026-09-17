// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect, beforeEach } from 'vitest'

import { executeTool, registerPostToolHook, clearToolHooks } from '../tool-executor'
import type { WorldStateMutable } from '../world-state'

/**
 * E4 — `_hookWarning` was a single key, so the LAST post-tool hook to warn won.
 *
 * The real pairing: a `regenerate_layer` that takes 34s AND throws at runtime
 * produces two warnings — "RUNTIME ERROR: …" from the auto-runtime-verify hook
 * (built-in-hooks.ts) and "took 34.0s" from the slow-tool hook, which runs
 * later. The perf note overwrote the defect report, so the model never learned
 * the scene it just wrote is broken.
 *
 * dispatch_to_branches is used as the carrier: a pure registry tool with no DB,
 * no filesystem and no provider call, so this exercises the hook plumbing only.
 */

function makeWorld(): WorldStateMutable {
  return {
    scenes: [],
    globalStyle: {
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    },
    projectName: 'p',
    projectId: 'proj-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: null },
    fanoutAvailable: true,
  } as unknown as WorldStateMutable
}

const RUNTIME = 'RUNTIME ERROR: cannot read property x of undefined (line 12). Patch it before continuing.'
const SLOW = 'Tool regenerate_layer took 34.0s — consider optimizing or splitting the operation.'

const run = () => executeTool('dispatch_to_branches', { count: 2, instruction: 'two takes' }, makeWorld())
const warningOf = (data: unknown) => (data as { _hookWarning?: string } | undefined)?._hookWarning ?? ''

describe('post-tool hook warnings accumulate (E4)', () => {
  beforeEach(() => clearToolHooks())

  it('keeps BOTH warnings when a later hook also warns', async () => {
    registerPostToolHook('*', 'verify', () => ({ warning: RUNTIME }))
    registerPostToolHook('*', 'slow', () => ({ warning: SLOW }))
    const r = await run()
    const w = warningOf(r.data)
    expect(w).toContain('RUNTIME ERROR')
    expect(w).toContain('took 34.0s')
  })

  it('orders the defect ahead of the perf note regardless of hook order', async () => {
    registerPostToolHook('*', 'slow', () => ({ warning: SLOW }))
    registerPostToolHook('*', 'verify', () => ({ warning: RUNTIME }))
    const w = warningOf((await run()).data)
    expect(w.indexOf('RUNTIME ERROR')).toBeLessThan(w.indexOf('took 34.0s'))
  })

  it('survives a hook that replaces the whole result mid-chain', async () => {
    registerPostToolHook('*', 'verify', () => ({ warning: RUNTIME }))
    registerPostToolHook('*', 'capture', (ctx) => ({
      modifiedResult: { ...ctx.result, data: { ...(ctx.result.data as object), clientAction: 'capture_frame' } },
    }))
    registerPostToolHook('*', 'slow', () => ({ warning: SLOW }))
    const r = await run()
    expect(warningOf(r.data)).toContain('RUNTIME ERROR')
    expect((r.data as { clientAction?: string }).clientAction).toBe('capture_frame')
  })

  it('leaves the key absent when nothing warned', async () => {
    const r = await run()
    expect((r.data as { _hookWarning?: string })._hookWarning).toBeUndefined()
  })
})

describe('an accumulated warning survives the model-facing summary (E4)', () => {
  it('_hookWarning is metadata, so a >500-char join is not collapsed', async () => {
    const { buildToolResultContent } = await import('../runner')
    const long = `${RUNTIME} ${'x'.repeat(400)} | ${SLOW}`
    const content = buildToolResultContent({ success: true, data: { _hookWarning: long } } as never)
    expect(typeof content).toBe('string')
    // Before _hookWarning was whitelisted, >500 chars became "[N chars generated]"
    // — deleting the defect report on exactly the runs that produce two warnings.
    expect(content as string).toContain('RUNTIME ERROR')
    expect(content as string).not.toContain('chars generated')
  })
})
