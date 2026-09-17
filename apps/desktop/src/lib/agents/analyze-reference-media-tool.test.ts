// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { executeTool, type WorldStateMutable } from './tool-executor'
import { ALL_TOOLS } from './tools'
import { createDefaultProject, createDefaultScene } from '../store/helpers'
import type { ReferenceMedia } from './types'

function worldWith(referenceMedia?: ReferenceMedia[]): WorldStateMutable {
  const scene = createDefaultScene()
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([scene]).sceneGraph,
    ...(referenceMedia ? { referenceMedia } : {}),
    // No engines configured + no keys/Ollama in test → analyzer yields a
    // "no engine" analysis, but the tool itself must still succeed.
  }
}

const IMG: ReferenceMedia = { id: 'ref1', kind: 'image', uri: 'file:///tmp/x.png', mimeType: 'image/png' }

describe('analyze_reference_media tool', () => {
  it('is registered, read-only (no mutates), and present in ALL_TOOLS', () => {
    const def = ALL_TOOLS.find((t) => t.name === 'analyze_reference_media')
    expect(def).toBeDefined()
    expect(def?.mutates).toBeFalsy()
    expect(def?.input_schema?.required).toContain('mediaId')
  })

  it('errors helpfully when the media id is unknown', async () => {
    const result = await executeTool('analyze_reference_media', { mediaId: 'nope' }, worldWith([IMG]))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No reference media with id "nope"/)
    expect(result.error).toMatch(/ref1/) // lists what's attached
  })

  it('errors when no media is attached', async () => {
    const result = await executeTool('analyze_reference_media', { mediaId: 'ref1' }, worldWith())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/none/)
  })

  it('resolves a known id and returns an analysis envelope (degrades, never throws)', async () => {
    const result = await executeTool('analyze_reference_media', { mediaId: 'ref1' }, worldWith([IMG]))
    expect(result.success).toBe(true)
    const data = result.data as { analysis: unknown; summary: string; modelsUsed: string[] }
    expect(data).toHaveProperty('analysis')
    expect(typeof data.summary).toBe('string')
    expect(Array.isArray(data.modelsUsed)).toBe(true)
  })
})
