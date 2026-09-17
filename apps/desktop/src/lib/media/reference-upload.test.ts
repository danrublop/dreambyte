import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolveReferenceToFetchableUrl,
  resolveReferenceToBytes,
  defaultToDiskPath,
  __clearReferenceUploadCache,
  type ReferenceUploadDeps,
} from './reference-upload'

// Use the real defaultToDiskPath so the public/ containment guard sees realistic paths.
function mockDeps(over: Partial<ReferenceUploadDeps> = {}): ReferenceUploadDeps {
  return {
    readFile: vi.fn(async () => Buffer.from('image-bytes')),
    upload: vi.fn(async () => 'https://fal.storage/uploaded.png'),
    toDiskPath: defaultToDiskPath,
    ...over,
  }
}

describe('resolveReferenceToFetchableUrl', () => {
  beforeEach(() => __clearReferenceUploadCache())

  it('passes through a safe http(s) URL without reading or uploading', async () => {
    const deps = mockDeps()
    const url = await resolveReferenceToFetchableUrl('https://example.com/a.png', deps)
    expect(url).toBe('https://example.com/a.png')
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.upload).not.toHaveBeenCalled()
  })

  it('reads a local /uploads reference and uploads it to a fetchable URL', async () => {
    const deps = mockDeps()
    const url = await resolveReferenceToFetchableUrl('/uploads/projects/p1/a.png', deps)
    expect(url).toBe('https://fal.storage/uploaded.png')
    expect(deps.readFile).toHaveBeenCalledWith(expect.stringContaining('public/uploads/projects/p1/a.png'))
    expect(deps.upload).toHaveBeenCalledTimes(1)
  })

  it('dedupes by content hash — same bytes upload once', async () => {
    const deps = mockDeps()
    await resolveReferenceToFetchableUrl('/uploads/a.png', deps)
    await resolveReferenceToFetchableUrl('/uploads/a-copy.png', deps) // same bytes, different path
    expect(deps.upload).toHaveBeenCalledTimes(1) // second resolves from cache
  })

  it('throws a clear error when the local file is unreadable (never silently degrades)', async () => {
    const deps = mockDeps({
      readFile: vi.fn(async () => {
        throw new Error('ENOENT')
      }),
    })
    await expect(resolveReferenceToFetchableUrl('/uploads/missing.png', deps)).rejects.toThrow(
      /image reference not readable.*ENOENT/,
    )
    expect(deps.upload).not.toHaveBeenCalled()
  })

  it('forwards the content type by extension', async () => {
    const deps = mockDeps()
    await resolveReferenceToFetchableUrl('/uploads/a.webp', deps)
    expect(deps.upload).toHaveBeenCalledWith(expect.anything(), 'image/webp')
  })

  // Security: SSRF guard on http references handed to fal.
  it.each([
    'http://localhost/x.png',
    'http://127.0.0.1/x.png',
    'http://169.254.169.254/latest/meta-data', // cloud metadata
    'http://10.0.0.5/x.png',
    'http://192.168.1.10/x.png',
    'https://thing.internal/x.png',
  ])('blocks SSRF-prone http host %s', async (ref) => {
    const deps = mockDeps()
    await expect(resolveReferenceToFetchableUrl(ref, deps)).rejects.toThrow(/SSRF guard|not allowed/)
    expect(deps.upload).not.toHaveBeenCalled()
  })

  // Security: a local reference that escapes public/ must never be read + uploaded.
  it('refuses to read an absolute path outside public/ (no arbitrary file exfiltration)', async () => {
    const deps = mockDeps()
    await expect(resolveReferenceToFetchableUrl('/etc/passwd', deps)).rejects.toThrow(/escapes (public|allowed roots)/)
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.upload).not.toHaveBeenCalled()
  })

  // Tier 2 (#7) review fix: an over-cap LOCAL file is rejected via statSize BEFORE it is read into
  // memory (the multi-ref fan-out made an oversized local ref a memory-exhaustion vector).
  it('rejects an over-cap local reference before reading it (statSize gate)', async () => {
    const deps = mockDeps({ statSize: vi.fn(async () => 26 * 1024 * 1024) }) // 26MB > 25MB cap
    await expect(resolveReferenceToFetchableUrl('/uploads/projects/p1/huge.png', deps)).rejects.toThrow(/too large/)
    expect(deps.readFile).not.toHaveBeenCalled() // never buffered
    expect(deps.upload).not.toHaveBeenCalled()
  })

  it('a small local reference passes the statSize gate and uploads', async () => {
    const deps = mockDeps({ statSize: vi.fn(async () => 1024) })
    await resolveReferenceToFetchableUrl('/uploads/projects/p1/a.png', deps)
    expect(deps.readFile).toHaveBeenCalled()
    expect(deps.upload).toHaveBeenCalledTimes(1)
  })

  // Tier 2 (#5): the extend source is a VIDEO. kind:'video' keeps every SSRF/path guard but swaps
  // the mime allowlist + content-type map (so the same .mp4 extension uploads as video, not audio).
  describe("kind: 'video' (extend source)", () => {
    it('uploads a local clip as video/mp4 (not audio/mp4)', async () => {
      const deps = mockDeps()
      await resolveReferenceToFetchableUrl('/uploads/projects/p1/clip.mp4', deps, { kind: 'video' })
      expect(deps.upload).toHaveBeenCalledWith(expect.anything(), 'video/mp4')
    })

    it('accepts a data:video/* URL', async () => {
      const deps = mockDeps()
      const url = await resolveReferenceToFetchableUrl('data:video/mp4;base64,AAAA', deps, { kind: 'video' })
      expect(url).toBe('https://fal.storage/uploaded.png') // mock upload return
    })

    it('rejects a data:image/* URL when video is requested (no image→video confusion)', async () => {
      const deps = mockDeps()
      await expect(
        resolveReferenceToFetchableUrl('data:image/png;base64,AAAA', deps, { kind: 'video' }),
      ).rejects.toThrow(/Unsupported video reference type/)
      expect(deps.upload).not.toHaveBeenCalled()
    })

    it('still rejects a data:video URL on the default image path (kind defaults to image)', async () => {
      const deps = mockDeps()
      await expect(resolveReferenceToFetchableUrl('data:video/mp4;base64,AAAA', deps)).rejects.toThrow(
        /Unsupported image reference type/,
      )
    })

    it('keeps the SSRF guard for a video http host', async () => {
      const deps = mockDeps()
      await expect(
        resolveReferenceToFetchableUrl('http://169.254.169.254/clip.mp4', deps, { kind: 'video' }),
      ).rejects.toThrow(/SSRF guard|not allowed/)
    })

    it('caches per KIND — identical bytes resolved as image vs video upload separately (right mime each)', async () => {
      const deps = mockDeps() // readFile returns the same bytes regardless of path
      await resolveReferenceToFetchableUrl('/uploads/a.png', deps) // image
      await resolveReferenceToFetchableUrl('/uploads/a.mp4', deps, { kind: 'video' }) // same bytes, video
      expect(deps.upload).toHaveBeenCalledTimes(2) // NOT deduped across kinds
      expect(deps.upload).toHaveBeenCalledWith(expect.anything(), 'image/png')
      expect(deps.upload).toHaveBeenCalledWith(expect.anything(), 'video/mp4')
    })

    it('rejects an over-cap local clip via statSize BEFORE reading it into memory (no OOM)', async () => {
      const deps = mockDeps({
        statSize: vi.fn(async () => 300 * 1024 * 1024), // 300MB > 200MB video cap
      })
      await expect(resolveReferenceToFetchableUrl('/uploads/huge.mp4', deps, { kind: 'video' })).rejects.toThrow(
        /Reference video too large/,
      )
      expect(deps.readFile).not.toHaveBeenCalled() // never buffered the file
      expect(deps.upload).not.toHaveBeenCalled()
    })

    it('a small clip passes the statSize gate and uploads', async () => {
      const deps = mockDeps({ statSize: vi.fn(async () => 1024) })
      await resolveReferenceToFetchableUrl('/uploads/small.mp4', deps, { kind: 'video' })
      expect(deps.readFile).toHaveBeenCalled()
      expect(deps.upload).toHaveBeenCalledWith(expect.anything(), 'video/mp4')
    })
  })

  // Tier 3 Cast (Slice 2): a voice-clone sample is AUDIO. kind:'audio' keeps every SSRF/path guard
  // but swaps the mime allowlist + content-type map. This is the biometric upload path, so the
  // sample must be guarded exactly like an image ref, never passed raw to a third party.
  describe("kind: 'audio' (voice-clone sample)", () => {
    it('uploads a local sample as audio/mpeg (not image)', async () => {
      const deps = mockDeps()
      await resolveReferenceToFetchableUrl('/uploads/projects/p1/sample.mp3', deps, { kind: 'audio' })
      expect(deps.upload).toHaveBeenCalledWith(expect.anything(), 'audio/mpeg')
    })

    it('uploads a .wav sample with the right content type', async () => {
      const deps = mockDeps()
      await resolveReferenceToFetchableUrl('/uploads/projects/p1/sample.wav', deps, { kind: 'audio' })
      expect(deps.upload).toHaveBeenCalledWith(expect.anything(), 'audio/wav')
    })

    it('accepts a data:audio/* URL (regression: the default image path rejected this)', async () => {
      const deps = mockDeps()
      const url = await resolveReferenceToFetchableUrl('data:audio/mpeg;base64,AAAA', deps, { kind: 'audio' })
      expect(url).toBe('https://fal.storage/uploaded.png') // mock upload return
    })

    it('still rejects a data:audio URL on the default image path (kind defaults to image)', async () => {
      const deps = mockDeps()
      await expect(resolveReferenceToFetchableUrl('data:audio/mpeg;base64,AAAA', deps)).rejects.toThrow(
        /Unsupported image reference type/,
      )
    })

    it('rejects a data:image/* URL when audio is requested (no image→audio confusion)', async () => {
      const deps = mockDeps()
      await expect(
        resolveReferenceToFetchableUrl('data:image/png;base64,AAAA', deps, { kind: 'audio' }),
      ).rejects.toThrow(/Unsupported audio reference type/)
      expect(deps.upload).not.toHaveBeenCalled()
    })

    it('keeps the SSRF guard for an audio http host (biometric data must not exfiltrate)', async () => {
      const deps = mockDeps()
      await expect(
        resolveReferenceToFetchableUrl('http://169.254.169.254/sample.mp3', deps, { kind: 'audio' }),
      ).rejects.toThrow(/SSRF guard|not allowed/)
      expect(deps.upload).not.toHaveBeenCalled()
    })

    it('rejects an over-cap local sample via statSize BEFORE reading it (no OOM)', async () => {
      const deps = mockDeps({ statSize: vi.fn(async () => 60 * 1024 * 1024) }) // 60MB > 50MB audio cap
      await expect(resolveReferenceToFetchableUrl('/uploads/huge.mp3', deps, { kind: 'audio' })).rejects.toThrow(
        /Reference audio too large/,
      )
      expect(deps.readFile).not.toHaveBeenCalled()
      expect(deps.upload).not.toHaveBeenCalled()
    })

    it('a small sample passes the statSize gate and uploads', async () => {
      const deps = mockDeps({ statSize: vi.fn(async () => 1024) })
      await resolveReferenceToFetchableUrl('/uploads/small.mp3', deps, { kind: 'audio' })
      expect(deps.readFile).toHaveBeenCalled()
      expect(deps.upload).toHaveBeenCalledWith(expect.anything(), 'audio/mpeg')
    })
  })
})

describe('defaultToDiskPath', () => {
  it('keeps absolute paths, resolves relative /uploads under the uploads dir', () => {
    expect(defaultToDiskPath('/abs/already.png')).toMatch(/already\.png$/)
    const rel = defaultToDiskPath('/uploads/projects/p1/a.png')
    expect(rel).toContain('public/uploads/projects/p1/a.png')
  })

  // Regression (Codex P1): packaged Electron addresses generated assets as
  // dreambyte://uploads/... — these MUST map to the real uploads dir, not public/dreambyte:/...
  it('maps dreambyte://uploads/ to the configured uploads dir (Electron i2i fix)', () => {
    const prev = process.env.DREAMBYTE_UPLOADS_DIR
    process.env.DREAMBYTE_UPLOADS_DIR = '/tmp/userData/uploads'
    try {
      expect(defaultToDiskPath('dreambyte://uploads/projects/p1/a.png')).toBe('/tmp/userData/uploads/projects/p1/a.png')
      // and /uploads/ follows the same dir when the env override is set
      expect(defaultToDiskPath('/uploads/projects/p1/a.png')).toBe('/tmp/userData/uploads/projects/p1/a.png')
    } finally {
      if (prev === undefined) delete process.env.DREAMBYTE_UPLOADS_DIR
      else process.env.DREAMBYTE_UPLOADS_DIR = prev
    }
  })
})

describe('resolveReferenceToBytes — data: URL guards (i2v / Veo)', () => {
  beforeEach(() => __clearReferenceUploadCache())

  it('decodes a base64 image data URL to bytes + mime', async () => {
    const b64 = Buffer.from('hello-png').toString('base64')
    const out = await resolveReferenceToBytes(`data:image/png;base64,${b64}`)
    expect(out.mimeType).toBe('image/png')
    expect(out.bytes.toString()).toBe('hello-png')
  })

  it('detects ;base64 even with an interleaved param (charset before base64)', async () => {
    const b64 = Buffer.from('x').toString('base64')
    const out = await resolveReferenceToBytes(`data:image/png;charset=utf-8;base64,${b64}`)
    expect(out.bytes.toString()).toBe('x') // decoded as base64, not as literal text
  })

  it('rejects a non-image data URL (no text/html into an image provider)', async () => {
    await expect(resolveReferenceToBytes('data:text/html;base64,PHNjcmlwdD4=')).rejects.toThrow(
      /Unsupported image reference type/,
    )
  })

  it('rejects an http reference whose content-length exceeds the cap (before downloading)', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === 'content-length' ? String(99 * 1024 * 1024) : null) },
      arrayBuffer,
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(resolveReferenceToBytes('https://example.com/big.png')).rejects.toThrow(/too large/)
      expect(arrayBuffer).not.toHaveBeenCalled() // content-length checked before downloading the body
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects an http reference that REDIRECTS (SSRF guard — manual redirect, non-ok)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({
      ok: false,
      status: 0,
      type: 'opaqueredirect',
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(resolveReferenceToBytes('https://example.com/redir.png')).rejects.toThrow(/failed or redirected/)
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads a local /uploads reference to bytes', async () => {
    const deps: ReferenceUploadDeps = {
      readFile: vi.fn(async () => Buffer.from('local-bytes')),
      upload: vi.fn(async () => 'unused'),
      toDiskPath: defaultToDiskPath,
    }
    const out = await resolveReferenceToBytes('/uploads/projects/p1/a.png', deps)
    expect(out.bytes.toString()).toBe('local-bytes')
    expect(out.mimeType).toBe('image/png')
  })
})
