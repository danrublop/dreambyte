// @vitest-environment node

/**
 * E3 — run the REAL ffmpeg over REAL files and assert the verifier's verdict.
 * A mock of `ffmpeg -i` output only proves the regex matches the mock; this
 * proves a good export passes and the three shapes a broken render actually
 * takes on disk (0-byte, header stub, truncated stream) are caught.
 *
 * Uses the installed ffmpeg the app resolves (packages/render-server/ffmpeg-path.js)
 * and skips when none is found.
 */

import { describe, it, expect } from 'vitest'
import { findFfmpeg } from '@dreambyte/render-server/ffmpeg-path.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkExportArtifact, parseFfmpegProbe } from './verify-export-artifact'

const FFMPEG = findFfmpeg()

/** Mirrors src/electron/ipc/export-tier3.ts assertExportArtifact: stat + `ffmpeg -i`. */
function verdictFor(file: string, expectedSeconds?: number) {
  const sizeBytes = existsSync(file) ? statSync(file).size : null
  const probe =
    sizeBytes != null
      ? parseFfmpegProbe(spawnSync(FFMPEG!, ['-i', file], { encoding: 'utf8', timeout: 60_000 }).stderr)
      : null
  return checkExportArtifact({ sizeBytes, probe, expectedSeconds })
}

describe.skipIf(!FFMPEG)('export artifact verification against real ffmpeg', () => {
  it('passes a real 2s render and catches the ways a render goes wrong', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'verifyexport-'))
    try {
      const real = path.join(root, 'real.mp4')
      const gen = spawnSync(
        FFMPEG!,
        // 320x180 / 2s / ultrafast keeps this well under a second.
        // prettier-ignore
        ['-f','lavfi','-i','color=c=blue:s=320x180:d=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-y', real],
        { encoding: 'utf8', timeout: 60_000 },
      )
      expect(gen.status, gen.stderr).toBe(0)

      // 1. The good case must pass — the guard must never fail a real export.
      const ok = verdictFor(real, 2)
      expect(ok.ok, JSON.stringify(ok)).toBe(true)

      // 2. Truncation: the same render is 2s, but the timeline said 30s. This
      //    is the shape of a render that died partway and still exited 0.
      const short = verdictFor(real, 30)
      expect(short.ok).toBe(false)
      expect(!short.ok && short.reason).toMatch(/truncated/)

      // 3. A 0-byte output — what a crashed encoder leaves behind.
      const empty = path.join(root, 'empty.mp4')
      writeFileSync(empty, '')
      expect(verdictFor(empty, 2).ok).toBe(false)

      // 4. A file truncated to its first 800 bytes: real MP4 header bytes, no
      //    moov atom, so ffmpeg reports no usable stream.
      const stub = path.join(root, 'stub.mp4')
      writeFileSync(stub, readFileSync(real).subarray(0, 800))
      const stubV = verdictFor(stub, 2)
      expect(stubV.ok).toBe(false)

      // 5. Audio-only output (a video export that lost its video stream).
      const audioOnly = path.join(root, 'audio.m4a')
      const genA = spawnSync(
        FFMPEG!,
        // prettier-ignore
        ['-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','aac','-y', audioOnly],
        { encoding: 'utf8', timeout: 60_000 },
      )
      expect(genA.status, genA.stderr).toBe(0)
      const aV = verdictFor(audioOnly, 2)
      expect(aV.ok).toBe(false)
      expect(!aV.ok && aV.reason).toMatch(/no video stream/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
