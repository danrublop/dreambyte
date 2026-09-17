// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'
import { PARENT_ONLY_TOOL_NAMES } from './tools'
import { MEDIA_GEN_TOOL_SET, toolTimeoutMs, renderBlockForTool } from './tool-executor'
import { MEDIA_GEN_TOOL_TIMEOUT_MS } from './tool-timeouts'
import type { SceneFrameTruth } from '@/lib/services/scene-verifier'

const BLANK: SceneFrameTruth = { nonblankRatio: 0.004, brokenImages: 0, totalImages: 0 }

/**
 * Hardening fixes from the multi-agent infra review (P0/P1/P2).
 */
describe('hardening: sub-agent ask_user guard (review P0)', () => {
  it('ask_user is parent-only → stripped from every sub-agent toolset', () => {
    expect(PARENT_ONLY_TOOL_NAMES.has('ask_user')).toBe(true)
  })
})

describe('hardening: paid i2i tools on the media timeout tier (review P0 double-bill)', () => {
  it('the real paid image tools are in MEDIA_GEN_TOOL_SET', () => {
    // i2i and re-roll are generate_image(source:…) since L5 — one merged name, one tier.
    expect(MEDIA_GEN_TOOL_SET.has('generate_image')).toBe(true)
  })
  it('they get the 180s media tier, not the 60s default (no spurious timeout → no retry double-bill)', () => {
    expect(toolTimeoutMs('generate_image')).toBe(MEDIA_GEN_TOOL_TIMEOUT_MS)
  })
})

describe('hardening: code-authoring tools are render-veto scoped (review P2)', () => {
  // migrate_to_react was the original subject here — it emitted reactCode, so a blank
  // render after it had to block exactly like write_scene_code. The tool is gone; the
  // invariant it was added to prove (veto scoped BY authoring, not by tool name) is
  // what these two assertions still hold.
  it('a blank render after a code-authoring tool blocks', () => {
    expect(renderBlockForTool('patch_layer_code', 'verified', BLANK)).not.toBeNull()
    expect(renderBlockForTool('write_scene_code', 'verified', BLANK)).not.toBeNull() // control
  })
  it('a non-authoring tool is NOT veto-scoped (control)', () => {
    expect(renderBlockForTool('scene_props', 'verified', BLANK)).toBeNull()
  })
})
