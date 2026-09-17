// @vitest-environment node

/**
 * v5 A1 / D13#12: run the REAL ffmpeg over the exact overlay args
 * buildProgramOverlayArgs produces and assert the user's timeline audio
 * actually LANDED in the MP4 — an audio stream exists and is not silence
 * (volumedetect). "Did the overlay run at all" must not depend on a human
 * remembering to listen to a mixed export.
 *
 * Uses the installed ffmpeg the app resolves (packages/render-server/ffmpeg-path.js)
 * and skips when none is found.
 */

import { describe, it, expect } from 'vitest'
import { findFfmpeg } from '@dreambyte/render-server/ffmpeg-path.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildProgramOverlayArgs } from './program-audio-overlay'

const FFMPEG = findFfmpeg()

const run = (args: string[]) =>
  spawnSync(FFMPEG!, ['-hide_banner', '-loglevel', 'info', ...args], { encoding: 'utf8', timeout: 60_000 })

/** Mirrors export-tier3's hasAudioStream: `ffmpeg -i` exits non-zero but prints stream info. */
const hasAudio = (file: string) =>
  /Stream #\d+:\d+.*: Audio:/.test(spawnSync(FFMPEG!, ['-i', file], { encoding: 'utf8', timeout: 60_000 }).stderr)

/** mean_volume in dB via volumedetect; silence reads ≈ -91 dB. */
function meanVolumeDb(file: string): number {
  const r = spawnSync(FFMPEG!, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  const m = r.stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)
  expect(m, r.stderr.slice(-500)).toBeTruthy()
  return Number(m![1])
}

describe.skipIf(!FFMPEG)('program-audio overlay against real ffmpeg', () => {
  it('a music clip lands audibly in a video that had NO audio stream', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'progaudio-'))
    try {
      const video = path.join(root, 'video.mp4')
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

      const tone = path.join(root, 'tone.wav')
      const genTone = run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', tone])
      expect(genTone.status, genTone.stderr).toBe(0)

      const out = path.join(root, 'out.mp4')
      const args = buildProgramOverlayArgs({
        videoPath: video,
        resolved: [{ file: tone, c: { src: 'x', startTime: 0, duration: 1.5, trimStart: 0, speed: 1, gain: 0.8 } }],
        masterVolume: 1,
        videoHasAudio: false,
        outPath: out,
      })
      const overlay = run(args)
      expect(overlay.status, overlay.stderr).toBe(0)

      expect(hasAudio(out)).toBe(true)
      expect(meanVolumeDb(out)).toBeGreaterThan(-40) // a sine at 0.8 gain ≈ -6 dB; silence ≈ -91 dB
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a clip mixes OVER existing scene audio without silencing it (amix normalize=0 path)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'progaudio-'))
    try {
      const video = path.join(root, 'video.mp4')
      // Video WITH a (quiet sine) audio stream — the 2-input amix branch.
      const gen = run([
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x180:d=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:duration=2',
        '-filter_complex',
        '[1:a]volume=0.2[a]',
        '-map',
        '0:v',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-y',
        video,
      ])
      expect(gen.status, gen.stderr).toBe(0)

      const tone = path.join(root, 'tone.wav')
      const genTone = run(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-y', tone])
      expect(genTone.status, genTone.stderr).toBe(0)

      const out = path.join(root, 'out.mp4')
      const args = buildProgramOverlayArgs({
        videoPath: video,
        resolved: [{ file: tone, c: { src: 'x', startTime: 0.5, duration: 1, trimStart: 0, speed: 1, gain: 0.8 } }],
        masterVolume: 1,
        videoHasAudio: true,
        outPath: out,
      })
      const overlay = run(args)
      expect(overlay.status, overlay.stderr).toBe(0)

      expect(hasAudio(out)).toBe(true)
      // The mix must be LOUDER than the quiet base alone (the clip is in there) —
      // full-gain summing, no 1/N attenuation of the base.
      expect(meanVolumeDb(out)).toBeGreaterThan(meanVolumeDb(video))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
