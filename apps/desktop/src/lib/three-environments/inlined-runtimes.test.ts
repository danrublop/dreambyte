import { describe, expect, it } from 'vitest'
import {
  THREE_ENVIRONMENT_RUNTIME_SCRIPT,
  THREE_HELPERS_RUNTIME_SCRIPT,
  THREE_SCATTER_RUNTIME_SCRIPT,
} from './inlined-runtimes'
import { DREAMBYTE_STUDIO_ENV_IDS, DREAMBYTE_THREE_ENVIRONMENTS } from './registry'

/** Rough check that ignores braces/parens inside string literals. */
function countBalanced(src: string, open: string, close: string): number {
  let depth = 0
  let inStr: string | null = null
  let inBlockComment = false
  let inLineComment = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inStr) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === open) depth++
    else if (ch === close) depth--
  }
  return depth
}

describe('Three.js runtime scripts', () => {
  it('environment runtime lists every registered env id in its switch', () => {
    for (const id of DREAMBYTE_STUDIO_ENV_IDS) {
      expect(THREE_ENVIRONMENT_RUNTIME_SCRIPT).toContain(`case '${id}'`)
    }
  })

  it('registry and runtime DREAMBYTE_THREE_ENV_IDS stay in sync', () => {
    for (const id of DREAMBYTE_STUDIO_ENV_IDS) {
      expect(THREE_ENVIRONMENT_RUNTIME_SCRIPT).toContain(`'${id}'`)
    }
    expect(DREAMBYTE_THREE_ENVIRONMENTS.map((e) => e.id).sort()).toEqual([...DREAMBYTE_STUDIO_ENV_IDS].sort())
  })

  it('falls back to studio_white for unknown env ids', () => {
    expect(THREE_ENVIRONMENT_RUNTIME_SCRIPT).toContain('falling back to studio_white')
    expect(THREE_ENVIRONMENT_RUNTIME_SCRIPT).toContain("envId = 'studio_white'")
  })

  it('helpers script defines all documented globals', () => {
    const expected = [
      'window.DREAMBYTE_TONE_MAPS',
      'window.createDreambytePostFX',
      'window.DREAMBYTE_POSTFX_PRESETS',
      'window.createDreambytePostFXPreset',
      'window.addCinematicLighting',
      'window.addGroundPlane',
      'window.loadPBRSet',
      'window.loadHDREnvironment',
      'window.createInstancedField',
      'window.createPositionalAudio',
    ]
    for (const name of expected) {
      expect(THREE_HELPERS_RUNTIME_SCRIPT).toContain(name)
    }
  })

  it('post-fx presets cover the documented look names', () => {
    const presets = [
      'bloom',
      'cinematic',
      'cyberpunk',
      'vintage',
      'dream',
      'matrix',
      'retroPixel',
      'ghibli',
      'noir',
      'sharpCorporate',
    ]
    for (const name of presets) {
      expect(THREE_HELPERS_RUNTIME_SCRIPT).toContain(name)
    }
  })

  it('tone-map presets keys match the documented names', () => {
    const keys = ['aces', 'cineon', 'reinhard', 'linear', 'agx', 'neutral', 'none']
    for (const k of keys) {
      expect(THREE_HELPERS_RUNTIME_SCRIPT).toContain(`${k}:`)
    }
  })

  it('inlined scripts have balanced braces and parens', () => {
    for (const src of [THREE_ENVIRONMENT_RUNTIME_SCRIPT, THREE_SCATTER_RUNTIME_SCRIPT, THREE_HELPERS_RUNTIME_SCRIPT]) {
      expect(countBalanced(src, '{', '}')).toBe(0)
      expect(countBalanced(src, '(', ')')).toBe(0)
      expect(countBalanced(src, '[', ']')).toBe(0)
    }
  })
})
