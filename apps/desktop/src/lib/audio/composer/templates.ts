/**
 * Native music composer — arrangement templates.
 *
 * Each template is hand-authored musical taste expressed as data: a chord
 * progression (in a C reference, transposed to the target key at arrange time),
 * a drum pattern, instrumentation (GM programs), and dynamics. The agent PICKS
 * and parameterizes a template (key/tempo/intensity); it never voice-leads notes
 * itself — that's what keeps output musical rather than technically-in-key-but-dead.
 *
 * Drum patterns are 16 sixteenth-note steps per bar: 'x' = hit, '.' = rest.
 */

/** GM program numbers per instrument role (0-indexed). */
export interface Instrumentation {
  pad: number
  keys: number
  bass: number
  lead: number
}

export interface DrumPattern {
  /** 16-char step strings; 'x' hit, '.' rest. */
  kick: string
  snare: string
  hat: string
}

export interface Template {
  id: string
  name: string
  /** Default musical key, e.g. 'C minor' or 'C major'. */
  key: string
  defaultTempo: number
  tempoRange: [number, number]
  /** Chord progression in a C reference (one chord per bar of the core loop). */
  progression: string[]
  instrumentation: Instrumentation
  drums: DrumPattern
  /** Roles active in this template (lead is omitted for calmer beds). */
  roles: { pad: boolean; keys: boolean; bass: boolean; lead: boolean; drums: boolean }
  /**
   * Swing amount 0..1 — how much the off-beat 8ths are pushed late. 0 = straight,
   * ~0.5 = a relaxed lofi/jazz swing. Felt mainly in hats + keys.
   */
  swing: number
  /** Room/space 0..1 — scales the per-role reverb sends (ambient/cinematic high, dnb dry). */
  reverb: number
}

// GM program reference: 0 Acoustic Grand, 4 E.Piano, 33 Finger Bass, 38 Synth Bass,
// 80 Square Lead, 81 Saw Lead, 88 New Age Pad, 89 Warm Pad, 91 Bowed/Choir Pad.
export const TEMPLATES: Template[] = [
  {
    id: 'lofi',
    swing: 0.5,
    reverb: 0.4,
    name: 'Lo-fi chill',
    key: 'C minor',
    defaultTempo: 82,
    tempoRange: [70, 95],
    progression: ['Cm7', 'Fm7', 'Abmaj7', 'Bb7'],
    instrumentation: { pad: 89, keys: 4, bass: 33, lead: 80 },
    drums: { kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
    roles: { pad: true, keys: true, bass: true, lead: false, drums: true },
  },
  {
    id: 'ambient',
    swing: 0,
    reverb: 0.85,
    name: 'Ambient pad',
    key: 'C major',
    defaultTempo: 70,
    tempoRange: [55, 85],
    progression: ['Cmaj7', 'Amin7', 'Fmaj7', 'Gsus4'],
    instrumentation: { pad: 91, keys: 88, bass: 33, lead: 80 },
    drums: { kick: '................', snare: '................', hat: '................' },
    roles: { pad: true, keys: true, bass: true, lead: false, drums: false },
  },
  {
    id: 'corporate',
    swing: 0,
    reverb: 0.35,
    name: 'Corporate uplift',
    key: 'C major',
    defaultTempo: 110,
    tempoRange: [95, 125],
    progression: ['Cmaj7', 'Gmaj7', 'Amin7', 'Fmaj7'],
    instrumentation: { pad: 89, keys: 0, bass: 33, lead: 81 },
    drums: { kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx' },
    roles: { pad: true, keys: true, bass: true, lead: true, drums: true },
  },
  {
    id: 'tension',
    swing: 0,
    reverb: 0.45,
    name: 'Tension build',
    key: 'C minor',
    defaultTempo: 100,
    tempoRange: [85, 130],
    progression: ['Cm', 'Cm', 'Abmaj7', 'G7'],
    instrumentation: { pad: 91, keys: 88, bass: 38, lead: 81 },
    drums: { kick: 'x...x...x...x...', snare: '................', hat: 'xxxxxxxxxxxxxxxx' },
    roles: { pad: true, keys: false, bass: true, lead: true, drums: true },
  },
  {
    id: 'upbeat',
    swing: 0.12,
    reverb: 0.3,
    name: 'Upbeat pop',
    key: 'C major',
    defaultTempo: 120,
    tempoRange: [105, 135],
    progression: ['C', 'G', 'Amin', 'F'],
    instrumentation: { pad: 89, keys: 0, bass: 33, lead: 81 },
    drums: { kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx' },
    roles: { pad: true, keys: true, bass: true, lead: true, drums: true },
  },
  {
    id: 'cinematic',
    swing: 0,
    reverb: 0.8,
    name: 'Cinematic strings',
    key: 'D minor',
    defaultTempo: 68,
    tempoRange: [55, 90],
    progression: ['Cm', 'Abmaj7', 'Ebmaj7', 'Gm'],
    instrumentation: { pad: 49, keys: 48, bass: 43, lead: 49 },
    drums: { kick: 'x.......x.......', snare: '................', hat: '................' },
    roles: { pad: true, keys: true, bass: true, lead: false, drums: true },
  },
  {
    id: 'dnb',
    swing: 0,
    reverb: 0.15,
    name: 'Drum & bass',
    key: 'C minor',
    defaultTempo: 174,
    tempoRange: [160, 180],
    progression: ['Cm7', 'Cm7', 'Abmaj7', 'Fm7'],
    instrumentation: { pad: 89, keys: 4, bass: 38, lead: 81 },
    drums: { kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx' },
    roles: { pad: true, keys: true, bass: true, lead: true, drums: true },
  },
  {
    id: 'synthwave',
    swing: 0,
    reverb: 0.45,
    name: 'Retro synthwave',
    key: 'A minor',
    defaultTempo: 100,
    tempoRange: [85, 118],
    progression: ['Cm', 'Ab', 'Eb', 'Bb'],
    instrumentation: { pad: 89, keys: 81, bass: 39, lead: 81 },
    drums: { kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.' },
    roles: { pad: true, keys: true, bass: true, lead: true, drums: true },
  },
  {
    id: 'folk',
    swing: 0.2,
    reverb: 0.3,
    name: 'Acoustic folk',
    key: 'G major',
    defaultTempo: 96,
    tempoRange: [80, 120],
    progression: ['C', 'G', 'Amin', 'F'],
    instrumentation: { pad: 48, keys: 24, bass: 32, lead: 25 },
    drums: { kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
    roles: { pad: false, keys: true, bass: true, lead: false, drums: true },
  },
]

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id)

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
