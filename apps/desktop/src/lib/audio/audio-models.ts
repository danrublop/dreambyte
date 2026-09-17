/**
 * Audio model directory — the in-app Generate composer's source of truth for the audio
 * "model" pill.
 *
 * Audio does NOT live in `src/lib/media/model-catalog.ts`. That catalog routes the agent over
 * `MEDIA_PROVIDERS` (image/video/avatar) and a hard invariant test binds every row's
 * `providerId` to that registry. Audio has its OWN provider system — `src/lib/audio/router.ts`
 * + the `audioProviderEnabled` toggles + the `TTSProvider`/`SFXProvider`/`MusicProvider`
 * unions — so its models are described here instead, keyed by those provider ids.
 *
 * Two consumers:
 *   - the renderer (GenerateComposer) reads these to populate the sub-type + model pills
 *     (isomorphic-safe: no `process.env` at module load);
 *   - the main process (`src/lib/services/audio-gen.ts`) reads `apiName` to gate spend — a `null`
 *     `apiName` means a FREE provider (browser web-speech / puter) → skip the gate entirely.
 *
 * Cost is carried inline (cents) for the pill hint, mirroring the media catalog's cost-on-row.
 */

import type { APIName } from '@/lib/types/permissions'

export type AudioSubType = 'tts' | 'sfx' | 'music'

export interface AudioModelOption {
  /** Provider id — a `TTSProvider` / `SFXProvider` / `MusicProvider` union value. */
  id: string
  label: string
  subType: AudioSubType
  /** API the spend gate charges against. `null` = a free provider → the gate is skipped. */
  apiName: APIName | null
  /** Approximate per-call cost in cents for the pill hint. `null` = free. */
  costCents: number | null
}

export const AUDIO_MODELS: AudioModelOption[] = [
  // ── Voice (TTS) ────────────────────────────────────────────────────────────
  { id: 'elevenlabs', label: 'ElevenLabs', subType: 'tts', apiName: 'elevenLabs', costCents: 6 },
  { id: 'openai-tts', label: 'OpenAI TTS', subType: 'tts', apiName: 'openaiTts', costCents: 2 },
  { id: 'gemini-tts', label: 'Gemini TTS', subType: 'tts', apiName: 'geminiTts', costCents: 1 },
  { id: 'google-tts', label: 'Google Cloud TTS', subType: 'tts', apiName: 'googleTts', costCents: 1 },
  // Free, browser-side providers — no key, no spend gate.
  { id: 'web-speech', label: 'Web Speech (free)', subType: 'tts', apiName: null, costCents: null },
  { id: 'puter', label: 'Puter (free)', subType: 'tts', apiName: null, costCents: null },

  // ── Sound effects ──────────────────────────────────────────────────────────
  { id: 'elevenlabs-sfx', label: 'ElevenLabs SFX', subType: 'sfx', apiName: 'elevenLabs', costCents: 2 },

  // ── Music ──────────────────────────────────────────────────────────────────
  // Local, $0, no key. Composer is instant (template + instrument sequencer); MusicGen
  // is the neural text-prompt model (needs the local sidecar running — MUSICGEN_URL).
  // Listed first so the free/instant Composer is the default music model.
  { id: 'native-sequencer', label: 'Composer (local, instant)', subType: 'music', apiName: null, costCents: null },
  { id: 'musicgen', label: 'MusicGen (local)', subType: 'music', apiName: null, costCents: null },
  { id: 'stable-audio', label: 'Stable Audio (FAL)', subType: 'music', apiName: 'falMusic', costCents: 5 },
  // ElevenLabs Music ~$0.80/min → ~40c for a 30s default clip. Clean broad-commercial licensing.
  // Own apiName 'elevenLabsMusic' (NOT 'elevenLabs') so spend/caps/toggle are billed at the music
  // rate and independent of TTS/SFX — the gate keys cost on apiName via estimateApiCostUsd.
  { id: 'elevenlabs-music', label: 'ElevenLabs Music', subType: 'music', apiName: 'elevenLabsMusic', costCents: 40 },
  // Google Lyria (Gemini API, reuses GOOGLE_AI_KEY). Own apiName 'googleLyria' so spend/caps are
  // billed at the music rate, independent of Veo/Imagen/TTS under the same Google key.
  { id: 'lyria', label: 'Google Lyria', subType: 'music', apiName: 'googleLyria', costCents: 8 },
]

/** All audio models of a sub-type, in declared order (used to populate the model pill). */
export function audioModelsForSubType(subType: AudioSubType): AudioModelOption[] {
  return AUDIO_MODELS.filter((m) => m.subType === subType)
}

/** Look up a single audio model by provider id (used by the gate to resolve `apiName`). */
export function audioModel(id: string): AudioModelOption | undefined {
  return AUDIO_MODELS.find((m) => m.id === id)
}

/** The default (first-declared) provider id for a sub-type. */
export function defaultAudioModelId(subType: AudioSubType): string {
  return audioModelsForSubType(subType)[0]?.id ?? ''
}

/**
 * Complete TTS-provider → gate APIName map (the gate's source of truth, NOT just the composer's
 * pill set). `AUDIO_MODELS` only lists the composer-facing TTS providers; but the gate must price
 * EVERY provider `synthesizeTTS` can resolve to — including ones `getBestTTSProvider` auto-selects
 * (e.g. when the caller passes no provider / 'auto'). A provider ABSENT from this map is FREE
 * (browser/local: web-speech, puter, native-tts, openai-edge-tts, pocket-tts, voxcpm) → gate
 * skipped. A provider PRESENT here is PAID → gated against its APIName. This is what stops the
 * "auto resolves to a paid provider but apiName was null → ungated" bypass.
 */
const TTS_PROVIDER_API: Record<string, APIName> = {
  elevenlabs: 'elevenLabs',
  'openai-tts': 'openaiTts',
  'gemini-tts': 'geminiTts',
  'google-tts': 'googleTts',
}

/** Gate APIName for a TTS provider id. `null` = a free/local provider (skip the gate). */
export function ttsApiNameFor(provider: string): APIName | null {
  return TTS_PROVIDER_API[provider] ?? null
}
