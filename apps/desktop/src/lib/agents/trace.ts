/**
 * Lightweight agent lifecycle tracer (debug-only, env-gated).
 *
 * Set `DREAMBYTE_TRACE=1` to write a structured JSONL trace of the in-app agent
 * run — every tool call, scene create/write/delete, HTML regenerate + verify,
 * brief extraction, and scene-HTML serve/404 — to a single file so a human (or
 * Claude Code) can SEE exactly what a live run did, in order. Off by default and
 * zero-cost when unset (a single env check, no file handles).
 *
 * File: `DREAMBYTE_TRACE_FILE` or `~/.dreambyte/agent-trace.jsonl`.
 * Tail it with: `tail -f ~/.dreambyte/agent-trace.jsonl`
 *
 * Runs in the Electron MAIN process (executeTool / regenerateHTML / agent-runner
 * / the dreambyte:// protocol handler are all main-side), so node `fs` is fine.
 * Append-only + best-effort: a trace write must NEVER throw into the agent path.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let _resolved: string | null | undefined
let _runId = ''

function traceFile(): string | null {
  if (_resolved !== undefined) return _resolved
  if (!process.env.DREAMBYTE_TRACE) {
    _resolved = null
    return null
  }
  const f = process.env.DREAMBYTE_TRACE_FILE || path.join(os.homedir(), '.dreambyte', 'agent-trace.jsonl')
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
  } catch {
    /* best-effort */
  }
  _resolved = f
  return f
}

/** Cheap truthy check callers can gate expensive arg-shaping on. */
export function traceEnabled(): boolean {
  return traceFile() !== null
}

/** Tag subsequent events with a run id (best-effort correlation across tools). */
export function traceSetRun(runId: string): void {
  _runId = runId || ''
}

/**
 * Append one trace event. `type` is a dotted lifecycle tag, e.g.
 * 'run.start' | 'brief' | 'tool.call' | 'tool.done' | 'html' | 'scene.create' |
 * 'scene.delete' | 'serve'. `data` is shaped by the caller (keep it small).
 */
export function trace(type: string, data?: Record<string, unknown>): void {
  const f = traceFile()
  if (!f) return
  try {
    const line = JSON.stringify({ ts: Date.now(), run: _runId || undefined, type, ...data }) + '\n'
    fs.appendFileSync(f, line)
  } catch {
    /* never throw into the agent path */
  }
}

/** Truncate a string for the trace so a 14KB scene body doesn't bloat the log. */
export function tclip(s: unknown, n = 120): string {
  const str = typeof s === 'string' ? s : String(s ?? '')
  return str.length > n ? str.slice(0, n) + `…(+${str.length - n})` : str
}
