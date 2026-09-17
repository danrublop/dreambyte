// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Store + IPC mocks ────────────────────────────────────────────────────────
//
// timeline-import.ts is the renderer-side orchestrator that uploads a dropped
// file via Electron IPC, lands the resulting asset in the gallery, and adds a
// clip on the nearest eligible timeline track. It has three external
// dependencies we need to mock: the Zustand store, the `dreambyteApi.projects.uploadAsset`
// IPC bridge, and the gallery's `addProjectAsset` slot.

interface MockTrack {
  id: string
  type: 'video' | 'audio' | string
  locked: boolean
  position: number
  clips: Array<{ id: string; startTime: number; duration: number }>
}

interface MockStoreState {
  project: { id: string | null; timeline: { tracks: MockTrack[] } | null }
  initTimeline: ReturnType<typeof vi.fn>
  addTrack: ReturnType<typeof vi.fn>
  addClip: ReturnType<typeof vi.fn>
  addProjectAsset: ReturnType<typeof vi.fn>
  showTransientStatus: ReturnType<typeof vi.fn>
}

let mockState: MockStoreState

function freshState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    project: { id: 'proj-1', timeline: { tracks: [] } },
    initTimeline: vi.fn(),
    addTrack: vi.fn((_kind: string) => `track-${_kind}-1`),
    addClip: vi.fn(() => 'clip-1'),
    addProjectAsset: vi.fn(),
    showTransientStatus: vi.fn(),
    ...overrides,
  }
}

vi.mock('@/lib/store', () => ({
  useVideoStore: {
    getState: () => mockState,
  },
}))

// Defer the import until AFTER the mock is registered.
const { importFilesToTimeline, importFileToTimeline } = await import('./timeline-import')

// ── Helpers ───────────────────────────────────────────────────────────────────

function file(name: string, type: string, size = 1024): File {
  // Use a Blob with the requested size so File.size reflects it.
  const blob = new Blob([new Uint8Array(size)], { type })
  return new File([blob], name, { type })
}

interface UploadArgs {
  projectId: string
  data: ArrayBuffer
  mimeType: string
  originalName: string
  tags?: string[]
}
type UploadResult = { asset: { publicUrl: string; name: string; durationSeconds?: number } }
type UploadHandler = (args: UploadArgs) => Promise<UploadResult>

function setupDreambyteApi(uploadAsset: UploadHandler) {
  ;(window as unknown as { dreambyteApi?: unknown }).dreambyteApi = {
    projects: { uploadAsset },
  }
}

function clearDreambyteApi() {
  delete (window as unknown as { dreambyteApi?: unknown }).dreambyteApi
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('importFilesToTimeline — input shape & limits', () => {
  beforeEach(() => {
    mockState = freshState()
    setupDreambyteApi(async () => ({
      asset: { publicUrl: 'dreambyte://uploads/x.mp4', name: 'x.mp4', durationSeconds: 10 },
    }))
  })

  afterEach(() => {
    clearDreambyteApi()
    vi.clearAllMocks()
  })

  it('returns empty array for empty input', async () => {
    const results = await importFilesToTimeline([])
    expect(results).toEqual([])
  })

  it('caps batch size at MAX_FILES_PER_DROP (20) and surfaces a single error', async () => {
    const errors: string[] = []
    const onError = (msg: string) => errors.push(msg)
    const big = Array.from({ length: 25 }, (_, i) => file(`f${i}.mp4`, 'video/mp4'))

    const results = await importFilesToTimeline(big, onError)

    // 20 importable; 5 over the cap.
    expect(results.length).toBe(20)
    expect(errors.find((e) => /Too many files: 25/.test(e))).toBeDefined()
    expect(errors.find((e) => /first 20/.test(e))).toBeDefined()
  })

  it('classifies unsupported MIMEs as errors without IPC calls', async () => {
    const uploadAsset = vi.fn(async () => ({ asset: { publicUrl: '', name: '' } }))
    setupDreambyteApi(uploadAsset)
    const errors: string[] = []
    const onError = (msg: string) => errors.push(msg)

    const results = await importFilesToTimeline([file('doc.pdf', 'application/pdf')], onError)

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/Unsupported file: doc\.pdf/)
    expect(uploadAsset).not.toHaveBeenCalled()
  })

  it('image files upload and land on the video track with sourceType="image"', async () => {
    setupDreambyteApi(async () => ({
      asset: { publicUrl: 'dreambyte://uploads/photo.jpg', name: 'photo.jpg' },
    }))
    const errors: string[] = []
    const results = await importFilesToTimeline([file('photo.jpg', 'image/jpeg')], (m) => errors.push(m))

    expect(results[0].ok).toBe(true)
    expect(errors).toEqual([])
    // Image clips ride on the VIDEO track (visual track) but their clip
    // sourceType stays 'image' so Pixi routes them through renderImageClip.
    expect(mockState.addTrack).toHaveBeenCalledWith('video')
    const [trackId, clip] = mockState.addClip.mock.calls[0]
    expect(trackId).toBe('track-video-1')
    expect(clip.sourceType).toBe('image')
    expect(clip.sourceId).toBe('dreambyte://uploads/photo.jpg')
  })

  it('image clips default to 5s duration (DEFAULT_IMAGE_DURATION)', async () => {
    setupDreambyteApi(async () => ({
      // Image asset; upload-asset does not report durationSeconds for images.
      asset: { publicUrl: 'dreambyte://uploads/p.png', name: 'p.png' },
    }))
    await importFilesToTimeline([file('p.png', 'image/png')])
    const [, clip] = mockState.addClip.mock.calls[0]
    expect(clip.duration).toBe(5)
  })
})

describe('importFilesToTimeline — size limits enforced renderer-side', () => {
  beforeEach(() => {
    mockState = freshState()
  })
  afterEach(() => clearDreambyteApi())

  /** Size-only stub — preflight reads name/type/size and must reject before
   *  ever touching the bytes, so no real allocation is needed. */
  const sizedFile = (name: string, type: string, size: number): File =>
    ({ name, type, size, arrayBuffer: () => Promise.reject(new Error('bytes must not be read')) }) as unknown as File

  it('rejects oversized videos before any IPC call (renderer-side size cap)', async () => {
    const uploadAsset = vi.fn(async () => ({ asset: { publicUrl: 'x', name: 'x' } }))
    setupDreambyteApi(uploadAsset)
    const big = sizedFile('big.mp4', 'video/mp4', 3 * 1024 * 1024 * 1024) // 3GB, cap is 2GB

    const results = await importFilesToTimeline([big])

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/File too large.*Max 2048MB/)
    expect(uploadAsset).not.toHaveBeenCalled()
  })

  it('rejects oversized audio before any IPC call', async () => {
    const uploadAsset = vi.fn(async () => ({ asset: { publicUrl: 'x', name: 'x' } }))
    setupDreambyteApi(uploadAsset)
    const big = sizedFile('big.mp3', 'audio/mpeg', 400 * 1024 * 1024) // 400MB, cap is 300

    const results = await importFilesToTimeline([big])

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/File too large.*Max 300MB/)
    expect(uploadAsset).not.toHaveBeenCalled()
  })

  it('rejects oversized images at the 50MB image cap before any IPC call', async () => {
    const uploadAsset = vi.fn(async () => ({ asset: { publicUrl: 'x', name: 'x' } }))
    setupDreambyteApi(uploadAsset)
    const big = sizedFile('big.jpg', 'image/jpeg', 60 * 1024 * 1024) // 60MB, image cap is 50

    const results = await importFilesToTimeline([big])

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/File too large.*Max 50MB/)
    expect(uploadAsset).not.toHaveBeenCalled()
  })
})

describe('importFilesToTimeline — runtime preconditions', () => {
  beforeEach(() => {
    mockState = freshState()
  })
  afterEach(() => clearDreambyteApi())

  it('refuses to import without the Electron IPC bridge', async () => {
    clearDreambyteApi()

    const results = await importFilesToTimeline([file('v.mp4', 'video/mp4')])

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/requires the desktop runtime/)
  })

  it('refuses to import when no project is loaded', async () => {
    mockState = freshState({ project: { id: null, timeline: null } })
    setupDreambyteApi(async () => ({ asset: { publicUrl: 'x', name: 'x' } }))

    const results = await importFilesToTimeline([file('v.mp4', 'video/mp4')])

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/No project loaded/)
  })

  it('refuses to place a clip when project changes mid-upload', async () => {
    // We need to switch the project AFTER the IPC starts but BEFORE it resolves.
    // Two signals: `uploadStarted` fires when the IPC callback begins,
    // `uploadFinished` resolves the upload with a result.
    let uploadStarted!: () => void
    const uploadStartedPromise = new Promise<void>((r) => {
      uploadStarted = r
    })
    let uploadFinished: (asset: unknown) => void = () => {}
    setupDreambyteApi(
      () =>
        new Promise((resolve) => {
          uploadFinished = (asset) => resolve({ asset } as { asset: { publicUrl: string; name: string } })
          uploadStarted()
        }),
    )

    const promise = importFilesToTimeline([file('v.mp4', 'video/mp4')])
    // Wait until the upload IPC actually begins, then switch projects.
    await uploadStartedPromise
    mockState.project = { id: 'proj-2', timeline: { tracks: [] } }
    uploadFinished({ publicUrl: 'dreambyte://uploads/v.mp4', name: 'v.mp4' })

    const results = await promise
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/project changed during upload/)
  })
})

describe('importFilesToTimeline — happy path', () => {
  beforeEach(() => {
    mockState = freshState()
    setupDreambyteApi(async () => ({
      asset: { publicUrl: 'dreambyte://uploads/v.mp4', name: 'v.mp4', durationSeconds: 12.5 },
    }))
  })

  afterEach(() => {
    clearDreambyteApi()
    vi.clearAllMocks()
  })

  it('uploads, adds to gallery, then places a clip on the video track', async () => {
    const results = await importFilesToTimeline([file('v.mp4', 'video/mp4')])

    expect(results[0].ok).toBe(true)
    expect(results[0].clipId).toBe('clip-1')
    expect(mockState.addProjectAsset).toHaveBeenCalledTimes(1)
    expect(mockState.addTrack).toHaveBeenCalledWith('video')
    expect(mockState.addClip).toHaveBeenCalledTimes(1)
    const [trackId, clip] = mockState.addClip.mock.calls[0]
    expect(trackId).toBe('track-video-1')
    expect(clip.sourceType).toBe('video')
    expect(clip.sourceId).toBe('dreambyte://uploads/v.mp4')
    expect(clip.duration).toBe(12.5) // honors asset.durationSeconds
    expect(clip.startTime).toBe(0)
  })

  it('falls back to 5s duration when asset has no durationSeconds', async () => {
    setupDreambyteApi(async () => ({
      asset: { publicUrl: 'dreambyte://uploads/v.mp4', name: 'v.mp4' },
    }))

    await importFilesToTimeline([file('v.mp4', 'video/mp4')])

    const [, clip] = mockState.addClip.mock.calls[0]
    expect(clip.duration).toBe(5)
  })

  it('routes audio files to an audio track (auto-created)', async () => {
    setupDreambyteApi(async () => ({
      asset: { publicUrl: 'dreambyte://uploads/a.mp3', name: 'a.mp3', durationSeconds: 30 },
    }))

    await importFilesToTimeline([file('a.mp3', 'audio/mpeg')])

    expect(mockState.addTrack).toHaveBeenCalledWith('audio')
    const [trackId, clip] = mockState.addClip.mock.calls[0]
    expect(trackId).toBe('track-audio-1')
    expect(clip.sourceType).toBe('audio')
  })

  it('reuses existing eligible track instead of creating a new one', async () => {
    mockState.project.timeline = {
      tracks: [{ id: 'existing-video-track', type: 'video', locked: false, position: 0, clips: [] }],
    }

    await importFilesToTimeline([file('v.mp4', 'video/mp4')])

    expect(mockState.addTrack).not.toHaveBeenCalled()
    const [trackId] = mockState.addClip.mock.calls[0]
    expect(trackId).toBe('existing-video-track')
  })

  it('skips locked tracks and falls through to a new track', async () => {
    mockState.project.timeline = {
      tracks: [{ id: 'locked-track', type: 'video', locked: true, position: 0, clips: [] }],
    }

    await importFilesToTimeline([file('v.mp4', 'video/mp4')])

    expect(mockState.addTrack).toHaveBeenCalledWith('video')
  })

  it('places clips sequentially at end-of-track', async () => {
    mockState.project.timeline = {
      tracks: [
        {
          id: 'video-1',
          type: 'video',
          locked: false,
          position: 0,
          clips: [{ id: 'old', startTime: 0, duration: 8 }],
        },
      ],
    }

    await importFilesToTimeline([file('v.mp4', 'video/mp4')])

    const [, clip] = mockState.addClip.mock.calls[0]
    expect(clip.startTime).toBe(8) // appended after the existing 8s clip
  })
})

describe('importFilesToTimeline — batch behavior', () => {
  beforeEach(() => {
    mockState = freshState()
  })
  afterEach(() => {
    clearDreambyteApi()
    vi.clearAllMocks()
  })

  it('processes mixed batch: video + audio + image — all 3 land on the timeline', async () => {
    setupDreambyteApi(async ({ originalName }: { originalName: string }) => ({
      // Video/audio have ffprobe duration; image doesn't.
      asset: {
        publicUrl: `dreambyte://uploads/${originalName}`,
        name: originalName,
        ...(originalName.endsWith('.jpg') ? {} : { durationSeconds: 4 }),
      },
    }))
    const errors: string[] = []

    const results = await importFilesToTimeline(
      [file('v.mp4', 'video/mp4'), file('a.mp3', 'audio/mpeg'), file('img.jpg', 'image/jpeg')],
      (m) => errors.push(m),
    )

    expect(results.length).toBe(3)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(errors).toEqual([])
    // Verify sourceType is set per kind for each placement
    const sourceTypes = mockState.addClip.mock.calls.map(([, clip]) => clip.sourceType)
    expect(sourceTypes).toEqual(['video', 'audio', 'image'])
  })

  it('shows progress status when total > 1', async () => {
    setupDreambyteApi(async ({ originalName }: { originalName: string }) => ({
      asset: { publicUrl: `dreambyte://uploads/${originalName}`, name: originalName, durationSeconds: 4 },
    }))

    await importFilesToTimeline([file('v1.mp4', 'video/mp4'), file('v2.mp4', 'video/mp4')])

    // Per-upload progress messages + final summary
    const calls = mockState.showTransientStatus.mock.calls
    expect(calls.some(([msg]) => /Importing \d+ of 2/.test(String(msg)))).toBe(true)
    expect(calls.some(([msg]) => /Imported \d+ of 2/.test(String(msg)))).toBe(true)
  })

  it('does NOT show progress status for single-file imports', async () => {
    setupDreambyteApi(async () => ({
      asset: { publicUrl: 'x', name: 'x.mp4', durationSeconds: 4 },
    }))

    await importFilesToTimeline([file('v.mp4', 'video/mp4')])

    expect(mockState.showTransientStatus).not.toHaveBeenCalled()
  })

  it('caps concurrent uploads at UPLOAD_CONCURRENCY (3)', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    setupDreambyteApi(async ({ originalName }: { originalName: string }) => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { asset: { publicUrl: `dreambyte://uploads/${originalName}`, name: originalName, durationSeconds: 1 } }
    })

    const files = Array.from({ length: 10 }, (_, i) => file(`v${i}.mp4`, 'video/mp4'))
    await importFilesToTimeline(files)

    expect(maxConcurrent).toBeLessThanOrEqual(3)
    // Sanity: at least 2 ran in parallel — otherwise we're sequential, defeating the cap's point.
    expect(maxConcurrent).toBeGreaterThanOrEqual(2)
  })
})

describe('importFilesToTimeline — IPC error handling', () => {
  beforeEach(() => {
    mockState = freshState()
  })
  afterEach(() => clearDreambyteApi())

  it('surfaces upload errors as structured ImportResult, not exceptions', async () => {
    setupDreambyteApi(async () => {
      throw new Error('disk full')
    })

    const errors: string[] = []
    const results = await importFilesToTimeline([file('v.mp4', 'video/mp4')], (m) => errors.push(m))

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/Could not import v\.mp4.*disk full/)
    expect(errors[0]).toMatch(/Could not import v\.mp4/)
  })
})

describe('importFileToTimeline (single-file convenience)', () => {
  beforeEach(() => {
    mockState = freshState()
    setupDreambyteApi(async () => ({
      asset: { publicUrl: 'dreambyte://uploads/v.mp4', name: 'v.mp4', durationSeconds: 10 },
    }))
  })

  afterEach(() => {
    clearDreambyteApi()
    vi.clearAllMocks()
  })

  it('uploads and places a single video clip', async () => {
    const result = await importFileToTimeline(file('v.mp4', 'video/mp4'))
    expect(result.ok).toBe(true)
    expect(result.clipId).toBe('clip-1')
  })

  it('returns the same error shape as the batch path for unsupported MIMEs', async () => {
    const result = await importFileToTimeline(file('doc.pdf', 'application/pdf'))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Unsupported file/)
  })
})
