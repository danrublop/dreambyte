// @vitest-environment node

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Mock electron so `./audio-decode` → `./paths` can load in node.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/dreambyte-test-userdata',
    isPackaged: false,
  },
}))

import { createWhisperApiTranscriber, _whisperInternals } from './whisper-transcriber'

let tmpDir: string
let audioPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-whisper-'))
  audioPath = path.join(tmpDir, 'sample.mp3')
  await fs.writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x44]))
})
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('createWhisperApiTranscriber', () => {
  it('throws when OPENAI_API_KEY is not set', async () => {
    const t = createWhisperApiTranscriber({ resolveApiKey: () => undefined })
    await expect(t.transcribe(audioPath)).rejects.toThrow(/OPENAI_API_KEY not set/)
  })

  it('posts multipart with model + response_format=srt and returns the SRT text', async () => {
    let capturedUrl: string | URL = ''
    let capturedHeaders: HeadersInit | undefined
    let capturedBody: BodyInit | null | undefined
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = url as string
      capturedHeaders = init?.headers
      capturedBody = init?.body as BodyInit | null
      return new Response('1\n00:00:01,000 --> 00:00:02,000\nHello\n', { status: 200 }) as unknown as Response
    }
    const t = createWhisperApiTranscriber({ resolveApiKey: () => 'sk-test', fetch: fakeFetch })
    const result = await t.transcribe(audioPath)
    expect(result.srt).toMatch(/Hello/)
    expect(capturedUrl).toBe('https://api.openai.com/v1/audio/transcriptions')
    const headerObj = capturedHeaders as Record<string, string>
    expect(headerObj.Authorization).toBe('Bearer sk-test')
    expect(headerObj['Content-Type']).toMatch(/multipart\/form-data; boundary=/)
    const bodyText = new TextDecoder().decode(capturedBody as Uint8Array)
    expect(bodyText).toContain('name="model"')
    expect(bodyText).toContain('whisper-1')
    expect(bodyText).toContain('name="response_format"')
    expect(bodyText).toContain('srt')
    expect(bodyText).toContain('name="file"; filename="sample.mp3"')
  })

  it('passes language + prompt fields when provided', async () => {
    let bodyText = ''
    const fakeFetch: typeof fetch = async (_url, init) => {
      bodyText = new TextDecoder().decode(init?.body as Uint8Array)
      return new Response('1\n00:00:01,000 --> 00:00:02,000\nX\n', { status: 200 }) as unknown as Response
    }
    const t = createWhisperApiTranscriber({ resolveApiKey: () => 'sk-test', fetch: fakeFetch })
    await t.transcribe(audioPath, { language: 'es', prompt: 'technical' })
    expect(bodyText).toContain('name="language"')
    expect(bodyText).toContain('es')
    expect(bodyText).toContain('name="prompt"')
    expect(bodyText).toContain('technical')
  })

  it('surfaces non-2xx responses as errors', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }) as unknown as Response
    const t = createWhisperApiTranscriber({ resolveApiKey: () => 'sk-test', fetch: fakeFetch })
    await expect(t.transcribe(audioPath)).rejects.toThrow(/429.*Too Many Requests.*rate limited/)
  })

  it('rejects files larger than the 25MB Whisper cap', async () => {
    const big = path.join(tmpDir, 'big.mp3')
    await fs.writeFile(big, Buffer.alloc(26 * 1024 * 1024))
    const t = createWhisperApiTranscriber({ resolveApiKey: () => 'sk-test' })
    await expect(t.transcribe(big)).rejects.toThrow(/Whisper API 25MB cap/)
  })

  it('rejects http(s) sources (today only local paths are supported)', async () => {
    const t = createWhisperApiTranscriber({ resolveApiKey: () => 'sk-test' })
    await expect(t.transcribe('https://example.com/x.mp3')).rejects.toThrow(/http\(s\) sources not yet supported/)
  })

  it('honors a custom endpoint + model (local OpenAI-compatible server)', async () => {
    let capturedUrl: string | URL = ''
    let bodyText = ''
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = url as string
      bodyText = new TextDecoder().decode(init?.body as Uint8Array)
      return new Response('1\n00:00:01,000 --> 00:00:02,000\nLocal\n', { status: 200 }) as unknown as Response
    }
    const t = createWhisperApiTranscriber({
      endpoint: 'http://localhost:8000/v1/audio/transcriptions',
      model: 'whisper-large-v3',
      resolveApiKey: () => 'sk-local',
      fetch: fakeFetch,
    })
    const result = await t.transcribe(audioPath)
    expect(result.srt).toMatch(/Local/)
    expect(capturedUrl).toBe('http://localhost:8000/v1/audio/transcriptions')
    // Model override flows into the multipart body.
    expect(bodyText).toContain('whisper-large-v3')
  })
})

describe('whisper internals', () => {
  it('guessMime returns expected types', () => {
    expect(_whisperInternals.guessMime('a.mp3')).toBe('audio/mpeg')
    expect(_whisperInternals.guessMime('a.wav')).toBe('audio/wav')
    expect(_whisperInternals.guessMime('a.m4a')).toBe('audio/mp4')
    expect(_whisperInternals.guessMime('a.unknown')).toBe('application/octet-stream')
  })

  it('buildMultipart joins fields and audio with the boundary', () => {
    const { body, boundary } = _whisperInternals.buildMultipart({
      audio: { bytes: new Uint8Array([1, 2, 3]), filename: 'a.mp3', mime: 'audio/mpeg' },
      fields: { model: 'whisper-1', response_format: 'srt' },
    })
    const text = new TextDecoder().decode(body)
    expect(boundary).toMatch(/^----dreambyte-whisper-/)
    expect(text).toContain('Content-Disposition: form-data; name="model"')
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="a.mp3"')
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true)
  })
})
