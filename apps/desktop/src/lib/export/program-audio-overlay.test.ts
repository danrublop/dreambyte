import { describe, it, expect } from 'vitest'
import { atempoChain, volumeFilterFor, buildProgramOverlayArgs } from './program-audio-overlay'

const clip = (over: Partial<Parameters<typeof volumeFilterFor>[0]> = {}) => ({
  src: 'dreambyte://audio/music.mp3',
  startTime: 2,
  duration: 4,
  trimStart: 0.5,
  speed: 1,
  gain: 0.8,
  ...over,
})

describe('atempoChain', () => {
  it('is empty at speed 1 (and near-1, and non-positive)', () => {
    expect(atempoChain(1)).toEqual([])
    expect(atempoChain(1.0005)).toEqual([])
    expect(atempoChain(0)).toEqual([])
    expect(atempoChain(-2)).toEqual([])
  })
  it('decomposes out-of-window rates into [0.5,2] stages whose product is the speed', () => {
    expect(atempoChain(4)).toEqual(['atempo=2.0', 'atempo=2.00000000'])
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.50000000'])
    const product = (chain: string[]) => chain.reduce((p, s) => p * Number(s.split('=')[1]), 1)
    expect(product(atempoChain(7))).toBeCloseTo(7, 6)
    expect(product(atempoChain(0.1))).toBeCloseTo(0.1, 6)
  })
})

describe('volumeFilterFor', () => {
  it('constant volume without an envelope', () => {
    expect(volumeFilterFor(clip())).toBe('volume=0.8000')
  })
  it('piecewise-linear eval=frame expression with an envelope', () => {
    const f = volumeFilterFor(
      clip({
        gainEnvelope: [
          { t: 0, v: 0 },
          { t: 1, v: 1 },
        ],
      }),
    )
    expect(f).toContain('volume=eval=frame:volume=')
    expect(f).toContain('lerp(0.0000,1.0000,')
  })
})

describe('buildProgramOverlayArgs', () => {
  const resolved = (n: number) =>
    Array.from({ length: n }, (_v, i) => ({ file: `/tmp/c${i}.wav`, c: clip({ startTime: i * 2 }) }))

  it('single clip: no amix for the clip stage, master volume applied', () => {
    const args = buildProgramOverlayArgs({
      videoPath: '/tmp/v.mp4',
      resolved: resolved(1),
      masterVolume: 1,
      videoHasAudio: false,
      outPath: '/tmp/o.mp4',
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('[c0]volume=1.0000[prog]')
    expect(fc).not.toContain('clipmix')
    expect(fc).toContain('[prog]anull[aout]') // no scene audio → no 2-input mix
  })

  it('multi clip: full-gain summing (amix normalize=0, dropout_transition=0)', () => {
    const args = buildProgramOverlayArgs({
      videoPath: '/tmp/v.mp4',
      resolved: resolved(2),
      masterVolume: 0.9,
      videoHasAudio: true,
      outPath: '/tmp/o.mp4',
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('amix=inputs=2:normalize=0:dropout_transition=0[clipmix]')
    expect(fc).toContain('[clipmix]volume=0.9000[prog]')
    expect(fc).toContain('[0:a][prog]amix=inputs=2:normalize=0:dropout_transition=0[aout]')
  })

  it('audio-only pass: video stream is copied, never re-encoded', () => {
    const args = buildProgramOverlayArgs({
      videoPath: '/tmp/v.mp4',
      resolved: resolved(1),
      masterVolume: 1,
      videoHasAudio: false,
      outPath: '/tmp/o.mp4',
    })
    expect(args.join(' ')).toContain('-map 0:v -map [aout] -c:v copy')
  })

  it('clip chain: atrim → asetpts → volume → adelay at the timeline position', () => {
    const args = buildProgramOverlayArgs({
      videoPath: '/tmp/v.mp4',
      resolved: [{ file: '/tmp/c.wav', c: clip({ startTime: 2.5, trimStart: 0.5, duration: 4 }) }],
      masterVolume: 1,
      videoHasAudio: false,
      outPath: '/tmp/o.mp4',
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain(
      '[1:a]atrim=start=0.500:end=4.500,asetpts=PTS-STARTPTS,volume=0.8000,adelay=delays=2500:all=1[c0]',
    )
  })
})
