// ── TTS provider profiles for the generic selector ──────────────────────────
//
// Static quality/cost/reliability ratings per TTS provider. Consumed by
// `selectBestProvider()` to produce a ranked pick with a "why we chose X"
// reason string. Numbers are calibrated within the TTS category — a 90 here
// means "top-tier in this list," not an absolute benchmark.

import { API_COST_SCALARS } from '../permissions'
import type { TTSProvider } from '../types'
import type { ProviderProfile, SelectionContext } from './selector'

const hasEnv = (ctx: SelectionContext, key: string): boolean => {
  const env = ctx.env ?? (typeof process !== 'undefined' ? process.env : {})
  return !!env?.[key]
}

const isPlatform = (ctx: SelectionContext, platform: string): boolean => {
  const p = ctx.platform ?? (typeof process !== 'undefined' ? process.platform : '')
  return p === platform
}

const ttsCost =
  (api: 'elevenLabs' | 'openaiTts' | 'geminiTts' | 'googleTts') =>
  (ctx: SelectionContext): number => {
    const len = ctx.textLength ?? 0
    const scalar = API_COST_SCALARS[api]
    if (!scalar) return 0
    if (scalar.per1KChars && len > 0) {
      return Math.max(scalar.perCall, (scalar.per1KChars * len) / 1000)
    }
    return scalar.perCall
  }

export const TTS_PROFILES: ProviderProfile<TTSProvider>[] = [
  {
    id: 'elevenlabs',
    category: 'tts',
    name: 'ElevenLabs',
    quality: 95,
    reliability: 90,
    latency: 70,
    control: 85,
    available: (ctx) => hasEnv(ctx, 'ELEVENLABS_API_KEY'),
    costUsd: ttsCost('elevenLabs'),
    taskFit: (ctx) => (ctx.task === 'narration' || ctx.task === 'voiceover' ? 90 : 75),
    reasonHint: 'ElevenLabs (best voice quality, aligned captions)',
  },
  {
    id: 'openai-tts',
    category: 'tts',
    name: 'OpenAI TTS',
    quality: 80,
    reliability: 92,
    latency: 80,
    control: 70,
    available: (ctx) => hasEnv(ctx, 'OPENAI_API_KEY'),
    costUsd: ttsCost('openaiTts'),
    taskFit: () => 70,
    reasonHint: 'OpenAI TTS (fast, reliable, instruction-aware)',
  },
  {
    id: 'gemini-tts',
    category: 'tts',
    name: 'Gemini TTS',
    quality: 78,
    reliability: 85,
    latency: 75,
    control: 65,
    available: (ctx) => hasEnv(ctx, 'GEMINI_API_KEY'),
    costUsd: ttsCost('geminiTts'),
    taskFit: () => 65,
    reasonHint: 'Gemini TTS',
  },
  {
    id: 'google-tts',
    category: 'tts',
    name: 'Google Cloud TTS',
    quality: 72,
    reliability: 95,
    latency: 85,
    control: 60,
    available: (ctx) => hasEnv(ctx, 'GOOGLE_TTS_API_KEY'),
    costUsd: ttsCost('googleTts'),
    taskFit: () => 60,
    reasonHint: 'Google Cloud TTS',
  },
  {
    id: 'voxcpm',
    category: 'tts',
    name: 'VoxCPM2 (Local GPU)',
    quality: 70,
    reliability: 60,
    latency: 60,
    control: 70,
    available: (ctx) => hasEnv(ctx, 'VOXCPM_URL'),
    costUsd: () => 0,
    taskFit: () => 55,
    reasonHint: 'VoxCPM2 local GPU (free)',
  },
  {
    id: 'pocket-tts',
    category: 'tts',
    name: 'Pocket TTS (Local)',
    quality: 60,
    reliability: 70,
    latency: 70,
    control: 55,
    available: (ctx) => hasEnv(ctx, 'POCKET_TTS_URL'),
    costUsd: () => 0,
    taskFit: () => 55,
    reasonHint: 'Pocket TTS local (free)',
  },
  {
    id: 'openai-edge-tts',
    category: 'tts',
    name: 'Edge TTS (Local)',
    quality: 58,
    reliability: 75,
    latency: 78,
    control: 45,
    available: (ctx) => hasEnv(ctx, 'EDGE_TTS_URL'),
    costUsd: () => 0,
    taskFit: () => 55,
    reasonHint: 'Edge TTS local (free)',
  },
  {
    id: 'native-tts',
    category: 'tts',
    name: 'System Voice',
    quality: 50,
    reliability: 95,
    latency: 95,
    control: 35,
    available: (ctx) => isPlatform(ctx, 'darwin') || isPlatform(ctx, 'win32'),
    costUsd: () => 0,
    taskFit: () => 40,
    reasonHint: 'System voice (free, instant)',
  },
  {
    id: 'puter',
    category: 'tts',
    name: 'Puter.js (Browser)',
    quality: 45,
    reliability: 70,
    latency: 60,
    control: 30,
    available: () => true,
    costUsd: () => 0,
    taskFit: () => 35,
    reasonHint: 'Puter browser TTS (free, preview only)',
    clientOnly: true,
  },
  {
    id: 'web-speech',
    category: 'tts',
    name: 'Web Speech (Browser)',
    quality: 35,
    reliability: 60,
    latency: 95,
    control: 25,
    available: () => true,
    costUsd: () => 0,
    taskFit: () => 30,
    reasonHint: 'Web Speech API (free, browser only)',
    clientOnly: true,
  },
]
