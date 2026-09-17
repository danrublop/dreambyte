import type { AudioLayer } from '../types'

const DEFAULT_AUDIO_LAYER: AudioLayer = {
  enabled: false,
  src: null,
  volume: 1,
  fadeIn: false,
  fadeOut: false,
  startOffset: 0,
  tts: null,
  sfx: [],
  music: null,
}

/**
 * Normalize an AudioLayer from any version to the full multi-track shape.
 * Old scenes stored { enabled, src, volume, fadeIn, fadeOut, startOffset }
 * without tts/sfx/music fields. This converts them at runtime.
 */
export function normalizeAudioLayer(raw: AudioLayer | null | undefined): AudioLayer {
  if (!raw) return { ...DEFAULT_AUDIO_LAYER }

  // Already has multi-track fields
  if ('tts' in raw && raw.tts !== undefined) {
    return {
      ...raw,
      sfx: raw.sfx ?? [],
      music: raw.music ?? null,
    }
  }

  // Legacy: treat src as a pre-generated TTS track if present
  return {
    ...raw,
    tts: raw.src
      ? {
          text: '',
          provider: 'elevenlabs',
          voiceId: null,
          src: raw.src,
          status: 'ready' as const,
          duration: null,
          instructions: null,
        }
      : null,
    sfx: [],
    music: null,
  }
}
