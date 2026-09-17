export interface AudioProviderDef {
  id: string
  name: string
  category: 'tts' | 'sfx' | 'music'
  type: 'server' | 'client' | 'local'
  requiresKey: string | null
  defaultEnabled: boolean
}

export const AUDIO_PROVIDERS: AudioProviderDef[] = [
  // TTS providers
  {
    id: 'elevenlabs',
    name: 'ElevenLabs TTS',
    category: 'tts',
    type: 'server',
    requiresKey: 'ELEVENLABS_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    category: 'tts',
    type: 'server',
    requiresKey: 'OPENAI_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'gemini-tts',
    name: 'Gemini TTS',
    category: 'tts',
    type: 'server',
    requiresKey: 'GEMINI_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'google-tts',
    name: 'Google Cloud TTS',
    category: 'tts',
    type: 'server',
    requiresKey: 'GOOGLE_TTS_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'openai-edge-tts',
    name: 'Edge TTS (Local)',
    category: 'tts',
    type: 'local',
    requiresKey: null,
    defaultEnabled: true,
  },
  {
    id: 'pocket-tts',
    name: 'Pocket TTS (Local)',
    category: 'tts',
    type: 'local',
    requiresKey: null,
    defaultEnabled: true,
  },
  {
    id: 'voxcpm',
    name: 'VoxCPM2 (Local GPU)',
    category: 'tts',
    type: 'local',
    requiresKey: null,
    defaultEnabled: true,
  },
  { id: 'puter', name: 'Puter.js (Browser)', category: 'tts', type: 'client', requiresKey: null, defaultEnabled: true },
  {
    id: 'web-speech',
    name: 'Web Speech (Browser)',
    category: 'tts',
    type: 'client',
    requiresKey: null,
    defaultEnabled: true,
  },
  // SFX providers
  {
    id: 'elevenlabs-sfx',
    name: 'ElevenLabs SFX',
    category: 'sfx',
    type: 'server',
    requiresKey: 'ELEVENLABS_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'freesound',
    name: 'Freesound',
    category: 'sfx',
    type: 'server',
    requiresKey: 'FREESOUND_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'pixabay',
    name: 'Pixabay SFX',
    category: 'sfx',
    type: 'server',
    requiresKey: 'PIXABAY_API_KEY',
    defaultEnabled: true,
  },
  // Music providers
  // Paid generative music — each gets a Settings card (enable + key + per-model
  // permission/cost), so the Models tab is the single home for its cost limit.
  {
    id: 'stable-audio',
    name: 'Stable Audio (FAL)',
    category: 'music',
    type: 'server',
    requiresKey: 'FAL_KEY',
    defaultEnabled: true,
  },
  {
    id: 'elevenlabs-music',
    name: 'ElevenLabs Music',
    category: 'music',
    type: 'server',
    requiresKey: 'ELEVENLABS_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'lyria',
    name: 'Google Lyria',
    category: 'music',
    type: 'server',
    requiresKey: 'GOOGLE_AI_KEY',
    defaultEnabled: true,
  },
  {
    id: 'pixabay-music',
    name: 'Pixabay Music',
    category: 'music',
    type: 'server',
    requiresKey: 'PIXABAY_API_KEY',
    defaultEnabled: true,
  },
  {
    id: 'freesound-music',
    name: 'Freesound Music',
    category: 'music',
    type: 'server',
    requiresKey: 'FREESOUND_API_KEY',
    defaultEnabled: true,
  },
  // Local, $0 generators. Composer (the template/instrument sequencer) is built-in and
  // always ready, on by default. MusicGen is the neural text-prompt sidecar — opt-in
  // (defaultEnabled false) since it needs a local server running; enabling it in Settings
  // surfaces it in the picker. Its URL defaults to http://localhost:8090 (musicgenUrl overrides).
  {
    id: 'native-sequencer',
    name: 'Composer (local)',
    category: 'music',
    type: 'local',
    requiresKey: null,
    defaultEnabled: true,
  },
  {
    id: 'musicgen',
    name: 'MusicGen (local)',
    category: 'music',
    type: 'local',
    requiresKey: null,
    defaultEnabled: false,
  },
]

/** Local server URL env vars for providers that need a running service */
const LOCAL_URL_VARS: Record<string, string> = {
  'openai-edge-tts': 'EDGE_TTS_URL',
  'pocket-tts': 'POCKET_TTS_URL',
  voxcpm: 'VOXCPM_URL',
  musicgen: 'MUSICGEN_URL',
}

/**
 * Built-in local generators that need no key and no running server to be "ready" — the
 * enable toggle alone gates them. Composer renders in-process; MusicGen has a localhost
 * default (a sidecar the user runs), so readiness is the user opt-in, not a probe.
 */
const ALWAYS_READY_LOCAL = new Set(['native-sequencer', 'musicgen'])

/** Check if an audio provider is configured (API key set, server URL set, or platform-native) */
export function isAudioProviderReady(p: AudioProviderDef): boolean {
  if (p.requiresKey) return !!process.env[p.requiresKey]
  if (ALWAYS_READY_LOCAL.has(p.id)) return true
  if (p.type === 'local') return !!(LOCAL_URL_VARS[p.id] && process.env[LOCAL_URL_VARS[p.id]])
  if (p.id === 'native-tts') return process.platform === 'darwin' || process.platform === 'win32'
  return true // client-side (puter, web-speech) always available
}

export const DEFAULT_AUDIO_PROVIDER_ENABLED: Record<string, boolean> = Object.fromEntries(
  AUDIO_PROVIDERS.map((p) => [p.id, p.defaultEnabled && isAudioProviderReady(p)]),
)
