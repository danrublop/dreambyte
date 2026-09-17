/**
 * Spawn-based git wrapper.
 *
 * Same shape as `src/electron/audio-decode.ts` — we shell out to a binary
 * we trust is on PATH (system `git`). No new npm dep, no native build,
 * and tests can swap the binary for a fake script if we ever need to.
 *
 * Why spawn instead of `simple-git` / `isomorphic-git`:
 *   - simple-git is a JS wrapper around the same spawn; we'd just be
 *     adding indirection.
 *   - isomorphic-git is pure JS but slow + struggles with worktree
 *     features we rely on.
 *   - System git is universal on dev machines (and the export pipeline's
 *     user-installed ffmpeg is a precedent for spawning binaries inside Electron).
 *
 * Errors carry stderr so callers can surface real diagnostics.
 */

import { spawn } from 'node:child_process'

export interface GitRunOptions {
  /** Working directory. Required for most commands. */
  cwd: string
  /** Override the git binary (mostly for tests). */
  gitPath?: string
  /** Extra env passed through (e.g. GIT_AUTHOR_NAME for deterministic tests). */
  env?: NodeJS.ProcessEnv
  /** Cap on runtime in ms. Default 30s. */
  timeoutMs?: number
  /** stdin payload (for `commit -F -` etc.). */
  stdin?: string
}

export interface GitRunResult {
  stdout: string
  stderr: string
}

export class GitRunError extends Error {
  exitCode: number | null
  stdout: string
  stderr: string
  args: readonly string[]
  constructor(
    message: string,
    info: { args: readonly string[]; exitCode: number | null; stdout: string; stderr: string },
  ) {
    super(message)
    this.name = 'GitRunError'
    this.args = info.args
    this.exitCode = info.exitCode
    this.stdout = info.stdout
    this.stderr = info.stderr
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Strip bearer tokens / auth headers from any string that ends up in an error
 * message or log. Defense-in-depth for the auth-header path: the token is passed via env config rather than argv, but git
 * could still echo a header into stderr, and we never want a credential in a
 * thrown error.
 */
function redactSecrets(s: string): string {
  return s
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>')
}

/**
 * Transports git is allowed to use. Pinned here as defense-in-depth: every
 * git invocation in the app funnels through `runGit`, so forcing
 * `GIT_ALLOW_PROTOCOL` at this choke point neutralizes the command-execution
 * transports (`ext::`, `fd::`) regardless of which caller supplied the
 * remote URL. Without this, an agent- or renderer-supplied remote of the
 * form `ext::sh -c '<cmd>'` would run `<cmd>` on the next push/pull, since
 * git's default `protocol.ext.allow=user` permits ext for a configured
 * remote (agentic RCE via prompt injection).
 * `file` stays allowed so local-path remotes and worktree clones keep
 * working; the dangerous helpers are simply absent from the allowlist.
 */
const ALLOWED_GIT_PROTOCOLS = 'https:http:ssh:git:file'

/**
 * Run `git <args>` in `cwd`. Rejects on non-zero exit, timeout, or
 * spawn failure — message + exit code + stderr live on `GitRunError`.
 */
export async function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  const bin = options.gitPath ?? 'git'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Force the transport allowlist, but let an explicit caller-supplied
  // GIT_ALLOW_PROTOCOL win (tests that need a custom transport set it on
  // options.env). Only trusted code sets options.env; the agent can never
  // reach the spawn env, only the argv.
  const callerEnv = options.env ?? process.env
  const env: NodeJS.ProcessEnv = {
    ...callerEnv,
    GIT_ALLOW_PROTOCOL: callerEnv.GIT_ALLOW_PROTOCOL ?? ALLOWED_GIT_PROTOCOLS,
  }

  return await new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn(bin, args.slice(), {
      cwd: options.cwd,
      env,
    })

    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
      reject(
        new GitRunError(redactSecrets(`git ${args.join(' ')} timed out after ${timeoutMs}ms`), {
          args,
          exitCode: null,
          stdout,
          stderr: redactSecrets(stderr),
        }),
      )
    }, timeoutMs)

    if (options.stdin) {
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(
        new GitRunError(`git spawn failed: ${err.message}`, {
          args,
          exitCode: null,
          stdout,
          stderr,
        }),
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (killed) return
      if (code !== 0) {
        reject(
          new GitRunError(redactSecrets(`git ${args.join(' ')} exited ${code}: ${stderr.trim() || '(no stderr)'}`), {
            args,
            exitCode: code,
            stdout,
            stderr: redactSecrets(stderr),
          }),
        )
        return
      }
      resolve({ stdout, stderr })
    })
  })
}
