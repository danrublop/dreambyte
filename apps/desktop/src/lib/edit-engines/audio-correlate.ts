/**
 * Pure normalized cross-correlation core for waveform / envelope alignment.
 *
 * Used by `sync_audio` (dual-system sound / multicam): given two audio energy
 * envelopes sampled at the same rate, find the integer lag that best aligns
 * them and report a confidence in [0, 1].
 *
 * "Pure" means: no ffmpeg, no Electron, no filesystem — same inputs → identical
 * outputs. The decode/envelope steps live upstream (`audio-sync.ts`); this file
 * is exhaustively testable with synthetic signals (see `audio-correlate.test.ts`).
 *
 * Two implementations, same result shape:
 *   - `correlateTimeDomain` — O(N · lags) running-sums Pearson. Exact reference
 *     implementation; the tests pin against it.
 *   - `correlateFft` — O(N log N): one FFT yields the cross-products at every
 *     lag; prefix sums supply each lag's window mean/variance in O(1), so it
 *     computes the SAME per-lag Pearson as the time-domain path (and feeds the
 *     same `summarize`) without the O(N·lags) sweep.
 * `crossCorrelate` picks the cheaper one by size; both return identical results
 * to numerical tolerance (same Pearson, same `summarize`).
 *
 * Confidence is the peak Pearson correlation (mean-removed, variance-normalized),
 * so it is invariant to per-clip gain/level — a quiet recorder and a hot camera
 * mic still score ~1.0 when aligned. `peakRatio` (peak ÷ next-best non-adjacent
 * peak) guards against periodic audio correlating at many lags.
 */

export interface CorrelationResult {
  /**
   * Best lag in samples: the shift to apply to the TARGET to realign it onto the
   * reference. Defined so `reference[i + lag] ≈ target[i]` at the peak. If the
   * target's content occurs `D` samples later than the reference, `lag = -D`
   * (move the target left by D).
   */
  lagSamples: number
  /** Peak Pearson correlation at the best lag, clamped to [0, 1]. */
  confidence: number
  /** Peak ÷ second-highest non-adjacent peak. >1 = a distinct winner. */
  peakRatio: number
}

/** Below this overlap (in samples) a lag is ignored — too little to trust. */
const MIN_OVERLAP = 16

/**
 * `crossCorrelate` routes to the FFT path when the time-domain work proxy
 * (`n · lags`) exceeds this. Rough crossover, not a tuned benchmark — the FFT
 * path is correct at any size, this only picks the faster one.
 */
const FFT_DISPATCH_OPS = 4_000_000

/**
 * Windowed normalized Pearson correlation at a single lag, over the overlap
 *   x = tgt[i],  y = ref[i + lag]   for i in the valid window.
 * Returns the score clamped to [0, 1], or `null` when the overlap is below
 * `MIN_OVERLAP` or a side has zero variance (silence → undefined Pearson).
 * Shared by both correlators so the normalization is byte-identical.
 */
function pearsonAtLag(
  ref: Float64Array,
  tgt: Float64Array,
  lag: number,
): { lag: number; score: number } | null {
  const refLen = ref.length
  const tgtLen = tgt.length
  const iStart = Math.max(0, -lag)
  const iEnd = Math.min(tgtLen, refLen - lag)
  const n = iEnd - iStart
  if (n < MIN_OVERLAP) return null

  let sx = 0
  let sy = 0
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = iStart; i < iEnd; i++) {
    const x = tgt[i]
    const y = ref[i + lag]
    sx += x
    sy += y
    sxx += x * x
    syy += y * y
    sxy += x * y
  }
  const cov = sxy - (sx * sy) / n
  const vx = sxx - (sx * sx) / n
  const vy = syy - (sy * sy) / n
  const denom = Math.sqrt(vx * vy)
  if (!(denom > 0)) return null // zero-variance window (silence) → undefined Pearson
  return { lag, score: Math.max(0, cov / denom) }
}

/**
 * Time-domain normalized cross-correlation. Sweeps every lag in
 * `[-maxLag, +maxLag]`, computing the Pearson correlation over the overlapping
 * region. Exact and simple; the canonical reference the FFT path is checked
 * against.
 *
 * @param reference  energy envelope of the clip that stays put
 * @param target     energy envelope of the clip to align
 * @param maxLag     max |lag| to search, in samples (>= 0)
 */
export function correlateTimeDomain(
  reference: ArrayLike<number>,
  target: ArrayLike<number>,
  maxLag: number,
): CorrelationResult | null {
  const refLen = reference.length
  const tgtLen = target.length
  if (refLen === 0 || tgtLen === 0 || maxLag < 0) return null

  const ref = toFloat64(reference)
  const tgt = toFloat64(target)

  // Per-lag Pearson over the overlap; the canonical exhaustive sweep.
  const scores: { lag: number; score: number }[] = []
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const s = pearsonAtLag(ref, tgt, lag)
    if (s) scores.push(s)
  }

  return summarize(scores)
}

/**
 * FFT-based normalized cross-correlation — O(N log N), exact.
 *
 * One FFT gives the raw cross-products `Σ_i tgt[i]·ref[i+lag]` at EVERY lag at
 * once (in `cross`). Prefix sums of the (globally-centered) envelopes then give
 * each lag's window Σ/Σ² in O(1), so the per-lag Pearson is computed from the
 * SAME formula as `pearsonAtLag` — and the results are fed through the SAME
 * `summarize` the time-domain path uses. So the two paths agree to numerical
 * tolerance on confidence, lag, AND `peakRatio` (no raw-covariance argmax, no
 * `peakRatio` that drifts from the time-domain definition).
 *
 * Global mean-removal before the FFT is purely numerical (shrinks the DC term
 * so the `cov = Σxy − ΣxΣy/n` cancellation keeps precision); centering by a
 * constant leaves covariance and variance unchanged, so the Pearson is identical
 * to the raw-signal computation.
 */
export function correlateFft(
  reference: ArrayLike<number>,
  target: ArrayLike<number>,
  maxLag: number,
): CorrelationResult | null {
  const refLen = reference.length
  const tgtLen = target.length
  if (refLen === 0 || tgtLen === 0 || maxLag < 0) return null

  const ref = toFloat64(reference)
  const tgt = toFloat64(target)
  const meanRef = meanOf(ref)
  const meanTgt = meanOf(tgt)

  // Centered copies — used for BOTH the FFT and the prefix sums so the windowed
  // Pearson below matches the raw-signal Pearson exactly (constant shift is a
  // no-op for cov/var) while keeping the DC term small for numerical stability.
  const xc = new Float64Array(tgtLen)
  const yc = new Float64Array(refLen)
  for (let i = 0; i < tgtLen; i++) xc[i] = tgt[i] - meanTgt
  for (let i = 0; i < refLen; i++) yc[i] = ref[i] - meanRef

  // Linear (not circular) cross-correlation: pad to >= refLen + tgtLen - 1,
  // rounded up to a power of two for the radix-2 FFT.
  const fullLen = refLen + tgtLen - 1
  const size = nextPow2(fullLen)

  const reA = new Float64Array(size)
  const imA = new Float64Array(size)
  const reB = new Float64Array(size)
  const imB = new Float64Array(size)
  reA.set(xc)
  reB.set(yc)

  fft(reA, imA, false)
  fft(reB, imB, false)

  // Pointwise A · conj(B).
  for (let i = 0; i < size; i++) {
    const ar = reA[i]
    const ai = imA[i]
    const br = reB[i]
    const bi = imB[i]
    reA[i] = ar * br + ai * bi
    imA[i] = ai * br - ar * bi
  }
  fft(reA, imA, true) // inverse → reA[k] = Σ_i xc[i]·yc[i−k]

  // Bin → lag: reA[k] = Σ_i xc[i]·yc[i−k], i.e. the cross-product for time-domain
  // lag = −k (we want Σ_i xc[i]·yc[i+lag]). So lag's value lives at index
  // ((−lag) mod size); positive lags wrap to the high end (size − lag).
  const crossAt = (lag: number): number => reA[(((-lag) % size) + size) % size]

  // Prefix sums of the centered signals → window Σ / Σ² in O(1) per lag.
  const preX = prefixSums(xc)
  const preY = prefixSums(yc)

  // Same per-lag Pearson as `pearsonAtLag`, but with the cross term read from the
  // FFT and the window sums from prefix tables. Feeds the shared `summarize`.
  const scores: { lag: number; score: number }[] = []
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const iStart = Math.max(0, -lag)
    const iEnd = Math.min(tgtLen, refLen - lag)
    const n = iEnd - iStart
    if (n < MIN_OVERLAP) continue

    const sx = preX.sum[iEnd] - preX.sum[iStart]
    const sxx = preX.sqSum[iEnd] - preX.sqSum[iStart]
    const sy = preY.sum[iEnd + lag] - preY.sum[iStart + lag]
    const syy = preY.sqSum[iEnd + lag] - preY.sqSum[iStart + lag]
    const sxy = crossAt(lag)

    const cov = sxy - (sx * sy) / n
    const vx = sxx - (sx * sx) / n
    const vy = syy - (sy * sy) / n
    const denom = Math.sqrt(vx * vy)
    if (!(denom > 0)) continue
    scores.push({ lag, score: Math.max(0, cov / denom) })
  }

  return summarize(scores)
}

/**
 * Pick the best lag, returning peak confidence + the secondary-peak ratio.
 * The peakRatio uses the highest score at least 3 lags away from the winner so
 * a smooth correlation shoulder doesn't count against a real peak.
 */
function summarize(scores: { lag: number; score: number }[]): CorrelationResult | null {
  if (scores.length === 0) return null
  let best = scores[0]
  for (const s of scores) if (s.score > best.score) best = s

  let second = 0
  for (const s of scores) {
    if (Math.abs(s.lag - best.lag) <= 2) continue
    if (s.score > second) second = s.score
  }
  const peakRatio = second > 1e-9 ? best.score / second : Infinity
  return { lagSamples: best.lag, confidence: best.score, peakRatio }
}

/**
 * Choose the cheaper correlator. The time-domain sweep is O(N · lags); FFT is
 * O(N log N) but with a constant overhead, so it only wins on big inputs with a
 * wide lag window. Both return identical results to numerical tolerance.
 */
export function crossCorrelate(
  reference: ArrayLike<number>,
  target: ArrayLike<number>,
  maxLag: number,
): CorrelationResult | null {
  const n = Math.max(reference.length, target.length)
  const lags = 2 * maxLag + 1
  // Time-domain work ~ n·lags; FFT work ~ size·log2(size) + per-lag windows.
  // Use FFT when the direct product is large.
  if (n * lags > FFT_DISPATCH_OPS) return correlateFft(reference, target, maxLag)
  return correlateTimeDomain(reference, target, maxLag)
}

/**
 * Prefix sums of a signal and its squares: `sum[k] = Σ_{i<k} a[i]`,
 * `sqSum[k] = Σ_{i<k} a[i]²` (both length `a.length + 1`). Lets the FFT path
 * read any window's Σ / Σ² in O(1).
 */
function prefixSums(a: Float64Array): { sum: Float64Array; sqSum: Float64Array } {
  const sum = new Float64Array(a.length + 1)
  const sqSum = new Float64Array(a.length + 1)
  for (let i = 0; i < a.length; i++) {
    sum[i + 1] = sum[i] + a[i]
    sqSum[i + 1] = sqSum[i] + a[i] * a[i]
  }
  return { sum, sqSum }
}

function meanOf(a: Float64Array): number {
  if (a.length === 0) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s / a.length
}

function toFloat64(a: ArrayLike<number>): Float64Array {
  if (a instanceof Float64Array) return a
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]
  return out
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/**
 * In-place iterative radix-2 Cooley–Tukey FFT. `re`/`im` are same-length
 * power-of-two buffers; `inverse` toggles the sign + 1/N scaling. No external
 * deps — keeps this module pure and dependency-free.
 */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  if (n <= 1) return

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }

  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + half] = aRe - bRe
        im[i + k + half] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}
