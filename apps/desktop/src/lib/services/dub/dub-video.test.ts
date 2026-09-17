import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dubVideo, DubError, type DubVideoDeps } from './dub-video'

const SRT = `1
00:00:00,000 --> 00:00:02,000
Hello

2
00:00:02,000 --> 00:00:05,000
how are you`

function makeDeps(over: Partial<DubVideoDeps> = {}): DubVideoDeps {
  return {
    extractAudio: vi.fn(async () => '/tmp/audio.wav'),
    transcribe: vi.fn(async () => ({ srt: SRT, language: 'en' })),
    translateSegments: vi.fn(async (texts: string[]) => texts.map((t) => `ES:${t}`)),
    synthesize: vi.fn(async () => ({ audioUrl: 'https://tts/clip.mp3', durationMs: 2000 })),
    assembleAudio: vi.fn(async () => 'https://audio/dubbed.mp3'),
    relip: vi.fn(async () => ({ videoUrl: 'https://video/dubbed.mp4' })),
    ...over,
  }
}

const base = { projectId: 'p1', sourceVideoUrl: '/uploads/clip.mp4', targetLanguage: 'es' }

describe('dubVideo orchestration', () => {
  it('runs the full chain in order and returns the dubbed video', async () => {
    const deps = makeDeps()
    const out = await dubVideo(base, deps)
    expect(deps.extractAudio).toHaveBeenCalledWith('/uploads/clip.mp4')
    expect(deps.transcribe).toHaveBeenCalled()
    expect(deps.translateSegments).toHaveBeenCalledWith(['Hello', 'how are you'], 'es', 'en')
    expect(deps.synthesize).toHaveBeenCalledTimes(2)
    expect(deps.relip).toHaveBeenCalledWith('/uploads/clip.mp4', 'https://audio/dubbed.mp3')
    expect(out.videoUrl).toBe('https://video/dubbed.mp4')
    expect(out.segmentCount).toBe(2)
    expect(out.detectedLanguage).toBe('en')
  })

  it('passes a cloned voiceId through to TTS (dub in the speaker’s voice)', async () => {
    const deps = makeDeps()
    await dubVideo({ ...base, voiceId: 'el_clone' }, deps)
    expect(deps.synthesize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ voiceId: 'el_clone', language: 'es' }))
  })

  it('throws when the source video has no speech', async () => {
    const deps = makeDeps({ transcribe: vi.fn(async () => ({ srt: '', language: 'en' })) })
    await expect(dubVideo(base, deps)).rejects.toBeInstanceOf(DubError)
    expect(deps.synthesize).not.toHaveBeenCalled() // never spent on TTS
  })

  it('refuses to dub if translation returns a mismatched line count (timing would desync)', async () => {
    const deps = makeDeps({ translateSegments: vi.fn(async () => ['only one line']) })
    await expect(dubVideo(base, deps)).rejects.toThrow(/misaligned/)
    expect(deps.relip).not.toHaveBeenCalled()
  })

  it('holds silence (no TTS) for an empty translated cue', async () => {
    const deps = makeDeps({ translateSegments: vi.fn(async () => ['ES:Hello', '']) })
    await dubVideo(base, deps)
    expect(deps.synthesize).toHaveBeenCalledTimes(1) // only the non-empty cue
  })

  it('reports sync drift when a translated cue is too long to fit even sped-up', async () => {
    // cue windows are 2000ms; a 6000ms synth on a 2000ms window overflows past MAX_ATEMPO.
    const deps = makeDeps({ synthesize: vi.fn(async () => ({ audioUrl: 'x', durationMs: 6000 })) })
    const out = await dubVideo(base, deps)
    expect(out.driftMs).toBeGreaterThan(0)
  })

  it('validates required inputs', async () => {
    await expect(dubVideo({ ...base, targetLanguage: '' }, makeDeps())).rejects.toBeInstanceOf(DubError)
    await expect(dubVideo({ ...base, sourceVideoUrl: '' }, makeDeps())).rejects.toBeInstanceOf(DubError)
  })
})
