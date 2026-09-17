import { describe, it, expect } from 'vitest'
import { parseMusicPrompt } from './parse-music-prompt'

describe('parseMusicPrompt', () => {
  it('maps genre keywords to templates', () => {
    expect(parseMusicPrompt('epic cinematic orchestral trailer').templateId).toBe('cinematic')
    expect(parseMusicPrompt('chill lofi study beats').templateId).toBe('lofi')
    expect(parseMusicPrompt('upbeat corporate tech presentation').templateId).toBe('corporate')
    expect(parseMusicPrompt('dark suspenseful thriller score').templateId).toBe('tension')
    expect(parseMusicPrompt('retro 80s synthwave').templateId).toBe('synthwave')
    expect(parseMusicPrompt('gentle acoustic folk').templateId).toBe('folk')
  })

  it('defaults to a calm lo-fi bed for an unrecognized prompt', () => {
    expect(parseMusicPrompt('something indescribable xyz').templateId).toBe('lofi')
  })

  it('extracts an instrument when named (longest match wins)', () => {
    expect(parseMusicPrompt('warm piano background').instrument).toBe('piano')
    expect(parseMusicPrompt('electric piano groove').instrument).toBe('electric-piano')
    expect(parseMusicPrompt('soft strings underscore').instrument).toBe('strings')
    expect(parseMusicPrompt('no instrument mentioned here').instrument).toBeUndefined()
  })

  it('derives texture from solo / minimal cues', () => {
    expect(parseMusicPrompt('solo piano').texture).toBe('solo')
    expect(parseMusicPrompt('gentle background bed').texture).toBe('minimal')
    expect(parseMusicPrompt('full energetic band').texture).toBeUndefined()
  })

  it('infers a key from mood words', () => {
    expect(parseMusicPrompt('sad melancholic piano').key).toBe('C minor')
    expect(parseMusicPrompt('happy bright melody').key).toBe('C major')
  })

  it('composes a real example: "solo piano background music"', () => {
    const p = parseMusicPrompt('solo piano background music, calm and mellow')
    expect(p.instrument).toBe('piano')
    expect(p.texture).toBe('solo') // solo wins over minimal
    expect(p.templateId).toBe('lofi') // mellow → lofi
    expect(p.sceneDurationSec).toBeGreaterThan(0)
  })
})
