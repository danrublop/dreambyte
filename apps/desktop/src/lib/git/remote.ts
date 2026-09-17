/**
 * Remote helpers.
 *
 * Adds the push/pull side of the Tier 2 git surface. Auth tokens are
 * passed in per-call and injected via `-c http.<remote>.extraheader=...`
 * so the token never lands in the repo's git config or .git/credentials.
 *
 * Token storage lives one layer up (Electron `safeStorage` keychain
 * encryption). This file stays pure: callers hand us the plaintext token
 * for the duration of one operation; we never persist it.
 */

import { runGit, type GitRunOptions } from './git-runner'

export type RemoteBaseOptions = Omit<GitRunOptions, 'stdin'>

export interface RemoteEntry {
  name: string
  fetchUrl: string
  pushUrl: string
}

/**
 * Reject remote URLs whose transport git can turn into command execution.
 * `ext::`/`fd::` are git "transport helpers" — git forks a shell/process for
 * them on fetch/push — and `protocol.ext.allow=user` (git's default) permits
 * ext for an explicitly-configured remote. `runGit` also pins
 * GIT_ALLOW_PROTOCOL as the hard backstop; this guard runs first so callers
 * (especially the agent) get a clear, early error instead of a cryptic git
 * failure on the later push.
 */
export function assertSafeRemoteUrl(url: string): void {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*)::?/.exec(url.trim())?.[1]?.toLowerCase()
  // `ext`/`fd` are the command-execution helpers. A double-colon (`ext::`)
  // is the unambiguous helper syntax, but reject the bare scheme too.
  const blocked = new Set(['ext', 'fd'])
  if (scheme && blocked.has(scheme)) {
    throw new Error(
      `Refusing remote URL with "${scheme}" transport — it can execute arbitrary commands. ` +
        `Use https://, ssh://, git://, or a file path.`,
    )
  }
}

/** `git remote add <name> <url>`. Throws if the remote already exists. */
export async function gitRemoteAdd(name: string, url: string, options: RemoteBaseOptions): Promise<void> {
  assertSafeRemoteUrl(url)
  await runGit(['remote', 'add', name, url], options)
}

/** Remove a remote by name. */
export async function gitRemoteRemove(name: string, options: RemoteBaseOptions): Promise<void> {
  await runGit(['remote', 'remove', name], options)
}

/** `git remote -v` parsed into typed entries. */
export async function gitRemoteList(options: RemoteBaseOptions): Promise<RemoteEntry[]> {
  const { stdout } = await runGit(['remote', '-v'], options)
  if (!stdout.trim()) return []
  // Each remote produces TWO lines: "<name>\t<url> (fetch)" and "(push)".
  const byName = new Map<string, { fetchUrl?: string; pushUrl?: string }>()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const tabIdx = trimmed.indexOf('\t')
    if (tabIdx < 0) continue
    const name = trimmed.slice(0, tabIdx)
    const rest = trimmed.slice(tabIdx + 1)
    // rest looks like: "https://github.com/x/y.git (fetch)"
    const spaceIdx = rest.lastIndexOf(' ')
    if (spaceIdx < 0) continue
    const url = rest.slice(0, spaceIdx)
    const kind = rest.slice(spaceIdx + 1) // "(fetch)" or "(push)"
    const entry = byName.get(name) ?? {}
    if (kind === '(fetch)') entry.fetchUrl = url
    else if (kind === '(push)') entry.pushUrl = url
    byName.set(name, entry)
  }
  const out: RemoteEntry[] = []
  for (const [name, entry] of byName) {
    out.push({
      name,
      fetchUrl: entry.fetchUrl ?? entry.pushUrl ?? '',
      pushUrl: entry.pushUrl ?? entry.fetchUrl ?? '',
    })
  }
  return out
}

export interface PushPullOptions extends RemoteBaseOptions {
  /**
   * Optional bearer token to authenticate with the remote. Injected via
   * `-c http.<remoteUrl>.extraheader="Authorization: Bearer <token>"` so
   * it never reaches disk. Pass undefined for unauthenticated remotes
   * (e.g. SSH or already-cached creds).
   */
  authToken?: string
  /** Set when injecting tokens — `git -c http.<URL_PREFIX>.extraheader=` keys are URL-scoped. */
  remoteUrl?: string
}

/**
 * Build the auth header as env-based git config (`GIT_CONFIG_COUNT/KEY/VALUE`)
 * rather than a `-c` command-line arg. Passing the bearer token on argv leaks
 * it to any user on the box via `ps` / `/proc/<pid>/cmdline`, and into
 * `GitRunError` messages built from argv. Env is only
 * readable by the same user and never appears in argv or error strings. The
 * key is scoped to the remote URL prefix so the token only travels to that
 * exact host/repo. Returns merged options for runGit.
 */
function withAuthEnv(options: PushPullOptions): GitRunOptions {
  if (!options.authToken || !options.remoteUrl) return options
  const prefix = options.remoteUrl.replace(/\.git$/, '')
  const base = options.env ?? process.env
  return {
    ...options,
    env: {
      ...base,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${prefix}.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${options.authToken}`,
    },
  }
}

/**
 * `git push <remote> <ref>`. When `remoteUrl` + `authToken` are
 * provided, the auth header is injected for that URL only.
 */
export async function gitPush(remote: string, ref: string, options: PushPullOptions): Promise<void> {
  await runGit(['push', remote, ref], withAuthEnv(options))
}

/** `git pull --ff-only <remote> <ref>`. Same auth injection rules. */
export async function gitPull(
  remote: string,
  ref: string,
  options: PushPullOptions & { ffOnly?: boolean },
): Promise<void> {
  const args = ['pull']
  if (options.ffOnly !== false) args.push('--ff-only')
  args.push(remote, ref)
  await runGit(args, withAuthEnv(options))
}

/** Look up the URL of one remote by name (or null when missing). */
export async function gitRemoteGetUrl(name: string, options: RemoteBaseOptions): Promise<string | null> {
  try {
    const { stdout } = await runGit(['remote', 'get-url', name], options)
    return stdout.trim() || null
  } catch {
    return null
  }
}
