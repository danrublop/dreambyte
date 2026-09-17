// @vitest-environment node

// Single-scene slop rubric (Gap D): parseSceneRubric tolerates wrapped/garbage
// model output and clamps the score; runSceneRubric captures one frame, gates on
// cost, calls the (injected) vision transport, and degrades to reviewable:false on
// any miss — never throwing, never billing a failed call.

import { describe, expect, it, vi } from 'vitest'

import {
  parseSceneRubric,
  runSceneRubric,
  sceneRubricPrompt,
  collectRubricSceneIds,
  shouldRunDirectRubric,
} from './scene-rubric'
import { makeRunCostLedger } from '../run-cost-ledger'
import type { ToolCallRecord } from '../types'

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('parseSceneRubric', () => {
  it('parses a clean rubric object', () => {
    const r = parseSceneRubric('{"score": 7, "issues": [{"severity":"high","detail":"everything centered"}], "summary":"ok"}')
    expect(r.reviewable).toBe(true)
    expect(r.score).toBe(7)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toEqual({ severity: 'high', detail: 'everything centered' })
    expect(r.note).toBe('ok')
  })

  it('extracts JSON wrapped in prose / code fences', () => {
    const r = parseSceneRubric('Here is my review:\n```json\n{"score": 3, "issues": []}\n```\nHope that helps!')
    expect(r.reviewable).toBe(true)
    expect(r.score).toBe(3)
  })

  it('clamps the score to 0-10 and rounds', () => {
    expect(parseSceneRubric('{"score": 14}').score).toBe(10)
    expect(parseSceneRubric('{"score": -2}').score).toBe(0)
    expect(parseSceneRubric('{"score": 6.7}').score).toBe(7)
  })

  it('defaults an unknown severity to medium and drops empty details', () => {
    const r = parseSceneRubric('{"score":5,"issues":[{"severity":"sev1","detail":"x"},{"severity":"low","detail":""}]}')
    expect(r.issues).toEqual([{ severity: 'medium', detail: 'x' }])
  })

  it('caps issues at 4', () => {
    const many = Array.from({ length: 9 }, (_, i) => `{"severity":"low","detail":"d${i}"}`).join(',')
    const r = parseSceneRubric(`{"score":5,"issues":[${many}]}`)
    expect(r.issues).toHaveLength(4)
  })

  it('returns reviewable:false on empty / non-JSON / malformed', () => {
    expect(parseSceneRubric('').reviewable).toBe(false)
    expect(parseSceneRubric('no json here').reviewable).toBe(false)
    expect(parseSceneRubric('{not valid').reviewable).toBe(false)
  })
})

describe('sceneRubricPrompt', () => {
  it('names the scene + renderer and demands JSON only', () => {
    const p = sceneRubricPrompt('Intro', 'react')
    expect(p).toContain('Intro')
    expect(p).toContain('react')
    expect(p).toMatch(/JSON/)
    expect(p).toMatch(/Slop Test/)
  })
})

describe('runSceneRubric', () => {
  const goodCapture = vi.fn(async () => ({ dataUri: PNG_DATA_URI, mimeType: 'image/png' }))

  it('captures, calls the transport, and returns the parsed verdict', async () => {
    const send = vi.fn(async () => '{"score": 8, "issues": [], "summary": "distinctive"}')
    const r = await runSceneRubric('s1', 'Intro', 'react', 6, 'cloud:anthropic', { capture: goodCapture, send })
    expect(r.reviewable).toBe(true)
    expect(r.score).toBe(8)
    expect(send).toHaveBeenCalledOnce()
    // One frame, mid-scene (duration/2 = 3s).
    expect(goodCapture).toHaveBeenCalledWith('s1', 3)
  })

  it('skips honestly when the engine has no frame transport (e.g. gemini)', async () => {
    const send = vi.fn()
    const r = await runSceneRubric('s1', 'Intro', 'react', 6, 'cloud:gemini', { capture: goodCapture, send })
    expect(r.reviewable).toBe(false)
    expect(r.note).toMatch(/can't review a single frame/)
    expect(send).not.toHaveBeenCalled()
  })

  it('returns reviewable:false when the capture fails', async () => {
    const send = vi.fn()
    const r = await runSceneRubric('s1', 'Intro', 'react', 6, 'cloud:anthropic', {
      capture: async () => null,
      send,
    })
    expect(r.reviewable).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('refunds the cost reservation when the transport throws', async () => {
    const ledger = makeRunCostLedger(10)
    const before = ledger.spentUsd
    const send = vi.fn(async () => {
      throw new Error('boom')
    })
    const r = await runSceneRubric('s1', 'Intro', 'react', 6, 'cloud:anthropic', {
      capture: goodCapture,
      send,
      costLedger: ledger,
    })
    expect(r.reviewable).toBe(false)
    expect(ledger.spentUsd).toBe(before) // reserved then refunded → net zero
  })

  it('does not start when already over the cost cap', async () => {
    const ledger = makeRunCostLedger(0.0000001) // effectively no budget
    const send = vi.fn()
    const r = await runSceneRubric('s1', 'Intro', 'react', 6, 'cloud:anthropic', {
      capture: goodCapture,
      send,
      costLedger: ledger,
    })
    expect(r.reviewable).toBe(false)
    expect(r.note).toMatch(/cost cap/)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('collectRubricSceneIds', () => {
  const tc = (toolName: string, sceneId: string | undefined, success: boolean): ToolCallRecord =>
    ({ toolName, input: {}, output: { success, ...(sceneId ? { affectedSceneId: sceneId } : {}) } }) as unknown as ToolCallRecord

  it('collects scenes created OR fully (re)written, order-preserving + deduped', () => {
    const calls = [
      tc('create_scene', 's1', true),
      tc('write_scene_code', 's2', true),
      tc('write_scene_code', 's1', true), // dup of s1 → kept once, first position
      tc('regenerate_layer', 's3', true),
      tc('add_layer', 's2', true), // dup of s2
    ]
    expect(collectRubricSceneIds(calls)).toEqual(['s1', 's2', 's3'])
  })

  it('excludes surgical patch_layer_code edits', () => {
    expect(collectRubricSceneIds([tc('patch_layer_code', 's1', true)])).toEqual([])
  })

  it('excludes vetoed/failed builds (success:false — already caught by the pixel gate)', () => {
    expect(collectRubricSceneIds([tc('write_scene_code', 's1', false)])).toEqual([])
  })

  it('ignores build calls with no affectedSceneId', () => {
    expect(collectRubricSceneIds([tc('write_scene_code', undefined, true)])).toEqual([])
  })
})

describe('shouldRunDirectRubric', () => {
  const base = { isSubAgent: false, aiQualityReview: true, hasScenePlan: false, builtSceneCount: 1 }

  it('runs on a direct build with the setting on and scenes built', () => {
    expect(shouldRunDirectRubric(base)).toBe(true)
  })

  it('skips sub-agents (cut review covers the orchestrated path)', () => {
    expect(shouldRunDirectRubric({ ...base, isSubAgent: true })).toBe(false)
  })

  it('skips when the setting is explicitly off', () => {
    expect(shouldRunDirectRubric({ ...base, aiQualityReview: false })).toBe(false)
  })

  it('runs when the setting is undefined (default ON)', () => {
    expect(shouldRunDirectRubric({ ...base, aiQualityReview: undefined })).toBe(true)
  })

  it('skips the orchestrated (scenePlan) path — it has its own cut review', () => {
    expect(shouldRunDirectRubric({ ...base, hasScenePlan: true })).toBe(false)
  })

  it('skips when nothing was built', () => {
    expect(shouldRunDirectRubric({ ...base, builtSceneCount: 0 })).toBe(false)
  })
})
