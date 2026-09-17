// @vitest-environment node
/**
 * Tests for buildUnderstandingBrief (Phase 2 intake orchestrator).
 *
 * Analyzers + synthesis are injected so no real provider/Ollama calls happen.
 * Covers: per-kind routing, deterministic synthesis (no key), error→degrade,
 * ledger charging + sub-cap, and renderBriefForPrompt.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildUnderstandingBrief,
  deterministicSummary,
  renderBriefForPrompt,
  prependBriefToMessage,
  estimateAnalysisCost,
} from './multimodal-intake'
import { makeRunCostLedger } from '../run-cost-ledger'
import type { CapabilityProbe } from './media-understanding-registry'
import type { MediaAnalysis, ReferenceMedia } from '../types'

const CAPS_LOCAL: CapabilityProbe = {
  ollamaModels: ['qwen2.5vl:7b'],
  hasAnthropicKey: false, // forces deterministic synthesis
  hasOpenAIKey: true,
  hasGoogleKey: true,
  hasCuda: false,
}

function media(kind: ReferenceMedia['kind'], id: string = kind): ReferenceMedia {
  return { id, kind, uri: `file:///tmp/${id}`, mimeType: 'application/octet-stream' }
}

describe('estimateAnalysisCost', () => {
  it('local is free, cloud has a small estimate', () => {
    expect(estimateAnalysisCost('local:qwen2.5vl:7b')).toBe(0)
    expect(estimateAnalysisCost('cloud:gemini')).toBeGreaterThan(0)
    expect(estimateAnalysisCost('cloud:anthropic')).toBeGreaterThan(0)
  })
  it('charges frame-vision by its inner cloud engine (no longer $0)', () => {
    expect(estimateAnalysisCost('frame-vision:cloud:anthropic')).toBeGreaterThan(0)
    expect(estimateAnalysisCost('frame-vision:local:qwen2.5vl:7b')).toBe(0)
  })
  it('charges local:whisper (routes through the API today) but not other local', () => {
    expect(estimateAnalysisCost('local:whisper')).toBeGreaterThan(0)
    expect(estimateAnalysisCost('local:qwen2.5vl')).toBe(0)
    expect(estimateAnalysisCost('marlin')).toBe(0)
  })
})

describe('unsafe URI rejection', () => {
  it('rejects a traversal URI before dispatch (per-media error, run continues)', async () => {
    let called = false
    const brief = await buildUnderstandingBrief(
      [{ id: 'bad', kind: 'image', uri: 'dreambyte://uploads/../../etc/passwd', mimeType: 'image/png' }],
      {
        caps: CAPS_LOCAL,
        analyzers: {
          image: async (m, id) => {
            called = true
            return { mediaId: m.id, kind: 'image', backend: id, caption: 'x' }
          },
        },
      },
    )
    expect(called).toBe(false)
    expect(brief.perMedia[0].error).toMatch(/unsafe media URI/)
  })
})

describe('buildUnderstandingBrief routing', () => {
  it('dispatches each media to its kind analyzer and collects perMedia', async () => {
    const calls: string[] = []
    const mkAnalyzer = (kind: ReferenceMedia['kind']) =>
      vi.fn(async (m: ReferenceMedia, engineId: string): Promise<MediaAnalysis> => {
        calls.push(`${kind}:${engineId}`)
        return { mediaId: m.id, kind, backend: engineId, caption: `${kind} caption` }
      })

    const brief = await buildUnderstandingBrief([media('image'), media('audio'), media('doc')], {
      caps: CAPS_LOCAL,
      analyzers: { image: mkAnalyzer('image'), audio: mkAnalyzer('audio'), doc: mkAnalyzer('doc') },
    })

    expect(brief.perMedia).toHaveLength(3)
    // image auto → local model; audio auto → local:whisper; doc → local:pdfjs
    expect(calls).toContain('image:local:qwen2.5vl:7b')
    expect(calls).toContain('audio:local:whisper')
    expect(calls).toContain('doc:local:pdfjs')
  })

  it('reports "no engine" when nothing is available for a modality', async () => {
    const NO_CAPS: CapabilityProbe = {
      ollamaModels: [],
      hasAnthropicKey: false,
      hasOpenAIKey: false,
      hasGoogleKey: false,
      hasCuda: false,
    }
    const brief = await buildUnderstandingBrief([media('image')], { caps: NO_CAPS })
    expect(brief.perMedia[0].error).toMatch(/no engine available/)
  })
})

describe('media-analysis cache (Phase 2.5)', () => {
  // Minimal in-memory cache implementing the injectable interface.
  function fakeCache() {
    const store = new Map<string, MediaAnalysis>()
    const k = (h: string, e: string, v: string) => `${h}|${e}|${v}`
    return {
      store,
      get: vi.fn(async (h: string, e: string, v: string) => store.get(k(h, e, v)) ?? null),
      put: vi.fn(async (h: string, e: string, v: string, a: MediaAnalysis) => void store.set(k(h, e, v), a)),
    }
  }
  const withHash = (kind: ReferenceMedia['kind'], hash: string): ReferenceMedia => ({
    id: `${kind}-1`,
    kind,
    uri: `file:///tmp/${kind}`,
    mimeType: 'application/octet-stream',
    contentHash: hash,
  })

  it('miss → analyzes and writes to cache', async () => {
    const cache = fakeCache()
    let calls = 0
    await buildUnderstandingBrief([withHash('image', 'h1')], {
      caps: CAPS_LOCAL,
      cache,
      analyzers: {
        image: async (m, id) => {
          calls++
          return { mediaId: m.id, kind: 'image', backend: id, caption: 'a cat' }
        },
      },
    })
    expect(calls).toBe(1)
    expect(cache.put).toHaveBeenCalledOnce()
    expect(cache.store.size).toBe(1)
  })

  it('hit → reuses cached analysis, analyzer never runs (the perf win)', async () => {
    const cache = fakeCache()
    cache.store.set('h1|local:qwen2.5vl:7b|1', {
      mediaId: 'x',
      kind: 'image',
      backend: 'local:qwen2.5vl:7b',
      caption: 'cached cat',
    })
    let calls = 0
    const brief = await buildUnderstandingBrief([withHash('image', 'h1')], {
      caps: CAPS_LOCAL,
      cache,
      analyzers: { image: async (m, id) => (calls++, { mediaId: m.id, kind: 'image', backend: id, caption: 'fresh' }) },
    })
    expect(calls).toBe(0)
    expect(brief.perMedia[0].caption).toBe('cached cat')
    expect(brief.perMedia[0].mediaId).toBe('image-1') // re-stamped to the current media id
  })

  it('altered file (different contentHash) → miss → re-analyzes', async () => {
    const cache = fakeCache()
    cache.store.set('OLD|local:qwen2.5vl:7b|1', {
      mediaId: 'x',
      kind: 'image',
      backend: 'local:qwen2.5vl:7b',
      caption: 'old',
    })
    let calls = 0
    const brief = await buildUnderstandingBrief([withHash('image', 'NEW')], {
      caps: CAPS_LOCAL,
      cache,
      analyzers: { image: async (m, id) => (calls++, { mediaId: m.id, kind: 'image', backend: id, caption: 'new' }) },
    })
    expect(calls).toBe(1)
    expect(brief.perMedia[0].caption).toBe('new')
  })

  it('rejects a kind-mismatched cached row (poison defense) → re-analyzes', async () => {
    const cache = fakeCache()
    // A row for the same hash+engine but the WRONG kind must not be served.
    cache.store.set('h1|local:qwen2.5vl:7b|1', {
      mediaId: 'x',
      kind: 'video',
      backend: 'local:qwen2.5vl:7b',
      caption: 'wrong-kind',
    })
    let calls = 0
    const brief = await buildUnderstandingBrief([withHash('image', 'h1')], {
      caps: CAPS_LOCAL,
      cache,
      analyzers: {
        image: async (m, id) => (calls++, { mediaId: m.id, kind: 'image', backend: id, caption: 'fresh image' }),
      },
    })
    expect(calls).toBe(1)
    expect(brief.perMedia[0].caption).toBe('fresh image')
  })

  it('NEVER caches a failed/empty analysis (the invariant)', async () => {
    const cache = fakeCache()
    await buildUnderstandingBrief([withHash('image', 'h1')], {
      caps: CAPS_LOCAL,
      cache,
      analyzers: { image: async (m, id) => ({ mediaId: m.id, kind: 'image', backend: id, error: 'boom' }) },
    })
    expect(cache.put).not.toHaveBeenCalled()
    expect(cache.store.size).toBe(0)
  })

  it('skips cache entirely when media has no contentHash', async () => {
    const cache = fakeCache()
    await buildUnderstandingBrief([media('image')], {
      caps: CAPS_LOCAL,
      cache,
      analyzers: { image: async (m, id) => ({ mediaId: m.id, kind: 'image', backend: id, caption: 'x' }) },
    })
    expect(cache.get).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
  })
})

describe('synthesis + structured merge', () => {
  it('deterministic synthesis with no Anthropic key, aggregating palette/subjects/timeline', async () => {
    const analyzers = {
      image: vi.fn(
        async (m: ReferenceMedia, id: string): Promise<MediaAnalysis> => ({
          mediaId: m.id,
          kind: 'image',
          backend: id,
          caption: 'a neon city at night',
          palette: ['#ff00aa', '#00ffff'],
          subjects: ['city', 'neon'],
          mood: 'energetic',
        }),
      ),
      audio: vi.fn(
        async (m: ReferenceMedia, id: string): Promise<MediaAnalysis> => ({
          mediaId: m.id,
          kind: 'audio',
          backend: id,
          transcript: 'Welcome to the future.',
          events: [{ start: 0, end: 2, description: 'Welcome to the future.' }],
        }),
      ),
    }
    const brief = await buildUnderstandingBrief([media('image'), media('audio')], { caps: CAPS_LOCAL, analyzers })

    expect(brief.summary).toMatch(/image/i)
    expect(brief.visualStyle?.palette).toEqual(['#ff00aa', '#00ffff'])
    expect(brief.visualStyle?.mood).toBe('energetic')
    expect(brief.subjects).toEqual(['city', 'neon'])
    expect(brief.timeline?.[0]).toEqual({ t: 0, description: 'Welcome to the future.' })
    expect(brief.modelsUsed.length).toBeGreaterThan(0)
  })

  it('uses an injected synthesize override', async () => {
    const brief = await buildUnderstandingBrief([media('image')], {
      caps: CAPS_LOCAL,
      analyzers: { image: async (m, id) => ({ mediaId: m.id, kind: 'image', backend: id, caption: 'x' }) },
      synthesize: async () => ({ summary: 'CUSTOM SUMMARY', costUsd: 0.01 }),
    })
    expect(brief.summary).toBe('CUSTOM SUMMARY')
    expect(brief.costUsd).toBeCloseTo(0.01, 5)
  })
})

describe('cost ledger + sub-cap', () => {
  it('charges per-analysis cost to the ledger', async () => {
    const ledger = makeRunCostLedger(25)
    await buildUnderstandingBrief([media('image'), media('image', 'img2')], {
      caps: { ...CAPS_LOCAL, ollamaModels: [], hasGoogleKey: true }, // forces cloud:gemini ($0.003 each)
      ledger,
      analyzers: {
        image: async (m, id) => ({ mediaId: m.id, kind: 'image', backend: id, caption: 'c' }),
      },
    })
    expect(ledger.spentUsd).toBeCloseTo(0.006, 4)
  })

  it('skips all media when the run ledger is already over cap', async () => {
    const ledger = makeRunCostLedger(0.01)
    ledger.spentUsd = 0.02 // already over the run cap before intake even starts
    let analyzed = 0
    const brief = await buildUnderstandingBrief(
      Array.from({ length: 5 }, (_, i) => media('image', `i${i}`)),
      {
        caps: { ...CAPS_LOCAL, ollamaModels: [], hasGoogleKey: true },
        ledger,
        analyzers: {
          image: async (m, id) => {
            analyzed++
            return { mediaId: m.id, kind: 'image', backend: id, caption: 'c' }
          },
        },
      },
    )
    expect(analyzed).toBe(0)
    expect(brief.perMedia).toHaveLength(0)
    // Still returns a (degraded) brief so the run proceeds.
    expect(typeof brief.summary).toBe('string')
  })

  it('analyzes the whole set when under budget', async () => {
    let analyzed = 0
    const brief = await buildUnderstandingBrief(
      Array.from({ length: 4 }, (_, i) => media('image', `i${i}`)),
      {
        caps: CAPS_LOCAL,
        analyzers: {
          image: async (m, id) => {
            analyzed++
            return { mediaId: m.id, kind: 'image', backend: id, caption: 'c' }
          },
        },
      },
    )
    expect(analyzed).toBe(4)
    expect(brief.perMedia).toHaveLength(4)
  })

  it('times out a hung analyzer instead of stalling the run', async () => {
    vi.useFakeTimers()
    const brief$ = buildUnderstandingBrief([media('image')], {
      caps: CAPS_LOCAL,
      analyzers: {
        image: () => new Promise(() => {}), // never resolves
      },
    })
    await vi.advanceTimersByTimeAsync(46_000)
    const brief = await brief$
    expect(brief.perMedia[0].error).toMatch(/timed out/)
    vi.useRealTimers()
  })

  it('error analyses never throw and still produce a brief', async () => {
    const brief = await buildUnderstandingBrief([media('image')], {
      caps: CAPS_LOCAL,
      analyzers: {
        image: async (m, id) => ({ mediaId: m.id, kind: 'image', backend: id, error: 'engine exploded' }),
      },
    })
    expect(brief.perMedia[0].error).toBe('engine exploded')
    expect(typeof brief.summary).toBe('string')
  })
})

describe('deterministicSummary', () => {
  it('summarizes mixed media', () => {
    const s = deterministicSummary([
      { mediaId: 'a', kind: 'image', backend: 'local:x', caption: 'a logo' },
      { mediaId: 'b', kind: 'audio', backend: 'local:whisper', transcript: 'hello world' },
    ])
    expect(s).toMatch(/image/i)
    expect(s).toMatch(/audio/i)
  })
  it('flags when everything failed', () => {
    const s = deterministicSummary([{ mediaId: 'a', kind: 'image', backend: 'none', error: 'x' }])
    expect(s).toMatch(/could not be analyzed/i)
  })
})

describe('prependBriefToMessage', () => {
  it('prepends to a string message', () => {
    const out = prependBriefToMessage('build me a video', 'BRIEF')
    expect(out).toBe('BRIEF\n\n---\n\nbuild me a video')
  })
  it('prepends a text block preserving inline images', () => {
    const blocks = [{ type: 'image', image: { dataUri: 'data:...' } }]
    const out = prependBriefToMessage(blocks, 'BRIEF') as { type: string }[]
    expect(out[0].type).toBe('text')
    expect(out).toHaveLength(2)
    expect(out[1].type).toBe('image')
  })
})

describe('renderBriefForPrompt', () => {
  it('renders summary + structured sections as a prompt block', () => {
    const text = renderBriefForPrompt({
      summary: 'A neon explainer.',
      visualStyle: { palette: ['#ff00aa'], mood: 'energetic' },
      subjects: ['city'],
      narrative: { keyPoints: ['Point one.'], transcriptExcerpt: 'hello' },
      timeline: [{ t: 1.5, description: 'intro' }],
      perMedia: [],
      costUsd: 0,
      modelsUsed: ['local:qwen2.5vl:7b'],
    })
    expect(text).toMatch(/Reference media/)
    expect(text).toMatch(/A neon explainer\./)
    expect(text).toMatch(/#ff00aa/)
    expect(text).toMatch(/Point one\./)
    expect(text).toMatch(/1\.5s: intro/)
    expect(text).toMatch(/local:qwen2\.5vl:7b/)
  })
})
