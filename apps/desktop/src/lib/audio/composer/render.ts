/**
 * Native music composer — offline render engine.
 *
 * Pure-JS, no external provider, $0. Renders a note-event arrangement against a
 * General-MIDI SoundFont entirely in Node via spessasynth_core (Apache-2.0), then
 * encodes a 16-bit stereo WAV. The produced file is attached as a scene MusicTrack
 * and consumed UNCHANGED by preview + the ffmpeg export path.
 *
 * Pipeline:
 *
 *   Arrangement(events)                spessasynth_core (offline, Node)
 *     │  per-channel programChange   ┌─ SoundBankLoader.fromArrayBuffer(sf)  (cached by path)
 *     │  note on/off frame queue ───►│  SpessaSynthProcessor(44100)
 *     │  (sample-accurate)           │  process(L,R,0,n) in 128-frame blocks,
 *     ▼                              │   sliced at event boundaries
 *   stereo Float32 [L,R] ───────────┴► audioToWav([L,R], SR) ──► 16-bit PCM WAV
 *
 * The SoundBank decode is the only expensive step; it is cached per path so the
 * second render reuses it. The SpessaSynthProcessor is per-render (it is
 * stateful and cheap to construct).
 */
import { readFile, writeFile } from 'node:fs/promises'
import {
  SpessaSynthProcessor,
  SoundBankLoader,
  audioToWav,
  SPESSA_BUFSIZE,
  type BasicSoundBank,
} from 'spessasynth_core'

export const SAMPLE_RATE = 44100
/** Extra render time after the last note so release/reverb tails aren't clipped. */
export const RELEASE_TAIL_SEC = 1.5
/** Hard ceiling on rendered length — a backstop; the arrangement spec caps (bars/
 *  sections/events) enforced upstream keep real renders far below this. */
export const MAX_RENDER_SEC = 600
const BLOCK = SPESSA_BUFSIZE // 128 frames — spessasynth's native block size

/** GM drum channel (0-indexed channel 9 == MIDI channel 10). */
export const DRUM_CHANNEL = 9

export interface NoteEvent {
  /** 0-15; channel 9 is the GM drum kit. */
  channel: number
  /** MIDI note 0-127. */
  note: number
  /** 1-127. */
  velocity: number
  /** Onset in seconds from arrangement start. */
  startSec: number
  /** Sounding duration in seconds. */
  durSec: number
}

export interface ChannelProgram {
  channel: number
  /** GM program number 0-127 (for drums, the kit number). */
  program: number
  /**
   * Mark this channel as a drum channel. Defaults to true on the GM drum channel
   * (9). On a drum channel `programChange` selects the kit; the channel must be
   * flagged as percussion first via `MIDIChannel.setDrums(true)` (channel 9 is
   * percussion by default, but we set it explicitly so any channel can host drums).
   */
  drums?: boolean
  /**
   * Reverb send level 0-127 (MIDI CC91). The bundled soundfont's default reverb is
   * weak; an explicit send adds audible room/air (verified: a 127 send lifts the
   * post-note decay tail ~28 dB above dry).
   */
  reverb?: number
}

/** MIDI Reverb Send controller number (CC91). */
const REVERB_SEND_CC = 91

export interface Arrangement {
  /** Musical length in seconds (excludes the release tail). */
  durationSec: number
  /** Program (instrument) per channel. Channels without an entry default to program 0. */
  channels: ChannelProgram[]
  events: NoteEvent[]
}

export interface RenderResult {
  left: Float32Array
  right: Float32Array
  /** Total rendered frames (musical region + release tail). */
  frames: number
  /** Musical region length actually rendered (clamped to MAX_RENDER_SEC). */
  durationSec: number
  /** RMS over the musical region (excludes the tail) — used to assert non-silence. */
  rms: number
}

// SoundBank decode (~40MB parse) cached by path; this is the only heavy step.
const bankCache = new Map<string, BasicSoundBank>()

/** Reset the SoundBank cache — test seam + a place to hook eviction later. */
export function clearSoundBankCache(): void {
  bankCache.clear()
}

async function loadSoundBank(sfPath: string): Promise<BasicSoundBank> {
  const cached = bankCache.get(sfPath)
  if (cached) return cached
  const buf = await readFile(sfPath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const bank = SoundBankLoader.fromArrayBuffer(ab)
  bankCache.set(sfPath, bank)
  return bank
}

const clampVel = (v: number): number => Math.max(1, Math.min(127, Math.round(v)))

/**
 * Render an arrangement to stereo Float32 buffers. Events are fired sample-accurately
 * by slicing each render block at the next event boundary.
 */
export async function renderArrangement(arr: Arrangement, sfPath: string): Promise<RenderResult> {
  const durationSec = Math.min(Math.max(arr.durationSec || 0, 0), MAX_RENDER_SEC)
  const totalFrames = Math.ceil((durationSec + RELEASE_TAIL_SEC) * SAMPLE_RATE)

  const bank = await loadSoundBank(sfPath)
  const synth = new SpessaSynthProcessor(SAMPLE_RATE)
  await synth.processorInitialized
  synth.soundBankManager.addSoundBank(bank, 'main')
  for (const cp of arr.channels) {
    const isDrums = cp.drums ?? cp.channel === DRUM_CHANNEL
    if (isDrums) synth.midiChannels[cp.channel]?.setDrums(true)
    synth.programChange(cp.channel, cp.program)
    if (cp.reverb != null) {
      synth.controllerChange(cp.channel, REVERB_SEND_CC, Math.max(0, Math.min(127, Math.round(cp.reverb))))
    }
  }

  // Build a frame-sorted on/off queue. An off-frame is forced at least 1 frame after
  // its on-frame so a zero-duration event still articulates.
  type Ev = { frame: number; on: boolean; ch: number; note: number; vel: number }
  const queue: Ev[] = []
  for (const e of arr.events) {
    const onF = Math.max(0, Math.round(e.startSec * SAMPLE_RATE))
    const offF = Math.max(onF + 1, Math.round((e.startSec + e.durSec) * SAMPLE_RATE))
    queue.push({ frame: onF, on: true, ch: e.channel, note: e.note, vel: clampVel(e.velocity) })
    queue.push({ frame: offF, on: false, ch: e.channel, note: e.note, vel: 0 })
  }
  // Off before on at the same frame so re-triggers on one note retrigger cleanly.
  queue.sort((a, b) => a.frame - b.frame || Number(a.on) - Number(b.on))

  const L = new Float32Array(totalFrames)
  const R = new Float32Array(totalFrames)
  const lb = new Float32Array(BLOCK)
  const rb = new Float32Array(BLOCK)

  let pos = 0
  let qi = 0
  while (pos < totalFrames) {
    while (qi < queue.length && queue[qi].frame <= pos) {
      const ev = queue[qi++]
      if (ev.on) synth.noteOn(ev.ch, ev.note, ev.vel)
      else synth.noteOff(ev.ch, ev.note)
    }
    const nextBoundary = qi < queue.length ? queue[qi].frame : totalFrames
    const n = Math.min(BLOCK, totalFrames - pos, Math.max(1, nextBoundary - pos))
    lb.fill(0)
    rb.fill(0)
    synth.process(lb, rb, 0, n)
    L.set(lb.subarray(0, n), pos)
    R.set(rb.subarray(0, n), pos)
    pos += n
  }
  // NOTE: do NOT call synth.destroySynthProcessor() here. The SpessaSynthProcessor
  // shares the cached BasicSoundBank (decoded once per path); destroying the
  // processor frees that shared SoundBank's sample data, silencing every SUBSEQUENT
  // render that reuses the cache. The processor itself is lightweight and GC'd; the
  // soundbank is intentionally retained for reuse.

  const region = Math.min(Math.floor(durationSec * SAMPLE_RATE), totalFrames)
  let sum = 0
  for (let i = 0; i < region; i++) sum += L[i] * L[i] + R[i] * R[i]
  const rms = region > 0 ? Math.sqrt(sum / (region * 2)) : 0

  return { left: L, right: R, frames: totalFrames, durationSec, rms }
}

/** Encode a render to a 16-bit stereo PCM WAV (spessasynth's own encoder).
 *  `normalizeAudio: false` — audioToWav peak-normalizes to full scale by default,
 *  which would defeat the mastering chain's true-peak ceiling AND shift its
 *  BS.1770 loudness target. The master (or the raw render) owns the output level;
 *  the encoder must not re-scale it. */
export function encodeWav(result: RenderResult): Uint8Array {
  // Finite guard (output chokepoint): covers EVERY path to a composer WAV — the
  // mastered path, the no-master path (now un-normalized), and any future caller.
  // A non-finite sample reaching audioToWav writes garbage/zero bytes silently;
  // clamp it to 0 so a corrupt render can never ship as a "valid" file.
  for (const ch of [result.left, result.right]) {
    for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) ch[i] = 0
  }
  const ab = audioToWav([result.left, result.right], SAMPLE_RATE, { normalizeAudio: false })
  return new Uint8Array(ab)
}

/**
 * Render an arrangement and write the WAV to disk. Returns render metadata.
 * When `masterPreset` is given, the mastering chain is applied to the
 * stereo buffer before WAV encode — glue comp, tonal EQ, saturation, width, a
 * true-peak limiter, and a BS.1770 stem-loudness normalize. Pure + deterministic.
 */
export async function renderArrangementToFile(
  arr: Arrangement,
  sfPath: string,
  outPath: string,
  masterPreset?: import('./master').MasterPreset,
): Promise<{ durationSec: number; rms: number; bytes: number; lufs?: number; truePeakDb?: number }> {
  const result = await renderArrangement(arr, sfPath)
  let lufs: number | undefined
  let truePeakDb: number | undefined
  if (masterPreset) {
    const { applyMaster } = await import('./master')
    const m = applyMaster(result.left, result.right, masterPreset)
    lufs = m.measuredLufs
    truePeakDb = m.truePeakDb
  }
  const wav = encodeWav(result)
  await writeFile(outPath, wav)
  return { durationSec: result.durationSec, rms: result.rms, bytes: wav.length, lufs, truePeakDb }
}
