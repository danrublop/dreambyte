import { describe, it, expect } from 'vitest'
import {
  decideDriftCorrection,
  RESEEK_THRESHOLD_SEC,
  NUDGE_ENGAGE_SEC,
  NUDGE_RELEASE_SEC,
  NUDGE_RATE_DELTA,
  MICRO_FADE_SEC,
} from './drift-policy'

describe('decideDriftCorrection', () => {
  it('does nothing inside the deadband', () => {
    const d = decideDriftCorrection({ drift: 0.02, nudging: false, baseRate: 1 })
    expect(d.action).toBe('none')
    expect(d.playbackRate).toBe(1)
    expect(d.nudging).toBe(false)
  })

  it('engages a nudge above 80 ms drift, preserving pitch', () => {
    const d = decideDriftCorrection({ drift: 0.1, nudging: false, baseRate: 1 })
    expect(d.action).toBe('nudge')
    expect(d.nudging).toBe(true)
    expect(d.preservesPitch).toBe(true)
    // audio ahead → slow down
    expect(d.playbackRate).toBeCloseTo(1 - NUDGE_RATE_DELTA, 10)
  })

  it('nudges the other way when audio is behind', () => {
    const d = decideDriftCorrection({ drift: -0.1, nudging: false, baseRate: 1 })
    expect(d.action).toBe('nudge')
    expect(d.playbackRate).toBeCloseTo(1 + NUDGE_RATE_DELTA, 10)
  })

  it('bends around a non-unity base rate (clip speed)', () => {
    const d = decideDriftCorrection({ drift: 0.1, nudging: false, baseRate: 1.5 })
    expect(d.playbackRate).toBeCloseTo(1.5 * (1 - NUDGE_RATE_DELTA), 10)
  })

  it('reseeks with a micro-fade above 500 ms and cancels any nudge', () => {
    const d = decideDriftCorrection({ drift: 0.8, nudging: true, baseRate: 1 })
    expect(d.action).toBe('reseek')
    expect(d.microFadeSec).toBe(MICRO_FADE_SEC)
    expect(d.playbackRate).toBe(1)
    expect(d.nudging).toBe(false)
  })

  it('releases the nudge only below 30 ms, not at the engage threshold', () => {
    // 50 ms while nudging: still nudging (above release, below engage).
    const stillNudging = decideDriftCorrection({ drift: 0.05, nudging: true, baseRate: 1 })
    expect(stillNudging.action).toBe('nudge')
    expect(stillNudging.nudging).toBe(true)

    // 20 ms while nudging: release.
    const released = decideDriftCorrection({ drift: 0.02, nudging: true, baseRate: 1 })
    expect(released.action).toBe('release')
    expect(released.nudging).toBe(false)
    expect(released.playbackRate).toBe(1)
  })

  it('hysteresis prevents oscillation in the 30–80 ms band', () => {
    // A drift that lingers at 50 ms must NOT cause on/off flapping:
    //  - if not nudging, 50 ms stays 'none' (below 80 ms engage)
    //  - if nudging, 50 ms stays 'nudge' (above 30 ms release)
    const fromIdle = decideDriftCorrection({ drift: 0.05, nudging: false, baseRate: 1 })
    expect(fromIdle.action).toBe('none')
    const fromNudge = decideDriftCorrection({ drift: 0.05, nudging: true, baseRate: 1 })
    expect(fromNudge.action).toBe('nudge')
  })

  it('converges over a simulated drift ramp without flapping', () => {
    // Simulate a voice that starts 120 ms ahead and the nudge pulls it in.
    let nudging = false
    const drifts = [0.12, 0.09, 0.06, 0.04, 0.025, 0.01]
    const actions: string[] = []
    for (const drift of drifts) {
      const d = decideDriftCorrection({ drift, nudging, baseRate: 1 })
      nudging = d.nudging
      actions.push(d.action)
    }
    // Engages once, holds through the 30–80 ms band, releases once near zero.
    expect(actions).toEqual(['nudge', 'nudge', 'nudge', 'nudge', 'release', 'none'])
  })

  it('boundary values: exactly at thresholds do not trigger (strict >)', () => {
    expect(decideDriftCorrection({ drift: NUDGE_ENGAGE_SEC, nudging: false, baseRate: 1 }).action).toBe('none')
    expect(decideDriftCorrection({ drift: RESEEK_THRESHOLD_SEC, nudging: false, baseRate: 1 }).action).not.toBe('reseek')
    // exactly at release threshold while nudging → still nudging (strict <)
    expect(decideDriftCorrection({ drift: NUDGE_RELEASE_SEC, nudging: true, baseRate: 1 }).action).toBe('nudge')
  })
})
