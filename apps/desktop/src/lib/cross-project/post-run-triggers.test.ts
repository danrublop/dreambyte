import { describe, it, expect } from 'vitest'
import { resolveCrossProjectPicker } from './post-run-triggers'

const origin = { projectId: 'A', message: 'hi' }
const spec = { instruction: 'apply the brand kit', originBody: origin }

describe('resolveCrossProjectPicker', () => {
  it('returns the picker payload when there is a proposal (with origin body) and the run was not aborted', () => {
    expect(resolveCrossProjectPicker(spec, false)).toEqual({
      instruction: 'apply the brand kit',
      originBody: origin,
    })
  })

  it('returns null when there is no proposal (agent did not call dispatch_to_projects)', () => {
    expect(resolveCrossProjectPicker(null, false)).toBeNull()
  })

  it('returns null when the run was aborted (a Stop right after the proposal must not open the picker)', () => {
    expect(resolveCrossProjectPicker(spec, true)).toBeNull()
  })

  it('returns null when the proposal carried no origin body', () => {
    expect(resolveCrossProjectPicker({ instruction: 'x', originBody: null }, false)).toBeNull()
  })

  it('passes the bundled origin body through by reference (instruction + body always from the same run)', () => {
    const out = resolveCrossProjectPicker(spec, false)
    expect(out?.originBody).toBe(origin)
  })
})
