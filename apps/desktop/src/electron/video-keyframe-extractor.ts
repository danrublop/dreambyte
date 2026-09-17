/**
 * ffmpeg-backed KeyframeExtractor (Phase 2). Supplies the frame-vision
 * VideoUnderstander with sampled JPEG keyframes. Lives in Electron because it
 * spawns the bundled ffmpeg binary; the understander in `src/lib/` stays ffmpeg-free.
 *
 * Strategy: sample at a low fps (default 1) scaled to 512px wide, write JPEGs to
 * a temp dir, read them back with approximate timestamps, then clean up. The
 * adaptive down-select happens in `src/lib/services/keyframe-selection.ts`.
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveFfmpegPath, resolveSourceForFfmpeg } from './audio-decode'
import type { KeyframeExtractor, KeyframeImage } from '@/lib/services/video-understander'

const DEFAULT_MAX_FRAMES = 24
const EXTRACT_TIMEOUT_MS = 90_000
/** Fall back to this fps when the duration probe fails (samples the opening). */
const FALLBACK_FPS = 1

/** Probe media duration (seconds) by parsing ffmpeg's stderr banner. 0 if unknown. */
async function probeDurationSec(bin: string, input: string): Promise<number> {
  return new Promise<number>((resolve) => {
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['-hide_banner', '-i', input])
    } catch {
      resolve(0)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      resolve(0)
    }, 15_000)
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(0)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0)
    })
  })
}

export function createFfmpegKeyframeExtractor(opts: { ffmpegPath?: string } = {}): KeyframeExtractor {
  return {
    async extract(source, options = {}) {
      const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES
      const bin = opts.ffmpegPath ?? resolveFfmpegPath()
      const input = resolveSourceForFfmpeg(source)

      // Spread `maxFrames` evenly across the WHOLE clip: fps = frames/duration.
      // Without this (fixed fps + -frames:v N) we'd only sample the first N
      // seconds and report a bogus ~N-second duration for long videos.
      const durationProbe = options.fps ? 0 : await probeDurationSec(bin, input)
      const fps = options.fps ?? (durationProbe > 0 ? Math.min(maxFrames / durationProbe, 1) : FALLBACK_FPS)

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-keyframes-'))
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(bin, [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', input,
            '-vf', `fps=${fps},scale=512:-1`,
            '-frames:v', String(maxFrames),
            '-q:v', '5',
            path.join(dir, 'frame_%04d.jpg'),
          ])
          let stderr = ''
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error('ffmpeg keyframe extraction timed out'))
          }, EXTRACT_TIMEOUT_MS)
          options.abortSignal?.addEventListener('abort', () => {
            child.kill('SIGKILL')
            reject(new Error('aborted'))
          })
          child.stderr.on('data', (d) => (stderr += d.toString()))
          child.on('error', (e) => {
            clearTimeout(timer)
            reject(e)
          })
          child.on('close', (code) => {
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`))
          })
        })

        const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort()
        // Read frames in parallel (small count); timestamp = frame index / fps.
        const frames: KeyframeImage[] = await Promise.all(
          files.map(async (f, i) => ({
            timeSec: i / fps,
            bytes: new Uint8Array(await fs.readFile(path.join(dir, f))),
            mimeType: 'image/jpeg' as const,
          })),
        )
        // Prefer the probed duration; fall back to the last frame's timestamp.
        const durationSec = durationProbe > 0 ? durationProbe : frames.length ? frames[frames.length - 1].timeSec : 0
        return { durationSec, frames }
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}
