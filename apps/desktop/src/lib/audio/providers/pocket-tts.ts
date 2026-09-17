import fs from 'fs/promises'
import path from 'path'
import type { TTSProviderInterface, TTSParams, TTSResult, Voice, VoiceCloneParams, VoiceCloneResult } from '../types'
import { safeAudioFilename } from '../sanitize'
import { getAudioDir, audioUrlFor } from '../paths'

const FETCH_TIMEOUT_MS = 60_000
const DEFAULT_VOICE = 'alba'

const POCKET_VOICES: Voice[] = [
  { id: 'alba', name: 'Alba', language: 'en', gender: 'female' },
  { id: 'marius', name: 'Marius', language: 'en', gender: 'male' },
  { id: 'javert', name: 'Javert', language: 'en', gender: 'male' },
  { id: 'jean', name: 'Jean', language: 'en', gender: 'male' },
  { id: 'fantine', name: 'Fantine', language: 'en', gender: 'female' },
  { id: 'cosette', name: 'Cosette', language: 'en', gender: 'female' },
  { id: 'eponine', name: 'Eponine', language: 'en', gender: 'female' },
  { id: 'azelma', name: 'Azelma', language: 'en', gender: 'female' },
]

/** Voice name → HuggingFace voice URL mapping for built-in voices */
const VOICE_URLS: Record<string, string> = {
  alba: 'hf://kyutai/tts-voices/alba.wav',
  marius: 'hf://kyutai/tts-voices/marius.wav',
  javert: 'hf://kyutai/tts-voices/javert.wav',
  jean: 'hf://kyutai/tts-voices/jean.wav',
  fantine: 'hf://kyutai/tts-voices/fantine.wav',
  cosette: 'hf://kyutai/tts-voices/cosette.wav',
  eponine: 'hf://kyutai/tts-voices/eponine.wav',
  azelma: 'hf://kyutai/tts-voices/azelma.wav',
}

function getBaseUrl(): string {
  return process.env.POCKET_TTS_URL || 'http://localhost:8000'
}

export const pocketTTS: TTSProviderInterface = {
  id: 'pocket-tts',
  name: 'Pocket TTS (Local)',
  type: 'server',
  requiresKey: null,

  async generate(params: TTSParams): Promise<TTSResult> {
    const baseUrl = getBaseUrl()
    const voice = params.voiceId || DEFAULT_VOICE

    // Pocket TTS uses POST /tts with multipart form data
    const formData = new FormData()
    formData.append('text', params.text)

    // Only pass voice_url for non-default voices (cloned voices or explicit HF URLs).
    // The server's default voice is set via --voice flag at startup.
    // Passing voice_url for built-in voices triggers voice cloning mode which requires HF auth.
    const isBuiltIn = voice in VOICE_URLS
    if (!isBuiltIn && voice) {
      formData.append('voice_url', voice)
    }

    const response = await fetch(`${baseUrl}/tts`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Pocket TTS error (${response.status}): ${errorText}`)
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer())

    const audioDir = getAudioDir()
    await fs.mkdir(audioDir, { recursive: true })

    // Pocket TTS returns WAV audio
    const filename = safeAudioFilename('tts', params.sceneId, 'wav')
    const filePath = path.join(audioDir, filename)
    await fs.writeFile(filePath, audioBuffer)

    // Estimate duration from WAV file size (24kHz, 16-bit, mono = 48000 bytes/sec)
    const headerSize = 44
    const durationEstimate = Math.max(0, audioBuffer.length - headerSize) / 48000

    return {
      audioUrl: audioUrlFor(filename),
      duration: Math.round(durationEstimate * 10) / 10,
      provider: 'pocket-tts',
    }
  },

  async listVoices(): Promise<Voice[]> {
    // Pocket TTS doesn't have a voices endpoint — return hardcoded list
    return POCKET_VOICES
  },

  async cloneVoice(params: VoiceCloneParams): Promise<VoiceCloneResult> {
    // Pocket TTS supports cloning by passing voice_wav in the /tts call.
    // We store the reference audio and return a voice ID that maps to it.
    const audioDir = path.join(getAudioDir(), 'voices')
    await fs.mkdir(audioDir, { recursive: true })

    const voiceId = `cloned-${Date.now().toString(36)}`
    const voicePath = path.join(audioDir, `${voiceId}.wav`)
    await fs.writeFile(voicePath, params.audioBuffer)

    return {
      voiceId: voiceId,
      name: params.name,
    }
  },
}
