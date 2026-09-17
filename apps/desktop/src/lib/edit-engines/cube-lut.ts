/**
 * Adobe/IRIDAS `.cube` 3D LUT loading plus a CPU tetrahedral sampler.
 *
 * Format summary: `#` starts a comment; header keywords (TITLE, LUT_3D_SIZE, DOMAIN_MIN,
 * DOMAIN_MAX, optionally LUT_3D_INPUT_RANGE) precede n³ rows of three floats, ordered
 * with red changing fastest, then green, then blue. 1D LUTs are not supported.
 */

export interface CubeLut {
  /** Cube dimension n (LUT_3D_SIZE). */
  dimension: number
  /**
   * Packed RGBA float32, length n³·4, red fastest then green then blue — node (r,g,b)
   * lives at ((b·n + g)·n + r)·4, i.e. texel (r, b·n+g) of an n × n² strip texture.
   * Values are normalized by the domain into [0,1]; alpha is 1.
   */
  data: Float32Array
}

const MIN_SIZE = 2
/**
 * 64 keeps the n × n² strip texture at 64 × 4096 — the WebGL MAX_TEXTURE_SIZE floor on
 * many GPUs. 65³ LUTs would need 4225 texels and fail to upload there.
 */
const MAX_SIZE = 64

/** Keywords are matched case-insensitively (some exporters write `lut_3d_size`). */
const KEYWORD = /^[A-Z][A-Z0-9_]*$/i

function parseTriple(parts: string[]): [number, number, number] | null {
  if (parts.length !== 3) return null
  const v = parts.map(Number)
  return v.every(Number.isFinite) ? (v as [number, number, number]) : null
}

/** A data row: at least three numbers; extra numeric columns (some exporters add them) are ignored. */
function parseRow(parts: string[]): [number, number, number] | null {
  if (parts.length < 3 || !parts.every((p) => Number.isFinite(Number(p)))) return null
  return parseTriple(parts.slice(0, 3))
}

/** Parse `.cube` text into a normalized cube, or null when the file is not a valid 3D LUT. */
export function parseCubeLut(text: string): CubeLut | null {
  let size = 0
  let lo: [number, number, number] = [0, 0, 0]
  let hi: [number, number, number] = [1, 1, 1]
  const rows: number[] = []

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf('#')
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const head = parts[0].toUpperCase()

    if (KEYWORD.test(head)) {
      // Keywords belong to the header; one after the data starts means a broken file.
      if (rows.length > 0) return null
      const args = parts.slice(1)
      if (head === 'TITLE') continue
      if (head === 'LUT_1D_SIZE') return null
      if (head === 'LUT_3D_SIZE') {
        if (args.length !== 1 || !/^\d+$/.test(args[0])) return null
        size = Number(args[0])
      } else if (head === 'DOMAIN_MIN' || head === 'DOMAIN_MAX') {
        const t = parseTriple(args)
        if (!t) return null
        if (head === 'DOMAIN_MIN') lo = t
        else hi = t
      } else if (head === 'LUT_3D_INPUT_RANGE') {
        const a = args.map(Number)
        if (a.length !== 2 || !a.every(Number.isFinite)) return null
        lo = [a[0], a[0], a[0]]
        hi = [a[1], a[1], a[1]]
      }
      // Other keywords (vendor extensions) are ignored.
      continue
    }

    const t = parseRow(parts)
    if (!t) return null
    rows.push(t[0], t[1], t[2])
  }

  if (size < MIN_SIZE || size > MAX_SIZE) return null
  const count = size * size * size
  if (rows.length !== count * 3) return null
  if (lo.some((v, c) => !(hi[c] > v))) return null

  const data = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (rows[i * 3 + c] - lo[c]) / (hi[c] - lo[c])
      data[i * 4 + c] = v < 0 ? 0 : v > 1 ? 1 : v
    }
    data[i * 4 + 3] = 1
  }
  return { dimension: size, data }
}

/**
 * Sample the cube at (r,g,b) ∈ [0,1] with tetrahedral interpolation — the CPU twin of
 * the shader's `applyLut`. Exact at lattice nodes and exact for any affine cube.
 * `intensity` blends from the input (0) to the LUT output (1).
 */
export function sampleCubeTetra(
  lut: CubeLut,
  r: number,
  g: number,
  b: number,
  intensity = 1,
): [number, number, number] {
  const n = lut.dimension
  const d = lut.data
  const node = (x: number, y: number, z: number, c: number) => d[((z * n + y) * n + x) * 4 + c]

  const grid = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v) * (n - 1)
  const pr = grid(r)
  const pg = grid(g)
  const pb = grid(b)
  const r0 = Math.min(Math.floor(pr), n - 2)
  const g0 = Math.min(Math.floor(pg), n - 2)
  const b0 = Math.min(Math.floor(pb), n - 2)
  const fr = pr - r0
  const fg = pg - g0
  const fb = pb - b0

  // Walk from the low corner to the high corner one axis at a time, largest fraction
  // first; the two intermediate corners pick the tetrahedron.
  const axes: [number, number][] = [
    [fr, 0],
    [fg, 1],
    [fb, 2],
  ]
  axes.sort((a, z) => z[0] - a[0])
  const step = [0, 0, 0]
  const corners: [number, number, number][] = [[r0, g0, b0]]
  for (const [, axis] of axes) {
    step[axis] = 1
    corners.push([r0 + step[0], g0 + step[1], b0 + step[2]])
  }
  const weights = [1 - axes[0][0], axes[0][0] - axes[1][0], axes[1][0] - axes[2][0], axes[2][0]]

  const input = [r, g, b]
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    let v = 0
    for (let k = 0; k < 4; k++) v += weights[k] * node(corners[k][0], corners[k][1], corners[k][2], c)
    out[c] = input[c] + (v - input[c]) * intensity
  }
  return out
}
