// @vitest-environment node
/**
 * Integration test for the capture_frame server-side pipeline.
 *
 * Exercises every piece that runs without Anthropic:
 *  1. The capture_frame tool handler returns the clientAction marker
 *  2. A pending capture is created, the "client" posts the image back,
 *     the promise resolves with the posted dataUri
 *  3. buildToolResultContent turns that into an Anthropic image block
 *
 * What this does NOT cover: the Anthropic HTTP round-trip. That needs a
 * valid API key + live SDK stream. The pieces below are every line of code
 * executed on the server between "Claude wants a frame" and "Claude sees it".
 */

import { describe, it, expect } from 'vitest'
import { messagesCanCarryImages } from './canonical-messages'
import {
  hasVisionEngine,
  __setVisionEngineResolverForTesting,
  __resetVisionEngineResolverForTesting,
} from './services/visual-quality-check'
import { executeTool } from './tool-executor'
import { createPendingCapture, resolvePendingCapture } from './pending-captures'
import { buildToolResultContent, parseDataUri } from './runner'
import type { Scene, GlobalStyle, SceneGraph } from '../types'
import type { WorldStateMutable } from './world-state'

const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR4nGP8z8Dwn4GBgYGJgYGBAQAVNwF4F7vRTAAAAABJRU5ErkJggg=='

function makeWorld(): WorldStateMutable {
  const scene: Scene = {
    id: 'scene-abc-123',
    name: 'Hero',
    duration: 6,
    bgColor: '#1a2b3c',
    sceneType: 'svg',
    svgContent: '<svg viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#1a2b3c"/></svg>',
    textOverlays: [{ id: 't1', content: 'Caption', x: 10, y: 80, size: 48, color: '#ff0', animation: 'none' }],
  } as unknown as Scene

  const globalStyle: GlobalStyle = {
    palette: ['#1a2b3c', '#ffffff', '#ffff00', '#ff00ff'],
  } as unknown as GlobalStyle

  const sceneGraph: SceneGraph = { nodes: [], edges: [] } as unknown as SceneGraph

  return {
    scenes: [scene],
    globalStyle,
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph,
  }
}

describe('capture_frame end-to-end pipeline', () => {
  it('returns the clientAction marker when invoked', async () => {
    const world = makeWorld()
    const result = await executeTool('capture_frame', { sceneId: 'scene-abc-123', time: 1 }, world)
    expect(result.success).toBe(true)
    const data = result.data as any
    expect(data.clientAction).toBe('capture_frame')
    expect(data.sceneId).toBe('scene-abc-123')
    expect(data.time).toBe(1)
    expect(typeof data.description).toBe('string')
    expect(data.description.length).toBeGreaterThan(0)
  })

  it('resolves the full round-trip: tool → pending capture → client post → image block', async () => {
    const world = makeWorld()

    // 1. Tool runs (this is what executeAndEmit calls)
    const result = await executeTool('capture_frame', { sceneId: 'scene-abc-123', time: 1 }, world)
    expect((result.data as any).clientAction).toBe('capture_frame')

    // 2. runner.ts creates the pending capture
    const { captureId, promise } = createPendingCapture(2000)

    // 3. The "client" receives the capture_request SSE event and POSTs back
    // (simulates what /api/agent/capture-response does)
    setTimeout(() => resolvePendingCapture(captureId, RED_PNG, 'image/png'), 10)

    // 4. runner.ts awaits the image
    const img = await promise
    expect(img.dataUri).toBe(RED_PNG)
    expect(img.mimeType).toBe('image/png')

    // 5. runner.ts attaches it to result.data
    ;(result.data as any).capturedImage = img

    // 6. recordToolResult packages content with buildToolResultContent
    const content = buildToolResultContent(result)

    expect(Array.isArray(content)).toBe(true)
    const blocks = content as Array<any>
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('"success":true')
    expect(blocks[1].type).toBe('image')
    expect(blocks[1].source).toMatchObject({
      type: 'base64',
      media_type: 'image/png',
    })
    expect(blocks[1].source.data.length).toBeGreaterThan(10)
    // Exact payload survives intact
    expect(blocks[1].source.data).toBe(RED_PNG.split(',')[1])
  })

  it('falls back to JSON string when no image was captured', () => {
    const noImage = {
      success: true,
      data: { clientAction: 'capture_frame', sceneId: 'x', time: 1, description: 'text only' },
    }
    const content = buildToolResultContent(noImage as any)
    expect(typeof content).toBe('string')
    expect(content).toContain('"success":true')
  })

  it('falls back to JSON string when the dataUri is malformed', () => {
    const bad = {
      success: true,
      data: {
        clientAction: 'capture_frame',
        sceneId: 'x',
        time: 1,
        description: '...',
        capturedImage: { dataUri: 'not-a-data-uri', mimeType: 'image/png' },
      },
    }
    const content = buildToolResultContent(bad as any)
    expect(typeof content).toBe('string')
  })

  it('parseDataUri accepts each supported image media type', () => {
    for (const mt of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) {
      const parsed = parseDataUri(`data:${mt};base64,AAAA`)
      expect(parsed?.mediaType).toBe(mt)
      expect(parsed?.base64).toBe('AAAA')
    }
    expect(parseDataUri('data:text/plain;base64,AAAA')).toBeNull()
  })

  it('verify_scene also triggers capture_frame (visual verification)', async () => {
    const world = makeWorld()
    const result = await executeTool('verify_scene', { sceneId: 'scene-abc-123', time: 1 }, world)
    const data = result.data as any
    expect(data.clientAction).toBe('capture_frame')
    expect(data.sceneId).toBe('scene-abc-123')
  })
})

describe('review_video handler', () => {
  it('returns the clientAction marker with ordered scene ids + timing', async () => {
    const world = makeWorld()
    const result = await executeTool('review', { scope: 'cut' }, world)
    expect(result.success).toBe(true)
    const data = result.data as any
    expect(data.clientAction).toBe('review_video')
    expect(data.sceneIds).toEqual(['scene-abc-123'])
    expect(data.timing).toEqual([{ index: 0, name: 'Hero', durationSec: 6 }])
    // Non-runner fallback brief is honest, not a fake clean pass.
    expect(data.reviewBrief.reviewable).toBe(false)
  })

  it('errors when there are no scenes to review', async () => {
    const world = { ...makeWorld(), scenes: [] }
    const result = await executeTool('review', { scope: 'cut' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no scenes/i)
  })

  it('caps the contact sheet to 12 scenes (even-sampled, keeps first + last)', async () => {
    const base = makeWorld()
    const scenes = Array.from({ length: 30 }, (_, i) => ({ ...base.scenes[0], id: `scene-${i}`, name: `S${i}` }))
    const result = await executeTool('review', { scope: 'cut' }, { ...base, scenes } as any)
    const data = result.data as any
    expect(data.sceneIds).toHaveLength(12)
    expect(data.sceneIds[0]).toBe('scene-0')
    expect(data.sceneIds.at(-1)).toBe('scene-29')
    // index field is re-based to capture order 0..11
    expect(data.timing.map((t: any) => t.index)).toEqual([...Array(12).keys()])
  })
})

describe('review_scene_motion handler', () => {
  it('returns the clientAction marker + scene context + audio-timing text', async () => {
    const world = makeWorld()
    // Give the scene narration + an SFX cue so audioTimingText is non-empty.
    ;(world.scenes[0] as any).audioLayer = {
      enabled: true,
      tts: { text: 'Hello there', captions: null },
      sfx: [{ id: 'a', name: 'whoosh', triggerAt: 2, volume: 1, duration: null }],
    }
    const result = await executeTool('review', { scope: 'motion', sceneId: 'scene-abc-123' }, world)
    expect(result.success).toBe(true)
    const data = result.data as any
    expect(data.clientAction).toBe('review_scene_motion')
    expect(data.sceneId).toBe('scene-abc-123')
    expect(data.scene).toMatchObject({ name: 'Hero', durationSec: 6, narration: 'Hello there' })
    expect(data.audioTimingText).toContain('whoosh')
    // Non-runner fallback brief is honest, not a fake clean pass.
    expect(data.reviewBrief.reviewable).toBe(false)
  })

  it('errors when sceneId is missing', async () => {
    const result = await executeTool('review', { scope: 'motion' }, makeWorld())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/requires a sceneId/)
  })

  it('errors when the scene does not exist', async () => {
    const result = await executeTool('review', { scope: 'motion', sceneId: 'nope' }, makeWorld())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
  })
})

// ── Regression: captured frame must not leak into the TEXT summary ───────────
//
// summarizeToolResult's >500-char truncation only applies to direct string
// values; `capturedImage` is an OBJECT, so its base64 dataUri rode along
// verbatim inside the stringified JSON text block — double-sending every
// auto-captured frame as garbage tokens next to the real image block.

describe('buildToolResultContent — capturedImage stripping', () => {
  it('replaces capturedImage with a marker in the text summary', () => {
    const bigBase64 = 'A'.repeat(50_000)
    const result = {
      success: true,
      data: {
        clientAction: 'capture_frame',
        sceneId: 'scene-1',
        capturedImage: { dataUri: `data:image/png;base64,${bigBase64}`, mimeType: 'image/png' },
      },
    }
    const content = buildToolResultContent(result as any)

    expect(Array.isArray(content)).toBe(true)
    const blocks = content as Array<any>
    // Image block carries the pixels…
    expect(blocks[1].type).toBe('image')
    expect(blocks[1].source.data).toBe(bigBase64)
    // …and the text block carries only the marker, never the base64.
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('[frame image attached]')
    expect(blocks[0].text).not.toContain(bigBase64.slice(0, 64))
    expect(blocks[0].text.length).toBeLessThan(1000)
  })
})

// ── Regression: visual warnings must reach the model VERBATIM ─────────────────
//
// The generic array-of-objects branch in summarizeToolResult collapsed
// _visualWarnings to '[N items]' + a metadata-only first item — and
// severity/code/message are not METADATA_KEYS, so the model received an
// empty husk. The whole visual feedback loop hinged on text it never saw.

describe('buildToolResultContent — _visualWarnings pass-through', () => {
  it('keeps warning codes and messages in the text summary', () => {
    const result = {
      success: true,
      data: {
        sceneId: 'scene-1',
        _visualWarnings: [
          { severity: 'warning', code: 'VISUAL_BLANK_OR_STATIC', message: 'Scene appears blank.' },
          { severity: 'warning', code: 'VISUAL_LOW_CONTRAST', message: 'Contrast appears insufficient.' },
        ],
      },
    }
    const content = buildToolResultContent(result as any)
    expect(typeof content).toBe('string')
    expect(content).toContain('VISUAL_BLANK_OR_STATIC')
    expect(content).toContain('Scene appears blank.')
    expect(content).toContain('VISUAL_LOW_CONTRAST')
    expect(content).not.toContain('[2 items]')
  })
})

describe('a frame is only rendered when something can read it', () => {
  // A captured frame has exactly two possible consumers: the tool_result image
  // and the vision quality check, which is a SEPARATE engine and is how text-only
  // models see their own frames.
  //
  // Deliberately NOT "skip capture when the model has no vision": DeepSeek relies
  // entirely on the vision-engine routing (visual-quality-check.ts:351). Cutting on
  // model vision alone would delete working coverage on the default path.
  it('every vision-capable provider carries the pixels; only the text-only ones drop them', () => {
    // D6: the frame used to reach Claude and nobody else. OpenAI/Gemini/Qwen/Kimi
    // can all see — they now get the image alongside the tool answer (there is no
    // image slot INSIDE a tool/function response on either API).
    for (const p of ['anthropic', 'claude-code', 'openai', 'google', 'qwen', 'kimi']) {
      expect(messagesCanCarryImages(p), `${p} is vision-capable`).toBe(true)
    }
    // deepseek: the cloud chat models are text/reasoning only. local: an arbitrary
    // Ollama tag, mostly text-only, where a stray image part is a hard 400.
    for (const p of ['deepseek', 'local']) {
      expect(messagesCanCarryImages(p), `${p} is text-only`).toBe(false)
    }
  })

  it('resolves the vision engine ONCE and caches it on the run', async () => {
    // The engine used to be resolved inside runVisualQualityCheck — after the frame
    // had already been rendered — which is what made a no-vision-key setup pay for
    // captures it discarded. Asking early must not add a second probe.
    let probes = 0
    __setVisionEngineResolverForTesting(async () => {
      probes++
      return 'gemini-flash'
    })
    const runProgress = {} as Parameters<typeof hasVisionEngine>[0]
    expect(await hasVisionEngine(runProgress)).toBe(true)
    expect(await hasVisionEngine(runProgress)).toBe(true)
    expect(probes, 'resolver probed more than once for one run').toBe(1)
    __resetVisionEngineResolverForTesting()
  })

  it('reports "no reader" honestly — a skipped check must not read as a passed one', async () => {
    __setVisionEngineResolverForTesting(async () => null)
    const runProgress = {} as Parameters<typeof hasVisionEngine>[0]
    const canShowPixels = messagesCanCarryImages('deepseek')
    const frameHasAReader = canShowPixels || (await hasVisionEngine(runProgress))
    expect(frameHasAReader, 'no pixels and no engine — nothing could read the frame').toBe(false)
    __resetVisionEngineResolverForTesting()
  })

  it('STILL captures for a text-only model when a vision engine exists', async () => {
    // The regression this guards: text-only + vision engine is the DeepSeek path.
    __setVisionEngineResolverForTesting(async () => 'gemini-flash')
    const runProgress = {} as Parameters<typeof hasVisionEngine>[0]
    const frameHasAReader = messagesCanCarryImages('deepseek') || (await hasVisionEngine(runProgress))
    expect(frameHasAReader, 'text-only model with a vision engine must still capture').toBe(true)
    __resetVisionEngineResolverForTesting()
  })
})
