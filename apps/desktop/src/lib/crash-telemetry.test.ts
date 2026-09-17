// @vitest-environment node
//
// Tests for the DSN-gated / opt-out no-op paths of src/lib/crash-telemetry.ts.
//
// We deliberately exercise ONLY the branches that never load @sentry/electron
// or open a transport:
//   - no DREAMBYTE_SENTRY_DSN  → inert no-op
//   - DSN set BUT telemetry opted out (DREAMBYTE_TELEMETRY_DISABLED=1) → returns
//     before the SDK is touched
//   - shutdown when never started → no-op
// The DSN-set-AND-opted-in path is intentionally not tested here: it would call
// the real Sentry.init() and open a socket (brittle). It is environment-gated by
// design — initCrashReporter() is documented to never throw, which these cover.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initCrashReporter, isCrashReporterEnabled, shutdownCrashReporter } from './crash-telemetry'

const SAVED = {
  dsn: process.env.DREAMBYTE_SENTRY_DSN,
  disabled: process.env.DREAMBYTE_TELEMETRY_DISABLED,
  // isDisabled() also reads DREAMBYTE_USER_DATA_DIR for the file-marker opt-out;
  // save/restore it too so these tests are deterministic regardless of host env.
  userDataDir: process.env.DREAMBYTE_USER_DATA_DIR,
}

beforeEach(() => {
  delete process.env.DREAMBYTE_SENTRY_DSN
  delete process.env.DREAMBYTE_TELEMETRY_DISABLED
  delete process.env.DREAMBYTE_USER_DATA_DIR
})

afterEach(() => {
  if (SAVED.dsn === undefined) delete process.env.DREAMBYTE_SENTRY_DSN
  else process.env.DREAMBYTE_SENTRY_DSN = SAVED.dsn
  if (SAVED.disabled === undefined) delete process.env.DREAMBYTE_TELEMETRY_DISABLED
  else process.env.DREAMBYTE_TELEMETRY_DISABLED = SAVED.disabled
  if (SAVED.userDataDir === undefined) delete process.env.DREAMBYTE_USER_DATA_DIR
  else process.env.DREAMBYTE_USER_DATA_DIR = SAVED.userDataDir
})

describe('initCrashReporter — no-op paths', () => {
  it('is a no-op (and does not throw) when no DSN is configured', async () => {
    await expect(initCrashReporter()).resolves.toBeUndefined()
    expect(isCrashReporterEnabled()).toBe(false)
  })

  it('treats a whitespace-only DSN as unset (inert)', async () => {
    process.env.DREAMBYTE_SENTRY_DSN = '   '
    await expect(initCrashReporter()).resolves.toBeUndefined()
    expect(isCrashReporterEnabled()).toBe(false)
  })

  it('does not initialize when telemetry is opted out, even with a DSN set', async () => {
    process.env.DREAMBYTE_SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0'
    process.env.DREAMBYTE_TELEMETRY_DISABLED = '1'
    await expect(initCrashReporter()).resolves.toBeUndefined()
    // Opt-out short-circuits before the SDK loads → reporter stays disabled.
    expect(isCrashReporterEnabled()).toBe(false)
  })

  it('honors the file-marker opt-out (<userData>/.telemetry-disabled), the real Settings-UI toggle', async () => {
    // This is what the in-app opt-out actually writes — exercise it, not just the env var.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreambyte-telemetry-'))
    try {
      fs.writeFileSync(path.join(dir, '.telemetry-disabled'), '')
      process.env.DREAMBYTE_SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0'
      process.env.DREAMBYTE_USER_DATA_DIR = dir
      await expect(initCrashReporter()).resolves.toBeUndefined()
      expect(isCrashReporterEnabled()).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('shutdownCrashReporter', () => {
  it('is a no-op (and does not throw) when the reporter was never started', async () => {
    await expect(shutdownCrashReporter()).resolves.toBeUndefined()
    expect(isCrashReporterEnabled()).toBe(false)
  })
})
