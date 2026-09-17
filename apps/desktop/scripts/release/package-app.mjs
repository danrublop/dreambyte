#!/usr/bin/env node
// Packaging wrapper so the project's 4-part version (a.b.c.d) can be built.
//
// electron-builder (26.x) requires package.json `version` to be valid SEMVER
// (exactly three numeric segments) and validates it while *reading*
// package.json — before any --config / extraMetadata override applies. So a
// 4-part version like "0.7.2.3" fails with `Invalid version` and no CLI flag
// can rescue it. (This silently broke packaging the moment the project moved
// off 3-part versions; the last buildable version was 0.1.0.)
//
// Fix: for the duration of the electron-builder run only, rewrite `version`
// to its 3-part semver prefix (→ CFBundleShortVersionString, the user-facing
// version) and carry the FULL original string as buildVersion (→ CFBundleVersion,
// the build number). The original package.json is ALWAYS restored in `finally`,
// so the 4-part scheme stays the source of truth everywhere else (package.json,
// CHANGELOG, in-app About, etc.).
//
// Usage (from the dist:* npm scripts): node scripts/release/package-app.mjs <electron-builder args...>
//   node scripts/release/package-app.mjs --mac --publish never

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const pkgPath = path.resolve('package.json')
const original = fs.readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(original)
const full = String(pkg.version)

// Accepts a.b.c or a.b.c.d (this project's plain numeric scheme). Prerelease /
// build-metadata semvers (-beta.1, +ci.5) are intentionally NOT handled — the
// repo uses numeric versions only; if that ever changes, extend this regex.
const m = full.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/)
if (!m) {
  console.error(
    `package-app: version "${full}" is not of the form a.b.c or a.b.c.d — cannot normalize for electron-builder.`,
  )
  process.exit(1)
}
const semver = `${m[1]}.${m[2]}.${m[3]}`
const hasFourth = m[4] !== undefined
// CFBundleVersion accepts dot-separated integers; keep the full 4-part build number when present.
const buildVersion = hasFourth ? full : semver

// Resolve the local electron-builder binary (hoisted to the workspace root).
const ebBin = path.resolve('../../node_modules/.bin/electron-builder')
const ebCmd = fs.existsSync(ebBin) ? ebBin : 'electron-builder'

// Restore the original package.json exactly once, on normal exit OR on an
// interrupt signal. A try/finally alone does NOT cover SIGINT/SIGTERM (Ctrl-C
// kills the process group, including this parent, before `finally` runs), which
// would otherwise leave package.json stranded at the truncated 3-part version.
let restored = false
function restore() {
  if (restored) return
  restored = true
  fs.writeFileSync(pkgPath, original)
  if (semver !== full) console.log(`package-app: restored package.json version to ${full}`)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restore()
    process.exit(130)
  })
}

let code = 1
try {
  if (semver !== full) {
    // Surgical string replace (not JSON round-trip) so formatting/key order is
    // untouched. The FIRST "version": match must be the top-level package
    // version — guard against a future earlier nested "version" key by checking
    // the matched value equals the JSON-parsed top-level version before writing.
    const verMatch = original.match(/"version"\s*:\s*"([^"]+)"/)
    if (!verMatch || verMatch[1] !== full) {
      console.error(
        `package-app: the first "version" in package.json (${verMatch ? `"${verMatch[1]}"` : 'none'}) is not the top-level package version "${full}" — refusing to patch the wrong field.`,
      )
      process.exit(1)
    }
    const patched = original.replace(/("version"\s*:\s*")[^"]+(")/, `$1${semver}$2`)
    fs.writeFileSync(pkgPath, patched)
    console.log(
      `package-app: version ${full} → ${semver} (CFBundleShortVersionString); CFBundleVersion=${buildVersion} for electron-builder`,
    )
  }

  // Electron is hoisted to the workspace root, where electron-builder (which only looks in
  // apps/desktop/node_modules) can't infer it: pass the installed version explicitly.
  const electronPkgPath = createRequire(import.meta.url).resolve('electron/package.json')
  const electronVersion = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8')).version
  const args = [
    ...process.argv.slice(2),
    `-c.buildVersion=${buildVersion}`,
    `-c.electronVersion=${electronVersion}`,
  ]
  const r = spawnSync(ebCmd, args, { stdio: 'inherit' })
  if (r.error) {
    // spawn itself failed (e.g. electron-builder not found) — distinct from a build failure.
    console.error(`package-app: failed to run electron-builder: ${r.error.message}`)
    code = 1
  } else if (r.signal) {
    console.error(`package-app: electron-builder terminated by signal ${r.signal}`)
    code = 1
  } else {
    code = r.status ?? 1
  }
} finally {
  restore()
}

process.exit(code)
