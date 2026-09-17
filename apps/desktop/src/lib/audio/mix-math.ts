/**
 * mix-math — the SINGLE source of truth for every gain number in the audio
 * pipeline.
 *
 * Before this module the gain formula was re-derived in at least three places
 * (the timeline preview engine, the WebCodecs export, and now the mixer UI).
 * When the same arithmetic is copied it drifts: a clamp here, a missing bus
 * factor there, and preview no longer matches export. Everything that needs a
 * gain — preview, export, mixer faders, meters — composes it from the pure
 * functions here, so the chain is defined exactly once.
 *
 * Convention: gain is a LINEAR multiplier (1.0 = unity = 0 dB), never dB. dB is
 * a display/interaction unit only — the mixer faders convert at the boundary
 * via {@link faderToGain} / {@link gainToFader}. Per-stage gain (clip, track,
 * master) tops out at +6 dB (~2.0), matching the AudioGainRubberBand ceiling
 * that predates the mixer; the fully composed voice gain is hard-capped at
 * +12 dB so stacking three near-max stages can't blow out the bus.
 */

export const UNITY_GAIN = 1
/** Per-stage ceiling (clip envelope, track volume, master volume): +6 dB. */
export const MAX_STAGE_GAIN = 2
/** Hard ceiling on the composed voice (clip × track × master × bus): +12 dB. */
export const MAX_VOICE_GAIN = 4
/** Per-bus gains (tts/music/sfx) can reach +12 dB on their own. */
export const MAX_BUS_GAIN = 4

/** Fader travel maps this dB window to [0,1]. Unity (0 dB) lands at ~0.909. */
export const MIN_FADER_DB = -60
export const MAX_FADER_DB = 6

/**
 * The shared clamp for audio GAIN math (reducers, engine, program-audio).
 * NaN floors to `lo` (silence is the safe default); ±Infinity clamps by sign
 * (Math.min/Math.max handle that) — callers that must treat Infinity as
 * invalid guard with Number.isFinite first. NOTE: layer-tools' grade clamp is
 * intentionally separate — it takes a per-param neutral FALLBACK (e.g. hue
 * NaN → 0, not -180), which is different semantics, not duplication.
 */
export function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

/** dB → linear gain. `-Infinity` dB → 0 (silence). */
export function dbToLinear(db: number): number {
  if (db === -Infinity) return 0
  if (!Number.isFinite(db)) return UNITY_GAIN
  return Math.pow(10, db / 20)
}

/** Linear gain → dB. Gain ≤ 0 → `-Infinity` (silence has no finite dB). */
export function linearToDb(gain: number): number {
  if (!(gain > 0)) return -Infinity
  return 20 * Math.log10(gain)
}

/**
 * Fader position [0,1] → linear gain, on a dB taper (musical, not linear):
 * the bottom of the throw is silence, the top is +6 dB, and equal pixel travel
 * is equal dB — the behaviour every DAW fader has. p ≤ 0 is a true zero, not
 * `dbToLinear(MIN_FADER_DB)`, so muting via the fader is exact silence.
 */
export function faderToGain(pos: number): number {
  const p = clamp(pos, 0, 1)
  if (p <= 0) return 0
  if (p >= 1) return dbToLinear(MAX_FADER_DB)
  return dbToLinear(MIN_FADER_DB + p * (MAX_FADER_DB - MIN_FADER_DB))
}

/** Linear gain → fader position [0,1]. Inverse of {@link faderToGain}. */
export function gainToFader(gain: number): number {
  if (!(gain > 0)) return 0
  const db = clamp(linearToDb(gain), MIN_FADER_DB, MAX_FADER_DB)
  return (db - MIN_FADER_DB) / (MAX_FADER_DB - MIN_FADER_DB)
}

/**
 * Base clip gain = volume slot × keyframed envelope, each clamped to the stage
 * ceiling and the product re-clamped. This is the value the timeline engine's
 * `clipVolumeAt` produces; centralised here so the clamp can't diverge.
 */
export function clipBaseGain(volume: number, envelope: number): number {
  const v = clamp(volume, 0, MAX_STAGE_GAIN)
  const e = clamp(envelope, 0, MAX_STAGE_GAIN)
  return clamp(v * e, 0, MAX_STAGE_GAIN)
}

/** Program master gain, defaulted to unity and clamped to the stage range.
 *  The engine's master GainNode and the export's program mix both read this. */
export function resolveMasterGain(masterVolume: number | null | undefined): number {
  if (!Number.isFinite(masterVolume as number)) return UNITY_GAIN
  return clamp(masterVolume as number, 0, MAX_STAGE_GAIN)
}

export interface VoiceGainParams {
  /** Composed clip gain (e.g. from {@link clipBaseGain}), 0..MAX_STAGE_GAIN. */
  clipGain: number
  /** Per-track fader gain (mixer), 0..MAX_STAGE_GAIN. Default unity. */
  trackVolume?: number
  /** Program master gain, 0..MAX_STAGE_GAIN. Default unity. */
  masterVolume?: number
  /** Per-bus gain for scene-mirror voices (tts/music/sfx), 0..MAX_BUS_GAIN. Default unity. */
  busGain?: number
  /** Track is explicitly muted → silence. */
  muted?: boolean
  /** This track is soloed. */
  solo?: boolean
  /** Any track in the timeline is soloed → non-soloed tracks are silenced. */
  anySolo?: boolean
}

/**
 * The one true voice-gain formula. Everything that drives a GainNode — preview,
 * export, mixer — calls this so preview and export can never disagree.
 *
 * Gating first (mute, and solo-exclusion when any track is soloed), then the
 * multiplicative chain clip × track × master × bus, hard-capped at +12 dB.
 */
export function resolveVoiceGain(p: VoiceGainParams): number {
  if (p.muted) return 0
  if (p.anySolo && !p.solo) return 0
  const clipGain = clamp(p.clipGain, 0, MAX_STAGE_GAIN)
  const track = clamp(p.trackVolume ?? UNITY_GAIN, 0, MAX_STAGE_GAIN)
  const master = clamp(p.masterVolume ?? UNITY_GAIN, 0, MAX_STAGE_GAIN)
  const bus = clamp(p.busGain ?? UNITY_GAIN, 0, MAX_BUS_GAIN)
  return clamp(clipGain * track * master * bus, 0, MAX_VOICE_GAIN)
}
