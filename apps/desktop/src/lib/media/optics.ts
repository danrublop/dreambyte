// Cinematic OPTICS for video generation (Cinema / lens control — Higgsfield-adjacent). Where
// camera.ts describes camera MOTION, this describes the LENS: focal length, aperture / depth of
// field, lens style, film stock, and shot size. It compiles to one natural-language clause folded
// into effectiveVideoPrompt alongside the camera + effect clauses (src/lib/media/video-edit.ts), so a
// "pan left" becomes "pan left, 35mm anamorphic, shallow f/1.8 depth of field, 70mm film grain".

export type LensStyle = 'anamorphic' | 'spherical' | 'macro' | 'fisheye' | 'tilt-shift' | 'wide-angle' | 'telephoto'
export type FilmStock = 'digital-8k' | '70mm' | '35mm-film' | '16mm' | 'super-8' | 'vintage'
export type ShotSize = 'extreme-wide' | 'wide' | 'medium' | 'medium-close' | 'close-up' | 'extreme-close-up'

export interface OpticsSpec {
  /** Focal length in mm (clamped 8–300). Compiles to a wide/normal/telephoto descriptor. */
  focalLengthMm?: number
  /** f-number (clamped 1.0–32). Compiles to a depth-of-field descriptor. */
  aperture?: number
  lens?: LensStyle
  filmStock?: FilmStock
  shotSize?: ShotSize
}

// Finite-safe clamp: a NaN/Infinity input falls back to the low bound rather than propagating through
// Math.min/max (which would print "NaNmm" / "f/NaN" into the prompt + cache key). Defense in depth;
// compileOpticsToPrompt also skips non-finite values entirely so they're never mentioned.
const clampNum = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)

/** Focal length → a lens descriptor. Standard cinematography bands (mm on a full-frame sensor). */
export function focalDescriptor(mm: number): string {
  const f = clampNum(mm, 8, 300)
  const band =
    f < 16
      ? 'ultra-wide-angle'
      : f < 35
        ? 'wide-angle'
        : f <= 50
          ? 'normal'
          : f <= 85
            ? 'short-telephoto portrait'
            : f <= 200
              ? 'telephoto'
              : 'super-telephoto'
  return `${Math.round(f)}mm ${band} lens`
}

/** f-number → a depth-of-field descriptor (smaller f = shallower / more background blur). */
export function apertureDescriptor(fnum: number): string {
  const f = clampNum(fnum, 1.0, 32)
  const dof =
    f <= 2
      ? 'very shallow depth of field, creamy background blur'
      : f <= 4
        ? 'shallow depth of field'
        : f <= 8
          ? 'balanced focus'
          : 'deep focus, everything sharp'
  return `${dof} (f/${f % 1 === 0 ? f.toFixed(0) : f.toFixed(1)})`
}

const LENS_DESC: Record<LensStyle, string> = {
  anamorphic: 'anamorphic lens with oval bokeh and horizontal lens flares',
  spherical: 'clean spherical lens',
  macro: 'macro lens with extreme close detail',
  fisheye: 'fisheye lens with strong barrel distortion',
  'tilt-shift': 'tilt-shift lens, miniature-model effect',
  'wide-angle': 'wide-angle lens',
  telephoto: 'telephoto lens with compressed perspective',
}

const FILM_DESC: Record<FilmStock, string> = {
  'digital-8k': 'crisp 8K digital capture',
  '70mm': 'shot on 70mm film, rich grain and dynamic range',
  '35mm-film': 'shot on 35mm film',
  '16mm': '16mm film grain and texture',
  'super-8': 'Super 8 home-movie texture',
  vintage: 'vintage film look, soft halation and faded color',
}

const SHOT_DESC: Record<ShotSize, string> = {
  'extreme-wide': 'extreme wide establishing shot',
  wide: 'wide shot',
  medium: 'medium shot',
  'medium-close': 'medium close-up',
  'close-up': 'close-up',
  'extreme-close-up': 'extreme close-up',
}

/** Compile an optics spec into one prompt clause. Returns '' for an empty/no-op spec so callers can
 *  skip appending. Order reads cinematically: film stock → lens/focal → depth of field → framing. */
export function compileOpticsToPrompt(spec: OpticsSpec | null | undefined): string {
  if (!spec) return ''
  const parts: string[] = []
  if (spec.filmStock && FILM_DESC[spec.filmStock]) parts.push(FILM_DESC[spec.filmStock])
  // A named lens style describes the optics; for wide-angle/telephoto it already conveys the focal
  // band, so skip the redundant focal descriptor. Other lens styles (anamorphic/macro/…) keep it.
  if (spec.lens && LENS_DESC[spec.lens]) {
    parts.push(LENS_DESC[spec.lens])
    const focalRedundant = spec.lens === 'wide-angle' || spec.lens === 'telephoto'
    if (Number.isFinite(spec.focalLengthMm) && !focalRedundant) parts.push(focalDescriptor(spec.focalLengthMm as number))
  } else if (Number.isFinite(spec.focalLengthMm)) {
    parts.push(focalDescriptor(spec.focalLengthMm as number))
  }
  if (Number.isFinite(spec.aperture)) parts.push(apertureDescriptor(spec.aperture as number))
  if (spec.shotSize && SHOT_DESC[spec.shotSize]) parts.push(SHOT_DESC[spec.shotSize])
  if (parts.length === 0) return ''
  // Capitalize the first word for a clean sentence; one clause like the camera clause.
  const body = parts.join(', ')
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`
}

/** Named cinematic presets (the Cinema-Studio "lens preset" surface). */
export const OPTICS_PRESETS: Record<string, { label: string; spec: OpticsSpec }> = {
  'cinematic-anamorphic': {
    label: 'Cinematic anamorphic',
    spec: { lens: 'anamorphic', focalLengthMm: 40, aperture: 2, filmStock: '35mm-film' },
  },
  'epic-70mm': { label: 'Epic 70mm', spec: { filmStock: '70mm', focalLengthMm: 50, aperture: 8, shotSize: 'wide' } },
  'portrait-85': { label: 'Portrait 85mm', spec: { focalLengthMm: 85, aperture: 1.4, shotSize: 'close-up' } },
  'vintage-16mm': { label: 'Vintage 16mm', spec: { filmStock: '16mm', focalLengthMm: 25, aperture: 2.8 } },
  'macro-detail': {
    label: 'Macro detail',
    spec: { lens: 'macro', focalLengthMm: 100, aperture: 2.8, shotSize: 'extreme-close-up' },
  },
  'dreamy-tilt-shift': { label: 'Dreamy tilt-shift', spec: { lens: 'tilt-shift', aperture: 2 } },
  'digital-8k-crisp': { label: '8K digital crisp', spec: { filmStock: 'digital-8k', aperture: 8 } },
  'fisheye-wide': { label: 'Fisheye wide', spec: { lens: 'fisheye', focalLengthMm: 12, shotSize: 'wide' } },
  'super8-nostalgia': { label: 'Super 8 nostalgia', spec: { filmStock: 'super-8', focalLengthMm: 28, aperture: 4 } },
}

export type OpticsPresetId = keyof typeof OPTICS_PRESETS

/** Resolve a preset id to its OpticsSpec (or null for an unknown id). */
export function resolveOpticsPreset(id: string | null | undefined): OpticsSpec | null {
  if (!id) return null
  return OPTICS_PRESETS[id]?.spec ?? null
}
