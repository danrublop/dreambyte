import { describe, it, expect } from 'vitest'
import { isClientOnlyTtsUrl, isClientOnlyTtsProvider } from './download'

// Regression guard: client-only narration is detected by PROVIDER id, not by a
// sentinel url. The provider short-circuits to a client render with src=null, so
// a url-only check (the original bug) never fires and the export silently ships a
// voiceless MP4.
describe('client-only TTS detection', () => {
  it('flags client-only providers by id (the case the export must catch)', () => {
    for (const p of ['web-speech', 'puter', 'puter-tts']) {
      expect(isClientOnlyTtsProvider(p)).toBe(true)
    }
  })

  it('does not flag server providers or empty values', () => {
    for (const p of ['elevenlabs', 'openai', 'pocket-tts', 'auto', '', null, undefined]) {
      expect(isClientOnlyTtsProvider(p)).toBe(false)
    }
  })

  it('still flags the sentinel urls (defense-in-depth) and nothing else', () => {
    expect(isClientOnlyTtsUrl('web-speech://x')).toBe(true)
    expect(isClientOnlyTtsUrl('puter-tts://x')).toBe(true)
    expect(isClientOnlyTtsUrl('https://cdn/voice.mp3')).toBe(false)
    expect(isClientOnlyTtsUrl(null)).toBe(false)
  })
})
