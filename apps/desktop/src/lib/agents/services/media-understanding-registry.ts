/**
 * Media-understanding capability registry (multimodal intake).
 *
 * Probes which engines are actually available across the three peer tiers
 * (Local / Cloud / Premium) and resolves, per modality, the engine to use —
 * either the user's Settings choice or `auto` (best available).
 *
 * Design:
 *   - Cloud is first-class, not a fallback: most users can't run local models.
 *   - `auto` prefers a LOCAL model when one is installed (free / private /
 *     cost-effective per the user directive), else the best available CLOUD
 *     engine, else nothing (deterministic brief). Premium is opt-in only.
 *   - Pure + injectable: the Ollama probe and env reads are parameters so the
 *     registry is unit-testable without a live Ollama or real keys.
 */

import type { ReferenceMediaKind } from '../types'
import { OPENAI_COMPAT_VISION_PROVIDERS as COMPAT_PROVIDERS } from './intake-engines/openai-compat-vision'

export type MediaTier = 'local' | 'cloud' | 'premium'

export interface MediaEngine {
  /** Concrete engine id, e.g. `local:qwen2.5vl`, `cloud:gemini`, `premium:marlin`. */
  id: string
  tier: MediaTier
  /** Human label for the Settings selector. */
  label: string
  /** Modalities this engine can analyze. */
  kinds: ReferenceMediaKind[]
  available: boolean
  /** When unavailable, a one-line reason for the UI. */
  reason?: string
}

/** Snapshot of what the host can currently do. */
export interface CapabilityProbe {
  /** Ollama model tags pulled locally (e.g. `qwen2.5vl:7b`, `moondream`). */
  ollamaModels: string[]
  hasAnthropicKey: boolean
  hasOpenAIKey: boolean
  hasGoogleKey: boolean
  /** Which OpenAI-compat vision providers have their key set (qwen/kimi/deepseek).
   *  Optional so older callers/fixtures still typecheck; absent = none available. */
  compatKeys?: Record<string, boolean>
  /** NVIDIA/CUDA GPU present (premium Marlin path). Probed in the Electron layer. */
  hasCuda: boolean
  /** Set when a CUDA host still can't run Marlin (e.g. missing Python deps). */
  marlinUnavailableReason?: string
}

const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434'

/**
 * Ollama vision-capable model families, in descending preference. We match by
 * prefix because tags carry a size suffix (`qwen2.5vl:7b`). Order encodes the
 * §3 quality ranking: Qwen2.5-VL (best structured/OCR) > MiniCPM-V > LLaVA >
 * Moondream (smallest/fastest).
 */
const OLLAMA_VISION_PREFERENCE = [
  'qwen2.5vl',
  'qwen2-vl',
  'minicpm-v',
  'llava',
  'bakllava',
  'moondream',
  'llama3.2-vision',
]

/** Best vision model name among the pulled tags, or null if none is vision-capable. */
export function pickOllamaVisionModel(models: string[]): string | null {
  for (const fam of OLLAMA_VISION_PREFERENCE) {
    const hit = models.find((m) => m.toLowerCase().startsWith(fam))
    if (hit) return hit
  }
  return null
}

export interface ProbeOptions {
  ollamaEndpoint?: string
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable env reader (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>
  /** CUDA presence (probed by the Electron host; defaults false in renderer/tests). */
  hasCuda?: boolean
  /** Probe timeout for the Ollama call. */
  timeoutMs?: number
}

/** Short-TTL cache so repeated intake runs don't re-pay the connect/timeout cost
 *  (notably the full probe timeout on hosts without Ollama). Keyed by endpoint. */
const _ollamaProbeCache = new Map<string, { at: number; models: string[] }>()
const OLLAMA_PROBE_TTL_MS = 60_000

/** List the model tags Ollama has pulled. Empty array if Ollama is unreachable.
 *  Cached per endpoint for OLLAMA_PROBE_TTL_MS. Inject `fetchImpl` to bypass the
 *  cache deterministically in tests (cache is skipped when a custom fetch is given). */
export async function probeOllamaModels(opts: ProbeOptions = {}): Promise<string[]> {
  // OLLAMA_ENDPOINT is the same env override the runner's inference path
  // honors (src/lib/agents/runner.ts) — probe and calls must agree on the host.
  const endpoint = opts.ollamaEndpoint ?? process.env.OLLAMA_ENDPOINT ?? DEFAULT_OLLAMA_ENDPOINT
  const doFetch = opts.fetchImpl ?? fetch
  const useCache = !opts.fetchImpl
  if (useCache) {
    const hit = _ollamaProbeCache.get(endpoint)
    if (hit && Date.now() - hit.at < OLLAMA_PROBE_TTL_MS) return hit.models
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500)
  try {
    const res = await doFetch(`${endpoint}/api/tags`, { signal: controller.signal })
    if (!res.ok) return []
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] }
    const models = (body.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean)
    if (useCache) _ollamaProbeCache.set(endpoint, { at: Date.now(), models })
    return models
  } catch {
    // Cache the "unreachable" result too, so a down Ollama doesn't cost the full
    // timeout on every run for the next TTL window.
    if (useCache) _ollamaProbeCache.set(endpoint, { at: Date.now(), models: [] })
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** Build a full capability snapshot. Never throws — unreachable probes degrade. */
export async function probeCapabilities(opts: ProbeOptions = {}): Promise<CapabilityProbe> {
  const env = opts.env ?? process.env
  const ollamaModels = await probeOllamaModels(opts)
  // CUDA: explicit override wins (tests); otherwise consult the GPU-probe seam
  // (Electron wires nvidia-smi; defaults false everywhere else).
  let hasCuda = opts.hasCuda
  let marlinUnavailableReason: string | undefined
  if (hasCuda === undefined) {
    const { detectCuda } = await import('./gpu-probe')
    hasCuda = await detectCuda()
    if (hasCuda) {
      const { getMarlinUnavailableReason } = await import('@/lib/services/video-understander')
      marlinUnavailableReason = getMarlinUnavailableReason() ?? undefined
    }
  }
  // OpenAI-compat vision providers: available iff their key env is set.
  const compatKeys: Record<string, boolean> = {}
  for (const p of Object.values(COMPAT_PROVIDERS)) {
    compatKeys[p.key] = Boolean(env[p.keyEnv])
  }
  return {
    ollamaModels,
    hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
    hasOpenAIKey: Boolean(env.OPENAI_API_KEY),
    hasGoogleKey: Boolean(env.GOOGLE_AI_KEY),
    compatKeys,
    hasCuda,
    marlinUnavailableReason,
  }
}

/**
 * Enumerate every engine for a modality with its availability + reason. Drives
 * the Settings → Media Understanding selector (disabled entries show `reason`).
 */
export function listEngines(kind: ReferenceMediaKind, caps: CapabilityProbe): MediaEngine[] {
  const engines: MediaEngine[] = []
  const visionModel = pickOllamaVisionModel(caps.ollamaModels)

  // ── Local tier ──
  if (kind === 'image' || kind === 'video') {
    engines.push({
      id: visionModel ? `local:${visionModel}` : 'local:ollama',
      tier: 'local',
      label: visionModel ? `Local — ${visionModel} (Ollama)` : 'Local — Ollama vision model',
      kinds: [kind],
      available: Boolean(visionModel),
      reason: visionModel ? undefined : 'No vision model pulled in Ollama (try `ollama pull qwen2.5vl`)',
    })
  }
  if (kind === 'audio') {
    // whisper.cpp is the local speech path; for now the local audio engine
    // routes through the existing CaptionTranscriber seam (Whisper API today,
    // whisper.cpp opt-in later). Treated as available when an OpenAI key exists.
    engines.push({
      id: 'local:whisper',
      tier: 'local',
      label: 'Local — whisper.cpp (speech)',
      kinds: ['audio'],
      available: caps.hasOpenAIKey, // until whisper.cpp ships, the seam uses the API
      reason: caps.hasOpenAIKey ? undefined : 'Local whisper.cpp not yet installed',
    })
  }
  if (kind === 'doc') {
    engines.push({
      id: 'local:pdfjs',
      tier: 'local',
      label: 'Local — pdf.js text extraction',
      kinds: ['doc'],
      available: true, // pure JS, always available
    })
  }

  // ── Cloud tier (first-class) ──
  if (kind === 'image' || kind === 'video') {
    engines.push({
      id: 'cloud:gemini',
      tier: 'cloud',
      label: 'Cloud — Gemini',
      kinds: [kind],
      available: caps.hasGoogleKey,
      reason: caps.hasGoogleKey ? undefined : 'Add a Google AI API key in Settings',
    })
    engines.push({
      id: 'cloud:anthropic',
      tier: 'cloud',
      label: 'Cloud — Claude (Haiku vision)',
      kinds: [kind],
      available: caps.hasAnthropicKey,
      reason: caps.hasAnthropicKey ? undefined : 'Add an Anthropic API key in Settings',
    })
    // OpenAI-compat cheap vision providers: Qwen-VL / Kimi / DeepSeek.
    for (const p of Object.values(COMPAT_PROVIDERS)) {
      engines.push({
        id: `cloud:${p.key}`,
        tier: 'cloud',
        label: `Cloud — ${p.label} (cheaper)`,
        kinds: [kind],
        available: Boolean(caps.compatKeys?.[p.key]),
        reason: caps.compatKeys?.[p.key] ? undefined : `Add a ${p.label} API key (${p.keyEnv}) in Settings`,
      })
    }
  }
  if (kind === 'audio') {
    engines.push({
      id: 'cloud:gemini',
      tier: 'cloud',
      label: 'Cloud — Gemini (transcript + sound/music)',
      kinds: ['audio'],
      available: caps.hasGoogleKey,
      reason: caps.hasGoogleKey ? undefined : 'Add a Google AI API key in Settings',
    })
    engines.push({
      id: 'cloud:whisper',
      tier: 'cloud',
      label: 'Cloud — Whisper API',
      kinds: ['audio'],
      available: caps.hasOpenAIKey,
      reason: caps.hasOpenAIKey ? undefined : 'Add an OpenAI API key in Settings',
    })
  }

  // ── Premium tier (opt-in, heavy local) — surfaced but not implemented ──
  if (kind === 'video') {
    engines.push({
      id: 'premium:marlin',
      tier: 'premium',
      label: 'Premium — Marlin-2B (dense captions + temporal grounding)',
      kinds: ['video'],
      available: caps.hasCuda && !caps.marlinUnavailableReason,
      reason: caps.hasCuda ? caps.marlinUnavailableReason : 'Requires an NVIDIA (CUDA) GPU',
    })
  }
  if (kind === 'doc') {
    engines.push({
      id: 'premium:docling',
      tier: 'premium',
      label: 'Premium — Docling (layout/structure)',
      kinds: ['doc'],
      available: false,
      reason: 'Install Docling to enable structured document parsing',
    })
  }

  return engines
}

/**
 * Auto preference order per modality. Encodes "prefer local (free) → else best
 * cloud", with premium never auto-selected. Returns engine ids in priority order.
 */
function autoOrder(kind: ReferenceMediaKind): string[] {
  switch (kind) {
    case 'image':
      // Local-first; then cheapest capable cloud (Qwen-VL, same family we run
      // locally + ~10x cheaper) before Gemini/Anthropic.
      // DeepSeek/Kimi are selectable but not first in auto (newer vision).
      return ['local:', 'cloud:qwen', 'cloud:gemini', 'cloud:anthropic']
    case 'video':
      // Local-first for privacy; then cheapest cloud (Qwen) → Gemini → Anthropic.
      return ['local:', 'cloud:qwen', 'cloud:gemini', 'cloud:anthropic']
    case 'audio':
      return ['local:whisper', 'cloud:gemini', 'cloud:whisper']
    case 'doc':
      return ['local:pdfjs']
  }
}

/**
 * Resolve the engine for a modality. `override` is the Settings choice
 * (`auto` or a concrete id). Falls back to the auto chain when the chosen
 * engine is unavailable. Returns null only when nothing at all is available.
 */
export function resolveEngine(
  kind: ReferenceMediaKind,
  override: string | undefined,
  caps: CapabilityProbe,
): MediaEngine | null {
  const engines = listEngines(kind, caps)
  const available = engines.filter((e) => e.available)
  if (available.length === 0) return null

  // Explicit, available, non-auto choice wins.
  if (override && override !== 'auto') {
    const exact = available.find((e) => e.id === override)
    if (exact) return exact
    // Allow a prefix match (e.g. saved `local:qwen2.5vl:7b` vs probed tag drift).
    const prefix = available.find((e) => e.id.startsWith(override) || override.startsWith(e.id))
    if (prefix) return prefix
    // Chosen engine no longer available → fall through to auto.
  }

  for (const want of autoOrder(kind)) {
    const hit = available.find((e) => (want.endsWith(':') ? e.id.startsWith(want) : e.id === want))
    if (hit) return hit
  }
  // Anything available beats nothing.
  return available[0]
}
