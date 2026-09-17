// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

// get_routed_craft — the parity tool. Same routeOKF + loadRulePacks the in-app
// agent auto-injects, returned to the MCP / Claude Code caller. The args path
// doesn't touch the DB/world, so a stub world is fine.

import { describe, it, expect } from 'vitest'
import { createOkfToolHandler } from './okf-tools'

const handler = createOkfToolHandler()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const world = {} as any // unused on the explicit-args path

describe('get_routed_craft', () => {
  it('routes craft from explicit args (shortform explainer) with frontmatter stripped', async () => {
    const r = await handler('get_routed_craft', { videoType: 'explainer', aspectRatio: '9:16' }, world)
    expect(r.success).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = r.data as any
    expect(data.rulePacks).toContain('audio')
    expect(typeof data.craft).toBe('string')
    expect(data.craft.length).toBeGreaterThan(200) // real craft markdown
    expect(data.craft.startsWith('---')).toBe(false) // YAML frontmatter stripped
    expect(data.pacingProfile.shape).toBe('single-act-fast')
  })

  it('returns the SAME rule-pack set the in-app router would (longform film)', async () => {
    const r = await handler('get_routed_craft', { videoType: 'film', aspectRatio: '16:9' }, world)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = r.data as any
    expect(data.rulePacks).toEqual(['audio'])
  })

  it('pulls the generation pack when the video is avatar-centric', async () => {
    const r = await handler(
      'get_routed_craft',
      { videoType: 'professional', aspectRatio: '16:9', isAvatarCentric: true },
      world,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.data as any).rulePacks).toContain('generation')
  })

  it('returns honest guidance when no args and no project brief', async () => {
    const r = await handler('get_routed_craft', {}, world)
    expect(r.success).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.data as any).craft).toBe('')
  })

  it('clamps an invalid aspectRatio (no shortform mis-route)', async () => {
    const r = await handler('get_routed_craft', { videoType: 'explainer', aspectRatio: '21:9' }, world)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = r.data as any
    // 21:9 → clamped to 16:9 → longform
    expect(data.pacingProfile.shape).toBe('3-act')
  })

  it('a stray scalar (no videoType) does NOT build a default brief — falls back', async () => {
    // No videoType → useArgs false → stored-brief branch → no project → empty craft.
    const r = await handler('get_routed_craft', { runtimeTargetSec: 45 }, world)
    expect(r.success).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.data as any).craft).toBe('')
  })

  it('single-pack pull { pack } returns ONLY that pack (the on-demand menu path)', async () => {
    // `three` is NOT auto-routed (renderer tag) — the on-demand pull is the only door.
    const r = await handler('get_routed_craft', { videoType: 'explainer', aspectRatio: '16:9', pack: 'three' }, world)
    expect(r.success).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = r.data as any
    expect(data.craft.length).toBeGreaterThan(200) // just the three body
    expect(data.craft.startsWith('---')).toBe(false) // frontmatter stripped
    expect(data.craft.toLowerCase()).toMatch(/three|scene|camera/)
    expect(data.rulePacks).not.toContain('three') // pulled on request, not routed
  })

  it('an unknown pack id returns honest empty craft, names the routed set', async () => {
    const r = await handler('get_routed_craft', { videoType: 'explainer', aspectRatio: '16:9', pack: 'nope' }, world)
    expect(r.success).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.data as any).craft).toBe('')
    expect(r.changes?.[0].description).toMatch(/audio/) // lists what IS routed
  })

  it('rejects an unknown tool name', async () => {
    const r = await handler('not_a_real_tool', {}, world)
    expect(r.success).toBe(false)
  })
})

describe('set_aspect_ratio', () => {
  it('rejects an invalid aspect ratio', async () => {
    const r = await handler('set_aspect_ratio', { aspectRatio: '21:9' }, { projectId: 'p1' } as any)
    expect(r.success).toBe(false)
  })

  it('rejects when there is no active project', async () => {
    const r = await handler('set_aspect_ratio', { aspectRatio: '9:16' }, {} as any)
    expect(r.success).toBe(false)
  })

  it('updates the live world mp4Settings on a valid call (in-memory)', async () => {
    // No real DB row here, so persistence will throw and return an error result —
    // but world.mp4Settings is mutated first (what the same-session render reads).
    const w: any = { projectId: 'p1', mp4Settings: { aspectRatio: '16:9', resolution: '1080p', format: 'mp4' } }
    await handler('set_aspect_ratio', { aspectRatio: '9:16' }, w)
    expect(w.mp4Settings.aspectRatio).toBe('9:16')
  })
})
