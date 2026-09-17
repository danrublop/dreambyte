/**
 * Audio intake engine.
 *   - `local:whisper` / `cloud:whisper` → the existing `CaptionTranscriber`
 *     seam (Whisper API today; whisper.cpp opt-in later). Yields a transcript
 *     and a coarse timeline from the SRT cues.
 *   - `cloud:gemini` → one `generateContent` call that returns transcript AND
 *     sound/music understanding (mood, tags) in a single pass.
 *
 * Never throws — degrades to `{ error }`.
 */

import type { MediaAnalysis, ReferenceMedia } from '../../types'
import { resolveMedia } from './media-source'

const AUDIO_INLINE_CAP_BYTES = 18 * 1024 * 1024 // Gemini inline request ~20MB; stay under.

/** Parse an SRT body into plain transcript text + cue events. */
export function srtToTranscript(srt: string): {
  transcript: string
  events: { start: number; end: number; description: string }[]
} {
  const events: { start: number; end: number; description: string }[] = []
  const lines: string[] = []
  const blocks = srt.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const rows = block.split(/\r?\n/).filter((r) => r.trim().length > 0)
    if (rows.length === 0) continue
    // Drop a leading numeric index.
    let i = 0
    if (/^\d+$/.test(rows[0].trim())) i = 1
    const timeRow = rows[i]
    const m = timeRow?.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/)
    const text = rows
      .slice(m ? i + 1 : i)
      .join(' ')
      .trim()
    if (!text) continue
    lines.push(text)
    if (m) {
      const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
      const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000
      events.push({ start, end, description: text })
    }
  }
  return { transcript: lines.join(' ').trim(), events }
}

const AUDIO_PROMPT = `You are helping a video creator understand a reference audio clip.
Return ONLY a JSON object, no prose, with exactly these fields:
{
  "transcript": "<spoken words, verbatim; empty string if none>",
  "summary": "<one sentence describing the audio content>",
  "mood": "<short phrase: emotional tone / energy>",
  "tags": ["music", "speech", "ambient", "..."]
}`

async function analyzeViaTranscriber(media: ReferenceMedia, backend: string): Promise<MediaAnalysis> {
  const { getCaptionTranscriber } = await import('../../../edit-engines/caption-transcriber')
  const { srt } = await getCaptionTranscriber().transcribe(media.uri)
  const { transcript, events } = srtToTranscript(srt)
  return {
    mediaId: media.id,
    kind: 'audio',
    backend,
    transcript: transcript || undefined,
    events: events.length ? events : undefined,
  }
}

async function analyzeViaGemini(media: ReferenceMedia): Promise<MediaAnalysis> {
  const { bytes, mimeType } = await resolveMedia(media.uri, media.mimeType)
  if (bytes.byteLength > AUDIO_INLINE_CAP_BYTES) {
    // Gemini audio is inline-only here; large files fall back to the Whisper
    // transcriber. Report the real backend so cost estimation + modelsUsed stay
    // accurate (the size fallback is a log detail, not a backend identity).
    return analyzeViaTranscriber(media, 'cloud:whisper')
  }
  const base64 = Buffer.from(bytes).toString('base64')
  const { getGoogleClient } = await import('../../providers')
  const client = getGoogleClient()
  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ inlineData: { mimeType, data: base64 } }, { text: AUDIO_PROMPT }] as never,
  })
  const text = (response as { text?: string }).text ?? ''
  const fenced = text.replace(/```(?:json)?/gi, '').trim()
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  let parsed: { transcript?: string; summary?: string; mood?: string; tags?: string[] } | null = null
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(fenced.slice(start, end + 1))
    } catch {
      parsed = null
    }
  }
  if (!parsed) return { mediaId: media.id, kind: 'audio', backend: 'cloud:gemini', error: 'no parseable result' }
  return {
    mediaId: media.id,
    kind: 'audio',
    backend: 'cloud:gemini',
    transcript: parsed.transcript?.trim() || undefined,
    caption: parsed.summary?.trim() || undefined,
    mood: parsed.mood?.trim() || undefined,
    audioTags: parsed.tags?.filter(Boolean).map((label) => ({ label, score: 1 })) || undefined,
  }
}

export async function analyzeAudio(media: ReferenceMedia, engineId: string): Promise<MediaAnalysis> {
  try {
    if (engineId === 'cloud:gemini') return await analyzeViaGemini(media)
    if (engineId === 'local:whisper' || engineId === 'cloud:whisper') {
      return await analyzeViaTranscriber(media, engineId)
    }
    return { mediaId: media.id, kind: 'audio', backend: engineId, error: `unknown audio engine ${engineId}` }
  } catch (err) {
    return {
      mediaId: media.id,
      kind: 'audio',
      backend: engineId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
