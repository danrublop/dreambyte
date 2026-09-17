/**
 * Semantic memory extraction (audit F1) — the LLM pass the heuristic
 * extractor can't be.
 *
 * memory-extractor.ts mines the TOOL LOG with rules (preset/palette counts,
 * narration ratios). What it structurally cannot see is what the user SAID:
 * "use our brand green #00A86B", "never add background music", "this is for
 * my chemistry class". This module sends the user's message + a compact run
 * summary + the existing memory keys to a cheap model and gets back durable
 * preference memories in the same MemoryExtraction shape, upserted through
 * the same pipe.
 *
 * Cost discipline (mirrors visual-quality-check):
 *   - cheapest available provider (budget tier), ONE call per run,
 *     max_tokens 400, 15s timeout
 *   - key-gated: no text provider configured → skip silently (heuristics
 *     still ran). Routes through completeText so a DeepSeek/Qwen/Kimi-only
 *     setup keeps semantic memory instead of losing it to a hardcoded provider.
 *   - skipped for trivial messages (< MIN_MESSAGE_CHARS) — "make it pop"
 *     carries no durable preference worth $0.005
 *   - failure mode: any error/timeout/garbage → [] (never blocks the run;
 *     extraction is already fire-and-forget at the call site)
 *
 * Trust discipline:
 *   - strict shape validation, snake_case keys, category allowlist
 *   - confidence clamped to ≤ 0.8 — an inference from prose must never
 *     out-confidence the heuristics' direct observation of tool calls
 *   - at most MAX_MEMORIES_PER_RUN survive (highest confidence first)
 */

import type { MemoryExtraction } from './memory-extractor'
import type { ToolCallRecord } from './types'
import { completeText, resolveTextModel, hasAnyTextProviderKey } from '@/lib/generation/generate'
import { INFERRED_DELTA_CAP } from './confidence-pipeline'

const TIMEOUT_MS = 15_000
const MIN_MESSAGE_CHARS = 25
const MAX_MESSAGE_CHARS = 1200
const MAX_MEMORIES_PER_RUN = 5
const MAX_CONFIDENCE = 0.8
const VALID_CATEGORIES = new Set(['style', 'content', 'workflow', 'feedback'])

/** Compact tool histogram — names + counts only, no args (token + privacy). */
export function summarizeToolUsage(toolCalls: ToolCallRecord[]): string {
  const counts = new Map<string, number>()
  for (const tc of toolCalls) {
    if (tc.output?.success) counts.set(tc.toolName, (counts.get(tc.toolName) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
    .join(', ')
}

const SYSTEM_PROMPT = `You extract DURABLE user preferences from one video-editing agent session. Return ONLY a JSON array (no prose/markdown), each item:
{"category": "style"|"content"|"workflow"|"feedback", "key": "<short_snake_case>", "value": "<the preference, concise>", "confidence": <0..1>}

Extract ONLY preferences that will matter in FUTURE sessions: brand colors/fonts, audience ("for my chemistry class"), recurring do/don't instructions ("never add music"), domain context. Do NOT extract: one-off scene instructions, anything already covered by an existing memory key with the same meaning (update it instead by reusing its key), or guesses. Empty array when nothing durable was said.`

/** Parse + validate the model's JSON into MemoryExtraction entries. */
export function parseSemanticMemories(raw: string): MemoryExtraction[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: MemoryExtraction[] = []
  for (const item of parsed) {
    const m = item as Record<string, unknown>
    if (
      typeof m?.category !== 'string' ||
      !VALID_CATEGORIES.has(m.category) ||
      typeof m.key !== 'string' ||
      !/^[a-z][a-z0-9_]{1,60}$/.test(m.key) ||
      typeof m.value !== 'string' ||
      m.value.trim().length === 0 ||
      m.value.length > 500 ||
      typeof m.confidence !== 'number' ||
      !Number.isFinite(m.confidence)
    ) {
      continue // drop malformed entries, keep the rest
    }
    out.push({
      category: m.category as MemoryExtraction['category'],
      key: m.key,
      value: m.value.trim(),
      confidence: Math.max(0.1, Math.min(MAX_CONFIDENCE, m.confidence)),
    })
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_MEMORIES_PER_RUN)
}

/** Test seam — swap the LLM transport without network I/O. */
export type SemanticMemoryTransport = (systemPrompt: string, userPrompt: string) => Promise<string | null>
let _transport: SemanticMemoryTransport | null = null
export function __setSemanticMemoryTransportForTesting(t: SemanticMemoryTransport | null): void {
  _transport = t
}

async function callModel(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (_transport) return _transport(systemPrompt, userPrompt)
  // Cheapest available provider (budget tier). completeText handles
  // Anthropic / OpenAI / Google / DeepSeek / Qwen / Kimi / local. A timeout
  // race preserves the "never stall a run" guarantee (extraction is
  // fire-and-forget, so a slow provider just yields []).
  const model = resolveTextModel(undefined, 'budget')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS)
  })
  // .catch on the work promise so that if it loses the race and LATER rejects
  // (a slow provider 401ing after the 60-90s SDK timeout), the orphan can't
  // raise an unhandledRejection in the Electron main process (no global
  // handler). Extraction is fire-and-forget — a failure just yields [].
  const work = completeText(model, systemPrompt, userPrompt, 400)
    .then((c) => (c?.raw?.trim() ? c.raw : null))
    .catch(() => null)
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Extract semantic memories from a completed run. Returns [] on every
 * failure/skip path — the call site treats this as additive to the
 * heuristic extraction, never a replacement.
 */
export async function extractSemanticMemories(opts: {
  userMessage: string
  toolCalls: ToolCallRecord[]
  /** Existing memory (key, value) pairs so the model UPDATES instead of duplicating. */
  existingMemories?: Array<{ key: string; value: string }>
}): Promise<MemoryExtraction[]> {
  const msg = opts.userMessage.trim()
  if (msg.length < MIN_MESSAGE_CHARS) return []
  if (!_transport && !hasAnyTextProviderKey()) return []

  const existing = (opts.existingMemories ?? [])
    .slice(0, 20)
    .map((m) => `- ${m.key}: ${m.value.slice(0, 120)}`)
    .join('\n')

  const userPrompt = [
    `User's request this session:\n"""${msg.slice(0, MAX_MESSAGE_CHARS)}"""`,
    `Tools the agent used: ${summarizeToolUsage(opts.toolCalls) || '(none)'}`,
    existing ? `Existing memories (reuse these keys to update):\n${existing}` : null,
    'Extract durable preferences as the JSON array.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const raw = await callModel(SYSTEM_PROMPT, userPrompt)
  if (!raw) return []
  return parseSemanticMemories(raw)
}

// ── Inferred confidence adjustments from the user's NEXT message ─────────
//
// Separate from extraction: extraction MINTS new durable prefs; this pass reads
// the user's latest message against the EXISTING memory keys and infers whether
// each was confirmed ("yes, keep it dark") or contradicted ("actually make it
// light"). It returns a small, clamped ±delta per affected key — never a new
// memory, never a value rewrite. The runner routes these through
// adjustMemoryKeyConfidence so a misread self-corrects via decay.

export interface InferredAdjustment {
  category: string
  key: string
  /** Signed delta, clamped to ±INFERRED_DELTA_CAP downstream. */
  delta: number
}

const INFERENCE_SYSTEM_PROMPT = `You judge whether a user's message CONFIRMS or CONTRADICTS each of their existing remembered preferences. Return ONLY a JSON array (no prose/markdown), each item:
{"category": "style"|"content"|"workflow"|"feedback", "key": "<existing_key>", "delta": <number in [-1,1]>}

Rules:
- ONLY reference keys from the provided existing-memories list — never invent keys.
- delta > 0 if the message reaffirms/relies on that preference; delta < 0 if it overrides/abandons it; OMIT keys the message says nothing about.
- Keep |delta| small (≈0.3–1.0); it is scaled down before use. Empty array when the message confirms/contradicts nothing.`

/** Parse + validate the inference model's JSON, scoped to known keys. */
export function parseInferredAdjustments(raw: string, knownKeys: Set<string>): InferredAdjustment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: InferredAdjustment[] = []
  for (const item of parsed) {
    const m = item as Record<string, unknown>
    if (
      typeof m?.category !== 'string' ||
      !VALID_CATEGORIES.has(m.category) ||
      typeof m.key !== 'string' ||
      typeof m.delta !== 'number' ||
      !Number.isFinite(m.delta) ||
      m.delta === 0
    ) {
      continue
    }
    // Drop any key we didn't actually have a memory for (anti-hallucination).
    if (!knownKeys.has(`${m.category}:${m.key}`)) continue
    // Scale the model's [-1,1] judgement into the clamped taste band so a
    // single inference can only nudge, never dominate.
    const delta = Math.max(-INFERRED_DELTA_CAP, Math.min(INFERRED_DELTA_CAP, m.delta * INFERRED_DELTA_CAP))
    out.push({ category: m.category as InferredAdjustment['category'], key: m.key, delta })
  }
  return out
}

/**
 * Infer per-key confidence adjustments from the user's message against their
 * existing memories. Returns [] on every skip/failure path (no provider key,
 * trivial message, no existing memories, parse error) — purely additive to the
 * taste loop, never blocks a run.
 */
export async function inferMemoryAdjustments(opts: {
  userMessage: string
  existingMemories?: Array<{ category: string; key: string; value: string }>
}): Promise<InferredAdjustment[]> {
  const msg = opts.userMessage.trim()
  if (msg.length < MIN_MESSAGE_CHARS) return []
  const existing = opts.existingMemories ?? []
  if (existing.length === 0) return []
  if (!_transport && !hasAnyTextProviderKey()) return []

  const knownKeys = new Set(existing.map((m) => `${m.category}:${m.key}`))
  const listed = existing
    .slice(0, 20)
    .map((m) => `- [${m.category}] ${m.key}: ${m.value.slice(0, 120)}`)
    .join('\n')

  const userPrompt = [
    `User's latest message:\n"""${msg.slice(0, MAX_MESSAGE_CHARS)}"""`,
    `Existing remembered preferences:\n${listed}`,
    'Return the JSON array of confirmed/contradicted keys.',
  ].join('\n\n')

  const raw = await callModel(INFERENCE_SYSTEM_PROMPT, userPrompt)
  if (!raw) return []
  return parseInferredAdjustments(raw, knownKeys)
}
