/**
 * Desktop dub runtime (Electron main). Composes the full DubVideoDeps for the dubbing pipeline and
 * registers it via setDubRuntime() so the `dub_video` agent tool becomes available + executable.
 *
 * Most deps are thin wrappers over existing, tested subsystems (Whisper transcriber, synthesizeTTS,
 * the MuseTalk relip provider, the streaming ProviderAdapter). The two ffmpeg helpers (extractAudio,
 * assembleAudio) spawn the bundled ffmpeg, following src/electron/audio-decode.ts.
 *
 * LAUNCH-VERIFY HOTSPOTS (cannot be exercised headless — verify in the app with a real presenter
 * clip + OPENAI_API_KEY/FAL_KEY/an Anthropic key):
 *   1. assembleAudio's ffmpeg `filter_complex` (adelay+atempo+amix timeline placement).
 *   2. the translate `complete()` streaming-collection loop over the adapter.
 */

import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveFfmpegPath } from './audio-decode'
import { createWhisperApiTranscriber } from './whisper-transcriber'
import { setDubRuntime } from '@/lib/services/dub/run-dub'
import { translateSegments } from '@/lib/services/dub/translate'
import type { DubVideoDeps, DubClip } from '@/lib/services/dub/dub-video'

// ── ffmpeg helpers ───────────────────────────────────────────────────────────
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), ['-hide_banner', '-loglevel', 'error', ...args])
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += String(d)))
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
    )
  })
}

async function tmpFile(suffix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dreambyte-dub-'))
  return join(dir, `f${suffix}`)
}

/** Extract the source video's speech track to a Whisper-friendly mono 16k wav (local file; Whisper
 *  here doesn't accept http sources). */
async function extractAudio(videoRef: string): Promise<string> {
  const out = await tmpFile('.wav')
  await runFfmpeg(['-y', '-i', videoRef, '-vn', '-ac', '1', '-ar', '16000', out])
  return out
}

/**
 * Lay each dubbed cue on a single timeline track. For input i: speed it (atempo) then delay it to its
 * cue start (adelay, ms), then sum all delayed clips (amix, normalize off so levels are preserved and
 * non-overlapping cues don't duck). The result is one audio file matching the source pacing.
 * HOTSPOT: verify the filter graph + level behavior on a real multi-cue clip.
 */
async function assembleAudio(clips: DubClip[]): Promise<string> {
  const out = await tmpFile('.mp3')
  if (clips.length === 0) {
    // No speech cues → emit a short silence so the relip step still has an audio track.
    await runFfmpeg(['-y', '-f', 'lavfi', '-t', '1', '-i', 'anullsrc=r=44100:cl=mono', out])
    return out
  }
  const inputs: string[] = []
  const filters: string[] = []
  clips.forEach((clip, i) => {
    inputs.push('-i', clip.audioUrl)
    const atempo = clip.atempo && clip.atempo > 0 ? clip.atempo : 1
    const startMs = Math.max(0, Math.round(clip.startMs))
    // atempo only valid in [0.5,2]; our planner clamps to [0.8,1.3] so a single stage is safe.
    filters.push(`[${i}:a]atempo=${atempo.toFixed(4)},adelay=${startMs}:all=1[a${i}]`)
  })
  const mixLabels = clips.map((_, i) => `[a${i}]`).join('')
  const filterComplex = `${filters.join(';')};${mixLabels}amix=inputs=${clips.length}:normalize=0[out]`
  await runFfmpeg([...inputs, '-y', '-filter_complex', filterComplex, '-map', '[out]', out])
  return out
}

// ── transcribe (existing Whisper seam) ───────────────────────────────────────
const whisper = createWhisperApiTranscriber()
async function transcribe(audioRef: string, opts?: { language?: string }): Promise<{ srt: string; language?: string }> {
  const { srt, language } = await whisper.transcribe(audioRef, { language: opts?.language })
  return { srt, language }
}

// ── translate (one-shot over the streaming ProviderAdapter) ──────────────────
// HOTSPOT: the streaming collection loop. Uses the default utility model + its registered adapter.
async function completeText(prompt: string): Promise<string> {
  const { DEFAULT_MODELS } = await import('@/lib/agents/model-config')
  const { getAdapter } = await import('@/lib/agents/providers/adapter')
  await import('@/lib/agents/providers') // ensure adapters are registered (side-effecting index)
  const cfg = DEFAULT_MODELS[0]
  const adapter = getAdapter(cfg.provider)
  if (!adapter) throw new Error(`No model adapter registered for ${cfg.provider} — cannot translate.`)
  let text = ''
  for await (const ev of adapter.streamChat({
    model: cfg.modelId,
    systemPrompt: 'You are a precise translation engine. Follow the formatting rules exactly.',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 4096,
  })) {
    if (ev.type === 'text_delta') text += ev.text
  }
  return text
}

// ── synthesize (existing TTS) ────────────────────────────────────────────────
async function synthesize(
  text: string,
  opts: { voiceId?: string; provider?: string; language: string },
): Promise<{ audioUrl: string; durationMs: number }> {
  const { synthesizeTTS } = await import('@/lib/services/audio')
  const result = await synthesizeTTS({
    text,
    sceneId: 'dub',
    voiceId: opts.voiceId,
    provider: opts.provider as never,
  })
  if ('mode' in result) {
    throw new Error('Dubbing needs a server-side TTS provider (client-only voice cannot produce a file).')
  }
  // duration is in seconds; estimate from word count if the provider didn't return it.
  const durationSec = result.duration ?? Math.max(1, text.split(/\s+/).length / 2.5)
  return { audioUrl: result.url, durationMs: Math.round(durationSec * 1000) }
}

// ── relip (MuseTalk: source video + dubbed audio → relipped video) ───────────
async function relip(sourceVideoUrl: string, audioUrl: string): Promise<{ videoUrl: string }> {
  const { museTalkProvider } = await import('@/lib/avatar/providers/musetalk')
  const result = await museTalkProvider.generate(
    // MuseTalk treats sourceImageUrl AS source_video_url (see musetalk.ts).
    { sourceImageUrl: sourceVideoUrl, audioUrl, durationSeconds: 0, projectId: '' } as never,
    {},
  )
  return { videoUrl: result.videoUrl }
}

const dubRuntimeDeps: DubVideoDeps = {
  extractAudio,
  transcribe,
  translateSegments: (texts, targetLanguage, sourceLanguage) =>
    translateSegments(texts, targetLanguage, sourceLanguage, { complete: completeText }),
  synthesize,
  assembleAudio,
  relip,
}

/** Register the dub runtime so isDubRuntimeReady() → true and the dub_video tool activates. Call once
 *  from main startup. Best-effort temp-file cleanup is left to the OS tmpdir. */
export function registerDubRuntime(): void {
  setDubRuntime(dubRuntimeDeps)
}
