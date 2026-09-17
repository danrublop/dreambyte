/**
 * Tool-scoping tests for filterToolsForAgent — specifically the strict `toolAllowlist`
 * used by typed sub-agents. This is the test that would have caught the Phase-1 bug:
 * activeTools is an ENABLE model (the base mutating toolset is always offered), so a
 * read-only sub-agent can only be scoped via toolAllowlist, not activeTools.
 */
import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_ACTIVE_TOOLS, filterToolsForAgent } from './context-builder'
import { allowedToolsForSubagent } from './subagent-dispatch'

/** Makes an image provider genuinely ready (hasImageGen reads the real env). */
function withImageKeys<T>(fn: () => T): T {
  const saved = process.env.FAL_KEY
  process.env.FAL_KEY = 'media-surface-test-key'
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.FAL_KEY
    else process.env.FAL_KEY = saved
  }
}

const MUTATING = ['create_scene', 'write_scene_code', 'patch_layer_code', 'element', 'set_style']

describe('filterToolsForAgent — toolAllowlist (typed sub-agent scoping)', () => {
  it('REGRESSION: without an allowlist, activeTools does NOT restrict — base mutating tools leak in', () => {
    // Passing the Explore tool names as activeTools (the buggy approach) still offers create_scene.
    const explore = allowedToolsForSubagent('Explore')!
    const names = filterToolsForAgent('scene-maker', explore, undefined, undefined, undefined, true, true).map(
      (t) => t.name,
    )
    expect(names).toContain('create_scene') // proves activeTools is not an allowlist
  })

  it('with a toolAllowlist, the agent is offered EXACTLY the allowlist (no mutating tools)', () => {
    const explore = allowedToolsForSubagent('Explore')!
    const names = filterToolsForAgent('scene-maker', [], undefined, undefined, undefined, true, true, explore).map(
      (t) => t.name,
    )
    // Every offered tool is in the allowlist…
    for (const n of names) expect(explore).toContain(n)
    // …and none of the always-on mutating tools survive.
    for (const m of MUTATING) expect(names).not.toContain(m)
    // …research + read tools that exist for this agent do survive.
    expect(names).toContain('web_search')
    expect(names).toContain('inspect')
  })

  it('web-research gating still applies under an allowlist (search+fetch stripped when both off)', () => {
    const explore = allowedToolsForSubagent('Explore')!
    // webSearchEnabled=false strips web_search; webFetchEnabled=false strips fetch_url_content.
    const names = filterToolsForAgent('scene-maker', [], undefined, undefined, undefined, false, false, explore).map(
      (t) => t.name,
    )
    expect(names).not.toContain('web_search')
    expect(names).not.toContain('fetch_url_content')
    expect(names).toContain('inspect') // non-research read tool still offered
  })

  it('split gating: search off + fetch on keeps fetch_url_content, drops web_search', () => {
    const explore = allowedToolsForSubagent('Explore')!
    const names = filterToolsForAgent('scene-maker', [], undefined, undefined, undefined, false, true, explore).map(
      (t) => t.name,
    )
    expect(names).not.toContain('web_search')
    expect(names).toContain('fetch_url_content')
  })

  it('Verification allowlist offers verify_scene + review (whole-cut review) but no mutating tools', () => {
    const verify = allowedToolsForSubagent('Verification')!
    const names = filterToolsForAgent('scene-maker', [], undefined, undefined, undefined, true, true, verify).map(
      (t) => t.name,
    )
    expect(names).toContain('verify_scene')
    // review_video survives only because it's a real registered tool (T4) AND in the
    // Verification allowlist (T5) — the context builder drops unknown names.
    expect(names).toContain('review')
    for (const m of MUTATING) expect(names).not.toContain(m)
  })

  // Phase 3 — the Plan toolset is what the parent "wears" in plan mode. It must
  // offer the plan/todo writers + read/research, and physically exclude every
  // scene-mutating tool, so the parent cannot build before the plan is approved.
  it('Plan allowlist offers write_plan/update_todos + read/research, but no mutating tools', () => {
    const plan = allowedToolsForSubagent('Plan')!
    const names = filterToolsForAgent('scene-maker', [], undefined, undefined, undefined, true, true, plan).map(
      (t) => t.name,
    )
    // The plan/todo writers are offered…
    expect(names).toContain('write_plan')
    expect(names).toContain('update_todos')
    // …alongside read + research…
    expect(names).toContain('inspect')
    expect(names).toContain('web_search')
    // …and NOT a single mutating tool (incl. plan_scenes — the demoted planning form).
    for (const m of MUTATING) expect(names).not.toContain(m)
    expect(names).not.toContain('plan_scenes')
    expect(names).not.toContain('dispatch_scene_builder')
  })
})

// T26: the in-app scene-maker agent must actually be able to reach the media-library
// generation + placement surface (it previously couldn't — those tools weren't in its set).
const MEDIA_SURFACE = [
  // search_images was removed as a strictly-worse duplicate of find_media(kind:'image')
  // (no cache, no keyless fallback, needed an Unsplash key). Stock DISCOVERY is
  // find_media; this list covers the placement + library surface.
  'place_image',
  'use_asset_in_scene',
  'media_library',
  'generate_image',
  'character',
]
const MEDIA_GEN = ['generate_image', 'character']
const MEDIA_LIBRARY_OPS = ['media_library', 'use_asset_in_scene']

describe('filterToolsForAgent — media-library surface for scene-maker (T26)', () => {
  it('REGRESSION: with the in-app defaults and a ready provider, the full media surface is offered', () => {
    // Was written as `activeTools: []` back when an empty list short-circuited the
    // filter and returned everything ungated — so it proved nothing about the media
    // gates, only that the bypass existed. The in-app default set plus a keyed image
    // provider is the configuration it was actually meant to describe.
    const names = withImageKeys(() =>
      filterToolsForAgent('scene-maker', [...DEFAULT_ACTIVE_TOOLS], undefined, undefined, undefined, true).map(
        (t) => t.name,
      ),
    )
    for (const t of MEDIA_SURFACE) expect(names).toContain(t)
  })

  it('without the assets category, the whole media surface is gated out', () => {
    const names = filterToolsForAgent('scene-maker', ['audio'], undefined, { imageGen: true }, undefined, true).map(
      (t) => t.name,
    )
    for (const t of MEDIA_SURFACE) expect(names).not.toContain(t)
  })

  it('with assets active but NO image provider, paid-gen tools are gated but library ops survive', () => {
    // No FAL/OpenAI key in test env → no image provider is "ready" even though enabled.
    const names = filterToolsForAgent('scene-maker', ['assets'], undefined, { imageGen: true }, undefined, true).map(
      (t) => t.name,
    )
    for (const t of MEDIA_GEN) expect(names).not.toContain(t)
    for (const t of MEDIA_LIBRARY_OPS) expect(names).toContain(t)
    // place is also assets-gated (no provider needed — it places existing/stock images).
    expect(names).toContain('place_image')
  })
})

describe('filterToolsForAgent — AI generation gate (generate_image / generate_veo3_video)', () => {
  it('with assets active + an image provider configured, generate_image is OFFERED (sticker is a mode of it)', () => {
    vi.stubEnv('FAL_KEY', 'test-key') // makes the imageGen provider "ready"
    try {
      const names = filterToolsForAgent('scene-maker', ['assets'], undefined, { imageGen: true }, undefined, true).map(
        (t) => t.name,
      )
      expect(names).toContain('generate_image')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('generate_veo3_video is gated on the VIDEO category AND a video provider (not offered without a key)', () => {
    // No key → not offered even with the video category active.
    const stripped = filterToolsForAgent('scene-maker', ['video'], undefined, undefined, undefined, true).map(
      (t) => t.name,
    )
    expect(stripped).not.toContain('generate_veo3_video')

    vi.stubEnv('FAL_KEY', 'test-key') // a FAL-keyed video provider becomes ready
    try {
      const offered = filterToolsForAgent('scene-maker', ['video'], undefined, undefined, undefined, true).map(
        (t) => t.name,
      )
      expect(offered).toContain('generate_veo3_video')
      // still needs the video category — assets-only must NOT offer it
      const noVideoCat = filterToolsForAgent('scene-maker', ['assets'], undefined, undefined, undefined, true).map(
        (t) => t.name,
      )
      expect(noVideoCat).not.toContain('generate_veo3_video')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('media wiring (② unblock)', () => {
  it('REGRESSION: set_media_layer is registered on scene-maker and offered when video is active', () => {
    // It was missing from AGENT_TOOLS[scene-maker] entirely, so it never appeared
    // on ANY run regardless of keys/categories — this pins that it now does.
    const names = filterToolsForAgent(
      'scene-maker',
      ['video', 'audio', 'assets'],
      undefined,
      undefined,
      undefined,
      true,
      true,
    ).map((t) => t.name)
    expect(names).toContain('set_media_layer')
    // placement no longer requires a video-GENERATION provider (works with stock/uploads)
  })

  it('stock media tools are decoupled from the web-search switch (present when web search is OFF)', () => {
    const names = filterToolsForAgent(
      'scene-maker',
      ['assets'],
      undefined,
      undefined,
      undefined,
      false, // web search OFF
      false, // web fetch OFF
    ).map((t) => t.name)
    expect(names).not.toContain('web_search') // live web search stays gated
    expect(names).toContain('find_media') // our provider API — no longer gated
  })
})
