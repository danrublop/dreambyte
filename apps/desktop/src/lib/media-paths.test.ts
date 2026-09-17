// @vitest-environment node

/**
 * Env-aware local-media URL → disk resolution.
 *
 * The dispatcher replaces every `path.join(process.cwd(), 'public', url)`
 * site (media-cache reads, FAL data-URI inlining, cached-video start-cache,
 * asset thumbnail deletion). These tests pin: per-mount env overrides, the
 * URL forms call sites actually persist, traversal containment, and the
 * null contract for non-local URLs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { getGeneratedDir, resolvePublicMediaPath } from './media-paths'

const ENV_KEYS = ['DREAMBYTE_GENERATED_DIR', 'DREAMBYTE_UPLOADS_DIR', 'DREAMBYTE_AUDIO_DIR'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('getGeneratedDir', () => {
  it('defaults to cwd/public/generated (dev — Next serves it)', () => {
    expect(getGeneratedDir()).toBe(path.join(process.cwd(), 'public', 'generated'))
  })
  it('honors DREAMBYTE_GENERATED_DIR (packaged — userData mount)', () => {
    process.env.DREAMBYTE_GENERATED_DIR = '/tmp/userData/generated'
    expect(getGeneratedDir()).toBe('/tmp/userData/generated')
  })
})

describe('resolvePublicMediaPath', () => {
  it('resolves each mount against its env-aware dir', () => {
    process.env.DREAMBYTE_GENERATED_DIR = '/ud/generated'
    process.env.DREAMBYTE_UPLOADS_DIR = '/ud/uploads'
    process.env.DREAMBYTE_AUDIO_DIR = '/ud/audio'
    expect(resolvePublicMediaPath('/generated/images/a.png')).toBe(path.resolve('/ud/generated/images/a.png'))
    expect(resolvePublicMediaPath('/uploads/b.png')).toBe(path.resolve('/ud/uploads/b.png'))
    expect(resolvePublicMediaPath('/audio/c.wav')).toBe(path.resolve('/ud/audio/c.wav'))
  })

  it('dev default: /generated/... maps under cwd/public/generated', () => {
    expect(resolvePublicMediaPath('/generated/videos/x.mp4')).toBe(
      path.join(process.cwd(), 'public', 'generated', 'videos', 'x.mp4'),
    )
  })

  it('accepts dreambyte:// and legacy cench:// scheme forms', () => {
    process.env.DREAMBYTE_UPLOADS_DIR = '/ud/uploads'
    expect(resolvePublicMediaPath('dreambyte://uploads/x.png')).toBe(path.resolve('/ud/uploads/x.png'))
    expect(resolvePublicMediaPath('cench://uploads/x.png')).toBe(path.resolve('/ud/uploads/x.png'))
  })

  it('returns null for remote / non-local / unknown-mount URLs', () => {
    expect(resolvePublicMediaPath('https://example.com/a.png')).toBeNull()
    expect(resolvePublicMediaPath('data:image/png;base64,AAAA')).toBeNull()
    expect(resolvePublicMediaPath('/published/p/scene.html')).toBeNull() // not a media mount
    expect(resolvePublicMediaPath('/uploads')).toBeNull() // bare mount, no file
    expect(resolvePublicMediaPath('')).toBeNull()
  })

  it('rejects traversal — a poisoned DB row cannot escape the mount', () => {
    process.env.DREAMBYTE_UPLOADS_DIR = '/ud/uploads'
    expect(resolvePublicMediaPath('/uploads/../../etc/passwd')).toBeNull()
    expect(resolvePublicMediaPath('/uploads/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(resolvePublicMediaPath('dreambyte://uploads/../secrets.txt')).toBeNull()
  })

  it('malformed %-sequences return null, never throw (/review PR #104 multi-confirmed)', () => {
    // decodeURIComponent throws URIError on these; the null contract must hold
    // so a poisoned legacy row degrades to a cache miss instead of throwing
    // into a live generate flow.
    expect(() => resolvePublicMediaPath('/uploads/%')).not.toThrow()
    expect(resolvePublicMediaPath('/uploads/%')).toBeNull()
    expect(resolvePublicMediaPath('/generated/images/%E0%')).toBeNull()
    expect(resolvePublicMediaPath('dreambyte://uploads/bad%2')).toBeNull()
  })
})

describe('mount-table drift tripwire', () => {
  it('every dispatcher mount is served by the protocol handler (src/electron/main.ts)', async () => {
    // HOST_DIRS (here) and the protocol handler's host lists (main.ts: the
    // baseDir dispatch + two rewrite regexes) are independent hardcoded lists.
    // A mount added to one but not the other passes every unit test and
    // breaks only in packaged builds — this source-text tripwire makes the
    // divergence fail CI instead. ('scenes' is handler-only by design: it is
    // a protocol mount but not a media-URL mount this dispatcher serves.)
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const mainSrc = await fs.readFile(path.join(process.cwd(), 'src', 'electron', 'main.ts'), 'utf8')
    for (const host of ['uploads', 'generated', 'audio']) {
      expect(resolvePublicMediaPath(`/${host}/probe.bin`), `dispatcher lost mount "${host}"`).not.toBeNull()
      expect(mainSrc, `protocol handler missing baseDir dispatch for "${host}"`).toMatch(
        new RegExp(`host === '${host}'`),
      )
      expect(mainSrc, `app-host rewrite regex missing "${host}"`).toMatch(
        new RegExp(`scenes\\|audio\\|uploads\\|generated`),
      )
    }
  })
})
