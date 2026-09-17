// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { renderBlockForTool, verifySkippedForTool } from './tool-executor'
import type { SceneFrameTruth } from '../services/scene-verifier'

/**
 * Regression gate.
 *
 * The pixel-truth render gate must only flip CODE-AUTHORING tools to failure.
 * A camera / transition / background tool regenerates HTML (and so measures a
 * frame) but did not author the pixels — failing it for an already-blank scene
 * blames the wrong tool and sends the agent into a delete/recreate churn. This
 * is what killed the "Hook" scene in the captured trace: set_camera_motion was
 * flipped to failure for a legitimately dark scene caught mid animate-in.
 */

// A genuinely blank reading: <2% non-background pixels AND a single color.
const BLANK: SceneFrameTruth = {
  nonblankRatio: 0,
  distinctColors: 1,
  brokenImages: 0,
  totalImages: 0,
}

// A healthy reading: lots of content, many colors.
const RICH: SceneFrameTruth = {
  nonblankRatio: 0.55,
  distinctColors: 4096,
  brokenImages: 0,
  totalImages: 0,
}

describe('renderBlockForTool — render-gate flip scope (#4)', () => {
  it('flips a CODE-AUTHORING tool (write_scene_code) on a blank verified scene', () => {
    expect(renderBlockForTool('write_scene_code', 'verified', BLANK)).not.toBeNull()
  })

  it('flips patch_layer_code on a blank verified scene', () => {
    expect(renderBlockForTool('patch_layer_code', 'verified', BLANK)).not.toBeNull()
  })

  it('does NOT flip set_camera_motion on a blank verified scene (the #4 fix)', () => {
    expect(renderBlockForTool('set_camera_motion', 'verified', BLANK)).toBeNull()
  })

  it('does NOT flip set_transition on a blank verified scene', () => {
    expect(renderBlockForTool('set_transition', 'verified', BLANK)).toBeNull()
  })

  it('does NOT flip set_scene_background on a blank verified scene', () => {
    expect(renderBlockForTool('set_scene_background', 'verified', BLANK)).toBeNull()
  })

  it('does NOT flip a code tool on a RICH (non-blank) scene', () => {
    expect(renderBlockForTool('write_scene_code', 'verified', RICH)).toBeNull()
  })

  it('does NOT flip when the scene is not verified (errored/unknown)', () => {
    expect(renderBlockForTool('write_scene_code', 'errored', BLANK)).toBeNull()
    expect(renderBlockForTool('write_scene_code', undefined, BLANK)).toBeNull()
  })

  it('does NOT flip when there is no measured frame', () => {
    expect(renderBlockForTool('write_scene_code', 'verified', undefined)).toBeNull()
  })
})

/**
 * A4 (Director plan, Phase 0) — verifier honesty. renderBlockForTool returns
 * null on `unknown` (see the test above), which previously meant a scene the
 * verifier COULDN'T check shipped as a clean success with no signal — the
 * silent-pass bug behind "some scenes render, some don't" under infra pressure.
 * verifySkippedForTool catches exactly that gap: a code-authoring tool whose
 * scene came back `unknown` now yields a visible (non-blocking) marker.
 */
describe('verifySkippedForTool — A4 verifier-unavailable honesty', () => {
  it('flags a code-authoring tool whose scene is unknown (the silent-pass gap)', () => {
    expect(verifySkippedForTool('write_scene_code', 'unknown')).toEqual({ reason: 'verifier-unavailable' })
    expect(verifySkippedForTool('patch_layer_code', 'unknown')).toEqual({ reason: 'verifier-unavailable' })
  })

  it('does NOT flag a verified scene (the render gate owns that path)', () => {
    expect(verifySkippedForTool('write_scene_code', 'verified')).toBeNull()
  })

  it('does NOT flag an errored scene (the _verify gate owns that path)', () => {
    expect(verifySkippedForTool('write_scene_code', 'errored')).toBeNull()
  })

  it('does NOT flag when no verify was attempted (undefined/pending)', () => {
    expect(verifySkippedForTool('write_scene_code', undefined)).toBeNull()
    expect(verifySkippedForTool('write_scene_code', 'pending')).toBeNull()
  })

  it('does NOT flag a non-code-authoring tool (scoped like the render gate)', () => {
    expect(verifySkippedForTool('set_camera_motion', 'unknown')).toBeNull()
    expect(verifySkippedForTool('set_transition', 'unknown')).toBeNull()
  })
})
