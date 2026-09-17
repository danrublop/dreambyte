/**
 * Per-turn token-usage accounting for the runner's multi-turn loop.
 *
 * Billing model: EVERY provider — Anthropic included — bills each API call's
 * full prompt independently. Anthropic's per-call `input_tokens` does cover
 * the whole accumulated context, but that context is *charged again* on every
 * call, so the run's true spend is the SUM of per-call usage across turns.
 *
 * The runner previously OVERWROTE the run totals each turn for Anthropic
 * (both the adapter branch and the legacy streaming branch), on the mistaken
 * reasoning that "per-call usage already reflects full context". True for
 * prompt *content*, wrong for *billing*: the ledger ended up holding roughly
 * one turn's cost, so the per-run cost cap under-enforced and
 * logSpend/logAgentUsage under-reported multi-turn runs on the default
 * provider. These helpers are the single accounting shape both branches use;
 * the paired source-parity test (usage-accounting.test.ts) forbids plain
 * overwrite assignments into the totals inside runner.ts.
 *
 * Kept pure + dependency-free so tests exercise the arithmetic without the
 * runner's provider graph.
 */

/** The four run-total counters the runner maintains. */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

/** Normalized per-turn usage as reported by a provider adapter
 *  (consumeAdapterStream's `turn.usage`). */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number | null
  cacheReadTokens?: number | null
}

/** Anthropic SDK `Message.usage` shape (the legacy branch's
 *  `finalMessage().usage`). */
export interface FinalMessageUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/**
 * ADAPTER branch: add one turn's clean per-call usage to the run totals.
 * Provider-independent — Anthropic, OpenAI, Google, and the OpenAI-compat
 * providers (DeepSeek/Kimi/Qwen) all accumulate identically, because each
 * API call bills its own prompt (see module doc).
 *
 * Returns new totals (pure). A turn that reported no usage at all is a no-op,
 * matching the runner's historical `inputTokens > 0 || outputTokens > 0` gate.
 */
export function accumulateTurnUsage(totals: UsageTotals, turn: TurnUsage): UsageTotals {
  if (turn.inputTokens <= 0 && turn.outputTokens <= 0) return totals
  return {
    inputTokens: totals.inputTokens + turn.inputTokens,
    outputTokens: totals.outputTokens + turn.outputTokens,
    // Cached reads/creations are split out of the prompt count per
    // provider — accumulate them like the other per-call fields so
    // calculateCost bills them at the provider's cache rate.
    cacheCreationTokens: totals.cacheCreationTokens + (turn.cacheCreationTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (turn.cacheReadTokens ?? 0),
  }
}

/**
 * LEGACY Anthropic branch: two-phase per-turn accounting.
 *
 * Phase 1 (during the stream): message_start / message_delta usage deltas are
 * added straight into the run totals so mid-turn progress (run_progress
 * events, the 80% cap warning) tracks live.
 *
 * Phase 2 (here, after `finalMessage()` resolves): the final message's usage
 * is authoritative for THIS turn — streaming deltas can undercount by 2-5%
 * due to cache overhead and framing. Correct the totals to
 * `turnStart + finalUsage`, replacing only this turn's stream-counted slice;
 * prior turns stay summed. (A bare overwrite kept ~one turn's usage for the
 * whole run; a bare `+=` would double-count the phase-1 stream deltas.)
 *
 * - `turnStart` is the totals snapshot taken before this turn's stream began.
 * - `current` is the totals right now (turnStart + this turn's stream deltas).
 * - When `finalUsage` reports nothing (the runner's zero-usage fallback after
 *   a finalMessage() failure), the stream-counted deltas stand.
 * - When `finalUsage` omits a cache field, the stream-accumulated value for
 *   it stands (the historical `?? total` fallback, re-based per turn).
 *
 * Returns the corrected totals plus this turn's stream-counted input/output
 * (for the >1% discrepancy warning).
 */
export function correctTurnUsageFromFinalMessage(
  turnStart: UsageTotals,
  current: UsageTotals,
  finalUsage: FinalMessageUsage,
): { totals: UsageTotals; streamedInput: number; streamedOutput: number } {
  const streamedInput = current.inputTokens - turnStart.inputTokens
  const streamedOutput = current.outputTokens - turnStart.outputTokens
  if (finalUsage.input_tokens <= 0 && finalUsage.output_tokens <= 0) {
    return { totals: current, streamedInput, streamedOutput }
  }
  return {
    totals: {
      inputTokens: turnStart.inputTokens + finalUsage.input_tokens,
      outputTokens: turnStart.outputTokens + finalUsage.output_tokens,
      cacheCreationTokens:
        finalUsage.cache_creation_input_tokens != null
          ? turnStart.cacheCreationTokens + finalUsage.cache_creation_input_tokens
          : current.cacheCreationTokens,
      cacheReadTokens:
        finalUsage.cache_read_input_tokens != null
          ? turnStart.cacheReadTokens + finalUsage.cache_read_input_tokens
          : current.cacheReadTokens,
    },
    streamedInput,
    streamedOutput,
  }
}
