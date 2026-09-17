import fs from 'fs/promises'
import path from 'path'
import type { TTSProviderInterface, TTSParams, TTSResult, Voice } from '../types'
import { safeAudioFilename } from '../sanitize'
import { getAudioDir, audioUrlFor } from '../paths'

const FETCH_TIMEOUT_MS = 60_000
const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts'
const DEFAULT_VOICE = 'Kore'

const GEMINI_VOICES: Voice[] = [
  { id: 'Kore', name: 'Kore', language: 'en', gender: 'female' },
  { id: 'Charon', name: 'Charon', language: 'en', gender: 'male' },
  { id: 'Fenrir', name: 'Fenrir', language: 'en', gender: 'male' },
  { id: 'Aoede', name: 'Aoede', language: 'en', gender: 'female' },
  { id: 'Puck', name: 'Puck', language: 'en', gender: 'male' },
  { id: 'Leda', name: 'Leda', language: 'en', gender: 'female' },
  { id: 'Orus', name: 'Orus', language: 'en', gender: 'male' },
]

function createWavHeader(
  pcmDataLength: number,
  sampleRate: number,
  numChannels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcmDataLength
  const headerSize = 44

  const buffer = Buffer.alloc(headerSize)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(dataSize + headerSize - 8, 4)
  buffer.write('WAVE', 8)

  // fmt sub-chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // sub-chunk size
  buffer.writeUInt16LE(1, 20) // PCM format
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)

  // data sub-chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  return buffer
}

async function generateViaGeminiAPI(params: TTSParams, apiKey: string): Promise<Buffer> {
  const model = params.model || DEFAULT_MODEL
  const voiceName = params.voiceId || DEFAULT_VOICE

  let inputText = params.text
  if (params.instructions) {
    inputText = `[${params.instructions}] ${params.text}`
  }

  // Build the request body
  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: inputText }] }],
    generationConfig: {
      response_modalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName,
          },
        },
      },
    },
  }

  // Multi-speaker support
  if (params.speakers && params.speakers.length > 0) {
    const speakerVoiceConfigs = params.speakers.map((s) => ({
      speaker: s.speaker,
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: s.voiceName,
        },
      },
    }))

    ;(body.generationConfig as Record<string, unknown>).speechConfig = {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs,
      },
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

  const response = await fetch(url, {
    method: 'POST',
    // Key in a header, not the URL query: query strings end up in proxy/server logs.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini TTS error (${response.status}): ${errorText}`)
  }

  const data = (await response.json()) as {
    candidates: Array<{
      content: {
        parts: Array<{
          inlineData?: { mimeType: string; data: string }
        }>
      }
    }>
  }

  const audioPart = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)
  if (!audioPart?.inlineData) {
    throw new Error('Gemini TTS returned no audio data')
  }

  const pcmData = Buffer.from(audioPart.inlineData.data, 'base64')

  // Gemini returns raw PCM audio — wrap it in a WAV header
  // Default: 24000 Hz, mono, 16-bit PCM (standard for Gemini TTS output)
  const sampleRate = 24000
  const numChannels = 1
  const bitsPerSample = 16

  const wavHeader = createWavHeader(pcmData.length, sampleRate, numChannels, bitsPerSample)
  return Buffer.concat([wavHeader, pcmData])
}

async function generateViaGoogleCloudTTS(params: TTSParams, apiKey: string): Promise<Buffer> {
  const voiceId = params.voiceId || 'en-US-Studio-O'
  // Extract language code from voice name (e.g. "en-US-Studio-O" -> "en-US")
  const languageCode = voiceId.split('-').slice(0, 2).join('-') || 'en-US'

  let inputText = params.text
  if (params.instructions) {
    inputText = `[${params.instructions}] ${params.text}`
  }

  const response = await fetch(`https://texttospeech.googleapis.com/v1beta1/text:synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      input: { text: inputText },
      voice: {
        languageCode,
        name: voiceId,
      },
      audioConfig: {
        audioEncoding: 'MP3',
      },
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Google Cloud TTS (Gemini) error (${response.status}): ${errorText}`)
  }

  const data = (await response.json()) as { audioContent: string }
  return Buffer.from(data.audioContent, 'base64')
}

export const geminiTTS: TTSProviderInterface = {
  id: 'gemini-tts',
  name: 'Gemini TTS',
  type: 'server',
  requiresKey: 'GEMINI_API_KEY',

  async generate(params: TTSParams): Promise<TTSResult> {
    const geminiKey = process.env.GEMINI_API_KEY
    const googleKey = process.env.GOOGLE_TTS_API_KEY

    if (!geminiKey && !googleKey) {
      throw new Error('Either GEMINI_API_KEY or GOOGLE_TTS_API_KEY must be set for Gemini TTS')
    }

    const audioDir = getAudioDir()
    await fs.mkdir(audioDir, { recursive: true })

    let audioBuffer: Buffer
    let extension: string

    if (geminiKey) {
      // Path A: Gemini Developer API — returns PCM wrapped as WAV
      audioBuffer = await generateViaGeminiAPI(params, geminiKey)
      extension = 'wav'
    } else {
      // Path B: Google Cloud TTS fallback — returns MP3
      audioBuffer = await generateViaGoogleCloudTTS(params, googleKey!)
      extension = 'mp3'
    }

    const filename = safeAudioFilename('tts', params.sceneId, extension)
    const filePath = path.join(audioDir, filename)
    await fs.writeFile(filePath, audioBuffer)

    // Estimate duration
    let durationEstimate: number
    if (extension === 'wav') {
      // WAV: calculate from PCM data (subtract 44 byte header)
      const pcmBytes = audioBuffer.length - 44
      const bytesPerSecond = 24000 * 1 * 2 // sampleRate * channels * bytesPerSample
      durationEstimate = pcmBytes / bytesPerSecond
    } else {
      // MP3: estimate from file size (128kbps)
      durationEstimate = (audioBuffer.length * 8) / (128 * 1000)
    }

    return {
      audioUrl: audioUrlFor(filename),
      duration: Math.round(durationEstimate * 10) / 10,
      provider: 'gemini-tts',
    }
  },

  async listVoices(): Promise<Voice[]> {
    return GEMINI_VOICES
  },
}
