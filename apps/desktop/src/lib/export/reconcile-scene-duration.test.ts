// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { reconcileSceneExportDuration } from './reconcile-scene-duration'
import type { AvatarLayer, Veo3Layer } from '../types/ai-layer'

const avatar = (over: Partial<AvatarLayer>): AvatarLayer =>
  ({
    id: 'av1',
    type: 'avatar',
    avatarId: 'a',
    voiceId: 'v',
    script: '',
    removeBackground: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    zIndex: 4,
    videoUrl: 'dreambyte://generated/av1.mp4',
    thumbnailUrl: null,
    status: 'ready',
    heygenVideoId: null,
    estimatedDuration: 0,
    startAt: 0,
    label: 'Avatar',
    ...over,
  }) as AvatarLayer

const veo = (over: Partial<Veo3Layer>): Veo3Layer =>
  ({
    id: 'veo1',
    type: 'veo3',
    prompt: '',
    negativePrompt: null,
    aspectRatio: '16:9',
    duration: 8,
    loop: false,
    playbackRate: 1,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    zIndex: 4,
    videoUrl: 'dreambyte://generated/veo1.mp4',
    thumbnailUrl: null,
    status: 'ready',
    operationName: null,
    startAt: 0,
    label: 'Veo',
    ...over,
  }) as Veo3Layer

describe('reconcileSceneExportDuration', () => {
  it('keeps the authored duration when there are no media layers', () => {
    expect(reconcileSceneExportDuration({ duration: 5 })).toEqual({
      duration: 5,
      extended: false,
      limitingLayerId: null,
    })
  })

  it('extends to a ready avatar clip that outruns the scene (the A4 silent cutoff)', () => {
    const r = reconcileSceneExportDuration({
      duration: 5,
      aiLayers: [avatar({ estimatedDuration: 9.4, startAt: 1 })],
    })
    expect(r.duration).toBeCloseTo(10.4)
    expect(r.extended).toBe(true)
    expect(r.limitingLayerId).toBe('av1')
  })

  it('does not extend for a clip that fits (frozen-last-frame stays the behavior)', () => {
    const r = reconcileSceneExportDuration({
      duration: 10,
      aiLayers: [avatar({ estimatedDuration: 4 })],
    })
    expect(r).toEqual({ duration: 10, extended: false, limitingLayerId: null })
  })

  it('never extends for a clip that is not ready — pre-generation placeholders carry word-count ESTIMATES', () => {
    expect(
      reconcileSceneExportDuration({
        duration: 5,
        aiLayers: [avatar({ estimatedDuration: 60, status: 'generating' })],
      }).extended,
    ).toBe(false)
    expect(
      reconcileSceneExportDuration({
        duration: 5,
        aiLayers: [avatar({ estimatedDuration: 60, videoUrl: null })],
      }).extended,
    ).toBe(false)
  })

  it("respects 'trim' and 'hold-last-frame' policies (authored duration wins)", () => {
    for (const timingPolicy of ['trim', 'hold-last-frame'] as const) {
      const r = reconcileSceneExportDuration({
        duration: 5,
        aiLayers: [avatar({ estimatedDuration: 12, timingPolicy })],
      })
      expect(r).toEqual({ duration: 5, extended: false, limitingLayerId: null })
    }
  })

  it('honors the paired lipsync narration track when it outlasts the video', () => {
    // The muted avatar <video> pairs with a `lipsync-<layerId>` SFX track
    // (addSFXToScene in src/lib/store/generation-actions.ts) — speech audio must
    // never be cut either.
    const r = reconcileSceneExportDuration({
      duration: 5,
      aiLayers: [avatar({ id: 'av9', estimatedDuration: 6 })],
      audioLayer: {
        sfx: [
          { id: 'lipsync-av9', name: '', provider: 'local', src: 'x', triggerAt: 0.5, volume: 1, duration: 7 },
          { id: 'other', name: '', provider: 'local', src: 'x', triggerAt: 0, volume: 1, duration: 99 },
        ],
      },
    })
    expect(r.duration).toBeCloseTo(7.5) // audio end (0.5 + 7) > video end (6); unrelated SFX ignored
    expect(r.limitingLayerId).toBe('av9')
  })

  it('veo3: looping clips never extend; playbackRate shortens the wall-clock end', () => {
    expect(
      reconcileSceneExportDuration({
        duration: 5,
        aiLayers: [veo({ duration: 30, loop: true })],
      }).extended,
    ).toBe(false)
    const r = reconcileSceneExportDuration({
      duration: 5,
      aiLayers: [veo({ duration: 16, playbackRate: 2, startAt: 1 })],
    })
    expect(r.duration).toBeCloseTo(9) // 1 + 16/2
    expect(r.limitingLayerId).toBe('veo1')
  })

  it('the longest of several layers wins', () => {
    const r = reconcileSceneExportDuration({
      duration: 5,
      aiLayers: [avatar({ id: 'a', estimatedDuration: 7 }), avatar({ id: 'b', estimatedDuration: 11 })],
    })
    expect(r.duration).toBe(11)
    expect(r.limitingLayerId).toBe('b')
  })

  it('non-finite garbage never produces a NaN duration', () => {
    const r = reconcileSceneExportDuration({
      duration: NaN,
      aiLayers: [avatar({ estimatedDuration: NaN, startAt: -3 })],
    })
    expect(Number.isFinite(r.duration)).toBe(true)
    expect(r.duration).toBe(0)
  })

  it('extends from the paired narration track ALONE when estimatedDuration is unset (0)', () => {
    // estimatedDuration: 0 is the factory default until generation completes
    // writing the real value — but the lipsync track can still prove the
    // speech length. The most load-bearing "speech never cut" path.
    const r = reconcileSceneExportDuration({
      duration: 5,
      aiLayers: [avatar({ id: 'av2', estimatedDuration: 0 })],
      audioLayer: {
        sfx: [{ id: 'lipsync-av2', name: '', provider: 'local', src: 'x', triggerAt: 0, volume: 1, duration: 8 }],
      },
    })
    expect(r.duration).toBe(8)
    expect(r.limitingLayerId).toBe('av2')
  })

  it('a valid estimatedDuration still extends when startAt is garbage (falls back to 0)', () => {
    const r = reconcileSceneExportDuration({
      duration: 5,
      aiLayers: [avatar({ estimatedDuration: 9, startAt: NaN })],
    })
    expect(r.duration).toBe(9)
  })

  it('veo3 honors trim/hold policies and the ready gate, like avatars', () => {
    for (const timingPolicy of ['trim', 'hold-last-frame'] as const) {
      expect(
        reconcileSceneExportDuration({ duration: 5, aiLayers: [veo({ duration: 30, timingPolicy })] }).extended,
      ).toBe(false)
    }
    expect(
      reconcileSceneExportDuration({ duration: 5, aiLayers: [veo({ duration: 30, status: 'generating' })] }).extended,
    ).toBe(false)
    expect(
      reconcileSceneExportDuration({ duration: 5, aiLayers: [veo({ duration: 30, videoUrl: null })] }).extended,
    ).toBe(false)
    expect(
      reconcileSceneExportDuration({ duration: 5, aiLayers: [veo({ duration: NaN })] }).extended,
    ).toBe(false)
  })

  it('tolerates audioLayer with null/empty sfx', () => {
    expect(
      reconcileSceneExportDuration({
        duration: 5,
        aiLayers: [avatar({ estimatedDuration: 7 })],
        audioLayer: { sfx: null },
      }).duration,
    ).toBe(7)
    expect(
      reconcileSceneExportDuration({
        duration: 5,
        aiLayers: [avatar({ estimatedDuration: 0 })],
        audioLayer: { sfx: [] },
      }).extended,
    ).toBe(false)
  })

  it('caps the extension at 30 minutes — a corrupt blob cannot drive an unbounded render', () => {
    const r = reconcileSceneExportDuration({
      duration: 5,
      aiLayers: [avatar({ estimatedDuration: 1e12 })],
    })
    expect(r.duration).toBe(30 * 60)
    expect(r.extended).toBe(true)
    // ...but a longer AUTHORED duration is user-typed and still wins.
    const long = reconcileSceneExportDuration({
      duration: 45 * 60,
      aiLayers: [avatar({ estimatedDuration: 1e12 })],
    })
    expect(long.duration).toBe(45 * 60)
    expect(long.extended).toBe(false)
  })

  it('extends the scene for an over-length real voiceover (T13)', () => {
    const r = reconcileSceneExportDuration({
      duration: 5,
      audioLayer: { tts: { src: 'https://cdn/v.mp3', duration: 12 } },
    })
    expect(r.duration).toBe(12)
    expect(r.extended).toBe(true)
    expect(r.limitingLayerId).toBe('narration')
  })

  it('does NOT extend for a client-only narration (no src → silent at export)', () => {
    const r = reconcileSceneExportDuration({
      duration: 5,
      audioLayer: { tts: { src: null, duration: 12 } },
    })
    expect(r.duration).toBe(5)
    expect(r.extended).toBe(false)
  })

  it('does not shrink a scene longer than its narration, and honors startOffset', () => {
    expect(
      reconcileSceneExportDuration({ duration: 20, audioLayer: { tts: { src: 'x', duration: 6 } } }).duration,
    ).toBe(20)
    expect(
      reconcileSceneExportDuration({ duration: 5, audioLayer: { startOffset: 3, tts: { src: 'x', duration: 6 } } })
        .duration,
    ).toBe(9) // 3s offset + 6s speech
  })
})
