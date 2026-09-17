/**
 * Tier-B clip grade — the WebGL2 GPU pass.
 *
 * `compileClipGradeCss` (Tier A) covers everything CSS/SVG can express. The two
 * ops it CANNOT — a 3D tetrahedral `.cube` LUT and Resolve-style hue-vs-hue/sat/lum
 * curves — run here through `GRADE_FRAGMENT_SHADER` (src/lib/compositor/grade-shaders.ts).
 *
 * This module has two halves:
 *   1. `buildGradeUniforms(grade)` — PURE: maps a ClipColorGrade to the flat uniform
 *      set the shader consumes (primaries, wheel CDL vec3s, the 256×1 channel/hue
 *      curve textures, LUT size/intensity). No GL, no DOM — fully unit-testable, and
 *      the SINGLE source of uniform truth shared by the preview (renderer) and the
 *      export host (main process). Reuses the SAME wheel/curve/white-balance math as
 *      the Tier-A CSS compiler so the tiers agree on the shared ops.
 *   2. `ClipGradeGL` — the GL driver for the PREVIEW pool. Pooled WebGL2 context +
 *      one compiled program; `render(source, uniforms)` draws the graded frame into
 *      its own `<canvas>` which the compositor styles in place of the raw element.
 *
 * The export host (src/electron/ipc/composite-host.ts) runs a structurally identical
 * driver inlined into its page controller string (it cannot import TS) — fed the
 * SAME `buildGradeUniforms` output (computed in main) and the SAME shader source, so
 * preview == export by construction. The only intentional duplication is the ~50
 * lines of WebGL boilerplate; all color math lives here and is shared.
 *
 * SSR/jsdom-safe: the context is acquired lazily and `supported` is false when no
 * WebGL2 is available (the renderer falls back to leaving the element ungraded).
 */

import type { ClipColorGrade } from '@/lib/edit-engines/clip-grade'
import {
  effectiveSaturation,
  gradeChannelTransfer,
  gradeTransferTables,
  whiteBalanceGains,
} from '@/lib/compositor/clip-grade-css'
import {
  GRADE_VERTEX_SHADER,
  GRADE_FRAGMENT_SHADER,
  buildChannelCurveTexture,
  buildHueCurveTexture,
} from '@/lib/compositor/grade-shaders'
import type { CubeLut } from '@/lib/edit-engines/cube-lut'

/** Flat uniform set for GRADE_FRAGMENT_SHADER — pure data, JSON-serializable. */
export interface GradeUniforms {
  exposure: number
  contrast: number
  /** Global saturation with vibrance folded in (same value the CSS tier uses). */
  saturation: number
  /** White-balance per-channel gain [r,g,b]. */
  wbGain: [number, number, number]
  /**
   * 256×4 RGBA texture holding the per-channel transfer (tonal primaries, wheels,
   * master + RGB curves) in R/G/B — the exact function the CSS tier bakes into its
   * feComponentTransfer tables. A is unused (255). Null when the transfer is identity.
   */
  channelCurve: Uint8Array | null
  /** 256×4 RGBA hue-curve texture, or null. */
  hueCurve: Uint8Array | null
  /** LUT cube dimension n (0 = no LUT). */
  lutSize: number
  lutIntensity: number
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Map a grade to the shader uniform set. PURE. Every op the CSS tier can express is
 * computed by the CSS tier's own helpers (white balance, saturation, the per-channel
 * transfer), so a clip looks the same whichever tier renders it; the GPU only adds
 * the LUT and true hue curves on top.
 */
export function buildGradeUniforms(grade: ClipColorGrade): GradeUniforms {
  const g = grade
  const wb = whiteBalanceGains(g.temperature ?? 6500, g.tint ?? 0)
  const channelCurve = gradeTransferTables(g)
    ? buildChannelCurveTexture(gradeChannelTransfer(g, 'r'), gradeChannelTransfer(g, 'g'), gradeChannelTransfer(g, 'b'))
    : null
  const lutSize = g.lut?.path && (g.lut.dimension ?? 0) > 1 ? g.lut.dimension : 0

  return {
    exposure: clamp(g.exposure ?? 0, -3, 3),
    contrast: clamp(g.contrast ?? 1, 0.5, 1.5),
    saturation: effectiveSaturation(g),
    wbGain: [wb.r, wb.g, wb.b],
    channelCurve,
    hueCurve: buildHueCurveTexture(g.hueCurves?.targets),
    lutSize,
    lutIntensity: clamp(g.lut?.strength ?? 1, 0, 1),
  }
}

/**
 * The `dreambyte://luts/<file>` URL a stored LUT path resolves to. The apply_color
 * handler copies every `.cube` into `~/.dreambyte/luts/`, which main.ts serves under
 * the `luts` protocol mount — so BOTH the preview (renderer) and the export host
 * (offscreen window) fetch the identical bytes by basename. Returns null for a
 * pathless / empty grade.
 */
export function lutUrlForPath(lutPath: string | undefined | null): string | null {
  if (!lutPath) return null
  const base = lutPath.replace(/\\/g, '/').split('/').pop()
  if (!base) return null
  return `dreambyte://luts/${encodeURIComponent(base)}`
}

/**
 * JSON-serializable form of the uniforms for the export host, which receives layer
 * instructions as `JSON.stringify`'d plain objects (no typed arrays). The host's
 * inlined GL driver consumes this shape; the LUT travels separately (registered once
 * by url to avoid re-shipping megabytes per frame) and is referenced here by `lutUrl`.
 */
export interface GradeGLPayload {
  exposure: number
  contrast: number
  saturation: number
  wbGain: [number, number, number]
  channelCurve: number[] | null
  hueCurve: number[] | null
  lutUrl: string | null
  lutSize: number
  lutIntensity: number
}

/** Build the host's serializable uniform payload from a grade (used in main process). */
export function buildGradeGLPayload(grade: ClipColorGrade): GradeGLPayload {
  const u = buildGradeUniforms(grade)
  return {
    exposure: u.exposure,
    contrast: u.contrast,
    saturation: u.saturation,
    wbGain: u.wbGain,
    channelCurve: u.channelCurve ? Array.from(u.channelCurve) : null,
    hueCurve: u.hueCurve ? Array.from(u.hueCurve) : null,
    lutUrl: lutUrlForPath(grade.lut?.path),
    lutSize: u.lutSize,
    lutIntensity: u.lutIntensity,
  }
}

// ── GL driver (preview pool) ────────────────────────────────────────────────

const QUAD = new Float32Array([-1, -1, 3, -1, -1, 3]) // single oversized triangle

/**
 * Pooled WebGL2 renderer that grades one source frame into its own `<canvas>`.
 * One instance is reused across layers/frames in the preview pool; `render` re-uploads
 * the source + uniforms each call. Tier-B only (LUT / hue curves) — Tier-A grades
 * never reach here.
 */
export class ClipGradeGL {
  readonly canvas: HTMLCanvasElement | null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private imageTex: WebGLTexture | null = null
  private channelTex: WebGLTexture | null = null
  private hueTex: WebGLTexture | null = null
  private lutTex: WebGLTexture | null = null
  private loc: Record<string, WebGLUniformLocation | null> = {}
  /** url → loaded cube (so a repeated grade does not re-fetch/re-upload). */
  private lutCache = new Map<string, CubeLut>()
  private currentLutUrl: string | null = null

  constructor() {
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
    if (this.canvas) this.init()
  }

  /** True when a WebGL2 context + program are live; false on SSR/jsdom/no-GPU. */
  get supported(): boolean {
    return !!this.gl && !!this.program
  }

  private init(): void {
    const canvas = this.canvas!
    let gl: WebGL2RenderingContext | null = null
    try {
      // preserveDrawingBuffer: the canvas IS the visible composite layer, so it must
      // retain the last graded frame across page repaints that don't re-run sync().
      gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: true })
    } catch {
      gl = null
    }
    if (!gl) return
    const vs = this.compile(gl, gl.VERTEX_SHADER, GRADE_VERTEX_SHADER)
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, GRADE_FRAGMENT_SHADER)
    if (!vs || !fs) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    this.imageTex = this.makeTex(gl, gl.LINEAR)
    this.channelTex = this.makeTex(gl, gl.LINEAR)
    this.hueTex = this.makeTex(gl, gl.LINEAR)
    this.lutTex = this.makeTex(gl, gl.NEAREST)

    gl.useProgram(program)
    for (const name of [
      'uImage',
      'uChannelCurve',
      'uHueCurve',
      'uLut',
      'uLutSize',
      'uLutIntensity',
      'uHasChannelCurve',
      'uHasHueCurve',
      'uExposure',
      'uContrast',
      'uSaturation',
      'uWbGain',
    ]) {
      this.loc[name] = gl.getUniformLocation(program, name)
    }
    // Static sampler units.
    gl.uniform1i(this.loc.uImage, 0)
    gl.uniform1i(this.loc.uChannelCurve, 1)
    gl.uniform1i(this.loc.uHueCurve, 2)
    gl.uniform1i(this.loc.uLut, 3)

    this.gl = gl
    this.program = program
  }

  private compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh)
      return null
    }
    return sh
  }

  private makeTex(gl: WebGL2RenderingContext, filter: number): WebGLTexture | null {
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  /**
   * Ensure the LUT for `url` is fetched, parsed and uploaded. Idempotent + cached.
   * Returns the cube dimension (0 when none / unsupported / fetch failed — the caller
   * then renders with lutSize 0, i.e. no LUT, rather than failing the frame).
   */
  async ensureLut(url: string | null): Promise<number> {
    if (!this.gl || !url) {
      this.currentLutUrl = null
      return 0
    }
    let cube = this.lutCache.get(url) ?? null
    if (!cube) {
      try {
        const res = await fetch(url)
        if (!res.ok) return 0
        const text = await res.text()
        const { parseCubeLut } = await import('@/lib/edit-engines/cube-lut')
        cube = parseCubeLut(text)
        if (!cube) return 0
        this.lutCache.set(url, cube)
      } catch {
        return 0
      }
    }
    if (this.currentLutUrl !== url) {
      this.uploadLut(cube)
      this.currentLutUrl = url
    }
    return cube.dimension
  }

  private uploadLut(cube: CubeLut): void {
    const gl = this.gl!
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    // Data is laid out r-fastest then g then b → texel (r, b*n+g) of an n × n² strip,
    // which the shader reads with texelFetch. Float + NEAREST: the tetrahedral
    // interpolation happens in-shader, so no hardware filtering is needed.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      cube.dimension,
      cube.dimension * cube.dimension,
      0,
      gl.RGBA,
      gl.FLOAT,
      cube.data,
    )
  }

  /**
   * Grade `source` (a seeked `<video>` / loaded `<img>` / canvas) into `this.canvas`
   * at width×height. `lutSize` overrides the uniform's LUT size — pass the value
   * returned by `ensureLut` so a failed LUT fetch degrades to no-LUT cleanly.
   */
  render(
    source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
    u: GradeUniforms,
    width: number,
    height: number,
    lutSize = u.lutSize,
  ): void {
    const gl = this.gl
    const canvas = this.canvas
    if (!gl || !this.program || !canvas) return
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.program)

    // Source frame.
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } catch {
      return // source not yet decodable this tick — skip, next frame retries
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)

    // Channel-curve texture.
    if (u.channelCurve) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.channelTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, u.channelCurve)
      gl.uniform1i(this.loc.uHasChannelCurve, 1)
    } else {
      gl.uniform1i(this.loc.uHasChannelCurve, 0)
    }

    // Hue-curve texture.
    if (u.hueCurve) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this.hueTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, u.hueCurve)
      gl.uniform1i(this.loc.uHasHueCurve, 1)
    } else {
      gl.uniform1i(this.loc.uHasHueCurve, 0)
    }

    // LUT (texture already uploaded by ensureLut; just need the unit bound).
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)

    gl.uniform1f(this.loc.uLutSize, lutSize)
    gl.uniform1f(this.loc.uLutIntensity, u.lutIntensity)
    gl.uniform1f(this.loc.uExposure, u.exposure)
    gl.uniform1f(this.loc.uContrast, u.contrast)
    gl.uniform1f(this.loc.uSaturation, u.saturation)
    gl.uniform3fv(this.loc.uWbGain, u.wbGain)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    const gl = this.gl
    if (!gl) return
    try {
      gl.deleteTexture(this.imageTex)
      gl.deleteTexture(this.channelTex)
      gl.deleteTexture(this.hueTex)
      gl.deleteTexture(this.lutTex)
      gl.deleteProgram(this.program)
    } catch {
      /* ignore */
    }
    this.gl = null
    this.program = null
  }
}
