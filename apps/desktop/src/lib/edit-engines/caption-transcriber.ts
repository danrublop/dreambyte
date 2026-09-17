/**
 * Caption transcriber seam.
 *
 * Same shape as `pcm-decoder.ts`: a single active transcriber slot the
 * orchestrator pulls from. Production wires Whisper API (privacy mode
 * "cloud") or whisper.cpp (privacy mode "local") at boot. Tests inject
 * synthetic transcribers via `setCaptionTranscriber`.
 *
 * The caller hands the transcriber a source URI (whatever the underlying
 * impl understands — file path / dreambyte:// uri / asset id) and gets back
 * raw SRT text plus the detected language. We do the SRT parsing
 * downstream so the cue array stays under one definition site.
 */

export interface TranscribeOptions {
  /** Override the source language if known; otherwise auto-detect. */
  language?: string
  /** Hint for domain-specific phrasing (Whisper API `prompt`). */
  prompt?: string
}

/** One word with source-time bounds (seconds). Optional capability — only
 *  transcribers that can produce word timestamps populate it. */
export interface TranscriptWord {
  word: string
  start: number
  end: number
}

export interface TranscriptionResult {
  /** Raw SRT body. */
  srt: string
  /** Language code Whisper / the local impl detected ("en", "es"...). */
  language?: string
  /** Word-level timestamps when the transcriber supports them (Whisper API
   *  verbose_json). Consumers MUST degrade to SRT cues when absent —
   *  local/compat endpoints often can't produce these. */
  words?: TranscriptWord[]
}

export interface CaptionTranscriber {
  transcribe(source: string, options?: TranscribeOptions): Promise<TranscriptionResult>
}

const throwingStub: CaptionTranscriber = {
  async transcribe(source: string) {
    throw new Error(
      `Caption transcriber not configured. Call setCaptionTranscriber(...) before invoking add_captions. (tried to transcribe: ${source})`,
    )
  },
}

let active: CaptionTranscriber = throwingStub

export function setCaptionTranscriber(transcriber: CaptionTranscriber | null): void {
  active = transcriber ?? throwingStub
}

export function getCaptionTranscriber(): CaptionTranscriber {
  return active
}
