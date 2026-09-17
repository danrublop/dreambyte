/**
 * Native music composer — arrange layer.
 *
 * Turns a template choice + parameters (key / tempo / intensity) + a target scene
 * duration into a concrete {@link Arrangement} of note events that {@link renderArrangement}
 * renders. The agent supplies intent; this layer supplies the musical voice-leading,
 * rhythm, and section dynamics — so output is reliably musical.
 *
 * Structure (multi-section, length-aware, seam-free):
 *
 *   |== intro ==|============= core (progression loops) =============|== outro ==|
 *    sparse pad      pad + keys + bass + drums (+ lead by intensity)    decay
 *
 * The whole scene duration is rendered as ONE continuous timeline, so there is no
 * loop seam to click — "looping the core at a bar boundary" is just the core
 * progression repeating within that continuous render. Intro/outro are dropped when
 * the scene is too short to fit them.
 *
 * Invalid inputs are clamped/snapped and every correction is reported so the
 * agent learns, but a track always renders.
 */
import { Chord, Note } from 'tonal'
import { getTemplate, TEMPLATE_IDS, type Template } from './templates'
import { DRUM_CHANNEL, type Arrangement, type NoteEvent } from './render'

/** Channel assignment per role (drums fixed to the GM drum channel). */
const CHANNELS = { pad: 0, keys: 1, bass: 2, lead: 3, drums: DRUM_CHANNEL } as const

const BEATS_PER_BAR = 4
const STEPS_PER_BAR = 16 // sixteenth-note grid for drums
export const MAX_BARS = 64 // spec cap
const MAX_INTRO_BARS = 2
const MAX_OUTRO_BARS = 2

// GM drum notes.
const KICK = 36
const SNARE = 38
const HAT = 42
const CRASH = 49 // section-boundary accent

export interface ComposeParams {
  templateId: string
  /** Musical key, e.g. 'C minor', 'G major', 'F#m'. Defaults to the template's key. */
  key?: string
  /** Beats per minute. Clamped to the template's range. */
  tempo?: number
  /** 0..1 — drives density, velocity, and whether the lead plays. Default 0.6. */
  intensity?: number
  /** Target length in seconds. */
  sceneDurationSec: number
  /**
   * Lead-line source: 'template' (deterministic, fast — the default) or 'ml'
   * (Magenta ImprovRNN generates a chord-conditioned melody; consumed by the
   * composer entry point, not by compose() itself).
   */
  melody?: 'template' | 'ml'
  /**
   * Drum groove source: 'template' (deterministic step grid + seeded humanization,
   * the default) or 'ml' (GrooVAE humanizes the grid — invents micro-timing +
   * velocity; consumed by the composer entry point, not by compose() itself).
   */
  groove?: 'template' | 'ml'
  /**
   * Override the melodic voices (keys + lead) with a named instrument, so the
   * agent can honor "piano background music", "make it strings", etc. regardless
   * of the template's default instrumentation. Unknown name → kept + a correction.
   */
  instrument?: string
  /**
   * Texture / density: 'full' (the template's band, default), 'minimal' (calm
   * bed — keys + pad + bass, no drums/lead), or 'solo' (just the instrument, e.g.
   * solo piano). minimal/solo play their voices continuously (incl. intro/outro).
   */
  texture?: 'full' | 'minimal' | 'solo'
}

/** Friendly instrument name → GM program. Overrides the keys + lead voices. */
export const INSTRUMENTS: Record<string, number> = {
  piano: 0,
  'electric-piano': 4,
  rhodes: 4,
  'music-box': 10,
  glockenspiel: 9,
  vibraphone: 11,
  bells: 11,
  organ: 19,
  guitar: 24,
  'steel-guitar': 25,
  harp: 46,
  strings: 48,
  synth: 81,
  'synth-lead': 81,
  pad: 89,
  flute: 73,
  sax: 65,
}
export const INSTRUMENT_NAMES = Object.keys(INSTRUMENTS)

export interface ComposeResult {
  arrangement: Arrangement
  corrections: string[]
  meta: { templateId: string; key: string; tempo: number; bars: number; sections: string[] }
  /** Derived facts the ML lead/drums generators need to overlay onto the core. */
  plan: {
    /** C-reference chord symbol per CORE bar (matches how the template voices them). */
    chordsInC: string[]
    /** Semitone transpose to the target key. */
    offset: number
    secPerBeat: number
    /** Absolute time the core section starts (lead is silent during the intro). */
    coreStartSec: number
    leadChannel: number
    /** Tempo (qpm) — GrooVAE renders the humanized groove at this speed. */
    tempo: number
    /** Number of CORE bars (the groove spans these). */
    coreBars: number
    /** The template's raw drum lanes for GrooVAE to humanize, or null if no drums. */
    drumPattern: { kick: string; snare: string; hat: string } | null
    drumChannel: number
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// ── Humanization (deterministic) ─────────────────────────────────────────────
// A dead-flat grid at constant velocity is the #1 "sounds like a MIDI demo" tell.
// We jitter timing + velocity and add swing, but SEED the PRNG from the spec so
// identical params produce identical output — the dedupe cache + determinism
// tests still hold.
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const HUMANIZE_TIMING_SEC = 0.012 // ±12ms — feel, not sloppiness
const HUMANIZE_VEL = 9 // ±9 velocity

// Per-role mix balance — multiplies each role's base velocity. One place to tune
// so pad sits under, bass has weight, lead stays clear, drums punch without dominating.
const MIX = { pad: 0.8, keys: 1.0, bass: 1.1, lead: 0.9, drums: 1.0 }
// Per-role reverb send base (0-127), scaled by the template's `reverb` (0..1).
const REVERB_BASE = { pad: 95, keys: 60, bass: 16, lead: 55, drums: 25 }

/** Parse a key string into a tonic pitch-class and mode. Falls back to the template key. */
function parseKey(key: string | undefined, fallback: string): { tonic: string; minor: boolean; label: string } {
  const raw = (key ?? fallback).trim()
  // tonic = leading note letter (+ optional #/b); mode = presence of "min"/"m".
  const m = raw.match(/^([A-Ga-g][#b]?)\s*(.*)$/)
  const tonic = m ? m[1][0].toUpperCase() + m[1].slice(1) : 'C'
  const rest = (m ? m[2] : '').toLowerCase()
  const minor = /m(in)?\b/.test(rest) || rest === 'm' || /minor/.test(rest)
  return { tonic, minor, label: `${tonic} ${minor ? 'minor' : 'major'}` }
}

/** Semitone offset from C to the target tonic (0..11). */
function tonicOffset(tonic: string): number {
  const m = Note.midi(`${tonic}4`)
  const c = Note.midi('C4')!
  return m == null ? 0 : (((m - c) % 12) + 12) % 12
}

/**
 * Voice a C-reference chord symbol into ascending MIDI notes at a base octave,
 * transposed by the key offset. Returns [] for an unparseable symbol.
 */
function chordToMidi(symbol: string, offset: number, baseOctave: number, maxNotes = 4): number[] {
  const ch = Chord.get(symbol)
  if (!ch.notes || ch.notes.length === 0) return []
  const out: number[] = []
  let prev = -Infinity
  for (const pc of ch.notes.slice(0, maxNotes)) {
    const base = Note.midi(`${pc}${baseOctave}`)
    if (base == null) continue
    let n = base + offset
    while (n <= prev) n += 12 // keep the voicing ascending (no crossed notes)
    out.push(n)
    prev = n
  }
  return out
}

/**
 * Voice a chord with simple voice-leading: snap each chord tone to the octave
 * nearest the PREVIOUS voicing's center, so the harmony moves smoothly (shared/
 * neighbour tones) instead of jumping around or muddying. Root position when there
 * is no previous voicing.
 */
function voiceChord(symbol: string, offset: number, prev: number[] | null, baseOctave: number, maxNotes = 4): number[] {
  const base = chordToMidi(symbol, offset, baseOctave, maxNotes)
  if (base.length === 0 || !prev || prev.length === 0) return base
  const center = prev.reduce((a, b) => a + b, 0) / prev.length
  const led = base.map((m) => {
    let n = m
    while (n - center > 7) n -= 12
    while (center - n > 7) n += 12
    return n
  })
  return Array.from(new Set(led)).sort((a, b) => a - b)
}

export function compose(params: ComposeParams): ComposeResult {
  const corrections: string[] = []

  let template = getTemplate(params.templateId)
  if (!template) {
    const fallback = getTemplate('lofi')!
    corrections.push(`unknown template "${params.templateId}" → "lofi" (valid: ${TEMPLATE_IDS.join(', ')})`)
    template = fallback
  }

  // Instrument override + texture (so "piano background", "solo piano", "make it
  // strings" work on any template). Reassign `template` once with the effective
  // instrumentation + roles so every reference below picks them up automatically.
  let instrumentation = template.instrumentation
  if (params.instrument) {
    const prog = INSTRUMENTS[params.instrument.toLowerCase().trim()]
    if (prog == null) {
      corrections.push(
        `unknown instrument "${params.instrument}" — kept the template's (valid: ${INSTRUMENT_NAMES.join(', ')})`,
      )
    } else {
      instrumentation = { ...instrumentation, keys: prog, lead: prog }
    }
  }
  const texture = params.texture ?? 'full'
  let roles = template.roles
  if (texture === 'solo') roles = { pad: false, keys: true, bass: false, lead: false, drums: false }
  else if (texture === 'minimal') roles = { ...roles, drums: false, lead: false }
  // minimal/solo are calm beds → their voices play continuously (no intro/outro drop).
  const continuousBed = texture !== 'full'
  template = { ...template, instrumentation, roles }

  const { tonic, minor, label } = parseKey(params.key, template.key)
  const offset = tonicOffset(tonic)

  let tempo = params.tempo ?? template.defaultTempo
  if (!Number.isFinite(tempo)) {
    corrections.push(`non-numeric tempo → ${template.defaultTempo}`)
    tempo = template.defaultTempo
  }
  const [tlo, thi] = template.tempoRange
  if (tempo < tlo || tempo > thi) {
    const c = clamp(tempo, tlo, thi)
    corrections.push(`tempo ${tempo} clamped to ${c} (range ${tlo}-${thi} for ${template.id})`)
    tempo = c
  }

  let intensity = params.intensity ?? 0.6
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    const c = clamp(Number.isFinite(intensity) ? intensity : 0.6, 0, 1)
    corrections.push(`intensity → ${c.toFixed(2)} (0..1)`)
    intensity = c
  }

  const secPerBeat = 60 / tempo
  const secPerBar = secPerBeat * BEATS_PER_BAR
  const secPerStep = secPerBar / STEPS_PER_BAR

  const reqDuration = params.sceneDurationSec || 0
  const maxDuration = MAX_BARS * secPerBar
  if (reqDuration > maxDuration) {
    corrections.push(`length capped at ${MAX_BARS} bars (~${Math.round(maxDuration)}s)`)
  }
  const duration = clamp(reqDuration, secPerBar, maxDuration)
  const totalBars = Math.min(MAX_BARS, Math.max(1, Math.round(duration / secPerBar)))

  // Section plan: fit intro + outro only when there's room for a core in between.
  const wantIntro = template.roles.pad && totalBars >= 6
  const wantOutro = totalBars >= 6
  const introBars = wantIntro ? Math.min(MAX_INTRO_BARS, Math.floor(totalBars / 4)) : 0
  const outroBars = wantOutro ? Math.min(MAX_OUTRO_BARS, Math.floor(totalBars / 4)) : 0
  const coreBars = totalBars - introBars - outroBars
  const sections: string[] = []
  if (introBars) sections.push('intro')
  sections.push('core')
  if (outroBars) sections.push('outro')

  // Seed humanization from the spec so identical params → identical output. The
  // `m1b` salt forces a one-time cache invalidation for the arrangement-dynamics
  // change (paired with the COMPOSER_VERSION bump).
  const rng = mulberry32(
    hashStr(`${template.id}|${label}|${tempo}|${intensity.toFixed(2)}|${totalBars}|${template.swing}|m1b`),
  )
  const jitter = (amt: number) => (rng() * 2 - 1) * amt

  // ── Arrangement dynamics ───────────────────────────────────────────────
  // A flat 4-chord loop at constant per-section energy is the "loop sounds like a
  // loop" tell. Within the core we now breathe: split it into phrases, swell the
  // velocity across each phrase, build gently across the whole core, bring the
  // lead in after the first phrase, and drop a drum fill + crash at phrase seams.
  // All deterministic (no new randomness source).
  const phraseLen = Math.min(4, Math.max(2, coreBars))
  // Per-core-bar velocity multiplier in [0.7, 1.0] — replaces the flat core gain.
  const coreDyn = (ci: number): number => {
    const pos = phraseLen > 1 ? (ci % phraseLen) / (phraseLen - 1) : 1 // 0..1 within phrase
    const macro = coreBars > 1 ? ci / (coreBars - 1) : 1 // 0..1 across the whole core
    const swell = 0.5 - 0.5 * Math.cos(Math.PI * pos) // smooth 0..1 phrase swell
    return clamp(0.7 + 0.18 * swell + 0.12 * macro, 0.7, 1)
  }
  // Lead enters after the first phrase on longer cores (so it "arrives"); a core
  // that's a single phrase keeps the lead throughout (no awkward silence).
  const leadActiveAt = (ci: number): boolean => coreBars <= phraseLen || ci >= phraseLen
  // True on the last bar of a phrase that is NOT the final core bar → fill + crash.
  const isPhraseSeam = (ci: number): boolean => ci % phraseLen === phraseLen - 1 && ci < coreBars - 1

  const events: NoteEvent[] = []
  // Rhythmic hits get timing + velocity jitter; sustained voices (pad) keep their
  // timing (humanizeTiming=false) but still get a touch of velocity variation.
  const add = (
    channel: number,
    note: number,
    velocity: number,
    startSec: number,
    durSec: number,
    humanizeTiming = true,
  ) => {
    if (note < 0 || note > 127) return
    const s = humanizeTiming ? Math.max(0, startSec + jitter(HUMANIZE_TIMING_SEC)) : startSec
    const v = clamp(Math.round(velocity + jitter(HUMANIZE_VEL)), 1, 127)
    events.push({ channel, note, velocity: v, startSec: s, durSec })
  }

  // Voice-leading state: each chord is voiced near the previous one's register.
  let padVoicing: number[] | null = null
  let keysVoicing: number[] | null = null

  for (let bar = 0; bar < totalBars; bar++) {
    const inIntro = bar < introBars
    const inOutro = bar >= introBars + coreBars
    const ci = bar - introBars // core-bar index (negative in intro, >= coreBars in outro)
    // Dynamics: intro/outro stay soft + flat; the core breathes via coreDyn.
    const dyn = inIntro ? 0.6 : inOutro ? 0.55 : coreDyn(ci)
    const barStart = bar * secPerBar

    // Chord for this bar (progression loops across the core; intro/outro hold the I/i).
    const coreIndex = clamp(ci, 0, coreBars - 1)
    const chordSym =
      inIntro || inOutro ? template.progression[0] : template.progression[coreIndex % template.progression.length]

    // PAD — sustained, voice-led whole-bar chord (always, if the template has a pad).
    if (template.roles.pad) {
      padVoicing = voiceChord(chordSym, offset, padVoicing, 3, 4)
      for (const n of padVoicing)
        add(CHANNELS.pad, n, 52 * MIX.pad * dyn * (0.7 + 0.3 * intensity), barStart, secPerBar * 0.98, false)
    }

    // BASS — moving line: root on beat 1, fifth/octave on beat 3 (alternating by bar),
    // plus an approach note on the "and of 4" at higher intensity. Root whole-note in intro.
    if (template.roles.bass) {
      const root = chordToMidi(chordSym, offset, 2, 1)[0]
      if (root != null) {
        const v = 68 * MIX.bass * dyn
        if (inIntro) {
          add(CHANNELS.bass, root, v, barStart, secPerBar * 0.95)
        } else {
          add(CHANNELS.bass, root, v, barStart, secPerBeat * 0.9)
          const second = bar % 2 === 0 ? root + 7 : root + 12 // fifth or octave
          add(CHANNELS.bass, second, v * 0.92, barStart + 2 * secPerBeat, secPerBeat * 0.9)
          if (intensity > 0.6) add(CHANNELS.bass, root + 7, v * 0.75, barStart + 3.5 * secPerBeat, secPerBeat * 0.4)
        }
      }
    }

    // KEYS — voice-led chord stabs on each beat in the core (off in intro/outro for space).
    // Call/response: when the lead is sustaining over this bar, thin the keys to
    // beats 1 & 3 to leave room; play all beats when the lead is silent.
    const leadHere = template.roles.lead && !inIntro && !inOutro && intensity >= 0.55 && leadActiveAt(ci)
    if (template.roles.keys && (continuousBed || (!inIntro && !inOutro))) {
      keysVoicing = voiceChord(chordSym, offset, keysVoicing, 4, 3)
      for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
        if (beat % 2 === 1 && intensity < 0.5 && !continuousBed) continue // thin out at low intensity (not in a solo/minimal bed)
        if (leadHere && beat % 2 === 1) continue // call/response: yield off-beats to the lead
        // Swing pushes the off-beats late; accent emphasizes the downbeat.
        const keySwing = template.swing > 0 && beat % 2 === 1 ? template.swing * (secPerBeat / 2) : 0
        const accent = beat === 0 ? 1 : beat === 2 ? 0.9 : 0.8
        for (const n of keysVoicing)
          add(
            CHANNELS.keys,
            n,
            58 * MIX.keys * dyn * (0.6 + 0.4 * intensity) * accent,
            barStart + beat * secPerBeat + keySwing,
            secPerBeat * 0.5,
          )
      }
    }

    // LEAD — top chord tone held; enters after the first phrase at higher
    // intensity. Octave-up at the core's peak so the climax lifts.
    if (leadHere) {
      const peak = coreBars > 1 && ci >= coreBars - phraseLen // final phrase
      const top = chordToMidi(chordSym, offset, peak ? 6 : 5, 4).pop()
      if (top != null) add(CHANNELS.lead, top, (50 + 30 * intensity) * MIX.lead * dyn, barStart, secPerBar * 0.9)
    }

    // DRUMS — step pattern; intro/outro drop drums for contrast.
    if (template.roles.drums && !inIntro && !inOutro) {
      const lanes: Array<[string, number, number]> = [
        [template.drums.kick, KICK, 110],
        [template.drums.snare, SNARE, 100],
        [template.drums.hat, HAT, 70],
      ]
      // Swing pushes the off-beat 8ths (the "and", every 4th 16th) late.
      const swingDelay = (step: number) => (template.swing > 0 && step % 4 === 2 ? template.swing * secPerStep : 0)
      const fill = isPhraseSeam(ci)
      for (const [pattern, note, vel] of lanes) {
        for (let step = 0; step < STEPS_PER_BAR; step++) {
          if (pattern[step] !== 'x') continue
          // Hats thin out at low intensity (drop odd steps).
          if (note === HAT && intensity < 0.5 && step % 2 === 1) continue
          // On a phrase-seam bar, clear the last beat (steps 12-15) so the fill
          // below owns it instead of colliding with the pattern.
          if (fill && step >= 12) continue
          // Downbeat accent: bar head strongest, beat heads next, off-steps softer.
          const accent = step === 0 ? 1 : step % 4 === 0 ? 0.92 : 0.82
          add(
            CHANNELS.drums,
            note,
            vel * MIX.drums * dyn * (0.7 + 0.3 * intensity) * accent,
            barStart + step * secPerStep + swingDelay(step),
            secPerStep * 0.9,
          )
        }
      }
      // Phrase-seam fill: a rising snare run on the last beat + a crash on the
      // next bar's downbeat — the clearest "produced, not a loop" signal.
      if (fill) {
        for (let step = 12; step < STEPS_PER_BAR; step++) {
          const rise = (step - 12) / 3 // 0..1 across the 4 fill steps
          add(CHANNELS.drums, SNARE, (78 + 34 * rise) * MIX.drums * dyn, barStart + step * secPerStep, secPerStep * 0.9)
        }
        add(CHANNELS.drums, CRASH, 96 * MIX.drums * dyn, barStart + secPerBar, secPerBeat)
      }
    }
  }

  // Reverb send per role, scaled by the template's room/space amount.
  const rev = (base: number) => Math.round(base * template.reverb)
  const channels = [
    { channel: CHANNELS.pad, program: template.instrumentation.pad, reverb: rev(REVERB_BASE.pad) },
    { channel: CHANNELS.keys, program: template.instrumentation.keys, reverb: rev(REVERB_BASE.keys) },
    { channel: CHANNELS.bass, program: template.instrumentation.bass, reverb: rev(REVERB_BASE.bass) },
    { channel: CHANNELS.lead, program: template.instrumentation.lead, reverb: rev(REVERB_BASE.lead) },
    { channel: CHANNELS.drums, program: 0, drums: true, reverb: rev(REVERB_BASE.drums) },
  ]

  // C-reference chord per core bar — what an ML lead would be conditioned on.
  const chordsInC: string[] = []
  for (let b = 0; b < coreBars; b++) chordsInC.push(template.progression[b % template.progression.length])

  return {
    arrangement: { durationSec: duration, channels, events },
    corrections,
    meta: { templateId: template.id, key: label, tempo, bars: totalBars, sections },
    plan: {
      chordsInC,
      offset,
      secPerBeat,
      coreStartSec: introBars * secPerBar,
      leadChannel: CHANNELS.lead,
      tempo,
      coreBars,
      drumPattern: template.roles.drums
        ? { kick: template.drums.kick, snare: template.drums.snare, hat: template.drums.hat }
        : null,
      drumChannel: CHANNELS.drums,
    },
  }
}
