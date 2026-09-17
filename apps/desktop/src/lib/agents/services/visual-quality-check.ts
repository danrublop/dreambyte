/**
 * Visual quality check via a vision model — provider-agnostic.
 *
 * After a scene's rendered frame is captured by the pending-captures
 * round-trip, this service sends the image to a lightweight vision model and
 * returns a structured quality assessment. Findings are surfaced as
 * severity:'warning' items attached to the auto-verify result so the agent
 * can self-correct without an explicit user prompt.
 *
 * Provider routing: the vision model is resolved from the media-understanding
 * registry (Gemini / Qwen-VL / Kimi / Anthropic Haiku / local Ollama),
 * NOT hardcoded. This is what lets a DeepSeek-driven agent see its own frames:
 * DeepSeek V4 is text-only, but the agent routes the vision sub-call to any
 * vision provider with a key. Previously this hardcoded Anthropic Haiku, so a
 * non-Anthropic setup got a blind agent.
 *
 * Cost discipline:
 *   - Cheapest available vision model (registry auto-order prefers local, then
 *     Qwen-VL, then Gemini, then Anthropic). Anthropic's system prompt is
 *     cached (ephemeral) when that engine is chosen.
 *   - Per-check cost target: ~$0.005 (0.5¢) — an estimate; the real guard is
 *     the per-run cap below.
 *   - Per-run cap: VISUAL_CHECK_COST_CAP_USD ($0.50). Once exceeded, checks
 *     are skipped for the remainder of the run and one warning is emitted.
 *
 * Failure mode: any timeout or API error → log at verbose, return null.
 * The caller must treat null as "no quality data" and not block the run.
 */

import { type RunCostLedger, commitCost, isOverCap } from '../run-cost-ledger'
import { probeCapabilities, resolveEngine } from './media-understanding-registry'
import { runVisionPrompt } from './vision-dispatch'

/** Per-run cap on vision-check spend in USD. */
export const VISUAL_CHECK_COST_CAP_USD = 0.5

/** Flat, conservative spend reservation per vision check, independent of the
 *  resolved provider (Gemini/Qwen-VL/Kimi/Anthropic/local). It only reserves
 *  against the per-run cost cap — the cap, not this estimate, is the real
 *  guard, so a rough flat figure is fine across providers. */
const ESTIMATED_COST_PER_CHECK_USD = 0.005

/** Timeout for the vision API call. */
const VISION_TIMEOUT_MS = 15_000

/**
 * Resolve the agent's vision engine from the capability registry (Gemini /
 * Qwen-VL / Kimi / Anthropic / local Ollama). Resolved ONCE per run and cached
 * on the run-scoped progress object — provider availability doesn't change
 * mid-run, and probeCapabilities touches the network (Ollama probe). Returns
 * null when no vision provider has a key (→ the agent is blind, checks skip).
 *
 * Injectable for tests so unit tests don't hit the network.
 */
let _resolveVisionEngineImpl = async (): Promise<string | null> => {
  const caps = await probeCapabilities()
  return resolveEngine('image', undefined, caps)?.id ?? null
}
export function __setVisionEngineResolverForTesting(fn: () => Promise<string | null>): void {
  _resolveVisionEngineImpl = fn
}

/**
 * Resolve (and cache on the run) whether ANY vision engine is available.
 *
 * Exported so a caller can ask BEFORE paying for a capture. runVisualQualityCheck
 * resolves this itself, but only after the frame has already been rendered and
 * round-tripped through the client — so a run with no vision key renders frames it
 * then immediately discards. Same cache field, so asking early costs nothing.
 */
export async function hasVisionEngine(runProgress: RunProgressLike): Promise<boolean> {
  if (!runProgress._visionResolved) {
    runProgress._visionEngineId = (await _resolveVisionEngineImpl()) ?? undefined
    runProgress._visionResolved = true
  }
  return !!runProgress._visionEngineId
}
export function __resetVisionEngineResolverForTesting(): void {
  _resolveVisionEngineImpl = async () => {
    const caps = await probeCapabilities()
    return resolveEngine('image', undefined, caps)?.id ?? null
  }
}

/** Structured output from the vision model. */
export interface VisualQualityResult {
  /** True if text elements appear readable (size, contrast adequate). */
  readable: boolean
  /** True if foreground/background contrast is sufficient. */
  contrast_ok: boolean
  /** True if the scene appears blank or completely static (no animation visible). */
  blank_or_static: boolean
  /** True if key elements are visible within frame bounds. */
  elements_visible: boolean
  /**
   * True if the frame plausibly depicts the stated scene intent (intent
   * comparison). Always true when no intent was provided with the check —
   * the model is instructed to default it, and the parser defaults a
   * missing/malformed field to true so intent-less checks behave exactly
   * as before.
   */
  matches_intent: boolean
  /** One-line note from the model. Empty string when all flags are true. */
  notes: string
}

/**
 * What the scene was SUPPOSED to depict. All fields optional — pass
 * whatever the caller has. Field values are truncated before prompting so a
 * pathological stored prompt can't blow up the (cheap, capped) vision call.
 */
export interface VisualCheckIntent {
  /** The user's request driving this run (or the sub-agent's task). */
  userPrompt?: string
  /** The captured scene's name. */
  sceneName?: string
  /** Scene-level intent: stored generation prompt, planned purpose, visual elements. */
  scenePlan?: string
}

/** Per-field caps keep the user message small; system prompt stays cached. */
const INTENT_FIELD_MAX_CHARS = { userPrompt: 400, sceneName: 100, scenePlan: 400 } as const

function buildIntentText(intent: VisualCheckIntent | undefined): string | null {
  if (!intent) return null
  const clip = (s: string | undefined, max: number) => {
    const t = s?.trim()
    if (!t) return null
    return t.length > max ? `${t.slice(0, max)}…` : t
  }
  const name = clip(intent.sceneName, INTENT_FIELD_MAX_CHARS.sceneName)
  const plan = clip(intent.scenePlan, INTENT_FIELD_MAX_CHARS.scenePlan)
  const prompt = clip(intent.userPrompt, INTENT_FIELD_MAX_CHARS.userPrompt)
  const parts = [
    name && `Scene name: ${name}`,
    plan && `Planned content: ${plan}`,
    prompt && `User request: ${prompt}`,
  ].filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

export interface VisualQualityWarning {
  severity: 'warning'
  code: string
  message: string
}

/**
 * Run a vision-model quality check on a captured scene frame.
 *
 * @param dataUri  Data URI from the pending-captures round-trip.
 * @param mimeType MIME type of the image (e.g. 'image/jpeg').
 * @param intent   Optional scene intent — judged via `matches_intent`.
 * @returns        Parsed quality result, or null on timeout/error.
 */
export async function checkVisualQuality(
  dataUri: string,
  mimeType: string,
  intent?: VisualCheckIntent,
  engineId?: string,
): Promise<VisualQualityResult | null> {
  // Extract base64 payload.
  const match = dataUri.match(/^data:[^;]+;base64,(.+)$/)
  if (!match) return null
  const base64Data = match[1]

  const mediaType = mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return null

  // Resolve the vision engine if the caller didn't pass one (it does in the
  // run wrapper, which resolves once per run). No engine → no vision provider.
  const engine = engineId ?? (await _resolveVisionEngineImpl())
  if (!engine) return null

  // Deterministic system prompt (no date / run-specific content) so the
  // Anthropic engine hits its prompt cache on every check after the first.
  const SYSTEM_PROMPT = `You are a video frame quality inspector. Evaluate the provided scene frame image and return ONLY a JSON object with no additional text, prose, or markdown. The JSON must have exactly these fields:
{
  "readable": <boolean — true if all text is readable at normal viewing size>,
  "contrast_ok": <boolean — true if foreground/background contrast is adequate>,
  "blank_or_static": <boolean — true if the frame is completely blank, solid color, or shows no animation potential>,
  "elements_visible": <boolean — true if key visual elements are within the frame bounds and not clipped>,
  "matches_intent": <boolean — the user message may include a "Scene intent" section describing what this frame is supposed to depict; true if the frame plausibly depicts it (judge subject matter, not polish). If NO intent section is present, always true>,
  "notes": <string — one sentence max; empty string "" when all flags are true>
}
Only output the JSON. No prose before or after.`

  // Intent rides in the USER text (not the system prompt) so the system prompt
  // stays byte-identical across checks and keeps its cache hit rate.
  const intentText = buildIntentText(intent)
  const userText = intentText
    ? `Scene intent (judge matches_intent against this):\n${intentText}\n\nEvaluate this scene frame. Return only the JSON object.`
    : 'Evaluate this scene frame. Return only the JSON object.'

  const raw = await runVisionPrompt(engine, {
    base64: base64Data,
    mimeType,
    systemPrompt: SYSTEM_PROMPT,
    userText,
    maxTokens: 256,
    timeoutMs: VISION_TIMEOUT_MS,
  })
  if (!raw) return null

  try {
    // Parse JSON — model should return only valid JSON per system prompt.
    // Tolerate a ```json fence (some providers wrap output).
    const jsonText = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    const parsed = JSON.parse(jsonText) as VisualQualityResult
    if (
      typeof parsed.readable !== 'boolean' ||
      typeof parsed.contrast_ok !== 'boolean' ||
      typeof parsed.blank_or_static !== 'boolean' ||
      typeof parsed.elements_visible !== 'boolean' ||
      typeof parsed.notes !== 'string'
    ) {
      return null
    }
    // matches_intent is lenient where the four core flags are strict: a
    // missing/malformed value defaults to true (no warning) rather than
    // discarding an otherwise-valid result — intent comparison is additive
    // and must never degrade the base checks.
    if (typeof parsed.matches_intent !== 'boolean') parsed.matches_intent = true
    return parsed
  } catch {
    return null
  }
}

/**
 * Convert a VisualQualityResult into warning objects for false flags.
 * Returns an empty array when the scene passes all checks.
 */
export function qualityResultToWarnings(result: VisualQualityResult): VisualQualityWarning[] {
  const warnings: VisualQualityWarning[] = []

  if (result.blank_or_static) {
    warnings.push({
      severity: 'warning',
      code: 'VISUAL_BLANK_OR_STATIC',
      message: 'Scene appears blank or completely static. Verify that animations are initializing correctly.',
    })
  }
  if (!result.readable) {
    warnings.push({
      severity: 'warning',
      code: 'VISUAL_TEXT_UNREADABLE',
      message: 'Text elements may be too small or low-contrast to read. Use a minimum 24px font at 1080p.',
    })
  }
  if (!result.contrast_ok) {
    warnings.push({
      severity: 'warning',
      code: 'VISUAL_LOW_CONTRAST',
      message: 'Foreground/background contrast appears insufficient. Adjust colors for readability.',
    })
  }
  if (!result.elements_visible) {
    warnings.push({
      severity: 'warning',
      code: 'VISUAL_ELEMENTS_OFFSCREEN',
      message: 'Key visual elements may be clipped or outside the frame. Check positioning.',
    })
  }
  if (!result.matches_intent) {
    warnings.push({
      severity: 'warning',
      code: 'VISUAL_INTENT_MISMATCH',
      message:
        'Frame does not appear to depict the planned scene intent. Compare the rendered content against the scene purpose / user request and adjust.',
    })
  }
  if (result.notes && warnings.length > 0) {
    // Append model notes to the last warning rather than creating a separate entry.
    warnings[warnings.length - 1].message += ` Note: ${result.notes}`
  }

  return warnings
}

// ── Runner-facing wrapper ─────────────────────────────────────────────────────

/**
 * Minimal shape this module needs from RunProgress — keeps the wrapper
 * decoupled from the full type so it can be unit-tested with a plain object.
 *
 * `_visualCheckCapAnnounced` is wrapper-private and not part of the public
 * RunProgress type. It exists so the "you hit the cap" warning fires exactly
 * once per run rather than on every subsequent code-write.
 */
interface RunProgressLike {
  visualCheckCostUsd?: number
  _visualCheckCapAnnounced?: boolean
  /** Vision engine resolved once per run (cached so probeCapabilities — which
   *  touches the network — runs at most once per run). */
  _visionEngineId?: string
  _visionResolved?: boolean
}

/**
 * Minimal shape this module needs from ToolResult — same rationale.
 */
interface ToolResultLike {
  success: boolean
  data?: unknown
}

/**
 * Minimal logger shape — accepts the project's AgentLogger or any logger
 * with the same (phase, message, data?) signature.
 */
interface LoggerLike {
  log(phase: string, message: string, data?: Record<string, unknown>): void
  warn(phase: string, message: string, data?: Record<string, unknown>): void
}

/**
 * Allow tests to swap in a mock that bypasses the live Anthropic API call.
 * Production code never sets this; the default is `checkVisualQuality`.
 */
let _checkImpl: typeof checkVisualQuality = checkVisualQuality
export function __setVisualQualityCheckImplForTesting(impl: typeof checkVisualQuality): void {
  _checkImpl = impl
}
export function __resetVisualQualityCheckImplForTesting(): void {
  _checkImpl = checkVisualQuality
}

/**
 * Run a vision-model quality check on a captured frame and attach any
 * resulting warnings to the tool result. Tracks per-run cost on runProgress
 * and short-circuits once VISUAL_CHECK_COST_CAP_USD is exceeded.
 *
 * Failure modes (timeout, malformed response, API error) are non-fatal:
 * the function logs the failure and returns without mutating the result.
 *
 * @param dataUri      Data URI returned by the capture round-trip.
 * @param mimeType     MIME type of the captured image.
 * @param result       Tool result to attach warnings to (mutated in place).
 * @param runProgress  Run-scoped progress object — cost counter is mutated.
 * @param logger       Agent logger for verbose / warn output.
 * @param costLedger   Shared parent+sub-agent run ledger (
 *                     TODOS #4). Visual-check spend used to bypass it
 *                     entirely: each sub-agent carried its OWN runProgress,
 *                     so an orchestrated build paid N × the visual cap and
 *                     the run-level cost cap never saw a cent of it. Spend
 *                     is now committed to the ledger, and a run already over
 *                     its cap skips checks the same way the visual cap does.
 * @param intent       Optional scene intent: what the frame was supposed
 *                     to depict. Surfaced as VISUAL_INTENT_MISMATCH when the
 *                     vision model judges the frame off-plan. Omitting it
 *                     keeps the intent-free behavior exactly (matches_intent ⇒ true).
 */
export async function runVisualQualityCheck(
  dataUri: string,
  mimeType: string,
  result: ToolResultLike,
  runProgress: RunProgressLike,
  logger: LoggerLike,
  costLedger?: RunCostLedger,
  intent?: VisualCheckIntent,
): Promise<void> {
  // Resolve the vision provider for this run (Gemini / Qwen-VL / Kimi /
  // Anthropic / local Ollama) ONCE, cached on the run-scoped progress object.
  // No provider with a key → the agent is blind; skip before reserving cost so
  // a setup without any vision key doesn't burn the ledger on guaranteed nulls.
  // (DeepSeek V4 is text-only, so a DeepSeek agent relies entirely on this
  // routing to see its own frames.)
  if (!runProgress._visionResolved) {
    runProgress._visionEngineId = (await _resolveVisionEngineImpl()) ?? undefined
    runProgress._visionResolved = true
  }
  const visionEngineId = runProgress._visionEngineId
  if (!visionEngineId) {
    logger.log('visual-check', 'Skipped — no vision provider configured (add a Gemini/Qwen/Kimi/Anthropic key)')
    return
  }

  const spent = runProgress.visualCheckCostUsd ?? 0

  // Run-level cap: if the SHARED ledger is already at its limit, spend
  // nothing more on vision checks — generation needs the remaining budget
  // more than QA does. Reuses the same announce-once pause path below.
  const ledgerOverCap = !!costLedger && isOverCap(costLedger)

  // Cost cap: once exceeded, emit one warning and skip further checks for
  // the remainder of the run. The "warn once" flag lives on runProgress
  // (run-scoped) — putting it on result.data would re-fire every tool call
  // since each call gets a fresh ToolResult.
  if (spent >= VISUAL_CHECK_COST_CAP_USD || ledgerOverCap) {
    if (!runProgress._visualCheckCapAnnounced) {
      runProgress._visualCheckCapAnnounced = true
      const existingData =
        typeof result.data === 'object' && result.data !== null ? (result.data as Record<string, unknown>) : {}
      result.data = {
        ...existingData,
        _visualWarnings: [
          {
            severity: 'warning' as const,
            code: 'VISUAL_CHECK_COST_CAP',
            message: ledgerOverCap
              ? `Visual quality checks paused — the run's cost cap is reached; remaining budget goes to generation, not QA.`
              : `Visual quality checks paused for this run (spent $${spent.toFixed(3)} of $${VISUAL_CHECK_COST_CAP_USD.toFixed(2)} cap). Subsequent code-writes will not surface visual warnings.`,
          },
        ],
      }
      logger.warn('visual-check', 'Cost cap reached, suppressing further checks', {
        spentUsd: spent,
        ledgerOverCap,
      })
    }
    return
  }

  // RESERVE the estimated cost BEFORE the await (R4). The old order —
  // gate-check, await the vision call, then commit — let M concurrent
  // sub-agent checks all pass the gate before any committed, overshooting
  // the cap by ~M × estimate. Charging up front closes that window, and it
  // costs nothing semantically: the policy was already "always charge, even
  // on null/error, so a misbehaving vision model can't infinitely retry."
  // The spend also lands on the SHARED run ledger so the parent's cost
  // cap accounts for sub-agent vision checks (they each carry their own
  // runProgress, but the ledger is passed by reference run-wide).
  runProgress.visualCheckCostUsd = spent + ESTIMATED_COST_PER_CHECK_USD_EXPORT
  if (costLedger) commitCost(costLedger, ESTIMATED_COST_PER_CHECK_USD_EXPORT)

  const quality = await _checkImpl(dataUri, mimeType, intent, visionEngineId)

  if (!quality) {
    logger.log('visual-check', 'No quality data (timeout or parse error)')
    return
  }

  const warnings = qualityResultToWarnings(quality)
  if (warnings.length === 0) {
    logger.log('visual-check', 'Scene passed all visual checks')
    return
  }

  const existingData =
    typeof result.data === 'object' && result.data !== null ? (result.data as Record<string, unknown>) : {}
  result.data = {
    ...existingData,
    _visualWarnings: warnings,
  }
  logger.log('visual-check', `Surfaced ${warnings.length} visual warning(s)`, {
    codes: warnings.map((w) => w.code),
  })
}

/**
 * Re-exported as a named constant so the wrapper can reference it without
 * the `const`-vs-module-private collision. Kept private earlier for clarity
 * inside `checkVisualQuality`, but the wrapper needs read access too.
 */
const ESTIMATED_COST_PER_CHECK_USD_EXPORT = ESTIMATED_COST_PER_CHECK_USD
