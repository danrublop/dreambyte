// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { AUDIO_MODELS, audioModelsForSubType, audioModel, defaultAudioModelId, ttsApiNameFor } from './audio-models'
import { createDefaultAPIPermissions } from '@/lib/permissions'

// The audio-model directory is the source of truth that BOTH the composer pills and the spend gate
// (audio-gen.ts) read. A typo'd apiName silently bypasses the run cost cap — the model_pricing_drift
// class. This invariant mirrors model-catalog.test.ts's "providerId exists in MEDIA_PROVIDERS" guard.
describe('audio-models directory', () => {
  it('every paid apiName is a REAL APIName; free providers are null with null cost', () => {
    const valid = new Set(Object.keys(createDefaultAPIPermissions()))
    for (const m of AUDIO_MODELS) {
      if (m.apiName === null) {
        expect(m.costCents, `${m.id} is free but has a cost`).toBeNull()
        continue
      }
      expect(valid.has(m.apiName), `${m.id} -> unknown apiName "${m.apiName}"`).toBe(true)
    }
  })

  it('free browser providers map to apiName null; paid ones map correctly', () => {
    expect(audioModel('web-speech')?.apiName).toBeNull()
    expect(audioModel('puter')?.apiName).toBeNull()
    expect(audioModel('stable-audio')?.apiName).toBe('falMusic')
    expect(audioModel('elevenlabs-sfx')?.apiName).toBe('elevenLabs')
  })

  it('sub-type filter + default + lookup resolve and miss cleanly', () => {
    expect(audioModelsForSubType('music').map((m) => m.id)).toEqual([
      'native-sequencer',
      'musicgen',
      'stable-audio',
      'elevenlabs-music',
      'lyria',
    ])
    expect(audioModelsForSubType('tts').length).toBeGreaterThan(0)
    expect(audioModelsForSubType('sfx').map((m) => m.id)).toContain('elevenlabs-sfx')
    expect(defaultAudioModelId('tts')).toBe('elevenlabs')
    expect(defaultAudioModelId('sfx')).toBe('elevenlabs-sfx')
    // The free, instant Composer is the default music model (local, no key).
    expect(defaultAudioModelId('music')).toBe('native-sequencer')
    expect(audioModel('nope')).toBeUndefined()
  })

  it('ttsApiNameFor maps every paid TTS provider and treats free/local/unknown as null', () => {
    const valid = new Set(Object.keys(createDefaultAPIPermissions()))
    // Paid providers the auto-resolver can land on must each gate against a real APIName.
    for (const p of ['elevenlabs', 'openai-tts', 'gemini-tts', 'google-tts']) {
      const api = ttsApiNameFor(p)
      expect(api, `${p} should be a paid (non-null) apiName`).not.toBeNull()
      expect(valid.has(api as string)).toBe(true)
    }
    // Free / local / browser providers + unknown ids → null (gate skipped).
    for (const p of ['web-speech', 'puter', 'native-tts', 'openai-edge-tts', 'pocket-tts', 'voxcpm', 'mystery']) {
      expect(ttsApiNameFor(p), `${p} should be free (null)`).toBeNull()
    }
  })
})
