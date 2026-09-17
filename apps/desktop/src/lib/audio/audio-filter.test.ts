import { describe, it, expect } from 'vitest'
// The pure FFmpeg filtergraph builder lives in render-server (plain JS so
// audio-mixer.js can import it without a TS build). vitest excludes the
// render-server dir from test discovery but can still import its modules.
import { buildSceneAudioFilter } from '@dreambyte/render-server/audio-filter.js'

describe('buildSceneAudioFilter — CRITICAL regression (resolved=null → byte-identical legacy)', () => {
  it('tts + ducked music produces the exact pre-E1 filtergraph', () => {
    const out = buildSceneAudioFilter(
      {
        tts: { path: '/t.wav' },
        music: { path: '/m.mp3', volume: 0.12, loop: false, duckDuringTTS: true, duckLevel: 0.2 },
      },
      5,
      null,
    )
    expect(out).not.toBeNull()
    expect(out!.audioInputPaths).toEqual(['/t.wav', '/m.mp3'])
    expect(out!.audioOutLabel).toBe('aout')
    expect(out!.filterComplex).toBe(
      '[1:a]asplit=2[tts][tts_sc];' +
        '[2:a]volume=0.12[music_raw];' +
        '[music_raw][tts_sc]sidechaincompress=threshold=0.02:ratio=10:attack=100:release=500:level_in=1:level_sc=5.00[music];' +
        '[tts][music]amix=inputs=2:duration=longest:dropout_transition=2[aout]',
    )
  })

  it('single SFX track produces the exact pre-E1 apad graph', () => {
    const out = buildSceneAudioFilter({ sfx: [{ path: '/s.wav', triggerAt: 1, volume: 0.8 }] }, 3, null)
    expect(out!.filterComplex).toBe('[1:a]adelay=1000:all=1,volume=0.8[sfx0];[sfx0]apad=pad_dur=3[aout]')
  })

  it('tts-only (no ducking) uses acopy, exactly as before', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null)
    expect(out!.filterComplex).toBe('[1:a]acopy[tts];[tts]apad=pad_dur=5[aout]')
  })

  it('no audio → null', () => {
    expect(buildSceneAudioFilter({}, 5, null)).toBeNull()
    expect(buildSceneAudioFilter({ sfx: [] }, 5, null)).toBeNull()
  })
})

describe('buildSceneAudioFilter — E1 gain + ducking', () => {
  const resolved = (over: Record<string, any> = {}) => ({
    masterGain: 1,
    ttsGain: 1,
    musicGain: 1,
    sfxGain: 1,
    ...over,
    // deep-merge nested objects so a partial override keeps the other fields
    // (matches resolveAudioProcessing, which always fully populates these).
    normalize: { enabled: false, targetLufs: -14, ...(over.normalize ?? {}) },
    ducking: { enabled: false, duckLevel: 0.2, attackMs: 100, releaseMs: 500, ratio: 10, ...(over.ducking ?? {}) },
  })

  it('applies per-bus gains and a post-mix master gain', () => {
    const out = buildSceneAudioFilter(
      {
        tts: { path: '/t.wav' },
        music: { path: '/m.mp3', volume: 0.12, loop: false, duckDuringTTS: false },
      },
      4,
      resolved({ masterGain: 2, ttsGain: 1.5, musicGain: 0.5 }),
    )
    expect(out!.filterComplex).toBe(
      '[1:a]volume=1.5[tts];' +
        '[2:a]volume=0.06[music_raw];' +
        '[tts][music_raw]amix=inputs=2:duration=longest:dropout_transition=2[premaster];' +
        '[premaster]volume=2[aout]',
    )
  })

  it('scales SFX volume by the sfx bus gain', () => {
    const out = buildSceneAudioFilter(
      { sfx: [{ path: '/s.wav', triggerAt: 0, volume: 0.8 }] },
      2,
      resolved({ sfxGain: 0.5 }),
    )
    expect(out!.filterComplex).toContain('volume=0.4[sfx0]')
  })

  it('takes attack/release/ratio from resolved but duckLevel from the MusicTrack', () => {
    const out = buildSceneAudioFilter(
      {
        tts: { path: '/t.wav' },
        music: { path: '/m.mp3', volume: 0.1, loop: false, duckDuringTTS: true, duckLevel: 0.5 },
      },
      4,
      resolved({ ducking: { enabled: true, duckLevel: 0.9, attackMs: 50, releaseMs: 200, ratio: 4 } }),
    )
    // ratio/attack/release from resolved (4/50/200); level_sc from the music
    // track's duckLevel 0.5 → 1/0.5 = 2.00 (NOT the resolved 0.9).
    expect(out!.filterComplex).toContain(
      'sidechaincompress=threshold=0.02:ratio=4:attack=50:release=200:level_in=1:level_sc=2.00[music]',
    )
  })

  it('a corrupt negative MusicTrack duckLevel is epsilon-guarded (no level_sc=Infinity/negative)', () => {
    const out = buildSceneAudioFilter(
      {
        tts: { path: '/t.wav' },
        music: { path: '/m.mp3', volume: 0.1, loop: false, duckDuringTTS: true, duckLevel: -1 },
      },
      4,
      resolved({ ducking: { enabled: true } }),
    )
    // Math.max(-1, 0.01) = 0.01 → 1/0.01 = 100.00, never Infinity or a negative.
    expect(out!.filterComplex).toContain('level_sc=100.00[music]')
    expect(out!.filterComplex).not.toContain('Infinity')
  })

  it('loops music AND ducks it (aloop + sidechaincompress together)', () => {
    const out = buildSceneAudioFilter(
      {
        tts: { path: '/t.wav' },
        music: { path: '/m.mp3', volume: 0.12, loop: true, duckDuringTTS: true, duckLevel: 0.2 },
      },
      5,
      resolved({ ducking: { enabled: true } }),
    )
    expect(out!.filterComplex).toContain('aloop=999999999:size=2147483647,atrim=0:5,volume=0.12[music_raw]')
    expect(out!.filterComplex).toContain(
      '[music_raw][tts_sc]sidechaincompress=threshold=0.02:ratio=10:attack=100:release=500:level_in=1:level_sc=5.00[music]',
    )
  })

  it('fans in multiple SFX with distinct labels + amix', () => {
    const out = buildSceneAudioFilter(
      {
        sfx: [
          { path: '/a.wav', triggerAt: 0, volume: 0.8 },
          { path: '/b.wav', triggerAt: 1, volume: 0.5 },
        ],
      },
      3,
      resolved(),
    )
    expect(out!.audioInputPaths).toEqual(['/a.wav', '/b.wav'])
    expect(out!.filterComplex).toBe(
      '[1:a]adelay=0:all=1,volume=0.8[sfx0];' +
        '[2:a]adelay=1000:all=1,volume=0.5[sfx1];' +
        '[sfx0][sfx1]amix=inputs=2:duration=longest:dropout_transition=2[aout]',
    )
  })

  it('applies master gain on a SINGLE input (apad then premaster volume)', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, resolved({ masterGain: 2 }))
    expect(out!.filterComplex).toBe('[1:a]acopy[tts];[tts]apad=pad_dur=5[premaster];[premaster]volume=2[aout]')
  })

  it('gain of exactly 1 emits no redundant volume stage (stays byte-identical)', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, resolved())
    expect(out!.filterComplex).toBe('[1:a]acopy[tts];[tts]apad=pad_dur=5[aout]')
  })
})

describe('buildSceneAudioFilter — sceneMix (timeline track volume / mute / solo / pan)', () => {
  it('trackGain multiplies into the TTS volume', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null, {
      tts: { trackGain: 0.5, pan: 0, drop: false },
    })
    // sceneMix present → deterministic stereo output (cross-scene concat layout).
    expect(out!.filterComplex).toBe(
      '[1:a]volume=0.5[tts];[tts]apad=pad_dur=5[prestereo];[prestereo]aformat=channel_layouts=stereo[aout]',
    )
  })

  it('forces a stereo [aout] whenever a sceneMix is present, even with no pan', () => {
    // Deterministic layout so a panned scene and an unpanned scene concat cleanly.
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null, {
      tts: { trackGain: 1, pan: 0, drop: false },
    })
    expect(out!.filterComplex.endsWith('[prestereo]aformat=channel_layouts=stereo[aout]')).toBe(true)
  })

  it('stays mono (no forced stereo) when sceneMix is absent — byte-identical', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null)
    expect(out!.filterComplex).toBe('[1:a]acopy[tts];[tts]apad=pad_dur=5[aout]')
  })

  it('a dropped narration with music present does NOT silence the scene', () => {
    // Regression: the [tts] label is not created when dropped, so it must not be
    // referenced in the mix — otherwise ffmpeg fails to bind and the whole scene
    // exports silent (music + sfx lost too).
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' }, music: { path: '/m.mp3', volume: 0.12 } }, 5, null, {
      tts: { trackGain: 1, pan: 0, drop: true }, // narration muted
      music: { trackGain: 1, pan: 0, drop: false },
    })
    expect(out!.audioInputPaths).toEqual(['/m.mp3']) // only music
    expect(out!.filterComplex).not.toContain('[tts]') // no dangling reference
    expect(out!.filterComplex).toContain('[music_raw]') // music still mixed
  })

  it('trackGain composes with the audioProcessing bus gain', () => {
    // music bus gain 2 × track 0.5 × base 0.12 = 0.12
    const out = buildSceneAudioFilter(
      { music: { path: '/m.mp3', volume: 0.12, loop: false } },
      5,
      {
        masterGain: 1,
        ttsGain: 1,
        musicGain: 2,
        sfxGain: 1,
        ducking: { duckLevel: 0.2, attackMs: 100, releaseMs: 500, ratio: 10 },
      },
      { music: { trackGain: 0.5, pan: 0, drop: false } },
    )
    expect(out!.filterComplex).toContain('volume=0.12[music_raw]')
  })

  it('a dropped (muted / solo-excluded) category is omitted from the graph', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' }, music: { path: '/m.mp3', volume: 0.12 } }, 5, null, {
      tts: { trackGain: 1, pan: 0, drop: false },
      music: { trackGain: 1, pan: 0, drop: true }, // music muted
    })
    expect(out!.audioInputPaths).toEqual(['/t.wav']) // music input not added
    expect(out!.filterComplex).toBe(
      '[1:a]acopy[tts];[tts]apad=pad_dur=5[prestereo];[prestereo]aformat=channel_layouts=stereo[aout]',
    )
  })

  it('dropping all categories yields null (no audio)', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null, {
      tts: { trackGain: 0, pan: 0, drop: true },
    })
    expect(out).toBeNull()
  })

  it('pan emits a constant-power stereo pan stage matching the StereoPanner law', () => {
    // pan = -1 (hard left): gL=1, gR=0
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null, {
      tts: { trackGain: 1, pan: -1, drop: false },
    })
    expect(out!.filterComplex).toContain('pan=stereo|c0=1.000000*c0|c1=0.000000*c0')
    // hard right: gL=0, gR=1
    const right = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null, {
      tts: { trackGain: 1, pan: 1, drop: false },
    })
    expect(right!.filterComplex).toContain('pan=stereo|c0=0.000000*c0|c1=1.000000*c0')
  })

  it('when one category pans, non-panned categories are forced to stereo for a clean amix', () => {
    const out = buildSceneAudioFilter(
      { tts: { path: '/t.wav' }, music: { path: '/m.mp3', volume: 0.12, loop: false } },
      5,
      null,
      {
        tts: { trackGain: 1, pan: -1, drop: false }, // panned
        music: { trackGain: 1, pan: 0, drop: false }, // not panned → stereoized
      },
    )
    expect(out!.filterComplex).toContain('aformat=channel_layouts=stereo') // music upmixed
    expect(out!.filterComplex).toContain('pan=stereo') // tts panned
  })

  it('resolves each SFX by id from sfxIds', () => {
    const out = buildSceneAudioFilter(
      { sfx: [{ path: '/s.wav', triggerAt: 1, volume: 0.8 }] },
      3,
      null,
      { sfx: { fx1: { trackGain: 0.5, pan: 0, drop: false } } },
      ['fx1'],
    )
    expect(out!.filterComplex).toBe(
      '[1:a]adelay=1000:all=1,volume=0.4[sfx0];[sfx0]apad=pad_dur=3[prestereo];[prestereo]aformat=channel_layouts=stereo[aout]',
    )
  })

  it('a dropped SFX is skipped while others remain', () => {
    const out = buildSceneAudioFilter(
      {
        sfx: [
          { path: '/a.wav', triggerAt: 0, volume: 0.8 },
          { path: '/b.wav', triggerAt: 1, volume: 0.8 },
        ],
      },
      3,
      null,
      { sfx: { a: { trackGain: 1, pan: 0, drop: true }, b: { trackGain: 1, pan: 0, drop: false } } },
      ['a', 'b'],
    )
    expect(out!.audioInputPaths).toEqual(['/b.wav']) // only the non-dropped one
  })
})

describe('buildSceneAudioFilter — file lane (base/imported audio in the A1 slot)', () => {
  // A base/imported file is routed to the tts slot upstream and tagged isFile. Its
  // timeline fader/mute/pan live in sceneMix.file (the `aud-` clip), NOT sceneMix.tts.
  // The resolver ALWAYS returns a (unity) sceneMix.tts, so the old
  // `sceneMix.tts || sceneMix.file` selector silently dropped the file's lane mix.
  const unityTts = { trackGain: 1, pan: 0, drop: false }

  it("a file's fader comes from sceneMix.file, not the (unity) tts lane", () => {
    const out = buildSceneAudioFilter({ tts: { path: '/f.wav', isFile: true } }, 5, null, {
      tts: unityTts,
      file: { trackGain: 0.5, pan: 0, drop: false },
    })
    // 0.5 proves the file lane applied; the old selector would have picked unity tts → no volume= stage.
    expect(out!.filterComplex).toBe(
      '[1:a]volume=0.5[tts];[tts]apad=pad_dur=5[prestereo];[prestereo]aformat=channel_layouts=stereo[aout]',
    )
  })

  it('muting the file lane drops it from the bake (the file is the only source → null)', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/f.wav', isFile: true } }, 5, null, {
      tts: unityTts, // unity → old selector would have kept the file audible
      file: { trackGain: 1, pan: 0, drop: true },
    })
    expect(out).toBeNull()
  })

  it("a file's pan comes from sceneMix.file", () => {
    const out = buildSceneAudioFilter({ tts: { path: '/f.wav', isFile: true } }, 5, null, {
      tts: unityTts,
      file: { trackGain: 1, pan: -1, drop: false }, // hard left
    })
    expect(out!.filterComplex).toContain('pan=stereo|c0=1.000000*c0|c1=0.000000*c0')
  })

  it('narration (no isFile) still reads the tts lane, ignoring the file lane', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null, {
      tts: { trackGain: 0.5, pan: 0, drop: false },
      file: { trackGain: 0.1, pan: 0, drop: false }, // must NOT win for narration
    })
    expect(out!.filterComplex).toContain('volume=0.5[tts]')
    expect(out!.filterComplex).not.toContain('volume=0.1')
  })
})

describe('buildSceneAudioFilter — v5 A2: full-gain summing + limiter on the export path', () => {
  const unity = { trackGain: 1, pan: 0, drop: false }
  const tracks = {
    tts: { path: '/t.wav' },
    music: { path: '/m.mp3', volume: 0.12, loop: false, duckDuringTTS: false },
  }

  it('multi-source + sceneMix: amix sums at full gain (normalize=0, dropout_transition=0) and soft-limits', () => {
    const out = buildSceneAudioFilter(tracks, 5, null, { tts: unity, music: unity })
    // FFmpeg's default amix scales each input by 1/N — narration+music exported
    // ~−6 dB quieter than the preview (which sums element volumes 1:1), and
    // dropout_transition=2 swelled the music for 2 s after narration ended.
    expect(out!.filterComplex).toContain('amix=inputs=2:duration=longest:normalize=0:dropout_transition=0')
    expect(out!.filterComplex).toContain('alimiter=limit=0.97:level=false')
    expect(out!.filterComplex).not.toContain('dropout_transition=2')
  })

  it('the limiter is LAST in the gain chain — after volume=masterGain (D13/#9: limiting before re-clips at masterGain > 1)', () => {
    const out = buildSceneAudioFilter(
      tracks,
      5,
      {
        masterGain: 2,
        ttsGain: 1,
        musicGain: 1,
        sfxGain: 1,
        ducking: { duckLevel: 0.2, attackMs: 100, releaseMs: 500, ratio: 10 },
      },
      { tts: unity, music: unity },
    )
    const fc = out!.filterComplex
    const masterAt = fc.indexOf('volume=2')
    const limitAt = fc.indexOf('alimiter=')
    expect(masterAt).toBeGreaterThan(-1)
    expect(limitAt).toBeGreaterThan(masterAt)
    // …and the stereo layout normalize stays terminal.
    expect(fc.indexOf('aformat=channel_layouts=stereo[aout]')).toBeGreaterThan(limitAt)
  })

  it('REGRESSION: sceneMix=null (preview / web-fallback legacy) keeps the old 1/N graph byte-identical', () => {
    const out = buildSceneAudioFilter(tracks, 5, null, null)
    expect(out!.filterComplex).toContain('amix=inputs=2:duration=longest:dropout_transition=2[aout]')
    expect(out!.filterComplex).not.toContain('alimiter')
    expect(out!.filterComplex).not.toContain('normalize=0')
  })

  it('REGRESSION: single-source scenes get no limiter and no amix (nothing to sum)', () => {
    const out = buildSceneAudioFilter({ tts: { path: '/t.wav' } }, 5, null, { tts: unity })
    expect(out!.filterComplex).not.toContain('alimiter')
    expect(out!.filterComplex).not.toContain('amix')
  })
})

describe('buildSceneAudioFilter — v5 A3: file audio coexisting with music/sfx', () => {
  const unity = { trackGain: 1, pan: 0, drop: false }

  it('a file in the tts slot + music: BOTH play, and the file does NOT sidechain-duck the music', () => {
    const out = buildSceneAudioFilter(
      {
        tts: { path: '/f.wav', isFile: true },
        music: { path: '/m.mp3', volume: 0.12, loop: false, duckDuringTTS: true, duckLevel: 0.2 },
      },
      5,
      null,
      { tts: unity, file: unity, music: unity },
    )
    expect(out!.audioInputPaths).toEqual(['/f.wav', '/m.mp3'])
    // Ducking is a narration feature — an imported file (often itself
    // ambience/music) must not duck the music under it (D13/#8).
    expect(out!.filterComplex).not.toContain('sidechaincompress')
    expect(out!.filterComplex).toContain('amix=inputs=2')
  })

  it('REGRESSION: real narration (no isFile) + duckDuringTTS music still ducks', () => {
    const out = buildSceneAudioFilter(
      {
        tts: { path: '/t.wav' },
        music: { path: '/m.mp3', volume: 0.12, loop: false, duckDuringTTS: true, duckLevel: 0.2 },
      },
      5,
      null,
      { tts: unity, music: unity },
    )
    expect(out!.filterComplex).toContain('sidechaincompress')
  })

  it("a coexisting file's fader/mute still come from sceneMix.file", () => {
    const out = buildSceneAudioFilter(
      {
        tts: { path: '/f.wav', isFile: true },
        music: { path: '/m.mp3', volume: 0.12, loop: false, duckDuringTTS: false },
      },
      5,
      null,
      { tts: unity, file: { trackGain: 0.5, pan: 0, drop: false }, music: unity },
    )
    expect(out!.filterComplex).toContain('volume=0.5[tts]') // file lane gain, not unity tts
    const muted = buildSceneAudioFilter(
      {
        tts: { path: '/f.wav', isFile: true },
        music: { path: '/m.mp3', volume: 0.12, loop: false, duckDuringTTS: false },
      },
      5,
      null,
      { tts: unity, file: { trackGain: 1, pan: 0, drop: true }, music: unity },
    )
    expect(muted!.audioInputPaths).toEqual(['/m.mp3']) // file dropped, music remains
  })
})
