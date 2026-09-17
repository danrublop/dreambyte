import fs from 'fs/promises'
import path from 'path'
import type {
  TTSProviderInterface,
  TTSParams,
  TTSResult,
  Voice,
  VoiceCloneParams,
  VoiceCloneResult,
  VoiceDesignParams,
  VoiceDesignResult,
} from '../types'
import { safeAudioFilename } from '../sanitize'
import { getAudioDir, audioUrlFor } from '../paths'

const DEFAULT_VOICE = 'default'

function getBaseUrl(): string {
  return process.env.VOXCPM_URL || 'http://localhost:8100'
}

export const voxcpmTTS: TTSProviderInterface = {
  id: 'voxcpm',
  name: 'VoxCPM2 (Local GPU)',
  type: 'server',
  requiresKey: null,

  async generate(params: TTSParams): Promise<TTSResult> {
    const baseUrl = getBaseUrl()
    const voice = params.voiceId || DEFAULT_VOICE

    const response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: params.text,
        voice_id: voice,
        mode: 'standard',
        language: 'en',
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`VoxCPM error (${response.status}): ${errorText}`)
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
      provider: 'voxcpm',
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
          voice_id?: string
          language?: string
          gender?: string
        }>

        if (Array.isArray(data) && data.length > 0) {
          return data.map((v) => ({
            id: v.voice_id || v.id || v.name || '',
            name: v.name || v.id || '',
            language: v.language || 'en',
            gender: v.gender?.toLowerCase(),
          }))
        }
      }
    } catch {
      // Server unavailable, return empty — VoxCPM voices are dynamic
    }

    return []
  },

  async cloneVoice(params: VoiceCloneParams): Promise<VoiceCloneResult> {
    const baseUrl = getBaseUrl()

    const formData = new FormData()
    formData.append('name', params.name)
    formData.append('audio', new Blob([new Uint8Array(params.audioBuffer)]), 'reference.wav')
    if (params.transcript) formData.append('transcript', params.transcript)
    formData.append('mode', params.mode || 'controllable')

    const response = await fetch(`${baseUrl}/v1/voices/clone`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`VoxCPM clone error (${response.status}): ${errorText}`)
    }

    const data = (await response.json()) as { voice_id?: string; name?: string }
    return {
      voiceId: data.voice_id || params.name,
      name: data.name || params.name,
    }
  },

  async designVoice(params: VoiceDesignParams): Promise<VoiceDesignResult> {
    const baseUrl = getBaseUrl()

    const response = await fetch(`${baseUrl}/v1/voices/design`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: params.description,
        sample_text: params.sampleText,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`VoxCPM voice design error (${response.status}): ${errorText}`)
    }

    const data = (await response.json()) as { voice_id?: string; name?: string; preview_url?: string }
    return {
      voiceId: data.voice_id || 'designed-voice',
      name: data.name || 'Designed Voice',
      previewUrl: data.preview_url,
    }
  },
}
