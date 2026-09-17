import type { TTSProvider, SFXProvider, MusicProvider } from '../types'

export interface Voice {
  id: string
  name: string
  language: string
  gender?: string
  previewUrl?: string | null
}

export interface TTSCaptions {
  /** Public URL to the SRT file (written alongside the audio). */
  srtUrl: string
  /** Public URL to the VTT file (written alongside the audio). */
  vttUrl: string
  /** `aligned` when the provider returned true word/character timestamps;
   *  `naive` when generated from audio duration + word count as a fallback. */
  kind: 'aligned' | 'naive'
  /** Word-level segments (scene-relative times, in seconds). */
  words: { text: string; start: number; end: number }[]
}

export interface TTSResult {
  audioUrl: string
  duration: number | null
  provider: TTSProvider
  /** Present when captions were emitted. Aligned for providers that return
   *  timestamps (ElevenLabs); naive fallback otherwise. */
  captions?: TTSCaptions
}

export interface TTSParams {
  text: string
  sceneId: string
  voiceId?: string
  model?: string
  instructions?: string
  speakers?: { speaker: string; voiceName: string }[]
}

export interface VoiceCloneParams {
  name: string
  audioBuffer: Buffer
  transcript?: string
  /** VoxCPM clone mode: 'controllable' or 'ultimate' */
  mode?: string
}

export interface VoiceCloneResult {
  voiceId: string
  name: string
}

export interface VoiceDesignParams {
  description: string
  sampleText?: string
}

export interface VoiceDesignResult {
  voiceId: string
  name: string
  previewUrl?: string
}

export interface TTSProviderInterface {
  id: TTSProvider
  name: string
  type: 'server' | 'client'
  requiresKey: string | null
  generate(params: TTSParams): Promise<TTSResult>
  listVoices?(): Promise<Voice[]>
  cloneVoice?(params: VoiceCloneParams): Promise<VoiceCloneResult>
  /** Hard-delete a cloned voiceprint at the provider (right-to-erasure). Tier 3 Cast. */
  deleteVoice?(voiceId: string): Promise<void>
  designVoice?(params: VoiceDesignParams): Promise<VoiceDesignResult>
}

export interface SFXResult {
  id: string
  name: string
  audioUrl: string
  duration: number | null
  provider: SFXProvider
  previewUrl?: string
  /** Raw license URL or name from provider (Freesound); Pixabay uses a fixed license string */
  license?: string
}

export interface SFXSearchOptions {
  /** 1-based page (Pixabay / Freesound) */
  page?: number
  /** For Freesound: only return CC0 / CC BY (commercial-friendly); drops NC and other licenses */
  commercialOnly?: boolean
}

export interface SFXProviderInterface {
  id: SFXProvider
  name: string
  requiresKey: string | null
  search(query: string, limit?: number, options?: SFXSearchOptions): Promise<SFXResult[]>
  generate?(prompt: string, duration?: number): Promise<SFXResult>
}

export interface MusicResult {
  id: string
  name: string
  audioUrl: string
  duration: number | null
  provider: MusicProvider
  previewUrl?: string
}

export interface MusicProviderInterface {
  id: MusicProvider
  name: string
  requiresKey: string | null
  search(query: string, limit?: number): Promise<MusicResult[]>
  /** Generative music providers (e.g. fal Stable Audio) compile a text prompt into a clip.
   *  Search-only providers (Pixabay / Freesound libraries) omit this. */
  generate?(prompt: string, duration?: number): Promise<MusicResult>
}
