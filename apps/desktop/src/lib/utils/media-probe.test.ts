// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { classifyMediaFile, probeMediaDuration } from './media-probe'

// ── classifyMediaFile ─────────────────────────────────────────────────────────
//
// Pure function: maps the File.type MIME prefix to one of four track kinds.
// Used by both the gallery drop handler and the timeline drop handler to
// decide whether to route a dropped file to a video track, audio track,
// image asset, or refuse entirely.

describe('classifyMediaFile', () => {
  function file(type: string): File {
    return new File([new Uint8Array(0)], 'test', { type })
  }

  it('classifies video MIMEs as "video"', () => {
    expect(classifyMediaFile(file('video/mp4'))).toBe('video')
    expect(classifyMediaFile(file('video/quicktime'))).toBe('video')
    expect(classifyMediaFile(file('video/webm'))).toBe('video')
  })

  it('classifies audio MIMEs as "audio"', () => {
    expect(classifyMediaFile(file('audio/mpeg'))).toBe('audio')
    expect(classifyMediaFile(file('audio/wav'))).toBe('audio')
    expect(classifyMediaFile(file('audio/x-m4a'))).toBe('audio')
  })

  it('classifies image MIMEs as "image"', () => {
    expect(classifyMediaFile(file('image/png'))).toBe('image')
    expect(classifyMediaFile(file('image/jpeg'))).toBe('image')
    expect(classifyMediaFile(file('image/webp'))).toBe('image')
  })

  it('returns null for unsupported MIMEs', () => {
    expect(classifyMediaFile(file('application/pdf'))).toBeNull()
    expect(classifyMediaFile(file('text/plain'))).toBeNull()
    expect(classifyMediaFile(file('application/octet-stream'))).toBeNull()
  })

  it('returns null for empty MIME (browser unable to classify)', () => {
    expect(classifyMediaFile(file(''))).toBeNull()
  })

  it('only matches on prefix — "video"-substring without slash does NOT match', () => {
    // The check is `t.startsWith('video/')`, not `t.includes('video')`.
    // A file with type "video-info/binary" should NOT classify as video.
    expect(classifyMediaFile(file('video-info'))).toBeNull()
    expect(classifyMediaFile(file('audio'))).toBeNull()
  })
})

// ── probeMediaDuration ────────────────────────────────────────────────────────
//
// DOM-based metadata probe: creates a hidden <video>/<audio> element, listens
// for `loadedmetadata`, and resolves with the duration. Hard 3s timeout to
// keep a slow/broken asset from hanging the import pipeline. Cleans up the
// element src on settle so the resource is released.
//
// jsdom doesn't actually decode media, so we simulate the events the real
// browser would fire. The contract tests below verify the state machine,
// not the underlying media decoding.

describe('probeMediaDuration', () => {
  type SettleFn = (kind: 'meta' | 'error' | 'never', opts?: { duration?: number; w?: number; h?: number }) => void
  let originalCreateElement: typeof document.createElement
  let createdElements: Array<HTMLMediaElement & { _settle?: SettleFn }>

  beforeEach(() => {
    vi.useFakeTimers()
    createdElements = []
    originalCreateElement = document.createElement.bind(document)
    // Intercept video/audio element creation so we can drive loadedmetadata /
    // error events manually. Other element types fall through to the real
    // jsdom impl.
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = originalCreateElement(tag) as HTMLMediaElement
      if (tag === 'video' || tag === 'audio') {
        // Provide a way to trigger the handler from the test side. The handler
        // is set later via `el.onloadedmetadata = ...` in probeMediaDuration.
        const proxied = el as HTMLMediaElement & { _settle?: SettleFn }
        proxied._settle = (kind, opts = {}) => {
          if (kind === 'meta') {
            // jsdom's HTMLMediaElement properties are read-only-ish in some
            // setups; assign via Object.defineProperty for portability.
            Object.defineProperty(proxied, 'duration', { configurable: true, get: () => opts.duration ?? 0 })
            if (tag === 'video') {
              Object.defineProperty(proxied, 'videoWidth', { configurable: true, get: () => opts.w ?? 0 })
              Object.defineProperty(proxied, 'videoHeight', { configurable: true, get: () => opts.h ?? 0 })
            }
            proxied.onloadedmetadata?.(new Event('loadedmetadata'))
          } else if (kind === 'error') {
            proxied.onerror?.(new Event('error'))
          }
          // 'never' — do nothing; let the timeout fire.
        }
        createdElements.push(proxied)
      }
      return el
    }) as typeof document.createElement)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resolves with duration on loadedmetadata for video', async () => {
    const promise = probeMediaDuration('dreambyte://uploads/x.mp4', 'video')
    // Defer one tick so probeMediaDuration's setSrc + handler assignment runs.
    await Promise.resolve()
    createdElements[0]._settle?.('meta', { duration: 12.5, w: 1920, h: 1080 })
    const result = await promise
    expect(result.duration).toBe(12.5)
    expect(result.width).toBe(1920)
    expect(result.height).toBe(1080)
  })

  it('resolves without width/height for audio', async () => {
    const promise = probeMediaDuration('dreambyte://uploads/x.mp3', 'audio')
    await Promise.resolve()
    createdElements[0]._settle?.('meta', { duration: 30 })
    const result = await promise
    expect(result.duration).toBe(30)
    expect(result.width).toBeUndefined()
    expect(result.height).toBeUndefined()
  })

  it('rejects on element error', async () => {
    const promise = probeMediaDuration('dreambyte://uploads/broken.mp4', 'video')
    await Promise.resolve()
    createdElements[0]._settle?.('error')
    await expect(promise).rejects.toThrow(/load error/)
  })

  it('rejects on zero or non-finite duration (treats as no-duration)', async () => {
    const promise = probeMediaDuration('dreambyte://uploads/zero.mp4', 'video')
    await Promise.resolve()
    createdElements[0]._settle?.('meta', { duration: 0 })
    await expect(promise).rejects.toThrow(/no duration/)
  })

  it('rejects on Infinity duration (streaming/unbounded)', async () => {
    const promise = probeMediaDuration('dreambyte://uploads/stream.mp4', 'video')
    await Promise.resolve()
    createdElements[0]._settle?.('meta', { duration: Infinity })
    await expect(promise).rejects.toThrow(/no duration/)
  })

  it('rejects after PROBE_TIMEOUT_MS when no event fires', async () => {
    // Attach the rejection handler IMMEDIATELY (before advancing timers) so
    // vitest's fake-timer scheduler doesn't see a transient unhandled
    // rejection between the timeout firing and `await expect().rejects`
    // attaching its handler.
    const promise = probeMediaDuration('dreambyte://uploads/hang.mp4', 'video')
    let captured: Error | null = null
    promise.catch((e: Error) => {
      captured = e
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(3001)
    // Flush the microtask that resolves the promise + invokes the .catch.
    await Promise.resolve()
    expect(captured).toBeInstanceOf(Error)
    expect((captured as unknown as Error).message).toMatch(/probe timeout/)
  })

  it('uses <audio> element for audio kind, <video> for video', async () => {
    const audioPromise = probeMediaDuration('dreambyte://uploads/a.mp3', 'audio')
    expect(createdElements[0]).toBeInstanceOf(HTMLAudioElement)
    await Promise.resolve()
    createdElements[0]._settle?.('meta', { duration: 5 })
    await audioPromise

    const videoPromise = probeMediaDuration('dreambyte://uploads/v.mp4', 'video')
    expect(createdElements[1]).toBeInstanceOf(HTMLVideoElement)
    await Promise.resolve()
    createdElements[1]._settle?.('meta', { duration: 5, w: 100, h: 100 })
    await videoPromise
  })
})
