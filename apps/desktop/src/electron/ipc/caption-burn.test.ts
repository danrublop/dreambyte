// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'
import type { IpcMain } from 'electron'

// caption-burn.ts only type-imports electron, but it pulls runFfmpeg from
// audio-normalize, whose ../paths dependency imports electron's `app` at
// module load — stub both so the module graph loads in a plain node env.
vi.mock('../paths', () => ({
  getRenderServerDir: () => '/tmp',
}))

// audio-normalize's runFfmpeg now routes through ffmpeg-util's utilityProcess
// runner (avoids the main-process ffmpeg SIGSEGV) — that module imports `electron` at top
// level, which throws at COLLECTION time on CI (no Electron binary installed
// there by design). Same stub shape as src/electron/audio-decode.test.ts.
vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(() => ({ on: vi.fn(), once: vi.fn(), kill: vi.fn(), postMessage: vi.fn() })),
  },
}))

import { burnTimeoutMs, register } from './caption-burn'

describe('burnTimeoutMs — scales with frames × pixel area', () => {
  const FLOOR = 30 * 60 * 1000
  const CEIL = 4 * 60 * 60 * 1000

  it('falls back to the 30-min floor without hints', () => {
    expect(burnTimeoutMs(1920, 1080)).toBe(FLOOR)
    expect(burnTimeoutMs(1920, 1080, NaN, 30)).toBe(FLOOR)
    expect(burnTimeoutMs(1920, 1080, 60, undefined)).toBe(FLOOR)
  })

  it('short 1080p exports stay at the floor', () => {
    // 60s @ 30fps @ 1080p → 1800 frames × 150ms = 4.5min < 30min floor
    expect(burnTimeoutMs(1920, 1080, 60, 30)).toBe(FLOOR)
  })

  it('long 1080p exports scale past the floor', () => {
    // 600s @ 30fps @ 1080p → 18000 frames × 150ms = 45min
    expect(burnTimeoutMs(1920, 1080, 600, 30)).toBe(18000 * 150)
  })

  it('long 4K exports are capped at 4h instead of SIGKILLed at 30min', () => {
    // 600s @ 60fps @ 4K → 36000 frames × 150ms × 4 = 6h → ceil 4h
    expect(burnTimeoutMs(3840, 2160, 600, 60)).toBe(CEIL)
  })

  it('sub-1080p never gets LESS budget than 1080p (pixelRatio floored at 1)', () => {
    expect(burnTimeoutMs(640, 360, 600, 30)).toBe(18000 * 150)
  })
})

describe('dreambyte:export.burnCaptions handler — validation + F68 authorization', () => {
  type Handler = (event: unknown, args: unknown) => Promise<unknown>
  const getHandler = (isWriteAuthorized: (p: string) => boolean): Handler => {
    let handler: Handler | undefined
    const fakeIpc = {
      handle: (_channel: string, fn: Handler) => {
        handler = fn
      },
    } as unknown as IpcMain
    register(fakeIpc, isWriteAuthorized)
    if (!handler) throw new Error('handler not registered')
    return handler
  }

  it('rejects missing/invalid filePath and srt before any filesystem work', async () => {
    const handler = getHandler(() => true)
    await expect(handler({}, undefined)).rejects.toThrow(/requires filePath and srt/)
    await expect(handler({}, { filePath: '', srt: 'x', width: 1, height: 1 })).rejects.toThrow(/requires filePath/)
    await expect(handler({}, { filePath: '/a.mp4', srt: 42, width: 1, height: 1 })).rejects.toThrow(/requires filePath/)
  })

  it('rejects non-positive / non-finite dimensions', async () => {
    const handler = getHandler(() => true)
    for (const [w, h] of [[0, 100], [100, -1], [NaN, 100], ['x', 100]] as const) {
      await expect(handler({}, { filePath: '/a.mp4', srt: 's', width: w, height: h })).rejects.toThrow(
        /positive width\/height/,
      )
    }
  })

  it('rejects paths the main process never vended (F68 allowlist)', async () => {
    const seen: string[] = []
    const handler = getHandler((p) => {
      seen.push(p)
      return false
    })
    await expect(
      handler({}, { filePath: '/etc/target.mp4', srt: 's', width: 100, height: 100 }),
    ).rejects.toThrow(/not authorized/)
    expect(seen).toEqual(['/etc/target.mp4'])
  })
})
