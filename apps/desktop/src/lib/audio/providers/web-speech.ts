import type { TTSProviderInterface, TTSParams, TTSResult, Voice } from '../types'

export const webSpeechTTS: TTSProviderInterface = {
  id: 'web-speech',
  name: 'Web Speech API',
  type: 'client',
  requiresKey: null,

  async generate(params: TTSParams): Promise<TTSResult> {
    const text = encodeURIComponent(params.text)
    const voiceId = params.voiceId ? encodeURIComponent(params.voiceId) : ''
    const url = voiceId ? `web-speech://${text}?voice=${voiceId}` : `web-speech://${text}`

    return {
      audioUrl: url,
      duration: null,
      provider: 'web-speech',
    }
  },

  async listVoices(): Promise<Voice[]> {
    // Voices are browser-dependent and only available client-side
    return []
  },
}
