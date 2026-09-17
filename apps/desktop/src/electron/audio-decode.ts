/**
 * ffmpeg-backed PCM decoder.
 *
 * Implements `src/lib/edit-engines/pcm-decoder.ts`'s `PcmDecoder` interface
 * by spawning the user's installed ffmpeg binary with:
 *
 *   ffmpeg -hide_banner -loglevel error -i <input> -f f32le -ac 1 -ar 48000 pipe:1
 *
 * which streams little-endian float32 mono PCM at 48 kHz to stdout. We
 * collect stdout buffers, splice them into a `Float32Array`, and return
 * `{ samples, sampleRate }`.
 *
 * Source URI handling:
 *   - absolute file paths pass through
 *   - `dreambyte://uploads/...` / `dreambyte://audio/...` resolve to the
 *     user-data dir via the same paths registered for the protocol
 *   - relative paths are rejected (callers always have a fully qualified
 *     reference by the time they hit the decoder)
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

import { getUserUploadsDir, getUserAudioDir } from './paths'
import { findFfmpeg, FFMPEG_MISSING_MESSAGE } from '@dreambyte/render-server/ffmpeg-path.js'
import type { PcmDecoder, DecodedPcm } from '@/lib/edit-engines/pcm-decoder'

const TARGET_SAMPLE_RATE = 48000

/**
 * Resolve the user's installed ffmpeg (packages/render-server/ffmpeg-path.js). Throws
 * the install hint when none is found — every caller runs inside an async
 * flow, so this surfaces as a rejected promise with a readable message.
 */
export function resolveFfmpegPath(): string {
  const bin = findFfmpeg()
  if (!bin) throw new Error(FFMPEG_MISSING_MESSAGE)
  return bin
}

/**
 * Join a decoded relative path under `base` and assert it stays inside.
 *
 * `decodeURIComponent` (in the caller) turns `..%2f..%2f` into `../../`, so
 * without this guard `dreambyte://uploads/..%2f..%2fetc%2fpasswd` would resolve
 * to a path outside the uploads mount. That matters because the resolved
 * path is later read and POSTed to the transcription/vision endpoint — an
 * arbitrary-file-read-with-exfiltration sink. We
 * normalize and compare with `path.relative`: anything that escapes yields
 * a relative path starting with `..` or an absolute path.
 */
function resolveWithinBase(base: string, rawPath: string, source: string): string {
  const resolvedBase = path.resolve(base)
  const target = path.resolve(resolvedBase, rawPath)
  const rel = path.relative(resolvedBase, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing path that escapes ${path.basename(base)}: ${source}`)
  }
  return target
}

/**
 * Translate the user-facing source URI to a value ffmpeg's `-i` understands.
 * Pure — exported for unit testing.
 */
export function resolveSourceForFfmpeg(source: string): string {
  if (source.startsWith('file://')) return source
  if (source.startsWith('http://') || source.startsWith('https://')) return source
  if (source.startsWith('dreambyte://')) {
    const u = new URL(source)
    const rawPath = decodeURIComponent(u.pathname).replace(/^\/+/, '')
    if (u.hostname === 'uploads') return resolveWithinBase(getUserUploadsDir(), rawPath, source)
    if (u.hostname === 'audio') return resolveWithinBase(getUserAudioDir(), rawPath, source)
    throw new Error(`Unsupported dreambyte:// host for ffmpeg decode: ${u.hostname}`)
  }
  // Bare path. Reject relative — callers should always have a fully
  // qualified reference at the decode boundary.
  if (!path.isAbsolute(source)) {
    throw new Error(`Refusing to decode relative path: ${source}`)
  }
  return source
}

interface FfmpegDecodeOptions {
  /** Override the ffmpeg binary (mostly for tests). */
  ffmpegPath?: string
  /** Cap on decode runtime in ms. Default 60s; long enough for ~10min audio. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Spawn ffmpeg, collect mono float32 PCM from stdout, return as a typed
 * array. Rejects on non-zero exit, stderr-flagged error, or timeout.
 */
async function decodeToFloat32Pcm(
  source: string,
  options: FfmpegDecodeOptions = {},
): Promise<DecodedPcm> {
  const resolved = resolveSourceForFfmpeg(source)
  const bin = options.ffmpegPath ?? resolveFfmpegPath()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return await new Promise<DecodedPcm>((resolve, reject) => {
    const child = spawn(bin, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', resolved,
      '-f', 'f32le',
      '-ac', '1',
      '-ar', String(TARGET_SAMPLE_RATE),
      'pipe:1',
    ])

    const buffers: Buffer[] = []
    let stderrText = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ffmpeg decode timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => buffers.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf-8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`ffmpeg spawn failed: ${err.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (signal === 'SIGKILL') return // timeout path already rejected
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${stderrText.trim() || '(no stderr)'}`))
      }
      const merged = Buffer.concat(buffers)
      // The merged buffer is N × Float32. Use a typed-array view; copy when
      // unaligned so downstream code can rely on byteOffset=0.
      const align = merged.byteOffset % 4
      if (align === 0) {
        const samples = new Float32Array(merged.buffer, merged.byteOffset, merged.length / 4)
        resolve({ samples, sampleRate: TARGET_SAMPLE_RATE })
      } else {
        const aligned = Buffer.from(merged)
        const samples = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4)
        resolve({ samples, sampleRate: TARGET_SAMPLE_RATE })
      }
    })
  })
}

/** PcmDecoder seam implementation. Drop into `setPcmDecoder(...)` at boot. */
export function createFfmpegPcmDecoder(): PcmDecoder {
  return {
    async decode(source: string) {
      return decodeToFloat32Pcm(source)
    },
  }
}
