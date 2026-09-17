#!/usr/bin/env node
// Upload sourcemaps to Sentry for the current build, so crash stack traces from
// the packaged app de-minify to real file:line. (The JS analogue of
// uploading dSYMs for a native app.)
//
// No-ops cleanly (exit 0) when the upload credentials are absent, so it can sit
// unconditionally in the dist:* chain without breaking unsigned/local builds:
//   - SENTRY_AUTH_TOKEN   (needs project:releases scope)
//   - SENTRY_ORG          (org slug)
//   - SENTRY_PROJECT      (project slug)
// Optionally DREAMBYTE_SENTRY_DSN — only used to confirm crash reporting is even
// wired; not required for upload.
//
// The `release` here MUST match src/lib/crash-telemetry.ts:releaseName():
//   dreambyte@<short>+<build>   (short = first 3 segments, build = the rest)
//
// Usage: node scripts/release/upload-sentry-symbols.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT } = process.env
if (!SENTRY_AUTH_TOKEN || !SENTRY_ORG || !SENTRY_PROJECT) {
  console.log('==> Sentry creds not set (SENTRY_AUTH_TOKEN/SENTRY_ORG/SENTRY_PROJECT) — skipping symbol upload')
  process.exit(0)
}

// Derive the release id from package.json version, matching releaseName().
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const parts = String(pkg.version).split('.')
const release =
  parts.length >= 4 ? `dreambyte@${parts.slice(0, 3).join('.')}+${parts.slice(3).join('.')}` : `dreambyte@${pkg.version}`

const distElectron = path.join(ROOT, 'dist-electron')
if (!fs.existsSync(distElectron)) {
  console.log('==> dist-electron/ not found — nothing to upload (skipping)')
  process.exit(0)
}

// Resolve the sentry-cli binary (local install preferred; fall back to npx).
const localBin = path.join(ROOT, '..', '..', 'node_modules', '.bin', 'sentry-cli')
const useLocal = fs.existsSync(localBin)

function sentry(args) {
  const cmd = useLocal ? localBin : 'npx'
  const fullArgs = useLocal ? args : ['--yes', '@sentry/cli', ...args]
  const r = spawnSync(cmd, fullArgs, { cwd: ROOT, stdio: 'inherit' })
  return r.status ?? 1
}

console.log(`==> Uploading sourcemaps to Sentry (release ${release})`)
// Create the release, attach the sourcemaps, finalize. Failures are warned but
// never fail the dist build — a missing symbol upload should not block shipping.
let code = sentry(['releases', 'new', release])
if (code !== 0) {
  console.warn('!! sentry-cli releases new failed — continuing without symbol upload')
  process.exit(0)
}
code = sentry(['releases', 'files', release, 'upload-sourcemaps', distElectron, '--rewrite'])
if (code !== 0) {
  console.warn('!! sentry-cli upload-sourcemaps failed — continuing')
  process.exit(0)
}
sentry(['releases', 'finalize', release])
console.log('==> Sentry symbol upload complete')
