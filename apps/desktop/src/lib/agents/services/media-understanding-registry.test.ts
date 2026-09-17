// @vitest-environment node
/**
 * Tests for the media-understanding capability registry (Phase 2 intake).
 *
 * Focus: engine availability + the resolve/fallback chain across probe
 * permutations (Ollama up/down, keys present/absent, CUDA yes/no). No live
 * Ollama or real keys — the probe is fully injectable.
 */

import { describe, it, expect } from 'vitest'
import {
  pickOllamaVisionModel,
  listEngines,
  resolveEngine,
  probeCapabilities,
  type CapabilityProbe,
} from './media-understanding-registry'

const NO_CAPS: CapabilityProbe = {
  ollamaModels: [],
  hasAnthropicKey: false,
  hasOpenAIKey: false,
  hasGoogleKey: false,
  hasCuda: false,
}

describe('pickOllamaVisionModel', () => {
  it('prefers qwen2.5vl over llava/moondream', () => {
    expect(pickOllamaVisionModel(['llava:7b', 'qwen2.5vl:7b', 'moondream'])).toBe('qwen2.5vl:7b')
  })
  it('falls back down the preference chain', () => {
    expect(pickOllamaVisionModel(['moondream', 'llava:13b'])).toBe('llava:13b')
    expect(pickOllamaVisionModel(['moondream'])).toBe('moondream')
  })
  it('returns null when no vision model is present', () => {
    expect(pickOllamaVisionModel(['llama3.1:8b', 'mistral'])).toBeNull()
  })
})

describe('listEngines availability', () => {
  it('image: local available only when a vision model is pulled; cloud gated on keys', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, ollamaModels: ['qwen2.5vl:7b'], hasGoogleKey: true }
    const engines = listEngines('image', caps)
    const local = engines.find((e) => e.tier === 'local')!
    expect(local.available).toBe(true)
    expect(local.id).toBe('local:qwen2.5vl:7b')
    const gemini = engines.find((e) => e.id === 'cloud:gemini')!
    expect(gemini.available).toBe(true)
    const anthropic = engines.find((e) => e.id === 'cloud:anthropic')!
    expect(anthropic.available).toBe(false)
    expect(anthropic.reason).toMatch(/Anthropic API key/)
  })

  it('image: local unavailable with a reason when no vision model pulled', () => {
    const local = listEngines('image', NO_CAPS).find((e) => e.tier === 'local')!
    expect(local.available).toBe(false)
    expect(local.reason).toMatch(/ollama pull|pulled in Ollama/i)
  })

  it('doc: pdf.js local engine is always available', () => {
    const local = listEngines('doc', NO_CAPS).find((e) => e.id === 'local:pdfjs')!
    expect(local.available).toBe(true)
  })

  it('video: premium Marlin gated on CUDA', () => {
    const noGpu = listEngines('video', NO_CAPS).find((e) => e.id === 'premium:marlin')!
    expect(noGpu.available).toBe(false)
    const gpu = listEngines('video', { ...NO_CAPS, hasCuda: true }).find((e) => e.id === 'premium:marlin')!
    expect(gpu.available).toBe(true)
  })

  it('video: Marlin stays unavailable on a CUDA host whose Python env cannot run it', () => {
    const reason = 'Python module "torch" is missing; install the Python dependencies'
    const e = listEngines('video', { ...NO_CAPS, hasCuda: true, marlinUnavailableReason: reason }).find(
      (x) => x.id === 'premium:marlin',
    )!
    expect(e.available).toBe(false)
    expect(e.reason).toBe(reason)
  })
})

describe('resolveEngine', () => {
  it('auto prefers a local model over cloud for images', () => {
    const caps: CapabilityProbe = {
      ...NO_CAPS,
      ollamaModels: ['qwen2.5vl:7b'],
      hasGoogleKey: true,
      hasAnthropicKey: true,
    }
    const chosen = resolveEngine('image', 'auto', caps)
    expect(chosen?.tier).toBe('local')
  })

  it('auto falls back to cloud when no local model', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, hasGoogleKey: true }
    const chosen = resolveEngine('image', 'auto', caps)
    expect(chosen?.id).toBe('cloud:gemini')
  })

  it('honors an explicit available override', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, ollamaModels: ['qwen2.5vl:7b'], hasAnthropicKey: true }
    const chosen = resolveEngine('image', 'cloud:anthropic', caps)
    expect(chosen?.id).toBe('cloud:anthropic')
  })

  it('falls back to auto when the chosen engine is unavailable', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, hasGoogleKey: true } // gemini available, anthropic not
    const chosen = resolveEngine('image', 'cloud:anthropic', caps)
    expect(chosen?.id).toBe('cloud:gemini')
  })

  it('prefix-matches a saved local tag against probed drift', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, ollamaModels: ['qwen2.5vl:7b'] }
    // Saved choice from a previous session: bare family name.
    const chosen = resolveEngine('image', 'local:qwen2.5vl', caps)
    expect(chosen?.id).toBe('local:qwen2.5vl:7b')
  })

  it('returns null when nothing is available', () => {
    expect(resolveEngine('image', 'auto', NO_CAPS)).toBeNull()
    expect(resolveEngine('audio', 'auto', NO_CAPS)).toBeNull()
  })

  it('doc always resolves (pdf.js needs nothing)', () => {
    expect(resolveEngine('doc', 'auto', NO_CAPS)?.id).toBe('local:pdfjs')
  })
})

describe('probeCapabilities', () => {
  it('reports Ollama unreachable as empty model list, never throws', async () => {
    const caps = await probeCapabilities({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
      env: {},
    })
    expect(caps.ollamaModels).toEqual([])
    expect(caps.hasAnthropicKey).toBe(false)
  })

  it('parses /api/tags and reads keys from env', async () => {
    const caps = await probeCapabilities({
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ models: [{ name: 'qwen2.5vl:7b' }, { model: 'llama3.1:8b' }] }),
      })) as unknown as typeof fetch,
      env: { ANTHROPIC_API_KEY: 'x', GOOGLE_AI_KEY: 'y' },
    })
    expect(caps.ollamaModels).toEqual(['qwen2.5vl:7b', 'llama3.1:8b'])
    expect(caps.hasAnthropicKey).toBe(true)
    expect(caps.hasGoogleKey).toBe(true)
    expect(caps.hasOpenAIKey).toBe(false)
  })
})
