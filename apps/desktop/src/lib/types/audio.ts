export interface AudioLayer {
  enabled: boolean
  src: string | null
  volume: number // 0–1
  fadeIn: boolean
  fadeOut: boolean
  startOffset: number // seconds

  // Multi-track fields (AudioLayerV2)
  tts?: TTSTrack | null
  sfx?: SFXTrack[]
  music?: MusicTrack | null

  // Mixing / leveling / ducking / normalization. Optional and additive:
  // when absent, export audio behaves exactly as before. Set via the agent's
  // set_audio_mix tool. See src/lib/audio/audio-processing.ts for the resolver that
  // both export mixers (FFmpeg render-server + Web Audio pixi-mp4) consume.
  audioProcessing?: AudioProcessing | null
}

/**
 * Agent-controllable audio mix settings for one scene's audio layer.
 *
 * Two things are scene-local and two are program-level:
 *  - `masterGain` + per-category gains (`ttsGain`/`musicGain`/`sfxGain`) and
 *    `ducking` are applied PER SCENE by each mixer. Per-category gain is a bus
 *    layer: final = clip.volume × categoryGain × masterGain.
 *  - `normalize` records PROGRAM intent. Loudness normalization is applied ONCE,
 *    post-stitch, as a single FFmpeg loudnorm pass on the final concatenated
 *    video (engine-agnostic, true LUFS) — never per scene (per-scene targets
 *    don't survive stitch/crossfade).
 *
 * All numeric fields are clamped by resolveAudioProcessing(). Absent ⇒ defaults.
 */
export interface AudioProcessing {
  /** Per-scene linear trim on the whole mix. 1 = unchanged. Clamp [0, 4]. */
  masterGain?: number
  /** Bus gain on the narration track. 1 = unchanged. Clamp [0, 4]. */
  ttsGain?: number
  /** Bus gain on background music. 1 = unchanged. Clamp [0, 4]. */
  musicGain?: number
  /** Bus gain on all SFX. 1 = unchanged. Clamp [0, 4]. */
  sfxGain?: number
  /** Program-level loudness normalization, applied once post-stitch (FFmpeg loudnorm). */
  normalize?: {
    enabled: boolean
    /** Integrated loudness target in LUFS. Default -14 (social/YouTube). Clamp [-30, -9]. */
    targetLufs?: number
  }
  /** Music-under-narration ducking parameters (supersede the legacy hardcoded values). */
  ducking?: {
    /** Authoritative on/off gate. set_audio_mix mirrors this to MusicTrack.duckDuringTTS
     *  so both export mixers honor it. */
    enabled?: boolean
    /** 0–1: music level while narration plays (lower = more duck). Default 0.2. */
    duckLevel?: number
    /** Fade-down time in ms. Default 100. Clamp [5, 1000]. */
    attackMs?: number
    /** Fade-up time in ms. Default 500. Clamp [50, 3000]. */
    releaseMs?: number
    /** FFmpeg sidechain compression ratio. Default 10. Clamp [2, 20]. */
    ratio?: number
  }
}

// ── Audio Provider Types ─────────────────────────────────────────────────────

export type TTSProvider =
  | 'web-speech'
  | 'puter'
  | 'native-tts'
  | 'openai-edge-tts'
  | 'pocket-tts'
  | 'voxcpm'
  | 'google-tts'
  | 'elevenlabs'
  | 'openai-tts'
  | 'gemini-tts'

export type SFXProvider = 'freesound' | 'pixabay' | 'elevenlabs-sfx' | 'local' | 'zzfx'
export type MusicProvider =
  | 'pixabay-music'
  | 'freesound-music'
  | 'stable-audio'
  | 'elevenlabs-music'
  | 'lyria'
  // Local, $0, no external provider: the agent composes the track itself via the
  // native sample-based sequencer (compose_music). Used as the MusicTrack origin tag.
  | 'native-sequencer'
  // Local, $0: a self-managed MusicGen sidecar (text prompt -> audio) reached via
  // MUSICGEN_URL — the neural counterpart to compose_music. Mirrors pocket-tts.
  | 'musicgen'

export interface TTSTrack {
  text: string
  provider: TTSProvider
  voiceId: string | null
  src: string | null
  status: 'pending' | 'generating' | 'ready' | 'error'
  duration: number | null
  instructions: string | null
  /** Subtitle files emitted alongside the audio. `null` when caption
   *  generation was skipped (e.g. empty text, missing duration). */
  captions?: {
    srtUrl: string
    vttUrl: string
    /** Word-level timings. From provider alignment when available, otherwise
     *  a naive even distribution across the audio duration. `kind` tells
     *  downstream consumers which kind they're dealing with. */
    kind: 'aligned' | 'naive'
    words: { text: string; start: number; end: number }[]
  } | null
}

export interface SFXTrack {
  id: string
  name: string
  provider: SFXProvider
  src: string
  triggerAt: number
  volume: number
  duration: number | null
  /** License note or URL from provider (e.g. Pixabay License, Freesound CC URL) — for compliance */
  license?: string | null
}

export interface MusicTrack {
  name: string
  provider: MusicProvider
  src: string
  volume: number
  loop: boolean
  duckDuringTTS: boolean
  duckLevel: number
}

export interface AudioSettings {
  defaultTTSProvider: TTSProvider | 'auto'
  defaultSFXProvider: SFXProvider | 'auto'
  defaultMusicProvider: MusicProvider | 'auto'
  defaultVoiceId: string | null
  defaultVoiceName: string | null
  webSpeechVoice: string | null
  puterProvider: 'openai' | 'elevenlabs'
  openaiTTSModel: 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts'
  openaiTTSVoice: string
  geminiTTSModel: 'gemini-2.5-flash-preview-tts' | 'gemini-2.5-pro-preview-tts'
  geminiVoice: string | null
  edgeTTSUrl: string | null
  pocketTTSUrl: string | null
  voxcpmUrl: string | null
  /** Local MusicGen sidecar URL (the neural text-prompt music provider). Defaults to
   *  http://localhost:8090 when unset; mirrors the pocketTTSUrl local-server pattern. */
  musicgenUrl: string | null
  globalMusicDucking: boolean
  globalMusicDuckLevel: number
  /**
   * Program master gain — a LINEAR multiplier (1.0 = unity = 0 dB), 0..2 (+6 dB
   * ceiling). The Master fader in the mixer reads/writes this; the timeline
   * engine multiplies the master bus by it, and the export's program-level mix
   * applies it once post-stitch. `undefined`/absent ⇒ unity, so existing
   * projects behave exactly as before. Read via {@link resolveMasterVolume}.
   */
  masterVolume?: number
}

/** Program master gain, defaulted to unity and clamped to the 0..2 stage range.
 *  The single safe reader for both engine and mixer. */
export function resolveMasterVolume(settings: Pick<AudioSettings, 'masterVolume'> | null | undefined): number {
  const v = settings?.masterVolume
  if (!Number.isFinite(v as number)) return 1
  return Math.max(0, Math.min(2, v as number))
}

/** True when the master fader is away from unity — drives the mixer's
 *  "master not at 0 dB" indicator. */
export function isMasterNonUnity(settings: Pick<AudioSettings, 'masterVolume'> | null | undefined): boolean {
  return Math.abs(resolveMasterVolume(settings) - 1) > 1e-4
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  defaultTTSProvider: 'auto',
  defaultSFXProvider: 'auto',
  defaultMusicProvider: 'auto',
  defaultVoiceId: null,
  defaultVoiceName: null,
  webSpeechVoice: null,
  puterProvider: 'openai',
  openaiTTSModel: 'tts-1',
  openaiTTSVoice: 'alloy',
  geminiTTSModel: 'gemini-2.5-flash-preview-tts',
  geminiVoice: null,
  edgeTTSUrl: null,
  pocketTTSUrl: null,
  voxcpmUrl: null,
  musicgenUrl: null,
  globalMusicDucking: true,
  globalMusicDuckLevel: 0.2,
  masterVolume: 1,
}
