/**
 * High-level git operations for a Tier 2 project repo.
 *
 * Each function takes a `cwd` (the project's `.dreambyte/` folder) and an
 * optional `gitPath` so tests can swap binaries / sandbox env. Outputs
 * are typed structures, not raw stdout — callers get a stable
 * surface even if a future git release reformats the human output.
 *
 * Scope intentionally narrow: only the operations the agent + UI
 * actually need (init, status, add, commit, log, branch, checkout,
 * diff name-status). Remote push/pull lands in a follow-up wired to
 * the credential helper.
 */

import { runGit, type GitRunOptions } from './git-runner'

export type RepoBaseOptions = Omit<GitRunOptions, 'stdin'>

export interface CommitInfo {
  sha: string
  /** ISO 8601 (e.g. `2026-05-12T01:34:00+00:00`). */
  date: string
  authorName: string
  authorEmail: string
  subject: string
}

export interface StatusEntry {
  /** Two-letter porcelain code (e.g. ` M`, `A `, `??`). */
  code: string
  path: string
}

export interface DiffEntry {
  /** Git name-status letter: A (added), M (modified), D (deleted), R (rename), C (copy). */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | string
  path: string
  /** Old path for renames / copies. */
  oldPath?: string
}

/** `git init -q -b main`. Idempotent — calling on an existing repo is a no-op. */
export async function gitInit(options: RepoBaseOptions & { initialBranch?: string }): Promise<void> {
  const branch = options.initialBranch ?? 'main'
  await runGit(['init', '-q', '-b', branch], options)
}

/** `git status --porcelain=v1` parsed into entries. */
export async function gitStatus(options: RepoBaseOptions): Promise<StatusEntry[]> {
  const { stdout } = await runGit(['status', '--porcelain=v1'], options)
  if (!stdout.trim()) return []
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2),
      path: line.slice(3),
    }))
}

/** `git add <paths>` — accepts a list of relative paths or `['.']`. */
export async function gitAdd(paths: readonly string[], options: RepoBaseOptions): Promise<void> {
  if (paths.length === 0) return
  await runGit(['add', '--', ...paths], options)
}

/**
 * `git commit -m <message>`. Returns the new commit SHA. Throws if the
 * tree is clean (mirrors git's default).
 */
export async function gitCommit(message: string, options: RepoBaseOptions & { allowEmpty?: boolean }): Promise<string> {
  const args = ['commit', '-q', '-m', message]
  if (options.allowEmpty) args.push('--allow-empty')
  await runGit(args, options)
  const { stdout } = await runGit(['rev-parse', 'HEAD'], options)
  return stdout.trim()
}

/**
 * `git log --max-count=<n>` parsed into commit records. Default 50.
 * Returns newest first.
 */
export async function gitLog(options: RepoBaseOptions & { maxCount?: number; ref?: string }): Promise<CommitInfo[]> {
  const max = options.maxCount ?? 50
  const FORMAT = ['%H', '%aI', '%an', '%ae', '%s'].join('%x1f')
  const ref = options.ref ?? 'HEAD'
  const { stdout } = await runGit(['log', `--max-count=${max}`, `--format=${FORMAT}`, ref], options)
  if (!stdout.trim()) return []
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, authorName, authorEmail, subject] = line.split('\x1f')
      return { sha, date, authorName, authorEmail, subject }
    })
}

/**
 * Reject ref names that git could parse as an option, plus the characters
 * git's own `check-ref-format` forbids. The primary target is a leading `-`:
 * `runGit` spawns with no shell, but a name like `-f` would still be parsed
 * by git as a flag (argument injection), e.g. turning `git checkout -f` into
 * a destructive force-checkout of the .dreambyte/ project repo. Callers upstream only check non-empty, so this is the real guard.
 */
const SAFE_REF_NAME_RE = /^[^\s~^:?*[\\\x00-\x1f]+$/
export function assertSafeRefName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Empty git ref name')
  }
  if (name.startsWith('-')) {
    throw new Error(`Refusing git ref name that starts with "-" (option injection): ${name}`)
  }
  if (
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.lock') ||
    name.includes('..') ||
    name.includes('@{') ||
    !SAFE_REF_NAME_RE.test(name)
  ) {
    throw new Error(`Invalid git ref name: ${name}`)
  }
}

/**
 * `git branch <name>` (or `--list` when no name supplied). Creates a
 * branch at HEAD; doesn't switch. `--` ends option parsing so a hostile name
 * can't be read as a flag.
 */
export async function gitBranchCreate(name: string, options: RepoBaseOptions): Promise<void> {
  assertSafeRefName(name)
  await runGit(['branch', '--', name], options)
}

/** Current branch via `git rev-parse --abbrev-ref HEAD`. Returns null for detached HEAD. */
export async function gitCurrentBranch(options: RepoBaseOptions): Promise<string | null> {
  const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], options)
  const v = stdout.trim()
  return v === 'HEAD' ? null : v
}

/** `git branch --list --format=%(refname:short)` → string[]. */
export async function gitBranchList(options: RepoBaseOptions): Promise<string[]> {
  const { stdout } = await runGit(['branch', '--list', '--format=%(refname:short)'], options)
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `git checkout <branch>` (or `-b <branch>` when `create` is true). */
export async function gitCheckout(branch: string, options: RepoBaseOptions & { create?: boolean }): Promise<void> {
  assertSafeRefName(branch)
  const args = options.create ? ['checkout', '-b', branch] : ['checkout', branch]
  await runGit(args, options)
}

/**
 * `git diff --name-status <a>..<b>` parsed into entries. `from`/`to`
 * default to the merge-base of HEAD..main pattern — callers usually
 * pass explicit refs.
 */
export async function gitDiffNameStatus(from: string, to: string, options: RepoBaseOptions): Promise<DiffEntry[]> {
  const { stdout } = await runGit(['diff', '--name-status', `${from}..${to}`], options)
  if (!stdout.trim()) return []
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t')
      const status = parts[0]
      // Renames: R100\told\tnew  (we strip the score)
      if (status.startsWith('R') || status.startsWith('C')) {
        return { status: status[0] as DiffEntry['status'], oldPath: parts[1], path: parts[2] }
      }
      return { status: status as DiffEntry['status'], path: parts[1] }
    })
}
