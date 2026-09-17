#!/usr/bin/env node
// One-command release orchestrator. Turns "cut a release" into a single human action:
//
//   node scripts/release/release.mjs 0.7.17.0
//
// Stages (each bails out BEFORE anything public-visible on a failed check):
//   1. Preflight  — clean tree / on main or release/* / in sync with origin /
//                   target tag free locally + on origin
//   2. Build guard — the 4th version segment is the monotonic build number
//                   (→ CFBundleVersion → updater version-compare). Refuse if the
//                   new build is not strictly greater than the last published one.
//   3. Bump       — write package.json version to a.b.c.d
//   4. Notes      — `## What's new` + git log since the last tag; prepend to CHANGELOG
//   5. Build      — npm run dist:mac (or dist:win); signs+notarizes when certs in env
//   6. Commit+tag — commit bump+changelog, tag v<version>, push branch + tag
//   7. GH release — gh release create with the artifact(s) + notes
//
// Flags:
//   --dry-run     print the plan and exit 0 without mutating git, files, or GitHub
//   --mac         build the macOS DMG (default)
//   --win         build the Windows installer (.pfx/cloud signing only)
//   --skip-build  tag + release an artifact that's already in dist/ (no rebuild)
//   --yes         non-interactive (skip the final confirmation prompt)
//
// Everything after preflight is guarded by --dry-run so the orchestration logic
// is testable WITHOUT signing certs or a network round-trip.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL, fileURLToPath } from 'node:url'

// fileURLToPath (not `new URL(...).pathname`) so this resolves correctly on
// Windows drive paths too — `--win` is a supported release target.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// True only when this file is the program entry (node scripts/release/release.mjs ...),
// false when imported by a test. Lets unit tests pull the pure helpers
// (buildFromTag / isBuildAllowed) WITHOUT triggering arg parsing or main().
const IS_ENTRY = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
const PKG_PATH = path.join(ROOT, 'package.json')
const CHANGELOG_PATH = path.join(ROOT, '..', '..', 'docs', 'CHANGELOG.md')

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))
const DRY_RUN = flags.has('--dry-run')
const SKIP_BUILD = flags.has('--skip-build')
const ASSUME_YES = flags.has('--yes')
const TARGET = flags.has('--win') ? 'win' : 'mac'

const VERSION = positional[0]

function die(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

function usage() {
  console.error('usage: node scripts/release/release.mjs <a.b.c.d> [--dry-run] [--mac|--win] [--skip-build] [--yes]')
  console.error('  e.g. node scripts/release/release.mjs 0.7.17.0 --dry-run')
}

if (IS_ENTRY && !VERSION) {
  usage()
  process.exit(1)
}

// Dreambyte uses a 4-segment numeric version a.b.c.d where the 4th segment is
// the monotonic build number. (3-segment is accepted; build defaults to 0.)
const vm = VERSION ? VERSION.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/) : null
if (IS_ENTRY && !vm) die(`version must be a.b.c or a.b.c.d (got: ${VERSION})`)
const SHORT_VERSION = vm ? `${vm[1]}.${vm[2]}.${vm[3]}` : ''
const BUILD_NUMBER = vm && vm[4] !== undefined ? Number(vm[4]) : 0
const TAG = `v${VERSION}`

// ── small helpers ────────────────────────────────────────────────────────────

/** Run a command, capturing stdout. Throws on non-zero unless allowFail. */
function run(cmd, args, { allowFail = false, cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.error) {
    if (allowFail) return { code: 1, stdout: '', stderr: String(r.error.message) }
    die(`failed to run ${cmd}: ${r.error.message}`)
  }
  if (r.status !== 0 && !allowFail) {
    die(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stderr || r.stdout}`)
  }
  return { code: r.status ?? 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
}

/** Run a command inheriting stdio (for the long build). Honors --dry-run. */
function runLive(cmd, args, label) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would run: ${cmd} ${args.join(' ')}`)
    return
  }
  console.log(`==> ${label}`)
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) die(`${label} failed (exit ${r.status})`)
}

function git(args, opts) {
  return run('git', args, opts)
}

function step(name, fn) {
  console.log(`\n==> ${name}`)
  return fn()
}

/** Parse the build number (4th segment) out of a vA.B.C.D tag. null if absent. */
export function buildFromTag(tag) {
  const m = String(tag).match(/^v?\d+\.\d+\.\d+\.(\d+)$/)
  return m ? Number(m[1]) : null
}

/**
 * Pure monotonicity check for the build-number guard. `maxPublished` is the
 * highest already-published build (null = first release). A new build is allowed
 * iff there is no prior release OR it is STRICTLY greater than the last one.
 * Returns { ok, reason }. Side-effect-free so it's unit-testable without git/gh.
 */
export function isBuildAllowed(buildNumber, maxPublished) {
  // Defensive: a non-finite build number (NaN from a malformed tag/version)
  // must never pass the guard — `NaN <= maxPublished` is false, which would
  // otherwise slip a bad build past the monotonicity check.
  if (!Number.isFinite(buildNumber)) {
    return { ok: false, reason: `build number is not a finite number (got: ${buildNumber})` }
  }
  if (maxPublished === null || maxPublished === undefined) {
    return { ok: true, reason: 'first release' }
  }
  if (buildNumber <= maxPublished) {
    return { ok: false, reason: `build ${buildNumber} not greater than last published ${maxPublished}` }
  }
  return { ok: true, reason: `build ${buildNumber} > last published ${maxPublished}` }
}

async function confirm(question) {
  if (ASSUME_YES || DRY_RUN) return true
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

// ── 1. Preflight ─────────────────────────────────────────────────────────────
function preflight() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout
  // Branch gate. Override with DREAMBYTE_RELEASE_ALLOW_BRANCH=1 only for
  // rehearsing the flow on a feature branch under --dry-run (a real release
  // must still run from main or release/*).
  const branchOverride = process.env.DREAMBYTE_RELEASE_ALLOW_BRANCH === '1'
  const onReleaseBranch = branch === 'main' || branch.startsWith('release/')
  // A real release must run from main or release/*. The override is honored ONLY
  // to rehearse the flow off a feature branch under --dry-run — it can never let
  // a real (mutating) release run from an arbitrary branch.
  if (!onReleaseBranch && !(branchOverride && DRY_RUN)) {
    die(`must be on main or a release/* branch (got: ${branch})`)
  }

  const dirty = git(['status', '--porcelain']).stdout
  if (dirty) die(`working tree has uncommitted changes:\n${dirty}`)

  // Tag must be free locally and on origin.
  const localTag = git(['rev-parse', TAG], { allowFail: true })
  if (localTag.code === 0) die(`tag ${TAG} already exists locally`)

  const fetched = git(['fetch', 'origin', branch, '--quiet'], { allowFail: true })
  git(['fetch', 'origin', '--tags', '--quiet'], { allowFail: true })
  // If we couldn't reach origin, the "tag-free on origin" and "in sync with
  // origin" checks below would silently degrade to stale local refs. Refuse a
  // real release rather than ship on an unverifiable origin state.
  if (fetched.code !== 0 && !DRY_RUN) {
    die(`could not fetch origin/${branch} (network/auth?) — refusing a real release on stale local refs. Use --dry-run to rehearse offline.`)
  }

  const originTag = git(['rev-parse', `refs/tags/${TAG}`], { allowFail: true })
  if (originTag.code === 0) die(`tag ${TAG} already exists on origin`)

  const head = git(['rev-parse', 'HEAD']).stdout
  const originRef = git(['rev-parse', `origin/${branch}`], { allowFail: true })
  if (originRef.code === 0 && head !== originRef.stdout) {
    die(`local ${branch} differs from origin/${branch}. Push or pull first.`)
  }
  console.log(`    branch=${branch}  head=${head.slice(0, 8)}  tag ${TAG} is free`)
  return { branch }
}

// ── 2. Build-number guard ────────────────────────────────────────────────────
// The new build number must exceed the highest published build. Our
// published-build source of truth is the highest vA.B.C.D tag (each release tags
// one). gh is consulted opportunistically; tags are authoritative + offline.
function buildGuard() {
  const tagList = git(['tag', '--list', 'v*'], { allowFail: true }).stdout
  const builds = tagList
    .split('\n')
    .map((t) => buildFromTag(t.trim()))
    .filter((n) => n !== null)

  // Opportunistic: also consider the latest GH release tag if gh is available.
  const ghLatest = run('gh', ['release', 'view', '--json', 'tagName', '-q', '.tagName'], { allowFail: true })
  if (ghLatest.code === 0 && ghLatest.stdout) {
    const b = buildFromTag(ghLatest.stdout)
    if (b !== null) builds.push(b)
  }

  const maxPublished = builds.length ? Math.max(...builds) : null
  if (maxPublished === null) {
    console.log('    no prior release tags — this is the first release')
    return
  }
  if (!isBuildAllowed(BUILD_NUMBER, maxPublished).ok) {
    die(
      `new build number ${BUILD_NUMBER} (from ${VERSION}) is not greater than the last ` +
        `published build ${maxPublished}. Bump the 4th version segment so the updater ` +
        `can order the release ahead of what's live.`,
    )
  }
  console.log(`    new build ${BUILD_NUMBER} > last published ${maxPublished} ✓`)
}

// ── 3. Version bump ──────────────────────────────────────────────────────────
function bumpVersion() {
  const original = fs.readFileSync(PKG_PATH, 'utf8')
  const pkg = JSON.parse(original)
  const old = pkg.version
  console.log(`    ${old} → ${VERSION}  (short ${SHORT_VERSION}, build ${BUILD_NUMBER})`)
  if (DRY_RUN) {
    console.log('    [dry-run] would write package.json')
    return
  }
  // Surgical replace on package.json so key order/formatting is preserved
  // (same approach as package-app.mjs).
  const verMatch = original.match(/"version"\s*:\s*"([^"]+)"/)
  if (!verMatch || verMatch[1] !== old) {
    die(`the first "version" in package.json (${verMatch ? verMatch[1] : 'none'}) is not the top-level version "${old}"`)
  }
  const patched = original.replace(/("version"\s*:\s*")[^"]+(")/, `$1${VERSION}$2`)
  fs.writeFileSync(PKG_PATH, patched)
}

// ── 4. Release notes ─────────────────────────────────────────────────────────
function generateNotes() {
  const lastTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*'], { allowFail: true }).stdout
  const range = lastTag ? `${lastTag}..HEAD` : ''
  const logArgs = ['log', '--pretty=format:- %s', '--no-merges']
  if (range) logArgs.push(range)
  const log = git(logArgs, { allowFail: true }).stdout
  const today = new Date().toISOString().slice(0, 10)

  const body = [`## What's new`, '', log || (lastTag ? '_No changes since last tag._' : 'First release.'), ''].join('\n')

  // The CHANGELOG entry mirrors the existing format (## [version] - date — title).
  const changelogEntry = [`## [${VERSION}] - ${today}`, '', log || '- (no commit-level changes)', '', ''].join('\n')

  console.log(`    ${lastTag ? `since ${lastTag}` : 'first release'}, ${log ? log.split('\n').length : 0} commits`)

  if (!DRY_RUN) {
    const current = fs.existsSync(CHANGELOG_PATH) ? fs.readFileSync(CHANGELOG_PATH, 'utf8') : '# Changelog\n\n'
    // Insert the new entry after the top header block and `## [Unreleased]`
    // (before the first versioned `## [` entry), so newest stays on top.
    const firstEntry = current.search(/^## \[(?!Unreleased\])/m)
    const next =
      firstEntry === -1
        ? `${current.trimEnd()}\n\n${changelogEntry}`
        : current.slice(0, firstEntry) + changelogEntry + current.slice(firstEntry)
    fs.writeFileSync(CHANGELOG_PATH, next)
  }
  return body
}

// ── 5. Build ─────────────────────────────────────────────────────────────────
function build() {
  if (SKIP_BUILD) {
    console.log('    --skip-build: using existing dist/ artifacts')
    return
  }
  const script = TARGET === 'win' ? 'dist:win' : 'dist:mac'
  runLive('npm', ['run', script], `Building signed${DRY_RUN ? '' : '+notarized'} ${TARGET} artifact (${script})`)
}

/** Locate the artifact(s) to attach to the GH release. */
function findArtifacts() {
  const distDir = path.join(ROOT, 'dist')
  if (!fs.existsSync(distDir)) {
    if (DRY_RUN) return [path.join('dist', TARGET === 'win' ? '<setup>.exe' : '<app>.dmg')]
    die('dist/ not found — build did not produce artifacts')
  }
  const want = TARGET === 'win' ? /\.exe$/ : /\.dmg$/
  const found = fs.readdirSync(distDir).filter((f) => want.test(f))
  // electron-updater feed files must also be uploaded so the updater can read them.
  const feed = TARGET === 'win' ? ['latest.yml'] : ['latest-mac.yml']
  for (const f of feed) if (fs.existsSync(path.join(distDir, f))) found.push(f)
  if (found.length === 0 && !DRY_RUN) die(`no ${TARGET} artifact found in dist/`)
  return found.map((f) => path.join('dist', f))
}

// ── 6 + 7. Commit, tag, push, GH release ─────────────────────────────────────
function commitTagPush(branch) {
  const files = ['package.json', CHANGELOG_PATH]
  if (DRY_RUN) {
    console.log(`  [dry-run] would: git add ${files.join(' ')}`)
    console.log(`  [dry-run] would: git commit -m "Release ${VERSION}"`)
    console.log(`  [dry-run] would: git tag ${TAG}`)
    console.log(`  [dry-run] would: git push origin ${branch}`)
    return
  }
  git(['add', ...files])
  git(['commit', '-m', `Release ${VERSION}`])
  git(['tag', TAG])
  git(['push', 'origin', branch])
  // NOTE: the tag is pushed in ghRelease(), paired with the release create so a
  // failed release can roll the tag back. Pushing it here would orphan the tag
  // (un-resumable + burns a build number) if `gh release create` then fails.
}

function ghRelease(notesBody, artifacts) {
  const notesFile = path.join(ROOT, '.release-notes.tmp.md')
  if (DRY_RUN) {
    console.log(`  [dry-run] would: git push origin ${TAG}`)
    console.log(`  [dry-run] would: gh release create ${TAG} ${artifacts.join(' ')} --title ${TAG} --notes <generated>`)
    return
  }
  // Push the tag now, immediately before the release, so the public-visible tag
  // and the release succeed or fail together. If the release create fails, roll
  // the tag back (origin + local) so a re-run isn't blocked by "tag exists" and
  // the monotonic build number isn't consumed by a release that never shipped.
  git(['push', 'origin', TAG])
  fs.writeFileSync(notesFile, notesBody)
  try {
    const r = run('gh', ['release', 'create', TAG, ...artifacts, '--title', TAG, '--notes-file', notesFile], {
      allowFail: true,
    })
    if (r.code !== 0) {
      git(['push', 'origin', '--delete', TAG], { allowFail: true })
      git(['tag', '-d', TAG], { allowFail: true })
      die(
        `gh release create failed (exit ${r.code}) — rolled back tag ${TAG} (origin + local) so you can re-run.\n${r.stderr || r.stdout}`,
      )
    }
  } finally {
    fs.rmSync(notesFile, { force: true })
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Dreambyte release ${VERSION}${DRY_RUN ? '  (DRY RUN — nothing will be mutated)' : ''}`)

  const { branch } = step('Preflight', preflight)
  step('Build-number guard', buildGuard)

  if (!DRY_RUN) {
    const ok = await confirm(`Release ${VERSION} (${TARGET}) from ${branch}?`)
    if (!ok) {
      console.log('aborted.')
      process.exit(0)
    }
  }

  step('Bumping version', bumpVersion)
  const notes = step('Generating release notes', generateNotes)
  step('Building artifact', build)
  const artifacts = findArtifacts()
  step('Commit + tag + push', () => commitTagPush(branch))
  step('Creating GitHub release', () => ghRelease(notes, artifacts))

  console.log(`\n==> ${DRY_RUN ? 'Dry run complete — no changes made.' : `Released ${TAG}.`}`)
  if (!DRY_RUN) {
    const remote = git(['remote', 'get-url', 'origin'], { allowFail: true }).stdout
    const slug = remote.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '')
    if (slug) console.log(`    https://github.com/${slug}/releases/tag/${TAG}`)
  }
}

if (IS_ENTRY) {
  main().catch((e) => die(e?.stack || String(e)))
}
