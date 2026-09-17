// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { clipVolumeAt, TimelineAudioEngine } from './timeline-audio-engine'
import type { Clip, Timeline } from '@/lib/types'

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'a1',
    trackId: 'A1',
    sourceType: 'audio',
    sourceId: '/uploads/music.mp3',
    label: 'music',
    startTime: 0,
    duration: 10,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...over,
  } as Clip
}

describe('clipVolumeAt', () => {
  it('defaults to the clip volume slot with no envelope', () => {
    expect(clipVolumeAt(clip({ opacity: 0.7 }), 3)).toBeCloseTo(0.7, 5)
  })

  it('applies the gain rubber-band envelope (interpolated, may exceed unity)', () => {
    const c = clip({
      keyframes: [
        { time: 0, property: 'gain', value: 0, easing: 'linear' },
        { time: 4, property: 'gain', value: 2, easing: 'linear' },
      ],
    })
    expect(clipVolumeAt(c, 0)).toBeCloseTo(0, 5)
    expect(clipVolumeAt(c, 2)).toBeCloseTo(1, 5)
    expect(clipVolumeAt(c, 4)).toBeCloseTo(2, 5) // +6 dB boost survives
  })

  it('non-gain keyframes (opacity, x) do not affect volume', () => {
    const c = clip({ keyframes: [{ time: 0, property: 'opacity', value: 0, easing: 'linear' }] })
    expect(clipVolumeAt(c, 1)).toBeCloseTo(1, 5)
  })
})

describe('TimelineAudioEngine.sync', () => {
  const timeline = (clips: Clip[]): Timeline =>
    ({
      tracks: [{ id: 'A1', name: 'A1', type: 'audio', clips, muted: false, locked: false, position: 0 }],
    }) as Timeline

  it('is inert while paused (no AudioContext, no voices) — jsdom-safe', () => {
    const engine = new TimelineAudioEngine()
    engine.sync(timeline([clip({})]), { globalTime: 2, isPlaying: false })
    expect(engine.hasActiveVoices()).toBe(false)
    expect(engine.getLevel()).toBe(0)
  })

  it('skips scene-mirrored audio clips (aud-/tts-/mus- prefixes) even when playing', () => {
    const engine = new TimelineAudioEngine()
    // Only mirror clips active → wanted stays empty → no AudioContext needed.
    engine.sync(
      timeline([
        clip({ id: 'm1', sourceId: 'aud-scene1' }),
        clip({ id: 'm2', sourceId: 'tts-scene1' }),
        clip({ id: 'm3', sourceId: 'mus-scene1' }),
      ]),
      { globalTime: 2, isPlaying: true },
    )
    expect(engine.hasActiveVoices()).toBe(false)
  })

  it('respects track mute and clip bounds without instantiating audio', () => {
    const engine = new TimelineAudioEngine()
    const tl = timeline([clip({ startTime: 5, duration: 3 })])
    tl.tracks[0].muted = true
    engine.sync(tl, { globalTime: 6, isPlaying: true })
    expect(engine.hasActiveVoices()).toBe(false)
    tl.tracks[0].muted = false
    // Out of clip bounds
    engine.sync(tl, { globalTime: 20, isPlaying: true })
    expect(engine.hasActiveVoices()).toBe(false)
  })
})

/**
 * T11 — PR-1 regression contract: the unified-graph refactor must NOT change
 * what plays today. Scene audio (tts/music/sfx/avatar) still belongs to the
 * scene iframe by default; the engine only takes it when explicitly granted,
 * and NEVER takes avatar speech. All assertions here keep the WANTED set empty
 * (resolves to no playable URL), so they need no AudioContext — jsdom-safe.
 */
describe('TimelineAudioEngine — T11 ownership regression contract', () => {
  const audioTrack = (clips: Clip[]): Timeline =>
    ({ tracks: [{ id: 'A1', name: 'A1', type: 'audio', clips, muted: false, locked: false, position: 0 }] }) as Timeline

  it('default: scene-mirror audio stays with the iframe (engine takes nothing) — incl avatar', () => {
    const engine = new TimelineAudioEngine()
    engine.sync(
      audioTrack([
        clip({ id: 'm1', sourceId: 'aud-s1' }),
        clip({ id: 'm2', sourceId: 'tts-s1' }),
        clip({ id: 'm3', sourceId: 'mus-s1' }),
        clip({ id: 'm4', sourceId: 'avatar-audio:av1' }),
      ]),
      { globalTime: 2, isPlaying: true },
      // No opts ⇒ ownsSceneAudio defaults false: behaviour identical to pre-PR-1.
    )
    expect(engine.hasActiveVoices()).toBe(false)
  })

  it('even with a URL map, scene audio is not taken unless ownsSceneAudio is granted', () => {
    const engine = new TimelineAudioEngine()
    const urls = new Map([['tts-s1', '/media/tts.mp3']])
    engine.sync(audioTrack([clip({ id: 'm2', sourceId: 'tts-s1' })]), { globalTime: 2, isPlaying: true }, {
      sceneAudioUrls: urls,
      ownsSceneAudio: false,
    })
    expect(engine.hasActiveVoices()).toBe(false)
  })

  it('avatar speech is excluded from engine ownership even when scene audio is granted', () => {
    const engine = new TimelineAudioEngine()
    const urls = new Map([['avatar-audio:av1', '/media/avatar.mp3']])
    engine.sync(audioTrack([clip({ id: 'm4', sourceId: 'avatar-audio:av1' })]), { globalTime: 2, isPlaying: true }, {
      sceneAudioUrls: urls,
      ownsSceneAudio: true,
      ownershipExceptions: new Set(['avatar-audio:av1']),
    })
    // Excluded → no playable URL → no voice → lipsync keeps owning its audio.
    expect(engine.hasActiveVoices()).toBe(false)
  })

  it('granted scene audio with no resolvable URL is a no-op (never throws, never doubles)', () => {
    const engine = new TimelineAudioEngine()
    engine.sync(audioTrack([clip({ id: 'm2', sourceId: 'tts-s1' })]), { globalTime: 2, isPlaying: true }, {
      sceneAudioUrls: new Map(), // url missing
      ownsSceneAudio: true,
    })
    expect(engine.hasActiveVoices()).toBe(false)
  })
})
