'use client'

/**
 * Timeline audio engine — the single WebAudio owner of timeline playback.
 *
 * Graph (mixer topology, post-fader metering):
 *
 *   voice.gain (clip envelope × opacity)
 *     → trackBus.gain (Track.volume fader)
 *     → trackBus.pan  (Track.pan)
 *     → trackBus.analyser  (per-track meter, post-fader)
 *     → master.gain (program masterVolume)
 *     → master.analyser (master meter)
 *     → destination
 *
 * Each audio/video track gets one bus, created lazily when its first voice
 * plays and pruned when the track leaves the timeline. The mixer reads
 * `getTrackLevel(trackId)` / `getMasterLevel()` off the analysers and drives the
 * faders via the `track/setVolume`·`track/setPan` actions, which land back here
 * on the next sync.
 *
 * Two classes of clip:
 *  - STANDALONE audio (files dropped on the timeline; `sourceId` is a URL) —
 *    always played here.
 *  - SCENE-MIRROR audio (`aud-`/`tts-`/`mus-`/`avatar-audio:` + raw sfx ids) —
 *    played here ONLY when `ownsSceneAudio` is set, with the URL resolved from
 *    the scene→URL map. Default OFF: scene audio keeps playing inside its scene
 *    iframe (legacy behaviour) until the playback-controller mutes those iframes
 *    and flips this flag, so audio never plays twice.
 *
 * Per-clip volume = clip.opacity × `gain` keyframe envelope (clamped 0..2),
 * centralised in mix-math `clipBaseGain`. Track mute/solo gate the WANTED set
 * (muted/solo-excluded clips simply don't sound — cheap, and unmute re-syncs via
 * the drift policy). trimStart + speed map to currentTime offset / playbackRate;
 * clock drift is corrected by the pure `decideDriftCorrection` policy.
 */

import type { Timeline, Clip } from '@/lib/types'
import { evaluateKeyframes } from '@/lib/compositor/interpolate'
import { clipBaseGain, clamp, MAX_STAGE_GAIN, resolveMasterGain } from './mix-math'
import { decideDriftCorrection, MICRO_FADE_SEC } from './drift-policy'
import { isStandaloneAudioClip, isSceneMirrorAudioClip } from './program-audio'

interface ActiveVoice {
  clip: Clip
  trackId: string
  el: HTMLAudioElement
  gain: GainNode
  source: MediaElementAudioSourceNode
  /** Drift-policy nudge state, fed back each tick. */
  nudging: boolean
}

/** One mixer channel: fader → pan → meter tap, shared by every voice on the track. */
interface TrackBus {
  gain: GainNode
  pan: StereoPannerNode
  analyser: AnalyserNode
  meterBuf: Uint8Array
}

export interface TransportState {
  globalTime: number
  isPlaying: boolean
}

export interface SyncOptions {
  /** scene sourceId → media URL (from buildAudioUrlMap). Required to play scene-mirror clips. */
  sceneAudioUrls?: Map<string, string>
  /** When true, scene-mirror clips play through this engine (scene iframes must be muted). */
  ownsSceneAudio?: boolean
  /** Program master gain (project.audioSettings.masterVolume). Default unity. */
  masterVolume?: number
  /** sourceIds the engine must NOT take over even when ownsSceneAudio is true
   *  (e.g. live avatar speech that drives lipsync from the iframe). */
  ownershipExceptions?: Set<string>
}

/**
 * Resolve the media URL a clip should play, or null if it isn't playable by
 * this engine under the current options. The standalone / scene-mirror split
 * lives in program-audio.ts so preview and export share one definition.
 */
function resolveClipUrl(clip: Clip, opts: SyncOptions): string | null {
  // The scene url-map is the authoritative scene-mirror id set (catches bare-id
  // SFX clips the prefix regex misses), so a scene SFX clip is never treated as
  // a standalone file the engine would try to load by its bare id.
  const mirror = opts.sceneAudioUrls
  if (isStandaloneAudioClip(clip, mirror)) return clip.sourceId
  if (!opts.ownsSceneAudio) return null
  if (!isSceneMirrorAudioClip(clip, mirror)) return null
  if (opts.ownershipExceptions?.has(clip.sourceId)) return null
  return opts.sceneAudioUrls?.get(clip.sourceId) ?? null
}

/** Clip volume at clip-local time: base volume × keyframed gain envelope
 *  (rubber-band; 0..2 where 2 = +6 dB). Delegates the clamp to mix-math. */
export function clipVolumeAt(clip: Clip, localTime: number): number {
  if (clip.audioMuted) return 0
  const base = Number.isFinite(clip.opacity) ? clip.opacity : 1
  const env = evaluateKeyframes(clip.keyframes ?? [], 'gain', localTime, 1) ?? 1
  return clipBaseGain(base, env)
}

function rmsFromAnalyser(analyser: AnalyserNode | null, buf: Uint8Array | null): number {
  if (!analyser || !buf) return 0
  analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 2.2)
}

export class TimelineAudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private meterBuf: Uint8Array | null = null
  private voices = new Map<string, ActiveVoice>()
  private buses = new Map<string, TrackBus>()

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.master.connect(this.analyser)
      this.analyser.connect(this.ctx.destination)
      this.meterBuf = new Uint8Array(this.analyser.fftSize)
    }
    return this.ctx
  }

  private ensureBus(ctx: AudioContext, trackId: string): TrackBus {
    let bus = this.buses.get(trackId)
    if (!bus) {
      const gain = ctx.createGain()
      const pan = ctx.createStereoPanner()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      gain.connect(pan)
      pan.connect(analyser)
      analyser.connect(this.master!)
      bus = { gain, pan, analyser, meterBuf: new Uint8Array(analyser.fftSize) }
      this.buses.set(trackId, bus)
    }
    return bus
  }

  /**
   * Reconcile audible voices against the timeline + transport. Called on every
   * transport tick (cheap when nothing sounds — early-returns before touching
   * the AudioContext) and on timeline edits.
   */
  sync(timeline: Timeline | null | undefined, transport: TransportState, opts: SyncOptions = {}): void {
    // Solo scoped to the AUDIO bus: a soloed VIDEO track is a visual-only action
    // and must not mute the music/voice in preview + the mixer. (Matches
    // buildProgramAudioClips so preview, mixer, and export agree.)
    const anySolo = (timeline?.tracks ?? []).some((t) => t.type === 'audio' && t.solo === true)
    const wanted = new Map<string, { clip: Clip; trackId: string; localTime: number; url: string }>()

    if (timeline && transport.isPlaying) {
      for (const track of timeline.tracks) {
        if (track.type !== 'audio' && track.type !== 'video') continue
        if (track.muted) continue
        if (anySolo && !track.solo) continue
        for (const clip of track.clips) {
          const url = resolveClipUrl(clip, opts)
          if (!url) continue
          const localTime = transport.globalTime - clip.startTime
          if (localTime < 0 || localTime >= clip.duration) continue
          wanted.set(clip.id, { clip, trackId: track.id, localTime, url })
        }
      }
    }

    // Stop voices that should no longer play.
    for (const [id, voice] of this.voices) {
      if (!wanted.has(id)) this.stopVoice(id, voice)
    }

    // Activity gate: with nothing wanted there's no graph work to do —
    // but still keep master/bus gains current so a paused meter reads silence.
    if (wanted.size === 0) {
      this.pruneBuses(timeline)
      return
    }

    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()
    this.master!.gain.value = resolveMasterGain(opts.masterVolume)

    // Apply per-track fader + pan to every bus that backs a wanted voice.
    const trackById = new Map((timeline?.tracks ?? []).map((t) => [t.id, t]))
    for (const { trackId } of wanted.values()) {
      const bus = this.ensureBus(ctx, trackId)
      const track = trackById.get(trackId)
      const vol = Number.isFinite(track?.volume) ? (track!.volume as number) : 1
      bus.gain.gain.value = clamp(vol, 0, MAX_STAGE_GAIN)
      const pan = Number.isFinite(track?.pan) ? (track!.pan as number) : 0
      bus.pan.pan.value = clamp(pan, -1, 1)
    }

    for (const [id, { clip, trackId, localTime, url }] of wanted) {
      let voice = this.voices.get(id)
      const baseRate = clip.speed > 0 ? clip.speed : 1
      // When a reseek micro-fade is scheduled this tick, the fade IS the gain
      // ramp — a direct gain.value write below would cancel it, so skip it.
      let gainOwnedByFade = false
      if (!voice) {
        const el = new Audio()
        el.crossOrigin = 'anonymous'
        el.preservesPitch = true
        el.src = url
        const source = ctx.createMediaElementSource(el)
        const gain = ctx.createGain()
        source.connect(gain)
        gain.connect(this.ensureBus(ctx, trackId).gain)
        voice = { clip, trackId, el, gain, source, nudging: false }
        this.voices.set(id, voice)
        this.seekVoice(voice, localTime)
        voice.el.playbackRate = baseRate // #4: rate must be set on first play, not just on later ticks
        void el.play().catch(() => {})
      } else {
        voice.clip = clip
        // If the clip jumped tracks, re-route to the new bus.
        if (voice.trackId !== trackId) {
          try {
            voice.gain.disconnect()
          } catch {
            /* already disconnected */
          }
          voice.gain.connect(this.ensureBus(ctx, trackId).gain)
          voice.trackId = trackId
        }
        const expected = clip.trimStart + localTime * baseRate
        const decision = decideDriftCorrection({
          drift: voice.el.currentTime - expected,
          nudging: voice.nudging,
          baseRate,
        })
        voice.nudging = decision.nudging
        if (decision.action === 'reseek') {
          this.seekVoice(voice, localTime)
          this.microFade(voice, localTime, clip)
          gainOwnedByFade = true
        }
        voice.el.playbackRate = decision.playbackRate
        if (voice.el.paused) void voice.el.play().catch(() => {})
      }
      // Per-voice gain carries only the clip envelope; the fader (Track.volume)
      // and program master live on the bus / master nodes, so moving them is a
      // single write, not N per-voice writes. (#1: don't overwrite a pending
      // reseek micro-fade ramp.)
      if (!gainOwnedByFade) voice.gain.gain.value = clipVolumeAt(clip, localTime)
    }

    this.pruneBuses(timeline)
  }

  private stopVoice(id: string, voice: ActiveVoice): void {
    voice.el.pause()
    try {
      voice.source.disconnect()
      voice.gain.disconnect()
    } catch {
      /* already disconnected */
    }
    voice.el.src = ''
    this.voices.delete(id)
  }

  /** Disconnect buses whose track is gone from the timeline and has no voices. */
  private pruneBuses(timeline: Timeline | null | undefined): void {
    if (this.buses.size === 0) return
    const live = new Set((timeline?.tracks ?? []).map((t) => t.id))
    const voiced = new Set([...this.voices.values()].map((v) => v.trackId))
    for (const [trackId, bus] of this.buses) {
      if (live.has(trackId) || voiced.has(trackId)) continue
      try {
        bus.gain.disconnect()
        bus.pan.disconnect()
        bus.analyser.disconnect()
      } catch {
        /* already disconnected */
      }
      this.buses.delete(trackId)
    }
  }

  private seekVoice(voice: ActiveVoice, localTime: number): void {
    const target = voice.clip.trimStart + localTime * (voice.clip.speed > 0 ? voice.clip.speed : 1)
    try {
      voice.el.currentTime = Math.max(0, target)
    } catch {
      /* not seekable yet — the drift check re-seeks next tick */
    }
  }

  /** Mask a reseek discontinuity with a short gain ramp from 0 → target. */
  private microFade(voice: ActiveVoice, localTime: number, clip: Clip): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    const target = clipVolumeAt(clip, localTime)
    try {
      voice.gain.gain.cancelScheduledValues(now)
      voice.gain.gain.setValueAtTime(0, now)
      voice.gain.gain.linearRampToValueAtTime(target, now + MICRO_FADE_SEC)
    } catch {
      /* ramp scheduling failed (suspended ctx) — next tick sets gain directly */
    }
  }

  /** Master RMS level 0..1 for the meters (0 when idle). */
  getMasterLevel(): number {
    if (this.voices.size === 0) return 0
    return rmsFromAnalyser(this.analyser, this.meterBuf)
  }

  /** @deprecated use getMasterLevel — kept for the existing AudioMeter. */
  getLevel(): number {
    return this.getMasterLevel()
  }

  /** Per-track RMS level 0..1 (post-fader), 0 when the track has no live bus. */
  getTrackLevel(trackId: string): number {
    const bus = this.buses.get(trackId)
    if (!bus) return 0
    const hasVoice = [...this.voices.values()].some((v) => v.trackId === trackId)
    if (!hasVoice) return 0
    return rmsFromAnalyser(bus.analyser, bus.meterBuf)
  }

  /** Track ids that currently have a live (sounding) bus. */
  activeTrackIds(): string[] {
    return [...new Set([...this.voices.values()].map((v) => v.trackId))]
  }

  hasActiveVoices(): boolean {
    return this.voices.size > 0
  }

  /** Introspection for live debugging (window.__dreambyteAudioEngine). */
  debug(): Record<string, unknown> {
    return {
      ctxState: this.ctx?.state ?? 'none',
      masterGain: this.master?.gain.value ?? null,
      buses: [...this.buses.entries()].map(([id, b]) => ({ id, gain: b.gain.gain.value, pan: b.pan.pan.value })),
      voices: [...this.voices.entries()].map(([id, v]) => ({
        id: id.slice(0, 8),
        track: v.trackId,
        src: v.el.src.slice(0, 60),
        t: v.el.currentTime,
        rate: v.el.playbackRate,
        nudging: v.nudging,
        paused: v.el.paused,
        err: v.el.error?.code ?? null,
        gain: v.gain.gain.value,
        readyState: v.el.readyState,
      })),
    }
  }

  dispose(): void {
    this.sync(null, { globalTime: 0, isPlaying: false })
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
      this.master = null
      this.analyser = null
      this.buses.clear()
    }
  }
}

let singleton: TimelineAudioEngine | null = null

/** Module singleton — the meter component and the sync hook share it. */
export function getTimelineAudioEngine(): TimelineAudioEngine {
  if (!singleton) {
    singleton = new TimelineAudioEngine()
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __dreambyteAudioEngine?: TimelineAudioEngine }).__dreambyteAudioEngine = singleton
    }
  }
  return singleton
}
