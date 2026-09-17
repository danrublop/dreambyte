import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { SFXProviderInterface, SFXResult, SFXSearchOptions } from '../types'
import { getAudioDir, audioUrlFor } from '../paths'

const API_BASE = 'https://api.elevenlabs.io/v1'
const FETCH_TIMEOUT_MS = 60_000

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')
  return key
}

async function generateSFX(prompt: string, duration?: number): Promise<SFXResult> {
  const apiKey = getApiKey()

  const response = await fetch(`${API_BASE}/sound-generation`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: duration || 3,
      prompt_influence: 0.3,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`ElevenLabs SFX generation error (${response.status}): ${errorText}`)
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer())

  const audioDir = getAudioDir()
  await fs.mkdir(audioDir, { recursive: true })

  const timestamp = Date.now()
  const rand = crypto.randomBytes(4).toString('hex')
  const filename = `sfx-generated-${timestamp}-${rand}.mp3`
  const filePath = path.join(audioDir, filename)
  await fs.writeFile(filePath, audioBuffer)

  // Estimate duration from MP3 file size (rough: 128kbps VBR average)
  const durationEstimate = (audioBuffer.length * 8) / (128 * 1000)

  const localUrl = audioUrlFor(filename)
  return {
    id: `elevenlabs-sfx-${timestamp}`,
    name: prompt,
    audioUrl: localUrl,
    duration: Math.round(durationEstimate * 10) / 10,
    provider: 'elevenlabs-sfx',
    previewUrl: localUrl,
  }
}

export const elevenlabsSFX: SFXProviderInterface = {
  id: 'elevenlabs-sfx',
  name: 'ElevenLabs Sound Effects',
  requiresKey: 'ELEVENLABS_API_KEY',

  async search(query: string, _limit?: number, _options?: SFXSearchOptions): Promise<SFXResult[]> {
    // ElevenLabs SFX is generative, not a search library.
    const result = await generateSFX(query)
    return [result]
  },

  generate: generateSFX,
}
