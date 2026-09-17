import fs from 'fs/promises'
import path from 'path'
import type { TTSProviderInterface, TTSParams, TTSResult, Voice, VoiceCloneParams, VoiceCloneResult } from '../types'
import { safeAudioFilename } from '../sanitize'
import { buildCaptionBundle, type CharAlignment } from '../captions'
import { getAudioDir, audioUrlFor } from '../paths'

const API_BASE = 'https://api.elevenlabs.io/v1'
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // Rachel
const DEFAULT_MODEL = 'eleven_turbo_v2_5'

// Cap every ElevenLabs call so a stalled TTS request can't hang the agent turn.
const FETCH_TIMEOUT_MS = 60_000

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')
  return key
}

export const elevenlabsTTS: TTSProviderInterface = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  type: 'server',
  requiresKey: 'ELEVENLABS_API_KEY',

  async generate(params: TTSParams): Promise<TTSResult> {
    const apiKey = getApiKey()
    const voiceId = params.voiceId || DEFAULT_VOICE_ID
    const model = params.model || DEFAULT_MODEL

    const response = await fetch(`${API_BASE}/text-to-speech/${voiceId}/with-timestamps`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        text: params.text,
        model_id: model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`ElevenLabs TTS error (${response.status}): ${errorText}`)
    }

    const payload = (await response.json()) as {
      audio_base64: string
      alignment?: CharAlignment
      normalized_alignment?: CharAlignment
    }
    const audioBuffer = Buffer.from(payload.audio_base64, 'base64')

    const audioDir = getAudioDir()
    await fs.mkdir(audioDir, { recursive: true })

    const filename = safeAudioFilename('tts', params.sceneId, 'mp3')
    const filePath = path.join(audioDir, filename)
    await fs.writeFile(filePath, audioBuffer)

    // Estimate duration from MP3 file size (128kbps bitrate assumption)
    const durationEstimate = (audioBuffer.length * 8) / (128 * 1000)

    const result: TTSResult = {
      audioUrl: audioUrlFor(filename),
      duration: Math.round(durationEstimate * 10) / 10,
      provider: 'elevenlabs',
    }

    const alignment = payload.normalized_alignment ?? payload.alignment
    if (alignment && alignment.characters.length > 0) {
      const bundle = buildCaptionBundle(alignment)
      const base = filename.replace(/\.mp3$/, '')
      const srtName = `${base}.srt`
      const vttName = `${base}.vtt`
      await Promise.all([
        fs.writeFile(path.join(audioDir, srtName), bundle.srt, 'utf8'),
        fs.writeFile(path.join(audioDir, vttName), bundle.vtt, 'utf8'),
      ])
      result.captions = {
        srtUrl: audioUrlFor(srtName),
        vttUrl: audioUrlFor(vttName),
        kind: 'aligned',
        words: bundle.words,
      }
    }

    return result
  },

  async listVoices(): Promise<Voice[]> {
    const apiKey = getApiKey()

    const response = await fetch(`${API_BASE}/voices`, {
      headers: {
        'xi-api-key': apiKey,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`ElevenLabs voices error (${response.status}): ${await response.text()}`)
    }

    const data = (await response.json()) as {
      voices: Array<{
        voice_id: string
        name: string
        labels?: Record<string, string>
        preview_url?: string
      }>
    }

    return data.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      language: v.labels?.language || 'en',
      gender: v.labels?.gender,
      previewUrl: v.preview_url || null,
    }))
  },

  // Instant Voice Cloning. Multipart POST /v1/voices/add (raw fetch + xi-api-key, consistent with
  // the rest of this provider — the SDK's voices.ivc.create wraps the same endpoint). Consent +
  // trust-guard + spend gate are enforced upstream in src/lib/services/voice-clone.ts; this method is
  // the raw provider call. Throws (fail-loud) on a missing key or a non-2xx.
  async cloneVoice(params: VoiceCloneParams): Promise<VoiceCloneResult> {
    const apiKey = getApiKey()

    const form = new FormData()
    form.append('name', params.name)
    form.append('files', new Blob([new Uint8Array(params.audioBuffer)]), 'sample.mp3')
    if (params.transcript) form.append('description', params.transcript)

    const response = await fetch(`${API_BASE}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`ElevenLabs voice clone error (${response.status}): ${await response.text()}`)
    }

    const data = (await response.json()) as { voice_id?: string; name?: string }
    if (!data.voice_id) throw new Error('ElevenLabs voice clone returned no voice_id')
    return { voiceId: data.voice_id, name: data.name || params.name }
  },

  // Hard delete the remote voiceprint (right-to-erasure). DELETE /v1/voices/{id}. Fail-loud so the
  // caller never reports a deletion that didn't reach the third party.
  async deleteVoice(voiceId: string): Promise<void> {
    const apiKey = getApiKey()
    const response = await fetch(`${API_BASE}/voices/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`ElevenLabs voice delete error (${response.status}): ${await response.text()}`)
    }
  },
}
