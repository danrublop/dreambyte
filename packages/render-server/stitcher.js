import ffmpeg from 'fluent-ffmpeg'
import path from 'path'
import fs from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'
import os from 'os'
import { computeXfadeTimeline } from './xfade-timeline.js'
import { findFfmpeg, FFMPEG_MISSING_MESSAGE } from './ffmpeg-path.js'


/** Point fluent-ffmpeg at the user's FFmpeg install (resolved per stitch). */
function useInstalledFfmpeg() {
  const bin = findFfmpeg()
  if (!bin) throw new Error(FFMPEG_MISSING_MESSAGE)
  ffmpeg.setFfmpegPath(bin)
  const probe = findFfmpeg('ffprobe')
  if (probe) ffmpeg.setFfprobePath(probe)
  return bin
}

/** Normalize a file path for use inside FFmpeg concat list files. */
function toConcatPath(p) {
  // FFmpeg concat demuxer requires forward slashes and single-quote escaping
  return p.replace(/\\/g, '/').replace(/'/g, "\\'")
}

/** Probe each path for an audio stream. Missing/unreadable → false. */
async function probeHasAudio(videoPaths) {
  return Promise.all(videoPaths.map(async (p) => {
    try {
      const meta = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(p, (err, m) => err ? reject(err) : resolve(m))
      })
      return meta.streams.some((s) => s.codec_type === 'audio')
    } catch {
      return false
    }
  }))
}

/**
 * Add a silent stereo audio track to any video that lacks one so a later
 * concat/acrossfade sees consistent streams. Returns paths in the same order
 * (originals for videos that already had audio, or if the mux failed).
 */
async function addSilentAudioToMissing(videoPaths, hasAudio) {
  const { execFile: execFileCb } = await import('child_process')
  const { promisify } = await import('util')
  const execFileP = promisify(execFileCb)
  const ffmpegBin = useInstalledFfmpeg()

  return Promise.all(videoPaths.map(async (p, i) => {
    if (hasAudio[i]) return p
    const withAudio = p.replace(/\.mp4$/, '-silent-audio.mp4')
    try {
      await execFileP(ffmpegBin, [
        '-i', p,
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y',
        withAudio,
      ])
      return withAudio
    } catch {
      // If adding silent audio fails, keep original (concat may still work).
      return p
    }
  }))
}

/**
 * Stitch multiple scene MP4s into one final video.
 *
 * @param {string[]} videoPaths
 * @param {Array<{type:string, duration:number}>} transitions — type ids from src/lib/transitions.ts (FFmpeg xfade)
 * @param {string} outputPath
 */
export async function stitchScenes(videoPaths, transitions, outputPath, opts = {}) {
  if (videoPaths.length === 0) {
    throw new Error('No video paths to stitch')
  }

  if (videoPaths.length === 1) {
    // Just copy the single file
    await fs.copyFile(videoPaths[0], outputPath)
    return
  }

  useInstalledFfmpeg()

  const allNone = transitions.every((t) => t.type === 'none')

  if (allNone) {
    await simpleConcatVideos(videoPaths, outputPath, opts)
  } else {
    await xfadeConcatVideos(videoPaths, transitions, outputPath)
  }
}

/**
 * Simple concat via concat demuxer (no transitions).
 * Handles mixed scenes where some have audio and some don't by
 * adding a silent audio track to scenes that lack one.
 */
async function simpleConcatVideos(videoPaths, outputPath, opts = {}) {
  // Check which videos have audio streams so we can normalize
  const hasAudio = await probeHasAudio(videoPaths)

  const anyHasAudio = hasAudio.some(Boolean)

  let finalPaths = videoPaths
  if (anyHasAudio) {
    // Normalize: add silent audio to videos that don't have it
    finalPaths = await addSilentAudioToMissing(videoPaths, hasAudio)
  }

  // Write a concat list file
  const tmpDir = os.tmpdir()
  const listFile = path.join(tmpDir, `dreambyte-concat-${uuidv4()}.txt`)
  const listContent = finalPaths.map((p) => `file '${toConcatPath(p)}'`).join('\n')
  await fs.writeFile(listFile, listContent)

  // Stream-copy by default. For MIXED-engine exports the parts come from
  // different H.264 encoders (tier3 libx264 + legacy WebCodecs/VideoToolbox)
  // whose SPS/PPS/params differ, and -c copy across them produces a file that
  // glitches or freezes at the boundary. opts.reencode forces one graphics-tuned
  // libx264 pass (matching the xfade path) so a heterogeneous join is clean.
  const concatOutputOptions = opts.reencode
    ? [
        '-c:v libx264',
        '-c:a aac',
        '-b:a 256k',
        '-pix_fmt yuv420p',
        '-preset slow',
        '-crf 16',
        '-x264-params aq-mode=3:psy-rd=1.0,0.15:deblock=-1,-1:subme=10:trellis=2:ref=5',
        '-colorspace bt709',
        '-color_primaries bt709',
        '-color_trc bt709',
        '-movflags +faststart',
      ]
    : ['-c copy']

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(concatOutputOptions)
      .output(outputPath)
      .on('end', () => {
        fs.unlink(listFile).catch(() => {})
        resolve()
      })
      .on('error', (err) => {
        fs.unlink(listFile).catch(() => {})
        reject(new Error(`FFmpeg concat failed: ${err.message}`))
      })
      .run()
  })
}

/**
 * Concat with xfade transitions.
 * Calculates offset for each transition based on cumulative durations.
 */
async function xfadeConcatVideos(videoPaths, transitions, outputPath) {
  // First, probe durations of all clips
  const durations = await Promise.all(videoPaths.map(probeDuration))

  // Probe audio presence so we can either concat audio or run video-only.
  const hasAudio = await probeHasAudio(videoPaths)

  const anyHasAudio = hasAudio.some(Boolean)
  let finalVideoPaths = videoPaths

  // If some scenes have audio and some don't, add silent audio to missing ones
  // so the audio concat filter has consistent streams.
  if (anyHasAudio && hasAudio.some((h) => !h)) {
    finalVideoPaths = await addSilentAudioToMissing(videoPaths, hasAudio)
  }

  // Build xfade filter chain
  // [0][1]xfade=transition=fade:duration=0.5:offset=D0-0.25[v01];
  // [v01][2]xfade=transition=fade:duration=0.5:offset=D0+D1-0.5[v012]; etc.
  //
  // The per-join offset math lives in ./xfade-timeline.js (pure + unit-tested).
  const { joins } = computeXfadeTimeline(durations, transitions)
  let filterParts = []

  for (let i = 0; i < joins.length; i++) {
    const { offset, transDur, xfadeType } = joins[i]
    const nextLabel = i === videoPaths.length - 2 ? '[vout]' : `[v${i + 1}]`
    const currentInput = i === 0 ? '[0:v]' : `[v${i}]`

    filterParts.push(
      `${currentInput}[${i + 1}:v]xfade=transition=${xfadeType}:duration=${transDur}:offset=${offset.toFixed(3)}${nextLabel}`
    )
  }

  // Audio: acrossfade in lockstep with the video xfade (same per-join transDur)
  // so audio overlaps exactly where video does. A plain concat runs
  // sum(transDur) longer than the overlap-shortened video and drifts
  // progressively out of sync; acrossfade keeps them aligned and equal length.
  const audioParts = []
  if (anyHasAudio) {
    // Normalize every input to a common rate/layout first — scenes can carry
    // different sample rates (silent-padded ones are 44100/stereo) and acrossfade
    // chokes on mismatches.
    // Also pad/trim each audio to its scene's VIDEO duration (durations[i], already
    // probed) so the acrossfade chain tracks the xfade-shortened VIDEO timeline.
    // Audio shorter/longer than its video (TTS ends early, encoder padding) would
    // otherwise drift, or under-run the crossfade duration and error.
    for (let i = 0; i < finalVideoPaths.length; i++) {
      const dur = (durations[i] || 0).toFixed(3)
      audioParts.push(
        `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:${dur},asetpts=N/SR/TB[ar${i}]`
      )
    }
    for (let i = 0; i < joins.length; i++) {
      const d = Math.max(0.01, joins[i].transDur)
      const left = i === 0 ? '[ar0]' : `[a${i}]`
      const out = i === joins.length - 1 ? '[aout]' : `[a${i + 1}]`
      audioParts.push(`${left}[ar${i + 1}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri${out}`)
    }
  }

  // Append a debanding stage to the final video. Dark radial/large gradients
  // band into visible rings because the canvas capture isn't dithered like
  // Chrome's on-screen compositor, and 8-bit yuv420 quantization compounds it.
  // gradfun smooths near-flat regions + re-dithers them; its gradient threshold
  // leaves text/edges untouched. radius 32 spans the wide bands of a full-screen
  // gradient. (This covers only the crossfade re-encode path; a complete fix
  // for all paths is render-side dither or 10-bit output.)
  const complexFilter =
    filterParts.join(';') + ';[vout]gradfun=1.2:32[vdb]' + (audioParts.length ? ';' + audioParts.join(';') : '')

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()

    finalVideoPaths.forEach((p) => cmd.input(p))

    cmd
      .complexFilter(complexFilter)
      .outputOptions(
        // The xfade filter forces a re-encode (can't stream-copy across a
        // transition). Tuned for animation/graphics (flat color, crisp text,
        // smooth gradients): CRF 16 (below the visually-lossless ~18 to protect
        // text edges), preset slower, and x264 params that keep edges sharp
        // (aq-mode=3 + mild psy-rd) without smearing (deblock -1,-1). bt709
        // color tags so players don't guess; +faststart for instant playback.
        anyHasAudio
          ? [
              '-map [vdb]',
              '-map [aout]',
              '-c:v libx264',
              '-c:a aac',
              '-b:a 256k',
              '-pix_fmt yuv420p',
              '-preset slower',
              '-crf 16',
              '-x264-params aq-mode=3:psy-rd=1.0,0.15:deblock=-1,-1:subme=10:trellis=2:ref=5',
              '-colorspace bt709',
              '-color_primaries bt709',
              '-color_trc bt709',
              '-movflags +faststart',
            ]
          : [
              '-map [vdb]',
              '-c:v libx264',
              '-pix_fmt yuv420p',
              '-preset slower',
              '-crf 16',
              '-x264-params aq-mode=3:psy-rd=1.0,0.15:deblock=-1,-1:subme=10:trellis=2:ref=5',
              '-colorspace bt709',
              '-color_primaries bt709',
              '-color_trc bt709',
              '-movflags +faststart',
            ]
      )
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => {
        // Do NOT silently fall back to a plain concat here. The caller
        // requested transitions; a concat drops every transition and produces a
        // wrong export that looks "successful". Fail loudly so the user knows.
        console.error('[stitcher] xfade error (failing, transitions were requested):', err.message)
        reject(new Error(`xfade stitch failed: ${err.message}`))
      })
      .run()
  })
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err)
      resolve(metadata?.format?.duration ?? 0)
    })
  })
}
