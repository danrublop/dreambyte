// @vitest-environment node

/**
 * v5 A2: run the REAL ffmpeg over the exact scene filtergraph
 * buildSceneAudioFilter produces for the export path (sceneMix present,
 * multi-source). A graph that fails to bind silences the WHOLE scene (the
 * tier3 caller catches and logs 'keeping silent scene') — so the new
 * normalize=0 + alimiter chain must be proven against a real binary, and the
 * full-gain mix must measurably out-level the old 1/N mix.
 *
 * Same gating as the other integration tests: the user's installed ffmpeg
 * (packages/render-server/ffmpeg-path.js), skipped when none is found.
 */

import { describe, it, expect } from 'vitest'
import { findFfmpeg } from '@dreambyte/render-server/ffmpeg-path.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Plain-JS module shared with render-server (see audio-filter.test.ts).
import { buildSceneAudioFilter } from '@dreambyte/render-server/audio-filter.js'

// Needs an installed FFmpeg (DREAMBYTE_FFMPEG_PATH, PATH, or Homebrew); skipped when none is found.
const FFMPEG = findFfmpeg()

const run = (args: string[]) =>
  spawnSync(FFMPEG!, ['-hide_banner', '-loglevel', 'info', ...args], { encoding: 'utf8', timeout: 60_000 })

function meanVolumeDb(file: string): number {
  const r = spawnSync(FFMPEG!, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  const m = r.stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)
  expect(m, r.stderr.slice(-500)).toBeTruthy()
  return Number(m![1])
}

/** Bake a 2s scene (blue video) with the given filter result; returns the output path. */
function bake(root: string, name: string, filter: { audioInputPaths: string[]; filterComplex: string }): string {
  const video = path.join(root, 'video.mp4')
  if (!existsSync(video)) {
    const gen = run([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x180:d=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-y',
      video,
    ])
    expect(gen.status, gen.stderr).toBe(0)
  }
  const out = path.join(root, name)
  const args = ['-i', video]
  for (const a of filter.audioInputPaths) args.push('-i', a)
  args.push(
    '-filter_complex',
    filter.filterComplex,
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    out,
  )
  const r = run(args)
  expect(r.status, r.stderr).toBe(0)
  return out
}

describe.skipIf(!FFMPEG)('scene audio filter (export path) against real ffmpeg', () => {
  it('the v5 A2 graph binds, and full-gain summing is louder than the old 1/N mix', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'scenefilter-'))
    try {
      const tts = path.join(root, 'tts.wav')
      const music = path.join(root, 'music.wav')
      expect(run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', tts]).status).toBe(0)
      expect(run(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-y', music]).status).toBe(0)

      // Quiet sources (sum peaks ≈ 0.3) so the 0.97 limiter never engages —
      // this measures the normalize=0 effect itself, not limiter behavior.
      // (Full-scale sines summed to 1.4 get limited back down and the level
      // difference vs 1/N disappears — that's the limiter doing its job.)
      const tracks = {
        tts: { path: tts },
        music: { path: music, volume: 0.1, loop: false, duckDuringTTS: false },
      }
      const quietTts = { trackGain: 0.2, pan: 0, drop: false }
      const unity = { trackGain: 1, pan: 0, drop: false }

      // New export graph: sceneMix present → normalize=0 + alimiter.
      const v5 = buildSceneAudioFilter(tracks, 2, null, { tts: quietTts, music: unity })
      expect(v5!.filterComplex).toContain('normalize=0')
      expect(v5!.filterComplex).toContain('alimiter')
      const v5Out = bake(root, 'v5.mp4', v5!)

      // The PRE-FIX export graph for comparison: same per-source gains through
      // the old 1/N amix, plus the same terminal stereo stage the export path
      // always had (the mono→stereo upmix costs ~3 dB per channel by pan law,
      // so it must be present on BOTH sides or it masks half the delta).
      const legacy = buildSceneAudioFilter(
        tracks,
        2,
        {
          masterGain: 1,
          ttsGain: 0.2,
          musicGain: 1,
          sfxGain: 1,
          ducking: { duckLevel: 0.2, attackMs: 100, releaseMs: 500, ratio: 10 },
        },
        null,
      )
      expect(legacy!.filterComplex).toContain('dropout_transition=2')
      expect(legacy!.filterComplex).not.toContain('normalize=0')
      const legacyExportShaped = {
        audioInputPaths: legacy!.audioInputPaths,
        filterComplex:
          legacy!.filterComplex.replace('[aout]', '[prestereo]') + ';[prestereo]aformat=channel_layouts=stereo[aout]',
      }
      const legacyOut = bake(root, 'legacy.mp4', legacyExportShaped)

      // Identical per-source levels and identical stereo stage, so the only
      // difference is amix scaling: full-gain summing must sit ≈ +6 dB over
      // 1/N for 2 inputs (allow slack for aac); the limiter is in-graph but
      // never engages at these levels.
      expect(meanVolumeDb(v5Out)).toBeGreaterThan(meanVolumeDb(legacyOut) + 4)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
