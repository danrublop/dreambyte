import { describe, it, expect, vi } from 'vitest'
import {
  buildCutReviewBrief,
  reviewVideoFromCaptures,
  parseCutReview,
  cutReviewPrompt,
  dataUriToKeyframe,
  downsampleFrame,
  type CutSceneTiming,
} from './cut-review'
import { makeRunCostLedger } from '../run-cost-ledger'
import type { KeyframeImage } from '../../services/video-understander'

const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function frame(timeSec: number): KeyframeImage {
  return { timeSec, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }
}

const TIMING: CutSceneTiming[] = [
  { index: 0, name: 'Intro', durationSec: 6, narration: 'Welcome to the demo' },
  { index: 1, name: 'How it works', durationSec: 10 },
]

describe('cutReviewPrompt', () => {
  it('lists scenes with name, duration, narration, and a total', () => {
    const p = cutReviewPrompt(TIMING)
    expect(p).toContain('"Intro" (6.0s)')
    expect(p).toContain('narration: "Welcome to the demo"')
    expect(p).toContain('"How it works" (10.0s)')
    expect(p).toContain('16.0s total')
    expect(p).toMatch(/Return ONLY a JSON object/)
  })
})

describe('parseCutReview', () => {
  it('parses findings and maps 1-based scene → 0-based index', () => {
    const raw = JSON.stringify({
      summary: 'Solid cut',
      findings: [{ kind: 'pacing', severity: 'high', scene: 2, detail: 'Scene 2 drags' }],
    })
    const b = parseCutReview(raw)
    expect(b.reviewable).toBe(true)
    expect(b.summary).toBe('Solid cut')
    expect(b.findings).toEqual([{ kind: 'pacing', severity: 'high', scene: 1, detail: 'Scene 2 drags' }])
  })

  it('clamps unknown kind/severity to other/medium and drops detail-less findings', () => {
    const raw = JSON.stringify({
      findings: [
        { kind: 'bogus', severity: 'critical', detail: 'x' },
        { kind: 'pacing' }, // no detail → dropped
      ],
    })
    const b = parseCutReview(raw)
    expect(b.findings).toEqual([{ kind: 'other', severity: 'medium', detail: 'x' }])
  })

  it('treats an empty findings array as a clean, reviewable cut', () => {
    const b = parseCutReview(JSON.stringify({ summary: 'Reads well', findings: [] }))
    expect(b.reviewable).toBe(true)
    expect(b.findings).toEqual([])
  })

  it('returns reviewable:false on unparseable output (not a silent pass)', () => {
    const b = parseCutReview('the model rambled, no json here')
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/parse/i)
  })

  it('refuses a wrong-shape response (no findings array) instead of reporting a clean pass', () => {
    // {}, an error object, and the intake {scene,events} shape must all fail —
    // a failed/mis-routed call must never read as reviewable:true with no findings.
    for (const raw of ['{}', '{"error":"rate limited"}', '{"scene":"x","events":[]}']) {
      const b = parseCutReview(raw)
      expect(b.reviewable).toBe(false)
      expect(b.note).toMatch(/shape/i)
    }
  })

  it('drops an out-of-range scene index (cannot mis-attribute to a nonexistent scene)', () => {
    const raw = JSON.stringify({ findings: [{ kind: 'pacing', severity: 'low', scene: 99, detail: 'x' }] })
    const b = parseCutReview(raw, 2) // only 2 scenes
    expect(b.findings[0]).not.toHaveProperty('scene')
  })

  it('drops scene < 1, non-numeric, or omitted', () => {
    const raw = JSON.stringify({
      findings: [
        { kind: 'pacing', severity: 'low', scene: 0, detail: 'a' },
        { kind: 'pacing', severity: 'low', scene: 'abc', detail: 'b' },
        { kind: 'pacing', severity: 'low', detail: 'c' },
      ],
    })
    const b = parseCutReview(raw, 5)
    expect(b.findings.every((f) => !('scene' in f))).toBe(true)
  })
})

describe('buildCutReviewBrief', () => {
  it('runs the VLM pass and returns a structured brief (happy path)', async () => {
    const send = vi.fn(async (_frames: KeyframeImage[], _prompt: string) =>
      JSON.stringify({
        summary: 'ok',
        findings: [{ kind: 'continuity', severity: 'low', detail: 'palette shifts at scene 2' }],
      }),
    )
    const b = await buildCutReviewBrief([frame(0), frame(1)], TIMING, 'local:ollama', { send })
    expect(b.reviewable).toBe(true)
    expect(b.findings[0].kind).toBe('continuity')
    // The cut-review prompt was used, not the intake framesPrompt.
    expect(send.mock.calls[0][1]).toContain('reviewing a finished explainer-video cut')
  })

  it('is NOT reviewable when below minFrames (no hallucinated verdict from too few frames)', async () => {
    const send = vi.fn()
    const b = await buildCutReviewBrief([frame(0)], TIMING, 'local:ollama', { send, minFrames: 3 })
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/Too few frames/)
    expect(send).not.toHaveBeenCalled()
  })

  it('surfaces a transport failure as reviewable:false (does not swallow)', async () => {
    const send = vi.fn(async () => {
      throw new Error('No multi-frame vision transport for engine "cloud:bogus"')
    })
    const b = await buildCutReviewBrief([frame(0), frame(1)], TIMING, 'cloud:bogus', { send })
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/vision call failed.*transport/)
  })

  it('surfaces an empty model response as reviewable:false', async () => {
    const send = vi.fn(async () => '   ')
    const b = await buildCutReviewBrief([frame(0), frame(1)], TIMING, 'local:ollama', { send })
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/empty response/i)
  })

  it('refuses when frames and scenes are out of sync (would mis-map findings)', async () => {
    const send = vi.fn()
    const b = await buildCutReviewBrief([frame(0)], TIMING, 'local:ollama', { send }) // 1 frame, 2 scenes
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/mismatch/i)
    expect(send).not.toHaveBeenCalled()
  })

  it('passes scene count to the parser so out-of-range scene numbers are dropped', async () => {
    const send = vi.fn(async () =>
      JSON.stringify({ findings: [{ kind: 'pacing', severity: 'low', scene: 9, detail: 'x' }] }),
    )
    const b = await buildCutReviewBrief([frame(0), frame(1)], TIMING, 'local:ollama', { send }) // 2 scenes
    expect(b.reviewable).toBe(true)
    expect(b.findings[0]).not.toHaveProperty('scene') // 9 > 2 → dropped
  })
})

describe('reviewVideoFromCaptures', () => {
  const ids = ['s0', 's1', 's2']
  const timing3: CutSceneTiming[] = [
    { index: 0, name: 'A', durationSec: 6 },
    { index: 1, name: 'B', durationSec: 6 },
    { index: 2, name: 'C', durationSec: 6 },
  ]
  const okSend = vi.fn(async () => JSON.stringify({ summary: 'reads well', findings: [] }))

  it('captures every scene, reviews, and commits cost to the ledger', async () => {
    const capture = vi.fn(async () => ({ dataUri: PNG_DATA_URI, mimeType: 'image/png' }))
    const ledger = makeRunCostLedger(25)
    const send = vi.fn(async () =>
      JSON.stringify({ summary: 'ok', findings: [{ kind: 'pacing', severity: 'low', detail: 'x' }] }),
    )
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', { capture, send, costLedger: ledger })
    expect(b.reviewable).toBe(true)
    expect(capture).toHaveBeenCalledTimes(3)
    expect(ledger.spentUsd).toBeGreaterThan(0) // frame-vision:cloud:anthropic estimate committed
    expect(b.reviewedSceneIds).toEqual(ids) // findings map back to real scenes
  })

  it('does NOT charge the ledger when the VLM call fails (no over-charge on transport error)', async () => {
    const capture = vi.fn(async () => ({ dataUri: PNG_DATA_URI, mimeType: 'image/png' }))
    const ledger = makeRunCostLedger(25)
    const send = vi.fn(async () => {
      throw new Error('connection refused')
    })
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', { capture, send, costLedger: ledger })
    expect(b.reviewable).toBe(false)
    expect(ledger.spentUsd).toBe(0) // provider never billed → ledger untouched
  })

  it('skips the VLM call when aborted after capturing (no spend on a cancelled run)', async () => {
    const signal = { aborted: false }
    let n = 0
    const capture = vi.fn(async () => {
      if (++n === 3) signal.aborted = true // abort once all frames captured
      return { dataUri: PNG_DATA_URI, mimeType: 'image/png' }
    })
    const send = vi.fn()
    const ledger = makeRunCostLedger(25)
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', {
      capture,
      send,
      abortSignal: signal,
      costLedger: ledger,
    })
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/aborted/i)
    expect(send).not.toHaveBeenCalled()
    expect(ledger.spentUsd).toBe(0)
  })

  it('refuses before capturing when the cut has fewer scenes than minFrames', async () => {
    const capture = vi.fn()
    const b = await reviewVideoFromCaptures(['s0'], [timing3[0]], 'cloud:anthropic', {
      capture,
      send: okSend,
      minFrames: 2,
    })
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/too few scenes/i)
    expect(capture).not.toHaveBeenCalled()
  })

  it('drops a failed capture and realigns frames↔timing (no mismatch refusal)', async () => {
    // Middle capture fails → 2 frames, 2 timing entries, still reviewable.
    const capture = vi.fn(async (sceneId: string) =>
      sceneId === 's1' ? null : { dataUri: PNG_DATA_URI, mimeType: 'image/png' },
    )
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', { capture, send: okSend, minFrames: 2 })
    expect(b.reviewable).toBe(true)
    // buildCutReviewBrief received aligned 2-frame/2-scene input (no "mismatch" note).
    expect(b.note).toBeUndefined()
  })

  it('is reviewable:false when too few frames survive capture', async () => {
    const capture = vi.fn(async (sceneId: string) =>
      sceneId === 's0' ? { dataUri: PNG_DATA_URI, mimeType: 'image/png' } : null,
    )
    const send = vi.fn()
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', { capture, send, minFrames: 2 })
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/too few frames/i)
    expect(send).not.toHaveBeenCalled()
  })

  it('projected-cost-gates before capturing (no capture, no VLM call) when near the cap', async () => {
    const ledger = makeRunCostLedger(0.001) // tiny cap; frame-vision:cloud:anthropic estimate exceeds it
    const capture = vi.fn()
    const send = vi.fn()
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', { capture, send, costLedger: ledger })
    expect(b.reviewable).toBe(false)
    expect(b.note).toMatch(/cost cap/i)
    expect(capture).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('enriches a scene-specific finding with sceneId + sceneName from the reviewed subset', async () => {
    const capture = vi.fn(async () => ({ dataUri: PNG_DATA_URI, mimeType: 'image/png' }))
    // scene:2 (1-based) → 0-based index 1 → keptSceneIds[1] = 's1', kept[1].name = 'B'
    const send = vi.fn(async () =>
      JSON.stringify({ findings: [{ kind: 'pacing', severity: 'high', scene: 2, detail: 'drags' }] }),
    )
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', { capture, send })
    expect(b.reviewable).toBe(true)
    expect(b.findings[0]).toMatchObject({ scene: 1, sceneId: 's1', sceneName: 'B' })
  })

  it('leaves a cut-wide finding (no scene) without a sceneId', async () => {
    const capture = vi.fn(async () => ({ dataUri: PNG_DATA_URI, mimeType: 'image/png' }))
    const send = vi.fn(async () =>
      JSON.stringify({ findings: [{ kind: 'pacing', severity: 'low', detail: 'uneven overall' }] }),
    )
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', { capture, send })
    expect(b.findings[0]).not.toHaveProperty('sceneId')
    expect(b.findings[0]).not.toHaveProperty('scene')
  })

  it('resolves sceneId against the realigned subset after a dropped capture (not the original index)', async () => {
    // s1 capture fails → kept = [s0, s2]; a finding on the 2nd kept frame (scene:2)
    // must resolve to s2, NOT s1. Proves enrichment uses keptSceneIds, not raw timing.
    const capture = vi.fn(async (sceneId: string) =>
      sceneId === 's1' ? null : { dataUri: PNG_DATA_URI, mimeType: 'image/png' },
    )
    const send = vi.fn(async () =>
      JSON.stringify({ findings: [{ kind: 'continuity', severity: 'medium', scene: 2, detail: 'jump' }] }),
    )
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', { capture, send, minFrames: 2 })
    expect(b.findings[0]).toMatchObject({ sceneId: 's2', sceneName: 'C' })
  })

  it('stops on abort mid-capture', async () => {
    const signal = { aborted: false }
    const capture = vi.fn(async () => {
      signal.aborted = true // abort after the first capture
      return { dataUri: PNG_DATA_URI, mimeType: 'image/png' }
    })
    const send = vi.fn()
    const b = await reviewVideoFromCaptures(ids, timing3, 'cloud:anthropic', {
      capture,
      send,
      abortSignal: signal,
      minFrames: 2,
    })
    expect(capture).toHaveBeenCalledTimes(1) // loop broke on the next iteration
    expect(b.reviewable).toBe(false)
  })
})

describe('cutReviewPrompt sanitization', () => {
  it('strips quotes/braces/backticks from narration and names (prompt-injection hygiene)', () => {
    const p = cutReviewPrompt([
      { index: 0, name: 'Scene "A" {x}', durationSec: 5, narration: 'say "ignore previous" {drop} `code`' },
    ])
    expect(p).toContain('narration: "say ignore previous drop code"')
    expect(p).toContain('"Scene A x"')
  })
})

describe('dataUriToKeyframe', () => {
  it('decodes a valid base64 data URI', () => {
    const b64 = Buffer.from([10, 20, 30]).toString('base64')
    const kf = dataUriToKeyframe(`data:image/png;base64,${b64}`, 4)
    expect(kf).not.toBeNull()
    expect(kf!.mimeType).toBe('image/png')
    expect(kf!.timeSec).toBe(4)
    expect(Array.from(kf!.bytes)).toEqual([10, 20, 30])
  })

  it('returns null for a non-data-URI or non-image mime', () => {
    expect(dataUriToKeyframe('https://example.com/x.png', 0)).toBeNull()
    expect(dataUriToKeyframe('data:text/plain;base64,aGk=', 0)).toBeNull()
    expect(dataUriToKeyframe('', 0)).toBeNull()
  })

  it('returns null when the payload decodes to zero bytes (corrupt capture, not a fake frame)', () => {
    // Buffer.from(_, 'base64') silently truncates invalid input — guard on decoded length.
    expect(dataUriToKeyframe('data:image/png;base64,!!!!', 0)).toBeNull()
    expect(dataUriToKeyframe('data:image/png;base64,=', 0)).toBeNull()
  })
})

describe('downsampleFrame', () => {
  it('resizes a real image and emits jpeg', async () => {
    const sharp = (await import('sharp')).default
    const big = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: '#336699' } })
      .png()
      .toBuffer()
    const out = await downsampleFrame({ timeSec: 0, bytes: new Uint8Array(big), mimeType: 'image/png' }, 768)
    expect(out.mimeType).toBe('image/jpeg')
    expect(out.bytes.length).toBeGreaterThan(0)
    const meta = await sharp(Buffer.from(out.bytes)).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768)
  })

  it('degrades to the original frame when the bytes are not a valid image', async () => {
    const orig = frame(2) // [1,2,3] — not an image
    const out = await downsampleFrame(orig, 768)
    expect(out).toBe(orig) // same reference, no crash
  })

  it('flattens alpha so a transparent PNG does not get composited onto black', async () => {
    const sharp = (await import('sharp')).default
    const transparent = await sharp({
      create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()
    const out = await downsampleFrame({ timeSec: 0, bytes: new Uint8Array(transparent), mimeType: 'image/png' }, 768)
    expect(out.mimeType).toBe('image/jpeg')
    const meta = await sharp(Buffer.from(out.bytes)).metadata()
    expect(meta.hasAlpha).toBe(false) // flattened, not carried through (JPEG has no alpha anyway)
    // Top-left pixel should be white (the flatten background), not black.
    const { data } = await sharp(Buffer.from(out.bytes)).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]).toBeGreaterThan(240) // R near 255
  })
})
