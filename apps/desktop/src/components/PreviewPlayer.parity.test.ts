/**
 * Source-parity tests for PreviewPlayer's playhead time writers.
 *
 * A scene iframe reports SOURCE time (the scene clock: starts at trimStart,
 * advances at clip speed); the playhead/timecode store CLIP-LOCAL time. PR #226
 * fixed three tick writers (play / resumeAndTick / restart) to map source →
 * clip-local via `clipLocalTime`, but missed the fourth writer — the
 * `player.onTimeUpdate` handler, which fires on every scene-clock tick and on every
 * seek echo and was still writing RAW source time, snapping the playhead back
 * to source time for trimmed/split/sped clips.
 *
 * The writers live inside React callbacks/closures that can't be imported, so —
 * like src/lib/agents/__tests__/cap-checkpoint.test.ts — we assert the parity at
 * the source level. These tests would have failed before the fourth writer and
 * the fade-window math were fixed.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const src = readFileSync(path.resolve(process.cwd(), 'src/components/PreviewPlayer.tsx'), 'utf8')

describe('PreviewPlayer iframe-time writers store clip-local time', () => {
  it('the iframe-time writers wrap the reported time in clipLocalTime', () => {
    // Global wall-clock: the tick writes the playhead directly in timeline-local
    // time (g - clip.startTime), so the ONLY remaining clipLocalTime writer is the
    // onTimeUpdate seek-echo handler (used when PAUSED).
    const wrapped = src.split('setCurrentTime(clipLocalTime(').length - 1
    expect(wrapped).toBe(1)
  })

  it('the onTimeUpdate handler (seek-echo writer) maps source → clip-local', () => {
    const start = src.indexOf('player.onTimeUpdate =')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('player.onEnded', start)
    expect(end).toBeGreaterThan(start)
    const body = src.slice(start, end)
    expect(body).toContain('setCurrentTime(clipLocalTime(')
    // The pre-fix body wrote the raw source time straight through.
    expect(body).not.toMatch(/setCurrentTime\(t\)/)
  })
})

/**
 * One shared tick: the trimEnd watchdog and fade cross-fade must live in
 * EXACTLY ONE place — the shared `runPlaybackTick` — so the auto-advance path
 * (resumeAndTick) can't drift into a reduced tick that overshoots right-trims
 * and drops fades.
 */
describe('one shared playback tick', () => {
  it('advances via the active set, not a per-scene trimEnd watchdog (wall-clock)', () => {
    // Global wall-clock: a clip leaves the active set at startTime+duration (which
    // already accounts for its trim), so there is no per-scene reachedTrimEnd
    // watchdog and no advanceFromSceneRef call inside the tick.
    expect(src.split('reachedTrimEnd(').length - 1).toBe(0)
    expect(src).not.toContain('advanceFromSceneRef.current?.(sceneId)')
  })

  it('the tick is driven by a global wall-clock over the active set', () => {
    const tickStart = src.indexOf('const runPlaybackTick = useCallback(')
    const body = src.slice(tickStart, tickStart + 3000)
    expect(body).toContain('Date.now() - startWall')
    expect(body).toContain("getActiveClips(tl, g, { sourceType: 'scene' })")
  })

  it('has exactly one fade-detection block', () => {
    const fadeSites = src.split('const remaining = top.clip.duration - localT').length - 1
    expect(fadeSites).toBe(1)
  })

  it('deleted the dead restart() tick copy', () => {
    expect(src).not.toMatch(/const restart = useCallback/)
  })

  it('play / resumeAndTick both drive the shared runPlaybackTick', () => {
    expect(src).toContain('const runPlaybackTick = useCallback(')
    // resumeAndTick is now a thin wrapper that calls the shared tick.
    const rat = src.slice(src.indexOf('const resumeAndTick = useCallback('))
    expect(rat.slice(0, 300)).toContain('runPlaybackTick()')
  })

  it('[REGRESSION] the auto-advance path (resumeAndTick) no longer has its own reduced tick', () => {
    // Auto-advance routes goToSceneAndPlay → resumeAndTick. A local tick there would
    // lack the trimEnd watchdog and fades, so resumeAndTick must delegate to the
    // shared body.
    const ratStart = src.indexOf('const resumeAndTick = useCallback(')
    const ratEnd = src.indexOf('}, [', ratStart)
    const body = src.slice(ratStart, ratEnd)
    expect(body).not.toContain('const tick =')
    expect(body).not.toContain('requestAnimationFrame(tick)')
  })
})

describe('fade-transition window uses timeline-local remaining time', () => {
  it('the fade site computes remaining in timeline-local time', () => {
    // Wall-clock: the playhead IS timeline-local (g - clip.startTime), so the fade
    // window is `clip.duration - localT` directly — no source→clip inversion.
    expect(src).toContain('const remaining = top.clip.duration - localT')
  })

  it('the broken source-time math is gone', () => {
    // Old: `clip.duration - t * (clip.speed ?? 1)` — multiplied source time by
    // speed (instead of dividing) and ignored trimStart.
    expect(src).not.toMatch(/clip\.duration\s*-\s*t\s*\*/)
  })
})

/**
 * Transport completed state + replay: when the LAST scene ends the transport
 * parks `completed`; the next explicit play() replays from scene 1 / t=0 and
 * clears the stale advance guard (otherwise shouldAdvance rejects and the
 * playhead freezes).
 */
describe('transport completed state + replay', () => {
  it('parks completed at end-of-timeline', () => {
    // 2 legacy parks in advanceFromScene (used for jumps/interactions when paused)
    // + 1 in the wall-clock tick when globalTime reaches the total duration.
    const parks = src.split('completedRef.current = true').length - 1
    expect(parks).toBe(3)
  })

  it('play() clears the stale advance guard unconditionally at the top', () => {
    const playStart = src.indexOf('const play = useCallback(')
    const guardClear = src.indexOf('advanceFromRef.current = null', playStart)
    // The clear sits before the sceneless early-return.
    const scenelessBranch = src.indexOf('scenesRef.current.length === 0', playStart)
    expect(guardClear).toBeGreaterThan(playStart)
    expect(guardClear).toBeLessThan(scenelessBranch)
  })

  it('play() routes replay-from-end through replayTargetOnPlay + goToSceneAndPlay', () => {
    expect(src).toContain('replayTargetOnPlay({')
    expect(src).toMatch(/import \{[^}]*replayTargetOnPlay[^}]*\} from '@\/lib\/preview-advance'/)
    const playStart = src.indexOf('const play = useCallback(')
    const completedBranch = src.indexOf('if (completedRef.current) {', playStart)
    expect(completedBranch).toBeGreaterThan(playStart)
    const branch = src.slice(completedBranch, completedBranch + 300)
    expect(branch).toContain('completedRef.current = false')
    expect(branch).toContain('goToSceneAndPlay(replayId)')
  })

  it('clears completed on explicit seek and on manual selection (no false replay mid-timeline)', () => {
    // applySeekImmediate + the [selectedSceneId] effect both drop the park.
    const clears = src.split('completedRef.current = false').length - 1
    // top-of-play clear + selection effect + seek = 3.
    expect(clears).toBe(3)
  })
})

/**
 * Load choreography: handleSceneLoad guards against these races —
 *  (a) a deferred idle-frame seek that lands AFTER the synchronous play, so the
 *      controller's seek echo pauses the freshly-loaded active scene;
 *  (c) a stale pendingPlayRef that ghost-plays while paused, and a 10s timer that
 *      force-UNpauses.
 */
describe('load choreography', () => {
  it('skips the deferred idle seek for the active-and-playing scene', () => {
    // The idle-frame seek is gated behind !isActiveAndPlaying; the active+playing
    // scene seeks to trimStart synchronously BEFORE resumeScene instead.
    expect(src).toContain('const isActiveAndPlaying = sceneId === selectedIdRef.current && isPlayingRef.current')
    expect(src).toContain('if (p && !isActiveAndPlaying) {')
    const handlerIdx = src.indexOf('const handleSceneLoad = useCallback(')
    const activeBlock = src.indexOf('if (isActiveAndPlaying) {', handlerIdx)
    expect(activeBlock).toBeGreaterThan(handlerIdx)
    // The active branch seeks to the clip in-point, then resumes — order is seek→play.
    // Window covers the clip-centric resolution (currentClipIdRef-preferred) + seek.
    const block = src.slice(activeBlock, activeBlock + 700)
    const seekPos = block.indexOf('p?.seek(')
    const resumePos = block.indexOf('resumeScene(sceneId)')
    expect(seekPos).toBeGreaterThan(-1)
    expect(resumePos).toBeGreaterThan(seekPos)
  })

  it('gates the pendingPlay auto-play branch on isPlayingRef (no ghost-play while paused)', () => {
    const branchIdx = src.indexOf('if (pendingPlayRef.current === sceneId) {')
    expect(branchIdx).toBeGreaterThan(-1)
    const branch = src.slice(branchIdx, branchIdx + 600)
    expect(branch).toContain('if (p && isPlayingRef.current) {')
  })

  it('gates the 10s safety-net timer callback on isPlayingRef (no force-unpause)', () => {
    const timerIdx = src.indexOf('pendingPlayTimerRef.current = setTimeout(() => {')
    expect(timerIdx).toBeGreaterThan(-1)
    const body = src.slice(timerIdx, timerIdx + 600)
    expect(body).toContain('if (!isPlayingRef.current) return')
  })

  it('clears pendingPlay in pause, applySeekImmediate, and the selection-change effect', () => {
    // pause + applySeekImmediate route through clearPendingPlay; the selection
    // effect inlines the clear (gated on !isAutoAdvancing so auto-advance keeps it).
    expect(src).toContain('const clearPendingPlay = useCallback(')
    const pauseIdx = src.indexOf('const pause = useCallback(')
    expect(src.slice(pauseIdx, pauseIdx + 300)).toContain('clearPendingPlay()')
    const seekIdx = src.indexOf('const applySeekImmediate = useCallback(')
    expect(src.slice(seekIdx, seekIdx + 1200)).toContain('clearPendingPlay()')
    const effectIdx = src.indexOf('Manual scene selection (from scene list click)')
    expect(effectIdx).toBeGreaterThan(-1)
    const effectBody = src.slice(effectIdx, effectIdx + 1100)
    expect(effectBody).toContain('if (!isAutoAdvancing.current) {')
    expect(effectBody).toContain('pendingPlayRef.current = null')
  })
})

/**
 * init_error handling + play-on-errored skip: a scene whose controller failed to
 * init (init_error) is treated like a verify-errored scene, and play() on an
 * errored/never-ready selected scene routes through the same skip the advance path
 * uses (nextRenderableSceneId + 10s no-player net).
 */
describe('init_error handling + play-on-errored skip', () => {
  it('the global handler treats init_error like a verify error (marks failed + skips if playing)', () => {
    const idx = src.indexOf("e.data.type === 'init_error'")
    expect(idx).toBeGreaterThan(-1)
    const body = src.slice(idx, idx + 700)
    // Bound to the posting frame, marks failed, advances past it when playing.
    expect(body).toContain('isBoundToPostingFrame')
    expect(body).toContain('setFailedScenes(')
    expect(body).toContain('nextRenderableSceneId(badId)')
    expect(body).toContain('goToSceneAndPlayRef.current?.(nextId)')
  })

  it('nextRenderableSceneId + goToSceneAndPlay treat failedScenes (init_error) as unrenderable', () => {
    // Both the skip resolver and the requested-scene guard consult failedScenesRef.
    expect(src).toContain('failedScenesRef.current.has(id)')
    expect(src).toContain('failedScenesRef.current.has(sceneId)')
  })

  it('play() routes an errored / never-ready selected scene through goToSceneAndPlay', () => {
    const playStart = src.indexOf('const play = useCallback(')
    const skipIdx = src.indexOf('const selErrored = ', playStart)
    expect(skipIdx).toBeGreaterThan(playStart)
    const body = src.slice(skipIdx, skipIdx + 500)
    // Errored OR init-error-failed OR no live player → route through the skip path.
    expect(body).toContain("verifyStatus === 'errored'")
    expect(body).toContain('failedScenesRef.current.has(selId)')
    expect(body).toContain('!selHasPlayer')
    expect(body).toContain('goToSceneAndPlay(selId)')
  })

  it('ScenePlayer late init_error also marks the scene failed (belt-and-braces)', () => {
    expect(src).toContain('player.onInitError = () => {')
  })
})

/**
 * [REGRESSION] Muting a track must NOT broadcast a whole-iframe mute.
 *
 * A per-clip `player.setAudioMuted(track.muted)` would hit the iframe handler,
 * which mutes EVERY audio/video element, so muting the music track would silence
 * narration + video in preview. Export parity: neither export backend carries scene-embedded
 * video-element audio or consults V1 mute for scene audio (tier3 captures with
 * webContents audio muted + ffmpeg -an and mixes only scene.audioLayer;
 * pixi-mp4 reads only config.audioLayer) — so the preview matches by sending
 * nothing. The per-category mix effect is what silences muted lanes.
 */
describe('track mute no longer broadcasts a whole-iframe mute', () => {
  it('the blunt trackMutedSig effect is gone', () => {
    expect(src).not.toContain('trackMutedSig')
    expect(src).not.toMatch(/player\.setAudioMuted|\.setAudioMuted\(track/)
    expect(src).not.toContain("'set_audio_muted'")
  })

  it('the per-category mix effect (the replacement) is still wired', () => {
    expect(src).toContain('trackMixSig')
    expect(src).toContain('setSceneAudioMix(resolveSceneAudioMix(')
  })
})

describe('engine audio ownership broadcast', () => {
  it('PreviewPlayer hands scene audio to the engine on player ready', () => {
    // The iframe must be told the engine owns its audio so it mutes its own
    // tts/music/sfx copy (no double-play). Set on ready — before the first
    // play — so there is never an audible blip.
    expect(src).toContain('player.setEngineOwnsAudio(true)')
    const idx = src.indexOf('player.onReady')
    const ownIdx = src.indexOf('setEngineOwnsAudio(true)')
    expect(ownIdx).toBeGreaterThan(idx) // wired inside onReady
  })
})
