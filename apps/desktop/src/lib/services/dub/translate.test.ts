import { describe, it, expect, vi } from 'vitest'
import { translateSegments, parseNumberedResponse, buildTranslatePrompt, TranslateError } from './translate'

describe('buildTranslatePrompt', () => {
  it('numbers every cue and states the exact count + target language', () => {
    const p = buildTranslatePrompt(['Hello', 'Bye'], 'Spanish', 'English')
    expect(p).toMatch(/2 subtitle cues from English into Spanish/)
    expect(p).toMatch(/EXACTLY 2 lines/)
    expect(p).toContain('1. Hello')
    expect(p).toContain('2. Bye')
  })
})

describe('parseNumberedResponse', () => {
  it('parses numbered lines back into per-index order', () => {
    expect(parseNumberedResponse('1. Hola\n2. Adiós', 2)).toEqual(['Hola', 'Adiós'])
  })

  it('ignores model preamble and blank lines', () => {
    const r = `Sure, here are the translations:\n\n1. Hola\n2. ¿Cómo estás?\n`
    expect(parseNumberedResponse(r, 2)).toEqual(['Hola', '¿Cómo estás?'])
  })

  it('tolerates 1) and 1: numbering styles', () => {
    expect(parseNumberedResponse('1) Uno\n2: Dos', 2)).toEqual(['Uno', 'Dos'])
  })

  it('throws when a cue index is missing (no silent desync)', () => {
    expect(() => parseNumberedResponse('1. Hola', 2)).toThrow(TranslateError)
    expect(() => parseNumberedResponse('1. Hola\n3. Tres', 3)).toThrow(/missing 1 of 3/)
  })

  it('keeps the first occurrence on a duplicate index', () => {
    expect(parseNumberedResponse('1. first\n1. dup\n2. second', 2)).toEqual(['first', 'second'])
  })
})

describe('translateSegments', () => {
  it('returns one translation per input, in order', async () => {
    const complete = vi.fn(async () => '1. Hola\n2. Mundo')
    const out = await translateSegments(['Hello', 'World'], 'es', 'en', { complete })
    expect(out).toEqual(['Hola', 'Mundo'])
    expect(complete).toHaveBeenCalledOnce()
  })

  it('short-circuits empty input with no model call', async () => {
    const complete = vi.fn(async () => '')
    expect(await translateSegments([], 'es', 'en', { complete })).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it('propagates a count mismatch as TranslateError', async () => {
    const complete = vi.fn(async () => '1. only one')
    await expect(translateSegments(['a', 'b'], 'es', undefined, { complete })).rejects.toBeInstanceOf(TranslateError)
  })
})
