import sharp from 'sharp'

// ── SVG color extraction ────────────────────────────────────────────────────

const COLOR_ATTR_RE = /(?:fill|stroke)\s*=\s*"([^"]+)"/gi
const CSS_COLOR_RE = /(?:fill|stroke)\s*:\s*([^;}"]+)/gi
const HEX_RE = /^#(?:[0-9a-f]{3}){1,2}$/i
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i

const SKIP = new Set(['none', 'transparent', 'currentcolor', 'inherit', 'initial', 'unset'])

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
  gray: '#808080', grey: '#808080', pink: '#ffc0cb', brown: '#a52a2a',
  cyan: '#00ffff', magenta: '#ff00ff', navy: '#000080', teal: '#008080',
  maroon: '#800000', olive: '#808000', lime: '#00ff00', aqua: '#00ffff',
  silver: '#c0c0c0', coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347',
  gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee', crimson: '#dc143c',
}

function normalizeToHex(raw: string): string | null {
  const s = raw.trim().toLowerCase()
  if (SKIP.has(s) || s.startsWith('url(')) return null

  if (HEX_RE.test(s)) {
    if (s.length === 4) {
      return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
    }
    return s
  }

  const rgb = RGB_RE.exec(s)
  if (rgb) {
    const r = parseInt(rgb[1]).toString(16).padStart(2, '0')
    const g = parseInt(rgb[2]).toString(16).padStart(2, '0')
    const b = parseInt(rgb[3]).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`
  }

  if (NAMED_COLORS[s]) return NAMED_COLORS[s]
  return null
}

/** Extract dominant colors from SVG markup (fill/stroke attributes + inline CSS). */
export function extractColorsFromSvg(svgText: string): string[] {
  const freq = new Map<string, number>()

  for (const re of [COLOR_ATTR_RE, CSS_COLOR_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(svgText))) {
      const hex = normalizeToHex(m[1])
      if (hex) freq.set(hex, (freq.get(hex) ?? 0) + 1)
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => color)
    .slice(0, 6)
}

// ── Image color extraction (using sharp) ────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

interface ColorBucket {
  r: number
  g: number
  b: number
  count: number
}

/** Extract dominant colors from an image buffer using sharp pixel sampling. */
export async function extractColorsFromImage(buffer: Buffer): Promise<string[]> {
  const { data, info } = await sharp(buffer)
    .resize(32, 32, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = info.width * info.height
  const buckets: ColorBucket[] = []
  const MERGE_DIST = 40

  for (let i = 0; i < pixels; i++) {
    const r = data[i * 3]
    const g = data[i * 3 + 1]
    const b = data[i * 3 + 2]

    // Skip near-white and near-black (likely background)
    if (r > 240 && g > 240 && b > 240) continue
    if (r < 15 && g < 15 && b < 15) continue

    let merged = false
    for (const bucket of buckets) {
      if (colorDistance(r, g, b, bucket.r, bucket.g, bucket.b) < MERGE_DIST) {
        const total = bucket.count + 1
        bucket.r = Math.round((bucket.r * bucket.count + r) / total)
        bucket.g = Math.round((bucket.g * bucket.count + g) / total)
        bucket.b = Math.round((bucket.b * bucket.count + b) / total)
        bucket.count = total
        merged = true
        break
      }
    }
    if (!merged) {
      buckets.push({ r, g, b, count: 1 })
    }
  }

  return buckets
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((b) => rgbToHex(b.r, b.g, b.b))
}
