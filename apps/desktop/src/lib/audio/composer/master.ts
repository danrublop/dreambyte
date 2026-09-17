/**
 * Native music composer — mastering chain.
 *
 * Pure-JS Float32 sample processing in the Node render path. NOT Web Audio: the
 * composer runs in the Electron main / Node process (no Web Audio API), and Web
 * Audio nodes (DynamicsCompressor / ConvolverReverb) are not bit-reproducible,
 * which would break the deterministic dedupe cache + tests. Every stage here is a
 * pure arithmetic function of the input samples — no RNG, no Date, no context —
 * so identical input → identical bytes, on every OS, packaged or not.
 *
 * Slots into render.ts between renderArrangement() and encodeWav(): the raw
 * spessasynth soundfont sum is "mixed" only by a static per-role velocity scalar
 * + a fixed reverb send, which is the main "MIDI-demo" tell. This applies a real
 * master: glue compression, tonal EQ, harmonic saturation, stereo width, a
 * true-peak-aware brickwall limiter, and a BS.1770 loudness normalize.
 *
 *   [L,R] ─► HPF ─► bus comp ─► tilt/shelf EQ ─► tanh sat ─► M/S widen
 *         ─► lookahead limiter (-1 dBTP) ─► BS.1770 normalize (STEM target) ─► out
 *
 * LOUDNESS (plan decision 1, refined by outside voice): this normalizes the music
 * to a STEM target (~ -16 LUFS), NOT a -14 program target. The export's
 * normalizeFinalAudio is opt-in per scene (usually OFF), and the music plays under
 * narration at MusicTrack.volume 0.18, so the stem target is the calibration knob
 * the export acceptance tests (T1b) tune — the master must NOT assume a final
 * loudnorm will rescue it.
 *
 * Refs: BS.1770-5 K-weighting + gated loudness; RBJ biquad cookbook; tanh
 * soft-clip; lookahead-limiter peak-hold.
 */

const SR = 44100

// ── Biquad (RBJ cookbook), Transposed Direct Form II, per-channel state ───────

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

type BiquadKind = 'highpass' | 'lowshelf' | 'highshelf' | 'peaking'

/** Compute normalized RBJ biquad coefficients (a0 divided out). */
function makeBiquad(kind: BiquadKind, freq: number, q: number, gainDb = 0): Biquad {
  const w0 = (2 * Math.PI * freq) / SR
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const alpha = sinw / (2 * q)
  const A = Math.pow(10, gainDb / 40)
  let b0 = 1
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0
  switch (kind) {
    case 'highpass': {
      b0 = (1 + cosw) / 2
      b1 = -(1 + cosw)
      b2 = (1 + cosw) / 2
      a0 = 1 + alpha
      a1 = -2 * cosw
      a2 = 1 - alpha
      break
    }
    case 'lowshelf': {
      const ap = A + 1
      const am = A - 1
      const sq = 2 * Math.sqrt(A) * alpha
      b0 = A * (ap - am * cosw + sq)
      b1 = 2 * A * (am - ap * cosw)
      b2 = A * (ap - am * cosw - sq)
      a0 = ap + am * cosw + sq
      a1 = -2 * (am + ap * cosw)
      a2 = ap + am * cosw - sq
      break
    }
    case 'highshelf': {
      const ap = A + 1
      const am = A - 1
      const sq = 2 * Math.sqrt(A) * alpha
      b0 = A * (ap + am * cosw + sq)
      b1 = -2 * A * (am + ap * cosw)
      b2 = A * (ap + am * cosw - sq)
      a0 = ap - am * cosw + sq
      a1 = 2 * (am - ap * cosw)
      a2 = ap - am * cosw - sq
      break
    }
    case 'peaking': {
      b0 = 1 + alpha * A
      b1 = -2 * cosw
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cosw
      a2 = 1 - alpha / A
      break
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Process one channel through a biquad in place (TDF-II). Fresh state per call. */
function runBiquad(x: Float32Array, bq: Biquad): void {
  let z1 = 0
  let z2 = 0
  const { b0, b1, b2, a1, a2 } = bq
  for (let i = 0; i < x.length; i++) {
    const xn = x[i]
    const yn = b0 * xn + z1
    z1 = b1 * xn - a1 * yn + z2
    z2 = b2 * xn - a2 * yn
    x[i] = yn
  }
}

// ── Master preset ─────────────────────────────────────────────────────────────

export interface MasterPreset {
  /** High-pass corner (Hz) — strips DC/sub that eats limiter headroom. */
  hpfHz: number
  comp: { thresholdDb: number; ratio: number; kneeDb: number; attackSec: number; releaseSec: number }
  eq: {
    lowShelf: { freq: number; gainDb: number }
    highShelf: { freq: number; gainDb: number }
    bell: { freq: number; q: number; gainDb: number }
  }
  sat: { driveDb: number; mix: number }
  /** Mid/side width factor; 1 = unchanged, >1 wider. Bass stays mono-safe. */
  width: number
  /** Brickwall ceiling in dBTP (true-peak). */
  limiterCeilingDb: number
  /** Integrated-loudness STEM target (LUFS). NOT a -14 program target. */
  stemLufs: number
}

const CORPORATE: MasterPreset = {
  hpfHz: 30,
  comp: { thresholdDb: -18, ratio: 2.5, kneeDb: 6, attackSec: 0.025, releaseSec: 0.18 },
  eq: {
    lowShelf: { freq: 90, gainDb: 1.5 },
    highShelf: { freq: 8000, gainDb: 2.5 },
    bell: { freq: 350, q: 1.0, gainDb: -1.5 },
  },
  sat: { driveDb: 3, mix: 0.25 },
  width: 1.15,
  limiterCeilingDb: -1.0,
  stemLufs: -16,
}

export const MASTER_PRESETS: Record<string, MasterPreset> = {
  corporate: CORPORATE,
  lofi: {
    hpfHz: 40,
    comp: { thresholdDb: -16, ratio: 2.5, kneeDb: 6, attackSec: 0.02, releaseSec: 0.2 },
    eq: {
      lowShelf: { freq: 100, gainDb: 2 },
      highShelf: { freq: 10000, gainDb: -2 }, // darker
      bell: { freq: 400, q: 1.0, gainDb: -2 },
    },
    sat: { driveDb: 4, mix: 0.35 }, // grittier
    width: 1.05,
    limiterCeilingDb: -1.0,
    stemLufs: -17,
  },
  cinematic: {
    hpfHz: 25,
    comp: { thresholdDb: -20, ratio: 1.8, kneeDb: 6, attackSec: 0.05, releaseSec: 0.4 }, // slow, transparent
    eq: {
      lowShelf: { freq: 80, gainDb: 1 },
      highShelf: { freq: 9000, gainDb: 3 }, // air
      bell: { freq: 350, q: 1.0, gainDb: 0 }, // no mud cut — preserve warmth
    },
    sat: { driveDb: 2, mix: 0.15 }, // clean
    width: 1.25, // wide strings
    limiterCeilingDb: -1.0,
    stemLufs: -16,
  },
  synthwave: {
    hpfHz: 35,
    comp: { thresholdDb: -16, ratio: 3, kneeDb: 4, attackSec: 0.01, releaseSec: 0.12 }, // tight
    eq: {
      lowShelf: { freq: 70, gainDb: 2 },
      highShelf: { freq: 10000, gainDb: 2 },
      bell: { freq: 300, q: 1.0, gainDb: -1 },
    },
    sat: { driveDb: 4, mix: 0.3 },
    width: 1.2,
    limiterCeilingDb: -1.0,
    stemLufs: -15,
  },
}

/** Map a composer template id → master preset (decision 2 / arch). */
export function presetForTemplate(templateId: string | undefined): MasterPreset {
  switch (templateId) {
    case 'lofi':
      return MASTER_PRESETS.lofi
    case 'ambient':
    case 'cinematic':
    case 'tension':
      return MASTER_PRESETS.cinematic
    case 'dnb':
    case 'synthwave':
      return MASTER_PRESETS.synthwave
    default: // corporate / upbeat / folk / unknown
      return MASTER_PRESETS.corporate
  }
}

// ── Stages ────────────────────────────────────────────────────────────────────

/** Bus compressor: dB-domain feed-forward, soft-knee, stereo-linked sidechain. */
function compress(L: Float32Array, R: Float32Array, c: MasterPreset['comp']): void {
  const aA = Math.exp(-1 / (c.attackSec * SR))
  const aR = Math.exp(-1 / (c.releaseSec * SR))
  const W = c.kneeDb
  const thr = c.thresholdDb
  const ratio = c.ratio
  // Auto make-up: roughly half the static gain reduction at threshold.
  const makeup = Math.pow(10, (-thr * (1 - 1 / ratio) * 0.5) / 20)
  let envDb = 0 // current gain reduction in dB (>= 0)
  for (let i = 0; i < L.length; i++) {
    const detect = Math.max(Math.abs(L[i]), Math.abs(R[i]))
    const xDb = 20 * Math.log10(Math.max(detect, 1e-9))
    const over = xDb - thr
    let targetGr: number
    if (2 * over < -W) targetGr = 0
    else if (2 * over > W) targetGr = over - over / ratio
    else {
      const t = over + W / 2
      targetGr = (((1 / ratio - 1) * (t * t)) / (2 * W)) * -1
    }
    // Envelope toward more reduction with attack, toward less with release.
    const coeff = targetGr > envDb ? aA : aR
    envDb = coeff * envDb + (1 - coeff) * targetGr
    const g = Math.pow(10, -envDb / 20) * makeup
    L[i] *= g
    R[i] *= g
  }
}

/** Harmonic saturator: tanh soft-clip, level-compensated, parallel-blended. */
function saturate(x: Float32Array, s: MasterPreset['sat']): void {
  const pre = Math.pow(10, s.driveDb / 20)
  const norm = Math.tanh(pre) || 1
  const mix = s.mix
  for (let i = 0; i < x.length; i++) {
    const wet = Math.tanh(pre * x[i]) / norm
    x[i] = (1 - mix) * x[i] + mix * wet
  }
}

/** Mid/side widener with a bass-mono guard (low side energy stays centered). */
function widen(L: Float32Array, R: Float32Array, width: number): void {
  if (width === 1) return
  // One-pole low-pass on the side signal extracts its low band, which stays at
  // width 1 (centered) so bass never decorrelates — sum-to-mono safe for video.
  const cutoff = 150
  const rc = 1 / (2 * Math.PI * cutoff)
  const dt = 1 / SR
  const a = dt / (rc + dt)
  let sLow = 0
  for (let i = 0; i < L.length; i++) {
    const m = (L[i] + R[i]) * 0.5
    const s = (L[i] - R[i]) * 0.5
    sLow += a * (s - sLow) // low band of side (stays at width 1)
    const sHigh = s - sLow
    const sOut = sLow + sHigh * width
    L[i] = m + sOut
    R[i] = m - sOut
  }
}

/**
 * Look-ahead brickwall limiter, true-peak-aware (2× oversampled detection).
 * Delays the signal by the look-ahead window so reduction is in place before the
 * peak. Returns nothing; clamps to the ceiling.
 */
function limit(L: Float32Array, R: Float32Array, ceilingDb: number): void {
  const ceiling = Math.pow(10, ceilingDb / 20)
  const LA = Math.max(1, Math.round(0.0015 * SR)) // 1.5 ms look-ahead
  const releaseCoeff = Math.exp(-1 / (0.05 * SR)) // 50 ms release
  const n = L.length
  // True-peak estimate per sample: max of |x| and the midpoint to the next sample.
  const tp = (x: Float32Array, i: number): number => {
    const a = Math.abs(x[i])
    if (i + 1 >= x.length) return a
    const mid = Math.abs((x[i] + x[i + 1]) * 0.5)
    return Math.max(a, mid)
  }
  // reqGain[i] = gain needed to tame the loudest (true-)peak in the look-ahead
  // window [i, i+LA]. Because it scans AHEAD, the gain already dips before the
  // peak arrives — so it applies to the UN-delayed signal directly (no separate
  // delay line; an earlier delay-line version misaligned the reduction by LA
  // samples and let peaks through — caught by ffmpeg, not the synthetic test).
  const reqGain = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let peak = 0
    const end = Math.min(n - 1, i + LA)
    for (let j = i; j <= end; j++) peak = Math.max(peak, tp(L, j), tp(R, j))
    reqGain[i] = peak > ceiling ? ceiling / peak : 1
  }
  // Instant attack (the look-ahead window IS the attack), one-pole release.
  let g = 1
  for (let i = 0; i < n; i++) {
    const target = reqGain[i]
    g = target < g ? target : releaseCoeff * g + (1 - releaseCoeff) * target
    L[i] *= g
    R[i] *= g
  }
}

// ── BS.1770 integrated loudness ───────────────────────────────────────────────

/** K-weight a copy of the channel (stage-1 shelf + stage-2 RLB high-pass). */
function kWeight(x: Float32Array): Float32Array {
  const y = x.slice()
  // Stage 1: high-shelf ~ +4 dB at 1.5 kHz (the BS.1770 pre-filter).
  runBiquad(y, makeBiquad('highshelf', 1500, 0.707, 4))
  // Stage 2: RLB high-pass ~ 38 Hz.
  runBiquad(y, makeBiquad('highpass', 38, 0.5, 0))
  return y
}

/** Integrated loudness (LUFS) per BS.1770-5: 400ms / 75%-overlap gated blocks. */
export function measureLufs(L: Float32Array, R: Float32Array): number {
  const kL = kWeight(L)
  const kR = kWeight(R)
  const blockLen = Math.round(0.4 * SR)
  const hop = Math.round(0.1 * SR) // 75% overlap
  if (kL.length < blockLen) return -Infinity
  const blocks: number[] = [] // mean-square per block (summed channels)
  for (let start = 0; start + blockLen <= kL.length; start += hop) {
    let sum = 0
    for (let i = start; i < start + blockLen; i++) sum += kL[i] * kL[i] + kR[i] * kR[i]
    blocks.push(sum / blockLen)
  }
  if (blocks.length === 0) return -Infinity
  const lufsOf = (ms: number) => -0.691 + 10 * Math.log10(ms)
  // Absolute gate at -70 LUFS.
  const absGated = blocks.filter((ms) => lufsOf(ms) > -70)
  if (absGated.length === 0) return -Infinity
  const meanAbs = absGated.reduce((a, b) => a + b, 0) / absGated.length
  // Relative gate at -10 LU below the abs-gated mean.
  const relThresh = Math.pow(10, (lufsOf(meanAbs) - 10 + 0.691) / 10)
  const relGated = absGated.filter((ms) => ms >= relThresh)
  const pool = relGated.length > 0 ? relGated : absGated
  const mean = pool.reduce((a, b) => a + b, 0) / pool.length
  return lufsOf(mean)
}

function truePeakDb(L: Float32Array, R: Float32Array): number {
  let peak = 0
  for (let i = 0; i < L.length; i++) {
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
    if (i + 1 < L.length) {
      peak = Math.max(peak, Math.abs((L[i] + L[i + 1]) * 0.5), Math.abs((R[i] + R[i + 1]) * 0.5))
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity
}

export interface MasterResult {
  left: Float32Array
  right: Float32Array
  measuredLufs: number
  truePeakDb: number
}

/**
 * Apply the full mastering chain to a stereo buffer. Pure + deterministic.
 * Mutates the input arrays in place and also returns them with measured loudness.
 */
export function applyMaster(left: Float32Array, right: Float32Array, preset: MasterPreset): MasterResult {
  const L = left
  const R = right
  // Finite guard (entry): a single NaN/Infinity input sample would latch the
  // biquad recursive state to NaN forever, and measureLufs/truePeakDb would then
  // report it as silence — silently shipping a corrupt/zeroed WAV. Quarantine
  // non-finite samples to 0 here so one bad sample can't poison the whole track.
  for (let i = 0; i < L.length; i++) {
    if (!Number.isFinite(L[i])) L[i] = 0
    if (!Number.isFinite(R[i])) R[i] = 0
  }
  // 1. HPF
  runBiquad(L, makeBiquad('highpass', preset.hpfHz, 0.707, 0))
  runBiquad(R, makeBiquad('highpass', preset.hpfHz, 0.707, 0))
  // 2. Bus compressor
  compress(L, R, preset.comp)
  // 3. Bus EQ (low-shelf, high-shelf, de-mud bell)
  for (const ch of [L, R]) {
    runBiquad(ch, makeBiquad('lowshelf', preset.eq.lowShelf.freq, 0.707, preset.eq.lowShelf.gainDb))
    runBiquad(ch, makeBiquad('highshelf', preset.eq.highShelf.freq, 0.707, preset.eq.highShelf.gainDb))
    if (preset.eq.bell.gainDb !== 0) {
      runBiquad(ch, makeBiquad('peaking', preset.eq.bell.freq, preset.eq.bell.q, preset.eq.bell.gainDb))
    }
  }
  // 4. Saturator
  saturate(L, preset.sat)
  saturate(R, preset.sat)
  // 5. Stereo widener
  widen(L, R, preset.width)
  // 6. Look-ahead limiter
  limit(L, R, preset.limiterCeilingDb)
  // 7. BS.1770 normalize to stem target. Single scalar gain. Clamp the boost so a
  //    near-silent stem can't be over-amplified into the limiter; re-limit if the
  //    gain would push true-peak above the ceiling.
  const measured = measureLufs(L, R)
  if (Number.isFinite(measured)) {
    let gainDb = preset.stemLufs - measured
    gainDb = Math.max(-24, Math.min(12, gainDb)) // clamp
    const g = Math.pow(10, gainDb / 20)
    for (let i = 0; i < L.length; i++) {
      L[i] *= g
      R[i] *= g
    }
    // If the boost lifted peaks past the ceiling, re-limit once.
    if (truePeakDb(L, R) > preset.limiterCeilingDb) {
      limit(L, R, preset.limiterCeilingDb)
    }
  }
  return { left: L, right: R, measuredLufs: measureLufs(L, R), truePeakDb: truePeakDb(L, R) }
}
