/**
 * Runtime smoke for the sync_audio decode contract on DERIVED audio clips.
 *
 * The unit tests stub the PCM decoder, so they never exercise the one path the
 * tool is actually for: narration / music clips. Those clips carry SYNTHETIC
 * source ids (`tts-<sceneId>`, `mus-<sceneId>`) — not decodable URIs — so a naive
 * `decoder.decode(clip.sourceId)` feeds ffmpeg a non-openable string. This smoke:
 *
 *   1. synthesizes two real audio files with ffmpeg (identical content, one
 *      delayed by a known amount),
 *   2. wires a real ffmpeg-backed PCM decoder,
 *   3. builds scenes whose audioLayer.tts.src / .music.src point at those files
 *      (so a `tts-…` / `mus-…` clip resolves through `buildAudioUrlMap`),
 *   4. runs `computeAudioSyncOffset` WITH the resolver → expects the known offset,
 *   5. runs it WITHOUT the resolver → expects an HONEST refusal (synthetic id is
 *      not openable), proving the resolver is load-bearing, not decoration.
 *
 * Run:  FFMPEG=/opt/homebrew/bin/ffmpeg npx tsx scripts/smoke/sync-audio-decode-smoke.mts
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { DecodedPcm, PcmDecoder } from '../../src/lib/edit-engines/pcm-decoder'
import type { Clip, Scene } from '../../src/lib/types'

// Pull these dynamically: a static `import {}` is linked by node's ESM loader
// before tsx transpiles the dependency, and the CJS-target lib files don't
// surface their named exports to that linker. Dynamic import resolves after
// transpile, where the named exports are present.
const { setPcmDecoder } = await import('../../src/lib/edit-engines/pcm-decoder')
const { computeAudioSyncOffset } = await import('../../src/lib/edit-engines/audio-sync')
const { buildAudioUrlMap } = await import('../../src/lib/audio/audio-url-map')

const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const SR = 48000
const DELAY_MS = 400 // target content occurs 0.4 s later than the reference

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args)
    let err = ''
    c.stderr.on('data', (d) => (err += d.toString()))
    c.on('error', reject)
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.trim()}`))))
  })
}

/** A minimal ffmpeg-backed decoder (mirrors src/electron/audio-decode.ts spawn). */
const ffmpegDecoder: PcmDecoder = {
  decode(source: string): Promise<DecodedPcm> {
    return new Promise((resolve, reject) => {
      const child = spawn(FFMPEG, [
        '-hide_banner', '-loglevel', 'error',
        '-i', source,
        '-f', 'f32le', '-ac', '1', '-ar', String(SR),
        'pipe:1',
      ])
      const bufs: Buffer[] = []
      let err = ''
      child.stdout.on('data', (d: Buffer) => bufs.push(d))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)))
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim() || '(no stderr)'}`))
        const merged = Buffer.concat(bufs)
        const aligned = merged.byteOffset % 4 === 0 ? merged : Buffer.from(merged)
        const samples = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4)
        resolve({ samples, sampleRate: SR })
      })
    })
  },
}

function clip(over: Partial<Clip> & { id: string; sourceId: string }): Clip {
  return {
    trackId: 't', sourceType: 'audio', label: 'c', startTime: 0, duration: 6,
    trimStart: 0, trimEnd: null, speed: 1, opacity: 1, position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 }, rotation: 0, filters: [], keyframes: [], transition: null,
    ...over,
  } as Clip
}

let failures = 0
function check(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

async function main() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sync-audio-smoke-'))
  const refWav = path.join(dir, 'narration.wav')
  const tgtWav = path.join(dir, 'music.wav')

  // Identical broadband content, target delayed by DELAY_MS. Pink noise gives a
  // sharp cross-correlation peak (decorrelates fast off-alignment).
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', `anoisesrc=color=pink:duration=6:seed=12345`,
    '-ar', String(SR), '-ac', '1', refWav])
  await run(FFMPEG, ['-y', '-i', refWav, '-af', `adelay=${DELAY_MS}`, tgtWav])
  console.log(`Synthesized: ${refWav}\n             ${tgtWav} (delayed ${DELAY_MS}ms)\n`)

  setPcmDecoder(ffmpegDecoder)
  try {
    // Scenes: narration on s1, music on s2 → tts-s1 / mus-s2 resolve to the files.
    const scenes = [
      { id: 's1', audioLayer: { tts: { src: refWav } } },
      { id: 's2', audioLayer: { music: { src: tgtWav } } },
    ] as unknown as Scene[]
    const urlMap = buildAudioUrlMap(scenes)
    const resolveSource = (c: Clip) => urlMap.get(c.sourceId) || c.sourceId

    const refClip = clip({ id: 'ref', sourceId: 'tts-s1', startTime: 2, duration: 6 })
    const tgtClip = clip({ id: 'tgt', sourceId: 'mus-s2', startTime: 0, duration: 6.4 })

    check('buildAudioUrlMap resolves tts-/mus- ids', urlMap.get('tts-s1') === refWav && urlMap.get('mus-s2') === tgtWav)

    // 1) WITH the resolver — narration/music decode + sync to the known offset.
    const withResolver = await computeAudioSyncOffset(refClip, tgtClip, { searchWindowSeconds: 2, resolveSource })
    check('derived clips matched', withResolver.matched, withResolver.reason ?? '')
    check('confidence high', withResolver.confidence > 0.8, `confidence=${withResolver.confidence.toFixed(3)}`)
    // target later by 0.4s → lag -0.4s → newStart = refStart(2) - 0.4 = 1.6.
    const expectedNewStart = 2 - DELAY_MS / 1000
    check(
      'recovered offset matches the known delay',
      Math.abs(withResolver.newStartTime - expectedNewStart) < 0.05,
      `newStartTime=${withResolver.newStartTime.toFixed(3)} (expected ~${expectedNewStart})`,
    )

    // 2) WITHOUT the resolver — synthetic id reaches ffmpeg → honest refusal.
    const noResolver = await computeAudioSyncOffset(refClip, tgtClip, { searchWindowSeconds: 2 })
    check(
      'without the resolver it refuses honestly (no wrong move)',
      !noResolver.matched && /no readable audio|resolvable/i.test(noResolver.reason ?? ''),
      noResolver.reason ?? '',
    )
  } finally {
    setPcmDecoder(null)
  }

  console.log(`\n${failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures} check(s))`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('SMOKE ERRORED:', e)
  process.exit(1)
})
