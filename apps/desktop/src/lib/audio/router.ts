import type { AudioSettings, TTSProvider, SFXProvider, MusicProvider } from '../types'
import type { TTSProviderInterface, SFXProviderInterface, MusicProviderInterface } from './types'

export { getBestTTSProvider } from './resolve-best-tts-provider'

// Lazy-load providers to avoid importing everything at once
const ttsProviders: Record<string, () => Promise<TTSProviderInterface>> = {
  elevenlabs: () => import('./providers/elevenlabs-tts').then((m) => m.elevenlabsTTS),
  'openai-tts': () => import('./providers/openai-tts').then((m) => m.openaiTTS),
  'gemini-tts': () => import('./providers/gemini-tts').then((m) => m.geminiTTS),
  'google-tts': () => import('./providers/google-tts').then((m) => m.googleTTS),
  'openai-edge-tts': () => import('./providers/openai-edge-tts').then((m) => m.openaiEdgeTTS),
  'pocket-tts': () => import('./providers/pocket-tts').then((m) => m.pocketTTS),
  voxcpm: () => import('./providers/voxcpm-tts').then((m) => m.voxcpmTTS),
  'native-tts': () => import('./providers/native-tts').then((m) => m.nativeTTS),
  'web-speech': () => import('./providers/web-speech').then((m) => m.webSpeechTTS),
  puter: () => import('./providers/puter-tts').then((m) => m.puterTTS),
}

const sfxProviders: Record<string, () => Promise<SFXProviderInterface>> = {
  'elevenlabs-sfx': () => import('./providers/elevenlabs-sfx').then((m) => m.elevenlabsSFX),
  freesound: () => import('./providers/freesound').then((m) => m.freesoundSFX),
  pixabay: () => import('./providers/pixabay').then((m) => m.pixabaySFX),
}

const musicProviders: Record<string, () => Promise<MusicProviderInterface>> = {
  'pixabay-music': () => import('./providers/pixabay-music').then((m) => m.pixabayMusic),
  'freesound-music': () => import('./providers/freesound-music').then((m) => m.freesoundMusic),
  'stable-audio': () => import('./providers/stable-audio').then((m) => m.stableAudioMusic),
  'elevenlabs-music': () => import('./providers/elevenlabs-music').then((m) => m.elevenlabsMusic),
  lyria: () => import('./providers/lyria').then((m) => m.lyriaMusic),
  musicgen: () => import('./providers/musicgen-music').then((m) => m.musicgenMusic),
}

export function getBestSFXProvider(settings?: AudioSettings | null): SFXProvider {
  if (settings?.defaultSFXProvider && settings.defaultSFXProvider !== 'auto') {
    return settings.defaultSFXProvider
  }
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs-sfx'
  if (process.env.FREESOUND_API_KEY) return 'freesound'
  if (process.env.PIXABAY_API_KEY) return 'pixabay'
  // No SFX provider configured — freesound will throw but is the best fallback
  return 'freesound'
}

export function getBestMusicProvider(settings?: AudioSettings | null): MusicProvider {
  if (settings?.defaultMusicProvider && settings.defaultMusicProvider !== 'auto') {
    return settings.defaultMusicProvider
  }
  // Prefer the local, $0 MusicGen sidecar when it's running (text-prompt music with
  // no key/cost), before falling back to the library-search providers.
  if (process.env.MUSICGEN_URL) return 'musicgen'
  if (process.env.PIXABAY_API_KEY) return 'pixabay-music'
  return 'freesound-music'
}

export async function getTTSProvider(id: TTSProvider): Promise<TTSProviderInterface> {
  const loader = ttsProviders[id]
  if (!loader) throw new Error(`Unknown TTS provider: ${id}`)
  return loader()
}

export async function getSFXProvider(id: SFXProvider): Promise<SFXProviderInterface> {
  const loader = sfxProviders[id]
  if (!loader) throw new Error(`Unknown SFX provider: ${id}`)
  return loader()
}

export async function getMusicProvider(id: MusicProvider): Promise<MusicProviderInterface> {
  const loader = musicProviders[id]
  if (!loader) throw new Error(`Unknown music provider: ${id}`)
  return loader()
}
