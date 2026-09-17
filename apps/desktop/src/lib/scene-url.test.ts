import { afterEach, describe, expect, it } from 'vitest'
import { sceneSrc } from './scene-url'

// jsdom gives window.location.protocol === 'http:' by default. The origin
// isolation only kicks in under the packaged `dreambyte://` scheme, so each case
// stubs the protocol and restores it afterward.
const realLocation = window.location

function setProtocol(protocol: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, protocol },
  })
}

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
})

describe('sceneSrc — scene iframe origin isolation', () => {
  it('uses the distinct dreambyte://scene-frame origin under the packaged dreambyte scheme', () => {
    setProtocol('dreambyte:')
    expect(sceneSrc('abc-123')).toBe('dreambyte://scene-frame/abc-123.html')
  })

  it('appends a cache-busting version query when version > 0', () => {
    setProtocol('dreambyte:')
    expect(sceneSrc('abc-123', 4)).toBe('dreambyte://scene-frame/abc-123.html?v=4')
  })

  it('omits the version query when version is 0', () => {
    setProtocol('dreambyte:')
    expect(sceneSrc('abc-123', 0)).toBe('dreambyte://scene-frame/abc-123.html')
  })

  it('stays same-origin relative in dev (http), where no second origin exists', () => {
    setProtocol('http:')
    expect(sceneSrc('abc-123')).toBe('/scenes/abc-123.html')
  })

  // Security regression guard: under dreambyte://, a scene must never load from a
  // same-origin /scenes/ path — that re-opens the window.parent.dreambyteApi escape.
  // See docs/plans/SECURITY-SCOPE.md section 4.
  it('never emits a same-origin /scenes/ path under dreambyte://', () => {
    setProtocol('dreambyte:')
    expect(sceneSrc('x')).not.toMatch(/^\/scenes\//)
  })
})
