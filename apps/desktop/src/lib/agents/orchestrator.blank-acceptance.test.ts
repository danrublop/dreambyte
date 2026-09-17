// @vitest-environment node

// Pixel-truth as orchestrator acceptance: endedOnBlankRender decides whether a
// scene-builder sub-agent left its scene in a blank/broken final state (the
// post-tool gate flips such a write to success:false with a `_render` marker). If
// so, the orchestrator's corrective pass re-runs the scene. The detector must be
// conservative — a later clean content write must clear the verdict so a recovered
// scene never triggers a wasted corrective pass.

import { describe, expect, it } from 'vitest'

import { endedOnBlankRender } from './orchestrator'
import type { ToolCallRecord } from './types'

function call(
  toolName: string,
  sceneId: string,
  success: boolean,
  opts: { render?: boolean } = {},
): ToolCallRecord {
  return {
    toolName,
    input: { sceneId },
    output: {
      success,
      ...(opts.render ? { data: { _render: { status: 'blank' } } } : {}),
    },
  } as unknown as ToolCallRecord
}

describe('endedOnBlankRender', () => {
  it('is true when the only render-affecting call was a blank block', () => {
    const calls = [call('write_scene_code', 's1', false, { render: true })]
    expect(endedOnBlankRender(calls, 's1')).toBe(true)
  })

  it('is false when a clean content write follows the block (recovered)', () => {
    const calls = [
      call('write_scene_code', 's1', false, { render: true }),
      call('patch_layer_code', 's1', true), // fixed it
    ]
    expect(endedOnBlankRender(calls, 's1')).toBe(false)
  })

  it('is true when a block follows an earlier clean write (regressed)', () => {
    const calls = [
      call('write_scene_code', 's1', true),
      call('patch_layer_code', 's1', false, { render: true }), // broke it again, never fixed
    ]
    expect(endedOnBlankRender(calls, 's1')).toBe(true)
  })

  it('is false when there are no blocks at all', () => {
    const calls = [call('write_scene_code', 's1', true), call('verify_scene', 's1', true)]
    expect(endedOnBlankRender(calls, 's1')).toBe(false)
  })

  it('ignores blocks on OTHER scenes when scoped to ownId', () => {
    const calls = [
      call('write_scene_code', 's2', false, { render: true }), // a different scene's block
      call('write_scene_code', 's1', true),
    ]
    expect(endedOnBlankRender(calls, 's1')).toBe(false)
  })

  it('does not treat a non-content tool as a recovery', () => {
    // set_scene_background succeeding does NOT prove the scene draws content, so a
    // prior write block (only content tools recover) should still stand.
    const calls = [
      call('write_scene_code', 's1', false, { render: true }),
      call('set_scene_background', 's1', true),
    ]
    expect(endedOnBlankRender(calls, 's1')).toBe(true)
  })
})
