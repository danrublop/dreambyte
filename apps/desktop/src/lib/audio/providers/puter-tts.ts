import type { TTSProviderInterface, TTSParams, TTSResult, Voice } from '../types'

const OPENAI_VOICES = [
  { id: 'alloy', name: 'Alloy', gender: 'neutral' },
  { id: 'echo', name: 'Echo', gender: 'male' },
  { id: 'nova', name: 'Nova', gender: 'female' },
  { id: 'shimmer', name: 'Shimmer', gender: 'female' },
  { id: 'fable', name: 'Fable', gender: 'male' },
  { id: 'onyx', name: 'Onyx', gender: 'male' },
] as const

export const puterTTS: TTSProviderInterface = {
  id: 'puter',
  name: 'Puter TTS',
  type: 'client',
  requiresKey: null,

  async generate(params: TTSParams): Promise<TTSResult> {
    const text = encodeURIComponent(params.text)
    const provider = params.model || 'openai'
    const voiceId = params.voiceId || 'nova'
    const url = `puter-tts://${text}?provider=${encodeURIComponent(provider)}&voice=${encodeURIComponent(voiceId)}`

    return {
      audioUrl: url,
      duration: null,
      provider: 'puter',
    }
  },

  async listVoices(): Promise<Voice[]> {
    return OPENAI_VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      language: 'en',
      gender: v.gender,
      previewUrl: null,
    }))
  },
}
