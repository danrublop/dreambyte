// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { EASINGS } from './EasingCurvePicker'

describe('EasingCurvePicker', () => {
  it('exports exactly the four CSS easings the keyframe reducer accepts', () => {
    expect(EASINGS).toEqual(['linear', 'ease-in', 'ease-out', 'ease-in-out'])
  })
})
