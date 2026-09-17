/**
 * Pure ffmpeg-arg assembly for the program-audio overlay — the step that mixes
 * standalone timeline audio (files on audio tracks) onto a finished export.
 *
 * Lives in src/lib/export (electron-free) so the SAME production args are unit- and
 * integration-testable: src/electron/ipc/export-tier3.ts's overlayProgramAudio
 * resolves clip sources to local files and runs ffmpeg (in the utility
 * process); this module owns everything in between. v5 A1 made the overlay run
 * on all three export paths (tier3 internally, mixed/legacy via concatMp4), so
 * one arg builder serves every engine.
 *
 * Filter shape per clip:  [N:a] atrim → asetpts → atempo… → volume → adelay
 * Then: sum clips (amix normalize=0) → ×masterVolume → mix over scene audio.
 * Output: -map 0:v -map [aout] -c:v copy (audio-only pass; video untouched).
 */

export interface ProgramOverlayClip {
  src: string
  startTime: number
  duration: number
  trimStart: number
  speed: number
  gain: number
  /** Volume-automation samples in clip-local seconds (mirrors program-audio.ts). */
  gainEnvelope?: Array<{ t: number; v: number }>
}

/** Decompose any playback rate into chained atempo factors, each in ffmpeg's
 *  supported [0.5, 2] window (atempo=4 isn't valid; atempo=2,atempo=2 is). */
export function atempoChain(speed: number): string[] {
  if (!(speed > 0) || Math.abs(speed - 1) < 1e-3) return []
  let s = speed
  const out: string[] = []
  while (s > 2) {
    out.push('atempo=2.0')
    s /= 2
  }
  while (s < 0.5) {
    out.push('atempo=0.5')
    s *= 2
  }
  // The 2.0/0.5 stages are exact powers of two, so `s` IS the residual of the
  // running product — the only drift source is serialization precision. 8
  // decimals keeps the chained product within ~5e-9 of the exact speed
  // (sub-ms over hours; toFixed(4) drifted sub-ms/sec on long clips).
  out.push(`atempo=${s.toFixed(8)}`)
  return out
}

/** Build the `volume` filter for a clip — constant when there's no envelope, or
 *  a piecewise-linear `eval=frame` expression in clip-local time `t` that
 *  reproduces the gain automation. Commas inside the expr are protected by the
 *  surrounding single quotes (ffmpeg filtergraph quoting). */
export function volumeFilterFor(c: ProgramOverlayClip): string {
  const env = c.gainEnvelope
  if (!env || env.length < 2) return `volume=${c.gain.toFixed(4)}`
  // Nested piecewise-linear: before first point → v0; between i-1,i → lerp; after last → vN.
  const n = env.length
  let expr = env[n - 1].v.toFixed(4)
  for (let i = n - 1; i >= 1; i--) {
    const a = env[i - 1]
    const b = env[i]
    const seg =
      b.t - a.t < 1e-4
        ? b.v.toFixed(4)
        : `lerp(${a.v.toFixed(4)},${b.v.toFixed(4)},(t-${a.t.toFixed(4)})/${(b.t - a.t).toFixed(4)})`
    expr = `if(lt(t,${b.t.toFixed(4)}),${seg},${expr})`
  }
  expr = `if(lt(t,${env[0].t.toFixed(4)}),${env[0].v.toFixed(4)},${expr})`
  return `volume=eval=frame:volume='${expr}'`
}

/**
 * Assemble the complete ffmpeg argv for one overlay pass. `resolved` pairs each
 * clip with its already-resolved local file (input 0 is the video).
 */
export function buildProgramOverlayArgs(opts: {
  videoPath: string
  resolved: Array<{ file: string; c: ProgramOverlayClip }>
  masterVolume: number
  /** Whether the video already has an audio stream to mix the clips over. */
  videoHasAudio: boolean
  outPath: string
}): string[] {
  const { videoPath, resolved, masterVolume, videoHasAudio, outPath } = opts
  const inputPaths: string[] = [videoPath, ...resolved.map((r) => r.file)]
  const filters: string[] = []
  const labels: string[] = []
  resolved.forEach(({ c }, i) => {
    const inIdx = i + 1 // input 0 is the video
    const speed = c.speed > 0 ? c.speed : 1
    const srcDur = c.duration * speed
    const delayMs = Math.round(Math.max(0, c.startTime) * 1000)
    // The input label `[N:a]` must prefix the first filter WITHOUT a comma —
    // `[N:a]atrim,...` not `[N:a],atrim,...` (the latter parses the label as
    // feeding an empty filter → "No such filter: ''"). Order: trim the source
    // span → reset PTS → atempo (so the envelope's t is clip-local timeline
    // seconds) → volume (constant or automated) → delay to the timeline position.
    const chain = [
      `atrim=start=${c.trimStart.toFixed(3)}:end=${(c.trimStart + srcDur).toFixed(3)}`,
      `asetpts=PTS-STARTPTS`,
      ...atempoChain(speed),
      volumeFilterFor(c),
      `adelay=delays=${delayMs}:all=1`,
    ]
    filters.push(`[${inIdx}:a]${chain.join(',')}[c${i}]`)
    labels.push(`[c${i}]`)
  })

  // Sum the clips, scale by master, then mix over the scene audio (if any).
  if (labels.length === 1) {
    filters.push(`${labels[0]}volume=${masterVolume.toFixed(4)}[prog]`)
  } else {
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[clipmix]`)
    filters.push(`[clipmix]volume=${masterVolume.toFixed(4)}[prog]`)
  }

  if (videoHasAudio) filters.push(`[0:a][prog]amix=inputs=2:normalize=0:dropout_transition=0[aout]`)
  else filters.push(`[prog]anull[aout]`)

  const args: string[] = ['-y']
  for (const p of inputPaths) args.push('-i', p)
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '256k',
    '-shortest',
    outPath,
  )
  return args
}
