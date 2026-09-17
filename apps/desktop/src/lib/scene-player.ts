/**
 * ScenePlayer — controls a scene iframe via postMessage.
 *
 * Each scene iframe contains an anime.js master timeline + scene clock controlled by
 * the playback controller. ScenePlayer sends commands (play, pause,
 * seek, reset) and receives state updates (ready, timeupdate, ended).
 */

export type ScenePlayerStatus = 'loading' | 'ready' | 'playing' | 'paused' | 'ended'

export class ScenePlayer {
  private iframe: HTMLIFrameElement
  private sceneId: string
  private boundHandler: (e: MessageEvent) => void

  public duration: number = 0
  public currentTime: number = 0
  public status: ScenePlayerStatus = 'loading'

  // Callbacks
  onReady?: (duration: number) => void
  onTimeUpdate?: (currentTime: number) => void
  onEnded?: () => void
  /** The scene's playback controller failed to initialize (e.g. anime.js missing — C4b). */
  onInitError?: (error: string) => void
  onPaused?: (currentTime: number) => void
  onSeeked?: (currentTime: number) => void
  /** In-scene interaction events (from DreambyteReact hooks) */
  onVariableChanged?: (name: string, value: unknown) => void
  onElementClicked?: (elementId: string, data?: Record<string, unknown>) => void
  onInteractionEvent?: (name: string, payload?: unknown) => void

  constructor(iframe: HTMLIFrameElement, sceneId: string) {
    this.iframe = iframe
    this.sceneId = sceneId
    this.boundHandler = this.handleMessage.bind(this)
    window.addEventListener('message', this.boundHandler)
  }

  private send(msg: Record<string, unknown>) {
    try {
      this.iframe.contentWindow?.postMessage({ target: 'dreambyte-scene', sceneId: this.sceneId, ...msg }, '*')
    } catch {}
  }

  private handleMessage(event: MessageEvent) {
    const data = event.data
    if (!data || data.source !== 'dreambyte-scene') return
    if (data.sceneId !== this.sceneId) return

    switch (data.type) {
      case 'ready':
        this.duration = data.duration ?? 0
        this.status = 'paused'
        this.onReady?.(this.duration)
        break

      case 'timeupdate':
        this.currentTime = data.currentTime ?? 0
        this.onTimeUpdate?.(this.currentTime)
        break

      case 'playing':
        this.status = 'playing'
        break

      case 'paused':
        this.status = 'paused'
        this.currentTime = data.currentTime ?? this.currentTime
        this.onPaused?.(this.currentTime)
        break

      case 'seeked':
        this.currentTime = data.currentTime ?? this.currentTime
        this.onSeeked?.(this.currentTime)
        break

      case 'ended':
        this.status = 'ended'
        this.onEnded?.()
        break

      case 'init_error':
        // The controller couldn't build its timeline (anime.js missing). Mark the
        // player dead so the parent skips this scene like a verify error (C4b).
        this.status = 'ended'
        this.onInitError?.(typeof data.error === 'string' ? data.error : 'Scene failed to initialize')
        break

      case 'state':
        this.currentTime = data.currentTime ?? this.currentTime
        this.duration = data.duration ?? this.duration
        this.status = data.status ?? this.status
        break

      // In-scene interaction events (from DreambyteReact hooks)
      case 'variable_changed':
        this.onVariableChanged?.(data.name, data.value)
        break
      case 'element_clicked':
        this.onElementClicked?.(data.elementId, data.data)
        break
      case 'interaction_event':
        this.onInteractionEvent?.(data.name, data.payload)
        break
    }
  }

  play() {
    this.send({ type: 'play' })
  }

  pause() {
    this.send({ type: 'pause' })
  }

  seek(time: number) {
    this.send({ type: 'seek', time })
  }

  /** Enter scrub mode — mutes all audio/video for the duration of the drag. */
  startScrub() {
    this.send({ type: 'scrub_start' })
  }

  /** Exit scrub mode — restores per-element muted state captured at scrub_start. */
  endScrub() {
    this.send({ type: 'scrub_end' })
  }

  reset() {
    this.send({ type: 'reset' })
  }

  getState() {
    this.send({ type: 'get_state' })
  }

  /** Mute or unmute all audio/video in the scene (track mute). */
  setAudioMuted(muted: boolean) {
    this.send({ type: 'set_audio_muted', muted })
  }

  /**
   * Push the per-category timeline mix (faders / pan / solo / master) so the
   * preview matches the exported mix. `mix` is a `SceneAudioMix`
   * ({ tts, file, music, sfx: { id: CategoryMix } }) from `resolveSceneAudioMix` —
   * the same resolver the export uses, so preview and export agree by construction.
   */
  setSceneAudioMix(mix: unknown) {
    this.send({ type: 'set_scene_audio_mix', mix })
  }

  /**
   * Hand this scene's audio ownership to the timeline audio engine. When
   * `true`, the scene's own tts/music/sfx/legacy `<audio>`/`<video>` stay muted
   * so the engine — which plays the SAME sources through the mixer + meters —
   * is the single audio path (no double-play). Sticky inside the controller and
   * re-applied on every media sync; avatar lipsync speech is exempt.
   */
  setEngineOwnsAudio(value: boolean) {
    this.send({ type: 'set_engine_owns_audio', value })
  }

  /** Push a variable value into the scene iframe */
  setVariable(name: string, value: unknown) {
    this.send({ type: 'set_variable', name, value })
  }

  /** Fire a named trigger into the scene */
  fireTrigger(name: string, payload?: unknown) {
    this.send({ type: 'fire_trigger', name, payload })
  }

  destroy() {
    window.removeEventListener('message', this.boundHandler)
  }
}
