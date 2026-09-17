import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomBytes } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { TTSProviderInterface, TTSParams, TTSResult, Voice } from '../types'
import { safeAudioFilename } from '../sanitize'
import { getAudioDir, audioUrlFor } from '../paths'
import { createLogger } from '../../logger'

const log = createLogger('audio.native-tts')

const execFileAsync = promisify(execFile)

function sanitizeText(text: string): string {
  return text.replace(/[\x00-\x1f]/g, ' ')
}

/** Only allow safe characters in voice IDs to prevent shell/PowerShell injection */
function sanitizeVoiceId(id: string): string {
  // Real voice names are alphanumeric with spaces, hyphens, periods, and underscores
  const cleaned = id.replace(/[^a-zA-Z0-9 \-_.]/g, '')
  if (cleaned !== id) {
    log.warn('stripped unsafe characters from voiceId', { extra: { from: id, to: cleaned } })
  }
  return cleaned
}

async function ffmpegConvert(input: string, output: string): Promise<void> {
  await execFileAsync('ffmpeg', ['-y', '-i', input, '-ar', '44100', '-ac', '1', '-b:a', '128k', output], {
    timeout: 30_000,
  })
}

function estimateDuration(mp3Bytes: number): number {
  return Math.round(((mp3Bytes * 8) / (128 * 1000)) * 10) / 10
}

// ── macOS ────────────────────────────────────────────────────────────────────

async function generateMac(params: TTSParams, outMp3: string): Promise<number> {
  const voice = sanitizeVoiceId(params.voiceId || 'Samantha')
  // Random suffix, not Date.now() alone — two concurrent generations in the
  // same millisecond would collide on the temp path and clobber each other.
  const tmpAiff = path.join(os.tmpdir(), `native-tts-${randomBytes(8).toString('hex')}.aiff`)
  try {
    await execFileAsync('say', ['-v', voice, '-o', tmpAiff, sanitizeText(params.text)], { timeout: 60_000 })
    await ffmpegConvert(tmpAiff, outMp3)
    const stat = await fs.stat(outMp3)
    return estimateDuration(stat.size)
  } finally {
    await fs.unlink(tmpAiff).catch(() => {})
  }
}

async function listVoicesMac(): Promise<Voice[]> {
  const { stdout } = await execFileAsync('say', ['-v', '?'], { timeout: 10_000 })
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // Format: "Name       lang_REGION  # description"
      const match = line.match(/^(.+?)\s{2,}(\S+)\s+#\s*(.*)$/)
      if (!match) return null
      const [, name, langRaw, description] = match
      const lang = langRaw.replace('_', '-')
      return {
        id: name.trim(),
        name: `${name.trim()} — ${description.trim()}`,
        language: lang,
      }
    })
    .filter((v): v is Voice => v !== null)
}

// ── Windows ──────────────────────────────────────────────────────────────────

async function generateWin(params: TTSParams, outMp3: string): Promise<number> {
  const voice = sanitizeVoiceId(params.voiceId || '')
  const tmpWav = path.join(os.tmpdir(), `native-tts-${randomBytes(8).toString('hex')}.wav`)
  const escapedText = sanitizeText(params.text).replace(/'/g, "''")
  const selectVoice = voice ? `$synth.SelectVoice('${voice.replace(/'/g, "''")}')` : ''
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    selectVoice,
    `$synth.SetOutputToWaveFile('${tmpWav.replace(/'/g, "''")}')`,
    `$synth.Speak('${escapedText}')`,
    '$synth.Dispose()',
  ]
    .filter(Boolean)
    .join('; ')

  try {
    await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 60_000 })
    await ffmpegConvert(tmpWav, outMp3)
    const stat = await fs.stat(outMp3)
    return estimateDuration(stat.size)
  } finally {
    await fs.unlink(tmpWav).catch(() => {})
  }
}

async function listVoicesWin(): Promise<Voice[]> {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$synth.GetInstalledVoices() | ForEach-Object {',
    '  $v = $_.VoiceInfo',
    '  "$($v.Name)|$($v.Culture.Name)|$($v.Gender)"',
    '}',
    '$synth.Dispose()',
  ].join('; ')
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 10_000 })
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, lang, gender] = line.split('|')
      return {
        id: name,
        name,
        language: lang || 'en-US',
        gender: gender?.toLowerCase(),
      }
    })
}

// ── Provider ─────────────────────────────────────────────────────────────────

export const nativeTTS: TTSProviderInterface = {
  id: 'native-tts',
  name: 'System Voice',
  type: 'server',
  requiresKey: null,

  async generate(params: TTSParams): Promise<TTSResult> {
    const platform = process.platform
    if (platform !== 'darwin' && platform !== 'win32') {
      throw new Error('Native TTS is only available on macOS and Windows')
    }

    const audioDir = getAudioDir()
    await fs.mkdir(audioDir, { recursive: true })
    const filename = safeAudioFilename('tts', params.sceneId, 'mp3')
    const outMp3 = path.join(audioDir, filename)

    const duration = platform === 'darwin' ? await generateMac(params, outMp3) : await generateWin(params, outMp3)

    return {
      audioUrl: audioUrlFor(filename),
      duration,
      provider: 'native-tts',
    }
  },

  async listVoices(): Promise<Voice[]> {
    if (process.platform === 'darwin') return listVoicesMac()
    if (process.platform === 'win32') return listVoicesWin()
    return []
  },
}
