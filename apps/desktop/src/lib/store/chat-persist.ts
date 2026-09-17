/**
 * Incremental streaming chat persist.
 *
 * The agent's reply is streamed token-by-token; the in-memory message is the
 * authoritative copy until the run finishes, at which point a final persist
 * supersedes everything. Between those moments a refresh / crash / quit can
 * lose the whole reply. This module is the DURABLE path: a debounced (~2s)
 * upsert of the in-flight assistant message (status='streaming') during SSE.
 *
 * Correctness properties of the persist layer (Codex fold):
 *
 *   1. monotonic seq — the ACTUAL stale-write guard. Each flush increments a
 *      sequence number; the DB upsert is gated on `seq IS NULL OR seq <=
 *      :incoming` so an older debounced write that lands AFTER a newer one
 *      (out-of-order on a slow IPC) is rejected and can never overwrite newer
 *      streamed content. Cross-run isolation also relies on the persister being
 *      created fresh per run and disposed in the stream `finally`, so a timer
 *      that fires after disposal is a no-op.
 *
 *   2. runId — persisted on the message row with every partial (migration
 *      0025), so orphan detection can tie a streaming row to its specific run:
 *      a row whose run_id is not among the live activeRunIds() is orphaned
 *      precisely, regardless of other in-flight runs (orphan-detection.ts).
 *      Legacy NULL-runId rows keep the conservative any-active-run grace. The
 *      seq guard above is still what prevents stale WRITES; runId classifies
 *      abandoned rows on load.
 *
 * Failure handling: an upsert that throws is logged and retried ONCE; a second
 * failure is swallowed. It NEVER throws into the caller (the SSE stream loop),
 * because losing one partial is recoverable (the next flush or the final
 * persist supersedes it) but aborting the stream is not.
 *
 * Pure / React-free so it is unit-testable in isolation. The component wires a
 * `persistFn` (the store's seq-aware persist) and a `getSnapshot` that reads
 * the current accumulated text/tools/segments/thinking from the stream loop.
 */

import { createLogger } from '../logger'

const log = createLogger('store.chat-persist')

/** ~2s debounce so a burst of tokens coalesces into one write. */
export const STREAMING_PERSIST_DEBOUNCE_MS = 2_000

/**
 * Hard ceiling between durable writes. The debounce RESETS on every schedule()
 * call, so under continuous streaming (tokens/tool-calls arriving faster than
 * the debounce) it would never elapse and NOTHING would be persisted until the
 * run ends — a mid-run refresh/crash then loses the entire in-flight reply. The
 * max-wait forces a flush once it's been this long since the last durable write,
 * so at most this much stream is ever at risk.
 */
export const STREAMING_PERSIST_MAX_WAIT_MS = 10_000

export interface StreamingSnapshot {
  content: string
  toolCalls?: unknown[]
  contentSegments?: unknown[]
  thinking?: string
}

/**
 * Persists a single message with a monotonic seq. Resolves to whether the
 * write was applied (false = rejected as stale, or the layer no-op'd). MUST
 * NOT throw for an "applied=false" outcome — only throw on a transport error,
 * which the persister catches + retries.
 */
export type SeqPersistFn = (args: {
  messageId: string
  runId: string | null
  seq: number
  status: 'streaming'
  snapshot: StreamingSnapshot
}) => Promise<{ applied: boolean }>

export interface StreamingPersisterOptions {
  messageId: string
  /** The live IPC runId; may be null at construction and set later via setRunId. */
  runId?: string | null
  persistFn: SeqPersistFn
  getSnapshot: () => StreamingSnapshot
  debounceMs?: number
  /** Force a flush if the debounce hasn't fired within this window (default 10s). */
  maxWaitMs?: number
  /** Injectable timers/clock for deterministic tests. */
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  nowFn?: () => number
}

/**
 * Drives debounced, seq-guarded incremental persistence for ONE streaming
 * message. Create at run start, call `schedule()` as tokens arrive, and
 * `dispose()` in the stream `finally` (the final persist is the component's
 * job and intentionally lives outside this module so it can carry usage/etc).
 */
export class StreamingChatPersister {
  private readonly messageId: string
  private runId: string | null
  private readonly persistFn: SeqPersistFn
  private readonly getSnapshot: () => StreamingSnapshot
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly nowFn: () => number

  private timer: ReturnType<typeof setTimeout> | null = null
  private lastFlushAt: number
  private seq = 0
  private disposed = false
  /** Serializes flushes so a slow write can't overlap the next one. */
  private inFlight: Promise<void> = Promise.resolve()

  constructor(opts: StreamingPersisterOptions) {
    this.messageId = opts.messageId
    this.runId = opts.runId ?? null
    this.persistFn = opts.persistFn
    this.getSnapshot = opts.getSnapshot
    this.debounceMs = opts.debounceMs ?? STREAMING_PERSIST_DEBOUNCE_MS
    this.maxWaitMs = opts.maxWaitMs ?? STREAMING_PERSIST_MAX_WAIT_MS
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout
    this.nowFn = opts.nowFn ?? Date.now
    this.lastFlushAt = this.nowFn()
  }

  /** Capture the live runId once the SSE run_start event arrives. */
  setRunId(runId: string | null): void {
    this.runId = runId
  }

  /** Debounced schedule — coalesces a burst of tokens into a single write, BUT
   *  force-flushes once maxWaitMs has elapsed since the last durable write so a
   *  continuous stream (debounce never idle) still persists periodically. */
  schedule(): void {
    if (this.disposed) return
    if (this.nowFn() - this.lastFlushAt >= this.maxWaitMs) {
      if (this.timer) {
        this.clearTimeoutFn(this.timer)
        this.timer = null
      }
      void this.flush()
      return
    }
    if (this.timer) this.clearTimeoutFn(this.timer)
    this.timer = this.setTimeoutFn(() => {
      this.timer = null
      void this.flush()
    }, this.debounceMs)
  }

  /**
   * Persist the current snapshot now with the next seq. Chained off `inFlight`
   * so concurrent flushes serialize (preserving seq order on the wire) and
   * never throws into the caller.
   */
  flush(): Promise<void> {
    if (this.disposed) return this.inFlight
    this.lastFlushAt = this.nowFn()
    const seq = ++this.seq
    const snapshot = this.getSnapshot()
    const runId = this.runId
    const messageId = this.messageId

    const run = async () => {
      const attempt = () => this.persistFn({ messageId, runId, seq, status: 'streaming', snapshot })
      try {
        await attempt()
      } catch (err) {
        // Retry ONCE — a transient DB/IPC hiccup must not lose the partial, but
        // it must also never abort the stream loop. Swallow a second failure.
        log.warn('streaming persist failed, retrying once', { extra: { messageId, seq }, error: err })
        try {
          await new Promise((r) => this.setTimeoutFn(r, 250))
          await attempt()
        } catch (retryErr) {
          log.error('streaming persist retry failed; dropping partial', {
            extra: { messageId, seq },
            error: retryErr,
          })
        }
      }
    }

    this.inFlight = this.inFlight.then(run, run)
    return this.inFlight
  }

  /**
   * Cancel any pending debounce and stop accepting new work. Returns the
   * in-flight write so the caller can await quiescence before the final
   * persist. Idempotent.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) {
      this.clearTimeoutFn(this.timer)
      this.timer = null
    }
    await this.inFlight.catch(() => {})
  }

  /** Current seq — exposed for tests/diagnostics. */
  get currentSeq(): number {
    return this.seq
  }
}
