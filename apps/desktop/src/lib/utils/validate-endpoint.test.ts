import { describe, it, expect } from 'vitest'

import { safeLocalEndpoint } from './validate-endpoint'

// Security review F49: a user-configured local-model endpoint must be a
// well-formed http(s) URL before it is interpolated into fetch().
describe('safeLocalEndpoint', () => {
  it('accepts valid http(s) endpoints and strips trailing slash', () => {
    expect(safeLocalEndpoint('http://localhost:11434')).toBe('http://localhost:11434')
    expect(safeLocalEndpoint('http://192.168.1.50:11434/')).toBe('http://192.168.1.50:11434')
    expect(safeLocalEndpoint('https://ollama.lan')).toBe('https://ollama.lan')
  })

  it('falls back on non-http(s) schemes', () => {
    expect(safeLocalEndpoint('file:///etc/passwd')).toBe('http://localhost:11434')
    expect(safeLocalEndpoint('javascript:alert(1)')).toBe('http://localhost:11434')
  })

  it('falls back on malformed / empty values', () => {
    expect(safeLocalEndpoint('not a url')).toBe('http://localhost:11434')
    expect(safeLocalEndpoint('')).toBe('http://localhost:11434')
    expect(safeLocalEndpoint(undefined)).toBe('http://localhost:11434')
  })
})
