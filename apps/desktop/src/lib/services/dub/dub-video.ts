// Video dubbing orchestration (Tier 3). Chains the stages that already exist in the app into one
// pipeline: extract audio → transcribe (Whisper SRT) → translate per cue → TTS per cue (preset or a
// cloned Cast voice) → time-fit each cue to its source window → assemble one dubbed track → relip
// the source video to it. The heavy deps (ffmpeg, Whisper, the LLM, TTS, the fal relip) are injected
// so this stays a pure, unit-testable orchestrator; the real deps wire in main-side (Electron).

import { parseSrt, type DubSegment } from './srt'
import { planSegmentTiming, totalDriftMs, type SegmentTimingPlan } from './timing'

export class DubError extends Error {}

export interface DubVideoInput {
  projectId: string
  /** The source video to dub (local /uploads path, data: URL, or http(s)). */
  sourceVideoUrl: string
  /** Target language to dub INTO (provider-specific code or name, e.g. 'es' / 'Spanish'). */
  targetLanguage: string
  /** Optional source-language hint; otherwise Whisper auto-detects. */
  sourceLanguage?: string
  /** Optional cloned voice (clonedVoices.providerVoiceId) to dub in the original speaker's voice. */
  voiceId?: string
  /** TTS provider; defaults to the multilingual default chosen by the synth dep. */
  ttsProvider?: string
}

/** One synthesized cue + its timing plan, ready to place on the dubbed track. */
export interface DubClip {
  audioUrl: string
  startMs: number
  atempo: number
  padMsAfter: number
}

export interface DubVideoDeps {
  /** Extract the source video's audio to a Whisper-readable ref (ffmpeg, main-side). */
  extractAudio: (videoRef: string) => Promise<string>
  /** Transcribe audio → SRT (+ detected language). Whisper via the caption-transcriber seam. */
  transcribe: (audioRef: string, opts?: { language?: string }) => Promise<{ srt: string; language?: string }>
  /** Translate each cue's text into the target language (LLM). Returns one string per input, in order. */
  translateSegments: (texts: string[], targetLanguage: string, sourceLanguage?: string) => Promise<string[]>
  /** Synthesize one cue → audio + its real duration (ms). voiceId clones the speaker when present. */
  synthesize: (
    text: string,
    opts: { voiceId?: string; provider?: string; language: string },
  ) => Promise<{ audioUrl: string; durationMs: number }>
  /** Lay the per-cue clips on a timeline (atempo + trailing pad, each at startMs) → one audio file. */
  assembleAudio: (clips: DubClip[]) => Promise<string>
  /** Relip the source video to the dubbed audio track (fal MuseTalk/Fabric source_video_url+audio). */
  relip: (sourceVideoUrl: string, audioUrl: string) => Promise<{ videoUrl: string }>
}

export interface DubVideoResult {
  videoUrl: string
  /** Whisper-detected source language (when not overridden). */
  detectedLanguage?: string
  segmentCount: number
  /** Accumulated sync drift (ms) from cues whose translation was too long to fit even sped-up. 0 = perfect. */
  driftMs: number
}

export async function dubVideo(input: DubVideoInput, deps: DubVideoDeps): Promise<DubVideoResult> {
  if (!input.projectId) throw new DubError('projectId is required')
  if (!input.sourceVideoUrl) throw new DubError('A source video is required to dub')
  if (!input.targetLanguage) throw new DubError('A target language is required')

  // 1. Source audio → 2. transcript (SRT) → timed cues.
  const audioRef = await deps.extractAudio(input.sourceVideoUrl)
  const { srt, language } = await deps.transcribe(audioRef, { language: input.sourceLanguage })
  const segments: DubSegment[] = parseSrt(srt)
  if (segments.length === 0) throw new DubError('No speech was found in the source video to dub.')

  // 3. Translate every cue in one batch (preserves order; lets the LLM keep cross-cue coherence).
  const translations = await deps.translateSegments(
    segments.map((s) => s.text),
    input.targetLanguage,
    language ?? input.sourceLanguage,
  )
  if (translations.length !== segments.length) {
    throw new DubError(
      `Translation returned ${translations.length} lines for ${segments.length} cues — refusing to dub with misaligned timing.`,
    )
  }

  // 4. TTS each translated cue, then time-fit it to its source window (segment-level sync).
  const clips: DubClip[] = []
  const plans: SegmentTimingPlan[] = []
  const windows: number[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const text = translations[i]?.trim()
    const windowMs = seg.endMs - seg.startMs
    windows.push(windowMs)
    if (!text) {
      // Empty translation (e.g. a cue that's just music) → hold silence for the window, no TTS spend.
      plans.push({ atempo: 1, padMsAfter: windowMs, overflows: false, resultMs: windowMs })
      continue
    }
    const tts = await deps.synthesize(text, {
      voiceId: input.voiceId,
      provider: input.ttsProvider,
      language: input.targetLanguage,
    })
    const plan = planSegmentTiming(windowMs, tts.durationMs)
    plans.push(plan)
    clips.push({ audioUrl: tts.audioUrl, startMs: seg.startMs, atempo: plan.atempo, padMsAfter: plan.padMsAfter })
  }

  // 5. Assemble the dubbed track → 6. relip the source video to it.
  const dubbedAudio = await deps.assembleAudio(clips)
  const { videoUrl } = await deps.relip(input.sourceVideoUrl, dubbedAudio)

  return {
    videoUrl,
    detectedLanguage: language,
    segmentCount: segments.length,
    driftMs: totalDriftMs(windows, plans),
  }
}
