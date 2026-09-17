/**
 * Dreambyte crash + error telemetry — opt-out, PII-free, build-id keyed.
 *
 * This is the error/crash counterpart to `src/lib/telemetry.ts` (which is product
 * analytics). Policy:
 *   - opt-out, on by default
 *   - `sendDefaultPii: false` — no usernames, emails, IPs, machine names
 *   - 10% transaction trace sampling
 *   - `release` keyed to `dreambyte@<version>+<buildNumber>` so a stack trace
 *     maps to the exact published build (and uploaded symbols)
 *   - a clean no-op when the DSN is unset (no DSN → nothing is initialized)
 *
 * Transport: `@sentry/electron` (main process). It is imported lazily so that
 *   (a) the dependency is optional — if it's not installed, init no-ops, and
 *   (b) importing this file in tooling/tests never pulls the SDK or opens a
 *       socket. Nothing here ever throws into the caller.
 *
 * Opt-out: shares the exact opt-out signals used by `src/lib/telemetry.ts`, so one
 * UI toggle / env var disables BOTH product analytics and crash reporting.
 *   1. Env `DREAMBYTE_TELEMETRY_DISABLED=1`
 *   2. File `<userData>/.telemetry-disabled` (the Settings toggle writes this)
 *   3. No DSN configured (`DREAMBYTE_SENTRY_DSN` unset) → inert
 *
 * What is NEVER sent: project/scene/conversation content, prompt text, generated
 * code, file paths/contents, API keys, account identity. `beforeSend` strips the
 * server name and user as a belt-and-suspenders guard on top of sendDefaultPii.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger'

const log = createLogger('crash-telemetry')

let _started = false

/**
 * Minimal structural type for the slice of `@sentry/electron/main` we use. We
 * deliberately do NOT `import type` the real package: it's an optional runtime
 * dependency, and a static type import would make the build fail wherever it
 * isn't installed. The dynamic import below is resolved at runtime only.
 */
interface SentryMainLike {
  init(options: Record<string, unknown>): void
  flush(timeout?: number): Promise<boolean>
}

/**
 * Runtime-only dynamic import that TypeScript does not try to resolve at
 * compile time (the specifier is built from a variable). Returns null if the
 * package isn't installed.
 */
async function loadSentry(): Promise<SentryMainLike | null> {
  try {
    const specifier = '@sentry/electron' + '/main'
    const mod = (await import(/* webpackIgnore: true */ specifier)) as unknown as SentryMainLike
    return mod ?? null
  } catch {
    return null
  }
}

/** Resolve whether telemetry is disabled, reusing src/lib/telemetry's signals. */
function isDisabled(): boolean {
  if (process.env.DREAMBYTE_TELEMETRY_DISABLED === '1' || process.env.DREAMBYTE_TELEMETRY_DISABLED === 'true') {
    return true
  }
  const userDataDir = process.env.DREAMBYTE_USER_DATA_DIR
  if (userDataDir) {
    try {
      if (fs.existsSync(path.join(userDataDir, '.telemetry-disabled'))) return true
    } catch {
      // If we can't stat the marker, fail open (telemetry stays enabled) — the
      // same posture src/lib/telemetry takes; a missing marker means opted-in.
    }
  }
  return false
}

/**
 * The `release` identifier — `dreambyte@<version>+<build>`, the
 * Sentry `name@version+build` convention. `DREAMBYTE_APP_VERSION` is the full 4-segment
 * version (set in src/electron/main.ts from `app.getVersion()`); the 4th segment is
 * the monotonic build number, so the whole string already encodes both.
 */
function releaseName(): string {
  const version = process.env.DREAMBYTE_APP_VERSION ?? '0.0.0'
  const parts = version.split('.')
  if (parts.length >= 4) {
    const short = parts.slice(0, 3).join('.')
    const build = parts.slice(3).join('.')
    return `dreambyte@${short}+${build}`
  }
  return `dreambyte@${version}`
}

/**
 * Initialize crash reporting. Call once, early in the Electron main process
 * (before windows exist) so boot-time crashes are captured. No-ops when:
 *   - telemetry is opted out, or
 *   - `DREAMBYTE_SENTRY_DSN` is unset, or
 *   - `@sentry/electron` is not installed.
 * Never throws.
 */
export async function initCrashReporter(): Promise<void> {
  if (_started) return
  const dsn = process.env.DREAMBYTE_SENTRY_DSN?.trim()
  if (!dsn) {
    log.debug('no DREAMBYTE_SENTRY_DSN — crash reporting is a no-op')
    return
  }
  if (isDisabled()) {
    log.debug('telemetry opted out — crash reporting disabled')
    return
  }

  const Sentry = await loadSentry()
  if (!Sentry) {
    log.warn('@sentry/electron not installed — crash reporting unavailable')
    return
  }

  try {
    Sentry.init({
      dsn,
      sendDefaultPii: false,
      environment: process.env.NODE_ENV === 'development' ? 'development' : 'production',
      release: releaseName(),
      tracesSampleRate: 0.1,
      // Belt-and-suspenders PII scrub: never attach the machine name or user.
      beforeSend(event: Record<string, unknown>) {
        delete event.server_name
        event.user = undefined
        return event
      },
    })
    _started = true
    log.info('crash reporting initialized', { extra: { release: releaseName() } })
  } catch (err) {
    log.warn('Sentry.init failed — continuing without crash reporting', { error: err })
  }
}

/** Whether the reporter is live (DSN set, opted in, SDK loaded). */
export function isCrashReporterEnabled(): boolean {
  return _started
}

/**
 * Flush pending crash events on shutdown. Best-effort, bounded, never throws.
 * Mirrors the `telemetryShutdown()` flush in src/electron/main.ts before-quit.
 */
export async function shutdownCrashReporter(): Promise<void> {
  if (!_started) return
  try {
    const Sentry = await loadSentry()
    if (Sentry) await Sentry.flush(2000)
  } catch (err) {
    log.warn('crash-reporter flush failed', { error: err })
  }
}
