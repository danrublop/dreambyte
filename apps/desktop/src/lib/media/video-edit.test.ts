import { describe, it, expect } from 'vitest'
import {
  compileVideoEdit,
  editPromptForProvider,
  effectiveVideoPrompt,
  isVideoEditOperation,
  VIDEO_EDIT_OPERATIONS,
} from './video-edit'

describe('compileVideoEdit', () => {
  it('frames each operation around the instruction, pinning what stays constant', () => {
    expect(compileVideoEdit('restyle', 'neon cyberpunk')).toMatch(
      /^Restyle this video as neon cyberpunk,.*preserving the original motion/,
    )
    expect(compileVideoEdit('relight', 'golden hour')).toMatch(/^Relight this video: golden hour\..*unchanged/)
    expect(compileVideoEdit('add-object', 'a red umbrella')).toMatch(/^Add to this video: a red umbrella,/)
    expect(compileVideoEdit('remove-object', 'the logo')).toMatch(/^Remove from this video: the logo,/)
    expect(compileVideoEdit('new-angle', 'low wide shot')).toMatch(/new camera angle: low wide shot/)
    expect(compileVideoEdit('replace-bg', 'a snowy forest')).toMatch(
      /Replace the background\/environment of this video with a snowy forest/,
    )
  })

  it('falls back to a per-operation default when the instruction is empty', () => {
    expect(compileVideoEdit('restyle', '')).toContain('a bold new visual style')
    expect(compileVideoEdit('relight', '   ')).toContain('dramatic cinematic lighting')
    expect(compileVideoEdit('restyle', null)).toContain('a bold new visual style')
    expect(compileVideoEdit('restyle', undefined)).toContain('a bold new visual style')
  })

  it('returns empty string for an unknown operation', () => {
    expect(compileVideoEdit('not-an-op' as never, 'x')).toBe('')
  })

  it('every catalog operation compiles to a non-empty clause', () => {
    for (const op of VIDEO_EDIT_OPERATIONS) {
      expect(compileVideoEdit(op, 'test instruction').length, op).toBeGreaterThan(0)
    }
  })
})

describe('isVideoEditOperation', () => {
  it('accepts only the known operations', () => {
    expect(isVideoEditOperation('restyle')).toBe(true)
    expect(isVideoEditOperation('replace-bg')).toBe(true)
    expect(isVideoEditOperation('zoom')).toBe(false)
    expect(isVideoEditOperation(null)).toBe(false)
    expect(isVideoEditOperation(42)).toBe(false)
  })
})

describe('editPromptForProvider', () => {
  it('compiles for a v2v-capable provider (runway → videoToVideo:true)', () => {
    const out = editPromptForProvider('runway', { operation: 'restyle' }, 'watercolor')
    expect(out).toMatch(/Restyle this video as watercolor/)
  })

  it('returns empty for a non-v2v provider (veo3 → videoToVideo:false), so callers keep the plain prompt', () => {
    expect(editPromptForProvider('veo3', { operation: 'restyle' }, 'watercolor')).toBe('')
  })

  it('returns empty when there is no edit spec', () => {
    expect(editPromptForProvider('runway', null, 'watercolor')).toBe('')
    expect(editPromptForProvider('runway', undefined, 'watercolor')).toBe('')
  })
})

describe('effectiveVideoPrompt', () => {
  it('an edit prompt REPLACES the base (and suppresses any camera clause)', () => {
    const out = effectiveVideoPrompt({
      basePrompt: 'a dog running',
      editPrompt: 'Restyle this video as watercolor.',
      cameraClause: 'Camera movement: fast dolly in.',
    })
    expect(out).toBe('Restyle this video as watercolor.')
    expect(out).not.toContain('a dog running') // base dropped
    expect(out).not.toContain('Camera movement') // camera suppressed for an edit
  })

  it('appends the camera clause to the base when there is no edit', () => {
    expect(effectiveVideoPrompt({ basePrompt: 'a dog running', cameraClause: 'Camera movement: pan left.' })).toBe(
      'a dog running Camera movement: pan left.',
    )
  })

  it('returns the bare base when neither edit nor camera is present', () => {
    expect(effectiveVideoPrompt({ basePrompt: 'a dog running' })).toBe('a dog running')
    expect(effectiveVideoPrompt({ basePrompt: 'a dog running', editPrompt: '' })).toBe('a dog running')
  })
})
