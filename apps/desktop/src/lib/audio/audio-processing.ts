/**
 * Shared audio-mix resolution + loudnorm argument builders.
 *
 * Single source of truth for clamping/defaults of the agent-controllable audio
 * mix (master/category gain, ducking params, normalization intent). Consumed by:
 *   - the set_audio_mix tool handler (validate/merge),
 *   - the Web Audio export path (src/lib/export2/pixi-mp4.ts),
 *   - the Electron Tier-3 FFmpeg path (src/electron/ipc/export-tier3.ts), which passes
 *     the resolved object into packages/render-server/audio-mixer.js (a dumb consumer).
 *
 * DESIGN:
 *   - Gain + ducking are PER SCENE. Per-category gain is a bus layer:
 *       final = clip.volume × categoryGain × masterGain.
 *   - Normalization is PROGRAM-level: applied ONCE, post-stitch, as a single
 *     FFmpeg loudnorm pass on the final concatenated video (see the loudnorm arg
 *     builders below). Never per-scene — per-scene targets don't survive
 *     stitch/crossfade, and a quiet interstitial would be wrongly boosted.
 *   - The per-scene FFmpeg FILTERGRAPH lives in packages/render-server/audio-filter.js
 *     (plain JS, so audio-mixer.js can import it without a TS build step). This
 *     module only owns the pure resolve + loudnorm-string logic.
 *
 * The render-server JS reads the SAME numeric field names this resolver emits,
 * so when audioProcessing is absent the resolved defaults reproduce today's
 * behavior byte-for-byte (the critical regression guard).
 */
import type { AudioProcessing } from '@/lib/types/audio'

// NOTE: packages/render-server/audio-filter.js mirrors these literals in its resolved=null
// legacy branch (it's plain JS and can't import this TS const without a build
// step). That duplication is deliberate — it's the byte-identical regression
// guard — but if you tune a default here, update the JS fallback to match.
export const AUDIO_MIX_DEFAULTS = {
  masterGain: 1,
  ttsGain: 1,
  musicGain: 1,
  sfxGain: 1,
  /** Social/YouTube integrated-loudness target. YouTube normalizes uploads to ~-14 LUFS. */
  normalizeTargetLufs: -14,
  /** True-peak ceiling in dBTP (Remotion-proven). */
  normalizeTruePeak: -2.0,
  /** Loudness range target in LU. */
  normalizeLra: 7,
  duckLevel: 0.2,
  duckAttackMs: 100,
  duckReleaseMs: 500,
  duckRatio: 10,
} as const

const GAIN_MIN = 0
const GAIN_MAX = 4
const LUFS_MIN = -30
const LUFS_MAX = -9

/** Clamp to [min,max], rejecting NaN / non-finite / non-number to `fallback`. */
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

export interface ResolvedDucking {
  /** Authoritative on/off gate (mirrored to MusicTrack.duckDuringTTS by the tool). */
  enabled: boolean
  duckLevel: number
  attackMs: number
  releaseMs: number
  ratio: number
}

export interface ResolvedNormalize {
  enabled: boolean
  targetLufs: number
}

export interface ResolvedAudioProcessing {
  masterGain: number
  ttsGain: number
  musicGain: number
  sfxGain: number
  normalize: ResolvedNormalize
  ducking: ResolvedDucking
}

/**
 * Clamp + default a raw AudioProcessing into a fully-populated resolved object.
 * `undefined`/`null` ⇒ all defaults (gains 1, normalize off, ducking off) —
 * which the downstream mixers treat as "behave exactly as before".
 */
export function resolveAudioProcessing(raw?: AudioProcessing | null): ResolvedAudioProcessing {
  const p = raw ?? {}
  const d = p.ducking ?? {}
  const n = p.normalize
  return {
    masterGain: clampNum(p.masterGain, GAIN_MIN, GAIN_MAX, AUDIO_MIX_DEFAULTS.masterGain),
    ttsGain: clampNum(p.ttsGain, GAIN_MIN, GAIN_MAX, AUDIO_MIX_DEFAULTS.ttsGain),
    musicGain: clampNum(p.musicGain, GAIN_MIN, GAIN_MAX, AUDIO_MIX_DEFAULTS.musicGain),
    sfxGain: clampNum(p.sfxGain, GAIN_MIN, GAIN_MAX, AUDIO_MIX_DEFAULTS.sfxGain),
    normalize: {
      enabled: n?.enabled === true,
      targetLufs: clampNum(n?.targetLufs, LUFS_MIN, LUFS_MAX, AUDIO_MIX_DEFAULTS.normalizeTargetLufs),
    },
    ducking: {
      enabled: d.enabled === true,
      // Lower bound is a small epsilon, NOT 0: the FFmpeg sidechain uses
      // level_sc=1/duckLevel, so duckLevel=0 would emit "Infinity" and fail the
      // mix (dropping the scene's audio). 0.01 ≈ -40 dB is effectively "fully
      // duck" without the divide-by-zero.
      duckLevel: clampNum(d.duckLevel, 0.01, 1, AUDIO_MIX_DEFAULTS.duckLevel),
      attackMs: clampNum(d.attackMs, 5, 1000, AUDIO_MIX_DEFAULTS.duckAttackMs),
      releaseMs: clampNum(d.releaseMs, 50, 3000, AUDIO_MIX_DEFAULTS.duckReleaseMs),
      ratio: clampNum(d.ratio, 2, 20, AUDIO_MIX_DEFAULTS.duckRatio),
    },
  }
}

/**
 * Deep-merge a partial AudioProcessing patch onto an existing one (for the
 * set_audio_mix tool's partial-update semantics). Nested `normalize`/`ducking`
 * merge field-by-field so an agent can tweak one knob without clobbering the rest.
 */
export function mergeAudioProcessing(
  base: AudioProcessing | null | undefined,
  patch: AudioProcessing,
): AudioProcessing {
  const b = base ?? {}
  return {
    ...b,
    ...patch,
    normalize:
      patch.normalize || b.normalize
        ? { ...(b.normalize ?? { enabled: false }), ...(patch.normalize ?? {}) }
        : undefined,
    ducking: patch.ducking || b.ducking ? { ...(b.ducking ?? {}), ...(patch.ducking ?? {}) } : undefined,
  }
}

/**
 * Pick the program-level normalization target across a video's scenes.
 *
 * Normalization is program-wide (one post-stitch pass), but the intent lives on
 * each scene's audioProcessing. Policy: first scene that enabled it wins. Shared
 * by both export finalize paths (Tier-3 + pixi/concatMp4) so the policy can't
 * drift. `conflict` is true when more than one scene enabled normalization with
 * DIFFERENT targets — the caller should surface that (the non-first targets are
 * silently dropped otherwise).
 */
export function resolveProgramNormalizeTarget(
  audioLayers: Array<{ audioProcessing?: AudioProcessing | null } | null | undefined>,
): { targetLufs: number | null; conflict: boolean } {
  let targetLufs: number | null = null
  let conflict = false
  for (const layer of audioLayers) {
    const ap = layer?.audioProcessing
    if (!ap?.normalize?.enabled) continue
    const t = resolveAudioProcessing(ap).normalize.targetLufs
    if (targetLufs == null) targetLufs = t
    else if (t !== targetLufs) conflict = true
  }
  // Default-ON: when no scene overrode the target, normalize the program to the social
  // loudness standard (-14 LUFS) so exports ship at a consistent, platform-appropriate
  // level instead of an arbitrary sum.
  // The finalize path only applies this when the program actually has audio.
  if (targetLufs == null) targetLufs = AUDIO_MIX_DEFAULTS.normalizeTargetLufs
  return { targetLufs, conflict }
}

// ── Post-stitch loudnorm (two-pass: measure → apply) ─────────────────────────
// Built here (pure strings); the spawn + JSON-parse orchestration lives with the
// stitch step. loudnorm wants the measured values from pass 1 fed into pass 2 to
// actually hit the target (single-pass drifts).

/** First-pass `-af` value: measures loudness and prints JSON to stderr. */
export function buildLoudnormMeasureFilter(targetLufs: number = AUDIO_MIX_DEFAULTS.normalizeTargetLufs): string {
  const I = clampNum(targetLufs, LUFS_MIN, LUFS_MAX, AUDIO_MIX_DEFAULTS.normalizeTargetLufs)
  return `loudnorm=I=${I}:TP=${AUDIO_MIX_DEFAULTS.normalizeTruePeak}:LRA=${AUDIO_MIX_DEFAULTS.normalizeLra}:print_format=json`
}

/** Measured values parsed from pass-1 loudnorm JSON. */
export interface LoudnormMeasured {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/** Second-pass `-af` value: applies linear normalization using the measured values. */
export function buildLoudnormApplyFilter(targetLufs: number, m: LoudnormMeasured): string {
  const I = clampNum(targetLufs, LUFS_MIN, LUFS_MAX, AUDIO_MIX_DEFAULTS.normalizeTargetLufs)
  return (
    `loudnorm=I=${I}:TP=${AUDIO_MIX_DEFAULTS.normalizeTruePeak}:LRA=${AUDIO_MIX_DEFAULTS.normalizeLra}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`
  )
}

/** Parse the JSON object loudnorm prints to stderr on the measure pass. Returns
 *  null when the expected fields aren't present (caller falls back to the
 *  un-normalized file rather than failing the export). */
export function parseLoudnormJson(stderr: string): LoudnormMeasured | null {
  // loudnorm prints a JSON block at the end of stderr. Grab the last {...}.
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const obj = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>
    const need = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const
    for (const k of need) if (typeof obj[k] !== 'string') return null
    return {
      input_i: obj.input_i as string,
      input_tp: obj.input_tp as string,
      input_lra: obj.input_lra as string,
      input_thresh: obj.input_thresh as string,
      target_offset: obj.target_offset as string,
    }
  } catch {
    return null
  }
}
