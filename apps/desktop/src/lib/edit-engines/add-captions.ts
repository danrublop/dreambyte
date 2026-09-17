/**
 * add_captions orchestrator.
 *
 * Sequence:
 *   1. transcribe via the configured transcriber → raw SRT
 *   2. parseSRT → typed cues
 *   3. captionsToActions → ordered ActionInput plan
 *
 * Pure once a synthetic transcriber is configured. The agent tool branch
 * and a future Inspector button both call into this single entry point.
 */

import type { Clip } from '@/lib/types'
import type { CaptionsPlan } from './caption-actions'
import { captionsToActions } from './caption-actions'
import { parseSRT, type SrtCue } from './srt'
import { getCaptionTranscriber, type TranscribeOptions } from './caption-transcriber'

export interface AddCaptionsArgs {
  /** The clip the captions belong to. */
  clip: Clip
  /** Source URI the transcriber understands. */
  sourceUri: string
  /** Optional explicit subtitles track id (otherwise a new text track is created). */
  subtitlesTrackId?: string
  /** Whisper / local-STT options. */
  transcribeOptions?: TranscribeOptions
  /** ID factory override. */
  newId?: () => string
}

export interface AddCaptionsResult {
  plan: CaptionsPlan
  cues: SrtCue[]
  /** Language reported by the transcriber, if any. */
  language?: string
}

export async function addCaptionsForClip(args: AddCaptionsArgs): Promise<AddCaptionsResult> {
  const transcriber = getCaptionTranscriber()
  const transcription = await transcriber.transcribe(args.sourceUri, args.transcribeOptions)
  const cues = parseSRT(transcription.srt)
  const plan = captionsToActions({
    parentClip: args.clip,
    cues,
    subtitlesTrackId: args.subtitlesTrackId,
    newId: args.newId,
  })
  return { plan, cues, language: transcription.language }
}
