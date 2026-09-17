/**
 * Per-event inactivity timeout for provider streams, shared by every adapter.
 *
 * If no event arrives within `timeoutMs` the generator throws so callers don't
 * hang forever on a dropped connection. Mirrors (and replaces) the per-adapter
 * copies; the runner has its own equivalent for the legacy provider branches.
 */
export const STREAM_INACTIVITY_TIMEOUT_MS = 90_000 // 90 seconds

export async function* withInactivityTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  label: string,
): AsyncGenerator<T> {
  let timer: ReturnType<typeof setTimeout>
  let rejectTimeout: ((err: Error) => void) | null = null

  const resetTimer = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      rejectTimeout?.(new Error(`Stream inactivity timeout after ${timeoutMs}ms: ${label}`))
    }, timeoutMs)
  }

  try {
    const iterator = iterable[Symbol.asyncIterator]()
    resetTimer()
    while (true) {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          rejectTimeout = reject
        }),
      ])
      if (result.done) break
      resetTimer()
      yield result.value
    }
  } finally {
    clearTimeout(timer!)
    rejectTimeout = null
  }
}
