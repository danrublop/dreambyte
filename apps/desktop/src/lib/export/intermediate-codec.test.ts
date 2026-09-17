import { describe, it, expect } from 'vitest'
import { chooseIntermediateCodec, isBlendTransition } from './intermediate-codec'

describe('isBlendTransition', () => {
  it('treats none / missing as a hard cut (not a blend)', () => {
    expect(isBlendTransition({ type: 'none' })).toBe(false)
    expect(isBlendTransition({})).toBe(false)
    expect(isBlendTransition(null)).toBe(false)
    expect(isBlendTransition(undefined)).toBe(false)
  })
  it('treats any non-none type as a blend', () => {
    expect(isBlendTransition({ type: 'crossfade' })).toBe(true)
    expect(isBlendTransition({ type: 'wipe-left' })).toBe(true)
  })
})

describe('chooseIntermediateCodec', () => {
  it('cuts-only export → crf14 (intermediate is the stream-copied final)', () => {
    expect(chooseIntermediateCodec([])).toBe('crf14')
    expect(chooseIntermediateCodec([{ type: 'none' }, { type: 'none' }])).toBe('crf14')
  })
  it('any blend present → lossless (xfade re-encode is the only lossy pass)', () => {
    expect(chooseIntermediateCodec([{ type: 'crossfade' }])).toBe('lossless')
    expect(chooseIntermediateCodec([{ type: 'none' }, { type: 'dissolve' }])).toBe('lossless')
  })
})
