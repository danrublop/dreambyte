// @vitest-environment node

/**
 * Integration test: run the REAL ffmpeg binary over the exact filter arg
 * buildSubtitlesFilterArg produces. The unit tests can only pin the string
 * shape the author intended — this is the test that catches a wrong intent
 * (the original apostrophe escaping passed its unit test and failed in every
 * real ffmpeg; see escapeSubtitlesFilterPath's doc comment).
 *
 * Uses the installed ffmpeg the app resolves (packages/render-server/ffmpeg-path.js)
 * and skips when none is found.
 */

import { describe, it, expect } from 'vitest'
import { findFfmpeg } from '@dreambyte/render-server/ffmpeg-path.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSubtitlesFilterArg } from './caption-burnin'

/**
 * The real precondition is the `subtitles` filter, not merely "an ffmpeg exists".
 *
 * That filter needs libass, and plenty of builds ship without it — Homebrew's
 * ffmpeg 8.1.2 reports `Unknown filter 'subtitles'`. A libass-less build made
 * this suite fail with a filtergraph parse error that reads exactly like a
 * regression in the escaping under test. It is not one; the escaping is fine.
 * Skip instead, so a red test always means a real defect.
 */
function hasSubtitlesFilter(bin: string | null): boolean {
  if (!bin) return false
  const r = spawnSync(bin, ['-hide_banner', '-h', 'filter=subtitles'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 && !/Unknown filter/i.test(`${r.stdout}${r.stderr}`)
}

const FFMPEG = findFfmpeg()
const CAN_BURN = hasSubtitlesFilter(FFMPEG)

describe.skipIf(!CAN_BURN)('caption burn filter against real ffmpeg', () => {
  it('burns an SRT whose path contains apostrophes, brackets, semicolons, commas and spaces', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'capburn-'))
    try {
      // The nastiest realistic export dir we can construct — every filter-graph
      // special plus the apostrophe that broke the original escaping.
      const nastyDir = path.join(root, "o'brien, [draft]; v2")
      mkdirSync(nastyDir)
      const srtPath = path.join(nastyDir, "final's.captions.srt")
      writeFileSync(srtPath, '1\n00:00:00,100 --> 00:00:00,400\nhello burn\n', 'utf-8')

      const base = path.join(root, 'base.mp4')
      const gen = spawnSync(
        FFMPEG!,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=320x180:d=0.5',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-y',
          base,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      )
      expect(gen.status, gen.stderr).toBe(0)

      const out = path.join(root, 'out.mp4')
      const burn = spawnSync(
        FFMPEG!,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          base,
          '-vf',
          buildSubtitlesFilterArg(srtPath, 1920, 1080),
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-y',
          out,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      )
      expect(burn.status, burn.stderr).toBe(0)
      expect(existsSync(out)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
