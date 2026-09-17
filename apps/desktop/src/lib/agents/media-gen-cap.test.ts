// @vitest-environment node
/**
 * Media-gen count backstop wiring (⑥ / D4 defense-in-depth).
 *
 * The per-world dispatch counter (noteMediaGenDispatch/drainMediaGenCount) is the
 * bridge that carries paid visual/video generation counts from the executeTool choke
 * point to the runner, which commits them to the shared RunCostLedger's mediaGenCount.
 * These prove the bridge accumulates + drains like the spend side-channel, and that
 * MEDIA_GEN_COUNT_SET targets the right class (visual/video, NOT per-scene audio).
 */
import { describe, it, expect } from 'vitest'
import { noteMediaGenDispatch, drainMediaGenCount } from './tool-handlers/_shared'
import { MEDIA_GEN_COUNT_SET } from './tool-executor'

describe('per-world media-gen dispatch count (bridge to the run ledger)', () => {
  it('accumulates per world and drains to zero (mirrors drainToolSpend)', () => {
    const world = {}
    expect(drainMediaGenCount(world)).toBe(0)
    noteMediaGenDispatch(world)
    noteMediaGenDispatch(world)
    expect(drainMediaGenCount(world)).toBe(2)
    // Drained → zeroed; a second drain sees nothing until the next dispatch.
    expect(drainMediaGenCount(world)).toBe(0)
    noteMediaGenDispatch(world)
    expect(drainMediaGenCount(world)).toBe(1)
  })

  it('is keyed per world — one world`s count never leaks into another', () => {
    const a = {}
    const b = {}
    noteMediaGenDispatch(a)
    expect(drainMediaGenCount(b)).toBe(0)
    expect(drainMediaGenCount(a)).toBe(1)
  })
})

describe('MEDIA_GEN_COUNT_SET — the counted class', () => {
  it('counts paid VISUAL/VIDEO gens (image, sticker, i2i, variation, avatar, veo3)', () => {
    for (const t of ['generate_image', 'generate_veo3_video', 'generate_avatar_narration', 'generate_avatar_scene']) {
      expect(MEDIA_GEN_COUNT_SET.has(t)).toBe(true)
    }
  })

  it('does NOT count per-scene AUDIO (narration/SFX/music/TTS) — they scale one-per-scene', () => {
    for (const t of ['add_narration', 'add_sound_effect', 'add_background_music', 'generate_music', 'elevenlabs_tts']) {
      expect(MEDIA_GEN_COUNT_SET.has(t)).toBe(false)
    }
  })
})
