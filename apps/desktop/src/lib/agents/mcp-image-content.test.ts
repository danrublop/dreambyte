import { describe, it, expect } from 'vitest'
import { imageContentFromResultData, imageContentsFromResultData } from './mcp-image-content'

describe('imageContentFromResultData (MCP-parity T2)', () => {
  it('splits a capture_frame data:image PNG URI into an MCP image block', () => {
    const data = {
      image: { dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANS', mimeType: 'image/png', width: 1280, height: 720 },
      sceneId: 'abc',
      time: 1,
    }
    expect(imageContentFromResultData(data)).toEqual({
      type: 'image',
      data: 'iVBORw0KGgoAAAANS',
      mimeType: 'image/png',
    })
  })

  it('falls back to the URI mime when no explicit mimeType field', () => {
    const out = imageContentFromResultData({ image: { dataUri: 'data:image/jpeg;base64,/9j/4AAQ' } })
    expect(out).toEqual({ type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' })
  })

  it('handles a URI with no ;base64 marker', () => {
    const out = imageContentFromResultData({ image: { dataUri: 'data:image/png,RAWPAYLOAD', mimeType: 'image/png' } })
    expect(out).toEqual({ type: 'image', data: 'RAWPAYLOAD', mimeType: 'image/png' })
  })

  it('returns null for results with no image (text-only tools)', () => {
    expect(imageContentFromResultData(null)).toBeNull()
    expect(imageContentFromResultData(undefined)).toBeNull()
    expect(imageContentFromResultData({})).toBeNull()
    expect(imageContentFromResultData({ changes: [] })).toBeNull()
    expect(imageContentFromResultData('a string')).toBeNull()
  })

  it('returns null for a malformed / empty image payload', () => {
    expect(imageContentFromResultData({ image: {} })).toBeNull()
    expect(imageContentFromResultData({ image: { dataUri: 'not-a-data-uri' } })).toBeNull()
    expect(imageContentFromResultData({ image: { dataUri: 'data:image/png;base64,' } })).toBeNull()
    expect(imageContentFromResultData({ image: { dataUri: 42 } })).toBeNull()
  })
})

describe('imageContentsFromResultData (T3 — multiple frames)', () => {
  it('extracts a review_video images[] array in order', () => {
    const data = {
      images: [
        { dataUri: 'data:image/png;base64,AAA', mimeType: 'image/png', label: '[1] Intro' },
        { dataUri: 'data:image/png;base64,BBB', mimeType: 'image/png', label: '[2] Body' },
        { dataUri: 'data:image/png;base64,CCC', mimeType: 'image/png', label: '[3] Outro' },
      ],
    }
    expect(imageContentsFromResultData(data)).toEqual([
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBB', mimeType: 'image/png' },
      { type: 'image', data: 'CCC', mimeType: 'image/png' },
    ])
  })

  it('includes a single data.image too (capture_frame), single first', () => {
    const data = {
      image: { dataUri: 'data:image/png;base64,ONE', mimeType: 'image/png' },
      images: [{ dataUri: 'data:image/png;base64,TWO', mimeType: 'image/png' }],
    }
    expect(imageContentsFromResultData(data).map((c) => c.data)).toEqual(['ONE', 'TWO'])
  })

  it('skips malformed entries but keeps the good ones', () => {
    const data = {
      images: [
        { dataUri: 'data:image/png;base64,GOOD' },
        { dataUri: 'broken' },
        {},
        { dataUri: 'data:image/png;base64,ALSO' },
      ],
    }
    expect(imageContentsFromResultData(data).map((c) => c.data)).toEqual(['GOOD', 'ALSO'])
  })

  it('returns [] for text-only results', () => {
    expect(imageContentsFromResultData(null)).toEqual([])
    expect(imageContentsFromResultData({})).toEqual([])
    expect(imageContentsFromResultData({ changes: [] })).toEqual([])
  })
})
