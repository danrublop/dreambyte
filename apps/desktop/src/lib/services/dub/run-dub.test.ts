import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runDubJob, setDubRuntime, isDubRuntimeReady, __resetDubRuntimeForTesting } from './run-dub'
import { DubError, type DubVideoDeps } from './dub-video'

const SRT = `1
00:00:00,000 --> 00:00:02,000
Hello`

function makeRuntime(): DubVideoDeps {
  return {
    extractAudio: vi.fn(async () => '/tmp/a.wav'),
    transcribe: vi.fn(async () => ({ srt: SRT, language: 'en' })),
    translateSegments: vi.fn(async (t: string[]) => t.map((x) => `ES:${x}`)),
    synthesize: vi.fn(async () => ({ audioUrl: 'tts.mp3', durationMs: 2000 })),
    assembleAudio: vi.fn(async () => 'dub.mp3'),
    relip: vi.fn(async () => ({ videoUrl: 'dubbed.mp4' })),
  }
}

beforeEach(() => __resetDubRuntimeForTesting())

describe('dub runtime seam', () => {
  it('is not ready until a runtime is registered', () => {
    expect(isDubRuntimeReady()).toBe(false)
  })

  it('runDubJob fails loud with a clear message when no runtime is wired', async () => {
    await expect(
      runDubJob({ projectId: 'p1', sourceVideoUrl: '/uploads/c.mp4', targetLanguage: 'es' }),
    ).rejects.toBeInstanceOf(DubError)
    await expect(
      runDubJob({ projectId: 'p1', sourceVideoUrl: '/uploads/c.mp4', targetLanguage: 'es' }),
    ).rejects.toThrow(/desktop runtime/i)
  })

  it('runs dubVideo through the registered runtime', async () => {
    setDubRuntime(makeRuntime())
    expect(isDubRuntimeReady()).toBe(true)
    const out = await runDubJob({ projectId: 'p1', sourceVideoUrl: '/uploads/c.mp4', targetLanguage: 'es' })
    expect(out.videoUrl).toBe('dubbed.mp4')
    expect(out.segmentCount).toBe(1)
  })
})
