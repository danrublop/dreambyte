/**
 * Native music composer — ML melody generation.
 *
 * Generates a chord-conditioned lead melody with Magenta's ImprovRNN, running in an
 * isolated child process (see ml-melody-worker.cjs). Fully local + $0: the model
 * weights are cached on disk (scripts/assets/fetch-magenta.mjs), no per-use network.
 *
 *   chord progression (C-ref) ──► worker (ImprovRNN) ──► NoteSequence (quantized steps)
 *                                                          │  + offset (→ key), × secPerStep
 *                                                          ▼
 *                                                        NoteEvent[] on the lead channel
 *
 * STOCHASTIC: ImprovRNN sampling is non-deterministic, so a track using an ML lead
 * must NOT be served from the spec-hash cache (the caller uses a unique filename).
 * Failure is graceful — returns [] so the composer falls back to the template lead.
 */
import { spawnMagentaWorker, resolveMagentaCheckpoint, resolveMagentaWorker } from './ml-worker'
import type { NoteEvent } from './render'

// Re-exported for callers (and the melody test) that import it from here.
export { resolveMagentaCheckpoint } from './ml-worker'

const STEPS_PER_BAR = 16 // stepsPerQuarter (4) × 4 beats

/**
 * Normalize a chord symbol to Magenta's chord vocabulary. Tonal (which the templates
 * use) writes minor as "min" (Amin7, Amin); Magenta's parser only accepts "m" (Am7,
 * Am) and throws "Unrecognized chord symbol" otherwise. Everything else in the template
 * vocabulary (maj7, m7, 7, sus4, plain triads) Magenta already accepts.
 */
function magentaChord(sym: string): string {
  return sym.replace(/min/g, 'm')
}

export interface MlMelodyOptions {
  /** C-reference chord symbols, one per core bar (same ones the template voices). */
  chordsInC: string[]
  /** Semitone transpose applied to the generated pitches (→ the target key). */
  offset: number
  secPerBeat: number
  /** Absolute time where the core section begins (the lead doesn't play in the intro). */
  startSec: number
  leadChannel: number
  intensity: number
  /** 0.5 (safe) .. 1.5 (wild). Default 1.0. */
  temperature?: number
  timeoutMs?: number
}

interface WorkerNote {
  pitch: number
  quantizedStartStep: number
  quantizedEndStep: number
}

/**
 * Generate an ML lead line as NoteEvents on the lead channel. Returns [] on any
 * failure so the caller falls back to the template lead.
 */
export async function generateMlMelody(opts: MlMelodyOptions): Promise<NoteEvent[]> {
  const checkpointDir = resolveMagentaCheckpoint()
  const workerPath = resolveMagentaWorker('ml-melody-worker.cjs')
  if (!checkpointDir || !workerPath || opts.chordsInC.length === 0) return []

  const steps = opts.chordsInC.length * STEPS_PER_BAR
  let notes: WorkerNote[]
  try {
    const res = await spawnMagentaWorker(
      workerPath,
      {
        checkpointDir,
        chords: opts.chordsInC.map(magentaChord),
        steps,
        temperature: opts.temperature ?? 1.0,
        seedPitch: 60,
      },
      opts.timeoutMs ?? 25_000,
      'ML melody',
    )
    notes = (res.notes as WorkerNote[]) ?? []
  } catch {
    return []
  }

  const secPerStep = opts.secPerBeat / 4
  const vel = Math.round(54 + 30 * opts.intensity)
  const events: NoteEvent[] = []
  for (const n of notes) {
    const pitch = (n.pitch ?? 0) + opts.offset
    if (pitch < 0 || pitch > 127) continue
    const startSec = opts.startSec + n.quantizedStartStep * secPerStep
    const durSec = Math.max(secPerStep, (n.quantizedEndStep - n.quantizedStartStep) * secPerStep) * 0.95
    events.push({ channel: opts.leadChannel, note: pitch, velocity: vel, startSec, durSec })
  }
  return events
}
