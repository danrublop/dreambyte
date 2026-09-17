/**
 * GPU color-grade program (WebGL2 / GLSL ES 3.00) plus the CPU builders for its two
 * 256×1 lookup textures.
 *
 * Binding contract (shared by ClipGradeGL in grade-gl.ts and the export host's inlined
 * driver in src/electron/ipc/composite-host.ts):
 *   attribute  aPos  vec2, location 0 — one oversized clip-space triangle
 *   sampler    uImage=0  uChannelCurve=1  uHueCurve=2  uLut=3
 *   int        uHasChannelCurve, uHasHueCurve  (0/1)
 *   float      uExposure uContrast uSaturation uLutSize (0 = no LUT) uLutIntensity
 *   vec3       uWbGain
 *
 * Pipeline per pixel (display-referred, 0..1), matching the CSS tier's
 * `brightness() contrast() saturate() url(#wb+tables)` chain op for op:
 *   exposure → contrast → saturation → white balance → per-channel transfer table
 *   (tonal primaries, wheels, curves — baked on the CPU by gradeChannelTransfer) →
 *   hue-selective curves → tetrahedral 3D LUT blended by intensity.
 */

/** Hue-rotation range a hue-curve byte can express: ±this many degrees. */
const HUE_SHIFT_SPAN_DEG = 60
/** Lightness-offset range a hue-curve byte can express: ±this much. */
const LUM_SHIFT_SPAN = 1
/** A hue target influences hues within ±this many degrees (smoothstep falloff). */
export const HUE_TARGET_RADIUS_DEG = 22

export const GRADE_VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export const GRADE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;
// 256x1 RGBA8: R/G/B hold the per-channel transfer (A unused).
uniform sampler2D uChannelCurve;
// 256x1 RGBA8 indexed by hue: R = hue rotation, G = saturation scale, B = lightness
// offset. Each byte is signed around 128 (see decodeSigned).
uniform sampler2D uHueCurve;
// RGBA32F strip, n wide and n*n tall: texel (r, b*n + g) holds lattice node (r,g,b).
uniform highp sampler2D uLut;

uniform int uHasChannelCurve;
uniform int uHasHueCurve;
uniform float uLutSize;
uniform float uLutIntensity;

uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uWbGain;

const vec3 REC709 = vec3(0.2126, 0.7152, 0.0722);
const float HUE_SPAN_TURNS = ${HUE_SHIFT_SPAN_DEG.toFixed(1)} / 360.0;
const float LUM_SPAN = ${LUM_SHIFT_SPAN.toFixed(1)};

// Map a 0..1 value onto the centre of the matching texel of a 256-wide texture.
float lookupCoord(float x) {
  return clamp(x, 0.0, 1.0) * (255.0 / 256.0) + (0.5 / 256.0);
}

// Byte 128 decodes to exactly 0; 255 to +1; 1 to -1.
float decodeSigned(float v) {
  return (v * 255.0 - 128.0) / 127.0;
}

vec3 toHsv(vec3 c) {
  float hi = max(c.r, max(c.g, c.b));
  float lo = min(c.r, min(c.g, c.b));
  float range = hi - lo;
  float h = 0.0;
  if (range > 1e-5) {
    if (hi == c.r) {
      h = mod((c.g - c.b) / range, 6.0);
    } else if (hi == c.g) {
      h = (c.b - c.r) / range + 2.0;
    } else {
      h = (c.r - c.g) / range + 4.0;
    }
    h /= 6.0;
  }
  float s = hi > 1e-5 ? range / hi : 0.0;
  return vec3(h, s, hi);
}

vec3 fromHsv(vec3 hsv) {
  vec3 k = clamp(abs(mod(hsv.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return hsv.z * mix(vec3(1.0), k, hsv.y);
}

// Same ops, order and per-step clamping as the CSS filter chain.
vec3 applyPrimaries(vec3 c) {
  c = clamp(c * pow(2.0, uExposure), 0.0, 1.0);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  c = clamp(mix(vec3(dot(c, REC709)), c, uSaturation), 0.0, 1.0);
  return clamp(c * uWbGain, 0.0, 1.0);
}

vec3 applyChannelTransfer(vec3 c) {
  return vec3(
    texture(uChannelCurve, vec2(lookupCoord(c.r), 0.5)).r,
    texture(uChannelCurve, vec2(lookupCoord(c.g), 0.5)).g,
    texture(uChannelCurve, vec2(lookupCoord(c.b), 0.5)).b
  );
}

vec3 applyHueCurves(vec3 c) {
  vec3 hsv = toHsv(c);
  // Fade the effect out on near-neutral pixels: their hue is noise.
  float chroma = hsv.y * hsv.z;
  float weight = smoothstep(0.02, 0.12, chroma);
  if (weight <= 0.0) return c;

  vec4 cell = texture(uHueCurve, vec2(lookupCoord(hsv.x), 0.5));
  hsv.x = fract(hsv.x + weight * decodeSigned(cell.r) * HUE_SPAN_TURNS);
  hsv.y = clamp(hsv.y * (1.0 + weight * decodeSigned(cell.g)), 0.0, 1.0);
  vec3 outColor = fromHsv(hsv) + weight * decodeSigned(cell.b) * LUM_SPAN;
  return clamp(outColor, 0.0, 1.0);
}

vec3 lutNode(int r, int g, int b, int n) {
  return texelFetch(uLut, ivec2(r, b * n + g), 0).rgb;
}

vec3 applyLut(vec3 c) {
  int n = int(uLutSize + 0.5);
  vec3 p = clamp(c, 0.0, 1.0) * float(n - 1);
  ivec3 i0 = min(ivec3(floor(p)), ivec3(n - 2));
  vec3 f = p - vec3(i0);
  ivec3 i1 = i0 + 1;

  vec3 c000 = lutNode(i0.x, i0.y, i0.z, n);
  vec3 c111 = lutNode(i1.x, i1.y, i1.z, n);
  vec3 outColor;
  // Split the cell into six tetrahedra sharing its main diagonal; walk the cell edges
  // in order of decreasing fractional coordinate.
  if (f.r >= f.g) {
    if (f.g >= f.b) {
      vec3 cA = lutNode(i1.x, i0.y, i0.z, n);
      vec3 cB = lutNode(i1.x, i1.y, i0.z, n);
      outColor = c000 + f.r * (cA - c000) + f.g * (cB - cA) + f.b * (c111 - cB);
    } else if (f.r >= f.b) {
      vec3 cA = lutNode(i1.x, i0.y, i0.z, n);
      vec3 cB = lutNode(i1.x, i0.y, i1.z, n);
      outColor = c000 + f.r * (cA - c000) + f.b * (cB - cA) + f.g * (c111 - cB);
    } else {
      vec3 cA = lutNode(i0.x, i0.y, i1.z, n);
      vec3 cB = lutNode(i1.x, i0.y, i1.z, n);
      outColor = c000 + f.b * (cA - c000) + f.r * (cB - cA) + f.g * (c111 - cB);
    }
  } else {
    if (f.b >= f.g) {
      vec3 cA = lutNode(i0.x, i0.y, i1.z, n);
      vec3 cB = lutNode(i0.x, i1.y, i1.z, n);
      outColor = c000 + f.b * (cA - c000) + f.g * (cB - cA) + f.r * (c111 - cB);
    } else if (f.b >= f.r) {
      vec3 cA = lutNode(i0.x, i1.y, i0.z, n);
      vec3 cB = lutNode(i0.x, i1.y, i1.z, n);
      outColor = c000 + f.g * (cA - c000) + f.b * (cB - cA) + f.r * (c111 - cB);
    } else {
      vec3 cA = lutNode(i0.x, i1.y, i0.z, n);
      vec3 cB = lutNode(i1.x, i1.y, i0.z, n);
      outColor = c000 + f.g * (cA - c000) + f.r * (cB - cA) + f.b * (c111 - cB);
    }
  }
  return mix(c, outColor, clamp(uLutIntensity, 0.0, 1.0));
}

void main() {
  vec4 src = texture(uImage, vUv);
  vec3 c = applyPrimaries(src.rgb);
  if (uHasChannelCurve == 1) c = applyChannelTransfer(c);
  if (uHasHueCurve == 1) c = applyHueCurves(c);
  if (uLutSize >= 2.0) c = applyLut(c);
  fragColor = vec4(c, src.a);
}`

function toByte(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
}

/** Signed [-1,1] → byte, with 0 landing exactly on 128 (the shader's decodeSigned). */
function toSignedByte(v: number): number {
  return 128 + Math.round(Math.min(1, Math.max(-1, v)) * 127)
}

/**
 * 256×1 RGBA8 per-channel transfer texture: texel i holds each function evaluated at
 * i/255 in R/G/B (A = 255, unused). Outputs are clamped to [0,1].
 */
export function buildChannelCurveTexture(
  evalR: (x: number) => number,
  evalG: (x: number) => number,
  evalB: (x: number) => number,
): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    const o = i * 4
    out[o] = toByte(evalR(x))
    out[o + 1] = toByte(evalG(x))
    out[o + 2] = toByte(evalB(x))
    out[o + 3] = 255
  }
  return out
}

/** Decode one signed byte of the hue-curve texture (CPU mirror of the shader). */
export function decodeHueCurveByte(byte: number): number {
  return (byte - 128) / 127
}

/**
 * 256×1 RGBA8 hue-selective texture (texel i ↔ hue i/255·360°), or null when no target
 * changes anything. Channels are signed bytes around 128 (decodeHueCurveByte):
 *   R = hue rotation / HUE_SHIFT_SPAN_DEG, G = saturation scale − 1,
 *   B = lightness offset / LUM_SHIFT_SPAN, A = 255 (unused).
 * Each target's weight falls off smoothly to zero at HUE_TARGET_RADIUS_DEG of angular
 * distance (wrapping at 360°); overlapping targets add (hue, lightness) and multiply
 * (saturation).
 */
export function buildHueCurveTexture(
  targets: { targetHue: number; hueShift?: number; satScale?: number; lumShift?: number }[] | undefined,
): Uint8Array | null {
  const live = (targets ?? []).filter(
    (t) =>
      Math.abs(t.hueShift ?? 0) > 1e-4 || Math.abs((t.satScale ?? 1) - 1) > 1e-4 || Math.abs(t.lumShift ?? 0) > 1e-4,
  )
  if (live.length === 0) return null

  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const hue = (i / 255) * 360
    let rotate = 0
    let scale = 1
    let lift = 0
    for (const t of live) {
      const gap = Math.abs(((((hue - t.targetHue) % 360) + 540) % 360) - 180)
      if (gap >= HUE_TARGET_RADIUS_DEG) continue
      const s = gap / HUE_TARGET_RADIUS_DEG
      const w = 1 - s * s * (3 - 2 * s)
      rotate += w * (t.hueShift ?? 0)
      scale *= 1 + w * ((t.satScale ?? 1) - 1)
      lift += w * (t.lumShift ?? 0)
    }
    const o = i * 4
    out[o] = toSignedByte(rotate / HUE_SHIFT_SPAN_DEG)
    out[o + 1] = toSignedByte(scale - 1)
    out[o + 2] = toSignedByte(lift / LUM_SHIFT_SPAN)
    out[o + 3] = 255
  }
  return out
}
