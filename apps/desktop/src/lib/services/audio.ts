/**
 * Audio services: TTS, SFX, and music search.
 *
 * Callers: agent tool handlers and Electron IPC.
 *
 * URL shapes returned here follow `src/lib/audio/paths.ts` conventions —
 * either `/audio/<filename>` in dev or `dreambyte://audio/<filename>` in
 * packaged Electron. The renderer stores whichever it gets and hands
 * it to `<audio>` / `<video>` tags.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { TTSProvider, SFXProvider, MusicProvider } from '@/lib/types'
import {
  getBestTTSProvider,
  getTTSProvider,
  getBestSFXProvider,
  getSFXProvider,
  getBestMusicProvider,
  getMusicProvider,
} from '@/lib/audio/router'
import { downloadToLocal } from '@/lib/audio/download'
import { createLogger } from '@/lib/logger'

const log = createLogger('audio')
import { validateTextLength, validateQueryLength, MAX_TTS_TEXT_LENGTH } from '@/lib/audio/sanitize'
import { buildNaiveCaptions } from '@/lib/audio/captions'
import { getZzfxCategory, SFX_LIBRARY_CATEGORIES } from '@/lib/audio/sfx-zzfx-presets'
import { FREESOUND_LICENSE_NOTE, PIXABAY_SFX_LICENSE_NOTE } from '@/lib/audio/sfx-license'
import { getAudioDir, audioUrlFor, isLocalAudioUrl } from '@/lib/audio/paths'
import { sanitizeErrorMessage } from '@/lib/audio/sanitize'

// ── Service errors ─────────────────────────────────────────────────────────
// Plain Error subclasses so callers can distinguish user-input validation
// from server failures. HTTP wrappers map these to 400/500; IPC passes the
// message through unchanged.

export class AudioValidationError extends Error {
  readonly code = 'VALIDATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'AudioValidationError'
  }
}

// ── TTS ────────────────────────────────────────────────────────────────────

export interface TTSInput {
  text: string
  sceneId: string
  voiceId?: string
  provider?: TTSProvider
  model?: string
  instructions?: string
  localMode?: boolean
}

export type TTSResult =
  | {
      mode: 'client'
      provider: TTSProvider
      text: string
      voiceId: string | null
    }
  | {
      url: string
      duration?: number | null
      provider: TTSProvider
      captions: {
        srtUrl: string
        vttUrl: string
        kind: string
        words: unknown[]
      } | null
    }

const SCENE_ID_RE = /^[a-zA-Z0-9\-]+$/

export async function synthesizeTTS(input: TTSInput): Promise<TTSResult> {
  if (!input.text) throw new AudioValidationError('text is required')
  if (!input.sceneId || typeof input.sceneId !== 'string') {
    throw new AudioValidationError('sceneId is required')
  }
  if (!SCENE_ID_RE.test(input.sceneId)) {
    throw new AudioValidationError('Invalid sceneId format')
  }
  try {
    validateTextLength(input.text)
  } catch {
    throw new AudioValidationError(`Text exceeds maximum length of ${MAX_TTS_TEXT_LENGTH} characters`)
  }

  const selectedProvider: TTSProvider = input.provider ?? getBestTTSProvider(null, input.localMode)

  // Client-only providers return config for browser-side synthesis.
  if (selectedProvider === 'web-speech' || selectedProvider === 'puter') {
    return {
      mode: 'client',
      provider: selectedProvider,
      text: input.text,
      voiceId: input.voiceId ?? null,
    }
  }

  const impl = await getTTSProvider(selectedProvider)
  const result = await impl.generate({
    text: input.text,
    sceneId: input.sceneId,
    voiceId: input.voiceId,
    model: input.model,
    instructions: input.instructions,
  })

  // Fallback: if the provider didn't return timestamps but did give us an
  // audio duration, emit naive captions.
  if (!result.captions && result.duration && isLocalAudioUrl(result.audioUrl)) {
    const bundle = buildNaiveCaptions(input.text, result.duration)
    if (bundle.words.length > 0 && bundle.srt.length > 0) {
      try {
        const audioDir = getAudioDir()
        await fs.mkdir(audioDir, { recursive: true })
        const base = result.audioUrl.replace(/^(dreambyte:\/\/audio\/|\/audio\/)/, '').replace(/\.[a-z0-9]+$/i, '')
        const srtName = `${base}.srt`
        const vttName = `${base}.vtt`
        await Promise.all([
          fs.writeFile(path.join(audioDir, srtName), bundle.srt, 'utf8'),
          fs.writeFile(path.join(audioDir, vttName), bundle.vtt, 'utf8'),
        ])
        result.captions = {
          srtUrl: audioUrlFor(srtName),
          vttUrl: audioUrlFor(vttName),
          kind: 'naive',
          words: bundle.words,
        }
      } catch (captionErr) {
        log.warn('naive caption write failed', { error: captionErr })
      }
    }
  }

  return {
    url: result.audioUrl,
    duration: result.duration,
    provider: result.provider,
    captions: result.captions
      ? {
          srtUrl: result.captions.srtUrl,
          vttUrl: result.captions.vttUrl,
          kind: result.captions.kind,
          words: result.captions.words,
        }
      : null,
  }
}

// ── SFX ────────────────────────────────────────────────────────────────────

export interface SFXInput {
  query?: string
  prompt?: string
  provider?: SFXProvider
  limit?: number
  duration?: number
  download?: boolean
  mode?: 'search' | 'library' | 'generated'
  categoryId?: string
  page?: number
  commercialOnly?: boolean
}

export async function searchSFX(input: SFXInput): Promise<{
  results: unknown[]
  provider: SFXProvider
  mode: 'search' | 'library' | 'generated'
  category?: { id: string; label: string }
  page?: number
  licenseNote?: string
}> {
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50)
  const page = Math.max(1, Number(input.page) || 1)
  const isLibrary = input.mode === 'library'

  if (isLibrary) {
    const cat = getZzfxCategory(input.categoryId)
    const category = cat
      ? { id: cat.id, label: cat.label }
      : { id: SFX_LIBRARY_CATEGORIES[0]!.id, label: SFX_LIBRARY_CATEGORIES[0]!.label }
    return {
      results: [],
      provider: 'pixabay' as SFXProvider,
      mode: 'library',
      category,
      page,
      licenseNote:
        'The editor Sound effects library uses ZzFX (MIT) in the browser. Use search mode for remote Pixabay/Freesound when API keys are configured.',
    }
  }

  const searchQuery = input.query || input.prompt
  if (!searchQuery) throw new AudioValidationError('query or prompt is required')

  try {
    if (input.query) validateQueryLength(input.query)
    if (input.prompt) validateQueryLength(input.prompt)
  } catch {
    throw new AudioValidationError('Query or prompt too long')
  }

  const providerId: SFXProvider = input.provider ?? getBestSFXProvider()
  const impl = await getSFXProvider(providerId)

  if (input.prompt && impl.generate) {
    const result = await impl.generate(input.prompt, input.duration)
    return { results: [result], provider: providerId, mode: 'generated' }
  }

  const commercialOnly =
    input.commercialOnly !== undefined ? Boolean(input.commercialOnly) : providerId === 'freesound' ? true : false
  const searchOpts =
    commercialOnly || page > 1
      ? { page, commercialOnly: providerId === 'freesound' ? commercialOnly : false }
      : undefined
  const results = await impl.search(searchQuery, limit, searchOpts)

  if (input.download && results.length > 0) {
    const localResults = await Promise.all(
      results.map(async (r) => {
        if (r.audioUrl.startsWith('http')) {
          const localUrl = await downloadToLocal(r.audioUrl, 'sfx')
          return { ...r, audioUrl: localUrl, previewUrl: r.previewUrl || r.audioUrl }
        }
        return r
      }),
    )
    return { results: localResults, provider: providerId, mode: 'search' }
  }

  return {
    results,
    provider: providerId,
    mode: 'search',
    licenseNote: providerId === 'pixabay' ? PIXABAY_SFX_LICENSE_NOTE : FREESOUND_LICENSE_NOTE,
  }
}

// ── Music search ───────────────────────────────────────────────────────────

export interface MusicSearchInput {
  query: string
  provider?: MusicProvider
  limit?: number
  download?: boolean
}

export async function searchMusic(input: MusicSearchInput): Promise<{
  results: unknown[]
  provider: MusicProvider
}> {
  if (!input.query) throw new AudioValidationError('query is required')
  try {
    validateQueryLength(input.query)
  } catch {
    throw new AudioValidationError('Query too long')
  }

  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50)
  const providerId: MusicProvider = input.provider ?? getBestMusicProvider()
  const impl = await getMusicProvider(providerId)
  const results = await impl.search(input.query, limit)

  if (input.download && results.length > 0) {
    const localResults = await Promise.all(
      results.map(async (r) => {
        if (r.audioUrl.startsWith('http')) {
          const localUrl = await downloadToLocal(r.audioUrl, 'music')
          return { ...r, audioUrl: localUrl, previewUrl: r.previewUrl || r.audioUrl }
        }
        return r
      }),
    )
    return { results: localResults, provider: providerId }
  }

  return { results, provider: providerId }
}

// ── Music generation ─────────────────────────────────────────────────────────

export interface MusicGenInput {
  prompt: string
  provider?: MusicProvider
  duration?: number
}

export async function generateMusic(input: MusicGenInput): Promise<{
  result: unknown
  provider: MusicProvider
}> {
  if (!input.prompt) throw new AudioValidationError('prompt is required')
  try {
    validateQueryLength(input.prompt)
  } catch {
    throw new AudioValidationError('Prompt too long')
  }

  const providerId: MusicProvider = input.provider ?? 'stable-audio'
  const impl = await getMusicProvider(providerId)
  if (!impl.generate) {
    throw new AudioValidationError(`Music provider "${providerId}" does not support generation`)
  }

  const result = await impl.generate(input.prompt, input.duration)
  return { result, provider: providerId }
}

// ── TTS voice directory ────────────────────────────────────────────────────

const voiceCache = new Map<string, { voices: unknown[]; timestamp: number }>()
const VOICE_CACHE_TTL = 60 * 60 * 1000 // 1 hour

export interface ListVoicesResult {
  voices: unknown[]
  provider: TTSProvider
}

export async function listVoices(provider: TTSProvider): Promise<ListVoicesResult> {
  if (!provider) throw new AudioValidationError('provider is required')

  const cached = voiceCache.get(provider)
  if (cached && Date.now() - cached.timestamp < VOICE_CACHE_TTL) {
    return { voices: cached.voices, provider }
  }

  const impl = await getTTSProvider(provider)
  if (!impl.listVoices) return { voices: [], provider }

  const voices = await impl.listVoices()
  voiceCache.set(provider, { voices, timestamp: Date.now() })
  return { voices, provider }
}

// ── TTS voice design (VoxCPM) ──────────────────────────────────────────────

export interface DesignVoiceInput {
  description: string
  sampleText?: string
}

export interface DesignVoiceResult {
  voiceId: string
  name: string
  previewUrl: string | null
  provider: 'voxcpm'
}

export async function designVoice(input: DesignVoiceInput): Promise<DesignVoiceResult> {
  if (!input.description || typeof input.description !== 'string') {
    throw new AudioValidationError('description is required')
  }
  if (input.description.length > 500) {
    throw new AudioValidationError('description must be under 500 characters')
  }

  const impl = await getTTSProvider('voxcpm')
  if (!impl.designVoice) {
    throw new AudioValidationError('VoxCPM provider does not support voice design')
  }

  try {
    const result = await impl.designVoice({
      description: input.description,
      sampleText: input.sampleText || undefined,
    })
    return {
      voiceId: result.voiceId,
      name: result.name,
      previewUrl: result.previewUrl ?? null,
      provider: 'voxcpm',
    }
  } catch (err) {
    // sanitizeErrorMessage expects an Error, not a string. Passing err.message
    // would always hit the non-Error branch
    // and returned the generic fallback. Pass `err` so the real message is
    // sanitized and surfaced.
    const message = sanitizeErrorMessage(err)
    throw new Error(message === 'Audio operation failed' ? 'Voice design failed' : message, { cause: err })
  }
}
