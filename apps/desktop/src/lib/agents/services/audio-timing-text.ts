/**
 * Audio-timing text.
 *
 * When no native-video engine is available, motion review degrades to sampled
 * still frames — which carry no audio. To still attempt an audio↔video sync
 * check on that degraded path, we thread the scene's narration + SFX timing into
 * the prompt AS TEXT: where words land, where sound effects trigger. The model
 * then reasons about whether the on-screen action it sees in the frames lines up
 * with the audio beats described here.
 *
 * Pure + structural: reads a minimal subset of `Scene` so it's trivially testable
 * and has no Electron/render dependency. The native (Gemini) path does NOT use
 * this — Gemini hears the muxed audio track directly.
 */

import type { Scene } from '../../types/scene'
import { sanitizeForPrompt } from './cut-review'

/** The minimal slice of a Scene this helper reads. A real `Scene` satisfies it. */
export type AudioTimingScene = Pick<Scene, 'duration'> & {
  audioLayer?: Pick<Scene['audioLayer'], 'tts' | 'sfx'> | null
}

/** Cap how many SFX rows we list so a scene with hundreds of cues can't blow the prompt. */
const MAX_SFX_ROWS = 20

/**
 * Build a compact, model-readable description of the scene's audio timing, or ''
 * when the scene has no narration and no SFX (nothing to sync against). Text is
 * sanitized (it's model/user-authored) before interpolation.
 */
export function buildAudioTimingText(scene: AudioTimingScene): string {
  const lines: string[] = []
  const tts = scene.audioLayer?.tts ?? null
  const sfx = scene.audioLayer?.sfx ?? []
  const caps = tts?.captions ?? null

  if (caps && caps.words.length > 0) {
    const first = caps.words[0]
    const last = caps.words[caps.words.length - 1]
    const reliability = caps.kind === 'aligned' ? 'aligned to audio' : 'evenly estimated (approximate)'
    lines.push(
      `Narration runs ${first.start.toFixed(1)}s–${last.end.toFixed(1)}s (${caps.words.length} words, ${reliability}):`,
    )
    const text = sanitizeForPrompt(caps.words.map((w) => w.text).join(' '), 400)
    lines.push(`  "${text}"`)
  } else if (tts?.text?.trim()) {
    const dur = tts.duration ?? scene.duration
    lines.push(`Narration (no word-level timings; spans ~0.0s–${dur.toFixed(1)}s):`)
    lines.push(`  "${sanitizeForPrompt(tts.text, 400)}"`)
  }

  if (sfx.length > 0) {
    lines.push('Sound effects (trigger time → name):')
    const sorted = [...sfx].sort((a, b) => a.triggerAt - b.triggerAt)
    for (const s of sorted.slice(0, MAX_SFX_ROWS)) {
      lines.push(`  ${s.triggerAt.toFixed(1)}s — ${sanitizeForPrompt(s.name, 60)}`)
    }
    if (sorted.length > MAX_SFX_ROWS) lines.push(`  …and ${sorted.length - MAX_SFX_ROWS} more`)
  }

  if (lines.length === 0) return ''
  return `Audio timing for this scene (duration ${scene.duration.toFixed(1)}s) — judge whether the on-screen action lands on these audio beats:\n${lines.join('\n')}`
}
