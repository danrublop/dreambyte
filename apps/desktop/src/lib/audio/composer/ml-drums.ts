/**
 * Native music composer — GrooVAE humanized drums.
 *
 * Replaces the deterministic step-grid drums with a GrooVAE-humanized groove:
 * the model takes the template's flat kick/snare/hat grid and INVENTS real
 * micro-timing + velocity (a drummer's feel) instead of seeded jitter.
 *
 *   16-step grid per core bar ──► 2-bar (32-step) NoteSequence segments
 *                                  │  GrooVAE encode→decode (humanize) at our qpm
 *                                  ▼
 *                                NoteEvent[] on the GM drum channel
 *
 * STOCHASTIC (like the ML melody) — a track using ml groove must NOT be served from
 * the spec-hash cache; the caller uses a unique filename. Failure is graceful:
 * returns [] so the composer keeps its deterministic drums.
 *
 * Pitch mapping is round-trip safe: our KICK=36 / SNARE=38 / HAT=42 are the FIRST
 * member of GrooVAE's drum pitch classes 0 / 1 / 2, so decode returns 36/38/42.
 */
import { spawnMagentaWorker, resolveMagentaCheckpoint, resolveMagentaWorker } from './ml-worker'
import { DRUM_CHANNEL, type NoteEvent } from './render'

const STEPS_PER_BAR = 16
const BARS_PER_SEGMENT = 2 // GrooVAE 2-bar (32-step) window
const KICK = 36
const SNARE = 38
const HAT = 42

export interface MlDrumsOptions {
  /** 16-char step strings ('x' = hit) — the template's drum lanes. */
  kick: string
  snare: string
  hat: string
  /** Number of CORE bars the groove spans. */
  coreBars: number
  secPerBeat: number
  /** Absolute time the core begins (drums don't play in the intro). */
  coreStartSec: number
  /** Tempo (qpm) so GrooVAE renders the groove at the right speed. */
  qpm: number
  timeoutMs?: number
}

interface GrooveNote {
  pitch: number
  startTime: number
  endTime: number
  velocity: number
}

/**
 * Generate humanized drum NoteEvents on the GM drum channel. Returns [] on any
 * failure so the caller falls back to the deterministic step-grid drums.
 */
export async function generateMlDrums(opts: MlDrumsOptions): Promise<NoteEvent[]> {
  const checkpointDir = resolveMagentaCheckpoint('groovae_2bar_humanize')
  const workerPath = resolveMagentaWorker('ml-drums-worker.cjs')
  if (!checkpointDir || !workerPath || opts.coreBars < 1) return []

  // Build 2-bar (32-step) segments from the tiled grid. A note on lane L at step s
  // of core bar b lands at quantizedStartStep = (b % 2) * 16 + s within its segment.
  const lanes: Array<[string, number]> = [
    [opts.kick, KICK],
    [opts.snare, SNARE],
    [opts.hat, HAT],
  ]
  const numSegments = Math.ceil(opts.coreBars / BARS_PER_SEGMENT)
  const segments: Array<Array<{ step: number; pitch: number }>> = []
  for (let si = 0; si < numSegments; si++) {
    const hits: Array<{ step: number; pitch: number }> = []
    for (let localBar = 0; localBar < BARS_PER_SEGMENT; localBar++) {
      const coreBar = si * BARS_PER_SEGMENT + localBar
      if (coreBar >= opts.coreBars) break // odd core: trailing bar stays empty
      for (const [pattern, pitch] of lanes) {
        for (let s = 0; s < STEPS_PER_BAR; s++) {
          if (pattern[s] === 'x') hits.push({ step: localBar * STEPS_PER_BAR + s, pitch })
        }
      }
    }
    segments.push(hits)
  }
  if (segments.every((s) => s.length === 0)) return []

  let outSegments: GrooveNote[][]
  try {
    const res = await spawnMagentaWorker(
      workerPath,
      { checkpointDir, segments, qpm: opts.qpm },
      opts.timeoutMs ?? 25_000,
      'ML drums',
    )
    outSegments = (res.segments as GrooveNote[][]) ?? []
  } catch {
    return []
  }

  const secPerBar = opts.secPerBeat * 4
  const coreEndSec = opts.coreStartSec + opts.coreBars * secPerBar
  const events: NoteEvent[] = []
  for (let si = 0; si < outSegments.length; si++) {
    const segStart = opts.coreStartSec + si * BARS_PER_SEGMENT * secPerBar
    for (const n of outSegments[si] ?? []) {
      const startSec = segStart + (Number.isFinite(n.startTime) ? n.startTime : 0)
      if (startSec < opts.coreStartSec || startSec >= coreEndSec) continue // clamp to the core
      // GrooVAE velocity is 0-127; tolerate a 0-1 normalized output just in case.
      let vel = n.velocity
      if (vel > 0 && vel <= 1) vel *= 127
      const velocity = Math.max(1, Math.min(127, Math.round(vel || 80)))
      const durSec = Math.max(0.04, (Number.isFinite(n.endTime) ? n.endTime : 0) - (n.startTime || 0))
      events.push({ channel: DRUM_CHANNEL, note: n.pitch, velocity, startSec, durSec })
    }
  }
  return events
}
