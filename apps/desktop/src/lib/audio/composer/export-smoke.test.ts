// @vitest-environment node
//
// T6 / D9 — the #1 risk gate: a composed track that previews fine but exports
// SILENT (the client-only-TTS trap, for music). This drives the REAL export audio
// filtergraph (packages/render-server/audio-filter.js buildSceneAudioFilter — the same code
// the Tier-3 export uses) with a freshly composed track, muxes it into an MP4
// exactly as the export does, and asserts the output audio is present + non-silent.
//
// CI-runnable (no live app). Skips cleanly when the soundfont or ffmpeg is absent.
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { compose } from './arrange'
import { renderArrangementToFile } from './render'
// The actual export filtergraph builder (plain JS, shared by render-server + Tier-3).
import { buildSceneAudioFilter } from '@dreambyte/render-server/audio-filter.js'

const SF = process.env.DREAMBYTE_SOUNDFONT_PATH || join(process.cwd(), 'public', 'soundfonts', 'GeneralUser-GS.sf2')
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg'

function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args)
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d.toString()))
    p.on('error', () => resolve({ code: -1, stderr: 'spawn failed' }))
    p.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

async function ffmpegAvailable(): Promise<boolean> {
  return (await run(FFMPEG, ['-version'])).code === 0
}

/** Mean volume (dBFS) of a file via ffmpeg volumedetect; -91 ≈ digital silence. */
async function meanVolumeDb(file: string): Promise<{ hasAudio: boolean; db: number | null }> {
  const { stderr } = await run(FFMPEG, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
  const hasAudio = /Stream #\d+:\d+.*Audio/.test(stderr)
  const m = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  return { hasAudio, db: m ? Number(m[1]) : null }
}

const canRun = existsSync(SF)
;(canRun ? describe : describe.skip)('composed music → export audibility', () => {
  it('survives the real export filtergraph as audible (non-silent) audio in an MP4', async () => {
    if (!(await ffmpegAvailable())) {
      console.warn('[export-smoke] ffmpeg not available — skipping')
      return
    }
    const dir = await mkdtemp(join(tmpdir(), 'export-smoke-'))
    const duration = 4

    // 1) Compose + render a real track to a WAV.
    const { arrangement } = compose({ templateId: 'lofi', sceneDurationSec: duration, intensity: 0.7 })
    const musicWav = join(dir, 'music.wav')
    await renderArrangementToFile(arrangement, SF, musicWav)

    // 2) Make a synthetic scene video (the export muxes audio onto real video frames).
    const videoMp4 = join(dir, 'scene.mp4')
    const mk = await run(FFMPEG, [
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=320x240:rate=30:duration=${duration}`,
      '-pix_fmt',
      'yuv420p',
      '-t',
      String(duration),
      '-y',
      videoMp4,
    ])
    expect(mk.code, mk.stderr.slice(-400)).toBe(0)

    // 3) Build the REAL export filtergraph for a scene whose only audio is our music.
    const audioTracks = {
      music: { path: musicWav, volume: 0.8, loop: false, duckDuringTTS: false, duckLevel: 0.2 },
    }
    const built = buildSceneAudioFilter(audioTracks, duration, null, null, [])
    if (!built) throw new Error('filtergraph should be built for a music-only scene')

    // 4) Mux exactly as packages/render-server/audio-mixer.js does.
    const out = join(dir, 'out.mp4')
    const inputs = ['-i', videoMp4]
    for (const p of built.audioInputPaths) inputs.push('-i', p)
    const mux = await run(FFMPEG, [
      ...inputs,
      '-filter_complex',
      built.filterComplex,
      '-map',
      '0:v',
      '-map',
      `[${built.audioOutLabel}]`,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-t',
      String(duration),
      '-y',
      out,
    ])
    expect(mux.code, mux.stderr.slice(-600)).toBe(0)

    // 5) The export MUST contain audible audio — this is the silent-export gate.
    const { hasAudio, db } = await meanVolumeDb(out)
    expect(hasAudio, 'exported MP4 must have an audio stream').toBe(true)
    expect(db, 'mean volume should be measurable').not.toBeNull()
    expect(db!, `mean volume ${db} dB should be above the silence floor`).toBeGreaterThan(-50)
  }, 60_000)
})
