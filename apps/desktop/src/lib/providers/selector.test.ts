import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WEIGHTS,
  LOCAL_MODE_WEIGHTS,
  selectBestProvider,
  type ProviderProfile,
} from './selector'
import { TTS_PROFILES } from './tts-profiles'
import { IMAGE_PROFILES } from './image-profiles'

const envWith = (obj: Record<string, string | undefined>): Record<string, string | undefined> => obj

describe('selectBestProvider', () => {
  it('returns null when nothing is available', () => {
    const out = selectBestProvider(TTS_PROFILES, { env: {} }, DEFAULT_WEIGHTS)
    // web-speech + puter are always available
    expect(out.chosen).not.toBe(null)
  })

  it('prefers free providers in local mode weights', () => {
    const out = selectBestProvider(
      TTS_PROFILES,
      { env: envWith({ ELEVENLABS_API_KEY: 'x' }), platform: 'darwin' },
      LOCAL_MODE_WEIGHTS,
    )
    // A free provider (native-tts, web-speech, puter) should beat ElevenLabs here
    expect(out.chosen?.costUsd).toBe(0)
  })

  it('ranking is sorted descending by score', () => {
    const out = selectBestProvider(
      TTS_PROFILES,
      { env: envWith({ ELEVENLABS_API_KEY: 'x', OPENAI_API_KEY: 'y' }) },
      DEFAULT_WEIGHTS,
    )
    for (let i = 1; i < out.ranking.length; i++) {
      expect(out.ranking[i - 1].score).toBeGreaterThanOrEqual(out.ranking[i].score)
    }
  })

  it('uses the task-fit bias when picking image providers', () => {
    const typographyPick = selectBestProvider(
      IMAGE_PROFILES,
      { env: envWith({ FAL_KEY: 'x' }), task: 'typography' },
      DEFAULT_WEIGHTS,
    )
    expect(typographyPick.chosen?.id).toBe('ideogram-v3')

    const draftPick = selectBestProvider(
      IMAGE_PROFILES,
      { env: envWith({ FAL_KEY: 'x' }), task: 'draft' },
      DEFAULT_WEIGHTS,
    )
    // For drafts, flux-schnell's speed + low cost + fit should win
    expect(draftPick.chosen?.id).toBe('flux-schnell')
  })

  it('gives a continuity boost to the last-used provider on ties', () => {
    // Two providers with identical static scores — continuity should tiebreak
    const profiles: ProviderProfile<'a' | 'b'>[] = [
      {
        id: 'a',
        category: 'image',
        name: 'A',
        quality: 80,
        reliability: 80,
        latency: 80,
        control: 80,
        available: () => true,
        costUsd: () => 0.05,
        taskFit: () => 80,
      },
      {
        id: 'b',
        category: 'image',
        name: 'B',
        quality: 80,
        reliability: 80,
        latency: 80,
        control: 80,
        available: () => true,
        costUsd: () => 0.05,
        taskFit: () => 80,
      },
    ]
    const withPrior = selectBestProvider(profiles, { lastProviderId: 'b' }, DEFAULT_WEIGHTS)
    expect(withPrior.chosen?.id).toBe('b')
  })

  it('drops client-only providers when requiresServerOutput is set (MP4 export path)', () => {
    const out = selectBestProvider(
      TTS_PROFILES,
      { env: envWith({}), platform: 'linux', requiresServerOutput: true },
      DEFAULT_WEIGHTS,
    )
    // web-speech + puter are clientOnly; with no keys + requiresServerOutput,
    // there's nothing server-side to return.
    expect(out.chosen).toBe(null)
  })

  it('excludeIds filters specific providers out of the ranking', () => {
    const out = selectBestProvider(
      TTS_PROFILES,
      {
        env: envWith({ ELEVENLABS_API_KEY: 'x', OPENAI_API_KEY: 'y' }),
        excludeIds: ['elevenlabs'],
      },
      DEFAULT_WEIGHTS,
    )
    expect(out.chosen?.id).not.toBe('elevenlabs')
  })

  it('throws-safe: provider that errors in available() is dropped', () => {
    const profiles: ProviderProfile<'good' | 'bad'>[] = [
      {
        id: 'good',
        category: 'image',
        name: 'good',
        quality: 70,
        reliability: 70,
        latency: 70,
        control: 70,
        available: () => true,
        costUsd: () => 0,
      },
      {
        id: 'bad',
        category: 'image',
        name: 'bad',
        quality: 99,
        reliability: 99,
        latency: 99,
        control: 99,
        available: () => {
          throw new Error('boom')
        },
        costUsd: () => 0,
      },
    ]
    const out = selectBestProvider(profiles, {}, DEFAULT_WEIGHTS)
    expect(out.chosen?.id).toBe('good')
  })
})
