import type { IpcMain } from 'electron'
import { isTelemetryEnabled, setTelemetryEnabled, track as telemetryTrack } from '../../lib/telemetry'
import { listProviderKeyStatus, setProviderKey, type ProviderKeyId, PROVIDER_ENV_VARS } from '../provider-keys'
import { resetProviderClients } from '../../lib/agents/providers'
import { IpcValidationError } from './_helpers'

/**
 * Category: settings
 *
 * Exposes desktop-side helpers for audio + media provider availability.
 */

type TTSProvider =
  | 'elevenlabs'
  | 'openai-tts'
  | 'gemini-tts'
  | 'google-tts'
  | 'openai-edge-tts'
  | 'pocket-tts'
  | 'voxcpm'
  | 'native-tts'
  | 'puter'
  | 'web-speech'

type SFXProvider = 'elevenlabs-sfx' | 'freesound' | 'pixabay'
type MusicProvider = 'pixabay-music' | 'freesound-music' | 'native-sequencer' | 'musicgen'

interface ProviderAvailability<T extends string> {
  id: T
  name: string
  available: boolean
}

interface MediaProviderInfo {
  id: string
  name: string
  category: 'video' | 'image' | 'avatar' | 'utility'
  available: boolean
}

export interface ListProvidersResult {
  providers: {
    tts: ProviderAvailability<TTSProvider>[]
    sfx: ProviderAvailability<SFXProvider>[]
    music: ProviderAvailability<MusicProvider>[]
  }
  media: MediaProviderInfo[]
}

function listProviders(): ListProvidersResult {
  return {
    providers: {
      tts: [
        { id: 'elevenlabs', name: 'ElevenLabs', available: !!process.env.ELEVENLABS_API_KEY },
        { id: 'openai-tts', name: 'OpenAI TTS', available: !!process.env.OPENAI_API_KEY },
        { id: 'gemini-tts', name: 'Gemini TTS', available: !!process.env.GEMINI_API_KEY },
        { id: 'google-tts', name: 'Google Cloud TTS', available: !!process.env.GOOGLE_TTS_API_KEY },
        { id: 'openai-edge-tts', name: 'Edge TTS (local)', available: !!process.env.EDGE_TTS_URL },
        { id: 'pocket-tts', name: 'Pocket TTS (local)', available: !!process.env.POCKET_TTS_URL },
        { id: 'voxcpm', name: 'VoxCPM2 (local GPU)', available: !!process.env.VOXCPM_URL },
        {
          id: 'native-tts',
          name: 'System Voice',
          available: process.platform === 'darwin' || process.platform === 'win32',
        },
        { id: 'puter', name: 'Puter.js', available: true },
        { id: 'web-speech', name: 'Web Speech API', available: true },
      ],
      sfx: [
        { id: 'elevenlabs-sfx', name: 'ElevenLabs SFX', available: !!process.env.ELEVENLABS_API_KEY },
        { id: 'freesound', name: 'Freesound', available: !!process.env.FREESOUND_API_KEY },
        { id: 'pixabay', name: 'Pixabay', available: !!process.env.PIXABAY_API_KEY },
      ],
      music: [
        // Local generators — always ready (the enable toggle gates them in the picker).
        { id: 'native-sequencer', name: 'Composer (local)', available: true },
        { id: 'musicgen', name: 'MusicGen (local)', available: true },
        { id: 'pixabay-music', name: 'Pixabay Music', available: !!process.env.PIXABAY_API_KEY },
        { id: 'freesound-music', name: 'Freesound Music', available: !!process.env.FREESOUND_API_KEY },
      ],
    },
    media: [
      { id: 'veo3', name: 'Veo3 Video', category: 'video', available: !!process.env.GOOGLE_AI_KEY },
      { id: 'kling', name: 'Kling 2.1', category: 'video', available: !!process.env.FAL_KEY },
      { id: 'runway', name: 'Runway Gen-4', category: 'video', available: !!process.env.RUNWAY_API_KEY },
      { id: 'googleImageGen', name: 'Google Imagen', category: 'image', available: !!process.env.GOOGLE_AI_KEY },
      { id: 'imageGen', name: 'FAL Image Gen', category: 'image', available: !!process.env.FAL_KEY },
      { id: 'dall-e', name: 'DALL-E 3', category: 'image', available: !!process.env.OPENAI_API_KEY },
      { id: 'heygen', name: 'HeyGen Avatars', category: 'avatar', available: !!process.env.HEYGEN_API_KEY },
      { id: 'musetalk', name: 'MuseTalk', category: 'avatar', available: !!process.env.FAL_KEY },
      { id: 'fabric', name: 'Fabric 1.0', category: 'avatar', available: !!process.env.FAL_KEY },
      { id: 'aurora', name: 'Aurora', category: 'avatar', available: !!process.env.FAL_KEY },
      { id: 'backgroundRemoval', name: 'Background Removal', category: 'utility', available: true },
      { id: 'unsplash', name: 'Unsplash', category: 'utility', available: true },
    ],
  }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:settings.listProviders', async () => listProviders())

  // Telemetry controls. The Settings UI reads `dreambyte:settings.getTelemetry`
  // to render the toggle and posts back to `dreambyte:settings.setTelemetry`.
  // The toggle takes effect immediately (src/lib/telemetry updates its in-memory
  // config) and persists via the opt-out file marker; an env-var force-off
  // (DREAMBYTE_TELEMETRY_DISABLED) still wins for the session.
  ipcMain.handle('dreambyte:settings.getTelemetry', async () => ({ enabled: isTelemetryEnabled() }))
  ipcMain.handle('dreambyte:settings.setTelemetry', async (_e, args: { enabled: boolean }) => {
    setTelemetryEnabled(!!args.enabled)
    // Track the toggle itself only when turning telemetry ON — turning it off
    // shouldn't generate one last event.
    if (args.enabled) telemetryTrack('telemetry_enabled', {})
    return { ok: true as const }
  })

  // Renderer-initiated event tracking. The renderer can call
  // `dreambyteApi.settings.trackEvent('scene_generated', { sceneType: 'react' })`
  // and we forward to the main-process telemetry queue. Keeps all network
  // egress in main where opt-out + sandbox rules are enforced.
  ipcMain.handle(
    'dreambyte:settings.trackEvent',
    async (_e, args: { event: string; properties?: Record<string, unknown> }) => {
      if (!args?.event || typeof args.event !== 'string') return { ok: false as const }
      telemetryTrack(args.event, args.properties ?? {})
      return { ok: true as const }
    },
  )

  // BYOK key management — see src/electron/provider-keys.ts for storage details.
  // The Settings panel never holds decrypted values; it only sees
  // `{ hasKey, maskedPreview }` rows and writes `{ provider, apiKey }` back.
  ipcMain.handle('dreambyte:settings.listProviderKeys', async () => ({
    keys: listProviderKeyStatus(),
  }))

  ipcMain.handle('dreambyte:settings.setProviderKey', async (_e, args: { provider: string; apiKey: string | null }) => {
    if (!args || typeof args !== 'object') throw new IpcValidationError('args required')
    const provider = args.provider as ProviderKeyId
    if (!provider || !(provider in PROVIDER_ENV_VARS)) {
      throw new IpcValidationError(`Unknown provider: ${args.provider}`)
    }
    const value = typeof args.apiKey === 'string' ? args.apiKey : null
    setProviderKey(provider, value)
    // Drop cached Anthropic/OpenAI/Google clients so the next agent turn
    // re-reads process.env with the freshly-saved key.
    resetProviderClients()
    return { ok: true as const }
  })
}
