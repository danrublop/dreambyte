import { describe, it, expect } from 'vitest'
import { AUDIO_PROVIDERS, isAudioProviderReady, DEFAULT_AUDIO_PROVIDER_ENABLED } from './provider-registry'

const byId = (id: string) => AUDIO_PROVIDERS.find((p) => p.id === id)!

describe('audio provider registry — local music generators', () => {
  it('registers Composer + MusicGen as local music providers', () => {
    expect(byId('native-sequencer')).toMatchObject({ category: 'music', type: 'local', requiresKey: null })
    expect(byId('musicgen')).toMatchObject({ category: 'music', type: 'local', requiresKey: null })
  })

  it('both are always ready (no key / no probe — the enable toggle gates them)', () => {
    expect(isAudioProviderReady(byId('native-sequencer'))).toBe(true)
    expect(isAudioProviderReady(byId('musicgen'))).toBe(true)
  })

  it('Composer is on by default; MusicGen is opt-in (enable in Settings → appears in picker)', () => {
    expect(DEFAULT_AUDIO_PROVIDER_ENABLED['native-sequencer']).toBe(true)
    expect(DEFAULT_AUDIO_PROVIDER_ENABLED['musicgen']).toBe(false)
  })

  it('a real key-gated provider is only ready/enabled when its key is set', () => {
    const prev = process.env.PIXABAY_API_KEY
    delete process.env.PIXABAY_API_KEY
    expect(isAudioProviderReady(byId('pixabay-music'))).toBe(false)
    if (prev) process.env.PIXABAY_API_KEY = prev
  })
})
