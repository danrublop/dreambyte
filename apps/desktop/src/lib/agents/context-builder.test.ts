import { describe, expect, it } from 'vitest'

// Import the real exported constant so the test catches drift in the source
// (it is also the threshold the patch_layer_code pre-tool guard keys off of).
import { CODE_PREVIEW_SCENE_LIMIT_LARGE } from './context-builder'

// Small-preview limit is module-private; mirror its current value here.
const CODE_PREVIEW_SCENE_LIMIT = 2000
const LARGE_PREVIEW_TYPES = ['three', 'react', 'canvas2d']
const SMALL_PREVIEW_TYPES = ['motion', 'svg', 'lottie', 'zdog']

describe('context-builder code preview limits', () => {
  it('three/react/canvas2d get the 6k large limit', () => {
    for (const type of LARGE_PREVIEW_TYPES) {
      const limit = LARGE_PREVIEW_TYPES.includes(type) ? CODE_PREVIEW_SCENE_LIMIT_LARGE : CODE_PREVIEW_SCENE_LIMIT
      expect(limit).toBe(6000)
    }
  })

  it('motion/svg/lottie/zdog get the 2k small limit', () => {
    for (const type of SMALL_PREVIEW_TYPES) {
      const limit = LARGE_PREVIEW_TYPES.includes(type) ? CODE_PREVIEW_SCENE_LIMIT_LARGE : CODE_PREVIEW_SCENE_LIMIT
      expect(limit).toBe(2000)
    }
  })

  it('large limit is bounded to keep the uncached per-turn scene tax small', () => {
    // 6K chars (~1.5K tokens) gives the agent enough to orient while bounding
    // the fixed per-turn cost; inspect(kind:'code') covers the full source on demand.
    expect(CODE_PREVIEW_SCENE_LIMIT_LARGE).toBe(6000)
    expect(CODE_PREVIEW_SCENE_LIMIT_LARGE).toBeGreaterThan(CODE_PREVIEW_SCENE_LIMIT)
  })
})

describe('SCENE_TYPE_GUIDANCE_THREE content', () => {
  it('contains buildSceneSequencer and makeStudioSet for AE composition workflow', async () => {
    const { SCENE_TYPE_GUIDANCE_THREE } = await import('./prompts')
    expect(SCENE_TYPE_GUIDANCE_THREE).toContain('buildSceneSequencer')
    expect(SCENE_TYPE_GUIDANCE_THREE).toContain('makeStudioSet')
  })

  it('contains the inspect(kind:code) rule before editing', async () => {
    const { SCENE_TYPE_GUIDANCE_THREE } = await import('./prompts')
    expect(SCENE_TYPE_GUIDANCE_THREE).toContain("inspect(kind:'code')")
    expect(SCENE_TYPE_GUIDANCE_THREE).toContain('RULE 1')
  })

  it('contains window.__objects registry convention', async () => {
    const { SCENE_TYPE_GUIDANCE_THREE } = await import('./prompts')
    expect(SCENE_TYPE_GUIDANCE_THREE).toContain('window.__objects')
  })

  it('contains camera preset names for composition-first workflow', async () => {
    const { SCENE_TYPE_GUIDANCE_THREE } = await import('./prompts')
    expect(SCENE_TYPE_GUIDANCE_THREE).toContain('productReveal')
    expect(SCENE_TYPE_GUIDANCE_THREE).toContain('cinematicSweep')
  })
})

// B2: real-token-driven compaction. compactInFlightMessages gained a `force`
// flag (bypass the chars/4 estimate when provider usage says we're over budget)
// and a `summarize` callback (model-written summary with heuristic fallback).
describe('compactInFlightMessages — force + summarize (B2)', () => {
  // A history long enough to clear the preserveRecent+2 floor, but whose chars/4
  // estimate is tiny so the normal gate would skip compaction.
  const makeHistory = () =>
    Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`, // ~1 token each — far under any maxTokens threshold
    }))

  it('does NOT compact tiny histories without force (estimate gate holds)', async () => {
    const { compactInFlightMessages } = await import('./context-builder')
    const msgs = makeHistory()
    const out = await compactInFlightMessages(msgs, { maxTokens: 6000, preserveRecent: 8 })
    expect(out.length).toBe(msgs.length) // unchanged — estimate is under budget
  })

  it('force=true compacts even when the chars/4 estimate is under budget', async () => {
    const { compactInFlightMessages } = await import('./context-builder')
    const msgs = makeHistory()
    const out = await compactInFlightMessages(msgs, { maxTokens: 6000, preserveRecent: 8, force: true })
    // summary message + the 8 preserved recents = 9, fewer than the original 14.
    expect(out.length).toBeLessThan(msgs.length)
    expect(out.length).toBe(9)
  })

  it('respects the small-history floor even under force', async () => {
    const { compactInFlightMessages } = await import('./context-builder')
    const tiny = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    const out = await compactInFlightMessages(tiny, { preserveRecent: 8, force: true })
    expect(out).toBe(tiny) // nothing to summarize past the preserve window
  })

  it('uses the model summary when summarize returns text', async () => {
    const { compactInFlightMessages } = await import('./context-builder')
    const out = await compactInFlightMessages(makeHistory(), {
      force: true,
      preserveRecent: 8,
      summarize: async () => 'MODEL SUMMARY: built scene s1',
    })
    const summaryBlock = out[0].content[0].text as string
    expect(summaryBlock).toContain('MODEL SUMMARY: built scene s1')
  })

  it('falls back to the heuristic when summarize returns null', async () => {
    const { compactInFlightMessages } = await import('./context-builder')
    const out = await compactInFlightMessages(makeHistory(), {
      force: true,
      preserveRecent: 8,
      summarize: async () => null,
    })
    const summaryBlock = out[0].content[0].text as string
    // Heuristic summary always carries the CONTINUATION marker; never empty.
    expect(summaryBlock).toContain('CONTINUATION')
    expect(summaryBlock.length).toBeGreaterThan(0)
  })

  it('falls back to the heuristic when summarize throws (never blocks the run)', async () => {
    const { compactInFlightMessages } = await import('./context-builder')
    const out = await compactInFlightMessages(makeHistory(), {
      force: true,
      preserveRecent: 8,
      summarize: async () => {
        throw new Error('summary API down')
      },
    })
    expect(out.length).toBe(9) // compaction still happened
    expect(out[0].content[0].text).toContain('CONTINUATION')
  })

  // The continuation block MUST be typed — Anthropic / the canonical-message
  // mapping rejects an untyped `{ text }` block, which would fail the run when
  // the proactive guard compacts before the first provider call.
  it('emits the continuation block with an explicit type: "text"', async () => {
    const { compactInFlightMessages } = await import('./context-builder')
    const out = await compactInFlightMessages(makeHistory(), { force: true, preserveRecent: 8 })
    expect(out[0].content[0]).toMatchObject({ type: 'text' })
    expect(typeof out[0].content[0].text).toBe('string')
  })
})

// estimatePromptTokens — the tool-aware estimate that drives the proactive guard.
describe('estimatePromptTokens (proactive guard estimate)', () => {
  it('counts tool_use / tool_result JSON that estimateContentTokens ignores', async () => {
    const { estimatePromptTokens } = await import('./context-builder')
    // A turn dominated by tool_result JSON — no text/image blocks at all.
    const bigJson = 'x'.repeat(8000)
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'gen', input: { prompt: bigJson } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigJson }] },
    ]
    // Both blocks are non-text/non-image, so a text-only estimator would score ~0.
    // estimatePromptTokens serializes them → thousands of tokens.
    expect(estimatePromptTokens(messages)).toBeGreaterThan(3000)
  })

  it('scores a capture-frame image nested in a tool_result as an image, not base64 text', async () => {
    const { estimatePromptTokens } = await import('./context-builder')
    // What buildToolResultContent emits after a capture_frame: text summary +
    // a base64 PNG. A real frame is ~250KB of base64 → chars/4 would score it
    // at ~62k tokens instead of the ~1.6k an image actually costs.
    const b64 = 'A'.repeat(250_000)
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: '{"success":true}' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
            ],
          },
        ],
      },
    ]
    expect(estimatePromptTokens(messages)).toBeLessThan(2000)
  })

  it('counts string content and the system prompt chars', async () => {
    const { estimatePromptTokens } = await import('./context-builder')
    const base = estimatePromptTokens([{ role: 'user', content: 'a'.repeat(400) }])
    expect(base).toBe(100) // 400 chars / 4
    const withSys = estimatePromptTokens([{ role: 'user', content: 'a'.repeat(400) }], 400)
    expect(withSys).toBe(200) // + 400 system chars / 4
  })
})

// Tool-pair-safe split: the preserved window must not start with an orphaned
// tool_result whose matching tool_use got summarized away (provider 400).
describe('compactInFlightMessages — tool-pair-safe split', () => {
  it('walks the boundary back so the preserved half never starts with a tool_result', async () => {
    const { compactInFlightMessages } = await import('./context-builder')
    // 16 messages; with preserveRecent=8 the naive split point (index 8) lands on
    // a user turn carrying a tool_result. The walk-back must move it to a clean turn.
    const messages = Array.from({ length: 16 }, (_, i) =>
      i === 8
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tX', content: 'r' }] }
        : { role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` },
    )
    const out = await compactInFlightMessages(messages, { force: true, preserveRecent: 8 })
    // out[0] is the summary continuation; out[1] is the first preserved message —
    // it must NOT be a tool_result-bearing turn.
    const firstPreserved = out[1]
    const isToolResult =
      Array.isArray(firstPreserved.content) &&
      firstPreserved.content.some((b: { type?: string }) => b?.type === 'tool_result')
    expect(isToolResult).toBe(false)
  })
})

describe('getContextWindow + usableContextWindow (B2)', () => {
  it('returns the model config window and falls back for unknown models', async () => {
    const { getContextWindow, DEFAULT_CONTEXT_WINDOW_TOKENS } = await import('./model-config')
    expect(getContextWindow('claude-haiku-4-5-20251001')).toBe(200000)
    expect(getContextWindow('claude-haiku-4-5')).toBe(200000) // accepts config id too
    expect(getContextWindow('totally-unknown-model')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
  })

  // F6: a custom `fallback` lets the runner pass a conservative window for
  // unknown LOCAL models so pressure compaction fires before the model 400s.
  it('honors a custom fallback for unknown models (F6)', async () => {
    const { getContextWindow, LOCAL_FALLBACK_CONTEXT_WINDOW_TOKENS } = await import('./model-config')
    expect(getContextWindow('unknown-local-model', undefined, LOCAL_FALLBACK_CONTEXT_WINDOW_TOKENS)).toBe(8192)
    // A KNOWN model ignores the fallback and returns its real window.
    expect(getContextWindow('claude-haiku-4-5-20251001', undefined, 8192)).toBe(200000)
  })
})

// H1: getModelPricing is the SINGLE source of truth, derived from DEFAULT_MODELS
// (was a separate MODEL_PRICING table in types.ts that drifted and silently
// priced un-listed models at $0, disabling the cost cap).
describe('getModelPricing — single source of truth (H1)', () => {
  it('prices every paid DEFAULT_MODEL non-zero (no $0-cap-bypass), by id or modelId', async () => {
    const { getModelPricing, DEFAULT_MODELS } = await import('./model-config')
    const paid = DEFAULT_MODELS.filter((m) => m.costPer1MInput > 0 || m.costPer1MOutput > 0)
    expect(paid.length).toBeGreaterThan(0)
    for (const m of paid) {
      // No drift possible: pricing IS the model's own cost fields.
      expect(getModelPricing(m.modelId)).toEqual({ inputPer1M: m.costPer1MInput, outputPer1M: m.costPer1MOutput })
      expect(getModelPricing(m.id).inputPer1M).toBe(m.costPer1MInput) // accepts config id too
      expect(getModelPricing(m.modelId).inputPer1M + getModelPricing(m.modelId).outputPer1M).toBeGreaterThan(0)
    }
  })

  it('prices a user-added paid model from the passed configs (not just DEFAULT_MODELS)', async () => {
    const { getModelPricing } = await import('./model-config')
    const userModel = { id: 'my-gpt', modelId: 'acme/gpt-x', costPer1MInput: 2, costPer1MOutput: 8 } as never
    expect(getModelPricing('acme/gpt-x', [userModel])).toEqual({ inputPer1M: 2, outputPer1M: 8 })
  })

  it('returns {0,0} for genuinely unknown models (local/CLI passthrough are free)', async () => {
    const { getModelPricing } = await import('./model-config')
    expect(getModelPricing('totally-unknown:7b')).toEqual({ inputPer1M: 0, outputPer1M: 0 })
  })

  // R4: the deleted model-pricing-sync test guarded that no paid model prices $0.
  // With one source that guard moved here: a costPer1M:0 typo on a paid-provider
  // model would silently bypass the cost cap. Genuinely-free providers are exempt.
  it('every non-free-provider DEFAULT_MODEL prices non-zero (no $0-cap-bypass typo)', async () => {
    const { DEFAULT_MODELS } = await import('./model-config')
    const FREE_PROVIDERS = new Set(['local', 'claude-code', 'codex-cli'])
    const paidProviderModels = DEFAULT_MODELS.filter((m) => !FREE_PROVIDERS.has(m.provider))
    expect(paidProviderModels.length).toBeGreaterThan(0)
    for (const m of paidProviderModels) {
      expect(
        m.costPer1MInput > 0 || m.costPer1MOutput > 0,
        `${m.id} (${m.provider}) is a paid-provider model priced at $0 — it would disable the run cost cap`,
      ).toBe(true)
    }
  })
})
