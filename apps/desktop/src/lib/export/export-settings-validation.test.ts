import { describe, it, expect } from 'vitest'
import { normalizeExportSettings, validateExportSettings } from './export-settings-validation'

describe('validateExportSettings', () => {
  it('passes through supported resolution + fps', () => {
    expect(validateExportSettings({ resolution: '4k', fps: 60 })).toEqual({ resolution: '4k', fps: 60 })
    expect(validateExportSettings({ resolution: '720p', fps: 24 })).toEqual({ resolution: '720p', fps: 24 })
  })

  it('defaults an unknown/missing resolution to 1080p', () => {
    expect(validateExportSettings({ resolution: '8k' }).resolution).toBe('1080p')
    expect(validateExportSettings({}).resolution).toBe('1080p')
    expect(validateExportSettings({ resolution: 42 as unknown }).resolution).toBe('1080p')
  })

  it('floors a fractional fps that rounds to 0 (never reaches the encoder as zero)', () => {
    expect(validateExportSettings({ fps: 0.1 }).fps).toBe(1)
  })

  it('caps fps at 60 (the ExportFPS max) to avoid a 4k@240 resource bomb', () => {
    expect(validateExportSettings({ fps: 240 }).fps).toBe(60)
    expect(validateExportSettings({ fps: 1000 }).fps).toBe(60)
  })

  it('defaults non-finite / non-positive fps to 30', () => {
    expect(validateExportSettings({ fps: 0 }).fps).toBe(30)
    expect(validateExportSettings({ fps: -5 }).fps).toBe(30)
    expect(validateExportSettings({ fps: NaN }).fps).toBe(30)
    expect(validateExportSettings({ fps: 'abc' }).fps).toBe(30)
    expect(validateExportSettings({}).fps).toBe(30)
  })

  it('rounds and accepts an in-range integer-ish fps', () => {
    expect(validateExportSettings({ fps: 29.6 }).fps).toBe(30)
    expect(validateExportSettings({ fps: 50 }).fps).toBe(50)
  })
})

describe('normalizeExportSettings', () => {
  it('passes through values already on the ExportFPS union', () => {
    expect(normalizeExportSettings({ resolution: '4k', fps: 60 })).toEqual({ resolution: '4k', fps: 60 })
    expect(normalizeExportSettings({ resolution: '720p', fps: 25 })).toEqual({ resolution: '720p', fps: 25 })
  })

  it('snaps an in-range but unsupported fps to the nearest ExportFPS step', () => {
    expect(normalizeExportSettings({ fps: 23 }).fps).toBe(24)
    expect(normalizeExportSettings({ fps: 27 }).fps).toBe(25) // |27-25| < |27-30| ⇒ 25 wins
    expect(normalizeExportSettings({ fps: 50 }).fps).toBe(60)
  })

  it('shares the base validator for hostile input (bogus res → 1080p, 240fps → 60)', () => {
    expect(normalizeExportSettings({ resolution: '8k', fps: 240 })).toEqual({ resolution: '1080p', fps: 60 })
    expect(normalizeExportSettings({ fps: NaN }).fps).toBe(30)
    expect(normalizeExportSettings({ fps: 0.1 }).fps).toBe(24) // floored to 1, snapped to nearest step
  })
})
