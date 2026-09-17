// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyText } from './copy-text'

describe('copyText', () => {
  const origClipboard = navigator.clipboard
  const w = window as unknown as { dreambyteApi?: unknown }

  beforeEach(() => {
    delete w.dreambyteApi
  })
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: origClipboard, configurable: true })
    delete w.dreambyteApi
  })

  const setClipboard = (v: unknown) =>
    Object.defineProperty(navigator, 'clipboard', { value: v, configurable: true })

  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    expect(await copyText('hello')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to the native bridge when navigator.clipboard is undefined', async () => {
    setClipboard(undefined)
    const copyTextNative = vi.fn().mockResolvedValue({ ok: true })
    w.dreambyteApi = { app: { copyText: copyTextNative } }
    expect(await copyText('id-123')).toBe(true)
    expect(copyTextNative).toHaveBeenCalledWith('id-123')
  })

  it('falls back to the native bridge when navigator.clipboard.writeText throws', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('blocked')) })
    const copyTextNative = vi.fn().mockResolvedValue({ ok: true })
    w.dreambyteApi = { app: { copyText: copyTextNative } }
    expect(await copyText('x')).toBe(true)
    expect(copyTextNative).toHaveBeenCalledWith('x')
  })

  it('returns false when neither path is available', async () => {
    setClipboard(undefined)
    expect(await copyText('x')).toBe(false)
  })

  it('returns false when the native bridge reports not-ok', async () => {
    setClipboard(undefined)
    w.dreambyteApi = { app: { copyText: vi.fn().mockResolvedValue({ ok: false }) } }
    expect(await copyText('x')).toBe(false)
  })
})
