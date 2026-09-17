import fs from 'fs/promises'
import path from 'path'
import type { TTSProviderInterface, TTSParams, TTSResult, Voice } from '../types'
import { safeAudioFilename } from '../sanitize'
import { getAudioDir, audioUrlFor } from '../paths'

const DEFAULT_VOICE = 'en-US-AndrewNeural'

const EDGE_VOICES: Voice[] = [
  { id: 'en-US-AndrewNeural', name: 'Andrew', language: 'en-US', gender: 'male' },
  { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US', gender: 'female' },
  { id: 'en-US-AvaNeural', name: 'Ava', language: 'en-US', gender: 'female' },
  { id: 'en-US-BrianNeural', name: 'Brian', language: 'en-US', gender: 'male' },
  { id: 'en-US-ChristopherNeural', name: 'Christopher', language: 'en-US', gender: 'male' },
  { id: 'en-US-EmmaNeural', name: 'Emma', language: 'en-US', gender: 'female' },
  { id: 'en-US-EricNeural', name: 'Eric', language: 'en-US', gender: 'male' },
  { id: 'en-US-GuyNeural', name: 'Guy', language: 'en-US', gender: 'male' },
  { id: 'en-US-JennyNeural', name: 'Jenny', language: 'en-US', gender: 'female' },
  { id: 'en-US-MichelleNeural', name: 'Michelle', language: 'en-US', gender: 'female' },
  { id: 'en-US-RogerNeural', name: 'Roger', language: 'en-US', gender: 'male' },
  { id: 'en-US-SteffanNeural', name: 'Steffan', language: 'en-US', gender: 'male' },
  { id: 'en-GB-RyanNeural', name: 'Ryan (UK)', language: 'en-GB', gender: 'male' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (UK)', language: 'en-GB', gender: 'female' },
  { id: 'en-GB-LibbyNeural', name: 'Libby (UK)', language: 'en-GB', gender: 'female' },
  { id: 'en-AU-NatashaNeural', name: 'Natasha (AU)', language: 'en-AU', gender: 'female' },
  { id: 'en-AU-WilliamNeural', name: 'William (AU)', language: 'en-AU', gender: 'male' },
]

function getBaseUrl(): string {
  return process.env.EDGE_TTS_URL || 'http://localhost:5050'
}

export const openaiEdgeTTS: TTSProviderInterface = {
  id: 'openai-edge-tts',
  name: 'Edge TTS (Local)',
  type: 'server',
  requiresKey: null,

  async generate(params: TTSParams): Promise<TTSResult> {
    const baseUrl = getBaseUrl()
    const voice = params.voiceId || DEFAULT_VOICE

    const response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice,
        input: params.text,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Edge TTS error (${response.status}): ${errorText}`)
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
      provider: 'openai-edge-tts',
    }
  },

  async listVoices(): Promise<Voice[]> {
    const baseUrl = getBaseUrl()

    try {
      const response = await fetch(`${baseUrl}/v1/voices`, {
        signal: AbortSignal.timeout(3000),
      })

      if (response.ok) {
        const data = (await response.json()) as Array<{
          id?: string
          name?: string
          ShortName?: string
          Locale?: string
          Gender?: string
        }>

        if (Array.isArray(data) && data.length > 0) {
          return data.map((v) => ({
            id: v.ShortName || v.id || v.name || '',
            name: v.name || v.ShortName || v.id || '',
            language: v.Locale || 'en-US',
            gender: v.Gender?.toLowerCase(),
          }))
        }
      }
    } catch {
      // Server unavailable or no voices endpoint, fall back to hardcoded list
    }

    return EDGE_VOICES
  },
}
