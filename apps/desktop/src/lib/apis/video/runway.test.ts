import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runwayProvider } from './runway'

// The reference resolver turns an app/url ref into a fetchable URL (Runway fetches it server-side).
vi.mock('@/lib/media/reference-upload', () => ({
  resolveReferenceToFetchableUrl: vi.fn(async (r: string) => `https://fetchable/${r}`),
}))

const BASE = 'https://api.dev.runwayml.com/v1'

describe('runwayProvider routing', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  beforeEach(() => {
    calls.length = 0
    process.env.RUNWAY_API_KEY = 'k'
    delete process.env.RUNWAY_MODEL
    delete process.env.RUNWAY_ALEPH_MODEL
    delete process.env.RUNWAY_ACT_TWO_MODEL
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : {} })
        return { ok: true, status: 200, json: async () => ({ id: 'task-1' }) } as Response
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  const base = { prompt: 'Restyle this video as neon.', aspectRatio: '16:9' as const, durationSeconds: 5 }

  it('edit (editVideoUrl): posts /video_to_video with model gen4_aleph + videoUri (NOT the default model)', async () => {
    await runwayProvider.generate({ ...base, editVideoUrl: 'https://cdn/src.mp4' })
    expect(calls[0].url).toBe(`${BASE}/video_to_video`)
    expect(calls[0].body.model).toBe('gen4_aleph') // the distinguishing Aleph behavior
    expect(calls[0].body.videoUri).toBe('https://fetchable/https://cdn/src.mp4')
    expect(calls[0].body.promptText).toBe('Restyle this video as neon.')
  })

  it('honors the RUNWAY_ALEPH_MODEL env override for the edit model', async () => {
    process.env.RUNWAY_ALEPH_MODEL = 'gen4_aleph_v2'
    await runwayProvider.generate({ ...base, editVideoUrl: 'https://cdn/src.mp4' })
    expect(calls[0].body.model).toBe('gen4_aleph_v2')
  })

  it('an empty RUNWAY_ALEPH_MODEL falls back to gen4_aleph (no empty-model leak)', async () => {
    process.env.RUNWAY_ALEPH_MODEL = ''
    await runwayProvider.generate({ ...base, editVideoUrl: 'https://cdn/src.mp4' })
    expect(calls[0].body.model).toBe('gen4_aleph')
  })

  it('extend (extendVideoUrl) uses the DEFAULT model, not Aleph — same endpoint, different model', async () => {
    await runwayProvider.generate({ ...base, extendVideoUrl: 'https://cdn/src.mp4' })
    expect(calls[0].url).toBe(`${BASE}/video_to_video`)
    expect(calls[0].body.model).toBe('gen4_turbo') // continue, not transform
  })

  it('within the adapter, edit (Aleph) wins over extend when both clips are passed directly', async () => {
    // startVideo rejects this combination upstream, but the provider must still resolve deterministically.
    await runwayProvider.generate({
      ...base,
      editVideoUrl: 'https://cdn/edit.mp4',
      extendVideoUrl: 'https://cdn/ext.mp4',
    })
    expect(calls[0].body.model).toBe('gen4_aleph')
    expect(calls[0].body.videoUri).toBe('https://fetchable/https://cdn/edit.mp4')
  })

  it('t2v (no clip): posts /text_to_video with the default model', async () => {
    await runwayProvider.generate(base)
    expect(calls[0].url).toBe(`${BASE}/text_to_video`)
    expect(calls[0].body.model).toBe('gen4_turbo')
  })

  it('Act-Two (drivingVideoUrl + imageUrl): posts /character_performance with the documented character+reference shape', async () => {
    await runwayProvider.generate({ ...base, imageUrl: 'app://char.png', drivingVideoUrl: 'https://cdn/drive.mp4' })
    expect(calls[0].url).toBe(`${BASE}/character_performance`)
    expect(calls[0].body.model).toBe('act_two')
    expect(calls[0].body.character).toEqual({ type: 'image', uri: 'https://fetchable/app://char.png' })
    expect(calls[0].body.reference).toEqual({ type: 'video', uri: 'https://fetchable/https://cdn/drive.mp4' })
    expect(calls[0].body.promptText).toBeUndefined() // Act-Two has no text prompt
  })

  it('honors RUNWAY_ACT_TWO_MODEL; an empty value falls back to act_two', async () => {
    process.env.RUNWAY_ACT_TWO_MODEL = 'act_two_v2'
    await runwayProvider.generate({ ...base, imageUrl: 'app://c.png', drivingVideoUrl: 'https://cdn/d.mp4' })
    expect(calls[0].body.model).toBe('act_two_v2')
    process.env.RUNWAY_ACT_TWO_MODEL = ''
    calls.length = 0
    await runwayProvider.generate({ ...base, imageUrl: 'app://c.png', drivingVideoUrl: 'https://cdn/d.mp4' })
    expect(calls[0].body.model).toBe('act_two')
  })

  it('Act-Two wins over edit/extend when several clips are passed directly (route priority)', async () => {
    await runwayProvider.generate({
      ...base,
      imageUrl: 'app://char.png',
      drivingVideoUrl: 'https://cdn/drive.mp4',
      editVideoUrl: 'https://cdn/edit.mp4',
      extendVideoUrl: 'https://cdn/ext.mp4',
    })
    expect(calls[0].url).toBe(`${BASE}/character_performance`)
    expect(calls[0].body.model).toBe('act_two')
  })

  it('Act-Two requires a character image — drivingVideoUrl with no imageUrl fails loud', async () => {
    await expect(runwayProvider.generate({ ...base, drivingVideoUrl: 'https://cdn/drive.mp4' })).rejects.toThrow(
      /requires a character image/,
    )
    expect(calls.length).toBe(0)
  })
})
