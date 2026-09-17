import { describe, it, expect } from 'vitest'
import { parseCubeLut, sampleCubeTetra } from './cube-lut'

/** Build an identity 2³ .cube (corners of the unit cube). */
function identityCube2(): string {
  const lines = ['TITLE "id"', 'LUT_3D_SIZE 2']
  // r fastest, then g, then b
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${r} ${g} ${b}`)
  return lines.join('\n')
}

describe('parseCubeLut', () => {
  it('parses a minimal identity 2³ cube', () => {
    const lut = parseCubeLut(identityCube2())
    expect(lut).not.toBeNull()
    expect(lut!.dimension).toBe(2)
    expect(lut!.data.length).toBe(2 * 2 * 2 * 4)
    // first node (0,0,0) → black, alpha 1
    expect(Array.from(lut!.data.slice(0, 4))).toEqual([0, 0, 0, 1])
    // last node (1,1,1) → white
    expect(Array.from(lut!.data.slice(28, 32))).toEqual([1, 1, 1, 1])
  })

  it('handles comments, blank lines, and CRLF', () => {
    const txt =
      '# comment\r\nLUT_3D_SIZE 2\r\n\r\n' + '0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1\r\n'
    const lut = parseCubeLut(txt)
    expect(lut?.dimension).toBe(2)
  })

  it('applies DOMAIN_MIN/MAX normalization', () => {
    const txt = [
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 2 2 2',
      '0 0 0',
      '2 0 0',
      '0 2 0',
      '2 2 0',
      '0 0 2',
      '2 0 2',
      '0 2 2',
      '2 2 2',
    ].join('\n')
    const lut = parseCubeLut(txt)
    expect(lut).not.toBeNull()
    // node (1,0,0) raw=2 over domain 0..2 → normalized 1
    expect(lut!.data[4]).toBeCloseTo(1, 5)
  })

  it('rejects 1D LUTs', () => {
    expect(parseCubeLut('LUT_1D_SIZE 16\n0 0 0\n1 1 1')).toBeNull()
  })

  it('rejects truncated data (wrong count)', () => {
    const txt = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0' // only 3 of 8 nodes
    expect(parseCubeLut(txt)).toBeNull()
  })

  it('rejects malformed numeric rows', () => {
    const txt = 'LUT_3D_SIZE 2\n0 0 0\nxx 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1'
    expect(parseCubeLut(txt)).toBeNull()
  })

  it('rejects out-of-range dimensions', () => {
    expect(parseCubeLut('LUT_3D_SIZE 1\n0 0 0')).toBeNull()
    expect(parseCubeLut('LUT_3D_SIZE 128')).toBeNull()
    expect(parseCubeLut('0 0 0')).toBeNull() // no LUT_3D_SIZE at all
  })

  it('accepts a 64³ cube and rejects 65³ (65 × 4225 strip exceeds a 4096 texture limit)', () => {
    const rows = ['LUT_3D_SIZE 64']
    for (let i = 0; i < 64 ** 3; i++) rows.push('0.5 0.5 0.5')
    expect(parseCubeLut(rows.join('\n'))?.dimension).toBe(64)
    expect(parseCubeLut('LUT_3D_SIZE 65\n0 0 0')).toBeNull()
  })

  it('accepts lowercase / mixed-case keywords', () => {
    const txt = identityCube2().replace('TITLE', 'title').replace('LUT_3D_SIZE', 'lut_3d_size')
    expect(parseCubeLut(`${txt}`.replace('lut_3d_size 2', 'lut_3d_size 2\nDomain_Max 1 1 1'))?.dimension).toBe(2)
    expect(parseCubeLut('lut_1d_size 16\n0 0 0')).toBeNull()
  })

  it('takes the first three values of rows with extra numeric columns', () => {
    const lut = parseCubeLut(identityCube2().replace('1 1 1', '1 1 1 1').replace('0 0 0', '0 0 0 0.5 7'))
    expect(lut?.dimension).toBe(2)
    expect(Array.from(lut!.data.slice(28, 32))).toEqual([1, 1, 1, 1])
    expect(parseCubeLut(identityCube2().replace('1 1 1', '1 1 1 x'))).toBeNull()
  })

  it('rejects extra data rows, rows with the wrong arity, and keywords after data', () => {
    expect(parseCubeLut(identityCube2() + '\n0 0 0')).toBeNull()
    expect(parseCubeLut(identityCube2().replace('1 1 1', '1 1'))).toBeNull()
    expect(parseCubeLut(identityCube2() + '\nDOMAIN_MAX 1 1 1')).toBeNull()
  })

  it('ignores TITLE, trailing comments and unknown header keywords', () => {
    const txt = identityCube2().replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2 # size\nLUT_IN_VIDEO_RANGE')
    expect(parseCubeLut(txt)?.dimension).toBe(2)
  })

  it('rejects an empty or inverted domain', () => {
    const body = identityCube2().split('\n').slice(2).join('\n')
    expect(parseCubeLut(`LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 1 1 1\n${body}`)).toBeNull()
  })

  it('honours LUT_3D_INPUT_RANGE as a uniform domain', () => {
    const rows = ['LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE 0 4']
    for (let b = 0; b < 2; b++)
      for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${r * 4} ${g * 4} ${b * 4}`)
    expect(parseCubeLut(rows.join('\n'))!.data[4]).toBeCloseTo(1, 5)
  })
})

const invertCube2 = () => {
  const lines = ['LUT_3D_SIZE 2']
  for (let b = 0; b < 2; b++)
    for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${1 - r} ${1 - g} ${1 - b}`)
  return lines.join('\n')
}

// sampleCubeTetra is the CPU twin of the shader's tetrahedral LUT step.
describe('sampleCubeTetra', () => {
  it('identity cube returns the input', () => {
    const lut = parseCubeLut(identityCube2())!
    const [r, g, b] = sampleCubeTetra(lut, 0.3, 0.6, 0.9)
    expect(r).toBeCloseTo(0.3, 4)
    expect(g).toBeCloseTo(0.6, 4)
    expect(b).toBeCloseTo(0.9, 4)
  })

  it('inverts an invert cube exactly (affine cubes are reproduced)', () => {
    const lut = parseCubeLut(invertCube2())!
    const [r, g, b] = sampleCubeTetra(lut, 200 / 255, 50 / 255, 50 / 255)
    expect(r * 255).toBeCloseTo(55, 3)
    expect(g * 255).toBeCloseTo(205, 3)
    expect(b * 255).toBeCloseTo(205, 3)
  })

  it('intensity 0 returns the input unchanged', () => {
    const lut = parseCubeLut(invertCube2())!
    expect(sampleCubeTetra(lut, 0.25, 0.5, 0.75, 0)).toEqual([0.25, 0.5, 0.75])
  })

  it('half intensity lands midway between input and LUT output', () => {
    const lut = parseCubeLut(invertCube2())!
    const [r] = sampleCubeTetra(lut, 0.2, 0.5, 0.5, 0.5)
    expect(r).toBeCloseTo(0.5, 5)
  })

  it('is exact at every lattice node of a non-affine 3³ cube', () => {
    const rows = ['LUT_3D_SIZE 3']
    const val = (r: number, g: number, b: number) => [(r * r) / 4, 0.5 + Math.sin(g + b) / 2, ((r + 2 * g + b) % 3) / 2]
    for (let b = 0; b < 3; b++)
      for (let g = 0; g < 3; g++) for (let r = 0; r < 3; r++) rows.push(val(r, g, b).join(' '))
    const lut = parseCubeLut(rows.join('\n'))!
    for (let b = 0; b < 3; b++)
      for (let g = 0; g < 3; g++)
        for (let r = 0; r < 3; r++) {
          const out = sampleCubeTetra(lut, r / 2, g / 2, b / 2)
          const want = val(r, g, b)
          for (let c = 0; c < 3; c++) expect(out[c]).toBeCloseTo(want[c], 5)
        }
  })

  it('weights the tetrahedron picked by the ordering of the fractions', () => {
    // Identity except node (1,0,0) → (0.3,0,0). At (0.7,0.5,0.2) r>g>b, so the path is
    // 000 → 100 → 110 → 111 with weights 0.3, 0.2, 0.3, 0.2 → red = 0.2·0.3 + 0.3 + 0.2.
    const lines = ['LUT_3D_SIZE 2']
    for (let b = 0; b < 2; b++)
      for (let g = 0; g < 2; g++)
        for (let r = 0; r < 2; r++) lines.push(r === 1 && g === 0 && b === 0 ? '0.3 0 0' : `${r} ${g} ${b}`)
    const lut = parseCubeLut(lines.join('\n'))!
    const [r, g, b] = sampleCubeTetra(lut, 0.7, 0.5, 0.2)
    expect(r).toBeCloseTo(0.56, 5)
    expect(g).toBeCloseTo(0.5, 5)
    expect(b).toBeCloseTo(0.2, 5)
  })

  it('clamps out-of-range input to the cube surface', () => {
    const lut = parseCubeLut(invertCube2())!
    const [r, g, b] = sampleCubeTetra(lut, 1.5, -0.5, 0.5)
    expect(r).toBeCloseTo(0, 5)
    expect(g).toBeCloseTo(1, 5)
    expect(b).toBeCloseTo(0.5, 5)
  })
})
