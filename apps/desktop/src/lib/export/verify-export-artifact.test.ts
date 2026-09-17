// @vitest-environment node

/**
 * E3 — export success used to be inferred from control flow alone. These pin
 * the decision table that now stands between "ffmpeg didn't throw" and telling
 * the user their video is ready.
 */

import { describe, it, expect } from 'vitest'
import { checkExportArtifact, parseFfmpegProbe, MIN_EXPORT_BYTES } from './verify-export-artifact'

const good = { hasVideo: true, hasAudio: false, durationSec: 10 }

describe('checkExportArtifact', () => {
  it('rejects a missing file', () => {
    const v = checkExportArtifact({ sizeBytes: null, probe: null })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.reason).toMatch(/does not exist/)
  })

  it('rejects a 0-byte render that every step "succeeded" on', () => {
    const v = checkExportArtifact({ sizeBytes: 0, probe: good })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.reason).toMatch(/0 bytes/)
  })

  it('rejects a header-only stub under the minimum', () => {
    expect(checkExportArtifact({ sizeBytes: MIN_EXPORT_BYTES - 1, probe: good }).ok).toBe(false)
  })

  it('rejects an audio-only / streamless file', () => {
    const v = checkExportArtifact({ sizeBytes: 200_000, probe: { hasVideo: false, hasAudio: true, durationSec: 10 } })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.reason).toMatch(/no video stream/)
  })

  it('rejects a file whose duration ffmpeg cannot read (truncated / no index)', () => {
    const v = checkExportArtifact({ sizeBytes: 200_000, probe: { ...good, durationSec: null } })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.reason).toMatch(/no duration/)
  })

  it('rejects a render truncated far short of the timeline', () => {
    const v = checkExportArtifact({ sizeBytes: 200_000, probe: { ...good, durationSec: 3 }, expectedSeconds: 60 })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.reason).toMatch(/truncated/)
  })

  it('accepts normal container drift against the timeline', () => {
    expect(
      checkExportArtifact({ sizeBytes: 200_000, probe: { ...good, durationSec: 10.08 }, expectedSeconds: 10 }).ok,
    ).toBe(true)
    // A short export is dominated by the 1s floor, not the 25% band.
    expect(
      checkExportArtifact({ sizeBytes: 200_000, probe: { ...good, durationSec: 2.4 }, expectedSeconds: 2 }).ok,
    ).toBe(true)
  })

  it('checks what it can (and says so) when no ffmpeg is available to probe', () => {
    const v = checkExportArtifact({ sizeBytes: 200_000, probe: null })
    expect(v.ok).toBe(true)
    expect(v.ok && v.warnings[0]).toMatch(/could not probe/)
  })
})

describe('parseFfmpegProbe', () => {
  it('reads duration + streams out of an `ffmpeg -i` dump', () => {
    const stderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'out.mp4':
  Duration: 00:01:03.52, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo
`
    const p = parseFfmpegProbe(stderr)
    expect(p.hasVideo).toBe(true)
    expect(p.hasAudio).toBe(true)
    expect(p.durationSec).toBeCloseTo(63.52, 2)
  })

  it('returns a null duration for "Duration: N/A" (the truncated-file signature)', () => {
    const p = parseFfmpegProbe(`  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: h264`)
    expect(p.durationSec).toBeNull()
    expect(p.hasVideo).toBe(true)
  })
})
