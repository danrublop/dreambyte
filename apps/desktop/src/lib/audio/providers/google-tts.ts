import fs from 'fs/promises'
import path from 'path'
import type { TTSProviderInterface, TTSParams, TTSResult, Voice } from '../types'
import { safeAudioFilename } from '../sanitize'
import { getAudioDir, audioUrlFor } from '../paths'

const API_BASE = 'https://texttospeech.googleapis.com/v1'
const FETCH_TIMEOUT_MS = 60_000
const DEFAULT_VOICE = 'en-US-Neural2-F'
const DEFAULT_LANGUAGE = 'en-US'

function getApiKey(): string {
  const key = process.env.GOOGLE_TTS_API_KEY
  if (!key) throw new Error('GOOGLE_TTS_API_KEY is not set')
  return key
}

export const googleTTS: TTSProviderInterface = {
  id: 'google-tts',
  name: 'Google Cloud TTS',
  type: 'server',
  requiresKey: 'GOOGLE_TTS_API_KEY',

  async generate(params: TTSParams): Promise<TTSResult> {
    const apiKey = getApiKey()
    const voiceId = params.voiceId || DEFAULT_VOICE

    // Extract language code from voice name (e.g. "en-US-Neural2-F" -> "en-US")
    const languageCode = voiceId.split('-').slice(0, 2).join('-') || DEFAULT_LANGUAGE

    const response = await fetch(`${API_BASE}/text:synthesize`, {
      method: 'POST',
      // Key in a header, not the URL query: query strings end up in proxy/server logs.
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        input: { text: params.text },
        voice: {
          languageCode,
          name: voiceId,
        },
        audioConfig: {
          audioEncoding: 'MP3',
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Google TTS error (${response.status}): ${errorText}`)
    }

    const data = (await response.json()) as { audioContent: string }
    const audioBuffer = Buffer.from(data.audioContent, 'base64')

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
      provider: 'google-tts',
    }
  },

  async listVoices(): Promise<Voice[]> {
    const apiKey = getApiKey()

    const response = await fetch(`${API_BASE}/voices`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`Google TTS voices error (${response.status}): ${await response.text()}`)
    }

    const data = (await response.json()) as {
      voices: Array<{
        name: string
        languageCodes: string[]
        ssmlGender: string
      }>
    }

    return data.voices.map((v) => ({
      id: v.name,
      name: v.name,
      language: v.languageCodes[0] || 'en-US',
      gender: v.ssmlGender?.toLowerCase(),
    }))
  },
}
