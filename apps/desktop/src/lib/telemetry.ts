/**
 * Dreambyte telemetry — anonymous, opt-out, fire-and-forget.
 *
 * Goal: enough product signal to know what features get used, what errors
 * users hit, and where the funnel breaks down. Nothing more. Specifically
 * NOT collected:
 *   - Project / scene / conversation names or content
 *   - Prompt text, generated code, scene HTML
 *   - File paths, file contents, environment variables
 *   - API keys (provider keys never leave the user's machine)
 *   - User email, name, or any account identity
 *
 * What IS collected per event:
 *   - Event name (e.g. `app_launched`, `scene_generated`)
 *   - A flat properties bag of small primitives (counts, durations,
 *     enum values, success/failure flags) — caller's responsibility to
 *     keep these PII-free
 *   - An anonymous device ID (UUID, generated and stored locally on
 *     first run; never derived from user identity)
 *   - App version + platform (mac/win/linux + arch)
 *
 * Transport: fire-and-forget POST. Events queue in memory and flush on a
 * 30s timer or on app quit, whichever first. Drops the queue silently if
 * the network is unreachable — telemetry must never block the app.
 *
 * Opt-out: three layers, any of which disables sending.
 *   1. Env var `DREAMBYTE_TELEMETRY_DISABLED=1`
 *   2. File at `<userData>/.telemetry-disabled` (written by the
 *      `dreambyte:settings.setTelemetry` IPC handler; there is no Settings UI toggle)
 *   3. No telemetry endpoint configured (`DREAMBYTE_TELEMETRY_URL` unset — the default)
 *
 * Provider-agnostic: there is no built-in endpoint. Set `DREAMBYTE_TELEMETRY_URL`
 * + `DREAMBYTE_TELEMETRY_API_KEY` (PostHog-shaped payload, e.g.
 * https://us.i.posthog.com/i/v0/e/ with a project key). See docs/TELEMETRY.md.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger'
import type { AgentRunEvent } from './agent-run-event'

const log = createLogger('telemetry')

const FLUSH_INTERVAL_MS = 30_000
const MAX_QUEUE_SIZE = 200 // beyond this, drop oldest events
const MAX_PAYLOAD_PROPERTY_BYTES = 4_096 // per property; truncate longer values

interface QueuedEvent {
  event: string
  properties: Record<string, string | number | boolean | null>
  timestamp: string
}

let _queue: QueuedEvent[] = []
let _flushTimer: ReturnType<typeof setInterval> | null = null
let _deviceId: string | null = null
let _initialized = false

interface TelemetryConfig {
  endpoint: string | null
  apiKey: string | null
  disabled: boolean
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  userDataDir: string | null
}

let _config: TelemetryConfig | null = null

/**
 * Resolve config once. Reads env + opt-out file here rather than stat()ing on
 * every track(); setTelemetryEnabled() updates the cached `disabled` flag so
 * runtime toggles take effect immediately.
 */
function getConfig(): TelemetryConfig {
  if (_config) return _config
  const userDataDir = process.env.DREAMBYTE_USER_DATA_DIR ?? null
  const optOutFile = userDataDir ? path.join(userDataDir, '.telemetry-disabled') : null
  const disabled =
    process.env.DREAMBYTE_TELEMETRY_DISABLED === '1' ||
    process.env.DREAMBYTE_TELEMETRY_DISABLED === 'true' ||
    (optOutFile !== null && fs.existsSync(optOutFile))

  _config = {
    endpoint: process.env.DREAMBYTE_TELEMETRY_URL ?? null,
    apiKey: process.env.DREAMBYTE_TELEMETRY_API_KEY ?? null,
    disabled,
    appVersion: process.env.DREAMBYTE_APP_VERSION ?? '0.0.0',
    platform: process.platform,
    arch: process.arch,
    userDataDir,
  }
  return _config
}

/**
 * Anonymous device ID: a UUID generated on first run and persisted at
 * `<userData>/device-id`. Not tied to any user identity; not derived from
 * hardware ID; not preserved across reinstalls (uninstalling the app and
 * deleting userData yields a fresh ID).
 */
function getDeviceId(): string {
  if (_deviceId) return _deviceId
  const config = getConfig()
  if (!config.userDataDir) {
    // Fallback for non-Electron contexts — a process-scoped UUID. Lasts
    // until the process exits. Better than nothing but not stable.
    _deviceId = crypto.randomUUID()
    return _deviceId
  }
  const idFile = path.join(config.userDataDir, 'device-id')
  try {
    if (fs.existsSync(idFile)) {
      const existing = fs.readFileSync(idFile, 'utf8').trim()
      if (existing.length === 36) {
        _deviceId = existing
        return _deviceId
      }
    }
  } catch (e) {
    log.warn('failed to read device id', { error: e })
  }
  const fresh = crypto.randomUUID()
  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true })
    fs.writeFileSync(idFile, fresh, 'utf8')
  } catch (e) {
    // If we can't persist, the ID is process-scoped — telemetry still works
    // for this run but won't correlate with future runs.
    log.warn('failed to persist device id', { error: e })
  }
  _deviceId = fresh
  return _deviceId
}

/**
 * Truncate a property value to keep payloads small. Long strings (e.g.
 * accidentally including a stack trace) get cut off so we don't blow the
 * payload budget or accidentally exfiltrate large blobs.
 */
function sanitizeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length > MAX_PAYLOAD_PROPERTY_BYTES ? value.slice(0, MAX_PAYLOAD_PROPERTY_BYTES) + '…' : value
  }
  // Objects, arrays, functions: stringify defensively. The caller should
  // pre-flatten these — anything bigger than the truncation budget is
  // almost certainly the wrong thing to send.
  try {
    const json = JSON.stringify(value)
    return json.length > MAX_PAYLOAD_PROPERTY_BYTES ? json.slice(0, MAX_PAYLOAD_PROPERTY_BYTES) + '…' : json
  } catch {
    return null
  }
}

/**
 * Lazily start the flush timer on the first track() call. Avoids holding
 * an event loop reference open in tooling that imports this file but never
 * sends an event.
 */
function ensureInitialized(): void {
  if (_initialized) return
  _initialized = true
  const config = getConfig()
  if (config.disabled || !config.endpoint) return
  _flushTimer = setInterval(() => {
    void flush()
  }, FLUSH_INTERVAL_MS)
  // Don't keep the process alive just for telemetry.
  if (typeof _flushTimer.unref === 'function') _flushTimer.unref()
}

/**
 * Queue an event. Returns immediately. Caller never awaits, never sees errors.
 * Properties bag must be flat primitives — see top-of-file PII contract.
 */
export function track(event: string, properties: Record<string, unknown> = {}): void {
  const config = getConfig()
  if (config.disabled) return
  ensureInitialized()
  if (!config.endpoint) return

  const sanitized: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(properties)) {
    sanitized[k] = sanitizeValue(v)
  }
  // Always-attached context. Counted toward the property budget but tiny.
  sanitized.app_version = config.appVersion
  sanitized.platform = config.platform
  sanitized.arch = config.arch

  _queue.push({
    event,
    properties: sanitized,
    timestamp: new Date().toISOString(),
  })

  if (_queue.length > MAX_QUEUE_SIZE) {
    // Drop oldest events. A backed-up queue means the network is broken;
    // shedding the past keeps memory bounded.
    _queue = _queue.slice(-MAX_QUEUE_SIZE)
  }
}

/**
 * Typed convenience wrapper for the `agent_run_completed` event. Keeps the
 * event name and shape in one place so producers (run-analytics) get a typed
 * call site instead of hand-rolling the properties bag. The fields are already
 * bucketed/enum (see AgentRunEvent), so this is PII-safe by construction.
 */
export function trackAgentRun(event: AgentRunEvent): void {
  track('agent_run_completed', { ...event })
}

/**
 * Flush the queue immediately. Called by the timer and by `shutdown()`.
 * Best-effort — drops the batch on any error, logs nothing-fatal.
 */
export async function flush(): Promise<void> {
  const config = getConfig()
  if (config.disabled || !config.endpoint || _queue.length === 0) return

  const batch = _queue
  _queue = []
  const deviceId = getDeviceId()

  // PostHog batch capture format. If a different provider is configured
  // (DREAMBYTE_TELEMETRY_URL points elsewhere), the same JSON shape is sent —
  // most analytics endpoints accept a similar `{api_key, batch}` envelope.
  const body = JSON.stringify({
    api_key: config.apiKey,
    batch: batch.map((evt) => ({
      event: evt.event,
      distinct_id: deviceId,
      properties: evt.properties,
      timestamp: evt.timestamp,
    })),
  })

  try {
    const res = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // 5s budget per flush. Telemetry must not stall the app on a slow
      // network; we'd rather drop the batch and try again next tick.
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      log.warn('telemetry flush non-2xx', { extra: { status: res.status, batchSize: batch.length } })
    }
  } catch (e) {
    // Network error / timeout / DNS failure — drop the batch and move on.
    log.warn('telemetry flush failed', { extra: { batchSize: batch.length }, error: e })
  }
}

/**
 * Stop the flush timer and send any pending events. Called from
 * `src/electron/main.ts` on `before-quit`.
 */
export async function shutdown(): Promise<void> {
  if (_flushTimer) {
    clearInterval(_flushTimer)
    _flushTimer = null
  }
  await flush()
}

/**
 * Toggle telemetry on/off at runtime by writing/removing the opt-out marker
 * file AND mutating the in-memory config so subsequent track() calls honor
 * the toggle immediately (otherwise events would keep flowing until the next
 * launch after an opt-out). The env-var override (`DREAMBYTE_TELEMETRY_DISABLED=1`) still wins:
 * the user can't enable telemetry mid-session if it was force-disabled at boot.
 */
export function setTelemetryEnabled(enabled: boolean): void {
  const config = getConfig()
  if (!config.userDataDir) return
  const optOutFile = path.join(config.userDataDir, '.telemetry-disabled')
  try {
    if (enabled) {
      if (fs.existsSync(optOutFile)) fs.unlinkSync(optOutFile)
    } else {
      fs.writeFileSync(optOutFile, new Date().toISOString())
    }
  } catch (e) {
    log.warn('setTelemetryEnabled failed', { error: e })
  }
  // Update the in-memory cache so the change takes effect on the very next
  // track() call. The env-var path stays sticky — if telemetry was force-off
  // via env at boot, no UI toggle should re-enable it without a restart.
  const envForcedOff =
    process.env.DREAMBYTE_TELEMETRY_DISABLED === '1' || process.env.DREAMBYTE_TELEMETRY_DISABLED === 'true'
  config.disabled = envForcedOff || !enabled
}

/** Returns the current effective opt-in state. Reads the disk marker fresh. */
export function isTelemetryEnabled(): boolean {
  const config = getConfig()
  if (config.disabled) return false
  if (!config.userDataDir) return true
  const optOutFile = path.join(config.userDataDir, '.telemetry-disabled')
  return !fs.existsSync(optOutFile)
}
