'use client'

/**
 * Drives the timeline audio engine from the store: re-syncs on every
 * transport tick (globalTime updates while playing) and on timeline edits
 * (clip moves, volume keyframes, mute/solo, faders). Mounted once by the
 * Timeline.
 *
 * The scene→URL map (for scene-mirror clips) is rebuilt only when the `scenes`
 * array reference changes, not on every transport tick — building it walks
 * every scene + nested layer, which must not run at frame rate.
 *
 * `ownsSceneAudio` is TRUE: the engine plays scene-mirror audio
 * (tts/music/sfx) so it rides the mixer faders + drives the per-track VU meters,
 * and `PreviewPlayer` tells each scene iframe `setEngineOwnsAudio(true)` so the
 * iframe mutes its own copy — one source, no double-play. Avatar
 * lipsync speech is excluded via `ownershipExceptions` (the avatar overlay owns
 * it and drives lipsync from its own AudioContext), matching the controller's
 * `data-avatar-audio` exemption.
 */

import { useEffect } from 'react'
import { useVideoStore } from '@/lib/store'
import { getTimelineAudioEngine } from '@/lib/audio/timeline-audio-engine'
import { buildAudioUrlMap } from '@/lib/audio/audio-url-map'
import { AVATAR_AUDIO_RE } from '@/lib/audio/program-audio'
import type { Scene } from '@/lib/types'

export function useTimelineAudio(): void {
  useEffect(() => {
    const engine = getTimelineAudioEngine()
    let mapScenes: Scene[] | null = null
    let map = new Map<string, string>()
    // Avatar lipsync speech the engine must NOT take over (the avatar overlay
    // plays it + drives lipsync). Rebuilt with the url-map when scenes change.
    let exceptions = new Set<string>()
    // The store fires on EVERY mutation (selection, hover, chat-token streaming,
    // grade preview). Gate on the audio-relevant slices so we don't rebuild the
    // url-map / reconcile voices when nothing audio-related changed.
    let last: { tl: unknown; gt: number; playing: boolean; scenes: unknown; master: unknown } | null = null
    const sync = () => {
      const s = useVideoStore.getState()
      const tl = s.project.timeline
      const gt = s.timelineTransport.globalTime
      const playing = s.timelineTransport.isPlaying
      const scenes = s.scenes
      const master = s.project.audioSettings?.masterVolume
      if (
        last &&
        last.tl === tl &&
        last.gt === gt &&
        last.playing === playing &&
        last.scenes === scenes &&
        last.master === master
      ) {
        return
      }
      last = { tl, gt, playing, scenes, master }
      if (scenes !== mapScenes) {
        mapScenes = scenes
        map = buildAudioUrlMap(scenes)
        exceptions = new Set([...map.keys()].filter((k) => AVATAR_AUDIO_RE.test(k)))
      }
      engine.sync(
        tl,
        { globalTime: gt, isPlaying: playing },
        { sceneAudioUrls: map, masterVolume: master, ownsSceneAudio: true, ownershipExceptions: exceptions },
      )
    }
    sync()
    const unsub = useVideoStore.subscribe(sync)
    return () => {
      unsub()
      engine.sync(null, { globalTime: 0, isPlaying: false })
    }
  }, [])
}
