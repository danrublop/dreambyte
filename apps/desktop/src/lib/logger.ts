/**
 * Shared structured logger for Dreambyte.
 *
 * Goals:
 *   1. Replace bare `console.log` scattered across src/lib/ and src/electron/ so log
 *      level, namespace, and context are consistent across the codebase.
 *   2. Gate verbose logs behind `DEBUG` so packaged builds stay quiet unless
 *      the user opts in (macOS Console.app / stderr piped to file).
 *   3. Expose a pluggable `onError` transport so a Sentry / Axiom / Highlight
 *      integration drops in by calling `setErrorTransport(fn)` once at boot —
 *      no hunting down every error call site later.
 *
 * Non-goals for v1:
 *   - Ring buffer / in-app log viewer (belongs in a diagnostics panel later).
 *   - PII scrubbing (prompt snippets, paths). Add when we wire the transport.
 *
 * The `AgentLogger` in `src/lib/agents/logger.ts` remains the right tool for
 * agent-run-scoped traces (it persists a structured trace to the DB). This
 * logger is for everything else: export errors, IPC failures, route handlers,
 * long-lived services.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  /** Arbitrary structured data attached to the log entry. */
  extra?: Record<string, unknown>
  /** Original thrown value; used to derive stack/cause for the error transport. */
  error?: unknown
}

export interface ErrorTransport {
  (namespace: string, message: string, ctx: LogContext): void
}

type DebugGate = () => boolean

const defaultDebugGate: DebugGate = () => {
  // Node/Electron: honour `DEBUG=dreambyte` (matches the `debug` package idiom).
  if (typeof process !== 'undefined' && process.env && process.env.DEBUG) {
    return /dreambyte|\*/.test(process.env.DEBUG)
  }
  // Browser: `localStorage.debug = '1'` flips it on at runtime without reload.
  if (typeof window !== 'undefined') {
    try {
      return window.localStorage?.getItem('debug') === '1'
    } catch {
      return false
    }
  }
  return false
}

let debugGate: DebugGate = defaultDebugGate
let errorTransport: ErrorTransport | null = null

/** Swap the debug gate (tests, or feature flags wired differently). */
export function setDebugGate(gate: DebugGate): void {
  debugGate = gate
}

/** Install a transport that gets called for every `error()` / `warn()` event.
 * Call once at app boot — e.g. from `src/electron/main.ts` or `src/app/layout.tsx`.
 * Subsequent calls replace the transport. */
export function setErrorTransport(transport: ErrorTransport | null): void {
  errorTransport = transport
}

function emitConsole(level: LogLevel, namespace: string, message: string, ctx?: LogContext): void {
  const prefix = `[${namespace}]`
  const payload: unknown[] = [prefix, message]
  if (ctx?.extra) payload.push(ctx.extra)
  if (ctx?.error) payload.push(ctx.error)
  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  target.apply(console, payload)
}

export interface Logger {
  readonly namespace: string
  debug(message: string, ctx?: LogContext): void
  info(message: string, ctx?: LogContext): void
  warn(message: string, ctx?: LogContext): void
  error(message: string, ctx?: LogContext): void
  /** Narrow a child logger so sub-systems can tag without restating namespace. */
  child(suffix: string): Logger
}

function build(namespace: string): Logger {
  return {
    namespace,
    debug(message, ctx) {
      if (!debugGate()) return
      emitConsole('debug', namespace, message, ctx)
    },
    info(message, ctx) {
      emitConsole('info', namespace, message, ctx)
    },
    warn(message, ctx) {
      emitConsole('warn', namespace, message, ctx)
      if (errorTransport) {
        try {
          errorTransport(namespace, message, ctx ?? {})
        } catch {
          /* transport must never crash the caller */
        }
      }
    },
    error(message, ctx) {
      emitConsole('error', namespace, message, ctx)
      if (errorTransport) {
        try {
          errorTransport(namespace, message, ctx ?? {})
        } catch {
          /* transport must never crash the caller */
        }
      }
    },
    child(suffix) {
      return build(`${namespace}:${suffix}`)
    },
  }
}

/** Create a namespaced logger. Prefer short, file- or subsystem-aligned names:
 *   const log = createLogger('export')
 *   const log = createLogger('agent.runner')
 */
export function createLogger(namespace: string): Logger {
  return build(namespace)
}
