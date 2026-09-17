import { describe, it, expect } from 'vitest'
import { materializeSceneAudio } from './scene-audio-materializer'
import type { Scene } from '@/lib/types'

/** Minimal scene with only the fields the materializer reads. */
function scene(audioLayer: unknown, duration = 10): Scene {
  return { id: 'scene-1', name: 'S', duration, audioLayer } as unknown as Scene
}

describe('materializeSceneAudio — lane rules', () => {
  it('returns nothing for a scene without audio', () => {
    expect(materializeSceneAudio(scene(undefined))).toEqual([])
    expect(materializeSceneAudio(scene({}))).toEqual([])
  })

  it('routes file audio → A1 with offset-shortened duration', () => {
    const specs = materializeSceneAudio(scene({ enabled: true, src: '/a.mp3', startOffset: 2 }))
    expect(specs).toEqual([
      {
        lane: 'a1',
        sourceId: 'aud-scene-1',
        label: 'Audio',
        offset: 2,
        duration: 8,
        reuse: 'position+duration',
      },
    ])
  })

  it('disabled file audio emits nothing (but TTS still does)', () => {
    const specs = materializeSceneAudio(scene({ enabled: false, src: '/a.mp3', tts: { text: 'hi' } }))
    expect(specs.map((s) => s.sourceId)).toEqual(['tts-scene-1'])
  })

  it('TTS uses its real duration when known, bounded by the scene', () => {
    const known = materializeSceneAudio(scene({ tts: { src: '/t.mp3', duration: 4 } }))
    expect(known[0]).toMatchObject({ lane: 'a1', sourceId: 'tts-scene-1', duration: 4, reuse: 'position' })
    const over = materializeSceneAudio(scene({ tts: { src: '/t.mp3', duration: 60 } }))
    expect(over[0].duration).toBe(10)
    const unknown = materializeSceneAudio(scene({ tts: { text: 'hello' } }))
    expect(unknown[0].duration).toBe(10) // max(0.2, scene - off)
  })

  it('TTS reuse mode is position-only — a user trim must survive syncs', () => {
    const [ttsSpec] = materializeSceneAudio(scene({ tts: { text: 'hi' } }))
    expect(ttsSpec.reuse).toBe('position')
  })

  it('routes music → A2 with the track name as label', () => {
    const specs = materializeSceneAudio(scene({ music: { src: '/m.mp3', name: 'ASAP Casino' } }))
    expect(specs).toEqual([
      {
        lane: 'a2',
        sourceId: 'mus-scene-1',
        label: 'ASAP Casino',
        offset: 0,
        duration: 10,
        reuse: 'position+duration',
      },
    ])
  })

  it('routes SFX → A3 with per-SFX ownership markers and clamped triggers', () => {
    const specs = materializeSceneAudio(
      scene({
        sfx: [
          { id: 'boing-1', name: 'Boing', src: '/b.wav', triggerAt: 3, duration: 0.5 },
          { id: 'pop-2', src: '/p.wav', triggerAt: 99 }, // trigger past scene end → clamps
        ],
      }),
    )
    expect(specs).toEqual([
      {
        lane: 'a3',
        sourceId: 'boing-1',
        label: 'Boing',
        offset: 3,
        duration: 0.5,
        linkGroupId: 'scene-sfx:scene-1:boing-1',
        reuse: 'position+duration',
      },
      {
        lane: 'a3',
        sourceId: 'pop-2',
        label: 'SFX',
        offset: 10,
        duration: 0.05, // floor — no room left after the clamp
        linkGroupId: 'scene-sfx:scene-1:pop-2',
        reuse: 'position+duration',
      },
    ])
  })

  it('cascades OVERLAPPING SFX onto new lanes (a3, a4, a5) like video spills to V2/V3', () => {
    const specs = materializeSceneAudio(
      scene({
        sfx: [
          { id: 'rain', triggerAt: 0, duration: 4 }, // 0–4
          { id: 'boom', triggerAt: 1, duration: 0.5 }, // 1–1.5 overlaps rain → a4
          { id: 'coin', triggerAt: 2, duration: 0.2 }, // 2–2.2 overlaps rain, free of boom → a4
          { id: 'zap', triggerAt: 1.2, duration: 0.5 }, // 1.2–1.7 overlaps rain AND boom → a5
        ],
      }),
    )
    const laneOf = (id: string) => specs.find((s) => s.sourceId === id)?.lane
    expect(laneOf('rain')).toBe('a3')
    expect(laneOf('boom')).toBe('a4') // can't share a3 (rain spans it)
    expect(laneOf('zap')).toBe('a5') // overlaps rain (a3) + boom (a4)
    expect(laneOf('coin')).toBe('a4') // boom ended at 1.5, so a4 is free at 2
  })

  it('keeps NON-overlapping SFX all on a3 (no needless extra tracks)', () => {
    const specs = materializeSceneAudio(
      scene({
        sfx: [
          { id: 's1', triggerAt: 0, duration: 1 }, // 0–1
          { id: 's2', triggerAt: 1, duration: 1 }, // 1–2 touches s1 (end==start) → shares a3
          { id: 's3', triggerAt: 5, duration: 1 }, // 5–6 → a3
        ],
      }),
    )
    expect(specs.map((s) => s.lane)).toEqual(['a3', 'a3', 'a3'])
  })

  it('a full audioLayer emits every lane in stable order: aud, tts, music, sfx', () => {
    const specs = materializeSceneAudio(
      scene({
        enabled: true,
        src: '/a.mp3',
        startOffset: 1,
        tts: { text: 'hi', duration: 3 },
        music: { src: '/m.mp3' },
        sfx: [{ id: 'x', src: '/x.wav', triggerAt: 0 }],
      }),
    )
    expect(specs.map((s) => `${s.lane}:${s.sourceId}`)).toEqual([
      'a1:aud-scene-1',
      'a1:tts-scene-1',
      'a2:mus-scene-1',
      'a3:x',
    ])
    // Shared startOffset applies to aud/tts/music; SFX use their own triggers.
    expect(specs.slice(0, 3).map((s) => s.offset)).toEqual([1, 1, 1])
    expect(specs[3].offset).toBe(0)
  })

  it('clamps a startOffset past the scene end', () => {
    const specs = materializeSceneAudio(scene({ enabled: true, src: '/a.mp3', startOffset: 99 }))
    expect(specs[0].offset).toBe(10)
    expect(specs[0].duration).toBe(0.1) // floor
  })

  // E2 — narration dedupe. Both narration paths write the same URL into BOTH
  // al.src AND al.tts.src; without dedupe every narrated scene got TWO A1 clips.
  describe('E2 narration same-src dedupe', () => {
    it('emits ONE A1 clip (tts) when al.src === al.tts.src', () => {
      const specs = materializeSceneAudio(
        scene({ enabled: true, src: '/narration.mp3', tts: { src: '/narration.mp3' } }),
      )
      const a1 = specs.filter((s) => s.lane === 'a1')
      expect(a1).toHaveLength(1)
      // The tts spec wins — it carries narration semantics (reuse:'position').
      expect(a1[0].sourceId).toBe('tts-scene-1')
      expect(a1[0].reuse).toBe('position')
    })

    it('emits TWO A1 clips when file src and tts src are genuinely distinct', () => {
      const specs = materializeSceneAudio(scene({ enabled: true, src: '/file.mp3', tts: { src: '/narration.mp3' } }))
      const a1 = specs.filter((s) => s.lane === 'a1')
      expect(a1.map((s) => s.sourceId)).toEqual(['aud-scene-1', 'tts-scene-1'])
    })

    it('emits the aud clip for genuine file audio with text-only TTS (no tts.src)', () => {
      const specs = materializeSceneAudio(scene({ enabled: true, src: '/file.mp3', tts: { text: 'spoken' } }))
      const a1 = specs.filter((s) => s.lane === 'a1')
      expect(a1.map((s) => s.sourceId)).toEqual(['aud-scene-1', 'tts-scene-1'])
    })

    it('still emits the file clip when there is no TTS at all (regression)', () => {
      const specs = materializeSceneAudio(scene({ enabled: true, src: '/file.mp3' }))
      expect(specs.map((s) => s.sourceId)).toEqual(['aud-scene-1'])
    })
  })
})
