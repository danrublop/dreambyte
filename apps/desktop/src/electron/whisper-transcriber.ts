/**
 * Whisper API transcriber.
 *
 * Implements `CaptionTranscriber` against OpenAI's
 * `POST /v1/audio/transcriptions` endpoint with `response_format=srt`
 * so we get a ready-to-parse SRT body back. Pure Node `fetch` + a
 * hand-rolled multipart body so we don't need to add an `openai` SDK
 * dep to the main bundle.
 *
 * Source resolution piggybacks on `resolveSourceForFfmpeg` — the same
 * URI surface as auto-cut-silence: `dreambyte://uploads/...`,
 * `dreambyte://audio/...`, `file://`, `http(s)://`, absolute path.
 *
 * The locked decision #3 picks Whisper API as the default; whisper.cpp
 * is the opt-in local variant and lands in a follow-up. The
 * `setCaptionTranscriber` slot lets the user toggle between them via
 * Settings → Audio → "Caption privacy mode" without touching this file.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { resolveSourceForFfmpeg } from './audio-decode'
import type { CaptionTranscriber, TranscribeOptions, TranscriptionResult } from '@/lib/edit-engines/caption-transcriber'

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const MODEL = 'whisper-1'
const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // OpenAI's hard cap

export interface WhisperApiTranscriberOptions {
  /** Override the OpenAI base URL (Azure proxy, gateway, test stub). */
  endpoint?: string
  /** Override the model name (e.g. `whisper-1-translate`, future fine-tunes). */
  model?: string
  /** Inject a custom fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch
  /** Override the API key resolver. Defaults to `process.env.OPENAI_API_KEY`. */
  resolveApiKey?: () => string | undefined
}

interface ReadFileResult {
  bytes: Uint8Array
  filename: string
  mime: string
}

/** Best-effort mime guess from the filename extension. */
function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  switch (ext) {
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    case '.flac': return 'audio/flac'
    case '.ogg': return 'audio/ogg'
    case '.webm': return 'audio/webm'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    default: return 'application/octet-stream'
  }
}

async function readAudioBytes(source: string): Promise<ReadFileResult> {
  // For http(s) URLs we'd need to download; defer that until first request.
  // Today we only support local paths (dreambyte:// + file:// + absolute).
  if (source.startsWith('http://') || source.startsWith('https://')) {
    throw new Error(`Whisper transcriber: http(s) sources not yet supported (got ${source})`)
  }
  const localPath = resolveSourceForFfmpeg(source).replace(/^file:\/\//, '')
  const bytes = await fs.readFile(localPath)
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio file ${bytes.byteLength} bytes exceeds Whisper API 25MB cap. ` +
      'Transcode to a lower bitrate first (ffmpeg -b:a 32k -ac 1).',
    )
  }
  return {
    bytes: new Uint8Array(bytes),
    filename: path.basename(localPath),
    mime: guessMime(localPath),
  }
}

/**
 * Build a multipart/form-data body and content-type. We hand-roll instead
 * of relying on the built-in FormData → Request body encoding because
 * Node's global `fetch` (undici) sometimes fails to serialise typed-array
 * file parts without `File` polyfill — and the hand-rolled path is
 * trivially testable.
 */
function buildMultipart(parts: {
  audio: ReadFileResult
  fields: Record<string, string>
}): { body: Uint8Array; boundary: string } {
  const boundary = `----dreambyte-whisper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const chunks: Uint8Array[] = []
  const enc = new TextEncoder()

  for (const [key, value] of Object.entries(parts.fields)) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  }
  chunks.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${parts.audio.filename}"\r\nContent-Type: ${parts.audio.mime}\r\n\r\n`,
    ),
  )
  chunks.push(parts.audio.bytes)
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`))

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const body = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    body.set(c, off)
    off += c.length
  }
  return { body, boundary }
}

export function createWhisperApiTranscriber(opts: WhisperApiTranscriberOptions = {}): CaptionTranscriber {
  const endpoint = opts.endpoint ?? ENDPOINT
  const model = opts.model ?? MODEL
  const doFetch = opts.fetch ?? fetch
  const resolveApiKey = opts.resolveApiKey ?? (() => process.env.OPENAI_API_KEY)

  return {
    async transcribe(source: string, options?: TranscribeOptions): Promise<TranscriptionResult> {
      const key = resolveApiKey()
      if (!key) {
        throw new Error(
          'Whisper transcriber: OPENAI_API_KEY not set. Configure it in Settings → Models.',
        )
      }

      const audio = await readAudioBytes(source)

      const request = async (fields: Record<string, string>) => {
        const { body, boundary } = buildMultipart({ audio, fields })
        return doFetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          // Undici's fetch accepts Uint8Array at runtime, but the type lib
          // doesn't model it — cast through `unknown` to BodyInit.
          body: body as unknown as BodyInit,
        })
      }

      const baseFields: Record<string, string> = { model }
      if (options?.language) baseFields.language = options.language
      if (options?.prompt) baseFields.prompt = options.prompt

      // Word timestamps first (verbose_json + word+segment granularities) —
      // cut_by_transcript uses them for word-precision spans. Local
      // OpenAI-compatible endpoints often don't implement verbose_json or
      // the granularity params, so ANY failure or shape surprise falls back
      // to the original srt request rather than failing the transcription.
      try {
        const res = await request({
          ...baseFields,
          response_format: 'verbose_json',
          'timestamp_granularities[]': 'word',
        })
        if (res.ok) {
          const parsed = (await res.json()) as {
            language?: string
            segments?: Array<{ start?: number; end?: number; text?: string }>
            words?: Array<{ word?: string; start?: number; end?: number }>
          }
          const srt = segmentsToSrt(parsed.segments)
          if (srt) {
            const words = (parsed.words ?? [])
              .filter(
                (w): w is { word: string; start: number; end: number } =>
                  typeof w?.word === 'string' && typeof w.start === 'number' && typeof w.end === 'number',
              )
              .map((w) => ({ word: w.word, start: w.start, end: w.end }))
            return { srt, language: parsed.language ?? options?.language, ...(words.length ? { words } : {}) }
          }
        }
      } catch {
        /* fall through to the srt path */
      }

      const res = await request({ ...baseFields, response_format: 'srt' })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Whisper API returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`)
      }
      const srt = await res.text()
      return { srt, language: options?.language }
    },
  }
}

/** Format seconds as an SRT timestamp (HH:MM:SS,mmm). */
function srtTimestamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rem = ms % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rem, 3)}`
}

/** Synthesize an SRT body from verbose_json segments so every downstream
 *  consumer (parseSRT, captions, cue-level cuts) keeps working unchanged.
 *  Returns null when segments are missing/empty (caller falls back). */
export function segmentsToSrt(segments?: Array<{ start?: number; end?: number; text?: string }>): string | null {
  if (!segments || segments.length === 0) return null
  const blocks: string[] = []
  let index = 1
  for (const seg of segments) {
    if (typeof seg.start !== 'number' || typeof seg.end !== 'number' || typeof seg.text !== 'string') continue
    const text = seg.text.trim()
    if (!text) continue
    blocks.push(`${index}\n${srtTimestamp(seg.start)} --> ${srtTimestamp(seg.end)}\n${text}`)
    index++
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

/** Exported for unit tests. */
export const _whisperInternals = { buildMultipart, guessMime, readAudioBytes }
