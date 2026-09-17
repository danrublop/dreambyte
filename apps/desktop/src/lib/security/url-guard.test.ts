import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, UrlGuardError } from './url-guard'

describe('assertPublicHttpUrl', () => {
  describe('allows', () => {
    it.each([
      'https://example.com/foo.mp4',
      'http://example.com/foo.mp4',
      'https://cdn.pixabay.com/video/abc.mp4',
      'https://8.8.8.8/foo',
      'https://example.com:8080/path',
      'https://user:pass@example.com/foo',
      'https://api.elevenlabs.io/v1/text-to-speech',
    ])('%s', (url) => {
      expect(() => assertPublicHttpUrl(url)).not.toThrow()
    })
  })

  describe('rejects disallowed schemes', () => {
    it.each(['file:///etc/passwd', 'data:text/html,hello', 'javascript:alert(1)', 'ftp://example.com/foo'])(
      '%s',
      (url) => {
        expect(() => assertPublicHttpUrl(url)).toThrow(UrlGuardError)
      },
    )
  })

  describe('rejects loopback + private v4', () => {
    it.each([
      'http://localhost/foo',
      'http://Localhost/foo', // case-insensitive
      'http://foo.localhost/bar',
      'http://127.0.0.1/foo',
      'http://127.1.2.3/foo',
      'http://0.0.0.0/foo',
      'http://my-machine.local/foo',
      'http://169.254.169.254/latest/meta-data/', // AWS/GCP/Azure metadata
      'http://10.0.0.1/foo',
      'http://10.255.255.255/foo',
      'http://192.168.0.1/foo',
      'http://172.16.0.1/foo',
      'http://172.31.255.255/foo',
    ])('%s', (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UrlGuardError)
    })
  })

  describe('rejects numeric-encoded loopback/private (F84)', () => {
    it.each([
      'http://2130706433/foo', // 127.0.0.1 as a single decimal
      'http://0x7f000001/foo', // 127.0.0.1 as hex
      'http://0177.0.0.1/foo', // 127 in octal, dotted
      'http://0x7f.1/foo', // 127.0.0.1 hex + 2-part shorthand
      'http://2852039166/foo', // 169.254.169.254 as decimal
      'http://017700000001/foo', // 127.0.0.1 as a single octal
    ])('%s', (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UrlGuardError)
    })
  })

  describe('rejects private v6', () => {
    it.each([
      'http://[::1]/foo',
      'http://[::]/foo',
      'http://[fc00::1]/foo',
      'http://[fd00::abcd]/foo',
      'http://[fe80::1]/foo',
      'http://[::ffff:127.0.0.1]/foo',
    ])('%s', (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UrlGuardError)
    })
  })

  describe('allows public v4 just outside private ranges', () => {
    it.each([
      'http://172.15.0.1/foo', // 172.15 is public (172.16-31 is private)
      'http://172.32.0.1/foo', // 172.32 is public
      'http://128.0.0.1/foo', // outside 127/8
      'http://193.168.0.1/foo', // 193 not 192.168
    ])('%s', (url) => {
      expect(() => assertPublicHttpUrl(url)).not.toThrow()
    })
  })

  describe('rejects malformed', () => {
    it('empty string', () => {
      expect(() => assertPublicHttpUrl('')).toThrow(UrlGuardError)
    })
    it('not a URL', () => {
      expect(() => assertPublicHttpUrl('not a url')).toThrow(UrlGuardError)
    })
  })

  describe('allowedSchemes override', () => {
    it('https-only rejects http', () => {
      expect(() => assertPublicHttpUrl('http://example.com/', { allowedSchemes: ['https:'] })).toThrow(
        /Disallowed URL scheme/,
      )
    })
    it('https-only allows https', () => {
      expect(() => assertPublicHttpUrl('https://example.com/', { allowedSchemes: ['https:'] })).not.toThrow()
    })
  })
})
