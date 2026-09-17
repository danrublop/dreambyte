import fs from 'fs/promises'
import path from 'path'
import type { TTSProviderInterface, TTSParams, TTSResult, Voice } from '../types'
import { safeAudioFilename } from '../sanitize'
import { getAudioDir, audioUrlFor } from '../paths'

const API_URL = 'https://api.openai.com/v1/audio/speech'
const FETCH_TIMEOUT_MS = 60_000
const DEFAULT_MODEL = 'tts-1'
const DEFAULT_VOICE = 'alloy'

const VOICES: Voice[] = [
  { id: 'alloy', name: 'Alloy', language: 'en', gender: 'neutral' },
  { id: 'ash', name: 'Ash', language: 'en', gender: 'male' },
  { id: 'ballad', name: 'Ballad', language: 'en', gender: 'male' },
  { id: 'coral', name: 'Coral', language: 'en', gender: 'female' },
  { id: 'echo', name: 'Echo', language: 'en', gender: 'male' },
  { id: 'fable', name: 'Fable', language: 'en', gender: 'male' },
  { id: 'nova', name: 'Nova', language: 'en', gender: 'female' },
  { id: 'onyx', name: 'Onyx', language: 'en', gender: 'male' },
  { id: 'sage', name: 'Sage', language: 'en', gender: 'female' },
  { id: 'shimmer', name: 'Shimmer', language: 'en', gender: 'female' },
]

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set')
  return key
}

export const openaiTTS: TTSProviderInterface = {
  id: 'openai-tts',
  name: 'OpenAI TTS',
  type: 'server',
  requiresKey: 'OPENAI_API_KEY',

  async generate(params: TTSParams): Promise<TTSResult> {
    const apiKey = getApiKey()
    const model = params.model || DEFAULT_MODEL
    const voice = params.voiceId || DEFAULT_VOICE

    const body: Record<string, unknown> = {
      model,
      voice,
      input: params.text,
      response_format: 'mp3',
    }

    // instructions only works with gpt-4o-mini-tts
    if (params.instructions && model === 'gpt-4o-mini-tts') {
      body.instructions = params.instructions
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI TTS error (${response.status}): ${errorText}`)
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer())

    const audioDir = getAudioDir()
    await fs.mkdir(audioDir, { recursive: true })

    const filename = safeAudioFilename('tts', params.sceneId, 'mp3')
    const filePath = path.join(audioDir, filename)
    await fs.writeFile(filePath, audioBuffer)

    // Estimate duration from MP3 file size (128kbps bitrate assumption)
    const durationEstimate = (audioBuffer.length * 8) / (128 * 1000)

    return {
      audioUrl: audioUrlFor(filename),
      duration: Math.round(durationEstimate * 10) / 10,
      provider: 'openai-tts',
    }
  },

  async listVoices(): Promise<Voice[]> {
    return VOICES
  },
}
