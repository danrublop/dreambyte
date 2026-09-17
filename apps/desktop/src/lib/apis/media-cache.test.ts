// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

/**
 * The cached-row read path routes the stored URL
 * through resolvePublicMediaPath. The contract pinned here: a row whose
 * filePath does NOT resolve to a local mount file (remote URL, traversal
 * poisoning, malformed %-sequence, unknown mount) reads as a CACHE MISS —
 * null / fall-through — never a throw into the generate flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db', () => ({
  getCachedMedia: vi.fn(),
  setCachedMedia: vi.fn(),
}))

import { checkCache, checkContentCache } from './media-cache'
import { getCachedMedia } from '@/lib/db'

const mockGetCachedMedia = vi.mocked(getCachedMedia)

beforeEach(() => {
  mockGetCachedMedia.mockReset()
})

const POISONED_FILE_PATHS = [
  'https://evil.example/x.png', // remote — not ours
  '/uploads/../../etc/passwd', // traversal
  '/published/p/scene.html', // unknown mount
  '/generated/images/%E0%', // malformed %-sequence (decodeURIComponent throws raw)
]

describe('checkCache — resolver-null rows are cache misses, never throws', () => {
  it.each(POISONED_FILE_PATHS)('filePath=%s → null', async (filePath) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetCachedMedia.mockResolvedValue({ filePath, config: null } as any)
    await expect(checkCache('images', { prompt: 'x' })).resolves.toBeNull()
  })

  it('a resolvable-but-absent file is also a miss', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetCachedMedia.mockResolvedValue({ filePath: '/generated/images/never-written.png', config: null } as any)
    await expect(checkCache('images', { prompt: 'x' })).resolves.toBeNull()
  })
})

describe('checkContentCache — same null-as-miss contract', () => {
  it.each(POISONED_FILE_PATHS)('filePath=%s → null', async (filePath) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetCachedMedia.mockResolvedValue({ filePath, config: null } as any)
    await expect(checkContentCache(Buffer.from('bytes'))).resolves.toBeNull()
  })
})
