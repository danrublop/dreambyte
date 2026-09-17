// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { afterEach, describe, it, expect } from 'vitest'

import { addCaptionsForClip } from './add-captions'
import { setCaptionTranscriber } from './caption-transcriber'
import type { Clip } from '@/lib/types'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    sourceType: 'video',
    sourceId: 'video://fixture.mp4',
    label: '',
    startTime: 0,
    duration: 10,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...overrides,
  }
}

afterEach(() => setCaptionTranscriber(null))

describe('addCaptionsForClip', () => {
  it('throws a useful error when no transcriber is configured', async () => {
    await expect(addCaptionsForClip({ clip: clip(), sourceUri: 'foo' })).rejects.toThrow(
      /Caption transcriber not configured/,
    )
  })

  it('returns a plan with one track/add and N clip/add for N cues', async () => {
    setCaptionTranscriber({
      async transcribe() {
        return {
          srt: ['1', '00:00:01,000 --> 00:00:02,000', 'Hello', '', '2', '00:00:03,000 --> 00:00:04,000', 'World'].join(
            '\n',
          ),
          language: 'en',
        }
      },
    })
    const result = await addCaptionsForClip({ clip: clip(), sourceUri: 'video://fixture.mp4' })
    expect(result.cues.length).toBe(2)
    expect(result.plan.cueCount).toBe(2)
    expect(result.plan.actions[0].type).toBe('track/add')
    expect(result.plan.actions.filter((a) => a.type === 'clip/add').length).toBe(2)
    expect(result.language).toBe('en')
  })

  it('reuses an existing subtitles track when one is supplied', async () => {
    setCaptionTranscriber({
      async transcribe() {
        return { srt: '1\n00:00:01,000 --> 00:00:02,000\nHi' }
      },
    })
    const result = await addCaptionsForClip({
      clip: clip(),
      sourceUri: 'foo',
      subtitlesTrackId: 'sub-existing',
    })
    expect(result.plan.trackId).toBe('sub-existing')
    expect(result.plan.actions.filter((a) => a.type === 'track/add').length).toBe(0)
  })

  it('passes transcribeOptions through to the transcriber', async () => {
    let received: unknown = null
    setCaptionTranscriber({
      async transcribe(_source, options) {
        received = options
        return { srt: '1\n00:00:01,000 --> 00:00:02,000\nx' }
      },
    })
    await addCaptionsForClip({
      clip: clip(),
      sourceUri: 'foo',
      transcribeOptions: { language: 'es', prompt: 'spanish technical' },
    })
    expect(received).toEqual({ language: 'es', prompt: 'spanish technical' })
  })
})
