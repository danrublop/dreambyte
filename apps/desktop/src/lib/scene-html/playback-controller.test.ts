import { describe, expect, it } from 'vitest'
import { TYPOGRAPHY_PROPS } from '../code-text-slots'
import { PLAYBACK_CONTROLLER } from './playback-controller'

describe('PLAYBACK_CONTROLLER live_apply SVG attr map', () => {
  // Locking in the data-driven invariant: if anyone adds a typography prop
  // with an svgAttr to TYPOGRAPHY_PROPS, the iframe-side runtime must know
  // about it. The previous hand-written switch silently dropped fontStyle
  // and textAlign.
  it('inlines an svgTextAttrMap entry for every TYPOGRAPHY_PROPS row with svgAttr', () => {
    for (const d of TYPOGRAPHY_PROPS) {
      if (!d.svgAttr) continue
      const expected = `"${d.key}":"${d.svgAttr}"`
      expect(PLAYBACK_CONTROLLER).toContain(expected)
    }
  })

  it('no longer hard-codes the SVG attr switch', () => {
    // The old switch tested __k against literal strings. Make sure it's gone.
    expect(PLAYBACK_CONTROLLER).not.toMatch(/__k === 'fontFamily' \? 'font-family'/)
  })
})

describe('PLAYBACK_CONTROLLER clock-drives the full-scene video', () => {
  it('locks data-scene-video currentTime to the scene clock on every clock frame', () => {
    // The full-scene <video> must be driven by the scene clock so it can't
    // free-run/loop and so a slaved (stacked) scene's video still advances.
    expect(PLAYBACK_CONTROLLER).toContain("querySelectorAll('video[data-scene-video]')")
    expect(PLAYBACK_CONTROLLER).toContain('_v.currentTime = Math.max(0, _t)')
  })
})

describe('PLAYBACK_CONTROLLER engine audio ownership (T4)', () => {
  it('handles the sticky set_engine_owns_audio message', () => {
    expect(PLAYBACK_CONTROLLER).toContain("case 'set_engine_owns_audio'")
    expect(PLAYBACK_CONTROLLER).toContain('window.__engineOwnsAudio')
  })

  it('gates the audio-producing branches on ownership, not visuals', () => {
    // Audio branches use audioPlaying (false when the engine owns audio); video
    // and CSS keep using `playing` so frames still advance under ownership.
    expect(PLAYBACK_CONTROLLER).toContain('var audioPlaying = playing && !_engineOwnsAudio')
  })

  it('excludes avatar speech from ownership muting (data-avatar-audio except-list)', () => {
    // Avatar speech is played by its owner and must never be muted by engine
    // ownership.
    expect(PLAYBACK_CONTROLLER).toContain('dataset.avatarAudio')
    expect(PLAYBACK_CONTROLLER).toContain('applyEngineAudioOwnership')
  })

  it('re-applies ownership on every syncMedia so it survives seek/reset/play', () => {
    const syncIdx = PLAYBACK_CONTROLLER.indexOf('function syncMedia(')
    const applyIdx = PLAYBACK_CONTROLLER.indexOf('applyEngineAudioOwnership();', syncIdx)
    expect(syncIdx).toBeGreaterThan(-1)
    expect(applyIdx).toBeGreaterThan(syncIdx)
  })
})

describe('PLAYBACK_CONTROLLER per-category audio mix (v4 #3)', () => {
  it('handles the set_scene_audio_mix message and applies it', () => {
    expect(PLAYBACK_CONTROLLER).toContain("case 'set_scene_audio_mix'")
    expect(PLAYBACK_CONTROLLER).toContain('applySceneMix()')
  })

  it('maps each scene audio element id to its category mix', () => {
    expect(PLAYBACK_CONTROLLER).toContain('function _catMixForEl(')
    // scene-tts → tts, scene-audio → file, scene-music → music, sfx-<id> → sfx[id]
    expect(PLAYBACK_CONTROLLER).toContain("el.id === 'scene-tts'")
    expect(PLAYBACK_CONTROLLER).toContain("el.id === 'scene-audio'")
    expect(PLAYBACK_CONTROLLER).toContain("el.id === 'scene-music'")
    expect(PLAYBACK_CONTROLLER).toContain("el.id.indexOf('sfx-') === 0")
  })

  it('applies gain via el.volume (not a routed graph) so a suspended AudioContext cannot silence it', () => {
    // The four base-volume sites are multiplied by the category gain.
    const gainSites = PLAYBACK_CONTROLLER.split('_mixGain(').length - 1
    // 2 helper refs (def + applySceneMix) + the threaded volume sites (tts×2, music×3, sfx×1).
    expect(gainSites).toBeGreaterThanOrEqual(7)
    expect(PLAYBACK_CONTROLLER).toContain('function _mixGain(')
    // A dropped (muted / solo-excluded) category resolves to gain 0.
    expect(PLAYBACK_CONTROLLER).toContain('if (c.drop) return 0')
  })

  it('builds a StereoPanner graph ONLY for panned elements (lazy AudioContext)', () => {
    expect(PLAYBACK_CONTROLLER).toContain('createStereoPanner()')
    expect(PLAYBACK_CONTROLLER).toContain('createMediaElementSource(el)')
    // The panner is only ensured when pan !== 0; gain/mute work without the graph.
    expect(PLAYBACK_CONTROLLER).toContain('if (pan !== 0) _ensurePanner(el, pan)')
    // The one-shot MediaElementSource + panner are cached on the element.
    expect(PLAYBACK_CONTROLLER).toContain('if (!el.__mixSource)')
  })

  it('threads the music gain through the duck dance so ducking composes with the fader', () => {
    expect(PLAYBACK_CONTROLLER).toContain('duckVol * _mixGain(musicAudio)')
    expect(PLAYBACK_CONTROLLER).toContain('normalVol * _mixGain(musicAudio)')
  })

  it('does not leak a template-literal interpolation into the injected string', () => {
    // The runtime is injected via a template literal; an accidental ${...} would
    // be evaluated at build time. The mix code must use string concat / no ${}.
    expect(PLAYBACK_CONTROLLER).not.toContain('${')
  })
})

describe('PLAYBACK_CONTROLLER animation-runtime-missing init_error guard (v6 C4b)', () => {
  // The controller's first anime touch is `anime.createTimeline(...)`; if anime is
  // undefined (offline / missing vendor asset) that throws and kills the IIFE
  // before the message listener is installed — a dead transport. The guard
  // installs a minimal listener + posts init_error FIRST so the parent can skip
  // the scene instead of freezing.
  const GUARD = "if (typeof anime === 'undefined'"
  it('installs the guard before the first anime.createTimeline() call', () => {
    const guardIdx = PLAYBACK_CONTROLLER.indexOf(GUARD)
    const firstTouch = PLAYBACK_CONTROLLER.indexOf('var masterTL = anime.createTimeline({')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(firstTouch).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(firstTouch)
  })

  it('the guard installs a message listener AND posts init_error before returning', () => {
    const guardIdx = PLAYBACK_CONTROLLER.indexOf(GUARD)
    // The early-return body ends at the performance.now interception section.
    const guardEnd = PLAYBACK_CONTROLLER.indexOf('performance.now() interception', guardIdx)
    const body = PLAYBACK_CONTROLLER.slice(guardIdx, guardEnd)
    const listenerPos = body.indexOf("window.addEventListener('message'")
    const beaconPos = body.indexOf("type: 'init_error'")
    expect(listenerPos).toBeGreaterThan(-1)
    expect(beaconPos).toBeGreaterThan(-1)
    // Listener installed before the beacon, and the block returns out of the IIFE.
    expect(listenerPos).toBeLessThan(beaconPos)
    expect(body).toContain('return;')
  })

  it('the guard responds to get_state with an error status (so parent polls do not hang)', () => {
    const guardIdx = PLAYBACK_CONTROLLER.indexOf(GUARD)
    const guardEnd = PLAYBACK_CONTROLLER.indexOf('performance.now() interception', guardIdx)
    const body = PLAYBACK_CONTROLLER.slice(guardIdx, guardEnd)
    expect(body).toContain("status: 'error'")
  })
})

describe('PLAYBACK_CONTROLLER seek media-pause honors isActive (v6 C3b)', () => {
  // A seek echo that lands while the clock is ACTIVELY playing must not pause
  // media — otherwise a deferred post-play seek on a freshly-loaded scene freezes
  // its audio and video. The media-pause half of the seek handler is gated on
  // !_clockActive(); paused-seek behavior is unchanged.
  it('runs _clock.pause() + syncMedia(false) only inside the !_clockActive() guard', () => {
    const seekIdx = PLAYBACK_CONTROLLER.indexOf("case 'seek':")
    expect(seekIdx).toBeGreaterThan(-1)
    const breakIdx = PLAYBACK_CONTROLLER.indexOf("case 'scrub_start':", seekIdx)
    const body = PLAYBACK_CONTROLLER.slice(seekIdx, breakIdx)
    expect(body).toContain('if (!_clockActive()) {')
    const guardIdx = body.indexOf('if (!_clockActive()) {')
    const guardBlock = body.slice(guardIdx, guardIdx + 120)
    expect(guardBlock).toContain('_clock.pause();')
    expect(guardBlock).toContain('syncMedia(false);')
  })

  it('does NOT call an unconditional syncMedia(false) after the seek guard', () => {
    const seekIdx = PLAYBACK_CONTROLLER.indexOf("case 'seek':")
    const breakIdx = PLAYBACK_CONTROLLER.indexOf("case 'scrub_start':", seekIdx)
    const body = PLAYBACK_CONTROLLER.slice(seekIdx, breakIdx)
    // Exactly one syncMedia(false); CALL in the seek case — the guarded one.
    const calls = body.split('syncMedia(false);').length - 1
    expect(calls).toBe(1)
  })
})

describe('PLAYBACK_CONTROLLER whole-iframe mute message (v5 B3)', () => {
  // PreviewPlayer's blunt track-mute effect was retired (the per-category mix
  // owns track mute now), but the set_audio_muted message itself must stay: it
  // is ChatScenePreview's mute-toggle contract (src/components/chat/
  // ChatScenePreview.tsx posts `{ type: 'set_audio_muted', muted }` for its
  // whole-preview toggle).
  it('still handles set_audio_muted (ChatScenePreview sender)', () => {
    expect(PLAYBACK_CONTROLLER).toContain("case 'set_audio_muted':")
    // The whole-preview toggle legitimately covers BOTH element kinds, and
    // restores the per-element baseline via the dataset key on unmute.
    expect(PLAYBACK_CONTROLLER).toContain("document.querySelectorAll('audio, video')")
    expect(PLAYBACK_CONTROLLER).toContain('el.dataset.trackMuted')
  })
})
