import { describe, expect, it } from 'vitest'
import { normalizeWikimediaThumbUrl } from './wikimedia-url'

describe('normalizeWikimediaThumbUrl', () => {
  it('rewrites a Wikimedia thumb URL to Special:FilePath with the width', () => {
    const thumb =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/42/FIFA_World_Cup_Trophy_2018.jpg/440px-FIFA_World_Cup_Trophy_2018.jpg'
    expect(normalizeWikimediaThumbUrl(thumb)).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/FIFA_World_Cup_Trophy_2018.jpg?width=440',
    )
  })

  it('handles an SVG-derived thumb (PNG render): file keeps the .svg name, width carried', () => {
    const thumb =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/9/96/Pictogram_voting_keep.svg/240px-Pictogram_voting_keep.svg.png'
    expect(normalizeWikimediaThumbUrl(thumb)).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/Pictogram_voting_keep.svg?width=240',
    )
  })

  it('passes a full-res Wikimedia file URL through unchanged (those already 200)', () => {
    const full = 'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg'
    expect(normalizeWikimediaThumbUrl(full)).toBe(full)
  })

  it('passes non-Wikimedia hosts through unchanged', () => {
    const unsplash = 'https://images.unsplash.com/photo-1551958219-acbc608c6377?w=640&q=80'
    expect(normalizeWikimediaThumbUrl(unsplash)).toBe(unsplash)
  })

  it('keeps a percent-encoded filename intact', () => {
    const thumb =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/A%20file%20name.jpg/300px-A%20file%20name.jpg'
    expect(normalizeWikimediaThumbUrl(thumb)).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/A%20file%20name.jpg?width=300',
    )
  })

  it('returns the input unchanged for a non-URL string', () => {
    expect(normalizeWikimediaThumbUrl('not a url')).toBe('not a url')
  })

  it('rewrites without a width when the size segment has no Npx- prefix', () => {
    // defensive: a malformed thumb path still routes to the canonical file (no width)
    const odd = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/42/Trophy.jpg/Trophy.jpg'
    expect(normalizeWikimediaThumbUrl(odd)).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/Trophy.jpg',
    )
  })
})
