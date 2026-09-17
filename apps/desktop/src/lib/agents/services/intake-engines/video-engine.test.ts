// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { analyzeVideo, analyzeVideoWithPrompt } from './video-engine'
import { parseFramesJson } from './frames-vision'
import { setVideoUnderstander, setMarlinUnderstander } from '../../../services/video-understander'
import { __setProviderClientsForTesting, resetProviderClients } from '../../providers'
import type { ReferenceMedia } from '../../types'

const vid: ReferenceMedia = { id: 'v1', kind: 'video', uri: 'file:///tmp/v.mp4', mimeType: 'video/mp4' }

afterEach(() => {
  setVideoUnderstander(null)
  setMarlinUnderstander(null)
  resetProviderClients()
})

describe('parseFramesJson', () => {
  it('parses scene + events, defaulting bad numbers to 0', () => {
    const out = parseFramesJson(
      '```json\n{"scene":"x","events":[{"start":1,"end":2,"description":"a"},{"description":"b"}]}\n```',
    )
    expect(out.scene).toBe('x')
    expect(out.events).toEqual([
      { start: 1, end: 2, description: 'a' },
      { start: 0, end: 0, description: 'b' },
    ])
  })
  it('returns empty events on garbage', () => {
    expect(parseFramesJson('nope')).toEqual({ events: [] })
  })
})

describe('analyzeVideo routing', () => {
  it('local engine routes through the VideoUnderstander seam', async () => {
    setVideoUnderstander({
      understand: async (source, opts) => {
        expect(source).toBe(vid.uri)
        expect(opts?.visionEngineId).toBe('local:qwen2.5vl:7b')
        return {
          scene: 'a clip',
          events: [{ start: 0, end: 1, description: 'intro' }],
          transcript: 'hi',
          backend: 'frame-vision:local:qwen2.5vl:7b',
        }
      },
    })
    const out = await analyzeVideo(vid, 'local:qwen2.5vl:7b')
    expect(out.caption).toBe('a clip')
    expect(out.transcript).toBe('hi')
    expect(out.events).toHaveLength(1)
    expect(out.backend).toBe('frame-vision:local:qwen2.5vl:7b')
  })

  it('cheap OpenAI-compat providers (cloud:qwen) route through frame-vision, not "unknown engine"', async () => {
    let seenEngine = ''
    setVideoUnderstander({
      understand: async (_s, opts) => {
        seenEngine = opts?.visionEngineId ?? ''
        return { scene: 'qwen frames', events: [], backend: 'frame-vision:cloud:qwen' }
      },
    })
    const out = await analyzeVideo(vid, 'cloud:qwen')
    expect(out.error).toBeUndefined()
    expect(seenEngine).toBe('cloud:qwen')
    expect(out.backend).toBe('frame-vision:cloud:qwen')
  })

  it('cloud:anthropic also routes through the seam', async () => {
    let called = false
    setVideoUnderstander({
      understand: async () => {
        called = true
        return { scene: 's', events: [], backend: 'frame-vision:cloud:anthropic' }
      },
    })
    await analyzeVideo(vid, 'cloud:anthropic')
    expect(called).toBe(true)
  })

  it('premium:marlin routes through the Marlin seam', async () => {
    setMarlinUnderstander({
      understand: async () => ({
        scene: 'dense marlin caption',
        events: [{ start: 2.1, end: 5.0, description: 'temporal event' }],
        backend: 'marlin',
      }),
    })
    const out = await analyzeVideo(vid, 'premium:marlin')
    expect(out.caption).toBe('dense marlin caption')
    expect(out.backend).toBe('marlin')
    expect(out.events).toHaveLength(1)
  })

  it('premium:marlin degrades to an error when no GPU/sidecar (stub throws)', async () => {
    // No setMarlinUnderstander → the seam stub throws.
    const out = await analyzeVideo(vid, 'premium:marlin')
    expect(out.error).toMatch(/Marlin video understander not available/)
  })

  it('unknown engine returns an error analysis, never throws', async () => {
    const out = await analyzeVideo(vid, 'bogus:engine')
    expect(out.error).toMatch(/unknown video engine/)
  })

  it('seam failure degrades to an error analysis', async () => {
    setVideoUnderstander({
      understand: async () => {
        throw new Error('ffmpeg missing')
      },
    })
    const out = await analyzeVideo(vid, 'local:qwen2.5vl:7b')
    expect(out.error).toMatch(/ffmpeg missing/)
  })
})

describe('analyzeVideoWithPrompt (bytes-accepting native-video seam)', () => {
  it('sends in-memory clip bytes inline + returns the model raw text', async () => {
    let seenParts: unknown
    let seenModel = ''
    __setProviderClientsForTesting({
      google: {
        files: {},
        models: {
          generateContent: async (req: { model: string; contents: unknown }) => {
            seenParts = req.contents
            seenModel = req.model
            return { text: '{"reviewable":true,"findings":[]}' }
          },
        },
      },
    })
    const bytes = new Uint8Array([1, 2, 3, 4])
    const raw = await analyzeVideoWithPrompt({ bytes, mimeType: 'video/mp4' }, 'cloud:gemini', 'judge this clip')
    expect(raw).toBe('{"reviewable":true,"findings":[]}')
    expect(seenModel).toBe('gemini-2.5-flash')
    // inline base64 part + the custom prompt
    const parts = seenParts as [{ inlineData?: { mimeType: string; data: string } }, { text: string }]
    expect(parts[0].inlineData?.mimeType).toBe('video/mp4')
    expect(parts[0].inlineData?.data).toBe(Buffer.from(bytes).toString('base64'))
    expect(parts[1].text).toBe('judge this clip')
  })

  it('honors a custom model override', async () => {
    let seenModel = ''
    __setProviderClientsForTesting({
      google: {
        files: {},
        models: {
          generateContent: async (req: { model: string }) => {
            seenModel = req.model
            return { text: 'ok' }
          },
        },
      },
    })
    await analyzeVideoWithPrompt({ bytes: new Uint8Array([9]), mimeType: 'video/mp4' }, 'cloud:gemini', 'p', {
      model: 'gemini-2.5-pro',
    })
    expect(seenModel).toBe('gemini-2.5-pro')
  })

  it('throws for a non-Gemini engine (caller degrades explicitly)', async () => {
    await expect(
      analyzeVideoWithPrompt({ bytes: new Uint8Array([1]), mimeType: 'video/mp4' }, 'cloud:anthropic', 'p'),
    ).rejects.toThrow(/unsupported native-video engine/)
  })

  it('throws when in-memory bytes exceed the inline cap (no path to upload)', async () => {
    __setProviderClientsForTesting({ google: { files: {}, models: { generateContent: async () => ({ text: '' }) } } })
    const big = new Uint8Array(19 * 1024 * 1024) // > 18MB inline cap
    await expect(analyzeVideoWithPrompt({ bytes: big, mimeType: 'video/mp4' }, 'cloud:gemini', 'p')).rejects.toThrow(
      /exceeds Gemini inline cap/,
    )
  })
})
