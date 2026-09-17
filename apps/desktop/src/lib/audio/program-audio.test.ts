import { describe, it, expect } from 'vitest'
import {
  buildProgramAudioClips,
  isStandaloneAudioClip,
  isSceneMirrorAudioClip,
  clipContributesProgramAudio,
} from './program-audio'
import type { Clip, Timeline } from '@/lib/types'

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c1',
    trackId: 'A1',
    sourceType: 'audio',
    sourceId: '/uploads/music.mp3',
    label: 'm',
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

function tl(tracks: Partial<Timeline['tracks'][number]>[]): Timeline {
  return {
    tracks: tracks.map((t, i) => ({
      id: t.id ?? `T${i}`,
      name: t.id ?? `T${i}`,
      type: t.type ?? 'audio',
      clips: t.clips ?? [],
      muted: t.muted ?? false,
      locked: false,
      position: t.position ?? i,
      solo: t.solo,
      volume: t.volume,
    })),
  } as Timeline
}

describe('standalone vs scene-mirror predicates', () => {
  it('standalone = audio clip whose sourceId is a media URL', () => {
    expect(isStandaloneAudioClip(clip({ sourceId: '/uploads/a.mp3' }))).toBe(true)
    expect(isStandaloneAudioClip(clip({ sourceId: 'tts-scene1' }))).toBe(false)
    expect(isStandaloneAudioClip(clip({ sourceType: 'scene', sourceId: 'scene1' }))).toBe(false)
  })
  it('scene-mirror = aud-/tts-/mus-/avatar-audio prefixes', () => {
    for (const id of ['aud-s', 'tts-s', 'mus-s', 'avatar-audio:x']) {
      expect(isSceneMirrorAudioClip(clip({ sourceId: id }))).toBe(true)
    }
    expect(isSceneMirrorAudioClip(clip({ sourceId: '/uploads/a.mp3' }))).toBe(false)
  })

  // T4 / A2 — embedded video audio joins the program bus.
  it('clipContributesProgramAudio: audio-standalone ✓, video ✓ (emit-all), image ✗, scene ✗', () => {
    expect(clipContributesProgramAudio(clip({ sourceType: 'audio', sourceId: '/u/a.mp3' }))).toBe(true)
    expect(clipContributesProgramAudio(clip({ sourceType: 'video', sourceId: '/u/v.mp4' }))).toBe(true)
    // a silent video still returns true — we cannot probe purely; ffmpeg amix no-ops it (OV-3b/c)
    expect(clipContributesProgramAudio(clip({ sourceType: 'video', sourceId: '/u/silent.mp4' }))).toBe(true)
    expect(clipContributesProgramAudio(clip({ sourceType: 'image', sourceId: '/u/p.png' }))).toBe(false)
    expect(clipContributesProgramAudio(clip({ sourceType: 'scene', sourceId: 's1' }))).toBe(false)
  })
})

describe('buildProgramAudioClips — embedded video audio (A2 / T4)', () => {
  it('a bare video clip on a video track becomes a program source (src = the mp4)', () => {
    const out = buildProgramAudioClips(
      tl([
        {
          id: 'V1',
          type: 'video',
          clips: [clip({ id: 'v', sourceType: 'video', sourceId: '/uploads/foot.mp4', startTime: 0, duration: 6 })],
        },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ src: '/uploads/foot.mp4', startTime: 0, duration: 6 })
  })

  it("a video clip's VISUAL opacity does NOT gate its audio (full clip gain)", () => {
    const out = buildProgramAudioClips(
      tl([
        {
          id: 'V1',
          type: 'video',
          volume: 1,
          clips: [clip({ sourceType: 'video', sourceId: '/u/v.mp4', opacity: 0.25 })],
        },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0].gain).toBeCloseTo(1) // opacity 0.25 is visual; audio stays full
  })

  it('respects audioMuted / track mute / track volume on a video clip', () => {
    expect(
      buildProgramAudioClips(
        tl([
          { id: 'V1', type: 'video', clips: [clip({ sourceType: 'video', sourceId: '/u/v.mp4', audioMuted: true })] },
        ]),
      ),
    ).toEqual([])
    expect(
      buildProgramAudioClips(
        tl([{ id: 'V1', type: 'video', muted: true, clips: [clip({ sourceType: 'video', sourceId: '/u/v.mp4' })] }]),
      ),
    ).toEqual([])
    const half = buildProgramAudioClips(
      tl([{ id: 'V1', type: 'video', volume: 0.5, clips: [clip({ sourceType: 'video', sourceId: '/u/v.mp4' })] }]),
    )
    expect(half[0].gain).toBeCloseTo(0.5)
  })

  it('de-dupes the SAME file at the SAME position across a video clip + an audio clip (OV-3a)', () => {
    // user drops a video AND manually puts the same file on an audio track at the same spot.
    const out = buildProgramAudioClips(
      tl([
        {
          id: 'V1',
          type: 'video',
          position: 0,
          clips: [clip({ id: 'v', sourceType: 'video', sourceId: '/u/x.mp4', startTime: 2, duration: 5 })],
        },
        {
          id: 'A1',
          type: 'audio',
          position: 1,
          clips: [clip({ id: 'a', sourceType: 'audio', sourceId: '/u/x.mp4', startTime: 2, duration: 5 })],
        },
      ]),
    )
    expect(out).toHaveLength(1) // one source, not +6dB
  })

  it('the SAME file at DIFFERENT positions stays TWO sources (a reused clip is real)', () => {
    const out = buildProgramAudioClips(
      tl([
        {
          id: 'A1',
          type: 'audio',
          clips: [
            clip({ id: 'a', sourceType: 'audio', sourceId: '/u/sfx.mp3', startTime: 0, duration: 1 }),
            clip({ id: 'b', sourceType: 'audio', sourceId: '/u/sfx.mp3', startTime: 5, duration: 1 }),
          ],
        },
      ]),
    )
    expect(out).toHaveLength(2)
  })

  it('same file + same position but DIFFERENT trimStart stays TWO sources (key includes trim/speed — review F3)', () => {
    const out = buildProgramAudioClips(
      tl([
        {
          id: 'A1',
          type: 'audio',
          clips: [
            clip({ id: 'a', sourceType: 'audio', sourceId: '/u/x.mp3', startTime: 2, duration: 5, trimStart: 0 }),
            clip({ id: 'b', sourceType: 'audio', sourceId: '/u/x.mp3', startTime: 2, duration: 5, trimStart: 10 }),
          ],
        },
      ]),
    )
    expect(out).toHaveLength(2) // different in-points → genuinely different sources, not a dup
  })

  it('an image clip never contributes audio', () => {
    expect(
      buildProgramAudioClips(
        tl([{ id: 'V1', type: 'video', clips: [clip({ sourceType: 'image', sourceId: '/u/p.png' })] }]),
      ),
    ).toEqual([])
  })
})

describe('buildProgramAudioClips', () => {
  it('returns standalone clips with timing + constant gain', () => {
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [clip({ startTime: 3, duration: 5, trimStart: 1, opacity: 0.5 })] }]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ src: '/uploads/music.mp3', startTime: 3, duration: 5, trimStart: 1, gain: 0.5 })
  })

  it('folds track volume into the per-clip gain', () => {
    const out = buildProgramAudioClips(tl([{ id: 'A1', volume: 0.5, clips: [clip({ opacity: 1 })] }]))
    expect(out[0].gain).toBeCloseTo(0.5, 10)
  })

  it('drops scene-mirror clips (they are baked into scene MP4s)', () => {
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [clip({ sourceId: 'tts-s1' }), clip({ id: 'c2', sourceId: '/uploads/x.mp3' })] }]),
    )
    expect(out).toHaveLength(1)
    expect(out[0].src).toBe('/uploads/x.mp3')
  })

  it('respects track mute (silenced clips are dropped, not emitted at 0)', () => {
    const out = buildProgramAudioClips(tl([{ id: 'A1', muted: true, clips: [clip({})] }]))
    expect(out).toHaveLength(0)
  })

  it('respects AUDIO solo (non-soloed audio tracks drop out)', () => {
    const out = buildProgramAudioClips(
      tl([
        { id: 'A1', clips: [clip({ id: 'a', sourceId: '/u/a.mp3' })] },
        { id: 'A2', solo: true, clips: [clip({ id: 'b', sourceId: '/u/b.mp3' })] },
      ]),
    )
    expect(out.map((c) => c.src)).toEqual(['/u/b.mp3'])
  })

  it('a soloed VIDEO track does NOT silence audio (solo is scoped to the audio bus)', () => {
    // Regression: soloing a video clip used to make anySolo true across all
    // tracks, dropping every non-solo audio track → audio silent in preview,
    // mixer, AND export. Video solo is a visual-only action.
    const out = buildProgramAudioClips(
      tl([
        { id: 'V1', type: 'video', solo: true, clips: [clip({ id: 'sc', sourceType: 'scene', sourceId: 'scene1' })] },
        { id: 'A1', clips: [clip({ id: 'm', sourceId: '/u/music.mp3' })] },
      ]),
    )
    expect(out.map((c) => c.src)).toEqual(['/u/music.mp3'])
  })

  it('includes standalone clips that ride a video track (linked audio)', () => {
    const out = buildProgramAudioClips(tl([{ id: 'V1', type: 'video', clips: [clip({ sourceId: '/u/v.mp3' })] }]))
    expect(out).toHaveLength(1)
  })

  it('null timeline → empty', () => {
    expect(buildProgramAudioClips(null)).toEqual([])
  })

  it('excludes scene SFX (bare id) via the scene-mirror set (#2)', () => {
    const mirror = new Map([['sfx-abc', '/media/sfx.wav']]) // url-map keys = scene-mirror ids
    const out = buildProgramAudioClips(
      tl([
        { id: 'A1', clips: [clip({ id: 'fx', sourceId: 'sfx-abc' }), clip({ id: 's2', sourceId: '/uploads/x.mp3' })] },
      ]),
      mirror,
    )
    expect(out.map((c) => c.src)).toEqual(['/uploads/x.mp3'])
  })

  it('predicate: bare-id clip is scene-mirror only when the mirror set knows it', () => {
    const c = clip({ sourceId: 'sfx-abc' })
    expect(isStandaloneAudioClip(c)).toBe(true) // no mirror set → looks standalone
    expect(isStandaloneAudioClip(c, new Map([['sfx-abc', '/x']]))).toBe(false)
    expect(isSceneMirrorAudioClip(c, new Map([['sfx-abc', '/x']]))).toBe(true)
  })

  it('carries a sampled gain envelope for clips with gain keyframes (#10)', () => {
    const c = clip({
      duration: 4,
      opacity: 1,
      keyframes: [
        { time: 0, property: 'gain', value: 0, easing: 'linear' },
        { time: 4, property: 'gain', value: 1, easing: 'linear' },
      ],
    })
    const out = buildProgramAudioClips(tl([{ id: 'A1', volume: 1, clips: [c] }]))
    const env = out[0].gainEnvelope
    expect(env).toBeDefined()
    expect(env![0]).toMatchObject({ t: 0, v: 0 })
    expect(env![env!.length - 1].v).toBeCloseTo(1, 5)
  })

  it('folds track volume into the envelope samples', () => {
    const c = clip({
      duration: 2,
      opacity: 1,
      keyframes: [{ time: 0, property: 'gain', value: 1, easing: 'linear' }],
    })
    const out = buildProgramAudioClips(tl([{ id: 'A1', volume: 0.5, clips: [c] }]))
    // env value = clipBaseGain(opacity=1, gain=1) * trackVol(0.5) = 0.5
    expect(out[0].gainEnvelope!.every((p) => Math.abs(p.v - 0.5) < 1e-6)).toBe(true)
  })

  it('no envelope field for clips without gain keyframes', () => {
    const out = buildProgramAudioClips(tl([{ id: 'A1', clips: [clip({})] }]))
    expect(out[0].gainEnvelope).toBeUndefined()
  })
})

// ── Single-stream export folds scene audio onto the program bus ──
//
// In the single-stream composite there are no
// per-scene MP4s, so scene audio (tts/music/sfx) is no longer baked — its mirror
// clips must ride the program bus at clip.startTime, resolved id→file via the
// url-map. Default (no flag) keeps the legacy per-scene-bake behavior.
describe('buildProgramAudioClips — includeSceneMirror (single-stream export)', () => {
  const urlMap = () =>
    new Map([
      ['tts-s1', '/audio/tts-s1.wav'],
      ['mus-s1', '/audio/mus-s1.mp3'],
      ['sfx-x', '/audio/sfx-x.wav'],
    ])

  it('default: scene-mirror clips are excluded (per-scene bake owns them)', () => {
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [clip({ id: 't', sourceId: 'tts-s1' }), clip({ id: 's', sourceId: '/u/x.mp3' })] }]),
      urlMap(),
    )
    expect(out.map((c) => c.src)).toEqual(['/u/x.mp3'])
  })

  it('includeSceneMirror: tts/music ride the bus at startTime, resolved via the url-map', () => {
    const out = buildProgramAudioClips(
      tl([
        { id: 'A1', clips: [clip({ id: 't', sourceId: 'tts-s1', startTime: 4, duration: 6, opacity: 0.8 })] },
        { id: 'A2', clips: [clip({ id: 'm', sourceId: 'mus-s1', startTime: 0, duration: 12 })] },
      ]),
      urlMap(),
      null,
      undefined,
      { includeSceneMirror: true },
    )
    expect(out).toHaveLength(2)
    expect(out.find((c) => c.src === '/audio/tts-s1.wav')).toMatchObject({ startTime: 4, duration: 6, gain: 0.8 })
    expect(out.find((c) => c.src === '/audio/mus-s1.mp3')).toMatchObject({ startTime: 0, duration: 12 })
  })

  it('includeSceneMirror: a bare-id SFX (known to the url-map) is included and resolved', () => {
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [clip({ id: 'fx', sourceId: 'sfx-x', startTime: 2, duration: 1 })] }]),
      urlMap(),
      null,
      undefined,
      { includeSceneMirror: true },
    )
    expect(out.map((c) => c.src)).toEqual(['/audio/sfx-x.wav'])
  })

  it('includeSceneMirror: an unresolvable mirror id is skipped (no silent fake)', () => {
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [clip({ id: 't', sourceId: 'tts-missing', startTime: 0, duration: 5 })] }]),
      urlMap(), // does not contain tts-missing
      null,
      undefined,
      { includeSceneMirror: true },
    )
    expect(out).toEqual([])
  })

  it('includeSceneMirror with a bare Set (no .get) does not throw — clips just stay unresolved', () => {
    const bareSet = new Set(['tts-s1']) // {has} only, the docstring-permitted shape
    expect(() =>
      buildProgramAudioClips(
        tl([{ id: 'A1', clips: [clip({ id: 't', sourceId: 'tts-s1' }), clip({ id: 's', sourceId: '/u/x.mp3' })] }]),
        bareSet,
        null,
        undefined,
        { includeSceneMirror: true },
      ),
    ).not.toThrow()
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [clip({ id: 't', sourceId: 'tts-s1' }), clip({ id: 's', sourceId: '/u/x.mp3' })] }]),
      bareSet,
      null,
      undefined,
      { includeSceneMirror: true },
    )
    // tts-s1 is recognized as scene-mirror (Set.has) but unresolvable (no .get) → skipped; standalone survives.
    expect(out.map((c) => c.src)).toEqual(['/u/x.mp3'])
  })

  it('includeSceneMirror still honors mute/solo and standalone clips', () => {
    const out = buildProgramAudioClips(
      tl([
        { id: 'A1', muted: true, clips: [clip({ id: 't', sourceId: 'tts-s1' })] },
        { id: 'A2', clips: [clip({ id: 's', sourceId: '/u/x.mp3' }), clip({ id: 'm', sourceId: 'mus-s1' })] },
      ]),
      urlMap(),
      null,
      undefined,
      { includeSceneMirror: true },
    )
    // muted track drops tts; A2 keeps the standalone + the resolved music mirror
    expect(out.map((c) => c.src).sort()).toEqual(['/audio/mus-s1.mp3', '/u/x.mp3'])
  })
})

// ── D3 / T15: avatar voice rides the program-audio overlay at export ──
//
// HeyGen avatar voice lives INSIDE the video file (the scene <video> is muted)
// and is NOT baked by the per-scene mixer — so the export overlay must carry it,
// resolving the avatar-audio mirror id to the video URL (ffmpeg extracts audio).
describe('buildProgramAudioClips — avatar voice inclusion (D3)', () => {
  const avScene = (over: Partial<import('@/lib/types').Scene> = {}): import('@/lib/types').Scene =>
    ({
      id: 's1',
      duration: 6,
      aiLayers: [],
      ...over,
    }) as import('@/lib/types').Scene

  it('includes an existing avatar-audio mirror clip, resolved to its video URL', () => {
    const mirror = new Map([['avatar-audio:av1', 'https://heygen/clip.mp4']])
    const out = buildProgramAudioClips(
      tl([
        { id: 'A1', clips: [clip({ id: 'm', sourceId: 'avatar-audio:av1', startTime: 2, duration: 6, opacity: 1 })] },
      ]),
      mirror,
      null,
      [
        avScene({
          aiLayers: [
            { id: 'av1', type: 'avatar', status: 'ready', videoUrl: 'https://heygen/clip.mp4', startAt: 2 } as any,
          ],
        }),
      ],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ src: 'https://heygen/clip.mp4', startTime: 2, duration: 6 })
  })

  it('EXCLUDES a lipsync avatar mirror — its voice is a separate baked SFX (v6 review P1, no double-play)', () => {
    const mirror = new Map([['avatar-audio:av1', 'https://fal/lipsync.mp4']])
    // The scene carries a `lipsync-av1` SFX (voice baked per-scene); the mirror
    // clip must NOT also ride the overlay, or the narration plays twice.
    const out = buildProgramAudioClips(
      tl([
        { id: 'A1', clips: [clip({ id: 'm', sourceId: 'avatar-audio:av1', startTime: 0, duration: 6, opacity: 1 })] },
      ]),
      mirror,
      null,
      [
        avScene({
          audioLayer: { sfx: [{ id: 'lipsync-av1', src: 'https://fal/voice.mp3', triggerAt: 0, volume: 1 }] } as any,
          aiLayers: [
            { id: 'av1', type: 'avatar', status: 'ready', videoUrl: 'https://fal/lipsync.mp4', startAt: 0 } as any,
          ],
        }),
      ],
    )
    expect(out).toHaveLength(0)
  })

  it('EXCLUDES a lipsync avatar from OV#9 synthesis too (no mirror clip, still no double-play)', () => {
    const out = buildProgramAudioClips(tl([{ id: 'A1', clips: [] }]), new Map(), null, [
      avScene({
        audioLayer: { sfx: [{ id: 'lipsync-av1', src: 'https://fal/voice.mp3', triggerAt: 0, volume: 1 }] } as any,
        aiLayers: [
          {
            id: 'av1',
            type: 'avatar',
            status: 'ready',
            videoUrl: 'https://fal/lipsync.mp4',
            startAt: 0,
            estimatedDuration: 6,
          } as any,
        ],
      }),
    ])
    expect(out).toHaveLength(0)
  })

  it('carries the mirror clip timing/gain (startAt + duration) correctly', () => {
    const mirror = new Map([['avatar-audio:av1', 'https://heygen/clip.mp4']])
    const out = buildProgramAudioClips(
      tl([
        {
          id: 'A1',
          volume: 0.5,
          clips: [clip({ sourceId: 'avatar-audio:av1', startTime: 3, duration: 4, opacity: 1 })],
        },
      ]),
      mirror,
      null,
      [avScene()],
    )
    expect(out[0].startTime).toBe(3)
    expect(out[0].duration).toBe(4)
    expect(out[0].gain).toBeCloseTo(0.5, 10) // track fader folded in
  })

  it('synthesizes the overlay clip from a READY avatar layer when no mirror clip exists (OV#9)', () => {
    const mirror = new Map([['avatar-audio:av1', 'https://heygen/clip.mp4']])
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [] }]), // no avatar-audio clip on the timeline
      mirror,
      null,
      [
        avScene({
          aiLayers: [
            {
              id: 'av1',
              type: 'avatar',
              status: 'ready',
              videoUrl: 'https://heygen/clip.mp4',
              startAt: 1,
              estimatedDuration: 5,
            } as any,
          ],
        }),
      ],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ src: 'https://heygen/clip.mp4', startTime: 1, duration: 5, gain: 1 })
  })

  it('does NOT double-emit: a layer WITH a mirror clip is overlaid once, not twice', () => {
    const mirror = new Map([['avatar-audio:av1', 'https://heygen/clip.mp4']])
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [clip({ sourceId: 'avatar-audio:av1', startTime: 2, duration: 6, opacity: 1 })] }]),
      mirror,
      null,
      [
        avScene({
          aiLayers: [
            {
              id: 'av1',
              type: 'avatar',
              status: 'ready',
              videoUrl: 'https://heygen/clip.mp4',
              startAt: 2,
              estimatedDuration: 6,
            } as any,
          ],
        }),
      ],
    )
    expect(out.filter((c) => c.src === 'https://heygen/clip.mp4')).toHaveLength(1)
  })

  it('skips a non-ready avatar layer and an unresolvable mirror id (no silent fake)', () => {
    const out = buildProgramAudioClips(
      tl([{ id: 'A1', clips: [clip({ sourceId: 'avatar-audio:noresolve', duration: 4 })] }]),
      new Map(), // empty url-map → avatar-audio:noresolve has no URL
      null,
      [
        avScene({
          aiLayers: [{ id: 'pending', type: 'avatar', status: 'processing', videoUrl: null, startAt: 0 } as any],
        }),
      ],
    )
    expect(out).toHaveLength(0)
  })

  it('REGRESSION: tts/music/sfx scene mirrors stay excluded; standalone music unchanged', () => {
    const mirror = new Map([
      ['tts-s1', '/tts.mp3'],
      ['mus-s1', '/music.mp3'],
      ['sfx-1', '/sfx.wav'],
    ])
    const out = buildProgramAudioClips(
      tl([
        {
          id: 'A1',
          clips: [
            clip({ id: 'a', sourceId: 'tts-s1' }),
            clip({ id: 'b', sourceId: 'mus-s1' }),
            clip({ id: 'c', sourceId: 'sfx-1' }),
            clip({ id: 'd', sourceId: '/uploads/standalone.mp3' }),
          ],
        },
      ]),
      mirror,
      null,
      [avScene()], // no avatar layers
    )
    expect(out.map((c) => c.src)).toEqual(['/uploads/standalone.mp3'])
  })
})
