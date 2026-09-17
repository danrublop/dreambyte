import { describe, expect, it } from 'vitest'
import { THREE_SYSTEM_PROMPT } from './prompts'

const PALETTE = ['#1a1a2e', '#e84545', '#16a34a', '#2563eb']
const BG = '#fffef9'
const DURATION = 8

describe('THREE_SYSTEM_PROMPT', () => {
  const prompt = THREE_SYSTEM_PROMPT(PALETTE, BG, DURATION, '')

  it('documents the new cookbook sections', () => {
    expect(prompt).toContain('POST-FX COOKBOOK')
    expect(prompt).toContain('POSTFX PRESETS')
    expect(prompt).toContain('SCENE BUILDERS')
    expect(prompt).toContain('ADVANCED / OPT-IN')
  })

  it('exposes new helper globals in the globals list', () => {
    const mustHave = [
      'createDreambytePostFX',
      'createDreambytePostFXPreset',
      'DREAMBYTE_POSTFX_PRESETS',
      'DREAMBYTE_TONE_MAPS',
      'addCinematicLighting',
      'addGroundPlane',
      'loadPBRSet',
      'loadHDREnvironment',
      'createInstancedField',
      'createPositionalAudio',
    ]
    for (const name of mustHave) {
      expect(prompt).toContain(name)
    }
  })

  it('boilerplate uses DREAMBYTE_TONE_MAPS.aces', () => {
    expect(prompt).toContain('renderer.toneMapping = DREAMBYTE_TONE_MAPS.aces')
  })

  it('stays within the prompt budget (hard ceiling 24000 chars / ~6k tokens)', () => {
    // Ceiling set just above the measured prompt size so growth is a deliberate choice.
    expect(prompt.length).toBeLessThan(24_000)
  })

  it('still mentions every registered stage environment id', () => {
    const ids = [
      'studio_white',
      'cinematic_fog',
      'iso_playful',
      'tech_grid',
      'nature_sunset',
      'data_lab',
      'track_rolling_topdown',
    ]
    for (const id of ids) {
      expect(prompt).toContain(id)
    }
  })
})
