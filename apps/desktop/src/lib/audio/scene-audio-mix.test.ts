import { describe, it, expect } from 'vitest'
import { resolveSceneAudioMix } from './scene-audio-mix'
import type { Scene, Track } from '@/lib/types'

function track(over: {
  id: string
  clips: { sourceId: string }[]
  volume?: number
  muted?: boolean
  solo?: boolean
  pan?: number
}): Track {
  return {
    id: over.id,
    name: over.id,
    type: 'audio',
    muted: over.muted ?? false,
    locked: false,
    position: 0,
    solo: over.solo,
    volume: over.volume,
    pan: over.pan,
    clips: over.clips as any,
  } as Track
}

function scene(id: string, sfxIds: string[] = []): Scene {
  return { id, audioLayer: { sfx: sfxIds.map((sid) => ({ id: sid })) } } as unknown as Scene
}

// A1 = aud-/tts-, A2 = mus-, A3 = sfx (bare id)
const tracksFor = (sceneId: string, sfxIds: string[] = []): Track[] => [
  track({ id: 'A1', clips: [{ sourceId: `aud-${sceneId}` }, { sourceId: `tts-${sceneId}` }] }),
  track({ id: 'A2', clips: [{ sourceId: `mus-${sceneId}` }] }),
  track({ id: 'A3', clips: sfxIds.map((sid) => ({ sourceId: sid })) }),
]

describe('resolveSceneAudioMix', () => {
  it('passes through unity when tracks are default', () => {
    const mix = resolveSceneAudioMix(scene('s1'), tracksFor('s1'), null)
    expect(mix.tts.trackGain).toBe(1)
    expect(mix.tts.drop).toBe(false)
    expect(mix.tts.pan).toBe(0)
  })

  it('folds track.volume into trackGain', () => {
    const tracks = tracksFor('s1')
    tracks[1].volume = 0.5 // A2 = music
    const mix = resolveSceneAudioMix(scene('s1'), tracks, null)
    expect(mix.music.trackGain).toBeCloseTo(0.5)
    expect(mix.tts.trackGain).toBe(1) // A1 unaffected
  })

  it('folds project master volume into every category', () => {
    const mix = resolveSceneAudioMix(scene('s1'), tracksFor('s1'), 0.5)
    expect(mix.tts.trackGain).toBeCloseTo(0.5)
    expect(mix.music.trackGain).toBeCloseTo(0.5)
  })

  it('multiplies track volume and master together', () => {
    const tracks = tracksFor('s1')
    tracks[1].volume = 0.5
    const mix = resolveSceneAudioMix(scene('s1'), tracks, 0.5)
    expect(mix.music.trackGain).toBeCloseTo(0.25)
  })

  it('a muted track drops its category', () => {
    const tracks = tracksFor('s1')
    tracks[0].muted = true // A1 → tts + file
    const mix = resolveSceneAudioMix(scene('s1'), tracks, null)
    expect(mix.tts.drop).toBe(true)
    expect(mix.tts.trackGain).toBe(0)
    expect(mix.file.drop).toBe(true)
    expect(mix.music.drop).toBe(false) // A2 untouched
  })

  it('global solo drops every non-soloed category', () => {
    const tracks = tracksFor('s1')
    tracks[1].solo = true // only A2 (music) soloed
    const mix = resolveSceneAudioMix(scene('s1'), tracks, null)
    expect(mix.music.drop).toBe(false) // soloed → kept
    expect(mix.music.trackGain).toBe(1)
    expect(mix.tts.drop).toBe(true) // not soloed → dropped
    expect(mix.file.drop).toBe(true)
  })

  it('A1 narration and file audio share the same lane track', () => {
    const tracks = tracksFor('s1')
    tracks[0].volume = 0.3
    tracks[0].pan = -1
    const mix = resolveSceneAudioMix(scene('s1'), tracks, null)
    expect(mix.tts.trackGain).toBeCloseTo(0.3)
    expect(mix.file.trackGain).toBeCloseTo(0.3)
    expect(mix.tts.pan).toBe(-1)
    expect(mix.file.pan).toBe(-1)
  })

  it('passes pan through, clamped to [-1, 1]', () => {
    const tracks = tracksFor('s1')
    tracks[1].pan = 5 // out of range
    const mix = resolveSceneAudioMix(scene('s1'), tracks, null)
    expect(mix.music.pan).toBe(1)
  })

  it('resolves each SFX against the A3 track by id', () => {
    const tracks = tracksFor('s1', ['fx-a', 'fx-b'])
    tracks[2].volume = 0.25
    const mix = resolveSceneAudioMix(scene('s1', ['fx-a', 'fx-b']), tracks, null)
    expect(mix.sfx['fx-a'].trackGain).toBeCloseTo(0.25)
    expect(mix.sfx['fx-b'].trackGain).toBeCloseTo(0.25)
  })

  it('a category not on any track resolves to master-only, not dropped', () => {
    // No tracks at all → no clip found for any category.
    const mix = resolveSceneAudioMix(scene('s1'), [], 0.5)
    expect(mix.tts.drop).toBe(false)
    expect(mix.tts.trackGain).toBeCloseTo(0.5) // master applies, track unity
    expect(mix.tts.pan).toBe(0)
  })

  // Per-clip mute (clip.audioMuted) — preview silences just that clip; export must match.
  it('drops a per-clip-muted narration clip even when its track is NOT muted', () => {
    const tracks: Track[] = [
      track({ id: 'A1', clips: [{ sourceId: 'tts-s1', audioMuted: true } as any, { sourceId: 'aud-s1' } as any] }),
      track({ id: 'A2', clips: [{ sourceId: 'mus-s1' }] }),
    ]
    const mix = resolveSceneAudioMix(scene('s1'), tracks, null)
    expect(mix.tts.drop).toBe(true)
    expect(mix.tts.trackGain).toBe(0)
    expect(mix.file.drop).toBe(false) // the unmuted file clip on the same track is unaffected
    expect(mix.music.drop).toBe(false)
  })

  it('drops only the per-clip-muted SFX, not its siblings', () => {
    const tracks: Track[] = [
      track({ id: 'A3', clips: [{ sourceId: 'fx1', audioMuted: true } as any, { sourceId: 'fx2' } as any] }),
    ]
    const mix = resolveSceneAudioMix(scene('s1', ['fx1', 'fx2']), tracks, null)
    expect(mix.sfx.fx1.drop).toBe(true)
    expect(mix.sfx.fx1.trackGain).toBe(0)
    expect(mix.sfx.fx2.drop).toBe(false)
  })

  // ── D3 / T15 no-double-bake guard ──
  //
  // Avatar voice is overlaid via the program-audio bus at export (D3); for that
  // to be safe the per-scene mixer must NEVER also bake avatar audio, or the
  // voice would double-play. The per-scene mixers read ONLY `scene.audioLayer`
  // and `resolveSceneAudioMix` resolves only tts/file/music/sfx lanes — there is
  // no avatar lane. This guard PINS that. If someone later adds avatar baking
  // per-scene, this test fails and forces them to also remove the program-audio
  // inclusion (src/lib/audio/program-audio.ts AVATAR_AUDIO_RE) — they can't have both.
  it('GUARD: the per-scene mix has NO avatar lane and ignores avatar-audio clips', () => {
    // The SceneAudioMix shape is exactly {tts,file,music,sfx} — no avatar key.
    const mix = resolveSceneAudioMix(scene('s1'), tracksFor('s1'), null)
    expect(Object.keys(mix).sort()).toEqual(['file', 'music', 'sfx', 'tts'])
    expect((mix as unknown as Record<string, unknown>).avatar).toBeUndefined()

    // Even with an avatar-audio clip placed on a track, the resolver never picks
    // it up (it only queries tts-/aud-/mus-/<sfxId> source ids), so nothing about
    // the avatar voice reaches the per-scene bake.
    const tracksWithAvatar: Track[] = [
      ...tracksFor('s1'),
      track({ id: 'AV', clips: [{ sourceId: 'avatar-audio:av1' } as any] }),
    ]
    const mix2 = resolveSceneAudioMix(scene('s1'), tracksWithAvatar, null)
    expect(Object.keys(mix2).sort()).toEqual(['file', 'music', 'sfx', 'tts'])
    expect(JSON.stringify(mix2)).not.toContain('avatar-audio')
  })
})
